# Flag Forge website

Your original pages (`index.html`, `jr-pentest.html`, `style.css`) with one new page type: **`challenge.html?c=<slug>`**.
Every challenge card opens it, and it shows the lab description, README, contributors with photos, a **Start lab** button
for each mission, and a **Download launcher** button that links to GitHub.

```
index.html ──▶ jr-pentest.html ──▶ challenge.html?c=burp-suite
                                    ├─ Launch the lab   (setup checklist + Start/Stop per mission)
                                    ├─ About this lab   (from data/challenges.json)
                                    ├─ README           (challenges/<slug>/README.md, rendered safely)
                                    ├─ Contributors     (photos, roles, GitHub links)
                                    └─ sidebar          (launcher downloads per OS, extension links)
```

## Run it locally

```bash
python3 -m http.server 8000      # then open http://localhost:8000/
```

(Opening the files straight from disk will not work: the page loads its data with `fetch`.)
To test the lab buttons locally, build the extension with `--dev-site http://localhost:8000/` (see `silentproxy-extension`).

## Publish on GitHub Pages

1. Push this folder to a GitHub repo and enable *Settings → Pages → Deploy from branch*.
2. Build the extension for that exact address, for example
   `python3 tools/build.py --site https://<org>.github.io/<repo>/` in `silentproxy-extension`.
   The extension only works on the site address it was built for.
3. Edit `js/config.js`: the GitHub org/repo of the launcher releases, the extension store links, and `chromeId`
   (printed by `tools/make_key.py`). `chromeId` fills in the Chrome install command shown to players.

## Add or edit things

| I want to… | Do this |
|---|---|
| Add a challenge | Add an entry to `data/challenges.json`, create `challenges/<slug>/README.md`, add a card in `jr-pentest.html` linking to `challenge.html?c=<slug>`. |
| Make a challenge playable | Set `"status": "live"` and list its `labs`. Each lab `id` must match an id in the launcher's `labs.json` (`mission-1-recon`, …). |
| Add a contributor | Add `{ "name", "role", "github", "photo" }` under that challenge's `contributors`. Put the photo in `assets/contributors/` and use that path, or leave `photo` empty to use their GitHub avatar, or leave both empty for initials. |
| Change the README | Edit `challenges/<slug>/README.md` (Markdown: headings, lists, tables, code blocks, links, images). |

Contributors in the data file: only Srinish Basu is listed for the Burp challenge so far. Add the others with the same shape.

## How the Start button works

The page includes `js/silentproxy-client.js` (the same file as in the extension project). On load it checks three things:
**extension installed**, **launcher app installed**, **Docker ready**, and shows what is missing with the fix.
Press *Check again* (or just come back to the tab) after installing something. **Start lab** then downloads and runs the mission
through the launcher, shows progress, and lists the `127.0.0.1` links, a countdown, **+1 hour** and **Stop lab**.
Only one lab runs at a time; starting another one asks first.

## Security notes

- A Content-Security-Policy on every page allows only this site's own scripts and styles (no inline code, no remote scripts).
  Images may come from this site and from GitHub (contributor avatars).
- Text from `challenges.json` and READMEs is always inserted as plain text. The README renderer ignores raw HTML and only keeps
  `https` and relative links.
- Lab links are only clickable for `127.0.0.1` / `localhost`.

## Tests

```bash
npm test      # 37 tests: README renderer and XSS cases, lab controller logic, page rendering, link/CSP checks
```

They run on a small fake DOM, so no browser is needed. **Not verified:** the pages have not been opened in a real browser, so
check the layout once on desktop and phone, and try the full flow with the real extension and launcher.
