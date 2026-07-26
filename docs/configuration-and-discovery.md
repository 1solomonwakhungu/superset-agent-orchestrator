# Portable configuration and Superset discovery

This document is the normative contract for locating Superset and constructing
child processes. Implementations MUST follow the requirements expressed by the
capitalized terms in this document.

## Configuration sources and precedence

Configuration MUST be merged by field, from lowest to highest precedence:

1. Built-in defaults.
2. User configuration.
3. Workspace configuration.
4. Environment variables.
5. Command-line arguments or explicit library-call options.

An absent value falls through to the next lower source. An invalid value MUST
fail validation and MUST NOT silently fall through. Unknown configuration keys
MUST fail validation. The user configuration location follows the operating
system instead of a fixed username or home path:

| Platform | User configuration |
| --- | --- |
| Linux and other Unix | `$XDG_CONFIG_HOME/superset-agent-orchestrator/config.json`, or the platform home directory plus `.config/superset-agent-orchestrator/config.json` |
| macOS | The platform application-support directory plus `superset-agent-orchestrator/config.json` |
| Windows | `%APPDATA%\superset-agent-orchestrator\config.json` |

Workspace configuration is `.superset/orchestrator.json`, resolved from the
explicit workspace root. Discovery MUST NOT walk above that root.

The portable environment mappings are:

| Variable | Configuration field |
| --- | --- |
| `SUPERSET_ORCHESTRATOR_EXECUTABLE` | `superset.executable` |
| `SUPERSET_ORCHESTRATOR_HOST_STATE` | `superset.hostState` |
| `SUPERSET_ORCHESTRATOR_DISCOVERY_TIMEOUT_MS` | `timeouts.discoveryMs` |
| `SUPERSET_ORCHESTRATOR_STARTUP_TIMEOUT_MS` | `timeouts.startupMs` |
| `SUPERSET_ORCHESTRATOR_SHUTDOWN_TIMEOUT_MS` | `timeouts.shutdownMs` |

Environment allowlist and fixed values are configured only through JSON or
explicit options. This prevents variable names and secrets from leaking through
process listings.

Default timeouts are 5,000 ms for discovery, 30,000 ms for startup, and 10,000
ms for shutdown. Timeouts use monotonic elapsed time and include cleanup.

## Executable discovery

Discovery MUST use this order:

1. Resolve `superset.executable` when configured. An absolute path is checked
   directly. A bare executable name is resolved using the current process search
   path. A relative value containing a path separator is invalid.
2. Resolve executable names `superset` and `superset-desktop` using the current
   process search path. On Windows, honor `PATHEXT` and test regular files only.
3. Query platform application registration without recursively scanning disks:
   Launch Services on macOS, registered application aliases and uninstall
   records on Windows, and XDG desktop entries on Linux.

Every candidate MUST be canonicalized with the platform filesystem API and
checked for the platform's executable semantics. Duplicate canonical paths are
collapsed. Discovery commands MUST use argument arrays without a shell and MUST
obey `timeouts.discoveryMs`.

No candidates is an error that names the attempted mechanisms and the supported
override. More than one distinct candidate is a conflict and MUST NOT select the
first candidate. The error MUST list redacted candidate identities and instruct
the operator to set `superset.executable`. This makes parallel stable, preview,
and per-user installations explicit rather than nondeterministic.

## Host-state discovery

An explicit `superset.hostState` MUST be absolute and takes precedence. Without
it, host state is resolved from platform data directories:

| Platform | Host-state base |
| --- | --- |
| Linux and other Unix | `$XDG_STATE_HOME`, falling back to the platform home directory plus `.local/state` |
| macOS | The platform application-support directory |
| Windows | `%LOCALAPPDATA%` |

The implementation appends the documented Superset state subdirectory for the
installed product. It MUST validate ownership where the platform exposes it and
MUST reject symlinks or junctions that escape the canonical state base. Missing
state is reported separately from a missing executable. Discovery MUST NOT
create or mutate host state.

If multiple supported product state directories exist and no candidate can be
associated uniquely with the selected executable, discovery MUST fail and ask
for `superset.hostState`.

## Child environment

Children MUST receive a newly constructed environment, never the complete
parent environment. A value is inherited only when its name is in the effective
allowlist. `environment.set` adds or replaces only explicitly named values.

The default portable allowlist is `PATH`, `HOME`, `USERPROFILE`, `TMPDIR`,
`TMP`, `TEMP`, `SystemRoot`, `ComSpec`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`,
`COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `HTTP_PROXY`, `HTTPS_PROXY`,
`NO_PROXY`, and their lowercase proxy variants. Windows name comparisons are
case-insensitive. User additions are additive. Empty values are preserved.

Variables commonly carrying credentials, tokens, cookies, dynamic-loader
injection, language runtime injection, or shell startup hooks are not defaults.
In particular, names matching `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*COOKIE*`,
`*CREDENTIAL*`, `*API_KEY*`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`,
`PYTHONSTARTUP`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, and `GIT_ASKPASS` MUST be
rejected from inheritance even if added to `environment.allow`. A required
secret must be delivered through a purpose-built credential channel, not ambient
environment inheritance.

## Startup diagnostics and redaction

Before launch, emit one structured diagnostic containing:

- configuration source for each non-default field;
- executable and host-state discovery mechanism;
- candidate count and stable, per-run candidate identifiers;
- effective timeout values;
- inherited and explicitly set environment variable names, never values.

Diagnostics MUST NOT contain organization names, usernames, hostnames, raw
machine paths, environment values, command output, or file contents. Paths are
represented as `<home>/...`, `<workspace>/...`, or `<system>/...` when rooted in
a known base. Other paths use `<path:HASH>`, where `HASH` is a per-run keyed hash
that is stable only within that process. URLs retain scheme and port but replace
userinfo and host with `<redacted-host>` and remove query and fragment data.

Errors returned to callers follow the same policy. Full unredacted diagnostics
MUST NOT be enabled by an environment variable. If a future explicit debug sink
is introduced, it must be local, opt-in, permission-restricted, and separate
from normal logs.
