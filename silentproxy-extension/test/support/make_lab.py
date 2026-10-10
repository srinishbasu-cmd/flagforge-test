#!/usr/bin/env python3
"""make_lab.py <outdir> <port>: write demo-lab.zip (GitHub-style top folder) and print {"sha256","size"}."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

out, port = Path(sys.argv[1]), sys.argv[2]
out.mkdir(parents=True, exist_ok=True)
compose = {"name": "demo", "services": {"web": {"image": "nginx:alpine", "ports": [
    {"mode": "ingress", "host_ip": "127.0.0.1", "target": 80, "published": port, "protocol": "tcp"}]}}}
z = out / "demo-lab.zip"
with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("demo-lab-main/docker-compose.yml", json.dumps(compose))
    zf.writestr("demo-lab-main/site/index.html", "<h1>hi</h1>")
data = z.read_bytes()
print(json.dumps({"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}))
