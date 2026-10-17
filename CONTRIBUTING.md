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
package, edit `CHANGELOG.md`, or change release versions by hand.

## Releases

Releases are automated with
[release-please](https://github.com/googleapis/release-please). Write commit
messages, or squash-merge titles, as
[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `ci:`, and so on). On every push to `main`, the `Release` workflow
opens or updates a release pull request that bumps `package.json`,
`package-lock.json`, and `CHANGELOG.md`. Merging that pull request creates the
`vX.Y.Z` tag and GitHub release. While the version is below 1.0.0, `feat:`
bumps the minor version and `fix:` bumps the patch version. The package is
private and is not published to npm.

The workflow uses the `RELEASE_PLEASE_TOKEN` secret when it is set, so release
pull requests trigger the required CI checks. Without it, the workflow falls
back to `GITHUB_TOKEN`, which requires the repository setting "Allow GitHub
Actions to create and approve pull requests" and does not start CI on the
release pull request.
