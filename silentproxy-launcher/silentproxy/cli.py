"""Entry point. Browsers start us with no subcommand; people use the subcommands."""
from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import sys

from . import __version__, paths
from .config import FIREFOX_EXTENSION_ID
from .errors import LabError


def is_native_launch(argv) -> bool:
    args = argv[1:]
    if not args:
        return not sys.stdin.isatty()
    first = args[0]
    return first.startswith(("chrome-extension://", "moz-extension://", "--parent-window")) or first.endswith(".json")


def _guided_install() -> int:
    """Double-clicked .exe: register with Firefox, show what is ready, and keep the window open."""
    from . import install
    from .manager import LabManager

    print("Operation Silent Proxy launcher\n")
    code = 0
    try:
        for line in install.install(["firefox"], []):
            print("Registered with", line)
        print("\nSetup finished. Go back to the website and press 'Check again'.")
    except (ValueError, OSError) as exc:
        print("Setup failed:", exc)
        code = 1
    try:
        d = LabManager().doctor()
        if d.get("daemon_running") and d.get("compose_ok"):
            print("Docker: ready (version %s)" % d.get("docker_version", "?"))
        else:
            err = d.get("error") or {}
            print("Docker: NOT ready -", err.get("message", "unknown problem"))
            if err.get("hint"):
                print("        ", err["hint"])
    except Exception as exc:  # never let the status check hide the setup result
        print("Docker check skipped:", exc)
    try:
        input("\nPress Enter to close this window...")
    except EOFError:
        pass
    return code


def setup_logging(console: bool) -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fh = logging.handlers.RotatingFileHandler(paths.log_dir() / "launcher.log", maxBytes=1_000_000, backupCount=3,
                                              encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root.addHandler(fh)
    if console:
        root.addHandler(logging.StreamHandler(sys.stderr))


def _emit_cli(stage: str, message: str = "", percent=None) -> None:
    suffix = f" {percent}%" if percent is not None else ""
    print(f"[{stage}] {message}{suffix}", file=sys.stderr)


def _print(obj) -> None:
    print(json.dumps(obj, indent=2))


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="silentproxy", description="Operation Silent Proxy lab launcher")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("host", help="run as a native messaging host (used by the browser)")
    reap = sub.add_parser("reap")
    reap.add_argument("lab")
    sub.add_parser("doctor", help="check Docker and Compose")
    sub.add_parser("list", help="list labs from the catalogue")
    sub.add_parser("status", help="show running labs")
    for name in ("start", "stop"):
        c = sub.add_parser(name)
        c.add_argument("lab")
        if name == "start":
            c.add_argument("--replace", action="store_true", help="stop any other running lab first")
    sub.add_parser("stop-all")
    ext = sub.add_parser("extend")
    ext.add_argument("lab")
    ext.add_argument("hours", type=float)
    sub.add_parser("purge", help="stop everything and delete downloaded labs")
    ins = sub.add_parser("install", help="register with browsers")
    ins.add_argument("--browser", action="append", choices=["firefox", "chrome", "chromium", "edge", "brave"])
    ins.add_argument("--chrome-id", action="append", default=[], help="Chromium extension ID (repeatable)")
    ins.add_argument("--firefox-id", default=FIREFOX_EXTENSION_ID)
    sub.add_parser("uninstall", help="remove browser registrations")
    return p


def main(argv=None) -> int:
    if argv is None and is_native_launch(sys.argv):
        from .host import run_host
        from .protocol import binary_stdio

        setup_logging(console=False)
        stdin, stdout = binary_stdio()
        run_host(stdin, stdout)
        return 0

    if argv is None and len(sys.argv) == 1 and getattr(sys, "frozen", False) and sys.stdin.isatty():
        setup_logging(console=False)
        return _guided_install()

    args = _parser().parse_args(argv)
    setup_logging(console=args.cmd not in (None, "reap"))
    if args.cmd is None:
        _parser().print_help()
        return 2

    from . import install, reaper
    from .manager import LabManager

    try:
        if args.cmd == "host":
            from .host import run_host
            from .protocol import binary_stdio

            stdin, stdout = binary_stdio()
            run_host(stdin, stdout)
            return 0
        if args.cmd == "install":
            browsers = args.browser or (["firefox"] + (["chrome", "chromium", "edge", "brave"] if args.chrome_id else []))
            for line in install.install(browsers, args.chrome_id, args.firefox_id):
                print("registered", line)
            return 0
        if args.cmd == "uninstall":
            for line in install.uninstall():
                print("removed", line)
            return 0
        mgr = LabManager()
        if args.cmd == "reap":
            reaper.run(args.lab, mgr)
        elif args.cmd == "doctor":
            _print(mgr.doctor())
        elif args.cmd == "list":
            _print(mgr.list_labs())
        elif args.cmd == "status":
            _print(mgr.status())
        elif args.cmd == "start":
            _print(mgr.start(args.lab, args.replace, _emit_cli))
        elif args.cmd == "stop":
            _print(mgr.stop(args.lab, _emit_cli))
        elif args.cmd == "stop-all":
            _print(mgr.stop_all(_emit_cli))
        elif args.cmd == "extend":
            _print(mgr.extend(args.lab, args.hours))
        elif args.cmd == "purge":
            _print(mgr.purge())
        return 0
    except LabError as exc:
        print(json.dumps({"error": exc.to_dict()}, indent=2), file=sys.stderr)
        return 1
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
