"""Auto-stop: a detached process that tears a lab down when its TTL expires.

The browser extension (and therefore the native host) can disappear at any time,
so expiry must not depend on either of them being alive.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import List

from . import state

log = logging.getLogger(__name__)


def self_command() -> List[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, "-m", "silentproxy"]


def pid_alive(pid: int) -> bool:
    if not pid:
        return False
    if sys.platform == "win32":
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def spawn(lab_id: str) -> int:
    """Start a detached reaper for lab_id and return its pid."""
    env = dict(os.environ)
    src_root = str(Path(__file__).resolve().parent.parent)
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [src_root, env.get("PYTHONPATH", "")]))
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "env": env}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(self_command() + ["reap", lab_id], **kwargs).pid


def run(lab_id: str, manager, poll: float = 15.0) -> None:
    """Block until the lab is gone or expired; stop it on expiry."""
    while True:
        entry = state.snapshot()["labs"].get(lab_id)
        if not entry:
            return
        remaining = float(entry["expires_at"]) - time.time()
        if remaining <= 0:
            log.info("TTL expired for %s; stopping", lab_id)
            try:
                manager.stop(lab_id)
            except Exception:  # keep trying on the next loop
                log.exception("auto-stop failed for %s", lab_id)
                time.sleep(poll)
                continue
            return
        time.sleep(min(poll, max(remaining, 0.2)))
