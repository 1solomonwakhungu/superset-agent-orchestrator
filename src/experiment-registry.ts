import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { z } from "zod";

const queues = new Map<string, Promise<void>>();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const checkpoint = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const nonEmptyJsonObject = z
  .record(z.string(), jsonValue)
  .refine((value) => Object.keys(value).length > 0, "Must not be empty");

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const experimentRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  experimentId: z
    .string()
    .regex(
      /^exp_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  parentBaselineFingerprint: hash,
  lineage: z.enum(["baseline", "disklm", "callforge", "fgguf"]),
  hypothesis: z.string().trim().min(1).max(1_000),
  config: z.record(z.string(), jsonValue),
  checkpointSha: checkpoint,
  env: nonEmptyJsonObject,
  hardware: nonEmptyJsonObject,
  codeRevision: checkpoint,
  tokenizerHash: hash,
  chatTemplateHash: hash,
  corpusHash: hash,
  metrics: z.record(z.string(), z.number().finite()),
  artifactLinks: z.array(z.string().url()),
  status: z.enum(["succeeded", "failed", "aborted"]),
  timestamp: z.iso.datetime(),
  ownerAgent: z.string().trim().min(1).max(200),
});

export const baselineCatalogSchema = z.array(
  z.strictObject({
    fingerprint: hash,
    config: z.record(z.string(), jsonValue),
    checkpointSha: checkpoint,
    env: nonEmptyJsonObject,
    hardware: nonEmptyJsonObject,
    codeRevision: checkpoint,
    tokenizerHash: hash,
    chatTemplateHash: hash,
    corpusHash: hash,
    metrics: z.record(z.string(), z.number().finite()),
  }),
);
type BaselineRecord = z.infer<typeof baselineCatalogSchema>[number];

export type ExperimentRecord = z.infer<typeof experimentRecordSchema>;
export type ExperimentInput = Omit<
  ExperimentRecord,
  "schemaVersion" | "experimentId" | "timestamp"
> & {
  experimentId?: string;
  timestamp?: string;
};
export type ExperimentQuery = Partial<
  Pick<
    ExperimentRecord,
    | "hypothesis"
    | "checkpointSha"
    | "parentBaselineFingerprint"
    | "status"
    | "ownerAgent"
  >
>;

export interface ExperimentDiff {
  baselineFingerprint: string;
  experimentId: string;
  changes: Array<{
    path: string;
    baseline?: JsonValue;
    experiment?: JsonValue;
  }>;
}

function pointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function diffValues(
  path: string,
  baseline: JsonValue | undefined,
  experiment: JsonValue | undefined,
  changes: ExperimentDiff["changes"],
): void {
  if (JSON.stringify(baseline) === JSON.stringify(experiment)) return;
  if (
    baseline !== null &&
    experiment !== null &&
    !Array.isArray(baseline) &&
    !Array.isArray(experiment) &&
    typeof baseline === "object" &&
    typeof experiment === "object"
  ) {
    for (const key of [
      ...new Set([...Object.keys(baseline), ...Object.keys(experiment)]),
    ].sort()) {
      diffValues(
        `${path}/${pointer(key)}`,
        baseline[key],
        experiment[key],
        changes,
      );
    }
    return;
  }
  changes.push({
    path,
    ...(baseline === undefined ? {} : { baseline }),
    ...(experiment === undefined ? {} : { experiment }),
  });
}

export class ExperimentRegistry {
  readonly path: string;

  constructor(
    path: string,
    private readonly baselineCatalogPath: string = resolve(
      "minicpm5/baseline-fingerprints.json",
    ),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {
    this.path = resolve(path);
  }

  async add(input: ExperimentInput): Promise<ExperimentRecord> {
    return this.withLock(async () => {
      const records = await this.readUnlocked();
      const record = experimentRecordSchema.parse({
        ...input,
        schemaVersion: 1,
        experimentId: input.experimentId ?? `exp_${this.createId()}`,
        timestamp: input.timestamp ?? this.now().toISOString(),
      });
      const baselines = await this.readBaselines();
      if (
        !baselines.some(
          (baseline) =>
            baseline.fingerprint === record.parentBaselineFingerprint,
        )
      ) {
        throw new Error(
          `Unknown baseline fingerprint: ${record.parentBaselineFingerprint}`,
        );
      }
      if (
        records.some(
          (existing) => existing.experimentId === record.experimentId,
        )
      )
        throw new Error(`Experiment already exists: ${record.experimentId}`);
      const conflictingLineage = records.find(
        (existing) =>
          existing.checkpointSha === record.checkpointSha &&
          existing.lineage !== record.lineage,
      );
      if (conflictingLineage) {
        throw new Error(
          `Checkpoint ${record.checkpointSha} already belongs to lineage ${conflictingLineage.lineage}`,
        );
      }
      const serialized = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(serialized) > 1_048_576)
        throw new Error("Experiment record exceeds 1 MiB");
      const file = await open(this.path, "a", 0o600);
      try {
        await file.write(serialized);
        await file.sync();
      } finally {
        await file.close();
      }
      return record;
    });
  }

  async query(query: ExperimentQuery = {}): Promise<ExperimentRecord[]> {
    return this.withLock(async () => {
      await this.readBaselines();
      const records = await this.readUnlocked();
      return records
        .filter((record) =>
          Object.entries(query).every(
            ([key, value]) => record[key as keyof ExperimentRecord] === value,
          ),
        )
        .sort(
          (left, right) =>
            left.timestamp.localeCompare(right.timestamp) ||
            left.experimentId.localeCompare(right.experimentId),
        );
    });
  }

  async diff(
    baselineFingerprint: string,
    experimentId: string,
  ): Promise<ExperimentDiff> {
    return this.withLock(async () => {
      const records = await this.readUnlocked();
      const baseline = (await this.readBaselines()).find(
        (record) => record.fingerprint === baselineFingerprint,
      );
      const experiment = records.find(
        (record) => record.experimentId === experimentId,
      );
      if (!baseline)
        throw new Error(`Unknown baseline fingerprint: ${baselineFingerprint}`);
      if (!experiment) throw new Error(`Unknown experiment: ${experimentId}`);
      if (baseline.fingerprint !== experiment.parentBaselineFingerprint)
        throw new Error(
          "Experiment references a different baseline fingerprint",
        );
      const changes: ExperimentDiff["changes"] = [];
      for (const key of [
        "checkpointSha",
        "config",
        "corpusHash",
        "env",
        "hardware",
        "codeRevision",
        "tokenizerHash",
        "chatTemplateHash",
        "metrics",
      ] as const) {
        diffValues(`/${key}`, baseline[key], experiment[key], changes);
      }
      return { baselineFingerprint, experimentId, changes };
    });
  }

  private async readBaselines(): Promise<BaselineRecord[]> {
    try {
      const baselines = baselineCatalogSchema.parse(
        JSON.parse(await readFile(this.baselineCatalogPath, "utf8")),
      );
      const fingerprints = new Set<string>();
      for (const baseline of baselines) {
        if (fingerprints.has(baseline.fingerprint))
          throw new Error(
            `Duplicate baseline fingerprint: ${baseline.fingerprint}`,
          );
        fingerprints.add(baseline.fingerprint);
      }
      return baselines;
    } catch (error) {
      throw new Error(`Invalid baseline catalog: ${this.baselineCatalogPath}`, {
        cause: error,
      });
    }
  }

  private async readUnlocked(): Promise<ExperimentRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (contents.length > 0 && !contents.endsWith("\n"))
      throw new Error("Registry has a truncated final line");
    const records = contents
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return experimentRecordSchema.parse(JSON.parse(line));
        } catch (error) {
          throw new Error(`Invalid registry record on line ${index + 1}`, {
            cause: error,
          });
        }
      });
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.experimentId))
        throw new Error(
          `Duplicate experiment ID in registry: ${record.experimentId}`,
        );
      ids.add(record.experimentId);
    }
    return records;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    await handle.close();
    const canonicalPath = await realpath(this.path);
    const previous = queues.get(canonicalPath) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolveQueue) => {
      releaseQueue = resolveQueue;
    });
    const tail = previous.then(() => queued);
    queues.set(canonicalPath, tail);
    await previous;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(canonicalPath, {
        stale: 10_000,
        update: 2_000,
        retries: { retries: 50, minTimeout: 20, maxTimeout: 100 },
      });
      return await operation();
    } finally {
      if (release) await release();
      releaseQueue();
      if (queues.get(canonicalPath) === tail) queues.delete(canonicalPath);
    }
  }
}
