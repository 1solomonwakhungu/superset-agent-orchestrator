from __future__ import annotations

import argparse
import json
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

USER_AGENT = "agency-availability-monitor/0.1"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def validate_config(config: dict[str, Any]) -> list[dict[str, Any]]:
    services = config.get("services")
    if not isinstance(services, list) or not services:
        raise ValueError("config.services must be a non-empty array")
    names: set[str] = set()
    for service in services:
        required = {"name", "url", "expected_status", "content_regex", "slo"}
        if not isinstance(service, dict) or not required.issubset(service):
            raise ValueError(f"each service must define {sorted(required)}")
        if service["name"] in names:
            raise ValueError(f"duplicate service name: {service['name']}")
        names.add(service["name"])
        parsed = urlparse(service["url"])
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError(f"invalid service URL: {service['url']}")
        re.compile(service["content_regex"])
        slo = service["slo"]
        if not 0 < float(slo["availability_percent"]) <= 100 or int(slo["window_days"]) < 1:
            raise ValueError(f"invalid SLO for {service['name']}")
    return services


def tls_expiry(url: str, timeout: float) -> tuple[str | None, int | None]:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return None, None
    context = ssl.create_default_context()
    with socket.create_connection((parsed.hostname, parsed.port or 443), timeout=timeout) as raw:
        with context.wrap_socket(raw, server_hostname=parsed.hostname) as connection:
            certificate = connection.getpeercert()
    expires = datetime.strptime(certificate["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    return isoformat(expires), int((expires - utc_now()).total_seconds() // 86400)


def probe(service: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now()
    started = time.monotonic()
    status_code: int | None = None
    content_match = False
    certificate_expires_at: str | None = None
    certificate_days_remaining: int | None = None
    errors: list[str] = []
    timeout = float(service.get("timeout_seconds", 15))
    try:
        request = urllib.request.Request(service["url"], headers={"User-Agent": USER_AGENT})
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status_code = response.status
            body = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
        content_match = re.search(service["content_regex"], body) is not None
        if status_code != int(service["expected_status"]):
            errors.append(f"expected HTTP {service['expected_status']}, got {status_code}")
        if not content_match:
            errors.append("content signature did not match")
    except (OSError, urllib.error.URLError, TimeoutError) as error:
        errors.append(f"HTTPS request failed: {type(error).__name__}: {error}")
    try:
        certificate_expires_at, certificate_days_remaining = tls_expiry(service["url"], timeout)
        warning_days = int(service.get("certificate_warning_days", 21))
        if certificate_days_remaining is not None and certificate_days_remaining < warning_days:
            errors.append(f"certificate expires in {certificate_days_remaining} days")
    except (OSError, ssl.SSLError, TimeoutError, KeyError, ValueError) as error:
        errors.append(f"certificate check failed: {type(error).__name__}: {error}")
    latency_ms = round((time.monotonic() - started) * 1000, 1)
    return {
        "name": service["name"],
        "url": service["url"],
        "checked_at": isoformat(started_at),
        "ok": not errors,
        "status_code": status_code,
        "latency_ms": latency_ms,
        "content_signature_match": content_match,
        "certificate_expires_at": certificate_expires_at,
        "certificate_days_remaining": certificate_days_remaining,
        "errors": errors,
    }


def empty_state() -> dict[str, Any]:
    return {"schema_version": 1, "checks": [], "incidents": []}


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return empty_state()
    state = load_json(path)
    state.setdefault("checks", [])
    state.setdefault("incidents", [])
    return state


def update_state(
    state: dict[str, Any], services: list[dict[str, Any]], results: list[dict[str, Any]], now: datetime
) -> None:
    longest_window = max(int(service["slo"]["window_days"]) for service in services)
    keep_after = now - timedelta(days=max(longest_window, 7) * 8)
    state["checks"] = [check for check in state["checks"] if parse_time(check["checked_at"]) >= keep_after]
    state["checks"].extend(
        {"name": result["name"], "checked_at": result["checked_at"], "ok": result["ok"]}
        for result in results
    )
    for result in results:
        open_incident = next(
            (incident for incident in reversed(state["incidents"]) if incident["name"] == result["name"] and incident["status"] == "open"),
            None,
        )
        if not result["ok"] and open_incident is None:
            state["incidents"].append(
                {
                    "id": f"{result['name']}:{result['checked_at']}",
                    "name": result["name"],
                    "status": "open",
                    "started_at": result["checked_at"],
                    "last_failure_at": result["checked_at"],
                    "failure_count": 1,
                    "errors": result["errors"],
                }
            )
        elif not result["ok"]:
            open_incident["last_failure_at"] = result["checked_at"]
            open_incident["failure_count"] += 1
            open_incident["errors"] = result["errors"]
        elif open_incident is not None:
            open_incident["status"] = "resolved"
            open_incident["resolved_at"] = result["checked_at"]


def evaluate_slos(
    services: list[dict[str, Any]], checks: list[dict[str, Any]], now: datetime
) -> dict[str, dict[str, Any]]:
    evaluations: dict[str, dict[str, Any]] = {}
    for service in services:
        slo = service["slo"]
        cutoff = now - timedelta(days=int(slo["window_days"]))
        samples = [
            check for check in checks if check["name"] == service["name"] and parse_time(check["checked_at"]) >= cutoff
        ]
        successful = sum(1 for check in samples if check["ok"])
        availability = round(successful / len(samples) * 100, 3) if samples else None
        target = float(slo["availability_percent"])
        evaluations[service["name"]] = {
            "window_days": int(slo["window_days"]),
            "target_percent": target,
            "sample_count": len(samples),
            "successful_samples": successful,
            "availability_percent": availability,
            "met": availability is not None and availability >= target,
        }
    return evaluations


def run_check(config_path: Path, state_path: Path, output_path: Path) -> int:
    services = validate_config(load_json(config_path))
    state = load_state(state_path)
    now = utc_now()
    results = [probe(service) for service in services]
    update_state(state, services, results, now)
    slos = evaluate_slos(services, state["checks"], now)
    overall_ok = all(result["ok"] and slos[result["name"]]["met"] for result in results)
    status = {
        "schema_version": 1,
        "generated_at": isoformat(now),
        "overall_status": "operational" if overall_ok else "degraded",
        "services": [{**result, "slo": slos[result["name"]]} for result in results],
        "open_incidents": [incident for incident in state["incidents"] if incident["status"] == "open"],
    }
    write_json(state_path, state)
    write_json(output_path, status)
    print(json.dumps(status, indent=2, sort_keys=True))
    return 0 if overall_ok else 1


def run_report(config_path: Path, state_path: Path, output_path: Path) -> int:
    services = validate_config(load_json(config_path))
    state = load_state(state_path)
    now = utc_now()
    week_start = now - timedelta(days=7)
    slos = evaluate_slos(services, state["checks"], now)
    incidents = [incident for incident in state["incidents"] if parse_time(incident["started_at"]) >= week_start]
    lines = [
        "# Agency availability weekly report",
        "",
        f"Generated: {isoformat(now)}  ",
        f"Reporting window: {isoformat(week_start)} to {isoformat(now)}",
        "",
        "## Service SLOs",
        "",
        "| Service | Availability | Target | Samples | Result |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for service in services:
        evaluation = slos[service["name"]]
        availability = "No data" if evaluation["availability_percent"] is None else f"{evaluation['availability_percent']:.3f}%"
        result = "Met" if evaluation["met"] else "Not met"
        lines.append(
            f"| {service['name']} | {availability} | {evaluation['target_percent']:.3f}% | {evaluation['sample_count']} | {result} |"
        )
    lines.extend(["", "## Incidents", ""])
    if incidents:
        lines.extend(["| Service | Started | Status | Failures | Recovered |", "| --- | --- | --- | ---: | --- |"])
        for incident in incidents:
            lines.append(
                f"| {incident['name']} | {incident['started_at']} | {incident['status']} | "
                f"{incident['failure_count']} | {incident.get('resolved_at', '-')} |"
            )
    else:
        lines.append("No incidents were opened during this reporting window.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(output_path.read_text(encoding="utf-8"), end="")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only agency availability monitoring")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "report"):
        child = subparsers.add_parser(command)
        child.add_argument("--config", type=Path, required=True)
        child.add_argument("--state", type=Path, required=True)
        child.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "check":
            return run_check(args.config, args.state, args.output)
        return run_report(args.config, args.state, args.output)
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
