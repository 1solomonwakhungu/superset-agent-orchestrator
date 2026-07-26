import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  LeaseRecoveryAmbiguousError,
  WorkspaceWriterBusyError,
  type LeaseAuthority,
  type OrchestratorStorage,
  type WorkspaceLeaseStatus,
} from "./storage.js";
import { DurableStore } from "./store.js";

/** Bounded, non-secret view of a workspace used by the read-only safety diagnostic. */
export interface WorkspaceSafetyReport {
  workspaceId: string;
  admissible: boolean;
  reason: string;
  lastGeneration: number;
  lease: WorkspaceLeaseStatus | null;
  ownerProcess: "absent" | "alive" | "unverifiable" | "none";
  lockHeldElsewhere: boolean;
}

export interface ProcessProbe {
  /** Start token identifying this exact process instance, not a reusable PID. */
  startToken(pid: number): string | undefined;
  exists(pid: number): boolean;
}

export const defaultProcessProbe: ProcessProbe = {
  startToken: (pid) => DurableStore.processStartedAt(pid),
  exists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

export interface WorkspaceSafetyOptions {
  lockDirectory: string;
  serverInstanceId?: string;
  hostId?: string;
  processProbe?: ProcessProbe;
  /** How long a lock file survives its owner before another process may steal it. */
  lockStaleMs?: number;
}

/**
 * Writer admission and recovery for workspaces.
 *
 * Admission needs two independent layers: an exclusive operating-system lock that
 * works across orchestrator processes, and the durable fenced lease generation.
 * Neither the passage of time nor a missing heartbeat releases a writer; only a
 * two-phase release by the current owner, or recovery backed by proof that the
 * exact owner process is gone, retires a generation.
 */
export class WorkspaceSafetyTool {
  readonly serverInstanceId: string;
  private readonly lockDirectory: string;
  private readonly hostId: string;
  private readonly probe: ProcessProbe;
  private readonly lockStaleMs: number;
  private readonly heldLocks = new Map<string, () => void>();

  constructor(private readonly storage: OrchestratorStorage, options: WorkspaceSafetyOptions) {
    this.lockDirectory = options.lockDirectory;
    this.serverInstanceId = options.serverInstanceId ?? randomUUID();
    this.hostId = options.hostId ?? hostname();
    this.probe = options.processProbe ?? defaultProcessProbe;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
  }

  /** Read-only diagnostic. It reports facts and never changes authority. */
  inspect(workspaceId: string, now = new Date()): WorkspaceSafetyReport {
    const lease = this.storage.blockingWriterLease(workspaceId);
    const lastGeneration = this.storage.lastAllocatedGeneration(workspaceId);
    const lockHeldElsewhere = this.lockHeldElsewhere(workspaceId);
    if (!lease) {
      return { workspaceId, admissible: !lockHeldElsewhere,
        reason: lockHeldElsewhere ? "workspace lock is held elsewhere" : "no blocking writer lease",
        lastGeneration, lease: null, ownerProcess: "none", lockHeldElsewhere };
    }
    const expired = lease.expiresAt <= now.toISOString();
    const reason = lease.state === "quarantined"
      ? "workspace is quarantined and needs evidence-based repair"
      : `writer generation ${lease.generation} is ${lease.state}${expired ? " and expired" : ""}`;
    return { workspaceId, admissible: false, reason, lastGeneration, lease,
      ownerProcess: this.ownerProcessState(lease), lockHeldElsewhere };
  }

  /** Latest generation for the workspace, released or not. */
  status(workspaceId: string): WorkspaceLeaseStatus | null {
    return this.storage.workspaceLeaseStatus(workspaceId);
  }

  /**
   * Takes the exclusive OS lock, then allocates the durable generation. The lock is
   * held for the whole lease lifetime and dropped only by release or recovery.
   */
  acquireWriter(input: {
    workspaceId: string;
    ownerBatchId: string;
    ownerSessionId?: string | null;
    ttlMs: number;
    now?: Date;
  }): LeaseAuthority {
    let releaseLock: () => void;
    try {
      releaseLock = this.lock(input.workspaceId);
    } catch (error) {
      if (error instanceof WorkspaceWriterBusyError) {
        this.storage.recordPolicyDenial(input.workspaceId, error.code,
          input.ownerSessionId ?? input.ownerBatchId, { layer: "os_lock" }, input.now ?? new Date());
      }
      throw error;
    }
    try {
      const authority = this.storage.acquireWriterLease({
        ...input,
        serverInstanceId: this.serverInstanceId,
        ownerHost: this.hostId,
      });
      this.heldLocks.set(authority.leaseId, releaseLock);
      return authority;
    } catch (error) {
      releaseLock();
      throw error;
    }
  }

  heartbeat(authority: LeaseAuthority, ttlMs: number, now = new Date()): LeaseAuthority {
    this.assertLockHeld(authority.leaseId);
    return this.storage.heartbeatWriterLease(authority, ttlMs, now);
  }

  /** Binds the spawned owner process so recovery can later prove it is gone. */
  bindProcess(authority: LeaseAuthority, processId: number, now = new Date()): LeaseAuthority {
    this.assertLockHeld(authority.leaseId);
    const startToken = this.probe.startToken(processId);
    if (startToken === undefined) {
      throw new LeaseRecoveryAmbiguousError("Owner process identity could not be captured");
    }
    return this.storage.bindWriterProcess(authority, processId, startToken, now);
  }

  /** Two-phase durable release first, then the OS lock. */
  releaseWriter(authority: LeaseAuthority, now = new Date()): void {
    this.assertLockHeld(authority.leaseId);
    if (authority.processId !== null && this.ownerProcessState({
      ...this.storage.workspaceLeaseById(authority.leaseId)!,
      processId: authority.processId,
      processStartToken: authority.processStartToken,
    }) !== "absent") {
      throw new LeaseRecoveryAmbiguousError("Writer process must be authoritatively absent before release");
    }
    this.storage.releaseWriterLease(authority, now);
    this.dropLock(authority.leaseId);
  }

  /**
   * Startup and operator reconciliation for one workspace. Preserves a live owner,
   * quarantines inconclusive evidence, and retires only a provably dead generation.
   */
  recoverWorkspace(workspaceId: string, actor: string, now = new Date()): WorkspaceSafetyReport {
    const lease = this.storage.blockingWriterLease(workspaceId);
    if (!lease) return this.inspect(workspaceId, now);
    if (lease.state === "quarantined") {
      throw new LeaseRecoveryAmbiguousError("Workspace is quarantined and needs evidence-based repair");
    }
    // This instance is the live owner: an owner releases its lease, never recovers it.
    if (this.heldLocks.has(lease.leaseId)) return this.inspect(workspaceId, now);
    let releaseLock: () => void;
    try {
      releaseLock = this.lock(workspaceId);
    } catch (error) {
      if (error instanceof WorkspaceWriterBusyError) {
        throw new LeaseRecoveryAmbiguousError("Another process may still hold the workspace lock");
      }
      throw error;
    }
    try {
      const ownerProcess = this.ownerProcessState(lease);
      if (ownerProcess !== "absent") {
        this.storage.quarantineWriterLease(lease.leaseId,
          ownerProcess === "alive" ? "owner process is still alive" : "owner process identity is unverifiable",
          actor, now);
        this.heldLocks.set(lease.leaseId, releaseLock);
        throw new LeaseRecoveryAmbiguousError(ownerProcess === "alive"
          ? "Owner process is still alive, so the live writer is preserved"
          : "Owner process identity is unverifiable");
      }
      this.storage.recoverExpiredWriterLease(lease.leaseId,
        { ownerProcessAbsent: true, detail: "owner pid and start token authoritatively absent while lock held" },
        actor, now);
      releaseLock();
      return this.inspect(workspaceId, now);
    } catch (error) {
      if (!this.heldLocks.has(lease.leaseId)) releaseLock();
      throw error;
    }
  }

  /** The one repair flow: independently prove absence, then retire the generation. */
  repairQuarantine(leaseId: string, actor: string, now = new Date()): void {
    const lease = this.storage.workspaceLeaseById(leaseId);
    if (!lease || lease.state !== "quarantined") {
      throw new LeaseRecoveryAmbiguousError("Repair requires an existing quarantined lease");
    }
    const heldRelease = this.heldLocks.get(leaseId);
    let releaseLock = heldRelease;
    if (!releaseLock) {
      try {
        releaseLock = this.lock(lease.workspaceId);
      } catch (error) {
        if (error instanceof WorkspaceWriterBusyError) {
          throw new LeaseRecoveryAmbiguousError("Another process may still hold the workspace lock");
        }
        throw error;
      }
    }
    try {
      if (this.ownerProcessState(lease) !== "absent") {
        throw new LeaseRecoveryAmbiguousError("Repair refused without verified owner-process absence");
      }
      this.storage.repairQuarantinedWriterLease(leaseId,
        { ownerProcessAbsent: true, detail: "local host, pid, start token, and exclusive lock verified" },
        actor, now);
      if (heldRelease) this.dropLock(leaseId);
      else releaseLock();
    } catch (error) {
      if (!heldRelease) releaseLock();
      throw error;
    }
  }

  /** Drops every lock this instance holds without changing durable authority. */
  close(): void {
    for (const leaseId of [...this.heldLocks.keys()]) this.dropLock(leaseId);
  }

  private ownerProcessState(lease: WorkspaceLeaseStatus): WorkspaceSafetyReport["ownerProcess"] {
    if (lease.ownerHost !== this.hostId) return "unverifiable";
    if (lease.processId === null || lease.processStartToken === null) return "unverifiable";
    if (!this.probe.exists(lease.processId)) return "absent";
    const startToken = this.probe.startToken(lease.processId);
    if (startToken === undefined) return "unverifiable";
    return startToken === lease.processStartToken ? "alive" : "absent";
  }

  /** Owner-only lock file derived from the workspace key, never from a raw path. */
  private lockPath(workspaceId: string): string {
    mkdirSync(this.lockDirectory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.lockDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (directory.mode & 0o077) !== 0 || directory.uid !== process.geteuid?.()) {
      throw new LeaseRecoveryAmbiguousError("Workspace lock directory is not owner-only");
    }
    const key = createHash("sha256").update(workspaceId, "utf8").digest("hex");
    const path = join(this.lockDirectory, `${key}.lease`);
    const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const file = fstatSync(descriptor);
      if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0 || file.uid !== process.geteuid?.()) {
        throw new LeaseRecoveryAmbiguousError("Workspace lock file is not a private regular file");
      }
    } finally {
      closeSync(descriptor);
    }
    return path;
  }

  private lock(workspaceId: string): () => void {
    try {
      return lockfile.lockSync(this.lockPath(workspaceId), { realpath: false, stale: this.lockStaleMs });
    } catch (error) {
      if ((error as { code?: string }).code === "ELOCKED") {
        throw new WorkspaceWriterBusyError("Another process holds the workspace writer lock");
      }
      throw error;
    }
  }

  private lockHeldElsewhere(workspaceId: string): boolean {
    try {
      return lockfile.checkSync(this.lockPath(workspaceId), { realpath: false, stale: this.lockStaleMs });
    } catch {
      return true;
    }
  }

  private dropLock(leaseId: string): void {
    const release = this.heldLocks.get(leaseId);
    if (!release) return;
    this.heldLocks.delete(leaseId);
    release();
  }

  private assertLockHeld(leaseId: string): void {
    if (!this.heldLocks.has(leaseId)) {
      throw new LeaseRecoveryAmbiguousError("Writer no longer holds the workspace lock");
    }
  }
}
