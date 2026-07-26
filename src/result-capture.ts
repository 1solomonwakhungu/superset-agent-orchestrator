import { createHash } from "node:crypto";
import type { AgentAdapter, RunResult, TerminalRunStatus } from "./agent-adapter.js";
import { DurableStore, type AgentResultClaim, type CapturedResult } from "./store.js";

export type ResultDelivery =
  | { kind: "adapter_result"; result: RunResult }
  | { kind: "stopped_without_result"; status: TerminalRunStatus; stopReason?: string }
  | { kind: "malformed"; error: string };

export class ResultCaptureService {
  constructor(
    private readonly store: DurableStore,
    private readonly adapter: AgentAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async collect(assignmentId: string, deliveryId: string): Promise<{ result?: CapturedResult; duplicate: boolean }> {
    const assignment = await this.store.assignmentForResult(assignmentId);
    if (assignment.status !== "launched" || assignment.runId === undefined) {
      throw new Error("Result collection requires a launched assignment with a bound run ID");
    }
    requireExactIdentities(assignment);
    const state = await this.adapter.status({ runId: assignment.runId });
    if (state.runId !== assignment.runId) throw new Error("Adapter status returned a different run ID");
    if (state.status === "queued" || state.status === "running") return { duplicate: false };
    let result: RunResult | undefined;
    try {
      result = await this.adapter.result({ runId: assignment.runId });
    } catch (error) {
      if (isTransientProviderError(error)) throw error;
      return this.ingest(assignmentId, deliveryId, {
        kind: "malformed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (result !== undefined && result.status !== state.status) {
      return this.ingest(assignmentId, deliveryId, {
        kind: "malformed",
        error: `Adapter result status ${JSON.stringify(result.status)} did not match observed status ${JSON.stringify(state.status)}`,
      });
    }
    return this.ingest(assignmentId, deliveryId, result === undefined
      ? { kind: "stopped_without_result", status: state.status }
      : { kind: "adapter_result", result });
  }

  async ingest(assignmentId: string, deliveryId: string, delivery: ResultDelivery) {
    if (deliveryId.length === 0) throw new Error("deliveryId must not be empty");
    const assignment = await this.store.assignmentForResult(assignmentId);
    if (assignment.runId === undefined) throw new Error("Result ingestion requires a bound run ID");
    requireExactIdentities(assignment);
    const claim = normalize(delivery);
    const deliveryFingerprint = createHash("sha256").update(canonical({
      assignmentId: assignment.id,
      batchId: assignment.batchId,
      sessionId: assignment.sessionId,
      workspaceId: assignment.workspaceId,
      workspacePath: assignment.workspacePath,
      attemptId: assignment.attemptId,
      attempt: assignment.attempt,
      runId: assignment.runId,
      attribution: assignment.attribution,
      claim,
    })).digest("hex");
    return this.store.captureResult({
      deliveryId,
      deliveryFingerprint,
      assignmentId: assignment.id,
      batchId: assignment.batchId,
      sessionId: assignment.sessionId,
      workspaceId: assignment.workspaceId,
      workspacePath: assignment.workspacePath,
      attemptId: assignment.attemptId,
      attempt: assignment.attempt,
      runId: assignment.runId,
      attribution: assignment.attribution,
      claim,
      verifiedArtifacts: [],
      capturedAt: this.now().toISOString(),
    });
  }
}

function isTransientProviderError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "PROVIDER_UNAVAILABLE";
}

function requireExactIdentities(assignment: {
  workspaceId?: string;
  attemptId?: string;
  attempt?: number;
}): asserts assignment is { workspaceId: string; attemptId: string; attempt: number } {
  if (assignment.workspaceId === undefined || assignment.attemptId === undefined || assignment.attempt === undefined) {
    throw new Error("Legacy assignments without exact workspace and attempt identities cannot accept results");
  }
}

function normalize(delivery: ResultDelivery): AgentResultClaim {
  if (delivery.kind === "malformed") {
    return { status: "malformed", completeness: "malformed", error: delivery.error };
  }
  if (delivery.kind === "stopped_without_result") {
    return {
      status: "stopped_without_result",
      completeness: "missing",
      ...(delivery.stopReason === undefined ? {} : { stopReason: delivery.stopReason }),
    };
  }
  const result = delivery.result;
  if (result.status === "succeeded") {
    return {
      status: result.status,
      completeness: result.output.length === 0 ? "empty" : "complete",
      output: result.output,
      ...(result.resume === undefined ? {} : { resume: result.resume }),
    };
  }
  if (result.status === "failed") {
    return {
      status: result.status,
      completeness: completeness(result.output),
      error: result.error,
      retryable: result.retryable,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.resume === undefined ? {} : { resume: result.resume }),
    };
  }
  return {
    status: result.status,
    completeness: completeness(result.output),
    ...(result.reason === undefined ? {} : { stopReason: result.reason }),
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.resume === undefined ? {} : { resume: result.resume }),
  };
}

function completeness(output: string | undefined): "missing" | "empty" | "partial" {
  return output === undefined ? "missing" : output.length === 0 ? "empty" : "partial";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
