"""Windows behaviour, exercised on any OS with a fake winreg module (the real registry is not touched)."""
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from silentproxy import cli, install
from silentproxy.config import FIREFOX_EXTENSION_ID, HOST_NAME


class FakeWinreg(types.ModuleType):
    HKEY_CURRENT_USER = "HKCU"
    REG_SZ = 1

    def __init__(self):
        super().__init__("winreg")
        self.values, self.keys, self.deleted = {}, set(), []

    def CreateKey(self, root, path):
        assert root == self.HKEY_CURRENT_USER
        self.keys.add(path)
        outer = self

        class _Key:
            def __enter__(self_inner):
                self_inner.path = path
                return self_inner

            def __exit__(self_inner, *a):
                return False
        return _Key()

    def SetValueEx(self, key, name, reserved, typ, data):
        self.values[(key.path, name)] = (typ, data)

    def DeleteKey(self, root, path):
        if path not in self.keys:
            raise FileNotFoundError(path)
        self.keys.discard(path)
        self.deleted.append(path)


class WindowsInstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reg = FakeWinreg()
        for p in (mock.patch.dict(sys.modules, {"winreg": self.reg}),
                  mock.patch.dict(os.environ, {"SILENTPROXY_HOME": str(self.root / "data")})):
            p.start()
            self.addCleanup(p.stop)

    def test_firefox_registry_key_manifest_location_and_content(self):
        exe = r"C:\Users\Player\AppData\Local\SilentProxy\bin\silentproxy.exe"
        out = install.install(["firefox"], [], platform="win32", launcher=exe)
        key = r"Software\Mozilla\NativeMessagingHosts\com.operationsilentproxy.launcher"
        self.assertEqual(HOST_NAME, "com.operationsilentproxy.launcher")
        manifest_path = self.root / "data" / "native-messaging" / "firefox" / f"{HOST_NAME}.json"
        self.assertTrue(manifest_path.is_file())
        self.assertEqual(self.reg.values[(key, "")], (1, str(manifest_path)))      # default (unnamed) value
        m = json.loads(manifest_path.read_text())
        self.assertEqual(m["path"], exe)                                           # the .exe itself, no .bat
        self.assertEqual(m["type"], "stdio")
        self.assertEqual(m["name"], HOST_NAME)
        self.assertEqual(m["allowed_extensions"], [FIREFOX_EXTENSION_ID])
        self.assertNotIn("allowed_origins", m)
        self.assertEqual(len(out), 1)
        self.assertEqual(self.reg.keys, {key})                                     # nothing registered for other browsers

    def test_chrome_needs_an_id_and_uses_allowed_origins(self):
        with self.assertRaises(ValueError):
            install.install(["chrome"], [], platform="win32", launcher="C:\\x.exe")
        cid = "a" * 32
        install.install(["chrome"], [cid], platform="win32", launcher="C:\\x.exe")
        m = json.loads((self.root / "data" / "native-messaging" / "chrome" / f"{HOST_NAME}.json").read_text())
        self.assertEqual(m["allowed_origins"], [f"chrome-extension://{cid}/"])
        self.assertNotIn("allowed_extensions", m)
        self.assertIn(r"Software\Google\Chrome\NativeMessagingHosts\com.operationsilentproxy.launcher", self.reg.keys)

    def test_frozen_exe_copies_itself_to_a_permanent_folder(self):
        fake_exe = self.root / "Downloads" / "silentproxy-windows.exe"
        fake_exe.parent.mkdir()
        fake_exe.write_bytes(b"MZ-fake-exe")
        with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "executable", str(fake_exe)):
            path = Path(install.create_launcher("win32"))
            self.assertEqual(path, self.root / "data" / "bin" / "silentproxy.exe")
            self.assertEqual(path.read_bytes(), b"MZ-fake-exe")
            fake_exe.write_bytes(b"MZ-newer")                                       # running install again refreshes it
            install.create_launcher("win32")
            self.assertEqual(path.read_bytes(), b"MZ-newer")
            with mock.patch("shutil.copy2", side_effect=PermissionError("in use")), self.assertRaises(ValueError) as cm:
                install.create_launcher("win32")
            self.assertIn("Close Firefox", str(cm.exception))

    def test_running_from_the_installed_copy_does_not_copy_onto_itself(self):
        installed = self.root / "data" / "bin" / "silentproxy.exe"
        installed.parent.mkdir(parents=True)
        installed.write_bytes(b"x")
        with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "executable", str(installed)), \
                mock.patch("shutil.copy2") as copy:
            install.create_launcher("win32")
            copy.assert_not_called()

    def test_python_install_uses_a_bat_wrapper(self):
        with mock.patch.object(sys, "frozen", False, create=True):
            wrapper = Path(install.create_launcher("win32"))
        self.assertEqual(wrapper.name, "silentproxy-host.bat")
        self.assertIn("-m silentproxy host %*", wrapper.read_text())

    def test_uninstall_removes_keys_and_ignores_missing_ones(self):
        install.install(["firefox"], [], platform="win32", launcher="C:\\x.exe")
        removed = install.uninstall(platform="win32")
        self.assertEqual(self.reg.deleted, [r"Software\Mozilla\NativeMessagingHosts\com.operationsilentproxy.launcher"])
        self.assertEqual(len(removed), 5)


class DoubleClickTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = mock.patch.dict(os.environ, {"SILENTPROXY_HOME": self.tmp.name})
        p.start()
        self.addCleanup(p.stop)

    def run_main(self, frozen, tty, argv=("silentproxy.exe",)):
        stdin = mock.Mock()
        stdin.isatty.return_value = tty
        with mock.patch.object(sys, "frozen", frozen, create=True), mock.patch.object(sys, "argv", list(argv)), \
                mock.patch.object(sys, "stdin", stdin), mock.patch("builtins.input", return_value="") as inp, \
                mock.patch.object(install, "install", return_value=["firefox: C:\\m.json"]) as ins, \
                mock.patch("silentproxy.manager.LabManager.doctor", return_value={"daemon_running": True, "compose_ok": True, "docker_version": "27"}), \
                mock.patch("builtins.print") as pr:
            code = cli.main()
        return code, ins, inp, [" ".join(map(str, c.args)) for c in pr.call_args_list]

    def test_double_clicked_exe_registers_with_firefox_then_waits(self):
        code, ins, inp, out = self.run_main(frozen=True, tty=True)
        self.assertEqual(code, 0)
        ins.assert_called_once_with(["firefox"], [])
        inp.assert_called_once()                                   # window stays open
        self.assertTrue(any("Registered with firefox" in l for l in out))
        self.assertTrue(any("Docker: ready" in l for l in out))

    def test_not_frozen_or_with_arguments_keeps_normal_behaviour(self):
        code, ins, inp, _ = self.run_main(frozen=False, tty=True)
        self.assertEqual(code, 2)                                  # plain `python -m silentproxy` prints help
        ins.assert_not_called()

    def test_firefox_launch_arguments_are_recognised_as_a_native_host_start(self):
        argv = ["silentproxy.exe", r"C:\Users\p\AppData\Local\SilentProxy\native-messaging\firefox\com.operationsilentproxy.launcher.json",
                FIREFOX_EXTENSION_ID]
        self.assertTrue(cli.is_native_launch(argv))
        with mock.patch.object(sys, "stdin", mock.Mock(isatty=mock.Mock(return_value=False))):
            self.assertTrue(cli.is_native_launch(["silentproxy.exe"]))   # no args + piped stdin = browser
        with mock.patch.object(sys, "stdin", mock.Mock(isatty=mock.Mock(return_value=True))):
            self.assertFalse(cli.is_native_launch(["silentproxy.exe"]))  # double-click


if __name__ == "__main__":
    unittest.main()
