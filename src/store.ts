import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";

export type WorkerStatus = "running" | "succeeded" | "failed" | "unknown_outcome";
export type DiagnosticKind = "orphan" | "unknown_outcome" | "missing_result";

export interface Session {
  id: string;
  clientId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface Batch {
  id: string;
  name: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerAttribution {
  agent: string;
  task: string;
}

export interface Worker {
  id: string;
  batchId: string;
  sessionId: string;
  pid?: number;
  processStartedAt?: string;
  status: WorkerStatus;
  attribution: WorkerAttribution;
  startedAt: string;
  completedAt?: string;
  result?: unknown;
}

export interface Diagnostic {
  id: string;
  kind: DiagnosticKind;
  workerId: string;
  message: string;
  detectedAt: string;
}

export interface DurableState {
  version: 1;
  sessions: Session[];
  batches: Batch[];
  workers: Worker[];
  diagnostics: Diagnostic[];
  reconciledAt?: string;
}

export interface ReconciliationSummary {
  sessionsRecovered: number;
  batchesRecovered: number;
  workersRecovered: number;
  runningWorkers: number;
  diagnosticsAdded: number;
  reconciledAt: string;
}

const attributionSchema = z.object({ agent: z.string().min(1), task: z.string().min(1) });
const sessionSchema = z.object({
  id: z.string().min(1), clientId: z.string().min(1), createdAt: z.iso.datetime(), lastSeenAt: z.iso.datetime(),
});
const batchSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), sessionId: z.string().min(1),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const workerSchema = z.object({
  id: z.string().min(1), batchId: z.string().min(1), sessionId: z.string().min(1),
  pid: z.number().int().positive().optional(),
  processStartedAt: z.string().min(1).optional(),
  status: z.enum(["running", "succeeded", "failed", "unknown_outcome"]),
  attribution: attributionSchema, startedAt: z.iso.datetime(), completedAt: z.iso.datetime().optional(),
  result: z.unknown().optional(),
});
const diagnosticSchema = z.object({
  id: z.string().min(1), kind: z.enum(["orphan", "unknown_outcome", "missing_result"]),
  workerId: z.string().min(1), message: z.string().min(1), detectedAt: z.iso.datetime(),
});
const stateSchema = z.object({
  version: z.literal(1), sessions: z.array(sessionSchema), batches: z.array(batchSchema),
  workers: z.array(workerSchema), diagnostics: z.array(diagnosticSchema), reconciledAt: z.iso.datetime().optional(),
}).superRefine((state, context) => {
  for (const [kind, records] of [["session", state.sessions], ["batch", state.batches], ["worker", state.workers]] as const) {
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) context.addIssue({ code: "custom", message: `Duplicate ${kind} ID: ${record.id}` });
      ids.add(record.id);
    }
  }
});

const EMPTY_STATE: DurableState = {
  version: 1,
  sessions: [],
  batches: [],
  workers: [],
  diagnostics: [],
};

export class DurableStore {
  private state: DurableState = structuredClone(EMPTY_STATE);

  constructor(
    private readonly path: string,
    private readonly isProcessAlive: (pid: number, processStartedAt?: string) => boolean = DurableStore.isProcessAlive,
  ) {}

  async reconcile(now = new Date()): Promise<ReconciliationSummary> {
    return this.withLock(async () => {
      await this.load();
      const detectedAt = now.toISOString();
      const sessionIds = new Set(this.state.sessions.map(({ id }) => id));
      const batches = new Map(this.state.batches.map((batch) => [batch.id, batch]));
      let diagnosticsAdded = 0;

      const diagnose = (kind: DiagnosticKind, worker: Worker, message: string): void => {
        const id = `${kind}:${worker.id}`;
        if (this.state.diagnostics.some((diagnostic) => diagnostic.id === id)) return;
        this.state.diagnostics.push({ id, kind, workerId: worker.id, message, detectedAt });
        diagnosticsAdded += 1;
      };

      for (const worker of this.state.workers) {
        const batch = batches.get(worker.batchId);
        if (!sessionIds.has(worker.sessionId) || batch === undefined || batch.sessionId !== worker.sessionId) {
          diagnose("orphan", worker, "Worker references a missing or inconsistent durable session or batch");
        }

        if (worker.status === "running"
          && (worker.pid === undefined || !this.isProcessAlive(worker.pid, worker.processStartedAt))) {
          worker.status = "unknown_outcome";
          worker.completedAt = detectedAt;
          diagnose("unknown_outcome", worker, "Worker process was absent during startup reconciliation");
        }

        if ((worker.status === "succeeded" || worker.status === "failed") && worker.result === undefined) {
          diagnose("missing_result", worker, "Terminal worker has no persisted result");
        }
      }

      this.state.reconciledAt = detectedAt;
      await this.persist();
      return {
        sessionsRecovered: this.state.sessions.length,
        batchesRecovered: this.state.batches.length,
        workersRecovered: this.state.workers.length,
        runningWorkers: this.state.workers.filter(({ status }) => status === "running").length,
        diagnosticsAdded,
        reconciledAt: detectedAt,
      };
    });
  }

  recentSessions(limit: number): Session[] {
    return [...this.state.sessions]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, limit);
  }

  reopenBatch(name: string): { batch: Batch; session: Session | undefined; workers: Worker[] } | undefined {
    const batch = [...this.state.batches]
      .filter((candidate) => candidate.name === name)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!batch) return undefined;
    return {
      batch,
      session: this.state.sessions.find(({ id }) => id === batch.sessionId),
      workers: this.state.workers.filter(({ batchId }) => batchId === batch.id),
    };
  }

  diagnostics(kind?: DiagnosticKind): Diagnostic[] {
    return this.state.diagnostics.filter((diagnostic) => kind === undefined || diagnostic.kind === kind);
  }

  snapshot(): DurableState {
    return structuredClone(this.state);
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.state = stateSchema.parse(parsed) as DurableState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot load orchestrator state at ${this.path}: ${(error as Error).message}`, { cause: error });
      }
      this.state = structuredClone(EMPTY_STATE);
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, this.path);
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 50, minTimeout: 50, maxTimeout: 200 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  static processStartedAt(pid: number): string | undefined {
    try {
      if (process.platform === "linux") {
        return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21];
      }
      return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private static isProcessAlive(pid: number, processStartedAt?: string): boolean {
    if (processStartedAt === undefined || !DurableStore.pidExists(pid)) return false;
    return DurableStore.processStartedAt(pid) === processStartedAt;
  }

  private static pidExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
