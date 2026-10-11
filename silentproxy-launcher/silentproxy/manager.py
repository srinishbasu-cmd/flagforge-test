"""Lab lifecycle: download -> verify -> extract -> policy check -> docker compose up."""
from __future__ import annotations

import contextlib
import json
import logging
import os
import shutil
import socket
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from . import paths, reaper, state
from .archive import safe_extract
from .config import (DEFAULT_TTL_HOURS, DOWN_TIMEOUT_S, LAB_ID_RE, MAX_DOWNLOAD_BYTES, MAX_RUNNING_LABS,
                     MAX_TTL_HOURS, READY_TIMEOUT_S, UP_TIMEOUT_S)
from .docker import Docker
from .errors import LabError
from .net import download_file
from .policy import _inside, build_override, validate_compose
from .registry import Lab, load_registry

log = logging.getLogger(__name__)
Emit = Callable[..., None]


def _noop(*_a, **_k) -> None:
    pass


def project_name(lab_id: str) -> str:
    return f"silentproxy-{lab_id}"


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


class LabManager:
    def __init__(self, docker: Optional[Docker] = None, loader=load_registry, spawn_reaper=reaper.spawn):
        self.docker = docker or Docker()
        self.loader = loader
        self.spawn_reaper = spawn_reaper
        self._locks: dict = {}
        self._guard = threading.Lock()

    # -- helpers ----------------------------------------------------------
    @contextlib.contextmanager
    def _exclusive(self, lab_id: str):
        with self._guard:
            lock = self._locks.setdefault(lab_id, threading.Lock())
        if not lock.acquire(blocking=False):
            raise LabError("LAB_BUSY", "Another operation on this lab is already in progress.")
        try:
            yield
        finally:
            lock.release()

    @staticmethod
    def _check_id(lab_id) -> str:
        if not isinstance(lab_id, str) or not LAB_ID_RE.match(lab_id):
            raise LabError("BAD_REQUEST", "Invalid lab id.")
        return lab_id

    def _public(self, lab_id: str, entry: dict, **extra) -> dict:
        now = time.time()
        out = {"lab": lab_id, "status": entry["status"], "version": entry["version"],
               "urls": entry.get("urls", []), "expires_at": _iso(entry["expires_at"]),
               "expires_in": max(0, int(entry["expires_at"] - now))}
        out.update(extra)
        return out

    # -- queries ----------------------------------------------------------
    def doctor(self) -> dict:
        info = self.docker.doctor()
        with contextlib.suppress(OSError):
            info["free_disk_gb"] = round(shutil.disk_usage(paths.data_dir()).free / 1e9, 1)
        return info

    def list_labs(self) -> dict:
        labs, meta = self.loader()
        running = state.snapshot()["labs"]
        out = []
        for lab in labs.values():
            marker = paths.labs_dir() / lab.id / lab.version / ".silentproxy-verified"
            out.append({"id": lab.id, "title": lab.title, "summary": lab.summary, "version": lab.version,
                        "size": lab.size, "ttl_hours": lab.ttl_hours, "installed": marker.exists(),
                        "running": lab.id in running,
                        "ports": [{"name": p.name, "url": p.url()} for p in lab.ports]})
        return {"labs": out, "registry": meta}

    def status(self) -> dict:
        labs_out, docker_ok = [], True
        for lab_id, entry in state.snapshot()["labs"].items():
            services = None
            try:
                services = self.docker.ps(project_name(lab_id))
            except LabError:
                docker_ok = False
            if services == [] and entry["status"] == "running":
                state.update(lambda d, k=lab_id: d["labs"].pop(k, None))  # containers gone (manual stop/reboot)
                continue
            labs_out.append(self._public(lab_id, entry, services=services))
        return {"labs": labs_out, "docker_available": docker_ok}

    # -- start ------------------------------------------------------------
    def start(self, lab_id, replace: bool = False, emit: Emit = _noop) -> dict:
        self._check_id(lab_id)
        emit("registry", "Checking the lab catalogue")
        labs, _meta = self.loader()
        lab = labs.get(lab_id)
        if lab is None:
            raise LabError("LAB_UNKNOWN", "That lab is not in the catalogue.")
        with self._exclusive(lab_id):
            current = state.snapshot()["labs"]
            entry = current.get(lab_id)
            if entry and entry["status"] == "running":
                rows = self.docker.ps(project_name(lab_id))
                if rows and all(r["state"] == "running" for r in rows):
                    emit("ready", "Lab is already running")
                    return self._public(lab_id, entry, already_running=True, ready=True)
            others = [k for k in current if k != lab_id]
            if len(others) >= MAX_RUNNING_LABS:
                if not replace:
                    raise LabError("OTHER_LAB_RUNNING", "Another lab is running. Stop it first or replace it.",
                                   running=others)
                for other in others:
                    emit("stopping", f"Stopping {other}")
                    self.stop(other)
            emit("docker", "Checking Docker")
            self.docker.require_ready()
            lab_dir = self._ensure_lab(lab, emit)
            files = self._prepare(lab, lab_dir, emit)
            if entry:  # leftover from a crashed run: start clean
                with contextlib.suppress(LabError):
                    self.docker.down(project_name(lab_id), DOWN_TIMEOUT_S)
            self._check_ports_free(lab)

            ttl = lab.ttl_hours or DEFAULT_TTL_HOURS
            now = time.time()
            new_entry = {"version": lab.version, "status": "starting", "started_at": now,
                         "expires_at": now + ttl * 3600, "compose": files,
                         "urls": [{"name": p.name, "url": p.url()} for p in lab.ports], "reaper_pid": 0}
            state.update(lambda d: d["labs"].__setitem__(lab_id, new_entry))
            new_entry["reaper_pid"] = self._spawn_reaper(lab_id)
            state.update(lambda d: d["labs"].__setitem__(lab_id, new_entry))

            emit("starting", "Starting containers (the first run pulls images and can take a few minutes)")
            last = [0.0]

            def on_line(line: str) -> None:
                if time.time() - last[0] > 0.4:
                    last[0] = time.time()
                    emit("docker", line[:200])

            try:
                self.docker.up(project_name(lab_id), str(lab_dir), files, UP_TIMEOUT_S, on_line)
            except LabError:
                with contextlib.suppress(Exception):
                    self.docker.down(project_name(lab_id), DOWN_TIMEOUT_S)
                state.update(lambda d: d["labs"].pop(lab_id, None))
                raise

            emit("waiting", "Waiting for services to accept connections")
            pending = self._wait_ready(lab)
            new_entry["status"] = "running"
            state.update(lambda d: d["labs"].__setitem__(lab_id, new_entry))
            extra = {"ready": not pending}
            if pending:
                extra["pending_ports"] = pending
            emit("ready", "Lab is ready" if not pending else "Lab started but some services are still warming up")
            return self._public(lab_id, new_entry, **extra)

    def _spawn_reaper(self, lab_id: str) -> int:
        try:
            return self.spawn_reaper(lab_id)
        except Exception:
            log.exception("could not spawn reaper")
            return 0

    def _ensure_lab(self, lab: Lab, emit: Emit) -> Path:
        dest = paths.labs_dir() / lab.id / lab.version
        marker = dest / ".silentproxy-verified"
        with contextlib.suppress(OSError):
            if marker.read_text("utf-8").strip() == lab.sha256:
                emit("cached", "Lab files already downloaded and verified")
                return dest
        emit("download", f"Downloading {lab.title}", 0)
        work = Path(tempfile.mkdtemp(prefix="dl-", dir=paths.tmp_dir()))
        try:
            archive = str(work / "lab.zip")
            last = [-1]

            def progress(done: int, total: int) -> None:
                pct = min(99, int(done * 100 / max(total, 1)))
                if pct != last[0] and pct % 5 == 0:
                    last[0] = pct
                    emit("download", f"Downloading {lab.title}", pct)

            download_file(lab.url, archive, min(lab.size + 1024 * 1024, MAX_DOWNLOAD_BYTES), lab.sha256, progress)
            emit("verify", "Checksum verified")
            emit("extract", "Unpacking lab files")
            staged = str(work / "files")
            safe_extract(archive, staged)
            (Path(staged) / ".silentproxy-verified").write_text(lab.sha256, "utf-8")
            if dest.parent.exists():
                shutil.rmtree(dest.parent, ignore_errors=True)  # drop older versions
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(staged, str(dest))
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return dest

    def _prepare(self, lab: Lab, lab_dir: Path, emit: Emit) -> list:
        compose = lab_dir / lab.compose_file
        if not compose.is_file() or not _inside(str(compose), str(lab_dir)):
            raise LabError("UNSAFE_LAB", f"Compose file {lab.compose_file!r} not found in the lab.")
        emit("validate", "Checking the lab against the safety policy")
        cfg = self.docker.config(str(lab_dir), [str(compose)])
        problems = validate_compose(cfg, str(lab_dir), lab.declared_ports())
        if problems:
            raise LabError("UNSAFE_LAB", "This lab breaks the launcher's safety rules and was not started.",
                           problems=problems[:10])
        override = lab_dir / ".silentproxy.override.yml"
        override.write_text(json.dumps(build_override(cfg, lab.id)), "utf-8")  # JSON is valid YAML
        return [str(compose), str(override)]

    @staticmethod
    def _check_ports_free(lab: Lab) -> None:
        for port in lab.ports:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
                try:
                    s.bind(("127.0.0.1", port.host))
                except OSError:
                    raise LabError("PORT_IN_USE", f"Port {port.host} ({port.name}) is already in use.",
                                   hint="Stop whatever is using it (another lab or a Burp listener) and retry.",
                                   port=port.host) from None

    @staticmethod
    def _wait_ready(lab: Lab, timeout: float = READY_TIMEOUT_S) -> list:
        pending = [p.host for p in lab.ports if p.check]
        deadline = time.time() + timeout
        while pending and time.time() < deadline:
            still = []
            for port in pending:
                try:
                    socket.create_connection(("127.0.0.1", port), timeout=1).close()
                except OSError:
                    still.append(port)
            pending = still
            if pending:
                time.sleep(1)
        return pending

    # -- stop / extend / cleanup -----------------------------------------
    def stop(self, lab_id, emit: Emit = _noop) -> dict:
        self._check_id(lab_id)
        with self._exclusive(lab_id):
            was_tracked = lab_id in state.snapshot()["labs"]
            emit("stopping", "Stopping containers")
            self.docker.down(project_name(lab_id), DOWN_TIMEOUT_S)
            state.update(lambda d: d["labs"].pop(lab_id, None))
            return {"lab": lab_id, "stopped": True, "was_running": was_tracked}

    def stop_all(self, emit: Emit = _noop) -> dict:
        stopped = []
        for lab_id in list(state.snapshot()["labs"]):
            self.stop(lab_id, emit)
            stopped.append(lab_id)
        return {"stopped": stopped}

    def extend(self, lab_id, hours) -> dict:
        self._check_id(lab_id)
        if not isinstance(hours, (int, float)) or isinstance(hours, bool) or not 0.25 <= hours <= MAX_TTL_HOURS:
            raise LabError("BAD_REQUEST", f"hours must be between 0.25 and {MAX_TTL_HOURS}.")
        holder = {}

        def mutate(d):
            entry = d["labs"].get(lab_id)
            if not entry:
                raise LabError("NOT_RUNNING", "That lab is not running.")
            # add the hours to the time that is left, but never allow more than MAX_TTL_HOURS from now
            entry["expires_at"] = min(entry["expires_at"] + hours * 3600, time.time() + MAX_TTL_HOURS * 3600)
            holder["entry"] = dict(entry)

        state.update(mutate)
        return self._public(lab_id, holder["entry"])

    def reap_expired(self) -> list:
        reaped = []
        for lab_id, entry in state.snapshot()["labs"].items():
            if entry["expires_at"] <= time.time():
                with contextlib.suppress(LabError):
                    self.stop(lab_id)
                    reaped.append(lab_id)
        return reaped

    def purge(self) -> dict:
        self.stop_all()
        shutil.rmtree(paths.labs_dir(), ignore_errors=True)
        shutil.rmtree(paths.tmp_dir(), ignore_errors=True)
        return {"purged": True}
