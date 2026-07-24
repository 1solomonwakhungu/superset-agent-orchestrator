export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type TerminalRunStatus = Extract<RunStatus, "succeeded" | "failed" | "cancelled">;

export interface LaunchRequest {
  idempotencyKey: string;
  prompt: string;
  workspacePath: string;
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
  | { status: "failed"; error: string; retryable: boolean; resume?: ResumeMetadata }
  | { status: "cancelled"; reason?: string; resume?: ResumeMetadata };

export interface AgentAdapter {
  launch(request: LaunchRequest): Promise<RunHandle>;
  status(handle: RunHandle): Promise<RunState>;
  result(handle: RunHandle): Promise<RunResult | undefined>;
  cancel(handle: RunHandle, reason?: string): Promise<void>;
  resumeMetadata(handle: RunHandle): Promise<ResumeMetadata | undefined>;
}
