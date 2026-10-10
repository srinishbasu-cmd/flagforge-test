"""Spawn the real host process and talk to it exactly like a browser does."""
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from tests.helpers import dev_env, good_compose, make_lab_zip, registry_json, serve

ROOT = Path(__file__).resolve().parent.parent


class NativeClient:
    def __init__(self, env):
        self.proc = subprocess.Popen([sys.executable, "-m", "silentproxy", "chrome-extension://abc/"], cwd=ROOT,
                                     env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def send_raw(self, body: bytes):
        self.proc.stdin.write(struct.pack("=I", len(body)) + body)
        self.proc.stdin.flush()

    def send(self, obj):
        self.send_raw(json.dumps(obj).encode())

    def recv(self):
        head = self.proc.stdout.read(4)
        if len(head) < 4:
            return None
        return json.loads(self.proc.stdout.read(struct.unpack("=I", head)[0]))

    def call(self, obj, timeout=60):
        """Send a request, return (progress_events, final_result)."""
        self.send(obj)
        events = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self.recv()
            if msg is None:
                break
            if msg.get("id") == obj["id"] and msg["type"] == "result":
                return events, msg
            events.append(msg)
        raise AssertionError("no result")

    def close(self):
        if not self.proc.stdin.closed:
            self.proc.stdin.close()
        self.proc.wait(timeout=10)
        return self.proc.stderr.read().decode()

    def close_pipes(self):
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if pipe and not pipe.closed:
                pipe.close()


class HostE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        srv_dir = root / "srv"
        srv_dir.mkdir()
        z = srv_dir / "demo-lab.zip"
        sha = make_lab_zip(z, good_compose(18090), prefix="demo-lab-main/")
        srv, base = serve(srv_dir)
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        reg = root / "labs.json"
        reg.write_text(json.dumps(registry_json(f"{base}/demo-lab.zip", sha, z.stat().st_size, port=18090)))
        self.env = dev_env(root, reg)
        self.client = NativeClient(self.env)
        self.addCleanup(self._shutdown)

    def _shutdown(self):
        if self.client.proc.poll() is None:
            try:
                self.client.call({"id": "cleanup", "action": "stop_all"}, timeout=20)
            except Exception:
                pass
            self.client.close()
        self.client.close_pipes()

    def test_full_lifecycle_over_native_messaging(self):
        c = self.client
        _, r = c.call({"id": 1, "action": "ping"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["data"]["protocol"], 1)

        _, r = c.call({"id": 2, "action": "doctor"})
        self.assertTrue(r["data"]["daemon_running"] and r["data"]["compose_ok"])

        _, r = c.call({"id": 3, "action": "list"})
        self.assertEqual([l["id"] for l in r["data"]["labs"]], ["demo-lab"])
        self.assertFalse(r["data"]["labs"][0]["running"])

        events, r = c.call({"id": "s1", "action": "start", "lab": "demo-lab"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["data"]["urls"][0]["url"], "http://127.0.0.1:18090/")
        stages = [e["stage"] for e in events]
        for stage in ("download", "verify", "extract", "validate", "starting", "ready"):
            self.assertIn(stage, stages)
        self.assertTrue(all(e["id"] == "s1" and e["type"] == "progress" for e in events))

        _, r = c.call({"id": 5, "action": "status"})
        self.assertEqual([l["lab"] for l in r["data"]["labs"]], ["demo-lab"])
        self.assertEqual(r["data"]["labs"][0]["services"][0]["state"], "running")

        _, r = c.call({"id": 6, "action": "extend", "lab": "demo-lab", "hours": 3})
        self.assertTrue(r["ok"])

        _, r = c.call({"id": 7, "action": "stop", "lab": "demo-lab"})
        self.assertTrue(r["data"]["stopped"])
        _, r = c.call({"id": 8, "action": "status"})
        self.assertEqual(r["data"]["labs"], [])

    def test_lab_is_auto_stopped_when_ttl_expires_even_without_extension_help(self):
        c = self.client
        _, r = c.call({"id": 1, "action": "start", "lab": "demo-lab"})
        self.assertTrue(r["ok"], r)
        state_path = Path(self.env["SILENTPROXY_HOME"]) / "state.json"
        data = json.loads(state_path.read_text())
        self.assertGreater(data["labs"]["demo-lab"]["reaper_pid"], 0)  # a detached reaper was really started
        data["labs"]["demo-lab"]["expires_at"] = time.time() + 2
        state_path.write_text(json.dumps(data))
        marker = Path(self.env["FAKE_DOCKER_STATE"]) / "silentproxy-demo-lab.up"
        self.assertTrue(marker.exists())
        deadline = time.time() + 25
        while marker.exists() and time.time() < deadline:
            time.sleep(0.5)
        self.assertFalse(marker.exists(), "reaper did not stop the lab")
        _, r = c.call({"id": 2, "action": "status"})
        self.assertEqual(r["data"]["labs"], [])

    def test_bad_requests_get_clean_errors(self):
        c = self.client
        for req, code in [
            ({"id": 1, "action": "rm -rf"}, "BAD_REQUEST"),
            ({"id": 2, "action": "start", "lab": "../../etc/passwd"}, "BAD_REQUEST"),
            ({"id": 3, "action": "start", "lab": "ghost-lab"}, "LAB_UNKNOWN"),
            ({"id": 4, "action": "start", "lab": "demo-lab", "replace": "yes"}, "BAD_REQUEST"),
            ({"id": 5, "action": "extend", "lab": "demo-lab", "hours": "9"}, "BAD_REQUEST"),
        ]:
            _, r = c.call(req)
            self.assertFalse(r["ok"], req)
            self.assertEqual(r["error"]["code"], code, req)
        c.send_raw(b'"just a string"')
        r = c.recv()
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        _, r = c.call({"id": 9, "action": "ping"})  # host survived
        self.assertTrue(r["ok"])

    def test_garbage_framing_ends_session_cleanly(self):
        self.client.send_raw(b"{not json")
        r = self.client.recv()
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.client.proc.wait(timeout=10)
        self.assertEqual(self.client.proc.returncode, 0)

    def test_stdout_stays_clean_of_logs(self):
        self.client.call({"id": 1, "action": "ping"})
        self.client.close()
        self.assertEqual(self.client.proc.stdout.read(), b"")  # nothing but framed replies was ever written


if __name__ == "__main__":
    unittest.main()
