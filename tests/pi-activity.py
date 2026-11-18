#!/usr/bin/env python3
"""Synthetic Pi collector and machine-event caller tests."""

import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/pi_activity.py"
SPEC = importlib.util.spec_from_file_location("pi_activity", SCRIPT)
PI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PI)

T0 = "2026-02-01T15:59:59.999Z"
T1 = "2026-02-01T16:00:00.001Z"
SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
FORK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TIME = dt.datetime.fromisoformat
START = TIME("2026-01-31T16:00:00+00:00")
END = TIME("2026-02-02T03:00:00+00:00")


def message(entry="12345678", at=T0, **changes):
    usage = {"input": 10, "cacheRead": 90, "cacheWrite": 4, "output": 6, "reasoning": 1, "totalTokens": 110}
    usage.update(changes)
    return {"id": entry, "type": "message", "timestamp": at, "message": {
        "role": "assistant", "provider": "fixture", "model": "fixture-model", "usage": usage,
        "content": [{"type": "text", "text": "PRIVATE_SYNTHETIC_MESSAGE"}]}}


def write(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    return path


class PiActivity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.personal = self.home / "personal"
        self.work = self.home / "work"
        self.personal.mkdir()
        self.work.mkdir()
        self.repos = [{"path": str(self.personal), "category": "personal"}, {"path": str(self.work), "category": "work"}]

    def session(self, category, sid, cwd, rows, parent=None, name="2026-02-01T15-00-00-000Z"):
        roots = {"team": ".local/share/mausbot-team/pi-agent/sessions", "cli": ".pi/agent/sessions"}
        header = {"type": "session", "version": 3, "id": sid, "cwd": str(cwd), "timestamp": T0}
        if parent:
            header["parentSession"] = str(parent)
            header["timestamp"] = "2026-02-01T16:00:00.000Z"
        return write(self.home / roots[category] / "project" / f"{name}_{sid}.jsonl", [header, *rows])

    def test_registered_source_and_fork_copy_have_one_event_per_real_call(self):
        root = self.session("team", SESSION, self.personal, [message(), message("23456789", T1)])
        self.session("cli", SESSION, self.personal, [message(), message("23456789", T1)])
        self.session("team", FORK, self.work, [message(), message("34567890", T1)], root)
        result = PI.collect_pi(self.home, self.repos, START, END)
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["tokens"]), 3)
        self.assertEqual(sum(r["category"] == "personal" for r in result["tokens"]), 2)
        self.assertEqual(sum(r["category"] == "work" for r in result["tokens"]), 1)
        self.assertNotIn("PRIVATE_SYNTHETIC_MESSAGE", json.dumps(result))
        days = {TIME(r["at"].replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()
                for r in result["tokens"]}
        self.assertEqual(days, {"2026-02-01", "2026-02-02"})
        for event in result["tokens"]:
            self.assertEqual(event["input"] + event["output"], 20)
            self.assertEqual(event["input"] + event["output"] + event["cacheRead"], 110)
            self.assertEqual((event["cacheWrite"], event["reasoning"]), (4, 1))

    def test_booked_host_turns_use_driver_identity_and_are_independent(self):
        self.session("team", SESSION, self.personal, [message()])
        base = {"driverKind": "piAgent", "at": T1, "input": 104, "cachedInput": 90, "output": 6,
                "model": "fixture-model", "botId": "fixture-bot", "threadId": "fixture-thread", "turnId": "fixture-turn"}
        retry = {**base, "at": "2026-02-01T16:00:01.000Z"}
        write(self.home / ".openmausbot/usage/2026-02.jsonl", [base, retry, {**base, "driverKind": "codex"},
              {**base, "turnId": "known-partial", "cachedInput": None, "usageStatus": "partial"}])
        result = PI.collect_pi(self.home, self.repos, START, END)
        self.assertEqual(len(result["tokens"]), 3)
        host = [r for r in result["tokens"] if r["category"] == "unclassified"]
        self.assertEqual(len(host), 2)
        self.assertEqual(host[0]["input"], 14)
        self.assertEqual(host[0]["cacheRead"], 90)
        self.assertEqual(host[0]["cacheWrite"], None)
        self.assertIsNone(host[1]["input"])
        self.assertIsNone(host[1]["cacheRead"])
        self.assertEqual(host[1]["output"], 6)
        self.assertIn({"source": "pi-host", "code": "IncompleteUsage"}, result["errors"])

    def test_host_registry_kind_is_not_the_instance_or_model_label(self):
        base = {"driverKind": "piAgent", "instanceId": "fixture-pi-instance", "at": T1,
                "input": 5310, "cachedInput": 4700, "output": 161, "usageStatus": "complete",
                "model": "fixture-model", "botId": "fixture-bot", "threadId": "fixture-thread", "turnId": "fixture-turn"}
        write(self.home / ".openmausbot/usage/2026-02.jsonl", [
            base,
            {**base, "driverKind": "codex", "instanceId": "piAgent", "model": "piAgent", "turnId": "fixture-codex"},
            {**base, "driverKind": "pi", "model": "fixture-unsupported", "turnId": "fixture-unsupported-kind"},
        ])
        result = PI.collect_pi(self.home, self.repos, START, END)
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["tokens"]), 1)
        event = result["tokens"][0]
        self.assertEqual(event["model"], "fixture-model")
        self.assertEqual((event["input"] + event["output"], event["cacheRead"]), (771, 4700))

    def test_incomplete_files_and_conflicting_replay_report_coverage(self):
        p = self.session("team", SESSION, self.personal, [message()])
        p.write_text(p.read_text() + '{"type":"message"')
        self.session("cli", SESSION, self.personal, [message(input=11, totalTokens=111)])
        result = PI.collect_pi(self.home, self.repos, START, END)
        self.assertEqual(result["tokens"], [])
        self.assertIn("IncompleteOrOversizeRecord", {r["code"] for r in result["errors"]})
        self.assertIn("ConflictingUsage", {r["code"] for r in result["errors"]})

    def test_public_caller_augments_the_existing_machine_sample(self):
        self.session("team", SESSION, self.personal, [message()])
        sample = {"status": "ok", "tokens": [{"provider": "codex", "key": "fixture-existing"}], "errors": [], "logFiles": 2}
        source = self.home / "sample.json"
        source.write_text(json.dumps(sample))
        repos = self.home / "repos.json"
        repos.write_text(json.dumps(self.repos))
        target = self.home / "candidate.json"
        subprocess.run([sys.executable, "-B", str(SCRIPT), "--home", str(self.home),
                        "--start", START.isoformat(), "--end", END.isoformat(), "--repositories", str(repos),
                        "--sample", str(source), "--output", str(target)], check=True)
        result = json.loads(target.read_text())
        self.assertEqual([row["provider"] for row in result["tokens"]], ["codex", "pi"])
        self.assertEqual(result["logFiles"], 3)
        self.assertEqual(result["piCoverage"]["pi-team"]["rows"], 1)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(source.read_text()), sample)


if __name__ == "__main__":
    unittest.main()
