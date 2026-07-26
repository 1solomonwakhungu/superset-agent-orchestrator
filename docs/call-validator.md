# CallForge Static Validator

`validateCallGraph` validates a CallForge IR graph without executing tools or
mutating its inputs. Runtime and data-pipeline consumers receive deterministic,
node-addressed diagnostics with stable `CFVnnn` IDs exported through
`diagnosticTaxonomy`.

Hard errors cover graph shape, duplicate and missing nodes, cycles, unknown tools,
JSON-schema types, required fields, enums, supported formats, closed-object fields,
and incompatible output-to-input edges. `CFV201` is a warning: references imply a
dependency, but callers should declare that edge explicitly for readable IR.

The contract intentionally implements the schema subset used by CallForge IR:
objects, arrays, scalar types, `required`, `additionalProperties`, `enum`, and the
`date-time`, `email`, `uri`, and `uuid` formats. Unsupported schema keywords are not
silently interpreted as constraints and should be added with corpus cases before use.
