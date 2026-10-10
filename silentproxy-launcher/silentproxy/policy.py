"""Safety policy for downloaded compose files.

We never run a lab's compose file as-is: it is normalised with
`docker compose config --format json` and every service is checked here first.
"""
from __future__ import annotations

import os
from typing import List

from .config import ALLOWED_CAPS, DEFAULT_CPUS, DEFAULT_MEM_LIMIT, DEFAULT_PIDS_LIMIT

_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _inside(path: str, root: str) -> bool:
    try:
        p = os.path.normcase(os.path.realpath(path))
        r = os.path.normcase(os.path.realpath(root))
        return os.path.commonpath([p, r]) == r
    except ValueError:  # different drives on Windows
        return False


def validate_compose(config: dict, lab_dir: str, declared_ports: set) -> List[str]:
    """Return a list of violations (empty means the lab may run)."""
    problems: List[str] = []
    services = config.get("services") or {}
    if not services:
        return ["compose file defines no services"]

    for name, svc in services.items():
        def bad(msg: str) -> None:
            problems.append(f"service '{name}': {msg}")

        if svc.get("privileged"):
            bad("privileged mode is not allowed")
        if svc.get("network_mode") == "host" or str(svc.get("network_mode", "")).startswith("container:"):
            bad("host/container network mode is not allowed")
        for key in ("pid", "ipc", "uts", "userns_mode"):
            if svc.get(key) == "host":
                bad(f"{key}: host is not allowed")
        extra_caps = set(svc.get("cap_add") or []) - ALLOWED_CAPS
        if extra_caps:
            bad(f"capabilities not allowed: {sorted(extra_caps)}")
        if svc.get("devices"):
            bad("device mappings are not allowed")
        if svc.get("cgroup_parent") or svc.get("runtime"):
            bad("cgroup_parent/runtime overrides are not allowed")
        if any("unconfined" in str(o) for o in svc.get("security_opt") or []):
            bad("unconfined security profiles are not allowed")
        for key in (svc.get("sysctls") or {}):
            if not str(key).startswith("net."):
                bad(f"sysctl {key} is not allowed")

        for port in svc.get("ports") or []:
            if not isinstance(port, dict):
                bad("unexpected port format")
                continue
            if str(port.get("host_ip", "")) not in _LOOPBACK:
                bad(f"port {port.get('published') or port.get('target')} must be bound to 127.0.0.1")
            pub = port.get("published")
            if pub in (None, ""):
                bad(f"port {port.get('target')} must publish an explicit 127.0.0.1 host port")
                continue
            if not str(pub).isdigit():
                bad(f"port range {pub} is not allowed")
            elif int(pub) not in declared_ports:
                bad(f"host port {pub} is not declared in the lab catalogue")

        for vol in svc.get("volumes") or []:
            if isinstance(vol, dict) and vol.get("type") == "bind":
                src = str(vol.get("source", ""))
                if "docker.sock" in src or not _inside(src, lab_dir):
                    bad(f"bind mount {src!r} is outside the lab folder")

        build = svc.get("build")
        if isinstance(build, dict):
            ctx = str(build.get("context", ""))
            if "://" in ctx or ctx.startswith("git@") or not _inside(ctx, lab_dir):
                bad("build context must be inside the lab folder")
            if build.get("additional_contexts"):
                bad("additional build contexts are not allowed")

    for kind in ("secrets", "configs"):
        for name, spec in (config.get(kind) or {}).items():
            f = (spec or {}).get("file")
            if f and not _inside(str(f), lab_dir):
                problems.append(f"{kind[:-1]} '{name}' file is outside the lab folder")
    for name, spec in (config.get("volumes") or {}).items():
        spec = spec or {}
        if spec.get("external"):
            problems.append(f"volume '{name}': external volumes are not allowed")
        if "device" in (spec.get("driver_opts") or {}):
            problems.append(f"volume '{name}': device-backed volumes are not allowed")
    for name, spec in (config.get("networks") or {}).items():
        spec = spec or {}
        if spec.get("external"):
            problems.append(f"network '{name}': external networks are not allowed")
        if spec.get("driver") in ("host", "macvlan", "ipvlan"):
            problems.append(f"network '{name}': driver {spec['driver']} is not allowed")
    return problems


def build_override(config: dict, lab_id: str) -> dict:
    """Compose override that adds resource caps and tracking labels to every service."""
    services = {}
    for name, svc in (config.get("services") or {}).items():
        extra = {
            "labels": {"com.operationsilentproxy.lab": lab_id},
            "security_opt": ["no-new-privileges:true"],
        }
        limits = ((svc.get("deploy") or {}).get("resources") or {}).get("limits") or {}
        if not svc.get("mem_limit") and not limits.get("memory"):
            extra["mem_limit"] = DEFAULT_MEM_LIMIT
        if not svc.get("cpus") and not limits.get("cpus"):
            extra["cpus"] = DEFAULT_CPUS
        if not svc.get("pids_limit"):
            extra["pids_limit"] = DEFAULT_PIDS_LIMIT
        services[name] = extra
    return {"services": services}
