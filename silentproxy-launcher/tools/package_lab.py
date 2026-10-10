#!/usr/bin/env python3
"""Package a lab folder into a deterministic zip and update labs.json.

Example:
  python tools/package_lab.py labs/mission-1-recon --id mission-1-recon --version 1.0.0 \
      --base-url https://github.com/Cybersecurity-CTF-Org/operation-silent-proxy/releases/download/mission-1-recon-v1.0.0 \
      --title "Mission 1: Setup & Recon" --port "MegaCorp portal:8081" --registry labs.json --validate
Upload dist/<id>-<version>.zip to the GitHub release named in --base-url, then commit labs.json.
"""
import argparse
import hashlib
import json
import os
import stat
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".idea", ".vscode"}
SKIP_FILES = {".DS_Store", "Thumbs.db"}
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def build_zip(lab_dir: Path, out: Path) -> None:
    files = []
    for root, dirs, names in os.walk(lab_dir):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(names):
            if name in SKIP_FILES:
                continue
            p = Path(root) / name
            if p.is_symlink():
                sys.exit(f"refusing symlink: {p}")
            files.append(p)
    if not files:
        sys.exit("lab folder is empty")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in files:
            rel = p.relative_to(lab_dir).as_posix()
            info = zipfile.ZipInfo(rel, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if p.stat().st_mode & stat.S_IXUSR else 0o644) << 16
            zf.writestr(info, p.read_bytes())


def validate(lab_dir: Path, compose_file: str, ports: set) -> None:
    from silentproxy.docker import Docker
    from silentproxy.errors import LabError
    from silentproxy.policy import validate_compose

    docker = Docker()
    if not docker.binary:
        print("warning: docker not found, skipping --validate", file=sys.stderr)
        return
    try:
        cfg = docker.config(str(lab_dir), [str(lab_dir / compose_file)])
    except LabError as exc:
        sys.exit(f"compose error: {exc.message} {exc.extra.get('detail', '')}")
    problems = validate_compose(cfg, str(lab_dir), ports)
    if problems:
        sys.exit("policy violations:\n  " + "\n  ".join(problems))
    print("compose file passes the launcher safety policy")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lab_dir")
    ap.add_argument("--id", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--base-url", required=True, help="release download URL prefix (no trailing slash)")
    ap.add_argument("--registry", default="labs.json")
    ap.add_argument("--out", default="dist")
    ap.add_argument("--compose-file", default="docker-compose.yml")
    ap.add_argument("--title")
    ap.add_argument("--summary")
    ap.add_argument("--ttl", type=float)
    ap.add_argument("--port", action="append", default=[], help='"Name:hostport[:scheme[:/path]]" (repeatable)')
    ap.add_argument("--no-check", action="append", type=int, default=[], help="host port to skip readiness check for")
    ap.add_argument("--validate", action="store_true", help="run the safety policy against the compose file")
    a = ap.parse_args()

    lab_dir = Path(a.lab_dir).resolve()
    if not (lab_dir / a.compose_file).is_file():
        sys.exit(f"{a.compose_file} not found in {lab_dir}")
    reg_path = Path(a.registry)
    registry = json.loads(reg_path.read_text()) if reg_path.exists() else {"schema": 1, "labs": []}
    old = next((l for l in registry["labs"] if l.get("id") == a.id), {})

    ports = old.get("ports", [])
    if a.port:
        ports = []
        for spec in a.port:
            parts = spec.split(":")
            entry = {"name": parts[0], "host": int(parts[1])}
            if len(parts) > 2:
                entry["scheme"] = parts[2]
            if len(parts) > 3:
                entry["path"] = ":".join(parts[3:])
            if entry["host"] in a.no_check:
                entry["check"] = False
            ports.append(entry)
    if a.validate:
        validate(lab_dir, a.compose_file, {p["host"] for p in ports})

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_name = f"{a.id}-{a.version}.zip"
    zip_path = out_dir / zip_name
    build_zip(lab_dir, zip_path)
    data = zip_path.read_bytes()
    entry = {
        "id": a.id,
        "title": a.title or old.get("title", a.id),
        "summary": a.summary or old.get("summary", ""),
        "version": a.version,
        "url": f"{a.base_url.rstrip('/')}/{zip_name}",
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "compose_file": a.compose_file,
        "ttl_hours": a.ttl or old.get("ttl_hours", 6),
        "ports": ports,
    }
    registry["labs"] = [l for l in registry["labs"] if l.get("id") != a.id] + [entry]
    registry["labs"].sort(key=lambda l: l["id"])
    reg_path.write_text(json.dumps(registry, indent=2) + "\n")
    print(f"wrote {zip_path} ({len(data)} bytes, sha256 {entry['sha256'][:12]}...) and updated {reg_path}")


if __name__ == "__main__":
    main()
