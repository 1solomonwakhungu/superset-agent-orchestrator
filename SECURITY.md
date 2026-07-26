# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Until private
vulnerability reporting is enabled, contact the repository owner privately
through their GitHub profile and request a secure reporting channel. Include
reproduction steps, affected versions or commits, impact, and any suggested
mitigation only through that private channel.

Do not include credentials, tokens, private infrastructure identifiers, customer
data, or unsanitized runtime state in reports or pull requests.

This project has not published a supported release. Security fixes target the
current `main` branch until a versioning policy is established.

## Trust boundary

The supported control plane is local stdio for a single trusted operator. There
is no authenticated network transport. Agents can perform powerful local
mutations, so only canonical registered workspaces may be targeted, ambient
secrets must not be inherited, and durable state and evidence must remain
private. Provider test tools are disabled by default, restricted to child paths
beneath an explicit test root, and must not be enabled for normal operation.

Public writer launch remains disabled because canonical identity, OS-enforced
read-only sharing, and descendant-process reconciliation are incomplete. The
fixture-only provider launch route is an explicit test opt-in, not a production
safety claim. See
the [threat model](docs/security/local-control-plane-threat-model.md) for the
authoritative controls and residual risks.
