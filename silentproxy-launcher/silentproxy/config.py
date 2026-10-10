"""Central configuration. Environment overrides exist for development only."""
from __future__ import annotations

import os
import re

HOST_NAME = "com.operationsilentproxy.launcher"
HOST_DESCRIPTION = "Operation Silent Proxy lab launcher"

# Where the lab catalogue lives. ADJUST to the real org/repo before releasing.
REGISTRY_URL = (
    "https://raw.githubusercontent.com/Cybersecurity-CTF-Org/"
    "operation-silent-proxy/main/labs.json"
)
# Lab archives and the registry may only come from here (https only).
ALLOWED_URL_PREFIXES = (
    "https://github.com/Cybersecurity-CTF-Org/",
    "https://raw.githubusercontent.com/Cybersecurity-CTF-Org/",
)
# Hosts a GitHub download may redirect through.
ALLOWED_REDIRECT_SUFFIXES = (".githubusercontent.com", "github.com")

# Extension identities allowed to talk to this host (set at install time).
FIREFOX_EXTENSION_ID = "silentproxy-launcher@operationsilentproxy.local"

LAB_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")

MAX_MESSAGE_IN = 1024 * 1024          # bytes accepted from the browser
MAX_MESSAGE_OUT = 1024 * 1024         # Chrome's limit for host -> browser
MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024
MAX_EXTRACT_BYTES = 400 * 1024 * 1024
MAX_EXTRACT_FILES = 5000
MAX_RATIO = 200                       # per-file zip-bomb guard

DEFAULT_TTL_HOURS = 6.0
MAX_TTL_HOURS = 12.0
MAX_RUNNING_LABS = 1
UP_TIMEOUT_S = 900                    # first image pull can be slow
READY_TIMEOUT_S = 90
DOWN_TIMEOUT_S = 120

ALLOWED_CAPS = {"NET_BIND_SERVICE", "CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"}
DEFAULT_MEM_LIMIT = "768m"
DEFAULT_CPUS = 1.0
DEFAULT_PIDS_LIMIT = 512


def dev_mode() -> bool:
    return os.environ.get("SILENTPROXY_DEV") == "1"


def registry_location() -> str:
    return os.environ.get("SILENTPROXY_REGISTRY", REGISTRY_URL) if dev_mode() else REGISTRY_URL


def docker_override() -> str | None:
    return os.environ.get("SILENTPROXY_DOCKER_BIN") if dev_mode() else None
