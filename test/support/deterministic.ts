import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Seeded generators for property-style tests. Every case is reproducible from
 * its seed, so a failure reported by CI can be replayed offline without network
 * access, wall-clock dependence, or shared machine state.
 */
export class SeededRandom {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32: small, fast, and stable across Node releases and platforms. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  integer(minimum: number, maximum: number): number {
    return minimum + Math.floor(this.next() * (maximum - minimum + 1));
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.integer(0, values.length - 1)];
    if (value === undefined) throw new Error("Cannot pick from an empty list");
    return value;
  }

  /** Fisher-Yates over a copy, so the caller's input is never reordered. */
  shuffle<T>(values: readonly T[]): T[] {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const target = this.integer(0, index);
      const left = copy[index] as T;
      copy[index] = copy[target] as T;
      copy[target] = left;
    }
    return copy;
  }

  word(prefix: string): string {
    return `${prefix}-${this.integer(0, 0xffffff).toString(16).padStart(6, "0")}`;
  }
}

/** Fixed seeds keep the suite deterministic; widen the list to broaden search. */
export const PROPERTY_SEEDS = [1, 7, 19, 42, 101, 2026] as const;

export async function withTemporaryDirectory(
  prefix: string,
  run: (directory: string) => void | Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Clock that advances by a fixed step, so timestamps are ordered but fixed. */
export function steadyClock(start = "2026-07-01T00:00:00.000Z", stepMs = 1_000): () => Date {
  let current = new Date(start).getTime() - stepMs;
  return () => {
    current += stepMs;
    return new Date(current);
  };
}
