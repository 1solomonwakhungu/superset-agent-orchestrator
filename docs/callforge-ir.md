# CallForge Typed Call DAG IR

Version `1.0` is the contract between goal compilers, validators, and executors.
It is model- and tool-set-neutral. Tool schemas are supplied by the caller rather
than embedded in the graph.

Each `CallNode` has a stable ID, tool ID, typed argument bindings, named typed
outputs, and `parallelizable`, `optional`, and `repair_of` annotations. A binding
contains either a literal or a source node/output pair. Source bindings and
`repair_of` annotations form directed dependency edges.

`CallGraph.validate()` reports, rather than prevents construction of, duplicate
nodes or arguments, cycles, dangling sources/outputs/repairs, unknown tools,
missing required arguments, and incompatible edge or argument types. This makes
malformed model output representable for diagnostics and repair.

`topological_order()` is deterministic in document order. `parallel_frontiers()`
groups calls whose dependencies are complete and emits non-parallelizable calls
alone.

JSON serialization is canonical and version checked. The XML bridge accepts the
pinned MiniCPM5/SGLang form:

```xml
<function name="weather"><param name="city">Nairobi</param></function>
```

XML has no dependency or type syntax, so its canonical import creates independent
string-valued calls. Export rejects source bindings rather than losing them.
