# Running pi-ui remotely

pi-ui is already a client/server system: the browser holds no state, everything lives in
the pi-ui server, which runs [`pi`](https://pi.dev) in-process. So "remote pi" is just
**pi-ui's own server, run on another machine**, reached from a phone or a second computer
over HTTPS. No new protocol, no separate agent to deploy.

```
 Web browser ─────────┐
  (desktop or phone,  │  HTTPS (one origin; token cookie or Bearer)
  installable as a ───┤  • POST /…      client → server (prompts, actions, dialog answers)
  PWA — see below)     │  • GET  /stream  SSE server → client (all live UI)
                       ▼
      ┌──────────── TLS + network gate ─────────────┐
      │ Tailscale (recommended) │ CF Tunnel+Access │ Caddy+LE │
      └──────────────────────┬──────────────────────┘
                              │ plain HTTP, loopback / tailnet only
 ┌────────────────────────────▼──── remote host (VPS / home server / spare laptop) ─┐
 │ pi-ui server (this repo's Bun server, `--remote`, systemd or Docker)             │
 │   auth gate → REST routes + /stream (SSE) → your browser/PWA client             │
 │   pi SDK in-process: sessions, tools (bash, fs, git), provider calls             │
 │ Disk: ~/.pi/agent/{sessions/*.jsonl, auth.json, settings.json, extensions/},     │
 │       ~/.config/pi-ui/config.json, your repo checkout(s)                        │
 └───────────────────────────────────────────────────────────────────────────────┘
```

Read the security section before you expose anything: **pi-ui is remote shell by
design.** This guide is the deployment half of that trade-off; it does not change it.

## Choosing a host

|                     | Linux VPS (recommended)                                       | Home server / spare laptop                           |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| Uptime              | Always on                                                     | Sleeps, reboots, ISP outages                         |
| Blast radius        | Separate from your daily machine                              | Your own files and credentials sit next to the agent |
| Latency to LLM APIs | Low (datacenter)                                              | Your home ISP                                        |
| Cost                | Roughly the price of a small VPS (2–4 vCPU, 4–8 GB is plenty) | Hardware you already own                             |

Either way you need: a recent Linux (or macOS) install, `git`, and either the standalone
`pi-ui` binary or Bun 1.4+ to run it from the npm package.

## Network exposure — pick one

Best first. All three keep pi-ui itself listening on plain HTTP, on loopback or a private
interface — never bind it directly to the public internet.

### Tailscale (recommended)

Reaches only your own devices; nothing is exposed to the public internet, and you get a
real TLS certificate for free via MagicDNS.

```sh
# on the host, once pi-ui is installed (see "Installing" below)
sudo tailscale up
tailscale serve --bg 31415
```

`tailscale serve` prints the `https://<host>.<tailnet>.ts.net` URL it's now proxying to
`127.0.0.1:31415` — open that from your phone or laptop's Tailscale app. No pi-ui
configuration needed beyond `--host 127.0.0.1` (the default) with an `--auth-token` (see
"Installing"); Tailscale is the network gate, the token is the second layer.

### Cloudflare Tunnel + Access

A public URL behind an identity check (Google/GitHub/email OTP) in front of pi-ui's own
token — two layers before anyone reaches the app. `cloudflared` connects _out_ from the
host, so no inbound port needs to be open.

```sh
cloudflared tunnel create pi-ui
cloudflared tunnel route dns pi-ui pi-ui.yourdomain.com
```

In the tunnel's `ingress` config, point the hostname at `http://127.0.0.1:31415` and set
`noTLSVerify` as needed for your setup. **Turn off buffering and caching for `/stream`** in
your Cloudflare Access application settings (Cache Rules → bypass cache for
`/stream`) — pi-ui's 20s SSE heartbeat is well inside Cloudflare's own idle timeout, but a
buffered or cached response means the browser sees nothing until it's stale.

### Caddy + Let's Encrypt, public

Only if the other two aren't an option for you — a public reverse proxy needs real
hardening (fail2ban, rate limiting) on top of pi-ui's own token and CSRF checks. See
[`deploy/Caddyfile.example`](../deploy/Caddyfile.example): point it at your domain and
`127.0.0.1:31415`, run `caddy run --config deploy/Caddyfile.example`. The
`flush_interval -1` line in that file is required — without it Caddy buffers `/stream` and
nothing streams.

## Installing

### systemd (recommended for a VPS)

Install pi-ui (see the main [README](../README.md) "install"), then, over SSH (no desktop
session — pi-ui detects this and installs a **user** unit that starts at boot instead of
at login, so it survives you disconnecting):

```sh
pi-ui service install --remote --auth-token "$(openssl rand -hex 32)"
```

This does three things: writes `~/.config/systemd/user/pi-ui.service` with
`WantedBy=default.target` (not `graphical-session.target` — there's no desktop to wait
for), persists `--host`/`--port`/`--remote`/`--auth-token` to a **0600**
`~/.config/pi-ui/pi-ui.env` referenced by the unit's `EnvironmentFile=` (never on the
`ExecStart` line, which any local user on the box can read via `ps`), and starts it. It
also prints the one thing a headless install can't do for you:

```sh
loginctl enable-linger $USER
```

Without lingering, systemd still stops your user's services when your SSH session ends —
this keeps pi-ui running after you log out. `pi-ui service install` accepts the same flags
as the server itself (`--host`, `--port`, `--remote`, `--auth-token`, `--insecure-no-auth`,
`--workspace`; `--headless` forces headless detection if the installing shell happens to
have a `$DISPLAY`, e.g. installing over an X-forwarded SSH session). Like the server, it
refuses a remote-mode service with neither `--auth-token` nor `--insecure-no-auth`.

```sh
pi-ui service uninstall   # stops it and removes the unit + env file
```

Prefer a system-wide service, independent of any login (its own `pi-ui` system user)?
See [`deploy/pi-ui.service.example`](../deploy/pi-ui.service.example) instead — you manage
its env file and updates yourself rather than through `pi-ui service install`.

### Workspace

pi-ui ignores the unit's `WorkingDirectory=` — its workspace (what the Files view browses,
and where a fresh session starts) always defaults to whoever runs it's home directory. For
the systemd install above, that's the whole home directory of the account you installed it
as, `~/pi-ui-remote/token` and all, not just your git checkout(s).

Two ways to narrow that:

- **Recommended: give pi-ui its own dedicated user**, so "the whole home directory" is
  nothing more than pi-ui's own workspace and agent data to begin with — the same "one
  pi-ui per user" boundary the [security](#security) section already asks for, just
  applied to the service account too.
- **Or pass `--workspace <path>`** (env `PI_UI_WORKSPACE`) to point it at a specific
  directory without creating a separate user:

    ```sh
    pi-ui service install --remote --auth-token "$(openssl rand -hex 32)" \
      --workspace ~/projects
    ```

    `pi-ui service install` persists it to the same 0600 env file as the other options.

### Docker

See [`deploy/Dockerfile`](../deploy/Dockerfile) for the full image (git + fd + ripgrep on
top of the compiled binary) and usage. Short version:

```sh
docker build -f deploy/Dockerfile -t pi-ui .
docker run -d --name pi-ui --restart unless-stopped \
  -p 31415:31415 \
  -e PI_UI_AUTH_TOKEN="$(openssl rand -hex 32)" \
  -v pi-ui-agent:/root/.pi \
  -v pi-ui-workspace:/workspace \
  pi-ui
```

Building the image on a non-Linux dev machine works too:
[`scripts/build.ts`](../scripts/build.ts) accepts `--target=bun-linux-x64` (or
`bun-linux-arm64`) to cross-compile the Linux executable the image copies in, without
needing a Linux build host.

### Provider login on a headless host

pi-ui's login dialog already shows the provider's URL or device code to the _client_, and
a paste-code input for flows that need one — this already works headless. What doesn't
work is the server trying to open a browser on itself; there's nothing there to open. In
`--remote` mode pi-ui skips that automatically. If your provider's flow is still awkward
over a device code, the simpler path is to copy credentials from a machine where you've
already logged in:

```sh
scp ~/.pi/agent/auth.json your-vps:~/.pi/agent/auth.json
```

or set the provider's API key as an environment variable in the same env file
(`~/.config/pi-ui/pi-ui.env` for the systemd install, `-e` for Docker).

## Persistence and backups

| Data                     | Location                                  | Back it up?                         |
| ------------------------ | ----------------------------------------- | ----------------------------------- |
| Sessions (append-only)   | `~/.pi/agent/sessions/**.jsonl`           | Yes — cheap with `restic`/`rsync`   |
| Credentials              | `~/.pi/agent/auth.json`                   | Yes, encrypted                      |
| pi settings & extensions | `~/.pi/agent/{settings.json,extensions/}` | Keep them in git if you can         |
| pi-ui config             | `~/.config/pi-ui/config.json`             | Optional                            |
| Workspace(s)             | your git checkout(s)                      | Their own remotes                   |
| Pasted images            | in-memory only                            | Lost on restart — not yet persisted |

A crashed process can leave behind a stale `pi-ui-transfers-*` temp directory (in-flight
file uploads); pi-ui removes its own on the next start.

## Security

**This is remote shell by design.** pi runs bash and writes files as the service user, and
asks for no approval — watching, trust and review do not create a security boundary. **A
leaked auth token is a full shell on the host.** The network gate above (Tailscale,
Cloudflare Access, or a hardened public proxy) is the real control; pi-ui's own token is
the second layer, not the first.

What pi-ui does for you:

- **Refuses to start** in `--remote` mode (or any non-loopback `--host`) without
  `--auth-token`/`PI_UI_AUTH_TOKEN`, unless you explicitly pass `--insecure-no-auth` — a
  loud warning either way.
- Sets the auth cookie `Secure` behind TLS (detected via the request or
  `X-Forwarded-Proto`), `HttpOnly`, `SameSite=Lax`.
- Strips `?token=` from the address bar once the cookie is set, so it never sits in
  browser history or gets shared in a copy-pasted link.
- Checks `Origin` against `Host` on cookie-authenticated writes (CSRF).
- Rate-limits failed auth attempts per client IP: after 10 wrong tokens in 5 minutes that
  IP gets `429` for every credential it sends, the right one included, until the window
  passes (a correct token would otherwise tell a guesser it had won).

**Trusted proxy behaviour for the rate limit.** pi-ui only trusts `X-Forwarded-For` from a
loopback peer (your reverse proxy, on the same host) — a non-loopback peer's own
`X-Forwarded-For` is always ignored, since anyone on the network could send one. When it
does trust the header, it reads the **last** hop, not the first, because a proxy can
handle the header two different ways:

- **Replaces it** with a single real hop (Caddy's default, and this doc's recipe): first
  and last hop are the same IP, so either choice works.
- **Appends** to whatever the client already sent (e.g. nginx's default
  `$proxy_add_x_forwarded_for`): the client's own, spoofable hops are still in the
  header. Trusting the _first_ hop there would let a client pick its own rate-limit
  bucket at will by sending its own `X-Forwarded-For`; the _last_ hop — the one your
  proxy itself appended — is the one that actually can't be forged.

If you put a different reverse proxy in front of pi-ui, confirm it either replaces
`X-Forwarded-For` outright or appends the real peer address as the last hop, and never
forwards an untouched client-supplied header as the only (and therefore last) one.

What you're responsible for:

- **One pi-ui per user.** Don't share a single server between people — there is one
  workspace, one set of credentials, one shell. Run a separate instance (or container) per
  person.
- **Don't run the `pi` CLI on the same session pi-ui has open.** Both write the session's
  JSONL file without a lock; one writer at a time.
- Treat `~/.pi/agent/auth.json` like any other credential file in your backups.
- Rotate the auth token if you ever suspect it leaked (`pi-ui service install
--auth-token <new token> ...` again, or edit the env file and restart).

## Multi-client behaviour

Every client connected to the same pi-ui server sees the same mirrored view — that's
intended, it's one person's workspace open on two screens, not two independent sessions.
Two things to know:

- **Dialog answers**: whichever client answers first wins; the other's answer is silently
  discarded (a small "answered on another device" notice appears there instead).
- **Terminal-surface width** (extension `custom()` overlays): the narrowest connected
  client sets it, so opening pi-ui on your phone while your desktop has one open will
  narrow the desktop's view too.

## Install as an app (PWA)

pi-ui is a web app on purpose — no separate Android app, no app store. Every browser
below can install it as a standalone app instead: same origin, same cookie, same
`/stream`, just its own window/icon and no address bar.

- **Android Chrome.** Open your pi-ui URL, then menu (⋮) → **Install app** (or Chrome
  offers it itself after a visit or two). It gets a home-screen icon and its own task in
  the app switcher.
- **Desktop Chrome or Edge.** The address bar shows an install icon; or menu → **Install
  pi-ui…**. It opens as a normal windowed app.
- **iOS/iPadOS Safari.** Share icon → **Add to Home Screen**. Safari does not show a
  browser-native install prompt for this the way Chrome does, but the result is the same
  kind of standalone app.

### Push notifications

The "Notify on completion" bell (in the Live Workspace pane) covers two cases:

- **A tab is open** (foreground or a hidden background tab): you get a normal in-page Web
  Notification, same as running locally.
- **No tab is open at all** — the installed PWA is closed, or you never opened one: a
  background session finishing instead sends a **Web Push** notification, which opens or
  focuses the app when tapped. This only ever fires when no tab is connected, so you never
  get the same notification twice.

Requirements:

- Push only activates in remote mode; running locally never registers a push
  subscription (there'd be nothing useful to reach).
- **iOS/iPadOS**: Safari only delivers Web Push to an **installed** PWA (Add to Home
  Screen first) — it does not support push for an ordinary browser tab.
- Grant the browser's notification permission when the bell toggle asks for it (a
  permission prompt only ever appears from that click, never on page load).
- The subscription is tied to that browser/device; installing on a second device (or
  reinstalling) registers its own subscription, so completions reach every device you've
  opted in on.

Nothing here is cached for offline use — pi-ui always needs a live connection to its
server. If the connection drops, the installed app shows a small "Can't reach your pi-ui
server" page instead of the browser's own offline error, and retries automatically.
