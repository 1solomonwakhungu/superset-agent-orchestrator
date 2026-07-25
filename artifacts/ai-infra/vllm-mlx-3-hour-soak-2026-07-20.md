# PER-230: vllm-mlx three-hour soak safety-gate report

**Attempt date:** 2026-07-24 19:51-19:57 CDT  
**Requested artifact date:** 2026-07-20  
**Machine:** MacBook M5 Pro, 48 GB unified memory, macOS 26.5.1 (arm64)  
**Result:** **SKIPPED / NO-GO. The three-hour soak did not start because the pre-test safety gate failed.**

## Executive result

The required production-like three-hour soak was not safe to start. The host was
already running many unrelated concurrent agent workloads, LM Studio's server was
already off with no loaded model, and swap grew rapidly before vllm-mlx was
started. Swap usage increased from 15,070.19 MiB at 19:51:23 to 17,135.88 MiB at
19:57:11, a 2,065.69 MiB increase in 5 minutes 48 seconds. That exceeds the
issue's 2 GiB hard-stop threshold before model loading or any soak request.

At 19:55:28 only 750.94 MiB of configured swap remained free. Loading the model,
whose prior measured vllm-mlx footprint was about 20 GB, would have added unsafe
memory pressure to a host already under a rapidly changing unrelated workload.
The run was therefore skipped rather than knowingly crossing a hard stop or
interfering with other work.

No model process was started, no LM Studio state was changed, no protected file
was modified, and no production migration was attempted. Port 8001 remained
closed.

## Prior evidence read

- `/Users/solomonwakhungu/Documents/Hermes/artifacts/ai-infra/vllm-mlx-side-by-side-test-2026-07-19.md`
- `/Users/solomonwakhungu/Documents/Hermes/artifacts/ai-infra/vllm-mlx-feasibility-2026-07-19.md`
- vllm-mlx v0.4.0 source at commit `0dd115769ef1196a715b96b181353edacd2a4f69`

The prior bounded run passed short requests and measured about 20 GB resident and
21.78 GB peak Metal memory. PER-230 still requires a real three-hour long-context
run before PER-188 can proceed.

## Exact preparation commands

The missing scratch environment was recreated under `/tmp` only:

```bash
git clone --branch v0.4.0 --depth 1 \
  https://github.com/waybarrios/vllm-mlx.git /tmp/per-230-vllm-mlx
/opt/homebrew/bin/python3.12 -m venv /tmp/per-230-vllm-mlx/.venv
/tmp/per-230-vllm-mlx/.venv/bin/python -m pip install -e /tmp/per-230-vllm-mlx
/tmp/per-230-vllm-mlx/.venv/bin/vllm-mlx serve --help
```

Verified environment:

| Component | Value |
|---|---|
| vllm-mlx commit | `0dd115769ef1196a715b96b181353edacd2a4f69` |
| Python | 3.12.13 |
| vllm-mlx | 0.4.0 |
| mlx | 0.32.0 |
| mlx-lm | 0.31.3 |
| mlx-vlm | 0.6.7 |

The dependency patch version differs from the prior run's mlx-vlm 0.6.5 because
the v0.4.0 package declares a lower bound rather than an exact pin. No global
package was installed.

## Safety-gate commands

```bash
date '+%Y-%m-%d %H:%M:%S %Z (%z)'
ps aux | rg -i 'hermes|qwen|lm studio|vllm|mlx|opencode'
memory_pressure -Q
vm_stat
sysctl vm.swapusage
pmset -g therm
df -h /tmp /Users/solomonwakhungu/Documents/Hermes
lsof -nP -iTCP:1234 -sTCP:LISTEN
lsof -nP -iTCP:8001 -sTCP:LISTEN
~/.lmstudio/bin/lms ps --json
~/.lmstudio/bin/lms status
curl --max-time 5 http://127.0.0.1:1234/v1/models
curl --max-time 5 http://127.0.0.1:1234/api/v0/models
shasum -a 256 ~/.hermes/config.yaml \
  ~/Documents/Hermes/scripts/overnight_agent_start.sh \
  ~/Downloads/overnight_agent_start.sh
```

## Baseline samples

| Time CDT | Memory free | Swap used | Swap free | Swapouts | Thermal | Port 1234 | Port 8001 |
|---|---:|---:|---:|---:|---|---|---|
| 19:51:23 | 37% | 15,070.19 MiB | 1,313.81 MiB | not sampled | no warnings | closed | closed |
| 19:55:28 | 37% | 16,657.06 MiB | 750.94 MiB | 21,437,759 | no warnings | closed | closed |
| 19:57:11 | 40% | 17,135.88 MiB | 1,296.12 MiB | 22,069,643 | no warnings | closed | closed |

Additional final values:

- Disk available under `/tmp`: 489 GiB.
- LM Studio `lms ps --json`: `[]`.
- LM Studio `lms status`: `Server: OFF`.
- `/v1/models`: connection failed, HTTP `000`.
- `/api/v0/models`: connection failed, HTTP `000`.
- Port 8001 had no listener.
- Process inventory contained many unrelated active `opencode` sessions. No local
  Qwen, LM Studio model, or vllm-mlx server process was found.

## Stop-condition evaluation

| Condition | Result | Evidence |
|---|---|---|
| OOM, crash, hang, malformed output | Not exercised | Server was not started |
| Memory free below 20% | Not observed | Samples were 37%, 37%, and 40% |
| Swap growth greater than 2 GiB | **Failed before start** | +2,065.69 MiB in 5m48s |
| Metal peak above 32 GB | Not exercised | Server was not started |
| Critical thermal pressure | Not observed | `pmset -g therm` reported no warnings |
| Request error rate above 0% | Not exercised | Zero requests sent |
| Protected files changed | Not observed | Hashes stable across the attempt |

The swapout counter increased by 631,884 pages between 19:55:28 and 19:57:11.
At a 16,384-byte page size, this represents approximately 9.64 GiB of swapout
activity during 103 seconds. `vm.swapusage` is the authoritative metric used for
the issue's net swap-growth stop condition; the counter additionally confirms
heavy churn.

## Request and performance totals

| Metric | Total |
|---|---:|
| Soak duration | 0 seconds |
| Requests attempted | 0 |
| Successful requests | 0 |
| Request errors | 0 |
| Correct completions | 0 |
| Correct tool calls | 0 |
| TTFT samples | 0 |
| Latency samples | 0 |
| Throughput samples | 0 |

There are no latency, throughput, Metal-memory, or one-minute soak tables because
starting the model after the failed safety gate would have been unsafe and would
not constitute a valid run.

## Protected-state verification

The three required hashes were identical at the beginning and end of the attempt:

| Protected file | SHA-256 | Result |
|---|---|---|
| `~/.hermes/config.yaml` | `284e1d06be8c2fafca04880a7c28770d0d4b640d482df39832bb19f32c25754a` | unchanged |
| Hermes `overnight_agent_start.sh` | `f8af1aadba1229c3547bc6250ab43637e5796243c74eac5c6fae8ccc4c342c4f` | unchanged |
| Downloads `overnight_agent_start.sh` | `468c1e46305de4b03ac80ab087e7291ef1770ecc98ba717a36e9ea2eb77cbd63` | unchanged |

No config, cron job, startup script, model file, application setting, or user data
was modified. No file was deleted or moved. The only runtime preparation was the
isolated `/tmp/per-230-vllm-mlx` clone and virtual environment.

## Restoration

There was no test process to stop and port 8001 was verified closed. LM Studio
was already off before this attempt, so reloading Qwen would have changed host
state that this attempt did not own. It was intentionally not started or changed.
Consequently, the issue's required restoration checks for port 1234 and a real
LM Studio completion cannot pass in this attempt.

## Decision and next step

**NO-GO for PER-188.** The full three-hour soak and restoration did not run, so
PER-230 must remain in Backlog and must continue blocking migration.

Retry in a dedicated host window with no unrelated local-agent workload. Before
starting, require stable swap usage for at least 15 minutes, enough headroom to
load the prior measured approximately 20 GB model footprint, and LM Studio in a
known healthy state so ownership and restoration can be verified. Pin the tested
dependency set, allow at least 3.5 hours before the deadline, then execute the
8K/16K/24K concurrency-4 harness and only enter the final concurrency-8 phase if
all issue gates remain green.
