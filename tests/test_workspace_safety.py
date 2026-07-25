from __future__ import annotations

import json

from superset_agent_orchestrator.workspace_safety import main


def test_workspace_safety_lifecycle(tmp_path, capsys) -> None:
    database = str(tmp_path / "state.db")

    assert main(["--database", database, "acquire", "ws", "worker", "--ttl", "30"]) == 0
    lease = json.loads(capsys.readouterr().out)
    assert lease["fencing_token"] == 1

    assert main(["--database", database, "status", "ws"]) == 0
    assert json.loads(capsys.readouterr().out)["owner"] == "worker"

    assert main(["--database", database, "release", "ws", "worker", "1"]) == 0
    assert json.loads(capsys.readouterr().out) == {"released": True}

    assert main(["--database", database, "audit", "ws"]) == 0
    assert [event["event"] for event in json.loads(capsys.readouterr().out)] == [
        "acquired",
        "released",
    ]


def test_workspace_safety_reports_conflict(tmp_path, capsys) -> None:
    database = str(tmp_path / "state.db")
    assert main(["--database", database, "acquire", "ws", "first", "--ttl", "30"]) == 0
    capsys.readouterr()

    assert main(["--database", database, "acquire", "ws", "second", "--ttl", "30"]) == 1
    assert "leased by" in json.loads(capsys.readouterr().out)["error"]
