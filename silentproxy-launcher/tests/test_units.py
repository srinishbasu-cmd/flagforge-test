import io
import json
import os
import stat
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from silentproxy import archive, install, net, policy, protocol, registry
from silentproxy.errors import LabError
from tests.helpers import GOOD_COMPOSE, dev_env, make_lab_zip, registry_json, serve


class ProtocolTests(unittest.TestCase):
    def test_roundtrip_and_eof(self):
        buf = io.BytesIO(protocol.encode_message({"a": 1}) + protocol.encode_message({"b": "é"}))
        self.assertEqual(protocol.read_message(buf), {"a": 1})
        self.assertEqual(protocol.read_message(buf), {"b": "é"})
        self.assertIsNone(protocol.read_message(buf))

    def test_rejects_oversize_truncated_and_bad_json(self):
        with self.assertRaises(protocol.ProtocolError):
            protocol.read_message(io.BytesIO(struct.pack("=I", 10 ** 8)))
        with self.assertRaises(protocol.ProtocolError):
            protocol.read_message(io.BytesIO(struct.pack("=I", 50) + b"{}"))
        with self.assertRaises(protocol.ProtocolError):
            protocol.read_message(io.BytesIO(struct.pack("=I", 3) + b"{no"))


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def _zip(self, entries):
        p = self.root / "a.zip"
        with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as zf:
            for item in entries:
                zf.writestr(*item) if isinstance(item, tuple) else zf.writestr(item, "x")
        return str(p)

    def test_extracts_and_strips_single_toplevel(self):
        z = self._zip([("repo-abc/docker-compose.yml", "x"), ("repo-abc/site/i.html", "y")])
        n = archive.safe_extract(z, str(self.root / "out"))
        self.assertEqual(n, 2)
        self.assertTrue((self.root / "out" / "docker-compose.yml").is_file())

    def test_flat_archive_kept_flat(self):
        z = self._zip([("docker-compose.yml", "x"), ("other/f.txt", "y")])
        archive.safe_extract(z, str(self.root / "out"))
        self.assertTrue((self.root / "out" / "other" / "f.txt").is_file())

    def test_path_traversal_and_absolute_rejected(self):
        for name in ("../evil.txt", "a/../../evil.txt", "/etc/evil", "C:/evil.txt", "a\\..\\..\\evil"):
            with self.assertRaises(LabError, msg=name) as cm:
                archive.safe_extract(self._zip([(name, "x")]), str(self.root / "o"))
            self.assertEqual(cm.exception.code, "ARCHIVE_UNSAFE")
            self.assertFalse((self.root / "o").exists())

    def test_symlink_rejected(self):
        p = self.root / "s.zip"
        with zipfile.ZipFile(p, "w") as zf:
            info = zipfile.ZipInfo("link")
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, "/etc/passwd")
            zf.writestr("ok.txt", "x")
        with self.assertRaises(LabError):
            archive.safe_extract(str(p), str(self.root / "o"))

    def test_zip_bomb_and_limits(self):
        p = self.root / "b.zip"
        with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("big.bin", b"\0" * (4 * 1024 * 1024))
        with self.assertRaises(LabError):
            archive.safe_extract(str(p), str(self.root / "o"))
        z = self._zip([("a.txt", "12345"), ("b.txt", "12345")])
        with mock.patch.object(archive, "MAX_EXTRACT_FILES", 1), self.assertRaises(LabError):
            archive.safe_extract(z, str(self.root / "o2"))
        junk = self.root / "junk.zip"
        junk.write_text("definitely not a zip")
        with self.assertRaises(LabError):
            archive.safe_extract(str(junk), str(self.root / "o3"))


def cfg(**svc):
    base = {"image": "x", "ports": [{"host_ip": "127.0.0.1", "published": "8081", "target": 80}]}
    base.update(svc)
    return {"services": {"app": base}}


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def check(self, config, ports=frozenset({8081})):
        return policy.validate_compose(config, self.dir, set(ports))

    def test_good_lab_passes(self):
        self.assertEqual(self.check(cfg(volumes=[{"type": "bind", "source": self.dir + "/site", "target": "/x"}],
                                        build={"context": self.dir})), [])

    def test_each_violation_is_caught(self):
        cases = {
            "privileged": cfg(privileged=True),
            "host net": cfg(network_mode="host"),
            "host pid": cfg(pid="host"),
            "cap": cfg(cap_add=["SYS_ADMIN"]),
            "devices": cfg(devices=["/dev/sda:/dev/sda"]),
            "unconfined": cfg(security_opt=["seccomp=unconfined"]),
            "sysctl": cfg(sysctls={"kernel.shmmax": 1}),
            "all interfaces": cfg(ports=[{"published": "8081", "target": 80}]),
            "0.0.0.0": cfg(ports=[{"host_ip": "0.0.0.0", "published": "8081", "target": 80}]),
            "random port": cfg(ports=[{"host_ip": "127.0.0.1", "target": 80}]),
            "range": cfg(ports=[{"host_ip": "127.0.0.1", "published": "8081-8085", "target": 80}]),
            "undeclared": cfg(ports=[{"host_ip": "127.0.0.1", "published": "9999", "target": 80}]),
            "bind outside": cfg(volumes=[{"type": "bind", "source": "/etc", "target": "/e"}]),
            "docker sock": cfg(volumes=[{"type": "bind", "source": "/var/run/docker.sock", "target": "/s"}]),
            "traversal": cfg(volumes=[{"type": "bind", "source": self.dir + "/../..", "target": "/e"}]),
            "build outside": cfg(build={"context": "/"}),
            "remote build": cfg(build={"context": "https://github.com/x/y.git"}),
            "extra ctx": cfg(build={"context": self.dir, "additional_contexts": {"a": "/"}}),
        }
        for name, config in cases.items():
            self.assertTrue(self.check(config), f"{name} should be rejected")

    def test_top_level_violations(self):
        for key, spec in {"networks": {"n": {"external": True}}, "volumes": {"v": {"external": True}},
                          "volumes ": {"v": {"driver_opts": {"device": "/", "o": "bind"}}},
                          "networks ": {"n": {"driver": "host"}},
                          "secrets": {"s": {"file": "/etc/shadow"}}}.items():
            config = cfg()
            config[key.strip()] = spec
            self.assertTrue(self.check(config), key)
        self.assertTrue(self.check({"services": {}}))

    def test_override_adds_limits_without_clobbering(self):
        config = {"services": {"a": {"image": "x"}, "b": {"image": "y", "mem_limit": "64m"}}}
        ov = policy.build_override(config, "demo-lab")["services"]
        self.assertIn("mem_limit", ov["a"])
        self.assertNotIn("mem_limit", ov["b"])
        self.assertEqual(ov["a"]["labels"]["com.operationsilentproxy.lab"], "demo-lab")


class NetAndRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_host_allowlist_is_not_fooled_by_lookalikes(self):
        self.assertTrue(net.host_allowed("objects.githubusercontent.com"))
        self.assertTrue(net.host_allowed("github.com"))
        for bad in ("evilgithub.com", "github.com.evil.io", "githubusercontent.com.evil.io", "", "localhost"):
            self.assertFalse(net.host_allowed(bad), bad)

    def test_url_allowlist(self):
        self.assertTrue(net.url_allowed("https://github.com/Cybersecurity-CTF-Org/r/releases/download/t/a.zip"))
        self.assertFalse(net.url_allowed("https://github.com/someone-else/r/a.zip"))
        self.assertFalse(net.url_allowed("http://github.com/Cybersecurity-CTF-Org/r/a.zip"))

    def test_registry_parsing_skips_bad_entries(self):
        good = {"id": "mission-1", "version": "1.0.0", "sha256": "a" * 64, "size": 10,
                "url": "https://github.com/Cybersecurity-CTF-Org/r/releases/download/t/m.zip",
                "ports": [{"name": "p", "host": 8081}]}
        bad_id = dict(good, id="../etc")
        bad_url = dict(good, id="mission-2", url="https://evil.example/m.zip")
        bad_sha = dict(good, id="mission-3", sha256="zz")
        bad_port = dict(good, id="mission-4", ports=[{"host": 80}])
        labs, warnings = registry.parse_registry({"schema": 1, "labs": [good, bad_id, bad_url, bad_sha, bad_port, good]})
        self.assertEqual(list(labs), ["mission-1"])
        self.assertEqual(len(warnings), 5)
        with self.assertRaises(LabError):
            registry.parse_registry({"schema": 2, "labs": []})

    def test_registry_cache_fallback(self):
        reg = self.root / "labs.json"
        reg.write_text(json.dumps(registry_json("https://x.test/a.zip", "b" * 64, 5)))
        env = dev_env(self.root, reg)
        with mock.patch.dict(os.environ, env):
            labs, meta = registry.load_registry()
            self.assertEqual(meta["source"], "network")
            self.assertIn("demo-lab", labs)
            reg.unlink()
            labs, meta = registry.load_registry()
            self.assertTrue(meta["stale"])
            self.assertIn("demo-lab", labs)

    def test_download_checks_hash_and_size(self):
        z = self.root / "srv" / "lab.zip"
        z.parent.mkdir()
        sha = make_lab_zip(z)
        srv, base = serve(z.parent)
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        with mock.patch.dict(os.environ, {"SILENTPROXY_DEV": "1"}):
            dest = str(self.root / "got.zip")
            self.assertEqual(net.download_file(base + "/lab.zip", dest, 10 ** 6, sha), sha)
            with self.assertRaises(LabError) as cm:
                net.download_file(base + "/lab.zip", dest, 10 ** 6, "0" * 64)
            self.assertEqual(cm.exception.code, "CHECKSUM_MISMATCH")
            with self.assertRaises(LabError) as cm:
                net.download_file(base + "/lab.zip", dest, 50, sha)
            self.assertEqual(cm.exception.code, "DOWNLOAD_TOO_LARGE")
        with self.assertRaises(LabError):  # not in dev mode: local server is not allowlisted
            net.download_file(base + "/lab.zip", dest, 10 ** 6, sha)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_linux_firefox_and_chrome_manifests(self):
        cid = "a" * 32
        out = install.install(["firefox", "chrome"], [cid], home=self.home, platform="linux", launcher="/opt/host")
        self.assertEqual(len(out), 2)
        ff = json.loads((self.home / ".mozilla/native-messaging-hosts/com.operationsilentproxy.launcher.json").read_text())
        self.assertEqual(ff["allowed_extensions"], [install.FIREFOX_EXTENSION_ID])
        self.assertNotIn("allowed_origins", ff)
        ch = json.loads((self.home / ".config/google-chrome/NativeMessagingHosts/com.operationsilentproxy.launcher.json").read_text())
        self.assertEqual(ch["allowed_origins"], [f"chrome-extension://{cid}/"])
        self.assertEqual(ch["path"], "/opt/host")
        self.assertEqual(ch["type"], "stdio")

    def test_macos_paths(self):
        d = install.manifest_dirs(self.home, "darwin")
        self.assertTrue(str(d["firefox"]).endswith("Library/Application Support/Mozilla/NativeMessagingHosts"))

    def test_validation_and_uninstall(self):
        with self.assertRaises(ValueError):
            install.install(["chrome"], [], home=self.home, platform="linux", launcher="/x")
        with self.assertRaises(ValueError):
            install.install(["chrome"], ["*"], home=self.home, platform="linux", launcher="/x")
        install.install(["firefox"], [], home=self.home, platform="linux", launcher="/x")
        self.assertEqual(len(install.uninstall(home=self.home, platform="linux")), 1)
        self.assertEqual(install.uninstall(home=self.home, platform="linux"), [])

    def test_wrapper_script_is_executable(self):
        with mock.patch.dict(os.environ, {"SILENTPROXY_HOME": str(self.home / "data")}):
            path = install.create_launcher("linux")
        self.assertTrue(os.access(path, os.X_OK))
        self.assertIn("-m silentproxy host", Path(path).read_text())


if __name__ == "__main__":
    unittest.main()
