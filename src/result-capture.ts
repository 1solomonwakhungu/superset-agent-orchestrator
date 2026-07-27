import { createHash } from "node:crypto";
import type { AgentAdapter, RunResult, RunStatus, TerminalRunStatus } from "./agent-adapter.js";
import { parseProviderResult, parseProviderStatus, ProviderProtocolError } from "./provider-protocol.js";
import { assertBoundedOptionalText, assertIdentifier, MAX_RESULT_BYTES } from "./security.js";
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

  async collect(
    assignmentId: string,
    deliveryId: string,
  ): Promise<{ result?: CapturedResult; duplicate: boolean; observedStatus?: RunStatus }> {
    const assignment = await this.store.assignmentForResult(assignmentId);
    if (assignment.status !== "launched" || assignment.runId === undefined) {
      throw new Error("Result collection requires a launched assignment with a bound run ID");
    }
    requireExactIdentities(assignment);
    let state;
    try {
      state = parseProviderStatus(await this.adapter.status({ runId: assignment.runId }));
    } catch (error) {
      if (!(error instanceof ProviderProtocolError)) throw error;
      return this.ingest(assignmentId, deliveryId, { kind: "malformed", error: error.message });
    }
    if (state.runId !== assignment.runId) {
      return this.ingest(assignmentId, deliveryId, {
        kind: "malformed",
        error: "Provider status response used a different execution identity",
      });
    }
    if (state.status === "queued" || state.status === "running") {
      return { duplicate: false, observedStatus: state.status };
    }
    let result: RunResult | undefined;
    try {
      const providerResult = await this.adapter.result({ runId: assignment.runId });
      if (providerResult !== undefined && typeof providerResult === "object" && "output" in providerResult) {
        const output = providerResult.output;
        if (typeof output === "string") assertBoundedOptionalText(output, "result output", MAX_RESULT_BYTES);
      }
      result = parseProviderResult(providerResult);
    } catch (error) {
      if (isTransientProviderError(error)) throw error;
      const captured = await this.ingest(assignmentId, deliveryId, {
        kind: "malformed",
        error: error instanceof Error && error.message.includes("exceeds the 4194304 byte limit")
          ? "Provider result response was oversized"
          : error instanceof Error ? error.message : String(error),
      });
      return { ...captured, observedStatus: state.status };
    }
    if (result !== undefined && result.status !== state.status) {
      const captured = await this.ingest(assignmentId, deliveryId, {
        kind: "malformed",
        error: `Adapter result status ${JSON.stringify(result.status)} did not match observed status ${JSON.stringify(state.status)}`,
      });
      return { ...captured, observedStatus: state.status };
    }
    const captured = await this.ingest(assignmentId, deliveryId, result === undefined
      ? { kind: "stopped_without_result", status: state.status }
      : { kind: "adapter_result", result });
    return { ...captured, observedStatus: state.status };
  }

  async ingest(assignmentId: string, deliveryId: string, delivery: ResultDelivery) {
    assertIdentifier(deliveryId, "deliveryId");
    const assignment = await this.store.assignmentForResult(assignmentId);
    if (assignment.runId === undefined) throw new Error("Result ingestion requires a bound run ID");
    requireExactIdentities(assignment);
    const claim = boundedClaim(this.store.redactValue(normalize(delivery)) as AgentResultClaim);
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

function boundedClaim(claim: AgentResultClaim): AgentResultClaim {
  let remaining = MAX_RESULT_BYTES;
  const bounded = (value: string | undefined, name: string): string | undefined => {
    if (value === undefined) return undefined;
    assertBoundedOptionalText(value, name, remaining);
    remaining -= Buffer.byteLength(value, "utf8");
    return value;
  };
  return {
    status: claim.status,
    completeness: claim.completeness,
    ...(claim.retryable === undefined ? {} : { retryable: claim.retryable }),
    ...(claim.output === undefined ? {} : { output: bounded(claim.output, "result output")! }),
    ...(claim.error === undefined ? {} : { error: bounded(claim.error, "result error")! }),
    ...(claim.stopReason === undefined ? {} : { stopReason: bounded(claim.stopReason, "result stop reason")! }),
    ...(claim.resume === undefined ? {} : {
      resume: {
        adapter: bounded(claim.resume.adapter, "result resume adapter")!,
        token: bounded(claim.resume.token, "result resume token")!,
      },
    }),
  };
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

/**
 * Projects one delivery into the exact claim persisted for a session, including completeness.
 * Canceled and failed runs keep whatever output they produced, marked `partial`.
 */
export function normalize(delivery: ResultDelivery): AgentResultClaim {
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
