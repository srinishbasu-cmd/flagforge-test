"""Native messaging host: request/response loop with streamed progress events.

Request : {"id": "<any>", "action": "start", "lab": "mission-1-recon", "replace": false}
Progress: {"id": "<same>", "type": "progress", "stage": "download", "message": "...", "percent": 40}
Result  : {"id": "<same>", "type": "result", "ok": true,  "data": {...}}
          {"id": "<same>", "type": "result", "ok": false, "error": {"code": "...", "message": "..."}}
"""
from __future__ import annotations

import logging
import sys
import threading

from . import PROTOCOL_VERSION, __version__
from .errors import LabError
from .manager import LabManager
from .protocol import ProtocolError, Writer, read_message

log = logging.getLogger(__name__)
ACTIONS = {"ping", "doctor", "list", "start", "stop", "stop_all", "status", "extend"}


def dispatch(manager: LabManager, msg: dict, emit) -> dict:
    action = msg.get("action")
    if action not in ACTIONS:
        raise LabError("BAD_REQUEST", f"Unknown action {action!r}.")
    if action == "ping":
        return {"host": "silentproxy-launcher", "version": __version__,
                "protocol": PROTOCOL_VERSION, "platform": sys.platform}
    if action == "doctor":
        return manager.doctor()
    if action == "list":
        return manager.list_labs()
    if action == "status":
        return manager.status()
    if action == "stop_all":
        return manager.stop_all(emit)
    if action == "start":
        replace = msg.get("replace", False)
        if not isinstance(replace, bool):
            raise LabError("BAD_REQUEST", "replace must be a boolean.")
        return manager.start(msg.get("lab"), replace, emit)
    if action == "stop":
        return manager.stop(msg.get("lab"), emit)
    return manager.extend(msg.get("lab"), msg.get("hours"))  # extend


def _handle(manager: LabManager, writer: Writer, msg) -> None:
    rid = msg.get("id") if isinstance(msg, dict) and isinstance(msg.get("id"), (str, int)) else None

    def emit(stage: str, message: str = "", percent=None) -> None:
        event = {"id": rid, "type": "progress", "stage": stage, "message": message}
        if percent is not None:
            event["percent"] = percent
        try:
            writer.send(event)
        except (OSError, ValueError):
            pass  # browser went away; the operation still finishes safely

    try:
        if not isinstance(msg, dict):
            raise LabError("BAD_REQUEST", "Request must be a JSON object.")
        reply = {"id": rid, "type": "result", "ok": True, "data": dispatch(manager, msg, emit)}
    except LabError as exc:
        reply = {"id": rid, "type": "result", "ok": False, "error": exc.to_dict()}
    except Exception:
        log.exception("unhandled error")
        reply = {"id": rid, "type": "result", "ok": False,
                 "error": {"code": "INTERNAL", "message": "Unexpected error in the launcher. See its log file."}}
    try:
        writer.send(reply)
    except (OSError, ValueError):
        log.warning("could not deliver reply (pipe closed)")


def run_host(stdin, stdout, manager: LabManager | None = None, max_inflight: int = 8) -> None:
    writer = Writer(stdout)
    manager = manager or LabManager()
    gate = threading.BoundedSemaphore(max_inflight)

    def worker(msg) -> None:
        try:
            _handle(manager, writer, msg)
        finally:
            gate.release()

    threading.Thread(target=_safe_reap, args=(manager,), daemon=True).start()
    log.info("host started (v%s)", __version__)
    while True:
        try:
            msg = read_message(stdin)
        except ProtocolError as exc:
            log.warning("protocol error: %s", exc)
            try:
                writer.send({"id": None, "type": "result", "ok": False,
                             "error": {"code": "BAD_REQUEST", "message": str(exc)}})
            except OSError:
                pass
            break  # framing is lost; the extension will reconnect
        if msg is None:
            break
        if not gate.acquire(blocking=False):
            writer.send({"id": msg.get("id") if isinstance(msg, dict) else None, "type": "result", "ok": False,
                         "error": {"code": "LAB_BUSY", "message": "Too many requests in flight."}})
            continue
        threading.Thread(target=worker, args=(msg,), daemon=True).start()
    log.info("stdin closed; host exiting")


def _safe_reap(manager: LabManager) -> None:
    try:
        manager.reap_expired()
    except Exception:
        log.exception("startup reap failed")
