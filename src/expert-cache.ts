export type CachePolicy = "lru" | "lfu" | "gdsf" | "hybrid";

export interface ExpertAccess {
  id: string;
  sizeBytes: number;
  fetchCost?: number;
}

export interface CacheOptions {
  capacityBytes: number;
  policy: CachePolicy;
  staticExperts?: readonly ExpertAccess[];
  admissionControl?: boolean;
}

export interface CacheSnapshot {
  capacityBytes: number;
  residentBytes: number;
  staticBytes: number;
  hits: number;
  misses: number;
  admissions: number;
  rejections: number;
  evictions: number;
  residentIds: string[];
}

interface Entry extends Required<ExpertAccess> {
  frequency: number;
  lastAccess: number;
  pinned: boolean;
  priority: number;
}

interface HistoryEntry {
  frequency: number;
  sizeBytes: number;
}

function validateAccess(access: ExpertAccess): Required<ExpertAccess> {
  if (access.id.length === 0) throw new Error("expert id must not be empty");
  if (!Number.isSafeInteger(access.sizeBytes) || access.sizeBytes <= 0) {
    throw new Error(`invalid size for expert ${access.id}`);
  }
  const fetchCost = access.fetchCost ?? 1;
  if (!Number.isFinite(fetchCost) || fetchCost <= 0) {
    throw new Error(`invalid fetch cost for expert ${access.id}`);
  }
  return { ...access, fetchCost };
}

export class ExpertCache {
  readonly #capacityBytes: number;
  readonly #policy: CachePolicy;
  readonly #admissionControl: boolean;
  readonly #entries = new Map<string, Entry>();
  readonly #history = new Map<string, HistoryEntry>();
  readonly #historyLimit: number;
  #clock = 0;
  #residentBytes = 0;
  #staticBytes = 0;
  #inflation = 0;
  #hits = 0;
  #misses = 0;
  #admissions = 0;
  #rejections = 0;
  #evictions = 0;

  constructor(options: CacheOptions) {
    if (!Number.isSafeInteger(options.capacityBytes) || options.capacityBytes <= 0) {
      throw new Error("cache capacity must be a positive safe integer");
    }
    this.#capacityBytes = options.capacityBytes;
    this.#policy = options.policy;
    this.#admissionControl = options.admissionControl ?? true;
    this.#historyLimit = Math.max(1, Math.floor(options.capacityBytes / 64));

    for (const candidate of options.staticExperts ?? []) {
      const access = validateAccess(candidate);
      if (this.#entries.has(access.id)) throw new Error(`duplicate static expert ${access.id}`);
      if (this.#residentBytes + access.sizeBytes > this.#capacityBytes) {
        throw new Error("static expert set exceeds cache capacity");
      }
      this.#entries.set(access.id, this.#makeEntry(access, true));
      this.#residentBytes += access.sizeBytes;
      this.#staticBytes += access.sizeBytes;
    }
  }

  access(candidate: ExpertAccess): boolean {
    const access = validateAccess(candidate);
    this.#clock += 1;
    const history = this.#history.get(access.id);
    if (history && history.sizeBytes !== access.sizeBytes) {
      throw new Error(`size changed for expert ${access.id}`);
    }
    const historicalFrequency = (history?.frequency ?? 0) + 1;
    this.#remember(access.id, { frequency: historicalFrequency, sizeBytes: access.sizeBytes });
    const resident = this.#entries.get(access.id);
    if (resident) {
      if (resident.sizeBytes !== access.sizeBytes) {
        throw new Error(`size changed for resident expert ${access.id}`);
      }
      resident.frequency = historicalFrequency;
      resident.lastAccess = this.#clock;
      resident.fetchCost = access.fetchCost;
      resident.priority = this.#priority(resident);
      this.#hits += 1;
      return true;
    }

    this.#misses += 1;
    const entry = this.#makeEntry(access, false, historicalFrequency);
    if (entry.sizeBytes > this.#capacityBytes - this.#staticBytes) {
      this.#rejections += 1;
      return false;
    }

    const victims = this.#selectVictims(entry.sizeBytes);
    if (this.#admissionControl && victims.length > 0) {
      const candidateValue = entry.frequency * entry.fetchCost;
      const victimValue = victims.reduce(
        (total, victim) => total + victim.frequency * victim.fetchCost,
        0,
      );
      if (candidateValue <= victimValue) {
        this.#rejections += 1;
        return false;
      }
    }

    for (const victim of victims) this.#evict(victim);
    this.#entries.set(entry.id, entry);
    this.#residentBytes += entry.sizeBytes;
    this.#admissions += 1;
    return false;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  snapshot(): CacheSnapshot {
    return {
      capacityBytes: this.#capacityBytes,
      residentBytes: this.#residentBytes,
      staticBytes: this.#staticBytes,
      hits: this.#hits,
      misses: this.#misses,
      admissions: this.#admissions,
      rejections: this.#rejections,
      evictions: this.#evictions,
      residentIds: [...this.#entries.keys()].sort(),
    };
  }

  #makeEntry(access: Required<ExpertAccess>, pinned: boolean, frequency = 0): Entry {
    const entry: Entry = {
      ...access,
      frequency,
      lastAccess: this.#clock,
      pinned,
      priority: 0,
    };
    entry.priority = this.#priority(entry);
    return entry;
  }

  #priority(entry: Entry): number {
    switch (this.#policy) {
      case "lru": return entry.lastAccess;
      case "lfu": return entry.frequency;
      case "gdsf": return this.#inflation + entry.frequency * entry.fetchCost / entry.sizeBytes;
      case "hybrid": return entry.frequency * entry.fetchCost / entry.sizeBytes + entry.lastAccess / (this.#clock + 1);
    }
  }

  #selectVictims(requiredBytes: number): Entry[] {
    const candidates = [...this.#entries.values()]
      .filter((entry) => !entry.pinned)
      .sort((left, right) => this.#priority(left) - this.#priority(right) || left.id.localeCompare(right.id));
    const victims: Entry[] = [];
    let available = this.#capacityBytes - this.#residentBytes;
    for (const candidate of candidates) {
      if (available >= requiredBytes) break;
      victims.push(candidate);
      available += candidate.sizeBytes;
    }
    if (available < requiredBytes) throw new Error("cache accounting invariant violated");
    return victims;
  }

  #evict(entry: Entry): void {
    this.#entries.delete(entry.id);
    this.#residentBytes -= entry.sizeBytes;
    this.#inflation = this.#priority(entry);
    this.#evictions += 1;
  }

  #remember(id: string, history: HistoryEntry): void {
    this.#history.delete(id);
    this.#history.set(id, history);
    while (this.#history.size > this.#historyLimit) {
      const oldest = this.#history.keys().next().value;
      if (oldest === undefined) break;
      this.#history.delete(oldest);
    }
  }
}

export function rankStaticExperts(
  accesses: readonly ExpertAccess[],
  budgetBytes: number,
): ExpertAccess[] {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new Error("invalid hot-set budget");
  const stats = new Map<string, { access: Required<ExpertAccess>; frequency: number }>();
  for (const candidate of accesses) {
    const access = validateAccess(candidate);
    const existing = stats.get(access.id);
    if (existing && existing.access.sizeBytes !== access.sizeBytes) {
      throw new Error(`size changed for expert ${access.id}`);
    }
    if (existing) existing.frequency += 1;
    else stats.set(access.id, { access, frequency: 1 });
  }
  const ranked = [...stats.values()].sort((left, right) =>
    right.frequency * right.access.fetchCost / right.access.sizeBytes
      - left.frequency * left.access.fetchCost / left.access.sizeBytes
      || left.access.id.localeCompare(right.access.id));
  const selected: ExpertAccess[] = [];
  let used = 0;
  for (const { access } of ranked) {
    if (used + access.sizeBytes > budgetBytes) continue;
    selected.push(access);
    used += access.sizeBytes;
  }
  return selected;
}
