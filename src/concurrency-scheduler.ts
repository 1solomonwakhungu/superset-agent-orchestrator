export interface ConcurrencyPolicy {
  global: number;
  perHost: number;
  perProject: number;
  perAgent: number;
  perWorkspace: number;
  maxQueued: number;
  pressureHookTimeoutMs: number;
  overload: "queue" | "reject";
}

export interface ConcurrencyScope {
  hostId: string;
  projectId: string;
  agentId: string;
  workspaceId: string;
}

export interface AdmissionRequest extends ConcurrencyScope {
  id: string;
  signal?: AbortSignal;
}

export interface PressureDecision {
  ready: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export type PressureHook = (request: Readonly<AdmissionRequest>) => PressureDecision | Promise<PressureDecision>;

export interface QueueEntry extends ConcurrencyScope {
  id: string;
  position: number;
  enqueuedAt: string;
  blockedBy: string[];
}

export interface SchedulerSnapshot {
  active: number;
  queued: QueueEntry[];
  activeByHost: Record<string, number>;
  activeByProject: Record<string, number>;
  activeByAgent: Record<string, number>;
  activeByWorkspace: Record<string, number>;
}

export class ConcurrencyError extends Error {
  constructor(
    readonly code: "CONCURRENCY_LIMIT" | "CANCELLED",
    message: string,
    readonly retryable: boolean,
    readonly detail: { queueDepth: number; limits?: string[] },
  ) {
    super(message);
  }
}

interface PendingRequest {
  request: AdmissionRequest;
  enqueuedAt: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
  pressureReadyAt: number;
  pressureReason?: string;
  interruptPressureCheck: () => void;
  pressureInterrupted: Promise<void>;
}

const DEFAULT_POLICY: ConcurrencyPolicy = {
  global: 8,
  perHost: 4,
  perProject: 4,
  perAgent: 2,
  perWorkspace: 1,
  maxQueued: 100,
  pressureHookTimeoutMs: 30_000,
  overload: "queue",
};

export class ConcurrencyScheduler {
  private readonly policy: ConcurrencyPolicy;
  private readonly queue: PendingRequest[] = [];
  private readonly active = new Map<string, AdmissionRequest>();
  private wakeTimer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(
    policy: Partial<ConcurrencyPolicy> = {},
    private readonly pressureHooks: readonly PressureHook[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    for (const [name, value] of Object.entries(this.policy)) {
      if (name !== "overload" && (!Number.isInteger(value) || Number(value) < 0)) {
        throw new Error(`${name} must be a non-negative integer`);
      }
    }
    if (this.policy.overload !== "queue" && this.policy.overload !== "reject") {
      throw new Error('overload must be either "queue" or "reject"');
    }
    if (this.policy.pressureHookTimeoutMs === 0) throw new Error("pressureHookTimeoutMs must be greater than zero");
    for (const name of ["global", "perHost", "perProject", "perAgent", "perWorkspace"] as const) {
      if (this.policy[name] === 0) throw new Error(`${name} must be greater than zero`);
    }
  }

  async run<T>(request: AdmissionRequest, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(request);
    try {
      if (request.signal?.aborted) throw cancelled(this.queue.length);
      return await operation();
    } finally {
      release();
    }
  }

  acquire(request: AdmissionRequest): Promise<() => void> {
    validateRequest(request);
    request = { id: request.id, ...scope(request), ...(request.signal !== undefined && { signal: request.signal }) };
    if (request.signal?.aborted) return Promise.reject(cancelled(this.queue.length));
    if (this.active.has(request.id) || this.queue.some(({ request: queued }) => queued.id === request.id)) {
      return Promise.reject(new Error(`Admission ID ${request.id} is already active or queued`));
    }
    const limits = this.blockedBy(request);
    if (this.policy.overload === "reject" && (this.queue.length > 0 || limits.length > 0)) {
      return Promise.reject(overloaded(this.queue.length, limits));
    }
    if (this.queue.length >= this.policy.maxQueued && (this.queue.length > 0 || limits.length > 0)) {
      return Promise.reject(overloaded(this.queue.length, limits));
    }

    return new Promise<() => void>((resolve, reject) => {
      let interruptPressureCheck = (): void => undefined;
      const pending: PendingRequest = {
        request,
        enqueuedAt: this.now().toISOString(),
        resolve,
        reject,
        pressureReadyAt: 0,
        interruptPressureCheck: () => interruptPressureCheck(),
        pressureInterrupted: new Promise<void>((done) => { interruptPressureCheck = done; }),
      };
      if (request.signal !== undefined) {
        const onAbort = (): void => {
          const index = this.queue.indexOf(pending);
          if (index !== -1) {
            this.queue.splice(index, 1);
            this.clearWakeTimer();
          }
          pending.interruptPressureCheck();
          reject(cancelled(this.queue.length));
          void this.drain();
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => request.signal?.removeEventListener("abort", onAbort);
      }
      this.queue.push(pending);
      void this.drain();
    });
  }

  acquireExisting(request: AdmissionRequest): () => void {
    validateRequest(request);
    request = { id: request.id, ...scope(request) };
    if (this.active.has(request.id) || this.queue.some(({ request: queued }) => queued.id === request.id)) {
      throw new Error(`Admission ID ${request.id} is already active or queued`);
    }
    return this.activate(request);
  }

  snapshot(): SchedulerSnapshot {
    return {
      active: this.active.size,
      queued: this.queue.map(({ request, enqueuedAt, pressureReason }, index) => ({
        ...scope(request),
        id: request.id,
        position: index + 1,
        enqueuedAt,
        blockedBy: pressureReason !== undefined ? [pressureReason] : this.blockedBy(request),
      })),
      activeByHost: this.countBy("hostId"),
      activeByProject: this.countBy("projectId"),
      activeByAgent: this.countBy("agentId"),
      activeByWorkspace: this.countBy("workspaceId"),
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const pending = this.queue[0];
        if (pending === undefined || this.blockedBy(pending.request).length > 0) return;
        const waitMs = pending.pressureReadyAt - this.now().getTime();
        if (waitMs > 0) {
          this.scheduleDrain(waitMs);
          return;
        }
        let pressure: PressureDecision | undefined;
        try {
          pressure = this.pressureHooks.length === 0
            ? { ready: true }
            : await this.checkPressureBounded(pending);
        } catch {
          pressure = {
            ready: false,
            retryAfterMs: 1_000,
            reason: "pressure_hook_error",
          };
        }
        if (this.queue[0] !== pending) continue;
        if (pressure === undefined) continue;
        if (!pressure.ready) {
          const retryAfterMs = Math.max(1, pressure.retryAfterMs ?? 1_000);
          pending.pressureReason = pressure.reason ?? "resource_pressure";
          if (this.policy.overload === "reject" || this.policy.maxQueued === 0) {
            this.queue.shift();
            pending.removeAbortListener?.();
            pending.reject(overloaded(this.queue.length, [pending.pressureReason]));
            continue;
          }
          pending.pressureReadyAt = this.now().getTime() + retryAfterMs;
          this.scheduleDrain(retryAfterMs);
          return;
        }
        this.queue.shift();
        pending.removeAbortListener?.();
        pending.resolve(this.activate(pending.request));
      }
    } finally {
      this.draining = false;
    }
  }

  private async checkPressure(request: AdmissionRequest): Promise<PressureDecision> {
    for (const hook of this.pressureHooks) {
      const decision = await hook(request);
      if (!decision.ready) return decision;
    }
    return { ready: true };
  }

  private async checkPressureBounded(pending: PendingRequest): Promise<PressureDecision | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<PressureDecision>((resolve) => {
      timer = setTimeout(
        () => resolve({ ready: false, reason: "pressure_hook_timeout" }),
        this.policy.pressureHookTimeoutMs,
      );
    });
    try {
      return await Promise.race([
        this.checkPressure(pending.request),
        pending.pressureInterrupted.then(() => undefined),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private scheduleDrain(delayMs: number): void {
    if (this.wakeTimer !== undefined) return;
    const boundedDelay = Number.isFinite(delayMs) ? Math.min(Math.max(1, delayMs), 2_147_483_647) : 1_000;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.drain();
    }, boundedDelay);
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer === undefined) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private blockedBy(request: AdmissionRequest): string[] {
    const blocked: string[] = [];
    if (this.active.size >= this.policy.global) blocked.push("global");
    if (this.count("hostId", request.hostId) >= this.policy.perHost) blocked.push("host");
    if (this.count("projectId", request.projectId) >= this.policy.perProject) blocked.push("project");
    if (this.count("agentId", request.agentId) >= this.policy.perAgent) blocked.push("agent");
    if (this.count("workspaceId", request.workspaceId) >= this.policy.perWorkspace) blocked.push("workspace");
    return blocked;
  }

  private count(key: keyof ConcurrencyScope, value: string): number {
    let total = 0;
    for (const request of this.active.values()) if (request[key] === value) total += 1;
    return total;
  }

  private countBy(key: keyof ConcurrencyScope): Record<string, number> {
    const counts: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const request of this.active.values()) counts[request[key]] = (counts[request[key]] ?? 0) + 1;
    return counts;
  }

  private activate(request: AdmissionRequest): () => void {
    this.active.set(request.id, request);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(request.id);
      void this.drain();
    };
  }
}

function validateRequest(request: AdmissionRequest): void {
  for (const [name, value] of Object.entries(scope(request)) as [keyof ConcurrencyScope, string][]) {
    if (value.length === 0) throw new Error(`${name} must not be empty`);
  }
  if (request.id.length === 0) throw new Error("id must not be empty");
}

function scope(request: ConcurrencyScope): ConcurrencyScope {
  return {
    hostId: request.hostId,
    projectId: request.projectId,
    agentId: request.agentId,
    workspaceId: request.workspaceId,
  };
}

function overloaded(queueDepth: number, limits: string[]): ConcurrencyError {
  return new ConcurrencyError(
    "CONCURRENCY_LIMIT",
    "Concurrency capacity is unavailable",
    true,
    { queueDepth, limits },
  );
}

function cancelled(queueDepth: number): ConcurrencyError {
  return new ConcurrencyError("CANCELLED", "Admission was cancelled", false, { queueDepth });
}
