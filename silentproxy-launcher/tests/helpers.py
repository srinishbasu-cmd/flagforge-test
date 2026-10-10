import hashlib
import http.server
import json
import os
import threading
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAKE_DOCKER = str(HERE / "fake_docker.py")

GOOD_COMPOSE = {
    "name": "demo",
    "services": {"web": {"image": "nginx:alpine",
                         "ports": [{"mode": "ingress", "host_ip": "127.0.0.1", "target": 80,
                                    "published": "18080", "protocol": "tcp"}]}},
}


def good_compose(port=18080):
    return {"name": "demo", "services": {"web": {"image": "nginx:alpine", "ports": [
        {"mode": "ingress", "host_ip": "127.0.0.1", "target": 80, "published": str(port), "protocol": "tcp"}]}}}


def make_lab_zip(path, compose=None, prefix="", extra=None):
    compose = compose or GOOD_COMPOSE
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(prefix + "docker-compose.yml", json.dumps(compose))
        zf.writestr(prefix + "site/index.html", "<h1>hi</h1>")
        for name, data in (extra or {}).items():
            zf.writestr(prefix + name, data)
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def serve(directory):
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **k)  # noqa: E731
    handler_cls = type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a, **k: None})
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: handler_cls(*a, directory=str(directory), **k))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def registry_json(url, sha, size, port=18080, check=False, lab_id="demo-lab", version="1.0.0", ttl=6):
    return {"schema": 1, "labs": [{
        "id": lab_id, "title": "Demo", "version": version, "url": url, "sha256": sha, "size": size,
        "ttl_hours": ttl, "ports": [{"name": "web", "host": port, "check": check}]}]}


def dev_env(tmp, registry_path):
    env = dict(os.environ)
    env.update({"SILENTPROXY_DEV": "1", "SILENTPROXY_HOME": str(Path(tmp) / "home"),
                "SILENTPROXY_REGISTRY": str(registry_path), "SILENTPROXY_DOCKER_BIN": FAKE_DOCKER,
                "FAKE_DOCKER_STATE": str(Path(tmp) / "fake-state")})
    (Path(tmp) / "fake-state").mkdir(exist_ok=True)
    return env
