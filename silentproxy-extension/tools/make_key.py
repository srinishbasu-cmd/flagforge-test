#!/usr/bin/env python3
"""Create (once) a signing key so the Chrome extension ID is stable, and print that ID.

The ID is what `silentproxy install --chrome-id <ID>` must be given. Keep keys/chrome-key.pem private
(it is git-ignored); the public part is embedded in the manifest by tools/build.py.
"""
import base64
import hashlib
import subprocess
import sys
from pathlib import Path

KEYS = Path(__file__).resolve().parent.parent / "keys"
PEM, PUB = KEYS / "chrome-key.pem", KEYS / "chrome-key.pub.b64"


def extension_id(der: bytes) -> str:
    # Chrome: first 16 bytes of SHA-256(public key DER), each hex digit mapped 0-f -> a-p
    return "".join(chr(ord("a") + int(ch, 16)) for ch in hashlib.sha256(der).hexdigest()[:32])


def main() -> None:
    KEYS.mkdir(exist_ok=True)
    if not PEM.exists():
        subprocess.run(["openssl", "genrsa", "-out", str(PEM), "2048"], check=True, capture_output=True)
        PEM.chmod(0o600)
        print("created", PEM, "- back this up; losing it changes the extension ID")
    der = subprocess.run(["openssl", "rsa", "-in", str(PEM), "-pubout", "-outform", "DER"],
                         check=True, capture_output=True).stdout
    PUB.write_text(base64.b64encode(der).decode() + "\n")
    print("Chrome extension ID:", extension_id(der))


if __name__ == "__main__":
    sys.exit(main())
