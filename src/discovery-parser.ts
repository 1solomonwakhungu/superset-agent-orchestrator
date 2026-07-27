import { z } from "zod";

const boundedString = z.string().max(4_096).refine((value) => !value.includes("\0"), "NUL bytes are not allowed");
const nonEmptyString = boundedString.min(1);
const nullableString = boundedString.nullable();

export const supersetVersionSchema = z.string().regex(
  /^(?:superset v?)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
  "expected a semantic Superset version",
);

export const localHostSchema = z.strictObject({
  running: z.boolean(),
  healthy: z.boolean(),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  endpoint: z.string().url(),
  organizationId: nonEmptyString,
  hostId: nonEmptyString,
  hostName: nonEmptyString,
  uptimeSec: z.number().nonnegative(),
});

const canonicalProjectSchema = z.strictObject({
  id: nonEmptyString,
  name: nonEmptyString,
  slug: nonEmptyString,
  repoCloneUrl: nullableString,
  githubRepositoryId: nullableString,
  setUp: z.enum(["yes", "no"]),
  path: nullableString,
});

const localCliProjectSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  repo: boundedString,
  path: nullableString,
});

export const projectSchema = z.union([
  canonicalProjectSchema,
  localCliProjectSchema.transform(({ id, name, repo, path }) => ({
    id,
    name,
    slug: name,
    repoCloneUrl: repo === "-" ? null : repo,
    githubRepositoryId: null,
    setUp: path === null ? "no" as const : "yes" as const,
    path,
  })),
]);

const canonicalWorkspaceSchema = z.strictObject({
  id: nonEmptyString,
  organizationId: nonEmptyString,
  projectId: nonEmptyString,
  hostId: nonEmptyString,
  name: nonEmptyString,
  branch: nonEmptyString,
  type: nonEmptyString,
  createdByUserId: nullableString,
  taskId: nullableString,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  worktreePath: nonEmptyString,
  worktreeExists: z.boolean(),
  projectName: nonEmptyString,
  hostName: nonEmptyString,
});

const localCliWorkspaceSchema = z.object({
  id: nonEmptyString,
  organizationId: nonEmptyString,
  projectId: nonEmptyString,
  hostId: nonEmptyString,
  name: nonEmptyString,
  branch: nonEmptyString,
  type: nonEmptyString,
  createdByUserId: nullableString,
  taskId: nullableString,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  worktreePath: nonEmptyString,
  worktreeExists: z.boolean(),
  projectName: nonEmptyString,
});

export const workspaceSchema = z.union([
  canonicalWorkspaceSchema,
  localCliWorkspaceSchema.transform((workspace) => ({ ...workspace, hostName: "local" })),
]);

export const agentPresetSchema = z.strictObject({
  id: nonEmptyString,
  presetId: nonEmptyString,
  iconId: nullableString.optional(),
  label: nonEmptyString,
  command: nonEmptyString,
  args: z.array(boundedString).max(100).optional(),
  promptTransport: z.enum(["argv", "stdin"]).optional(),
  promptArgs: z.array(boundedString).max(100).optional(),
  env: z.record(z.string().max(256), boundedString).optional(),
  order: z.number().int().nonnegative().optional(),
});

export type LocalHost = z.infer<typeof localHostSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type AgentPreset = z.infer<typeof agentPresetSchema>;

export function parseVersion(stdout: string): string {
  const value = supersetVersionSchema.parse(stdout.trim());
  return value.replace(/^superset v?/, "");
}

export function parseJson<T>(stdout: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Superset returned invalid JSON");
  }
  return schema.parse(value);
}

export const projectListSchema = z.array(projectSchema).max(10_000);
export const workspaceListSchema = z.array(workspaceSchema).max(10_000);
export const agentPresetListSchema = z.array(agentPresetSchema).max(1_000);
