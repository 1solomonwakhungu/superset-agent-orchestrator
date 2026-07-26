export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type TerminalRunStatus = Extract<RunStatus, "succeeded" | "failed" | "cancelled">;

export interface LaunchRequest {
  idempotencyKey: string;
  prompt: string;
  workspacePath: string;
  environment: NodeJS.ProcessEnv;
  revalidateWorkspace(): Promise<void>;
  resume?: ResumeMetadata;
}

export interface RunHandle {
  runId: string;
}

export interface RunState extends RunHandle {
  status: RunStatus;
  updatedAt: string;
}

export interface ResumeMetadata {
  adapter: string;
  token: string;
}

export type RunResult =
  | { status: "succeeded"; output: string; resume?: ResumeMetadata }
  | { status: "failed"; error: string; retryable: boolean; output?: string; resume?: ResumeMetadata }
  | { status: "cancelled"; reason?: string; output?: string; resume?: ResumeMetadata };

export type CancellationOutcome =
  | { status: "accepted" }
  | { status: "unsupported" };

export interface AgentAdapter {
  /**
   * Declares whether this backend can actually stop a run. Anything other than "supported" makes the
   * orchestrator refuse cancellation with CANCEL_UNSUPPORTED instead of recording an intent it cannot honor.
   */
  readonly cancellation?: "supported" | "unsupported";
  /** Returns the one run previously accepted for this key, or undefined when absence is authoritative. */
  findByIdempotencyKey(idempotencyKey: string): Promise<RunHandle | undefined>;
  /** Atomically returns the existing run or creates one after revalidation, using only the supplied environment. */
  launch(request: LaunchRequest): Promise<RunHandle>;
  status(handle: RunHandle, signal?: AbortSignal): Promise<RunState>;
  result(handle: RunHandle, signal?: AbortSignal): Promise<RunResult | undefined>;
  cancel(handle: RunHandle, reason?: string, signal?: AbortSignal): Promise<CancellationOutcome | void>;
  resumeMetadata(handle: RunHandle): Promise<ResumeMetadata | undefined>;
}
