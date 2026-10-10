# silentproxy-launcher

The **[App]** in Operation Silent Proxy's *Website → Extension → App* chain.

A browser extension asks this program (over *native messaging*) to start a mission's lab.
The program downloads the lab from GitHub, verifies it, checks it against a safety policy, runs it with
Docker Compose on `127.0.0.1`, reports progress, and shuts it down again (Stop button or automatic TTL).

```
Website (GitHub Pages)  ──click──▶  Extension  ──native messaging──▶  silentproxy (this app)
                                                                        │ labs.json  (catalogue, pinned URL)
                                                                        │ GitHub Release zip (sha256-checked)
                                                                        └ docker compose up  → 127.0.0.1:<ports>
```

Pure Python standard library (3.9+), no runtime dependencies.

## Install (player)

Kali's default browser is **Firefox**, so Firefox is first-class.

```bash
# from a release binary
./silentproxy-linux install                        # Firefox
./silentproxy-linux install --chrome-id <EXT_ID>   # + Chrome/Chromium/Edge/Brave
./silentproxy-linux doctor                         # checks Docker + Compose v2.17+

# or from source
python -m silentproxy install
```

`install` copies the app to a stable per-user folder and writes the native-messaging manifest
(Linux/macOS: files in each browser's `NativeMessagingHosts` dir; Windows: HKCU registry keys).
No admin rights. `silentproxy uninstall` removes it. Manifests only allow *your* extension ID
(`allowed_extensions` / `allowed_origins`), so other extensions cannot drive the app.

Docker on Linux needs your user in the `docker` group; the app detects this and returns a fix-it hint.

## CLI (also the easiest way to test without the extension)

```
silentproxy doctor | list | status
silentproxy start <lab> [--replace]      stop <lab>      stop-all      extend <lab> <hours>      purge
```

## Native messaging protocol (v1)

Framing is the browser standard: 4-byte native-endian length + UTF-8 JSON. One persistent port
(`connectNative`) is recommended so progress can stream. Every request carries your own `id`.

| action | extra fields | result `data` |
|---|---|---|
| `ping` | – | `{version, protocol, platform}` (cheap; use to detect the app is installed) |
| `doctor` | – | `{docker_installed, daemon_running, compose_ok, error?{code,message,hint}}` |
| `list` | – | `{labs:[{id,title,version,size,installed,running,ports:[{name,url}]}], registry:{stale,...}}` |
| `start` | `lab`, `replace?` | `{lab,status,ready,urls:[{name,url}],expires_at,expires_in,already_running?,pending_ports?}` |
| `stop` / `stop_all` | `lab` | `{stopped:true}` |
| `status` | – | `{labs:[{lab,status,services:[{service,state,health}],expires_in,urls}]}` |
| `extend` | `lab`, `hours` (0.25–12) | updated lab status |

Progress events while `start` runs: `{"id","type":"progress","stage","message","percent?"}` with stages
`registry, docker, cached|download, verify, extract, validate, starting, docker (log lines), waiting, ready`.
Final reply: `{"id","type":"result","ok":true,"data":…}` or `{"ok":false,"error":{"code","message","hint?"}}`.

Error codes: `DOCKER_NOT_FOUND, DOCKER_NOT_RUNNING, DOCKER_PERMISSION, COMPOSE_MISSING, REGISTRY_UNREACHABLE,
REGISTRY_INVALID, LAB_UNKNOWN, OTHER_LAB_RUNNING (extra: running[]), LAB_BUSY, URL_NOT_ALLOWED, NETWORK,
DOWNLOAD_FAILED, DOWNLOAD_TOO_LARGE, CHECKSUM_MISMATCH, ARCHIVE_UNSAFE, UNSAFE_LAB (extra: problems[]),
PORT_IN_USE, START_FAILED, STOP_FAILED, TIMEOUT, NOT_RUNNING, BAD_REQUEST, INTERNAL`.

## Security model

The app executes code fetched from the internet on a player's machine, so it is deliberately narrow:

- **Lab IDs only.** The browser can never send a URL, path, or command. IDs must match `^[a-z0-9][a-z0-9-]{1,47}$`
  and exist in the catalogue.
- **Pinned sources.** The catalogue and lab zips must come from `https://github.com/Cybersecurity-CTF-Org/…`
  (see `config.py`); every redirect hop is re-checked against GitHub hosts.
- **Integrity.** Each zip is checked against the SHA-256 and size in `labs.json` before anything is unpacked.
- **Safe unpacking.** No path traversal, absolute paths, symlinks, special files, zip bombs, or too many files.
- **Compose policy** (`policy.py`) runs on the normalised `docker compose config` output and refuses: privileged,
  host network/pid/ipc, extra capabilities, devices, unconfined profiles, ports not bound to `127.0.0.1`,
  ports not declared in the catalogue, bind mounts outside the lab folder (incl. `docker.sock`), outside/remote
  build contexts, external networks/volumes, device-backed volumes.
- **Resource caps** are added to every service (memory, CPU, pids, `no-new-privileges`) via a generated override file.
- **One lab at a time**, labs auto-stop after their TTL via a *detached reaper process*, so cleanup never depends on
  the browser or extension staying alive.
- stdout carries only protocol frames; logs go to `…/SilentProxy/logs/launcher.log`.

Not covered: the catalogue is trusted as far as the GitHub account/repo that hosts it is (protect it with 2FA and
branch protection). Signing `labs.json` would be the next hardening step.

## Publishing a lab

Lab folders must satisfy the policy above. Minimum rules for `docker-compose.yml`:

```yaml
ports: ["127.0.0.1:8081:80"]      # always 127.0.0.1, and 8081 must be listed in labs.json
```

```bash
python tools/package_lab.py labs/mission-1-recon --id mission-1-recon --version 1.0.0 \
  --base-url https://github.com/Cybersecurity-CTF-Org/operation-silent-proxy/releases/download/mission-1-recon-v1.0.0 \
  --title "Mission 1: Setup & Recon" --port "MegaCorp portal:8081" --validate
```

This builds a deterministic zip in `dist/`, computes the checksum, and updates `labs.json`. Upload the zip to that
GitHub Release, then commit `labs.json`. `--validate` runs the same policy locally (needs Docker).
Hostnames such as `portal.megacorp.local` are intentionally not added to `/etc/hosts` by the app: Mission 1 teaches
players to do that with Burp's hostname-resolution setting.

## Develop & test

```bash
python -m unittest discover -s tests -t .      # 37 tests, no Docker needed (tests use tests/fake_docker.py)
```

`SILENTPROXY_DEV=1` (development only) enables `SILENTPROXY_REGISTRY` (file path/URL), `SILENTPROXY_DOCKER_BIN`,
and non-GitHub download hosts. `SILENTPROXY_HOME` relocates the data directory and works in any mode.

Before first release, edit `REGISTRY_URL` / `ALLOWED_URL_PREFIXES` in `silentproxy/config.py` to the real repo, and set
the extension IDs when running `install`. Tag `vX.Y.Z` to build Linux/macOS/Windows binaries via
`.github/workflows/release.yml`.

## Layout

```
silentproxy/  cli · host (message loop) · protocol · manager (lifecycle) · registry · net · archive
              policy · docker · state · reaper · install · config
tools/package_lab.py     build lab zip + update labs.json
tests/                   unit tests, manager tests, end-to-end test of the real host process
examples/demo-lab/       nginx lab for smoke-testing with real Docker
```
