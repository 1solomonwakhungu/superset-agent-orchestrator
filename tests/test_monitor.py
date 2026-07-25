from __future__ import annotations

import json
import re
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agency_monitor.cli import evaluate_slos, update_state

ROOT = Path(__file__).resolve().parents[1]


class FixtureHandler(BaseHTTPRequestHandler):
    body = b"fixture signature"

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, format: str, *args: object) -> None:
        pass


class FixtureServer(ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: object) -> None:
        pass


class MonitorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = FixtureServer(("127.0.0.1", 0), FixtureHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(ROOT / "tests/fixtures/cert.pem", ROOT / "tests/fixtures/key.pem")
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def run_check(self, signature: str, state: Path, output: Path) -> subprocess.CompletedProcess[str]:
        config = state.parent / "services.json"
        config.write_text(
            json.dumps(
                {
                    "services": [
                        {
                            "name": "fixture",
                            "url": f"https://127.0.0.1:{self.server.server_port}/",
                            "expected_status": 200,
                            "content_regex": signature,
                            "timeout_seconds": 2,
                            "certificate_warning_days": -3650,
                            "slo": {"availability_percent": 30, "window_days": 7},
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        env = {**__import__("os").environ, "SSL_CERT_FILE": str(ROOT / "tests/fixtures/cert.pem")}
        return subprocess.run(
            [sys.executable, "-m", "agency_monitor", "check", "--config", str(config), "--state", str(state), "--output", str(output)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_failure_is_deduplicated_and_recovery_is_recorded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            output = Path(directory) / "status.json"
            first = self.run_check("missing", state, output)
            second = self.run_check("missing", state, output)
            recovered = self.run_check("fixture signature", state, output)
            self.assertEqual(first.returncode, 1, first.stderr)
            self.assertEqual(second.returncode, 1, second.stderr)
            self.assertEqual(recovered.returncode, 0, recovered.stderr)
            saved = json.loads(state.read_text(encoding="utf-8"))
            self.assertEqual(len(saved["incidents"]), 1)
            self.assertEqual(saved["incidents"][0]["failure_count"], 2)
            self.assertEqual(saved["incidents"][0]["status"], "resolved")
            self.assertIn("resolved_at", saved["incidents"][0])

    def test_slo_window_excludes_old_checks(self) -> None:
        now = datetime.now(timezone.utc)
        services = [{"name": "site", "slo": {"availability_percent": 99, "window_days": 7}}]
        checks = [
            {"name": "site", "checked_at": (now - timedelta(days=8)).isoformat(), "ok": False},
            {"name": "site", "checked_at": now.isoformat(), "ok": True},
        ]
        evaluation = evaluate_slos(services, checks, now)["site"]
        self.assertEqual(evaluation["sample_count"], 1)
        self.assertEqual(evaluation["availability_percent"], 100)
        self.assertTrue(evaluation["met"])

    def test_update_state_opens_only_one_incident(self) -> None:
        now = datetime.now(timezone.utc)
        state = {"checks": [], "incidents": []}
        services = [{"name": "site", "slo": {"availability_percent": 99, "window_days": 7}}]
        result = {"name": "site", "checked_at": now.isoformat(), "ok": False, "errors": ["failed"]}
        update_state(state, services, [result], now)
        update_state(state, services, [result], now)
        self.assertEqual(len(state["incidents"]), 1)
        self.assertEqual(state["incidents"][0]["failure_count"], 2)


if __name__ == "__main__":
    unittest.main()
