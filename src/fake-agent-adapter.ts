import type {
  AgentAdapter,
  LaunchRequest,
  ResumeMetadata,
  RunHandle,
  RunResult,
  RunState,
  RunStatus,
} from "./agent-adapter.js";

export interface FakeRunScript {
  statuses: readonly RunStatus[];
  result: RunResult;
  resume?: ResumeMetadata;
}

interface FakeRun {
  script: FakeRunScript;
  position: number;
  resultAvailable: boolean;
  cancelled?: RunResult;
}

export class FakeAgentAdapter implements AgentAdapter {
  readonly launches: LaunchRequest[] = [];
  readonly cancellations: Array<{ runId: string; reason?: string }> = [];
  private readonly runs = new Map<string, FakeRun>();
  private readonly runsByIdempotencyKey = new Map<string, RunHandle>();
  private nextRunId = 1;

  constructor(
    private readonly scripts: readonly FakeRunScript[],
    private readonly now: () => string = () => "2000-01-01T00:00:00.000Z",
  ) {}

  async launch(request: LaunchRequest): Promise<RunHandle> {
    const existing = this.runsByIdempotencyKey.get(request.idempotencyKey);
    if (existing !== undefined) return existing;
    const script = this.scripts[this.launches.length];
    if (script === undefined) throw new Error("No fake run script available");
    this.validateScript(script);

    this.launches.push(request);
    const runId = `fake-${this.nextRunId++}`;
    this.runs.set(runId, { script, position: 0, resultAvailable: false });
    const handle = { runId };
    this.runsByIdempotencyKey.set(request.idempotencyKey, handle);
    return handle;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<RunHandle | undefined> {
    return this.runsByIdempotencyKey.get(idempotencyKey);
  }

  async status(handle: RunHandle): Promise<RunState> {
    const run = this.getRun(handle);
    const status = run.cancelled?.status ?? run.script.statuses[run.position];
    if (status === undefined) throw new Error("Fake run script has no current status");

    if (run.cancelled === undefined && run.position < run.script.statuses.length - 1) {
      run.position += 1;
    } else if (status === "succeeded" || status === "failed" || status === "cancelled") {
      run.resultAvailable = true;
    }

    return { ...handle, status, updatedAt: this.now() };
  }

  async result(handle: RunHandle): Promise<RunResult | undefined> {
    const run = this.getRun(handle);
    if (!run.resultAvailable) return undefined;
    return run.cancelled ?? run.script.result;
  }

  async cancel(handle: RunHandle, reason?: string): Promise<void> {
    const run = this.getRun(handle);
    if (run.resultAvailable) return;
    run.cancelled = { status: "cancelled", ...(reason !== undefined && { reason }) };
    run.resultAvailable = true;
    this.cancellations.push({ runId: handle.runId, ...(reason !== undefined && { reason }) });
  }

  async resumeMetadata(handle: RunHandle): Promise<ResumeMetadata | undefined> {
    return this.getRun(handle).script.resume;
  }

  private getRun(handle: RunHandle): FakeRun {
    const run = this.runs.get(handle.runId);
    if (run === undefined) throw new Error(`Unknown fake run: ${handle.runId}`);
    return run;
  }

  private validateScript(script: FakeRunScript): void {
    const terminal = script.statuses.at(-1);
    if (terminal === undefined) throw new Error("Fake run script requires at least one status");
    if (terminal === "queued" || terminal === "running") {
      throw new Error("Fake run script must end in a terminal status");
    }
    if (terminal !== script.result.status) {
      throw new Error(`Fake run script ends in ${terminal} but result is ${script.result.status}`);
    }
    if (script.statuses.slice(0, -1).some((status) => status !== "queued" && status !== "running")) {
      throw new Error("Fake run script cannot transition away from a terminal status");
    }
  }
}
