import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LeaseFencedError,
  LeaseRecoveryAmbiguousError,
  OrchestratorStorage,
  WorkspaceWriterBusyError,
  type LeaseAuthority,
} from "../src/storage.js";
import { WorkspaceSafetyTool, type ProcessProbe } from "../src/workspace-safety.js";

/** Controllable stand-in for the operating-system process probe. */
class FakeProbe implements ProcessProbe {
  readonly running = new Map<number, string | undefined>();

  startToken(pid: number): string | undefined {
    return this.running.get(pid);
  }

  exists(pid: number): boolean {
    return this.running.has(pid);
  }
}

interface Harness {
  storage: OrchestratorStorage;
  probe: FakeProbe;
  directory: string;
  tool: (serverInstanceId: string) => WorkspaceSafetyTool;
}

async function withWorkspace(run: (harness: Harness) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "workspace-leases-"));
  const storage = new OrchestratorStorage(join(directory, "registry.sqlite"));
  const probe = new FakeProbe();
  const tools: WorkspaceSafetyTool[] = [];
  try {
    const seeded: [string, string][] = [["batch-1", "overnight"], ["batch-2", "overnight-2"]];
    for (const [id, name] of seeded) {
      storage.database.prepare("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, name, "solomon", "active", "{}", "2026-07-24T00:00:00.000Z", "2026-07-24T00:00:00.000Z", null);
    }
    run({
      storage,
      probe,
      directory,
      tool: (serverInstanceId) => {
        const tool = new WorkspaceSafetyTool(storage, {
          lockDirectory: join(directory, "locks"),
          serverInstanceId,
          hostId: "test-host",
          processProbe: probe,
        });
        tools.push(tool);
        return tool;
      },
    });
  } finally {
    for (const tool of tools) tool.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const acquiredAt = new Date("2026-07-24T01:00:00.000Z");
const after = (ms: number): Date => new Date(acquiredAt.getTime() + ms);

test("only one writer generation is authoritative for a workspace", async () => {
  await withWorkspace(({ storage, tool }) => {
    const owner = tool("server-a");
    const lease = owner.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 30_000 });
    assert.equal(lease.generation, 1);

    // Operating-system layer: a second server instance cannot take the lock.
    const rival = tool("server-b");
    assert.throws(() => rival.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-2", ttlMs: 30_000 }),
      WorkspaceWriterBusyError);

    // Durable layer, bypassing the lock, denies admission on its own.
    assert.throws(() => storage.acquireWriterLease({ workspaceId: "ws", ownerBatchId: "batch-2", ttlMs: 30_000 }),
      WorkspaceWriterBusyError);
    assert.equal(storage.database.prepare("SELECT COUNT(*) count FROM workspace_leases").get()?.count, 1);
    assert.equal(owner.inspect("ws").admissible, false);
    assert.equal(storage.database.prepare(
      "SELECT COUNT(*) count FROM events WHERE event_type = 'policy_denied'").get()?.count, 2);

    // A different workspace is unaffected.
    assert.equal(rival.acquireWriter({ workspaceId: "other", ownerBatchId: "batch-2", ttlMs: 30_000 }).generation, 1);
  });
});

test("heartbeat and release require the current token, owner, and row version", async () => {
  await withWorkspace(({ storage, tool }) => {
    const owner = tool("server-a");
    const lease = owner.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 30_000, now: acquiredAt });

    const staleAuthorities: LeaseAuthority[] = [
      { ...lease, fencingToken: "wrong" },
      { ...lease, generation: lease.generation + 1 },
      { ...lease, serverInstanceId: "server-b" },
      { ...lease, ownerBatchId: "batch-2" },
    ];
    for (const stale of staleAuthorities) {
      assert.throws(() => owner.heartbeat(stale, 30_000, after(1_000)), LeaseFencedError);
      assert.throws(() => storage.releaseWriterLease(stale, after(1_000)), LeaseFencedError);
    }

    const renewed = owner.heartbeat(lease, 30_000, after(1_000));
    assert.equal(renewed.rowVersion, lease.rowVersion + 1);
    // The superseded row version is now stale for both renewal and release.
    assert.throws(() => owner.heartbeat(lease, 30_000, after(1_100)), LeaseFencedError);
    assert.throws(() => storage.releaseWriterLease(lease, after(1_100)), LeaseFencedError);

    storage.assertWriterLease(renewed, after(2_000));
    owner.releaseWriter(renewed, after(2_000));
    assert.throws(() => storage.assertWriterLease(renewed, after(2_100)), LeaseFencedError);
    assert.throws(() => storage.releaseWriterLease(renewed, after(2_100)), LeaseFencedError);

    // The retired generation can never be reused by the next writer.
    const replacement = tool("server-b").acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-2", ttlMs: 30_000 });
    assert.equal(replacement.generation, 2);
    assert.throws(() => storage.assertWriterLease({ ...replacement, generation: 1 }), LeaseFencedError);

    assert.deepEqual(storage.database.prepare("SELECT event_type FROM events ORDER BY sequence").all()
      .map((row) => (row as { event_type: string }).event_type),
    ["lease_acquired", "lease_heartbeat", "lease_released", "lease_acquired"]);
  });
});

test("expiry alone never releases a lease and recovery needs owner-process proof", async () => {
  await withWorkspace(({ storage, probe, tool }) => {
    const owner = tool("server-a");
    probe.running.set(4_242, "start-token-1");
    const lease = owner.bindProcess(
      owner.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 1_000, now: acquiredAt }),
      4_242, acquiredAt);

    // The owner crashed: the process is gone, but the lease survives its expiry.
    probe.running.delete(4_242);
    owner.close();
    const restarted = tool("server-b");
    assert.equal(restarted.inspect("ws", after(2_000)).admissible, false);
    assert.equal(restarted.inspect("ws", after(2_000)).ownerProcess, "absent");
    assert.throws(() => storage.acquireWriterLease({ workspaceId: "ws", ownerBatchId: "batch-2", ttlMs: 30_000 }),
      WorkspaceWriterBusyError);

    // Before expiry, recovery is refused even though the process is absent.
    assert.throws(() => restarted.recoverWorkspace("ws", "operator", after(500)), LeaseRecoveryAmbiguousError);
    assert.equal(storage.workspaceLeaseStatus("ws")?.state, "active");

    const report = restarted.recoverWorkspace("ws", "operator", after(2_000));
    assert.equal(report.admissible, true);
    assert.equal(storage.workspaceLeaseStatus("ws")?.state, "released");
    assert.equal(restarted.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-2", ttlMs: 30_000 }).generation, 2);

    const recovered = storage.database.prepare(
      "SELECT data_json FROM events WHERE event_type = 'lease_recovered'").get() as { data_json: string };
    assert.equal(JSON.parse(recovered.data_json).evidence, "owner_process_absent");
    assert.throws(() => storage.recoverExpiredWriterLease(lease.leaseId, { ownerProcessAbsent: true },
      "operator", after(3_000)), LeaseRecoveryAmbiguousError);
  });
});

test("a live owner is quarantined rather than displaced, and repair is evidence-based", async () => {
  await withWorkspace(({ storage, probe, tool }) => {
    const owner = tool("server-a");
    probe.running.set(4_242, "start-token-1");
    const lease = owner.bindProcess(
      owner.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 1_000, now: acquiredAt }),
      4_242, acquiredAt);
    owner.close();

    // The server restarted while the owned process kept running past lease expiry.
    const restarted = tool("server-b");
    assert.equal(restarted.inspect("ws", after(5_000)).ownerProcess, "alive");
    assert.throws(() => restarted.recoverWorkspace("ws", "operator", after(5_000)), LeaseRecoveryAmbiguousError);
    assert.equal(storage.workspaceLeaseStatus("ws")?.state, "quarantined");
    assert.throws(() => storage.acquireWriterLease({ workspaceId: "ws", ownerBatchId: "batch-2", ttlMs: 30_000 }),
      WorkspaceWriterBusyError);
    assert.throws(() => restarted.recoverWorkspace("ws", "operator", after(6_000)), LeaseRecoveryAmbiguousError);

    // The still-live owner keeps no authority once quarantined.
    assert.throws(() => storage.heartbeatWriterLease(lease, 30_000, after(5_000)), LeaseFencedError);
    assert.throws(() => storage.releaseWriterLease(lease, after(5_000)), LeaseFencedError);

    assert.throws(() => restarted.repairQuarantine(lease.leaseId, "operator", after(7_000)),
      LeaseRecoveryAmbiguousError);
    probe.running.delete(4_242);
    restarted.repairQuarantine(lease.leaseId, "operator", after(7_000));
    assert.throws(() => restarted.repairQuarantine(lease.leaseId, "operator", after(7_100)),
      LeaseRecoveryAmbiguousError);

    assert.equal(restarted.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-2", ttlMs: 30_000 }).generation, 2);
    assert.deepEqual(storage.database.prepare(
      "SELECT event_type FROM events WHERE event_type IN ('lease_quarantined', 'lease_repaired') ORDER BY sequence")
      .all().map((row) => (row as { event_type: string }).event_type), ["lease_quarantined", "lease_repaired"]);
  });
});

test("a foreign-host owner is never inferred absent from the local process table", async () => {
  await withWorkspace(({ storage, probe, directory }) => {
    probe.running.set(4_242, "different-local-process");
    const owner = new WorkspaceSafetyTool(storage, {
      lockDirectory: join(directory, "locks"), serverInstanceId: "server-a",
      hostId: "remote-host", processProbe: probe,
    });
    const lease = owner.bindProcess(
      owner.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 1_000, now: acquiredAt }),
      4_242, acquiredAt);
    owner.close();

    const restarted = new WorkspaceSafetyTool(storage, {
      lockDirectory: join(directory, "locks"), serverInstanceId: "server-b",
      hostId: "test-host", processProbe: probe,
    });
    assert.equal(restarted.inspect("ws", after(5_000)).ownerProcess, "unverifiable");
    assert.throws(() => restarted.recoverWorkspace("ws", "operator", after(5_000)),
      LeaseRecoveryAmbiguousError);
    assert.throws(() => restarted.repairQuarantine(lease.leaseId, "operator", after(6_000)),
      LeaseRecoveryAmbiguousError);
    assert.equal(storage.workspaceLeaseStatus("ws")?.state, "quarantined");
    restarted.close();
  });
});

test("an unverifiable owner identity quarantines instead of admitting a writer", async () => {
  await withWorkspace(({ storage, tool }) => {
    const owner = tool("server-a");
    owner.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 1_000, now: acquiredAt });
    owner.close();

    // No process identity was ever bound, so absence can never be proven.
    const restarted = tool("server-b");
    assert.equal(restarted.inspect("ws", after(5_000)).ownerProcess, "unverifiable");
    assert.throws(() => restarted.recoverWorkspace("ws", "operator", after(5_000)), LeaseRecoveryAmbiguousError);
    assert.equal(storage.workspaceLeaseStatus("ws")?.state, "quarantined");
    assert.equal(storage.workspaceLeaseStatus("ws")?.quarantineReason, "owner process identity is unverifiable");
  });
});

test("fencing tokens are never persisted or emitted in audit events", async () => {
  await withWorkspace(({ storage, tool }) => {
    const owner = tool("server-a");
    const lease = owner.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 30_000 });
    owner.heartbeat(lease, 30_000);
    const leaseDump = JSON.stringify(storage.database.prepare("SELECT * FROM workspace_leases").all());
    const auditDump = JSON.stringify(storage.database.prepare("SELECT * FROM events").all());
    assert.equal(leaseDump.includes(lease.fencingToken), false);
    assert.equal(auditDump.includes(lease.fencingToken), false);
    assert.match(leaseDump, /fencing_token_digest/);
    const [persisted] = JSON.parse(leaseDump) as { fencing_token_digest: string }[];
    assert.equal(persisted?.fencing_token_digest.length, 64);
  });
});

test("generations stay monotonic across cleanup and schema rollback", async () => {
  await withWorkspace(({ storage, directory, tool }) => {
    const owner = tool("server-a");
    const lease = owner.acquireWriter({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 30_000, now: acquiredAt });
    owner.releaseWriter(lease, after(1_000));
    assert.equal(storage.lastAllocatedGeneration("ws"), 1);

    // Retention cleanup may delete the released row; the generation ledger stays.
    storage.database.prepare("DELETE FROM workspace_leases").run();
    assert.equal(storage.lastAllocatedGeneration("ws"), 1);

    // A downgrade and re-upgrade cannot hand a new writer a reused generation.
    storage.rollback(2, join(directory, "rollback-backup.sqlite"));
    storage.migrate();
    assert.equal(storage.lastAllocatedGeneration("ws"), 1);
    assert.equal(storage.acquireWriterLease({ workspaceId: "ws", ownerBatchId: "batch-1", ttlMs: 30_000 }).generation, 2);
  });
});
