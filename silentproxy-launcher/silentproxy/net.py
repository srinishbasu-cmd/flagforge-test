"""HTTPS fetching restricted to GitHub, with every redirect hop re-checked."""
from __future__ import annotations

import hashlib
import urllib.error
import urllib.request
from typing import Callable, Optional
from urllib.parse import urlparse

from . import __version__
from .config import ALLOWED_REDIRECT_SUFFIXES, ALLOWED_URL_PREFIXES, dev_mode
from .errors import LabError


def host_allowed(host: str) -> bool:
    host = (host or "").lower()
    for suffix in ALLOWED_REDIRECT_SUFFIXES:
        s = suffix.lstrip(".")
        if host == s or host.endswith("." + s):
            return True
    return False


def url_allowed(url: str) -> bool:
    if dev_mode():
        return url.startswith(("https://", "http://127.0.0.1", "http://localhost"))
    return url.startswith(ALLOWED_URL_PREFIXES)


class _StrictRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        p = urlparse(newurl)
        if not dev_mode() and (p.scheme != "https" or not host_allowed(p.hostname or "")):
            raise urllib.error.URLError(f"redirect to disallowed location blocked: {p.hostname}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, timeout: float):
    opener = urllib.request.build_opener(_StrictRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": f"silentproxy-launcher/{__version__}"})
    return opener.open(req, timeout=timeout)


def fetch_bytes(url: str, max_bytes: int, timeout: float = 15) -> bytes:
    if not url_allowed(url):
        raise LabError("URL_NOT_ALLOWED", "Refusing to fetch from a non-allowlisted location.")
    try:
        with _open(url, timeout) as resp:
            data = resp.read(max_bytes + 1)
    except (urllib.error.URLError, OSError) as exc:
        raise LabError("NETWORK", f"Could not download: {exc}", hint="Check your internet connection.") from exc
    if len(data) > max_bytes:
        raise LabError("DOWNLOAD_TOO_LARGE", "Download exceeded the size limit.")
    return data


def download_file(
    url: str,
    dest: str,
    max_bytes: int,
    expected_sha256: str,
    progress: Optional[Callable[[int, int], None]] = None,
    timeout: float = 30,
) -> str:
    """Stream url to dest, enforcing a size cap; returns the sha256 and raises on mismatch."""
    if not url_allowed(url):
        raise LabError("URL_NOT_ALLOWED", "Refusing to download from a non-allowlisted location.")
    h = hashlib.sha256()
    total = 0
    try:
        with _open(url, timeout) as resp, open(dest, "wb") as out:
            length = int(resp.headers.get("Content-Length") or 0)
            if length and length > max_bytes:
                raise LabError("DOWNLOAD_TOO_LARGE", "Lab archive is larger than allowed.")
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise LabError("DOWNLOAD_TOO_LARGE", "Lab archive is larger than allowed.")
                h.update(chunk)
                out.write(chunk)
                if progress:
                    progress(total, length or max_bytes)
    except (urllib.error.URLError, OSError) as exc:
        raise LabError("DOWNLOAD_FAILED", f"Download failed: {exc}", hint="Check your internet connection and retry.") from exc
    digest = h.hexdigest()
    if digest != expected_sha256.lower():
        raise LabError(
            "CHECKSUM_MISMATCH",
            "Downloaded lab does not match its published checksum and was discarded.",
        )
    return digest
