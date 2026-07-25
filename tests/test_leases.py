from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from superset_agent_orchestrator.leases import (
    LeaseConflict,
    LeaseLost,
    WorkspaceLeaseStore,
)


class Clock:
    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def test_only_one_concurrent_writer_acquires(tmp_path) -> None:
    database = tmp_path / "state.db"
    WorkspaceLeaseStore(database)

    def acquire(owner: str) -> tuple[str, int] | None:
        store = WorkspaceLeaseStore(database)
        try:
            lease = store.acquire("workspace-1", owner, ttl=30)
            return owner, lease.fencing_token
        except LeaseConflict:
            return None

    with ThreadPoolExecutor(max_workers=12) as executor:
        results = list(executor.map(acquire, (f"owner-{i}" for i in range(12))))

    winners = [result for result in results if result is not None]
    assert len(winners) == 1
    assert winners[0][1] == 1


def test_expired_owner_is_fenced_after_crash_recovery(tmp_path) -> None:
    clock = Clock()
    database = tmp_path / "state.db"
    store = WorkspaceLeaseStore(database, clock=clock)
    stale = store.acquire("workspace-1", "crashed-worker", ttl=10)

    clock.now += 11
    current = store.acquire("workspace-1", "replacement", ttl=10)

    assert current.fencing_token == stale.fencing_token + 1
    with sqlite3.connect(database, isolation_level=None) as connection:
        connection.execute("BEGIN IMMEDIATE")
        with pytest.raises(LeaseLost):
            store.assert_writer(
                connection,
                stale.workspace,
                stale.owner,
                stale.fencing_token,
            )
        connection.rollback()

    with pytest.raises(LeaseLost):
        store.heartbeat(stale.workspace, stale.owner, stale.fencing_token, ttl=10)


def test_stale_release_cannot_delete_replacement_lease(tmp_path) -> None:
    clock = Clock()
    store = WorkspaceLeaseStore(tmp_path / "state.db", clock=clock)
    stale = store.acquire("workspace-1", "first", ttl=10)
    clock.now += 11
    current = store.acquire("workspace-1", "second", ttl=10)

    with pytest.raises(LeaseLost):
        store.release(stale.workspace, stale.owner, stale.fencing_token)

    assert store.current("workspace-1") == current


def test_heartbeat_prevents_takeover_until_new_expiry(tmp_path) -> None:
    clock = Clock()
    store = WorkspaceLeaseStore(tmp_path / "state.db", clock=clock)
    lease = store.acquire("workspace-1", "live-worker", ttl=10)
    clock.now += 8
    renewed = store.heartbeat(
        lease.workspace, lease.owner, lease.fencing_token, ttl=10
    )
    clock.now += 3

    with pytest.raises(LeaseConflict):
        store.acquire("workspace-1", "contender", ttl=10)

    assert renewed.fencing_token == lease.fencing_token
    assert renewed.acquired_at == lease.acquired_at
    assert renewed.heartbeat_at > lease.heartbeat_at
    assert store.current("workspace-1").owner == "live-worker"


def test_release_and_reacquire_uses_new_fencing_token(tmp_path) -> None:
    store = WorkspaceLeaseStore(tmp_path / "state.db")
    first = store.acquire("workspace-1", "first", ttl=10)
    store.release(first.workspace, first.owner, first.fencing_token)
    second = store.acquire("workspace-1", "second", ttl=10)

    assert second.fencing_token == first.fencing_token + 1
    assert [event["event"] for event in store.audit_events("workspace-1")] == [
        "acquired",
        "released",
        "acquired",
    ]
