import json
import os
import socket
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from silentproxy import paths, state
from silentproxy.errors import LabError
from silentproxy.manager import LabManager
from silentproxy.registry import parse_registry
from tests.helpers import GOOD_COMPOSE, good_compose, make_lab_zip, registry_json, serve


class FakeDocker:
    def __init__(self, compose):
        self.compose, self.up_calls, self.down_calls, self.running, self.fail_up = compose, 0, [], set(), False

    def doctor(self):
        return {"docker_installed": True, "daemon_running": True, "compose_ok": True}

    def require_ready(self):
        pass

    def config(self, project_dir, files):
        with open(files[0]) as fh:
            return json.load(fh)  # lab compose files in tests are already in normalised JSON form

    def up(self, project, project_dir, files, timeout, on_line=None):
        if self.fail_up:
            raise LabError("START_FAILED", "boom")
        self.up_calls += 1
        self.running.add(project)
        if on_line:
            on_line("Container started")

    def down(self, project, timeout=120, volumes=True):
        self.down_calls.append(project)
        self.running.discard(project)

    def ps(self, project):
        return [{"service": "web", "state": "running", "health": None}] if project in self.running else []


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        patcher = mock.patch.dict(os.environ, {"SILENTPROXY_HOME": str(self.root / "home"), "SILENTPROXY_DEV": "1"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.srv_dir = self.root / "srv"
        self.srv_dir.mkdir()
        self.srv, self.base = serve(self.srv_dir)
        self.addCleanup(lambda: (self.srv.shutdown(), self.srv.server_close()))
        self.events = []

    def make(self, compose=GOOD_COMPOSE, ports=(18080,), lab_ids=("demo-lab",), sha_override=None, ttl=6):
        entries = []
        for lab_id in lab_ids:
            z = self.srv_dir / f"{lab_id}.zip"
            sha = make_lab_zip(z, compose if compose is not GOOD_COMPOSE else good_compose(ports[len(entries)]))
            reg = registry_json(f"{self.base}/{lab_id}.zip", sha_override or sha, z.stat().st_size,
                                port=ports[len(entries)], lab_id=lab_id, ttl=ttl)
            entries += reg["labs"]
        labs, _ = parse_registry({"schema": 1, "labs": entries})
        self.docker = FakeDocker(compose)
        self.reapers = []
        return LabManager(self.docker, loader=lambda: (labs, {}), spawn_reaper=lambda lab: self.reapers.append(lab) or 4242)

    def emit(self, stage, message="", percent=None):
        self.events.append(stage)

    def test_start_downloads_verifies_and_runs(self):
        m = self.make()
        res = m.start("demo-lab", emit=self.emit)
        self.assertEqual(res["status"], "running")
        self.assertTrue(res["ready"])
        self.assertEqual(res["urls"][0]["url"], "http://127.0.0.1:18080/")
        self.assertGreater(res["expires_in"], 5 * 3600)
        for stage in ("registry", "download", "verify", "extract", "validate", "starting", "ready"):
            self.assertIn(stage, self.events)
        self.assertEqual(self.reapers, ["demo-lab"])
        self.assertIn("demo-lab", state.snapshot()["labs"])
        self.assertTrue((paths.labs_dir() / "demo-lab" / "1.0.0" / ".silentproxy.override.yml").is_file())

    def test_second_start_is_idempotent_and_cached_download(self):
        m = self.make()
        m.start("demo-lab")
        res = m.start("demo-lab")
        self.assertTrue(res["already_running"])
        self.assertEqual(self.docker.up_calls, 1)
        m.stop("demo-lab")
        self.events.clear()
        m.start("demo-lab", emit=self.emit)
        self.assertIn("cached", self.events)
        self.assertNotIn("download", self.events)

    def test_checksum_mismatch_never_runs_anything(self):
        m = self.make(sha_override="0" * 64)
        with self.assertRaises(LabError) as cm:
            m.start("demo-lab")
        self.assertEqual(cm.exception.code, "CHECKSUM_MISMATCH")
        self.assertEqual(self.docker.up_calls, 0)
        self.assertEqual(state.snapshot()["labs"], {})

    def test_unsafe_compose_blocked_before_up(self):
        bad = {"services": {"web": {"image": "x", "privileged": True,
                                     "ports": [{"host_ip": "127.0.0.1", "published": "18080", "target": 80}]}}}
        m = self.make(compose=bad)
        with self.assertRaises(LabError) as cm:
            m.start("demo-lab")
        self.assertEqual(cm.exception.code, "UNSAFE_LAB")
        self.assertTrue(cm.exception.extra["problems"])
        self.assertEqual(self.docker.up_calls, 0)

    def test_unknown_or_malformed_lab_ids(self):
        m = self.make()
        for lab in ("nope-lab", "../../etc", "", None, 5, "UPPER"):
            with self.assertRaises(LabError):
                m.start(lab)
        self.assertEqual(self.docker.up_calls, 0)

    def test_failed_up_cleans_state(self):
        m = self.make()
        self.docker.fail_up = True
        with self.assertRaises(LabError):
            m.start("demo-lab")
        self.assertEqual(state.snapshot()["labs"], {})
        self.assertEqual(self.docker.down_calls, ["silentproxy-demo-lab"])

    def test_port_in_use_detected(self):
        m = self.make()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 18080))
            s.listen(1)
            with self.assertRaises(LabError) as cm:
                m.start("demo-lab")
        self.assertEqual(cm.exception.code, "PORT_IN_USE")
        self.assertEqual(self.docker.up_calls, 0)

    def test_one_lab_at_a_time_with_replace(self):
        m = self.make(ports=(18080, 18081), lab_ids=("lab-one", "lab-two"))
        m.start("lab-one")
        with self.assertRaises(LabError) as cm:
            m.start("lab-two")
        self.assertEqual(cm.exception.code, "OTHER_LAB_RUNNING")
        self.assertEqual(cm.exception.extra["running"], ["lab-one"])
        m.start("lab-two", replace=True)
        self.assertEqual(list(state.snapshot()["labs"]), ["lab-two"])
        self.assertIn("silentproxy-lab-one", self.docker.down_calls)

    def test_stop_extend_and_expiry(self):
        m = self.make(ttl=1)
        m.start("demo-lab")
        res = m.extend("demo-lab", 2)
        self.assertGreater(res["expires_in"], 3 * 3600 - 60)   # 1h left + 2h added
        self.assertLessEqual(res["expires_in"], 3 * 3600)
        res = m.extend("demo-lab", 12)                          # capped at 12h from now, not 15h
        self.assertLessEqual(res["expires_in"], 12 * 3600)
        self.assertGreater(res["expires_in"], 12 * 3600 - 60)
        with self.assertRaises(LabError):
            m.extend("demo-lab", 99)
        with self.assertRaises(LabError):
            m.extend("demo-lab", True)
        with self.assertRaises(LabError):
            m.extend("other-lab", 1)

        def expire(d):
            d["labs"]["demo-lab"]["expires_at"] = time.time() - 1
        state.update(expire)
        self.assertEqual(m.reap_expired(), ["demo-lab"])
        self.assertEqual(state.snapshot()["labs"], {})
        self.assertEqual(self.docker.running, set())

    def test_status_drops_labs_whose_containers_vanished(self):
        m = self.make()
        m.start("demo-lab")
        self.assertEqual(len(m.status()["labs"]), 1)
        self.docker.running.clear()  # e.g. user ran docker compose down or rebooted
        self.assertEqual(m.status()["labs"], [])
        self.assertEqual(state.snapshot()["labs"], {})

    def test_busy_lab_rejects_concurrent_operation(self):
        m = self.make()
        with m._exclusive("demo-lab"):
            with self.assertRaises(LabError) as cm:
                m.stop("demo-lab")
        self.assertEqual(cm.exception.code, "LAB_BUSY")

    def test_readiness_reports_pending_ports(self):
        m = self.make()
        lab = next(iter(m.loader()[0].values()))
        lab = type(lab)(**{**lab.__dict__, "ports": tuple(type(p)(p.name, p.host, p.scheme, p.path, True) for p in lab.ports)})
        self.assertEqual(LabManager._wait_ready(lab, timeout=1.2), [18080])
        with socket.socket() as s:
            s.bind(("127.0.0.1", 18080))
            s.listen(1)
            self.assertEqual(LabManager._wait_ready(lab, timeout=3), [])


if __name__ == "__main__":
    unittest.main()
