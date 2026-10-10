#!/usr/bin/env python3
"""A stand-in for the docker CLI so the launcher can be tested without Docker.

It understands just enough of: version, compose version, compose config/up/ps/down.
The lab's compose file is JSON (valid YAML) already in `compose config` normalised form.
State lives in $FAKE_DOCKER_STATE.
"""
import json
import os
import sys

state = os.environ["FAKE_DOCKER_STATE"]
args = sys.argv[1:]
mode = os.environ.get("FAKE_DOCKER_MODE", "")

if args[:1] == ["version"]:
    print("27.0.0")
elif args[:2] == ["compose", "version"]:
    print("v2.29.1")
elif args[:1] == ["compose"]:
    project, files, sub = None, [], None
    i = 1
    while i < len(args):
        a = args[i]
        if a == "-p":
            project = args[i + 1]; i += 2; continue
        if a == "-f":
            files.append(args[i + 1]); i += 2; continue
        if a in ("--project-directory", "--progress"):
            i += 2; continue
        if a in ("config", "up", "ps", "down") and sub is None:
            sub = a
        i += 1
    marker = os.path.join(state, f"{project}.up")
    if sub == "config":
        with open(files[0]) as fh:
            print(fh.read())
    elif sub == "up":
        if mode == "up-fails":
            print("Error response from daemon: boom", file=sys.stderr)
            sys.exit(1)
        for line in ("Container demo-web-1  Creating", "Container demo-web-1  Started"):
            print(line, file=sys.stderr)
        open(marker, "w").write("up")
    elif sub == "ps":
        if os.path.exists(marker):
            print(json.dumps([{"Service": "web", "State": "running", "Health": ""}]))
    elif sub == "down":
        if os.path.exists(marker):
            os.remove(marker)
else:
    sys.exit(127)
