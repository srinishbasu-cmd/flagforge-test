"""Per-user data locations (no admin rights needed)."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    override = os.environ.get("SILENTPROXY_HOME")
    if override:
        base = Path(override)
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "SilentProxy"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "SilentProxy"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "silentproxy"
    base.mkdir(parents=True, exist_ok=True)
    return base


def labs_dir() -> Path:
    p = data_dir() / "labs"
    p.mkdir(exist_ok=True)
    return p


def tmp_dir() -> Path:
    p = data_dir() / "tmp"
    p.mkdir(exist_ok=True)
    return p


def log_dir() -> Path:
    p = data_dir() / "logs"
    p.mkdir(exist_ok=True)
    return p


def state_file() -> Path:
    return data_dir() / "state.json"


def registry_cache() -> Path:
    return data_dir() / "registry-cache.json"
