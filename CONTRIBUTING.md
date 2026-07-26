# Contributing

All changes must be made on a feature branch and submitted through a pull
request. Do not push product changes directly to `main`.

Before requesting review:

1. Run `npm ci`.
2. Run `npm audit --audit-level=high`.
3. Run `npm run check`.
4. Confirm `npm run check` leaves generated schemas unchanged.

Keep changes scoped, add tests for changed behavior, and do not include secrets,
private infrastructure details, generated runtime state, or release/versioning
changes unless the pull request explicitly owns them.

Update `docs/public-readiness.md` when a change affects contracts, tools,
capabilities, configuration, limitations, or requirement-to-test evidence. Fake
and provider-fixture tests do not prove a capability exists in Superset. Core
behavior must remain client-independent and must not depend on Hermes.

Use exact-head pull request checks as review evidence. Do not add tags, publish a
package, introduce a changelog policy, or change release versions unless a
separate task explicitly owns release management.
