"""The lab catalogue (labs.json): the only source of truth for what may be launched."""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from . import paths
from .config import (
    DEFAULT_TTL_HOURS,
    LAB_ID_RE,
    MAX_DOWNLOAD_BYTES,
    MAX_TTL_HOURS,
    dev_mode,
    registry_location,
)
from .errors import LabError
from .net import fetch_bytes, url_allowed

log = logging.getLogger(__name__)
_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$")
_SHA_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_COMPOSE_RE = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._/-]{0,100}$")
_SCHEMES = {"http", "https", "tcp", "ws"}


@dataclass(frozen=True)
class PortSpec:
    name: str
    host: int
    scheme: str = "http"
    path: str = "/"
    check: bool = True

    def url(self) -> str:
        if self.scheme == "tcp":
            return f"tcp://127.0.0.1:{self.host}"
        return f"{self.scheme}://127.0.0.1:{self.host}{self.path}"


@dataclass(frozen=True)
class Lab:
    id: str
    title: str
    version: str
    url: str
    sha256: str
    size: int
    compose_file: str = "docker-compose.yml"
    ttl_hours: float = DEFAULT_TTL_HOURS
    summary: str = ""
    ports: Tuple[PortSpec, ...] = field(default_factory=tuple)

    def declared_ports(self) -> set:
        return {p.host for p in self.ports}


def _parse_lab(raw: dict) -> Lab:
    if not isinstance(raw, dict):
        raise ValueError("lab entry is not an object")
    lab_id = raw.get("id", "")
    if not isinstance(lab_id, str) or not LAB_ID_RE.match(lab_id):
        raise ValueError(f"bad lab id {lab_id!r}")
    version = str(raw.get("version", ""))
    if not _VERSION_RE.match(version):
        raise ValueError("bad version")
    url = raw.get("url", "")
    if not isinstance(url, str) or not url_allowed(url):
        raise ValueError("url missing or not allowlisted")
    sha = raw.get("sha256", "")
    if not isinstance(sha, str) or not _SHA_RE.match(sha):
        raise ValueError("bad sha256")
    size = raw.get("size")
    if not isinstance(size, int) or not 0 < size <= MAX_DOWNLOAD_BYTES:
        raise ValueError("bad size")
    compose = raw.get("compose_file", "docker-compose.yml")
    if not isinstance(compose, str) or not _COMPOSE_RE.match(compose) or ".." in compose.split("/"):
        raise ValueError("bad compose_file")
    ttl = raw.get("ttl_hours", DEFAULT_TTL_HOURS)
    if not isinstance(ttl, (int, float)) or not 0.25 <= ttl <= MAX_TTL_HOURS:
        raise ValueError("bad ttl_hours")
    ports: List[PortSpec] = []
    for p in raw.get("ports", []):
        host = p.get("host")
        scheme = p.get("scheme", "http")
        path = p.get("path", "/")
        if not isinstance(host, int) or not 1024 <= host <= 65535:
            raise ValueError("bad port")
        if scheme not in _SCHEMES or not isinstance(path, str) or not path.startswith("/"):
            raise ValueError("bad port scheme/path")
        ports.append(PortSpec(str(p.get("name", f"port {host}"))[:60], host, scheme, path, bool(p.get("check", True))))
    if len({p.host for p in ports}) != len(ports):
        raise ValueError("duplicate port")
    return Lab(lab_id, str(raw.get("title", lab_id))[:100], version, url, sha.lower(), size,
               compose, float(ttl), str(raw.get("summary", ""))[:300], tuple(ports))


def parse_registry(data) -> Tuple[Dict[str, Lab], List[str]]:
    if not isinstance(data, dict) or data.get("schema") != 1 or not isinstance(data.get("labs"), list):
        raise LabError("REGISTRY_INVALID", "Lab catalogue has an unexpected format.")
    labs: Dict[str, Lab] = {}
    warnings: List[str] = []
    for raw in data["labs"]:
        try:
            lab = _parse_lab(raw)
            if lab.id in labs:
                raise ValueError("duplicate id")
            labs[lab.id] = lab
        except (ValueError, AttributeError, TypeError) as exc:
            name = raw.get("id") if isinstance(raw, dict) else "?"
            warnings.append(f"skipped lab {name!r}: {exc}")
            log.warning(warnings[-1])
    return labs, warnings


def load_registry() -> Tuple[Dict[str, Lab], dict]:
    """Fetch the catalogue; fall back to the last good copy when offline."""
    loc = registry_location()
    meta = {"source": "network", "stale": False, "warnings": []}
    try:
        if dev_mode() and not loc.startswith(("http://", "https://")):
            with open(loc, "rb") as fh:
                raw = fh.read()
        else:
            raw = fetch_bytes(loc, 1024 * 1024, timeout=10)
        labs, warnings = parse_registry(json.loads(raw.decode("utf-8")))
        meta["warnings"] = warnings
        tmp = str(paths.registry_cache()) + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(raw)
        os.replace(tmp, paths.registry_cache())
        return labs, meta
    except (LabError, OSError, ValueError) as exc:
        cache = paths.registry_cache()
        if not cache.exists():
            if isinstance(exc, LabError):
                raise
            raise LabError("REGISTRY_UNREACHABLE", f"Could not load lab catalogue: {exc}") from exc
        log.warning("registry fetch failed (%s); using cache", exc)
        labs, warnings = parse_registry(json.loads(cache.read_text("utf-8")))
        meta.update(source="cache", stale=True, warnings=warnings)
        return labs, meta
