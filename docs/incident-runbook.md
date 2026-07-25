# Agency property incident runbook

This runbook is for the five public agency properties. Keep real cluster,
tunnel, and origin details in approved private systems. Never paste them into
public issues, reports, or monitoring output.

## Triage order

1. Preserve the failing `status.json` and UTC timestamp. Confirm whether the
   failure is HTTP status, latency, TLS expiry, or content signature.
2. Re-run one read-only check. The monitor deduplicates repeated failures into
   one open incident, so repeated runs do not create incident noise.
3. Check the layers below in order. Stop after identifying the first unhealthy
   layer. Do not change production until the cause and rollback are understood.
4. After remediation, run the check again. Confirm the incident becomes
   `resolved`, has `resolved_at`, and all five properties report operational.

## DNS

- Resolve the public hostname from two independent resolvers.
- Confirm it returns only expected public records and that no private address
  or internal hostname is exposed.
- Compare authoritative nameserver answers with recursive answers to detect
  propagation or stale-cache problems.
- If DNS changed unexpectedly, restore the last reviewed GitOps/provider value
  through the normal change process. Do not make an undocumented hot fix.

## Cloudflare tunnel

- Confirm the managed tunnel reports connected connectors and inspect recent
  connector logs in the private operations environment.
- Verify the public hostname maps to the intended service route without
  revealing the tunnel ID or origin address in tickets or reports.
- Distinguish edge TLS failures from origin reachability failures. A healthy
  connector does not prove the application is ready.
- Restart or rotate a connector only under the established operational policy;
  monitoring itself remains read-only.

## Flux reconciliation

- Inspect the relevant source and kustomization reconciliation conditions in
  the private cluster.
- Verify the applied Git revision equals the reviewed default-branch revision.
- Read controller events for fetch, authentication, validation, or dependency
  failures. Reconcile through Git rather than patching drift manually.
- If rollback is required, revert the faulty Git change and wait for successful
  reconciliation before continuing.

## GHCR image pull

- Inspect pod events for `ImagePullBackOff`, manifest-not-found, authorization,
  architecture, or rate-limit errors.
- Confirm the deployment references an existing immutable digest or expected
  release tag and that the namespace pull secret exists.
- Never print registry credentials. Repair credentials through the approved
  secret workflow and restart only after events confirm pulls can succeed.

## Pod readiness

- Compare desired, available, and ready replica counts and inspect readiness
  probe failures and restart history.
- Check scheduling, resource pressure, mounts, security context, and dependency
  readiness before increasing timeouts or resources.
- Read application logs from the failing pod while preserving request IDs and
  UTC timestamps. Do not include secrets or customer data in the incident.

## Application errors

- Reproduce the public request without mutation and correlate its UTC timestamp
  with private application logs.
- Separate route-level 404/5xx failures, startup/configuration failures,
  dependency failures, and incorrect content deployments.
- If only the content signature fails, verify that the expected identifying
  text still exists. Update a signature only when the product change was
  intentional and reviewed, never merely to turn a check green.

## Recovery verification

Run a fresh check against all five URLs, not only the recovered service. Record
the generated UTC timestamp, HTTP status, latency, certificate expiry, content
signature result, incident recovery timestamp, and exact Git revision. Generate
the weekly report and retain both artifacts privately. An incident is complete
only when the monitor reports operational and the open incident count is zero.
