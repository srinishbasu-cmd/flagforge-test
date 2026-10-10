# silentproxy-extension

The **[Extension]** in Operation Silent Proxy's *Website → Extension → App* chain (Chrome/Edge/Brave and Firefox, Manifest V3).
It lets the website start a lab on the player's machine by relaying requests to the
[`silentproxy-launcher`](../silentproxy-launcher) native app, and gives players a popup to see/stop/extend their lab.

```
website JS ──SilentProxy SDK──▶ content script ──▶ background ──native messaging──▶ launcher app ──▶ Docker
 (postMessage, same origin)     (only on your site)  (validates, routes)
```

## Files

| path | role |
|---|---|
| `src/background.js` | only component that talks to the launcher; validates senders and requests, routes replies/progress, badge + polling alarm, error mapping |
| `src/content.js` | injected **only** on your website; postMessage ⇄ background, checks origin/source/namespace |
| `src/common.js` | shared request validation (action + field whitelist, lab-id regex) and disconnect→error mapping |
| `src/popup.*` | status, Start/Stop/+1 hour, Docker warnings, "launcher missing" help (renders with `textContent` only) |
| `sdk/silentproxy-client.js` | the 100-line script your website includes |
| `tools/build.py` | builds `dist/chrome` + `dist/firefox` (+ zips) for a given website URL |
| `tools/make_key.py` | makes the Chrome signing key so the extension ID is stable, prints the ID |
| `test/` | 31 Node tests (no browser, no npm packages) |

## Build

```bash
python3 tools/make_key.py            # once. Prints the Chrome extension ID; keep keys/chrome-key.pem private
python3 tools/build.py --site https://cybersecurity-ctf-org.github.io/operation-silent-proxy/
# local testing build (adds localhost as an allowed site - never ship this one):
python3 tools/build.py --site https://cybersecurity-ctf-org.github.io/operation-silent-proxy/ --dev-site http://localhost:8000/
```

`--site` is the URL prefix of your GitHub Pages site (must end with `/`). Only pages under that prefix get the content script,
and the background re-checks the full URL before accepting any request. **Change the default in `tools/build.py` if the real repo name differs.**

## Install for testing

**Chrome / Edge / Brave:** `chrome://extensions` → Developer mode → *Load unpacked* → `dist/chrome`.
Then register the launcher for this extension's ID:

```bash
silentproxy install --chrome-id <ID printed by make_key.py>
```

**Firefox (Kali's default):** `about:debugging` → *This Firefox* → *Load Temporary Add-on* → `dist/firefox/manifest.json`
(removed on restart). The launcher's default `silentproxy install` already trusts the Firefox ID
`silentproxy-launcher@operationsilentproxy.local` (kept in sync in `tools/build.py` and the launcher's `config.py`).

For players you need a signed build: Firefox → submit `dist/silentproxy-extension-firefox-*.zip` to addons.mozilla.org as
**unlisted** (free, automated signing); Chrome → the Web Store ($5 one-time developer fee) or have players load unpacked.

## Use from the website

```html
<script src="silentproxy-client.js"></script>
<script>
  const state = await SilentProxy.detect();
  // {extension:false}                     -> show "install the extension"
  // {extension:true, host:false, error}   -> show error.message + error.hint (install the launcher app)
  // {extension:true, host:true}           -> ready
  try {
    const lab = await SilentProxy.start('mission-1-recon', { onProgress: p => status.textContent = p.message });
    // lab.urls = [{name, url}], lab.expires_in (seconds), lab.ready
  } catch (e) {
    if (e.code === 'OTHER_LAB_RUNNING') { /* ask, then SilentProxy.start(id, {replace:true}) */ }
    else show(e.message, e.hint);
  }
</script>
```

API: `detect() list() doctor() status() start(id,{replace,onProgress}) stop(id) stopAll() extend(id,hours)`.
Errors are `SilentProxyError` with `code`/`message`/`hint`: the launcher's codes (see its README) plus `HOST_NOT_INSTALLED`,
`HOST_FORBIDDEN` (extension ID not registered with the launcher), `HOST_CRASHED`, `HOST_DISCONNECTED`, `EXT_DISCONNECTED`,
`EXT_NOT_RESPONDING`, `BAD_REQUEST`. `examples/test-page.html` exercises everything with buttons.

## Security notes

- Pages can only send the 8 whitelisted actions with strictly validated fields (lab ids `^[a-z0-9][a-z0-9-]{1,47}$`);
  unknown fields are dropped. No URLs, paths or commands ever cross the bridge.
- Content script only runs on `--site`; messages must come from the same window and origin and carry the `silentproxy.v1` envelope.
- Background accepts connections only from the extension's own pages or URLs under the allowed prefix (lookalikes such as
  `…/silent-evil/` are rejected - tested).
- The launcher independently restricts who may talk to it (`allowed_origins` / `allowed_extensions`) and what it will run.
- Permissions: `nativeMessaging`, `alarms`. No host permissions, no remote code, no network access of its own.

## Tests

```bash
npm test     # 31 tests: validation, background routing, bridge/SDK, popup (fake DOM), and the full chain
```

The last test spawns the **real Python launcher** (with its fake-Docker test double) and drives it through SDK → content script →
background. It needs the launcher checkout next to this folder, or `LAUNCHER_DIR=/path/to/silentproxy-launcher npm test`.

**Not tested:** the extension has not been loaded into a real Chrome or Firefox. Browser-specific behaviour (service-worker/event-page
lifetime while a native port is open, Firefox manifest keys such as `data_collection_permissions`, match-pattern handling for localhost)
should be checked once manually, and `npx web-ext lint --source-dir dist/firefox` is run in CI for the Firefox package.
