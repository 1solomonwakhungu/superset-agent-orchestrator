export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly unknown[];
  format?: "date-time" | "email" | "uri" | "uuid";
};

export type ToolSchema = {
  input: JsonSchema;
  output?: JsonSchema;
};

export type CallReference = {
  $ref: string;
};

export type CallNode = {
  id: string;
  tool: string;
  arguments: unknown;
  dependsOn?: readonly string[];
};

export type CallGraph = {
  nodes: readonly CallNode[];
};

export const diagnosticTaxonomy = {
  CFV001: "graph_shape",
  CFV002: "duplicate_node",
  CFV003: "unknown_tool",
  CFV004: "missing_dependency",
  CFV005: "cycle",
  CFV101: "type_mismatch",
  CFV102: "required_field",
  CFV103: "enum_constraint",
  CFV104: "format_constraint",
  CFV105: "unknown_field",
  CFV106: "edge_type_mismatch",
  CFV201: "implicit_dependency",
} as const;

export type DiagnosticId = keyof typeof diagnosticTaxonomy;
export type ValidationDiagnostic = {
  id: DiagnosticId;
  category: (typeof diagnosticTaxonomy)[DiagnosticId];
  severity: "error" | "warning";
  nodeId: string | null;
  path: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  diagnostics: readonly ValidationDiagnostic[];
};

const referenceKeys = new Set(["$ref"]);

export function validateCallGraph(
  graph: unknown,
  tools: Readonly<Record<string, ToolSchema>>,
): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];
  const report = (
    id: DiagnosticId,
    nodeId: string | null,
    path: string,
    message: string,
    severity: "error" | "warning" = "error",
  ) =>
    diagnostics.push({
      id,
      category: diagnosticTaxonomy[id],
      severity,
      nodeId,
      path,
      message,
    });

  if (!isRecord(graph) || !Array.isArray(graph.nodes)) {
    report("CFV001", null, "$", "graph must contain a nodes array");
    return finish(diagnostics);
  }

  const nodes: CallNode[] = [];
  const byId = new Map<string, CallNode>();
  for (const [index, candidate] of graph.nodes.entries()) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !candidate.id ||
      typeof candidate.tool !== "string" ||
      !("arguments" in candidate) ||
      (candidate.dependsOn !== undefined &&
        (!Array.isArray(candidate.dependsOn) ||
          candidate.dependsOn.some((value) => typeof value !== "string")))
    ) {
      report("CFV001", null, `$.nodes[${index}]`, "node shape is invalid");
      continue;
    }
    const node = candidate as CallNode;
    nodes.push(node);
    if (byId.has(node.id)) {
      report("CFV002", node.id, `$.nodes[${index}].id`, "node id is duplicated");
    } else {
      byId.set(node.id, node);
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const node of nodes) {
    const dependencies = adjacency.get(node.id) ?? new Set<string>();
    for (const dependency of node.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        report(
          "CFV004",
          node.id,
          `$.nodes.${node.id}.dependsOn`,
          `dependency ${dependency} does not exist`,
        );
      } else {
        dependencies.add(dependency);
      }
    }
    adjacency.set(node.id, dependencies);
    const tool = tools[node.tool];
    if (!tool) {
      report("CFV003", node.id, `$.nodes.${node.id}.tool`, `unknown tool ${node.tool}`);
      continue;
    }
    validateValue(
      node.arguments,
      tool.input,
      `$.nodes.${node.id}.arguments`,
      node.id,
      byId,
      tools,
      dependencies,
      report,
    );
  }

  detectCycles(adjacency, (nodeId) =>
    report("CFV005", nodeId, `$.nodes.${nodeId}`, "dependency graph contains a cycle"),
  );
  diagnostics.sort((left, right) =>
    [left.nodeId ?? "", left.path, left.id, left.message].join("\0").localeCompare(
      [right.nodeId ?? "", right.path, right.id, right.message].join("\0"),
    ),
  );
  return finish(diagnostics);
}

function validateValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
  nodeId: string,
  nodes: ReadonlyMap<string, CallNode>,
  tools: Readonly<Record<string, ToolSchema>>,
  dependencies: Set<string>,
  report: (
    id: DiagnosticId,
    nodeId: string | null,
    path: string,
    message: string,
    severity?: "error" | "warning",
  ) => void,
): void {
  if (isReference(value)) {
    const source = nodes.get(value.$ref);
    if (!source) {
      report("CFV004", nodeId, path, `reference ${value.$ref} does not exist`);
      return;
    }
    if (!dependencies.has(value.$ref)) {
      report(
        "CFV201",
        nodeId,
        path,
        `reference ${value.$ref} should be declared in dependsOn`,
        "warning",
      );
      dependencies.add(value.$ref);
    }
    const output = tools[source.tool]?.output;
    if (!output || !compatible(output, schema)) {
      report("CFV106", nodeId, path, `output of ${value.$ref} is incompatible`);
    }
    return;
  }
  if (!matchesType(value, schema.type)) {
    report("CFV101", nodeId, path, `expected ${schema.type ?? "any"}`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value)))
    report("CFV103", nodeId, path, "value is not in enum");
  if (schema.format && typeof value === "string" && !matchesFormat(value, schema.format))
    report("CFV104", nodeId, path, `value is not a valid ${schema.format}`);
  if (schema.type === "object" && isRecord(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value))
        report("CFV102", nodeId, `${path}.${required}`, "required field is missing");
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) {
        validateValue(
          child,
          childSchema,
          `${path}.${key}`,
          nodeId,
          nodes,
          tools,
          dependencies,
          report,
        );
      } else if (schema.additionalProperties === false) {
        report("CFV105", nodeId, `${path}.${key}`, "field is not allowed");
      }
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((child, index) =>
      validateValue(
        child,
        schema.items!,
        `${path}[${index}]`,
        nodeId,
        nodes,
        tools,
        dependencies,
        report,
      ),
    );
  }
}

function detectCycles(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  report: (nodeId: string) => void,
): void {
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (node: string): boolean => {
    if (active.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    active.add(node);
    const cyclic = [...(adjacency.get(node) ?? [])].some(walk);
    active.delete(node);
    return cyclic;
  };
  for (const node of adjacency.keys()) if (walk(node)) report(node);
}

function finish(diagnostics: readonly ValidationDiagnostic[]): ValidationResult {
  return {
    valid: !diagnostics.some(({ severity }) => severity === "error"),
    diagnostics,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReference(value: unknown): value is CallReference {
  return (
    isRecord(value) &&
    typeof value.$ref === "string" &&
    Object.keys(value).every((key) => referenceKeys.has(key))
  );
}

function matchesType(value: unknown, type: JsonSchema["type"]): boolean {
  if (!type) return true;
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function compatible(source: JsonSchema, target: JsonSchema): boolean {
  if (!source.type || !target.type) return true;
  return source.type === target.type || (source.type === "integer" && target.type === "number");
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesFormat(value: string, format: NonNullable<JsonSchema["format"]>): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uuid")
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (format === "uri") {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  return !Number.isNaN(Date.parse(value)) && /T/.test(value);
}
