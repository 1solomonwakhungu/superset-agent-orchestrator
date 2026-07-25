"""SQLite-backed workspace leases with fencing and durable auditing."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


class LeaseConflict(RuntimeError):
    """Raised when another live owner holds the workspace lease."""


class LeaseLost(RuntimeError):
    """Raised when an owner or fencing token is no longer current."""


@dataclass(frozen=True, slots=True)
class Lease:
    workspace: str
    owner: str
    fencing_token: int
    acquired_at: float
    heartbeat_at: float
    expires_at: float


class WorkspaceLeaseStore:
    """Coordinates workspace writers through short SQLite transactions.

    The fencing token increases on every successful acquisition. Callers must
    authorize each protected write with ``assert_writer`` in the same database
    transaction as that write, preventing an expired owner from writing after a
    replacement has acquired the workspace.
    """

    def __init__(
        self,
        database: str | Path,
        *,
        clock: Callable[[], float] = time.time,
        busy_timeout: float = 5.0,
    ) -> None:
        self.database = str(database)
        self.clock = clock
        self.busy_timeout = busy_timeout
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.database,
            timeout=self.busy_timeout,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(f"PRAGMA busy_timeout = {int(self.busy_timeout * 1000)}")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = FULL;

                CREATE TABLE IF NOT EXISTS workspace_leases (
                    workspace TEXT PRIMARY KEY,
                    owner TEXT NOT NULL,
                    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
                    acquired_at REAL NOT NULL,
                    heartbeat_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS workspace_fencing (
                    workspace TEXT PRIMARY KEY,
                    last_token INTEGER NOT NULL CHECK (last_token > 0)
                );

                CREATE TABLE IF NOT EXISTS workspace_audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workspace TEXT NOT NULL,
                    event TEXT NOT NULL,
                    owner TEXT,
                    fencing_token INTEGER,
                    occurred_at REAL NOT NULL,
                    details TEXT NOT NULL DEFAULT '{}'
                );
                """
            )

    @staticmethod
    def _validate_identity(workspace: str, owner: str) -> None:
        if not workspace.strip():
            raise ValueError("workspace must not be empty")
        if not owner.strip():
            raise ValueError("owner must not be empty")

    @staticmethod
    def _lease(row: sqlite3.Row) -> Lease:
        return Lease(
            workspace=row["workspace"],
            owner=row["owner"],
            fencing_token=row["fencing_token"],
            acquired_at=row["acquired_at"],
            heartbeat_at=row["heartbeat_at"],
            expires_at=row["expires_at"],
        )

    @staticmethod
    def _audit(
        connection: sqlite3.Connection,
        *,
        workspace: str,
        event: str,
        owner: str | None,
        fencing_token: int | None,
        occurred_at: float,
        details: dict[str, Any] | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO workspace_audit_events
                (workspace, event, owner, fencing_token, occurred_at, details)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                workspace,
                event,
                owner,
                fencing_token,
                occurred_at,
                json.dumps(details or {}, sort_keys=True),
            ),
        )

    def acquire(self, workspace: str, owner: str, ttl: float) -> Lease:
        self._validate_identity(workspace, owner)
        if ttl <= 0:
            raise ValueError("ttl must be positive")

        now = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT * FROM workspace_leases WHERE workspace = ?", (workspace,)
            ).fetchone()
            if current is not None and current["expires_at"] > now:
                self._audit(
                    connection,
                    workspace=workspace,
                    event="acquire_rejected",
                    owner=owner,
                    fencing_token=current["fencing_token"],
                    occurred_at=now,
                    details={"held_by": current["owner"]},
                )
                connection.commit()
                raise LeaseConflict(
                    f"workspace {workspace!r} is leased by {current['owner']!r}"
                )

            token_row = connection.execute(
                """
                INSERT INTO workspace_fencing (workspace, last_token)
                VALUES (?, 1)
                ON CONFLICT(workspace) DO UPDATE SET last_token = last_token + 1
                RETURNING last_token
                """,
                (workspace,),
            ).fetchone()
            token = int(token_row["last_token"])
            expires_at = now + ttl
            connection.execute(
                """
                INSERT INTO workspace_leases
                    (workspace, owner, fencing_token, acquired_at, heartbeat_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(workspace) DO UPDATE SET
                    owner = excluded.owner,
                    fencing_token = excluded.fencing_token,
                    acquired_at = excluded.acquired_at,
                    heartbeat_at = excluded.heartbeat_at,
                    expires_at = excluded.expires_at
                """,
                (workspace, owner, token, now, now, expires_at),
            )
            self._audit(
                connection,
                workspace=workspace,
                event="acquired" if current is None else "recovered",
                owner=owner,
                fencing_token=token,
                occurred_at=now,
                details=(
                    {}
                    if current is None
                    else {
                        "previous_owner": current["owner"],
                        "previous_token": current["fencing_token"],
                    }
                ),
            )
            connection.commit()
            return Lease(workspace, owner, token, now, now, expires_at)

    def heartbeat(self, workspace: str, owner: str, token: int, ttl: float) -> Lease:
        if ttl <= 0:
            raise ValueError("ttl must be positive")
        now = self.clock()
        expires_at = now + ttl
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                UPDATE workspace_leases
                SET heartbeat_at = ?, expires_at = ?
                WHERE workspace = ? AND owner = ? AND fencing_token = ?
                    AND expires_at > ?
                RETURNING *
                """,
                (now, expires_at, workspace, owner, token, now),
            ).fetchone()
            if row is None:
                connection.rollback()
                raise LeaseLost("cannot heartbeat a stale or expired lease")
            self._audit(
                connection,
                workspace=workspace,
                event="heartbeat",
                owner=owner,
                fencing_token=token,
                occurred_at=now,
            )
            connection.commit()
            return self._lease(row)

    def release(self, workspace: str, owner: str, token: int) -> None:
        now = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                """
                DELETE FROM workspace_leases
                WHERE workspace = ? AND owner = ? AND fencing_token = ?
                """,
                (workspace, owner, token),
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise LeaseLost("cannot release a lease owned by another writer")
            self._audit(
                connection,
                workspace=workspace,
                event="released",
                owner=owner,
                fencing_token=token,
                occurred_at=now,
            )
            connection.commit()

    def assert_writer(
        self,
        connection: sqlite3.Connection,
        workspace: str,
        owner: str,
        token: int,
        *,
        now: float | None = None,
    ) -> None:
        """Fence a protected write inside the caller's active transaction."""
        checked_at = self.clock() if now is None else now
        row = connection.execute(
            """
            SELECT 1 FROM workspace_leases
            WHERE workspace = ? AND owner = ? AND fencing_token = ?
                AND expires_at > ?
            """,
            (workspace, owner, token, checked_at),
        ).fetchone()
        if row is None:
            raise LeaseLost("writer does not hold the current live lease")

    def current(self, workspace: str) -> Lease | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM workspace_leases WHERE workspace = ?", (workspace,)
            ).fetchone()
            return None if row is None else self._lease(row)

    def audit_events(self, workspace: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, workspace, event, owner, fencing_token, occurred_at, details
                FROM workspace_audit_events
                WHERE workspace = ? ORDER BY id
                """,
                (workspace,),
            ).fetchall()
        return [
            {
                **dict(row),
                "details": json.loads(row["details"]),
            }
            for row in rows
        ]
