# Operation Silent Proxy

You are an external red teamer hired to investigate **MegaCorp**, a fictional fintech company. A whistleblower has hidden flags across its infrastructure, and you recover them using **Burp Suite Community Edition only**.

## How it works

1. **Install the launcher and the browser extension** (the setup checklist on this page walks you through it).
2. Press **Start lab** on a mission. The launcher downloads that mission from GitHub, checks it, and starts it with Docker on your own machine.
3. Open Burp, route your browser through its proxy, and attack the lab at the `127.0.0.1` addresses shown on this page.
4. When you finish, press **Stop lab**. Labs also shut themselves down after a few hours.

> Every lab listens on `127.0.0.1` only. Nothing is attacked over the internet, and nobody else can reach your lab.

## Missions

| Mission | Focus | Flags |
| --- | --- | --- |
| 1. Setup & Recon | Burp configuration: CA cert, listeners, client certs, SOCKS, NTLM, HTTP/2 | 8 |
| 2. Interception & History | Intercepting, filtering, match and replace, WebSockets | 6 |
| 3. Repeater & Inspector | Chained requests, race conditions, request smuggling | 6 |
| 4. Intruder Mastery | Throttle-aware brute forcing | 5 |
| 5. Sequencer, Decoder, Comparer & Sessions | Token prediction, decoding chains, macros | 5 |
| 6. Client-Side, Extensions & Finale | DOM Invader, Clickbandit, JWT forging, the CEO's secret | 6 |

## Rules

- Use **Burp Suite Community Edition** as your only attack tool. The challenges are designed so that this is the practical way through.
- Burp Community cannot save projects. Closing Burp loses your history, so finish a mission's flags before you quit.
- Missions run one at a time. Starting another mission asks whether to stop the current one.

## Tips

- Mission 1 teaches the Burp settings that every later mission relies on. Do not skip it.
- Add a **hostname resolution** entry in Burp for names like `portal.megacorp.local` instead of editing your hosts file.
- If a port is busy, stop whatever is using it (another lab or a Burp listener) and start the mission again.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Launcher not installed" | Download the launcher from this page and run its `install` command, then press **Check again**. |
| "Docker is not running" | Start Docker (`sudo systemctl start docker` on Linux), then press **Check again**. |
| "No permission to use Docker" | Run `sudo usermod -aG docker $USER`, log out and back in. |
| Mission will not start | Open the launcher log (`launcher.log` in the SilentProxy data folder) and open an issue with the error code. |
