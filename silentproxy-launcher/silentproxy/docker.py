"""Thin, defensive wrapper around the docker / docker compose CLI."""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
from typing import Callable, List, Optional

from .config import docker_override
from .errors import LabError

log = logging.getLogger(__name__)

# Browsers launch native hosts with a minimal PATH (notably on macOS), so widen it.
_EXTRA_PATHS = [
    "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/snap/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
    r"C:\Program Files\Docker\Docker\resources\bin",
]
MIN_COMPOSE = (2, 17)


def _env() -> dict:
    env = dict(os.environ)
    sep = os.pathsep
    env["PATH"] = sep.join([env.get("PATH", "")] + [p for p in _EXTRA_PATHS if os.path.isdir(p)])
    env.setdefault("COMPOSE_ANSI", "never")
    return env


def _creationflags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def classify(stderr: str) -> Optional[LabError]:
    s = stderr.lower()
    if "permission denied" in s and "docker.sock" in s:
        return LabError("DOCKER_PERMISSION", "No permission to use Docker.",
                        hint="Add your user to the docker group (sudo usermod -aG docker $USER), then log out and back in.")
    if "cannot connect to the docker daemon" in s or "error during connect" in s or "is the docker daemon running" in s:
        return LabError("DOCKER_NOT_RUNNING", "Docker is installed but not running.",
                        hint="Start Docker (Docker Desktop, or: sudo systemctl start docker) and try again.")
    if "port is already allocated" in s or "address already in use" in s:
        return LabError("PORT_IN_USE", "A port this lab needs is already in use on your machine.",
                        hint="Stop whatever is using it (another lab, Burp listener, or app) and retry.")
    return None


class Docker:
    def __init__(self, binary: Optional[str] = None):
        self.binary = binary or docker_override() or shutil.which("docker", path=_env()["PATH"])

    def _require(self) -> str:
        if not self.binary:
            raise LabError("DOCKER_NOT_FOUND", "Docker is not installed.",
                           hint="Install Docker Engine (Linux/Kali) or Docker Desktop, then retry.")
        return self.binary

    def run(self, args: List[str], timeout: float = 60, cwd: Optional[str] = None,
            on_line: Optional[Callable[[str], None]] = None) -> subprocess.CompletedProcess:
        cmd = [self._require(), *args]
        log.info("exec: %s", " ".join(cmd))
        try:
            proc = subprocess.Popen(cmd, cwd=cwd, env=_env(), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, errors="replace", creationflags=_creationflags())
        except OSError as exc:
            raise LabError("DOCKER_NOT_FOUND", f"Could not run docker: {exc}") from exc
        lines: List[str] = []
        timer = None
        timed_out: List[bool] = []

        def _kill() -> None:
            timed_out.append(True)
            proc.kill()

        try:
            import threading
            timer = threading.Timer(timeout, _kill)
            timer.start()
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.rstrip()
                lines.append(line)
                if on_line and line:
                    on_line(line)
            proc.wait()
        finally:
            if timer:
                timer.cancel()
        out = "\n".join(lines)
        if timed_out:
            raise LabError("TIMEOUT", "Docker took too long and was stopped.", hint="Retry; slow networks need longer to pull images.")
        return subprocess.CompletedProcess(cmd, proc.returncode, out, "")

    def _ok(self, args, **kw) -> str:
        res = self.run(args, **kw)
        if res.returncode != 0:
            raise classify(res.stdout) or LabError("DOCKER_FAILED", _tail(res.stdout) or "Docker command failed.")
        return res.stdout

    # -- health -----------------------------------------------------------
    def doctor(self) -> dict:
        info = {"docker_installed": bool(self.binary), "daemon_running": False, "compose_ok": False}
        if not self.binary:
            info["error"] = LabError("DOCKER_NOT_FOUND", "Docker is not installed.",
                                     hint="Install Docker Engine or Docker Desktop.").to_dict()
            return info
        res = self.run(["version", "--format", "{{.Server.Version}}"], timeout=20)
        if res.returncode != 0:
            err = classify(res.stdout) or LabError("DOCKER_FAILED", _tail(res.stdout))
            info["error"] = err.to_dict()
            return info
        info["daemon_running"] = True
        info["docker_version"] = res.stdout.strip()
        res = self.run(["compose", "version", "--short"], timeout=20)
        ver = re.search(r"(\d+)\.(\d+)", res.stdout or "")
        if res.returncode == 0 and ver:
            info["compose_version"] = res.stdout.strip().lstrip("v")
            info["compose_ok"] = (int(ver.group(1)), int(ver.group(2))) >= MIN_COMPOSE
        if not info["compose_ok"]:
            info["error"] = LabError("COMPOSE_MISSING", "Docker Compose v2.17 or newer is required.",
                                     hint="Install the Docker Compose plugin (docker-compose-plugin).").to_dict()
        return info

    def require_ready(self) -> None:
        d = self.doctor()
        if not (d["daemon_running"] and d["compose_ok"]):
            e = d.get("error", {})
            raise LabError(e.get("code", "DOCKER_FAILED"), e.get("message", "Docker is not ready."), hint=e.get("hint"))

    # -- compose ----------------------------------------------------------
    def config(self, project_dir: str, files: List[str]) -> dict:
        """Normalised compose config. stderr is kept separate so warnings can't corrupt the JSON."""
        args = [self._require(), "compose", "--project-directory", project_dir]
        for f in files:
            args += ["-f", f]
        try:
            res = subprocess.run(args + ["config", "--format", "json"], cwd=project_dir, env=_env(),
                                 capture_output=True, text=True, errors="replace", timeout=60,
                                 stdin=subprocess.DEVNULL, creationflags=_creationflags())
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise LabError("DOCKER_FAILED", f"Could not read the lab's compose file: {exc}") from exc
        if res.returncode != 0:
            raise classify(res.stderr) or LabError("UNSAFE_LAB", "Lab compose file is invalid.", detail=_tail(res.stderr))
        try:
            return json.loads(res.stdout)
        except json.JSONDecodeError as exc:
            raise LabError("UNSAFE_LAB", "Lab compose file could not be parsed.") from exc

    def up(self, project: str, project_dir: str, files: List[str], timeout: float, on_line=None) -> None:
        args = ["compose", "--progress", "plain", "-p", project, "--project-directory", project_dir]
        for f in files:
            args += ["-f", f]
        res = self.run(args + ["up", "-d", "--build", "--remove-orphans", "--pull", "missing"],
                       timeout=timeout, cwd=project_dir, on_line=on_line)
        if res.returncode != 0:
            raise classify(res.stdout) or LabError("START_FAILED", "Lab failed to start.", detail=_tail(res.stdout))

    def down(self, project: str, timeout: float = 120, volumes: bool = True) -> None:
        args = ["compose", "-p", project, "down", "--remove-orphans", "--timeout", "10"]
        if volumes:
            args.append("--volumes")
        res = self.run(args, timeout=timeout)
        if res.returncode != 0:
            raise classify(res.stdout) or LabError("STOP_FAILED", "Could not stop the lab.", detail=_tail(res.stdout))

    def ps(self, project: str) -> List[dict]:
        res = self.run(["compose", "-p", project, "ps", "--all", "--format", "json"], timeout=30)
        if res.returncode != 0:
            return []
        text = res.stdout.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            rows = parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError:  # older compose emits one JSON object per line
            rows = []
            for line in text.splitlines():
                with_json = line.strip()
                if with_json.startswith("{"):
                    try:
                        rows.append(json.loads(with_json))
                    except json.JSONDecodeError:
                        pass
        return [{"service": r.get("Service"), "state": r.get("State"), "health": r.get("Health") or None}
                for r in rows]


def _tail(text: str, n: int = 8) -> str:
    return "\n".join(text.strip().splitlines()[-n:])[:1500]
