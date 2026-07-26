# Performance and Load Testing

PER-351 provides two bounded harnesses. Both emit a JSON report for automation and
a Markdown companion for review under `evidence/per-351/` by default. Generated
reports are ignored because timestamps and host measurements are run-specific.

## Fake backend benchmark

Run the production benchmark with exactly 100 sessions:

```bash
npm run benchmark:fake -- --sessions 100
```

The benchmark uses the production `DurableStore`, `LaunchCoordinator`, and
`FakeAgentAdapter`. It drives every fake through queued, running, and completed
states and verifies all 100 unique responses against their agent and task
attribution through the durable batch-results API, both before and after a store
restart. It records per-launch latency percentiles, indexed batch-query
examined/returned cost and latency, process CPU, RSS, descriptor count when the
OS supports it, failures, exact attribution mismatches, and durable restart
recovery.
The report fails verification if launch or query p95 exceeds the explicit 1-second
responsiveness ceiling, or if any indexed operation examines more than 100 workers.
It uses temporary unique workspace paths and removes them after the report is
written. These measurements characterize local orchestration, persistence, and
the deterministic fake; they do not predict paid-agent execution time.

## Controlled real-agent load

The default command is a safe 30-agent dry-run. It executes no Superset command
and starts no paid agents. Its report records the paid run as externally blocked
until the required workspaces and explicit operator opt-in are available:

```bash
npm run load:real
```

Real execution requires both the explicit `--execute-paid-agents` opt-in and a
file containing exactly 30 distinct, pre-existing local workspace IDs, one per
line:

```bash
npm run load:real -- \
  --execute-paid-agents \
  --workspace-file ./private-workspace-ids.txt \
  --agent codex
```

The runner first verifies all IDs against one `workspaces list --local` snapshot,
then ramps 5, 10, and 15 launches with a configurable in-flight ceiling. Every agent gets a unique workspace,
so no two writers share a worktree. Before and after each ramp it enforces RSS,
cumulative runner CPU, and descriptor ceilings; launch failures and ceiling
breaches abort all further ramps. Defaults are 2 GiB RSS, 300 CPU seconds, 4,096
descriptors, and 30 seconds per launch acceptance. Override them with
`--max-rss-bytes`, `--max-cpu-ms`, `--max-descriptors`, and
`--launch-timeout-ms`, and `--max-in-flight`.

An abort cannot stop sessions already accepted by Superset. Supported Superset
APIs return launch metadata only and cannot retrieve ordinary agent completion,
exact results, stop reasons, cancellation, or backend recovery. Accordingly, this
harness measures launch acceptance and local runner resources only and reports
those unavailable capabilities explicitly rather than fabricating outcomes.
The process metrics do not represent aggregate Superset host or agent-process use;
no supported per-session or aggregate host resource telemetry is available. The
fixed 30-session maximum and staged admissions bound new work, but cannot enforce
CPU or memory ceilings on sessions that Superset has already accepted.
An explicitly executed command exits unsuccessfully after writing its report if
any launch fails, a ceiling aborts a later ramp, or fewer than 30 launches are
accepted. Reports include per-stage offered, admitted, failed, withheld, and
maximum-in-flight evidence. Verification recomputes that arithmetic and accepts
either a complete 30-session run or an honestly failed run that proves later work
was withheld after overload.

Real execution must not reuse the repository's assigned writer workspace or borrow
unrelated workspaces merely to satisfy the count. If 30 authorized, isolated
workspaces are unavailable, retain the dry-run report and record the controlled
load test as blocked.

## Verification

CI runs `npm run load:ci` in a five-minute offline job. It uses only scripted
fakes and injected deterministic duration, query-clock, and resource measurements;
it never invokes Superset or a paid agent. The job generates and verifies JSON and
Markdown success and overload reports under `artifacts/per-351-ci/`, then uploads
them as commit-attributed artifacts. Operator CLI commands retain real host and
wall-clock measurements.

Validate generated report schemas and Markdown companions:

```bash
npm run reports:verify -- \
  evidence/per-351/fake-backend-100 \
  evidence/per-351/real-agent-load-30
```

Report paths are passed without `.json` or `.md`. Verification fails if the fake
run is not exactly 100 attempts and acceptances, has failures or attribution
mismatches, or fails to recover 100 sessions after restart. It also validates the
30-session staged load contract and its honest capability declaration.
