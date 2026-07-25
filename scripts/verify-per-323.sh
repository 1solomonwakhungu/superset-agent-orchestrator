#!/bin/sh
set -eu

report=docs/local-routing-relay-failure.md
evidence=evidence/per-323/relay-unavailable.json

test -f "$report"
test -f "$evidence"
jq -e '
  .issue == "PER-323" and
  .versions.supersetCli == "1.16.1" and
  (.observations | length) == 6 and
  (.localInventory.duplicateNameGroups > 0)
' "$evidence" >/dev/null

for code in \
  AMBIGUOUS_WORKSPACE \
  REMOTE_WORKSPACE \
  DUPLICATE_WORKSPACE \
  WORKSPACE_UNAVAILABLE
do
  rg -q "$code" "$report"
done

for operation in \
  'List projects' \
  'Create project' \
  'Set up project' \
  'List workspaces' \
  'Get workspace' \
  'Create workspace' \
  'Update workspace' \
  'Delete workspace' \
  'Open workspace' \
  'List agents' \
  'Create agent' \
  'Create terminal'
do
  rg -q "| $operation |" "$report"
done

printf '%s\n' 'PER-323 evidence and routing contract verified'
