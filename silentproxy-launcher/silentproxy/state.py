"""Tiny JSON state store with an inter-process lock (host + reaper share it)."""
from __future__ import annotations

import contextlib
import json
import os
import time

from . import paths


@contextlib.contextmanager
def _lock(timeout: float = 10.0, stale: float = 30.0):
    lock_path = str(paths.state_file()) + ".lock"
    deadline = time.time() + timeout
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock_path) > stale:
                    os.remove(lock_path)
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                raise TimeoutError("state lock timeout")
            time.sleep(0.05)
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            os.remove(lock_path)


def _read() -> dict:
    try:
        with open(paths.state_file(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("labs"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"labs": {}}


def _write(data: dict) -> None:
    tmp = str(paths.state_file()) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, paths.state_file())


def snapshot() -> dict:
    with _lock():
        return _read()


def update(fn):
    """Run fn(state_dict) under the lock and persist whatever it leaves behind."""
    with _lock():
        data = _read()
        result = fn(data)
        _write(data)
        return result
