import { z } from "zod";

const nonEmptyString = z.string().min(1);
const nullableString = z.string().nullable();

export const supersetVersionSchema = z.string().regex(
  /^(?:superset v?)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
  "expected a semantic Superset version",
);

export const localHostSchema = z.object({
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

export const projectSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  slug: nonEmptyString,
  repoCloneUrl: nullableString,
  githubRepositoryId: nullableString,
  setUp: z.enum(["yes", "no"]),
  path: nullableString,
});

export const workspaceSchema = z.object({
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

export const agentPresetSchema = z.object({
  id: nonEmptyString,
  presetId: nonEmptyString,
  iconId: nullableString.optional(),
  label: nonEmptyString,
  command: nonEmptyString,
  args: z.array(z.string()).optional(),
  promptTransport: z.enum(["argv", "stdin"]).optional(),
  promptArgs: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
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

export const projectListSchema = z.array(projectSchema);
export const workspaceListSchema = z.array(workspaceSchema);
export const agentPresetListSchema = z.array(agentPresetSchema);
