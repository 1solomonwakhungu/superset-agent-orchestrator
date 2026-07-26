import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const experimentRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  experimentId: z.string().regex(/^exp_[0-9a-f-]{36}$/),
  parentBaselineFingerprint: hash,
  hypothesis: z.string().trim().min(1).max(1_000),
  config: z.record(z.string(), jsonValue),
  checkpointSha: checkpoint,
  env: z.record(z.string(), jsonValue),
  corpusHash: hash,
  metrics: z.record(z.string(), z.number().finite()),
  artifactLinks: z.array(z.string().url()),
  status: z.enum(["succeeded", "failed", "aborted"]),
  timestamp: z.iso.datetime(),
  ownerAgent: z.string().trim().min(1).max(200),
});

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
  baselineExperimentId: string;
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
      if (
        records.some(
          (existing) => existing.experimentId === record.experimentId,
        )
      )
        throw new Error(`Experiment already exists: ${record.experimentId}`);
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
    baselineExperimentId: string,
    experimentId: string,
  ): Promise<ExperimentDiff> {
    return this.withLock(async () => {
      const records = await this.readUnlocked();
      const baseline = records.find(
        (record) => record.experimentId === baselineExperimentId,
      );
      const experiment = records.find(
        (record) => record.experimentId === experimentId,
      );
      if (!baseline)
        throw new Error(`Unknown baseline experiment: ${baselineExperimentId}`);
      if (!experiment) throw new Error(`Unknown experiment: ${experimentId}`);
      if (
        baseline.parentBaselineFingerprint !==
        experiment.parentBaselineFingerprint
      )
        throw new Error(
          "Experiments reference different baseline fingerprints",
        );
      const changes: ExperimentDiff["changes"] = [];
      for (const key of [
        "checkpointSha",
        "config",
        "corpusHash",
        "env",
        "metrics",
      ] as const) {
        diffValues(`/${key}`, baseline[key], experiment[key], changes);
      }
      return { baselineExperimentId, experimentId, changes };
    });
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
    return contents
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
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    await handle.close();
    const previous = queues.get(this.path) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolveQueue) => {
      releaseQueue = resolveQueue;
    });
    const tail = previous.then(() => queued);
    queues.set(this.path, tail);
    await previous;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.path, {
        realpath: false,
        stale: 10_000,
        update: 2_000,
        retries: { retries: 50, minTimeout: 20, maxTimeout: 100 },
      });
      return await operation();
    } finally {
      if (release) await release();
      releaseQueue();
      if (queues.get(this.path) === tail) queues.delete(this.path);
    }
  }
}
