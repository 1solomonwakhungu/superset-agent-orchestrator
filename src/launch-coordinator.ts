import { createHash } from "node:crypto";
import type { AgentAdapter, RunHandle } from "./agent-adapter.js";
import type { DurableStore, LaunchIntent, WorkerAttribution } from "./store.js";
import {
  assertBoundedText,
  assertDataOperand,
  assertIdentifier,
  childEnvironment,
  MAX_ATTRIBUTION_BYTES,
  MAX_IDEMPOTENCY_KEY_BYTES,
  MAX_RESUME_TOKEN_BYTES,
  reasonCode,
  SecurityError,
  type WorkspaceAuthorizer,
  type WorkspaceGrant,
} from "./security.js";

export interface AttributedLaunchRequest {
  idempotencyKey: string;
  prompt: string;
  workspaceId: string;
  resume?: { adapter: string; token: string };
  sessionId: string;
  batchId: string;
  workerId: string;
  attribution: WorkerAttribution;
}

export interface LaunchFailpoints {
  afterReservation?(): void;
  afterExternalAcceptance?(handle: RunHandle): void;
}

export class LaunchCoordinator {
  constructor(
    private readonly store: DurableStore,
    private readonly adapter: AgentAdapter,
    private readonly workspaceAuthorizer: WorkspaceAuthorizer,
    private readonly failpoints: LaunchFailpoints = {},
  ) {}

  async launch(request: AttributedLaunchRequest): Promise<LaunchIntent> {
    let grant: WorkspaceGrant;
    let prompt: string;
    let attribution: WorkerAttribution;
    try {
      assertIdentifier(request.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_BYTES);
      assertIdentifier(request.sessionId, "sessionId");
      assertIdentifier(request.batchId, "batchId");
      assertIdentifier(request.workerId, "workerId");
      assertIdentifier(request.workspaceId, "workspaceId");
      for (const identity of [request.idempotencyKey, request.sessionId, request.batchId, request.workerId, request.workspaceId]) {
        if (this.store.redactText(identity) !== identity) {
          throw new SecurityError("INVALID_ARGUMENT", "Launch identities must not contain credentials");
        }
      }
      assertIdentifier(request.attribution.agent, "attribution.agent", MAX_ATTRIBUTION_BYTES);
      assertBoundedText(request.attribution.task, "attribution.task", MAX_ATTRIBUTION_BYTES);
      if (request.resume !== undefined) {
        assertIdentifier(request.resume.adapter, "resume.adapter");
        assertBoundedText(request.resume.token, "resume.token", MAX_RESUME_TOKEN_BYTES);
        if (this.store.redactText(request.resume.adapter) !== request.resume.adapter
          || this.store.redactText(request.resume.token) !== request.resume.token) {
          throw new SecurityError("INVALID_ARGUMENT", "Resume metadata must not contain credentials");
        }
      }
      prompt = this.store.redactText(assertBoundedText(request.prompt, "prompt"));
      attribution = this.store.redactValue(request.attribution) as WorkerAttribution;
      grant = await this.workspaceAuthorizer.authorize(request.workspaceId);
    } catch (error) {
      await this.audit(request, "denied", reasonCode(error));
      throw sanitizedError(this.store, error);
    }
    const requestHash = LaunchCoordinator.requestHash({ ...request, prompt, attribution });
    const reservation = await this.store.reserveLaunch({
      idempotencyKey: request.idempotencyKey,
      requestHash,
      sessionId: request.sessionId,
      batchId: request.batchId,
      workerId: request.workerId,
      workspaceId: request.workspaceId,
      attribution,
    });
    const intent = reservation.intent;
    if (intent.status === "bound") return intent;
    if (reservation.created) this.failpoints.afterReservation?.();

    const recovered = await this.adapter.findByIdempotencyKey(request.idempotencyKey);
    if (recovered !== undefined) {
      try {
        if (intent.workspaceId === undefined) throw new SecurityError("INTEGRITY_FAILURE", "Legacy launch has no workspace identity");
        const freshGrant = await this.workspaceAuthorizer.authorize(intent.workspaceId);
        await freshGrant.revalidate();
      } catch (error) {
        await this.audit(request, "denied", reasonCode(error));
        throw sanitizedError(this.store, error);
      }
      return this.bind(intent, recovered, "launch_recovered");
    }
    if (!reservation.created && intent.status !== "reserved") {
      throw new Error(`Launch ${request.idempotencyKey} remains ${intent.status}; backend acceptance is unresolved`);
    }

    await this.store.updateLaunch(request.idempotencyKey, "dispatching");
    try {
      await grant.revalidate();
    } catch (error) {
      await this.audit(request, "denied", reasonCode(error), grant.projectId);
      await this.store.updateLaunch(request.idempotencyKey, "reserved", { diagnostic: this.store.safeError(error) });
      throw sanitizedError(this.store, error);
    }
    try {
      await this.audit(request, "allowed", "launch_intent", grant.projectId);
    } catch (error) {
      await this.store.updateLaunch(request.idempotencyKey, "reserved", { diagnostic: this.store.safeError(error) });
      throw sanitizedError(this.store, error);
    }
    try {
      const handle = await this.adapter.launch({
        idempotencyKey: request.idempotencyKey,
        prompt,
        workspacePath: assertDataOperand(grant.canonicalPath, "workspace path"),
        environment: childEnvironment(),
        revalidateWorkspace: () => grant.revalidate(),
        ...(request.resume === undefined ? {} : { resume: request.resume }),
      });
      this.failpoints.afterExternalAcceptance?.(handle);
      return await this.bind(intent, handle, "launch_started");
    } catch (error) {
      await this.store.updateLaunch(request.idempotencyKey, "unknown_outcome", {
        diagnostic: this.store.safeError(error),
        securityAudit: this.auditInput(request, "failed", reasonCode(error), grant.projectId),
      });
      throw sanitizedError(this.store, error);
    }
  }

  async reconcile(): Promise<LaunchIntent[]> {
    const reconciled: LaunchIntent[] = [];
    for (const intent of this.store.launchIntents()) {
      if (intent.status === "bound") continue;
      const handle = await this.adapter.findByIdempotencyKey(intent.idempotencyKey);
      if (handle !== undefined) {
        try {
          if (intent.workspaceId === undefined) throw new SecurityError("INTEGRITY_FAILURE", "Legacy launch has no workspace identity");
          const grant = await this.workspaceAuthorizer.authorize(intent.workspaceId);
          await grant.revalidate();
        } catch (error) {
          await this.store.appendSecurityAudit({
            requesterId: intent.sessionId,
            operation: "sessions_launch",
            decision: "denied",
            reasonCode: reasonCode(error),
            correlationId: intent.idempotencyKey,
            ...(intent.workspaceId === undefined ? {} : { workspaceId: intent.workspaceId }),
          });
          continue;
        }
        reconciled.push(await this.bind(intent, handle, "launch_recovered"));
      }
    }
    return reconciled;
  }

  private audit(
    request: AttributedLaunchRequest,
    decision: "allowed" | "denied" | "failed",
    reason: string,
    projectId?: string,
  ): Promise<unknown> {
    return this.store.appendSecurityAudit(this.auditInput(request, decision, reason, projectId));
  }

  private auditInput(
    request: AttributedLaunchRequest,
    decision: "allowed" | "denied" | "failed",
    reason: string,
    projectId?: string,
  ) {
    return {
      requesterId: request.sessionId || "invalid-requester",
      operation: "sessions_launch",
      decision,
      reasonCode: reason,
      correlationId: request.idempotencyKey || "invalid-correlation",
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(projectId === undefined ? {} : { projectId }),
    };
  }

  private bind(intent: LaunchIntent, handle: RunHandle, reason: "launch_started" | "launch_recovered"): Promise<LaunchIntent> {
    return this.store.updateLaunch(intent.idempotencyKey, "bound", {
      runId: handle.runId,
      securityAudit: {
        requesterId: intent.sessionId,
        operation: "sessions_launch",
        decision: "allowed",
        reasonCode: reason,
        correlationId: intent.idempotencyKey,
        ...(intent.workspaceId === undefined ? {} : { workspaceId: intent.workspaceId }),
      },
    });
  }

  static requestHash(request: AttributedLaunchRequest): string {
    const canonical = canonicalJson({
      sessionId: request.sessionId,
      batchId: request.batchId,
      workerId: request.workerId,
      attribution: request.attribution,
      prompt: request.prompt,
      workspaceId: request.workspaceId,
      resume: request.resume ?? null,
    });
    return createHash("sha256").update("launch-request:v1\0").update(canonical).digest("hex");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new SecurityError("INVALID_ARGUMENT", "Launch request contains an unsupported hash value");
}

function sanitizedError(store: DurableStore, error: unknown): Error {
  const message = store.safeError(error);
  const sanitizedCause = new Error(message);
  return error instanceof SecurityError
    ? new SecurityError(error.code, message, error.retryable, { cause: sanitizedCause })
    : new Error(message, { cause: sanitizedCause });
}
