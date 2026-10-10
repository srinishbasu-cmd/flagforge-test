"""Safe extraction of a downloaded lab archive."""
from __future__ import annotations

import os
import shutil
import stat
import zipfile
from pathlib import PurePosixPath

from .config import MAX_EXTRACT_BYTES, MAX_EXTRACT_FILES, MAX_RATIO
from .errors import LabError


def _bad(msg: str) -> LabError:
    return LabError("ARCHIVE_UNSAFE", f"Lab archive rejected: {msg}")


def _clean(name: str) -> PurePosixPath:
    name = name.replace("\\", "/")
    if "\x00" in name or name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        raise _bad(f"absolute or invalid path {name!r}")
    p = PurePosixPath(name)
    if any(part == ".." for part in p.parts):
        raise _bad(f"path traversal in {name!r}")
    return p


def safe_extract(zip_path: str, dest: str) -> int:
    """Extract into dest (must not exist). Returns number of files written."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise _bad("not a valid zip file") from exc
    with zf:
        infos = zf.infolist()
        if not infos or len(infos) > MAX_EXTRACT_FILES:
            raise _bad("empty or too many entries")
        entries = []
        total = 0
        for info in infos:
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise _bad(f"symlink {info.filename!r} not allowed")
            if stat.S_ISCHR(mode) or stat.S_ISBLK(mode) or stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode):
                raise _bad("special file in archive")
            total += info.file_size
            if total > MAX_EXTRACT_BYTES:
                raise _bad("uncompressed size too large")
            if info.compress_size and info.file_size > 1024 * 1024 and info.file_size / info.compress_size > MAX_RATIO:
                raise _bad("suspicious compression ratio")
            entries.append((info, _clean(info.filename)))

        # Strip one shared top-level folder (GitHub-style archives).
        firsts = {p.parts[0] for _, p in entries if p.parts}
        strip = 0
        if len(firsts) == 1 and all(len(p.parts) > 1 or i.is_dir() for i, p in entries):
            strip = 1

        os.makedirs(dest)
        root = os.path.realpath(dest)
        written = 0
        try:
            for info, p in entries:
                parts = p.parts[strip:]
                if not parts:
                    continue
                target = os.path.realpath(os.path.join(root, *parts))
                if os.path.commonpath([root, target]) != root:
                    raise _bad(f"entry escapes destination: {info.filename!r}")
                if info.is_dir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                remaining = info.file_size
                with zf.open(info) as src, open(target, "wb") as out:
                    while True:
                        chunk = src.read(64 * 1024)
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        if remaining < 0:
                            raise _bad("entry larger than declared")
                        out.write(chunk)
                mode = info.external_attr >> 16
                os.chmod(target, 0o755 if mode & 0o111 else 0o644)
                written += 1
        except BaseException:
            shutil.rmtree(dest, ignore_errors=True)
            raise
    if written == 0:
        shutil.rmtree(dest, ignore_errors=True)
        raise _bad("archive contains no files")
    return written
