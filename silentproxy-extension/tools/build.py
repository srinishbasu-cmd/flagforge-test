#!/usr/bin/env python3
"""Build the Chrome and Firefox extension packages into dist/.

  python tools/build.py --site https://cybersecurity-ctf-org.github.io/operation-silent-proxy/
  python tools/build.py --site https://... --dev-site http://localhost:8000/     # local testing build
"""
import argparse
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SRC, DIST = ROOT / "src", ROOT / "dist"
GECKO_ID = "silentproxy-launcher@operationsilentproxy.local"  # must equal the launcher's FIREFOX_EXTENSION_ID
FILES = ["common.js", "background.js", "content.js", "popup.html", "popup.css", "popup.js"]
DEFAULT_SITE = "https://cybersecurity-ctf-org.github.io/operation-silent-proxy/"


def check_site(url: str, dev: bool) -> str:
    p = urlparse(url)
    local = p.hostname in ("localhost", "127.0.0.1")
    if p.scheme not in ("https", "http") or not p.hostname or (p.scheme == "http" and not local):
        sys.exit(f"{url!r}: sites must be https (http only for localhost)")
    if local and not dev:
        sys.exit("localhost sites are only allowed via --dev-site")
    if not url.endswith("/") or p.query or p.fragment:
        sys.exit(f"{url!r}: must end with '/' and have no query or fragment")
    return url


def match_pattern(prefix: str) -> str:
    p = urlparse(prefix)
    return f"{p.scheme}://{p.hostname}{p.path}*"  # ports are not part of match patterns; background re-checks the full prefix


def build(browser: str, prefixes: list, version: str) -> Path:
    out = DIST / browser
    shutil.rmtree(out, ignore_errors=True)
    (out / "icons").mkdir(parents=True)
    for name in FILES:
        shutil.copy(SRC / name, out / name)
    for icon in (SRC / "icons").glob("*.png"):
        shutil.copy(icon, out / "icons" / icon.name)
    cfg = {"allowedPrefixes": prefixes}
    (out / "config.js").write_text((SRC / "config.template.js").read_text().replace("__CONFIG__", json.dumps(cfg, indent=2)))

    m = json.loads((SRC / "manifest.base.json").read_text())
    m["version"] = version
    m["content_scripts"][0]["matches"] = sorted({match_pattern(p) for p in prefixes})
    if browser == "chrome":
        m["background"] = {"service_worker": "background.js"}
        m["minimum_chrome_version"] = "116"
        key = ROOT / "keys" / "chrome-key.pub.b64"
        if key.exists():
            m["key"] = key.read_text().strip()
    else:
        m["background"] = {"scripts": ["common.js", "config.js", "background.js"]}
        m["browser_specific_settings"] = {"gecko": {
            "id": GECKO_ID, "strict_min_version": "115.0",
            "data_collection_permissions": {"required": ["none"]}}}
    (out / "manifest.json").write_text(json.dumps(m, indent=2) + "\n")

    zpath = DIST / f"silentproxy-extension-{browser}-{version}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(out).as_posix())
    return zpath


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default=DEFAULT_SITE, help="URL prefix of the website allowed to use the extension")
    ap.add_argument("--dev-site", action="append", default=[], help="extra localhost prefix for testing only")
    a = ap.parse_args()
    version = (ROOT / "VERSION").read_text().strip()
    if not re.fullmatch(r"\d+(\.\d+){0,3}", version):
        sys.exit("VERSION must look like 1.2.3")
    prefixes = [check_site(a.site, False)] + [check_site(d, True) for d in a.dev_site]
    for browser in ("chrome", "firefox"):
        print("built", build(browser, prefixes, version))
    if not (ROOT / "keys" / "chrome-key.pub.b64").exists():
        print("note: no keys/chrome-key.pub.b64 - the Chrome ID will change per machine. Run tools/make_key.py first.")


if __name__ == "__main__":
    main()
