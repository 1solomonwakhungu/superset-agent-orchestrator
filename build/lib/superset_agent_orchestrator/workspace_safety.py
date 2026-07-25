"""Command-line inspection and lifecycle operations for workspace leases."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict

from .leases import LeaseConflict, LeaseLost, WorkspaceLeaseStore


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="workspace-safety")
    parser.add_argument("--database", required=True, help="SQLite state database")
    subparsers = parser.add_subparsers(dest="command", required=True)

    acquire = subparsers.add_parser("acquire")
    acquire.add_argument("workspace")
    acquire.add_argument("owner")
    acquire.add_argument("--ttl", type=float, required=True)

    heartbeat = subparsers.add_parser("heartbeat")
    heartbeat.add_argument("workspace")
    heartbeat.add_argument("owner")
    heartbeat.add_argument("token", type=int)
    heartbeat.add_argument("--ttl", type=float, required=True)

    release = subparsers.add_parser("release")
    release.add_argument("workspace")
    release.add_argument("owner")
    release.add_argument("token", type=int)

    status = subparsers.add_parser("status")
    status.add_argument("workspace")

    audit = subparsers.add_parser("audit")
    audit.add_argument("workspace")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    store = WorkspaceLeaseStore(args.database)
    try:
        if args.command == "acquire":
            result = asdict(store.acquire(args.workspace, args.owner, args.ttl))
        elif args.command == "heartbeat":
            result = asdict(
                store.heartbeat(args.workspace, args.owner, args.token, args.ttl)
            )
        elif args.command == "release":
            store.release(args.workspace, args.owner, args.token)
            result = {"released": True}
        elif args.command == "status":
            lease = store.current(args.workspace)
            result = None if lease is None else asdict(lease)
        else:
            result = store.audit_events(args.workspace)
    except (LeaseConflict, LeaseLost, ValueError) as error:
        print(json.dumps({"error": str(error)}))
        return 1

    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
