"""Register the native messaging manifest with each browser (per-user, no admin)."""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Dict, List, Optional

from . import paths
from .config import FIREFOX_EXTENSION_ID, HOST_DESCRIPTION, HOST_NAME

CHROMIUM_FAMILY = ("chrome", "chromium", "edge", "brave")
_CHROME_ID_RE = re.compile(r"^[a-p]{32}$")
_GECKO_ID_RE = re.compile(r"^[A-Za-z0-9._@+-]{3,100}$")

_LINUX = {
    "chrome": ".config/google-chrome", "chromium": ".config/chromium", "edge": ".config/microsoft-edge",
    "brave": ".config/BraveSoftware/Brave-Browser", "firefox": ".mozilla",
}
_MAC = {
    "chrome": "Library/Application Support/Google/Chrome", "chromium": "Library/Application Support/Chromium",
    "edge": "Library/Application Support/Microsoft Edge",
    "brave": "Library/Application Support/BraveSoftware/Brave-Browser",
    "firefox": "Library/Application Support/Mozilla",
}
_WIN_KEYS = {
    "chrome": r"Software\Google\Chrome\NativeMessagingHosts", "chromium": r"Software\Chromium\NativeMessagingHosts",
    "edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
    "brave": r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    "firefox": r"Software\Mozilla\NativeMessagingHosts",
}


def manifest_dirs(home: Path, platform: str) -> Dict[str, Path]:
    table = _MAC if platform == "darwin" else _LINUX
    out = {}
    for browser, rel in table.items():
        sub = "native-messaging-hosts" if (browser == "firefox" and platform != "darwin") else "NativeMessagingHosts"
        out[browser] = home / rel / sub
    return out


def build_manifest(browser: str, host_path: str, chrome_ids: List[str], firefox_id: str) -> dict:
    manifest = {"name": HOST_NAME, "description": HOST_DESCRIPTION, "path": host_path, "type": "stdio"}
    if browser == "firefox":
        manifest["allowed_extensions"] = [firefox_id]
    else:
        manifest["allowed_origins"] = [f"chrome-extension://{i}/" for i in chrome_ids]
    return manifest


def create_launcher(platform: Optional[str] = None) -> str:
    """Return the executable path browsers should start (a wrapper when running from Python)."""
    platform = platform or sys.platform
    bin_dir = paths.data_dir() / "bin"
    bin_dir.mkdir(exist_ok=True)
    if getattr(sys, "frozen", False):
        # Copy the single-file build to a stable place so the browser keeps working if the download is moved.
        import shutil

        target = bin_dir / ("silentproxy.exe" if platform == "win32" else "silentproxy")
        if Path(sys.executable).resolve() != target.resolve():
            shutil.copy2(sys.executable, target)
        target.chmod(0o755)
        return str(target)
    src_root = str(Path(__file__).resolve().parent.parent)
    if platform == "win32":
        wrapper = bin_dir / "silentproxy-host.bat"
        wrapper.write_text(f'@echo off\r\nset "PYTHONPATH={src_root};%PYTHONPATH%"\r\n'
                           f'"{sys.executable}" -m silentproxy host %*\r\n', "utf-8")
    else:
        wrapper = bin_dir / "silentproxy-host"
        wrapper.write_text(f'#!/bin/sh\nPYTHONPATH={shlex.quote(src_root)}${{PYTHONPATH:+:$PYTHONPATH}} '
                           f'exec {shlex.quote(sys.executable)} -m silentproxy host "$@"\n', "utf-8")
        wrapper.chmod(0o755)
    return str(wrapper)


def _write_manifest(directory: Path, manifest: dict) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{HOST_NAME}.json"
    target.write_text(json.dumps(manifest, indent=2), "utf-8")
    return target


def _registry_key(key_path: str, manifest_path: Optional[str]) -> None:  # Windows only
    import winreg

    full = rf"{key_path}\{HOST_NAME}"
    if manifest_path is None:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, full)
        except FileNotFoundError:
            pass
        return
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, full) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)


def install(browsers: List[str], chrome_ids: List[str], firefox_id: str = FIREFOX_EXTENSION_ID,
            home: Optional[Path] = None, platform: Optional[str] = None, launcher: Optional[str] = None) -> List[str]:
    platform = platform or sys.platform
    home = home or Path.home()
    for cid in chrome_ids:
        if not _CHROME_ID_RE.match(cid):
            raise ValueError(f"{cid!r} is not a valid Chrome extension id (32 letters a-p)")
    if not _GECKO_ID_RE.match(firefox_id):
        raise ValueError("invalid Firefox extension id")
    wanted = [b for b in browsers if b == "firefox" or b in CHROMIUM_FAMILY]
    if any(b in CHROMIUM_FAMILY for b in wanted) and not chrome_ids:
        raise ValueError("a Chromium-family browser needs --chrome-id (the extension's ID)")
    host_path = launcher or create_launcher(platform)
    done: List[str] = []
    if platform == "win32":
        base = paths.data_dir() / "native-messaging"
        for browser in wanted:
            manifest = build_manifest(browser, host_path, chrome_ids, firefox_id)
            target = _write_manifest(base / browser, manifest)
            _registry_key(_WIN_KEYS[browser], str(target))
            done.append(f"{browser}: {target}")
        return done
    dirs = manifest_dirs(home, platform)
    for browser in wanted:
        target = _write_manifest(dirs[browser], build_manifest(browser, host_path, chrome_ids, firefox_id))
        done.append(f"{browser}: {target}")
    return done


def uninstall(home: Optional[Path] = None, platform: Optional[str] = None) -> List[str]:
    platform = platform or sys.platform
    home = home or Path.home()
    removed: List[str] = []
    if platform == "win32":
        for browser, key in _WIN_KEYS.items():
            _registry_key(key, None)
            removed.append(f"{browser}: registry key")
        return removed
    for browser, directory in manifest_dirs(home, platform).items():
        target = directory / f"{HOST_NAME}.json"
        if target.exists():
            target.unlink()
            removed.append(f"{browser}: {target}")
    return removed
