# Result capture

`ResultCaptureService` accepts terminal results only through an `AgentAdapter` or
an explicit delivery from the same supported adapter boundary. It does not read
Superset databases, transcripts, terminal logs, process output, private APIs, or
other inferred result sources.

Each durable result copies the immutable assignment identity established before
launch: assignment, batch, session, workspace, attempt, backend run, and task
attribution. Legacy assignments without exact workspace and attempt identities
fail closed. A delivery fingerprint makes exact duplicate and late delivery a
no-op while rejecting changed bytes or a conflicting terminal result.

The normalized claim records complete, empty, partial, missing, or malformed
output and preserves adapter stop reasons. Adapter output remains an agent
claim. `verifiedArtifacts` is deliberately separate and empty because capture
does not independently verify files, commits, pull requests, checks, or other
material assertions.

The public Superset capability boundary remains unchanged. Superset status,
final result, stop reason, cancellation, and recovery operations remain
unsupported and fail closed until a supported public interface is proven and
enabled by the compatibility policy.
