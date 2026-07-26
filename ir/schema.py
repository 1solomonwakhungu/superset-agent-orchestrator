"""Typed, versioned DAG contract shared by CallForge compilers and executors."""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping

IR_VERSION = "1.0"
UNSET = object()


@dataclass(frozen=True)
class TypeRef:
    """A JSON Schema type, optionally anchored in a registered tool schema."""

    json_type: str
    schema_ref: str | None = None

    def accepts(self, other: "TypeRef") -> bool:
        if self.json_type == "any" or self == other:
            return True
        return self.schema_ref is None and other.schema_ref is None and self.json_type == "number" and other.json_type == "integer"


@dataclass(frozen=True)
class ValueSource:
    node_id: str
    output: str


@dataclass(frozen=True)
class Binding:
    argument: str
    value_type: TypeRef
    literal: Any = UNSET
    source: ValueSource | None = None


@dataclass(frozen=True)
class CallNode:
    id: str
    tool_id: str
    arguments: tuple[Binding, ...] = ()
    outputs: Mapping[str, TypeRef] = field(default_factory=dict)
    parallelizable: bool = True
    optional: bool = False
    repair_of: str | None = None


@dataclass(frozen=True)
class ToolSchema:
    arguments: Mapping[str, TypeRef] = field(default_factory=dict)
    required: frozenset[str] = frozenset()
    outputs: Mapping[str, TypeRef] = field(default_factory=dict)


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    message: str
    path: str


@dataclass(frozen=True)
class CallGraph:
    nodes: tuple[CallNode, ...]
    version: str = IR_VERSION

    def validate(self, tool_schemas: Mapping[str, ToolSchema] | None = None) -> tuple[ValidationIssue, ...]:
        issues: list[ValidationIssue] = []
        by_id: dict[str, CallNode] = {}
        for index, node in enumerate(self.nodes):
            path = f"nodes[{index}]"
            if not node.id:
                issues.append(ValidationIssue("empty_id", "node id must not be empty", f"{path}.id"))
            elif node.id in by_id:
                issues.append(ValidationIssue("duplicate_node", f"duplicate node id {node.id!r}", f"{path}.id"))
            else:
                by_id[node.id] = node
            if not isinstance(node.parallelizable, bool):
                issues.append(ValidationIssue("invalid_annotation", "parallelizable must be a boolean", f"{path}.parallelizable"))
            if not isinstance(node.optional, bool):
                issues.append(ValidationIssue("invalid_annotation", "optional must be a boolean", f"{path}.optional"))

        dependencies: dict[str, set[str]] = {node_id: set() for node_id in by_id}
        for index, node in enumerate(self.nodes):
            seen_arguments: set[str] = set()
            for binding_index, binding in enumerate(node.arguments):
                path = f"nodes[{index}].arguments[{binding_index}]"
                if binding.argument in seen_arguments:
                    issues.append(ValidationIssue("duplicate_argument", f"duplicate argument {binding.argument!r}", path))
                seen_arguments.add(binding.argument)
                has_literal = binding.literal is not UNSET
                if has_literal == (binding.source is not None):
                    issues.append(ValidationIssue("invalid_binding", "binding must have exactly one of literal or source", path))
                if has_literal and not _literal_matches(binding.literal, binding.value_type):
                    issues.append(ValidationIssue("literal_type_mismatch", f"literal does not match {binding.value_type.json_type}", path))
                if binding.source is None:
                    continue
                source = by_id.get(binding.source.node_id)
                if source is None:
                    issues.append(ValidationIssue("dangling_source", f"unknown source node {binding.source.node_id!r}", f"{path}.source"))
                    continue
                dependencies.setdefault(node.id, set()).add(source.id)
                output_type = source.outputs.get(binding.source.output)
                if output_type is None:
                    issues.append(ValidationIssue("dangling_output", f"unknown output {binding.source.output!r} on {source.id!r}", f"{path}.source"))
                elif not binding.value_type.accepts(output_type):
                    issues.append(ValidationIssue("type_mismatch", f"{output_type.json_type} output cannot bind to {binding.value_type.json_type} argument", path))
            if node.repair_of is not None:
                if node.repair_of not in by_id:
                    issues.append(ValidationIssue("dangling_repair", f"unknown repaired node {node.repair_of!r}", f"nodes[{index}].repair_of"))
                else:
                    dependencies.setdefault(node.id, set()).add(node.repair_of)
            if tool_schemas is not None:
                expected = tool_schemas.get(node.tool_id)
                if expected is None:
                    issues.append(ValidationIssue("unknown_tool", f"unknown tool {node.tool_id!r}", f"nodes[{index}].tool_id"))
                else:
                    supplied = {binding.argument: binding.value_type for binding in node.arguments}
                    for name in supplied.keys() - expected.arguments.keys():
                        issues.append(ValidationIssue("unknown_argument", f"unknown argument {name!r}", f"nodes[{index}].arguments"))
                    for name in expected.required:
                        actual = supplied.get(name)
                        if actual is None:
                            issues.append(ValidationIssue("missing_argument", f"missing required argument {name!r}", f"nodes[{index}].arguments"))
                    for name, actual in supplied.items():
                        expected_type = expected.arguments.get(name)
                        if expected_type is not None and not expected_type.accepts(actual):
                            issues.append(ValidationIssue("argument_type_mismatch", f"argument {name!r} must be {expected_type.json_type}", f"nodes[{index}].arguments"))
                    for name, actual in node.outputs.items():
                        expected_type = expected.outputs.get(name)
                        if expected_type is None:
                            issues.append(ValidationIssue("unknown_output", f"unknown output {name!r}", f"nodes[{index}].outputs"))
                        elif not expected_type.accepts(actual):
                            issues.append(ValidationIssue("output_type_mismatch", f"output {name!r} must be {expected_type.json_type}", f"nodes[{index}].outputs"))

        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node_id: str) -> bool:
            if node_id in visiting:
                return True
            if node_id in visited:
                return False
            visiting.add(node_id)
            cyclic = any(visit(dependency) for dependency in dependencies.get(node_id, ()) if dependency in by_id)
            visiting.remove(node_id)
            visited.add(node_id)
            return cyclic

        if any(visit(node_id) for node_id in by_id):
            issues.append(ValidationIssue("cycle", "call graph contains a dependency cycle", "nodes"))
        return tuple(issues)

    def topological_order(self) -> tuple[str, ...]:
        issues = self.validate()
        if issues:
            raise ValueError("cannot order an invalid call graph")
        dependencies = self._dependencies()
        order: list[str] = []
        remaining = set(dependencies)
        while remaining:
            ready = [node.id for node in self.nodes if node.id in remaining and not (dependencies[node.id] & remaining)]
            order.extend(ready)
            remaining.difference_update(ready)
        return tuple(order)

    def parallel_frontiers(self) -> tuple[tuple[str, ...], ...]:
        dependencies = self._dependencies()
        remaining = set(self.topological_order())
        completed: set[str] = set()
        frontiers: list[tuple[str, ...]] = []
        while remaining:
            candidates = [node for node in self.nodes if node.id in remaining and dependencies[node.id] <= completed]
            serial = next((node for node in candidates if not node.parallelizable), None)
            ready = (serial.id,) if serial is not None else tuple(node.id for node in candidates)
            frontiers.append(ready)
            remaining.difference_update(ready)
            completed.update(ready)
        return tuple(frontiers)

    def _dependencies(self) -> dict[str, set[str]]:
        dependencies = {node.id: set() for node in self.nodes}
        for node in self.nodes:
            dependencies[node.id].update(binding.source.node_id for binding in node.arguments if binding.source is not None)
            if node.repair_of is not None:
                dependencies[node.id].add(node.repair_of)
        return dependencies

    def to_json(self) -> str:
        def encode_binding(binding: Binding) -> dict[str, Any]:
            encoded = {"argument": binding.argument, "value_type": asdict(binding.value_type)}
            if binding.literal is not UNSET:
                encoded["literal"] = binding.literal
            if binding.source is not None:
                encoded["source"] = asdict(binding.source)
            return encoded

        nodes = []
        for node in self.nodes:
            encoded = asdict(node)
            encoded["arguments"] = [encode_binding(binding) for binding in node.arguments]
            nodes.append(encoded)
        return json.dumps({"version": self.version, "nodes": nodes}, separators=(",", ":"), sort_keys=True)

    @classmethod
    def from_json(cls, payload: str) -> "CallGraph":
        raw = json.loads(payload)
        if raw.get("version") != IR_VERSION:
            raise ValueError(f"unsupported IR version {raw.get('version')!r}")
        nodes = []
        for raw_node in raw["nodes"]:
            arguments = tuple(Binding(
                argument=item["argument"],
                value_type=TypeRef(**item["value_type"]),
                literal=item["literal"] if "literal" in item else UNSET,
                source=ValueSource(**item["source"]) if item.get("source") is not None else None,
            ) for item in raw_node.get("arguments", ()))
            outputs = {name: TypeRef(**type_ref) for name, type_ref in raw_node.get("outputs", {}).items()}
            nodes.append(CallNode(
                id=raw_node["id"], tool_id=raw_node["tool_id"], arguments=arguments, outputs=outputs,
                parallelizable=raw_node.get("parallelizable", True), optional=raw_node.get("optional", False),
                repair_of=raw_node.get("repair_of"),
            ))
        return cls(nodes=tuple(nodes), version=raw["version"])


def _literal_matches(value: Any, type_ref: TypeRef) -> bool:
    checks = {
        "null": lambda item: item is None,
        "boolean": lambda item: isinstance(item, bool),
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "number": lambda item: isinstance(item, (int, float)) and not isinstance(item, bool) and (not isinstance(item, float) or math.isfinite(item)),
        "string": lambda item: isinstance(item, str),
        "array": lambda item: isinstance(item, list),
        "object": lambda item: isinstance(item, dict),
        "any": lambda item: True,
    }
    check = checks.get(type_ref.json_type)
    return check is not None and check(value)
