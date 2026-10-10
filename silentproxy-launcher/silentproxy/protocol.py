"""Native messaging framing: 4-byte native-endian length + UTF-8 JSON."""
from __future__ import annotations

import json
import struct
import sys
import threading
from typing import BinaryIO

from .config import MAX_MESSAGE_IN, MAX_MESSAGE_OUT


class ProtocolError(Exception):
    pass


def read_message(stream: BinaryIO):
    """Return a decoded message, or None on clean EOF."""
    header = stream.read(4)
    if not header:
        return None
    if len(header) < 4:
        raise ProtocolError("truncated length header")
    (length,) = struct.unpack("=I", header)
    if length > MAX_MESSAGE_IN:
        raise ProtocolError(f"message too large ({length} bytes)")
    body = stream.read(length)
    if len(body) < length:
        raise ProtocolError("truncated message body")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"invalid JSON: {exc}") from exc


def encode_message(obj) -> bytes:
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_MESSAGE_OUT:
        raise ProtocolError("outgoing message too large")
    return struct.pack("=I", len(body)) + body


class Writer:
    """Thread-safe writer so progress events and replies never interleave."""

    def __init__(self, stream: BinaryIO):
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, obj) -> None:
        data = encode_message(obj)
        with self._lock:
            self._stream.write(data)
            self._stream.flush()


def binary_stdio():
    """Return (stdin, stdout) as binary streams and keep stray prints off stdout."""
    if sys.platform == "win32":
        import msvcrt
        import os

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = sys.stderr
    return stdin, stdout
