# ☁️ cf-tunnel-panel · publish your private services to the internet, safely

> 🌐 **Language / 语言**：**English (current)** · [简体中文](README.zh-CN.md)

> One sentence: a web panel that wires **cloudflared tunnels** + **Caddy reverse proxy** together,
> so a private service at home becomes `https://your-domain/some-path` — **no public IP, no router
> changes, no open ports**. Multiple tunnels can run at the same time (quick + named, or several
> accounts and domains).

- Version: **v0.9.0**
- Works with: NAS, self-hosted sites, Home Assistant, Jellyfin, Gitea, Immich, qBittorrent… any HTTP service
- Stack: `node:http` backend (zero dependencies), hand-written frontend (no build step), `Caddy` for routing,
  `cloudflared` for the tunnel — one `docker compose up` and you are done
- License: [MIT](LICENSE)

---

## Table of contents

1. [What it actually does](#1-what-it-actually-does)
2. [The three containers](#2-the-three-containers)
3. [Quick start (5 minutes)](#3-quick-start-5-minutes)
4. [First run: 3 steps to a working site](#4-first-run-3-steps-to-a-working-site)
5. [Tunnels: quick, named, and many](#5-tunnels-quick-named-and-many)
6. [Rules in detail](#6-rules-in-detail)
7. [Toolbox](#7-toolbox)
8. [Observability](#8-observability)
9. [Security](#9-security)
10. [API](#10-api)
11. [Troubleshooting](#11-troubleshooting)
12. [Project layout & tests](#12-project-layout--tests)
13. [Roadmap](#13-roadmap)

---

## 1. What it actually does

```
                Internet
                   │  https://panel.example.com/jellyfin
                   ▼
        ┌──────────────────────┐
        │  Cloudflare edge     │  DNS + TLS + DDoS shield
        └──────────┬───────────┘
                   │  encrypted outbound tunnel (no inbound port!)
        ┌──────────▼───────────┐
        │  cloudflared         │  there is always exactly ONE upstream per tunnel
        └──────────┬───────────┘
                   │  http://127.0.0.1:8080
        ┌──────────▼───────────┐
        │  Caddy               │  ← this is where routing happens
        └──────────┬───────────┘
        ┌──────────┴───────────┐
        ▼                      ▼
  home-assistant:8123    jellyfin:8096      …rules decide
```

The important bit: **a tunnel carries traffic, it does not know what a "service" is.** Cloudflare lets you
point a hostname at exactly one upstream. So the panel points every tunnel at the local Caddy (`:8080`) and
lets **Caddy rules** decide which path or hostname goes where, with optional auth, IP allow-lists and headers.

## 2. The three containers

| Container | Image | Role | Port |
| --- | --- | --- | --- |
| `cf-tunnel-panel` | built from `Dockerfile` (node:22 + cloudflared binary) | the panel itself, spawns/ babysits cloudflared processes | `8090` |
| `cf-tunnel-caddy` | `caddy:2-alpine` | the data plane: routing, auth, headers, access log | `8080` (+ admin `127.0.0.1:2019`) |
| `cf-tunnel-demo` | `traefik/whoami` | a throwaway upstream so you can see it work immediately | `8091` |

All three use `network_mode: host`, because cloudflared and Caddy must reach services bound to `127.0.0.1`
on the host. Mounts: `./data` (state + backups + Caddy logs), `docker.sock:ro` (container list for one-click
rules), `./caddy.bootstrap.json` (initial Caddy config, replaced at runtime).

### 2.1 Pages

| Page | What's there |
| --- | --- |
| **Overview** | online exits / route count / traffic trend chart / exit online history / live log |
| **Tunnels** | one card per exit: status, public URL, uptime, reconnect count, start/stop/restart/QR/copy/delete |
| **Rules** | routing rules — filter, template, test upstream, reorder, export/import, simulate match |
| **Tools** | Docker containers (one-click rule), share links, self-test, Cloudflare API, speed test |
| **Observe** | access log with filters + live log (pause, errors only, download) |
| **Settings** | site / maintenance / security / notifications / panel login / read-only account / backups / about |

`/legacy` still serves the old single-page UI, in case you ever need it.

> **Interface language:** the panel ships Chinese + English. Click the `EN` / `中` button at the bottom-left to switch; the choice is a cookie (`cfp_lang`) and also drives `<html lang>`.

## 3. Quick start (5 minutes)

### 3.1 Requirements

- Docker + Docker Compose
- A domain on Cloudflare (only for named tunnels; quick tunnels work without one)

### 3.2 Start

```bash
git clone https://github.com/Adam-cell-tech/cf-tunnel-panel.git
cd cf-tunnel-panel
mkdir -p data/caddy-logs
docker compose up -d --build
```

### 3.3 Check three things

```bash
docker compose ps                            # three containers, all Up
curl -s localhost:8090/healthz               # {"ok":true,...}
docker exec cf-tunnel-caddy caddy version    # v2.11.x
```

### 3.4 Updating (read this before you `docker compose up` again)

`docker compose up -d` recreates the container **from the image**. If you edited files in `src/` without
rebuilding, that silently reverts to whatever the image was built with (we hit exactly this: the panel
"downgraded" itself back to v0.5.0). Two safe paths:

```bash
# A) proper: rebuild the image (needs a working registry for the base images)
docker compose build panel && docker compose up -d panel

# B) quick iteration: copy the files in, then restart
docker cp src/server.js cf-tunnel-panel:/app/src/server.js
docker cp src/web/.   cf-tunnel-panel:/app/src/web/
docker cp src/ui.html cf-tunnel-panel:/app/src/ui.html
docker cp package.json cf-tunnel-panel:/app/package.json
docker restart cf-tunnel-panel
```

### 3.5 Open the panel

Browse to `http://<lan-ip>:8090`, e.g. `http://192.168.1.55:8090`.

> Deploying to the public internet? Set a panel password first (Settings → panel login), or use a read-only
> account for whoever only needs to look.

## 4. First run: 3 steps to a working site

**① Start a tunnel.** Tunnels page → a quick tunnel is the fastest: press **Start**, wait ~5 seconds, you get
`https://something-random.trycloudflare.com`. (Quick tunnels have a random hostname per start and are
rate-limited by Cloudflare — fine for a test, not for daily use.)

**② Add a rule.** Rules page → **+ Add rule** → template `Whoami` → path `/demo`, upstream
`http://127.0.0.1:8091` → **Save**.

**③ Visit it.** Open `<your-tunnel-url>/demo` — you should see the `whoami` output, with an `X-Panel-Route`
header added by Caddy.

Any path that matches no rule returns a friendly 404 (a panel-authored page), which is a deliberate default:
probers learn nothing.

## 5. Tunnels: quick, named, and many

### 5.1 Quick tunnel (trycloudflare)

- No domain, no Cloudflare account. Hostname changes on every restart.
- Cloudflare rate-limits creation; the panel detects `429` and backs off exponentially (up to 15 minutes)
  instead of hammering every 5 seconds.

### 5.2 Named tunnel (recommended long-term)

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel → Cloudflared**, give it a name.
2. Copy the **token** (the long `eyJ...` string — not the whole `cloudflared service install ...` command;
   the panel can extract it if you paste the whole command, but the token alone is cleaner).
3. In the panel: Tunnels → edit the exit → mode `named`, paste the token, set the public hostname
   (e.g. `panel.example.com`), save, start.
4. In Cloudflare, on that tunnel: **Routes → Add route → Published application** → subdomain `panel`,
   domain `example.com`, service type **HTTP**, URL `127.0.0.1:8080`.
   *(The service URL must be Caddy, not the panel: `8080`, not `8090`.)*

Notes that save hours:

- The hostname you type in the panel **must equal** the public hostname you created in Cloudflare.
- Public hostnames can only be created in the Cloudflare dashboard. Creating just a DNS CNAME gives
  error `1033` (tunnel not found).
- Several public hostnames can point at the same tunnel — they all land on Caddy, which splits by `Host`.
- An invalid token no longer causes an infinite restart loop: the panel marks the exit `fatal`, shows
  "Token invalid · retries stopped" and waits for you.

### 5.3 Many exits at once

Exits are independent cloudflared processes (up to 8). Useful combinations:

| Scenario | Setup |
| --- | --- |
| Temporary share + stable service | one `quick` exit + one `named` exit |
| Two Cloudflare accounts | one named exit per token |
| Same account, several tunnels | one named exit per tunnel (each needs its own token) |

Each exit has its own log prefix, metrics port and status; the Overview page shows all of them.

### 5.4 One exit, one rule set

Rules have an optional **exit** field:

- **Global** (`""`) — applies to every exit (this is what older rules are).
- **Bound to exit X** — only valid for that exit's hostname. Implemented by pinning the Caddy matcher to the
  exit's public hostname (for quick tunnels: the assigned `*.trycloudflare.com` host).
- If the exit has no hostname yet (not started, or named without hostname), the rule is **not pushed** and
  the panel shows it under "skipped" with the reason.

Restarting a quick tunnel changes its hostname; the panel re-pushes Caddy config automatically so bound rules
follow the new hostname.

## 6. Rules in detail

### 6.1 Common fields (on the card)

| Field | Meaning | Example |
| --- | --- | --- |
| **Path** | prefix match; `*` = wildcard | `/jellyfin`, `/api/*` |
| **Host** | optional; match a Hostname (comma separated) | `panel.example.com` |
| **Upstream** | the service; `http://` optional | `127.0.0.1:8096` |
| **Strip prefix** | remove the rule path before proxying | on for most apps |
| **Note** | free text, shows on the card | `media server` |

### 6.2 Advanced (expand `Advanced`)

| Field | Meaning |
| --- | --- |
| **Exit** | scope the rule to one exit (see §5.4) |
| **Method** | restrict to `GET/POST/...` |
| **IP allow-list** | CIDR list; anything else gets the 404 page (no hint that a service exists) |
| **Basic auth** | user + password, stored as bcrypt hash (export never contains the plaintext) |
| **Timeout** | upstream response timeout (media servers need 300s) |
| **Backup upstream** | failover target when the primary refuses connections |
| **Load balancing** | round-robin / random / least_conn / ip_hash / uri_hash / header / cookie |
| **Request headers** | added to the upstream request |
| **Response headers** | added to the response (e.g. `X-Robots-Tag: noindex`) |

### 6.3 How a request is routed

1. Rules are evaluated **in order**; the first match wins.
2. A `/` catch-all rule therefore blocks everything after it — the panel warns you and offers **move to end**.
3. No match → panel 404 page.
4. Every rule's match is prefixed by its exit hostname if the rule is exit-scoped.

A rule being shadowed by an earlier one is also detected: the panel lists "rule A is blocked by rule B" with a
jump button, because that is the single most confusing failure mode.

### 6.4 Templates (30, five groups)

Generic web (whoami / static site / Node / Python / API), ops & dev (DSH, Baota, Portainer, Grafana, Uptime Kuma,
Gitea, code-server), media & home (Jellyfin, Plex, qBittorrent, Transmission, Synology DSM, Home Assistant,
Immich, Navidrome, Nextcloud), database UIs (Adminer, phpMyAdmin, pgAdmin, mongo-express, RedisInsight,
InfluxDB, MinIO), web terminals (ttyd, Wetty, Shellinabox).

Picking a "sensitive" template (database UI, terminal) auto-expands the advanced section and warns you to add
basic auth or an IP allow-list first.

### 6.5 What you cannot tunnel

A tunnel upstream is an **HTTP** server. Pointing a rule at MySQL (`3306`) or SSH (`22`) returns `502` — Caddy
speaks HTTP, MySQL answers with a binary handshake. Options:

1. **Web wrapper**: Adminer/phpMyAdmin for databases, ttyd/Wetty/code-server for shells.
2. **Cloudflare-side service type**: add `ssh://localhost:22` as a public hostname in the dashboard and use
   `cloudflared access ssh` on the client.
3. **Tailscale/WARP** for raw TCP.

## 7. Toolbox

- **Docker containers** — lists what is running (via `docker.sock`), guesses the right port, one click creates
  a rule pointing at the container.
- **Share links** — `https://panel.example.com/s/<random>` for a temporary upstream, expiring in N minutes.
  No panel login needed, and the route is injected ahead of every catch-all.
- **Self-test** — performs a real request through the local Caddy with a chosen path/Host and shows status,
  timing, headers and a body preview. This answers "is it Caddy or is it my app?".
- **Speed test** — measures TTFB and throughput through the tunnel, and reports which Cloudflare colo
  (`cf-ray` suffix) served the request.
- **Cloudflare API** (optional) — verify a token, list tunnels with live connections, fetch a tunnel token,
  list/create/delete DNS records. It cannot create public hostnames (Cloudflare doesn't expose that API),
  and the panel says so instead of pretending.
- **Generated Caddy config** — the exact JSON that gets pushed, for when a rule "doesn't work".

## 8. Observability

| Feature | Where | Notes |
| --- | --- | --- |
| Traffic trend | Overview | hourly aggregation from `access.log`, 6/12/24 h, errors overlaid |
| Exit online history | Overview | sampled every minute (240 points = 4 h) |
| Access stats | Observe | status/path/time filters, 5 rows per page |
| Live log | Observe | keyword filter, errors only, pause, download |
| Notifications history | Settings | last 50 sends, including ones skipped by cooldown/quiet hours |
| `/metrics` | Prometheus | `cf_tunnel_up{id,name}`, `cf_tunnel_running`, `cf_caddy_ok`, `cf_tunnel_requests_total{status}` |
| `/badge.svg` | README badge | live "tunnels up" count, no auth required |
| System info | Settings | version, Node, uptime, state size, backup count, log size, memory |

Notifications support `generic` (JSON POST), DingTalk, Feishu and Bark, with per-event switches, a cooldown
(default 300 s) and quiet hours (`23:00-07:00`, comma separated).

A ready-made Grafana dashboard lives in [`docs/grafana-dashboard.json`](docs/grafana-dashboard.json);
scrape config and alerts are documented in [`docs/PROMETHEUS-GRAFANA.md`](docs/PROMETHEUS-GRAFANA.md).

### 8.4 Audit log

Every state-changing request (`POST`/`PUT`/`DELETE`) and every failed `/api` call is recorded with
**who** (panel user, read-only user, or “not logged in”), **from which IP** (real client IP behind the tunnel),
**what** (human-readable action such as “修改代理规则”), the status code and duration.

- Stored in memory (last 500) **and** appended to `data/audit.log` (JSON Lines, rotated at 2 MB / 3000 lines).
- `GET /api/audit?limit=200&q=keyword` — search by person, IP, action or path.
- Plain `GET` reads are **not** recorded, so browsing the panel never floods the log.

### 8.5 Change trend (audit in the overview)
The overview page draws a second bar chart: how many **write actions** hit the panel each hour
(rule edits, exit start/stop, settings changes…), with failures stacked in red.
It reads `GET /api/audit/trend?hours=6|12|24`, which is built from the same audit log as §8.4 —
so it answers "when was the panel last touched, and did it succeed", which a backup list cannot.

## 9. Security

### 9.0 Sign-in and sessions
Two ways in, and they coexist:

| Method | Who it is for | How |
| --- | --- | --- |
| **Session cookie** | browsers | open `/login`, sign in once → `cfp_sid` cookie, 7 days, 12 h idle timeout |
| **HTTP Basic** | `curl`, scripts, Prometheus | `curl -u user:pass http://host:8090/...` |

Why sessions exist: Basic auth re-sends the password on every request, lives in the browser's
credential store forever, and **cannot be revoked** — with only Basic, the only way to lock
someone out is changing the password, which kicks you out too. With sessions you get a table
(Settings → Sessions) showing every device: account, role, source IP, user agent, signed-in
time, last activity — and a per-row **Kick** button plus *Sign out other devices*.

Details worth knowing:

- Sessions live in memory: restarting the panel signs everyone out (nothing to leak on disk).
- Cookie is `HttpOnly; SameSite=Lax`, plus `Secure` when the request came over HTTPS.
- Every state-changing request made with a session cookie is checked for same-origin
  (`Sec-Fetch-Site` / `Origin`). Cross-site writes are rejected with 403 and audited.
- Failed logins feed the same brute-force counter as Basic (8 tries / 10 min → 10 min lock).
- Read-only accounts also get sessions; their writes are refused with 403.


- **Panel login**: HTTP Basic. 8 wrong attempts from one IP → 10 minute lock (correct credentials still work).
- **Read-only account**: sees everything, writes nothing (403), for showing status to other people.
- **Security headers** on every panel page: CSP, `nosniff`, `no-referrer`, `SAMEORIGIN`.
- **Rate limit** on `/api/*`: 1200 requests/minute per client.
- **Real client IP behind the tunnel**: Caddy is configured with `trusted_proxies` (Cloudflare's 22 ranges) and
  `client_ip_headers: [CF-Connecting-IP]`. Without this, every request appears to come from a Cloudflare edge
  IP and your IP allow-lists silently stop working.
- **Secrets stay out of exports**: `/api/export` strips tunnel tokens, the Cloudflare token and webhook URLs
  unless you pass `?full=1`. Importing a stripped file keeps the current values instead of wiping them.
- **Route-level rate limiting** (`rate_limit`) needs a Caddy built with that module — see
  [`docs/RATELIMIT.md`](docs/RATELIMIT.md). Simpler alternative: Cloudflare Rate Limiting Rules.

### 9.1 Passwords are stored as bcrypt hashes

`panel.pass` and `viewer.pass` in `state.json` are bcrypt hashes (`$2b$10$…`), never plaintext — so backups,
exports and `cat data/state.json` no longer leak your password. Existing plaintext passwords are migrated
automatically on startup (`saveState('migrate-secrets')`), which is why you may see one extra backup file
right after upgrading.

Because every Basic-auth request would otherwise cost one bcrypt round (~170 ms on a small ARM box), successful
Basic credentials are cached in memory for 10 minutes; changing the password clears that cache immediately.
Browser sessions are unaffected — they use the session cookie, not Basic.

### 9.2 Is the container running the image's code?

`state.json` says v0.11.2 but the page looks old? Ask `/healthz`:

```bash
curl -s localhost:8090/healthz | jq '{version, code, imageCode, drift}'
```

- `code` — fingerprint (SHA1/16) of `src/` **as it is on disk right now**
- `imageCode` — fingerprint baked into the image at build time (`RUN node tools/codehash.js > .code-hash`)
- `drift: true` — the two differ, i.e. the container is running hot-copied code (`docker cp`) rather than the
  image's code. Perfectly normal while developing, dangerous in production: a plain `docker compose up -d`
  will silently roll you back to the image's version.

## 10. API

Everything the panel does is a plain JSON endpoint, so you can script it.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | `{ok, tunnels:{total,running}, version}` |
| GET | `/api/state` | full state + runtime (secrets redacted) |
| GET/POST | `/api/tunnels`, `/api/tunnels/<id>`, `/api/tunnels/<id>/{start,stop,restart,delete}` | exits |
| POST | `/api/tunnels/{start-all,stop-all}` | all exits |
| GET/POST | `/api/routes` | routing rules (whole list at once) |
| GET/POST | `/api/settings` | site / maintenance / security / notify / Cloudflare |
| POST | `/api/panel-auth`, `/api/viewer` | panel login, read-only account |
| POST | `/api/rules/test`, `/api/match` | probe an upstream, simulate a match |
| GET | `/api/access`, `/api/traffic`, `/api/history` | access log, hourly buckets, exit sampling |
| GET | `/api/notify/history`, `/api/system`, `/api/logs{,/stream,/download}` | diagnostics |
| GET/POST | `/api/shares`, `/api/shares/<id>/delete` | one-time share links |
| POST | `/api/curl`, `/api/ws-test`, `/api/bench/local` | self-tests through local Caddy |
| GET/POST | `/api/cf/{verify,tunnels,dns}` | Cloudflare integration |
| GET/POST | `/api/export[?full=1]`, `/api/import`, `/api/backups{,/restore,/diff}` | backup & migration |
| GET | `/api/caddy/config`, `/metrics`, `/badge.svg` | generated config, Prometheus, badge |

Configuration is stored in `data/state.json` (mode `0600`, 20 rolling backups in `data/backups/`).

Each format has a completely different URL shape. A wrong URL does not error out at send time — it is **silently dropped**, so the panel validates on save:

| Format | What the URL looks like | Secret (signing) |
| --- | --- | --- |
| Generic JSON | any `http(s)://` endpoint receiving `{title,text,event,ts,host}` | not needed |
| DingTalk bot | `https://oapi.dingtalk.com/robot/send?access_token=…` | only when "signing" is enabled (`SEC…`), appended as `timestamp`/`sign` in the query |
| Feishu bot | `https://open.feishu.cn/open-apis/bot/v2/hook/…` | only with "signature verification", sent as `timestamp`/`sign` in the body |
| Bark (iOS) | `https://api.day.app/your-key` (self-hosted: your own domain) | not needed; panel appends `/title/body` |

A DingTalk bot that only uses a keyword needs no secret — just make sure the keyword appears in the message. Panel titles contain "掉线" / "失败" / "换了 IP" (down / failed / IP changed), so pick one of those.

### 10.3 Login sessions (more controllable than Basic)

| Method | Use case | Revocable |
| --- | --- | --- |
| Browser session (cookie `cfp_sid`) | everyday use | ✅ kick one by one |
| HTTP Basic | curl / scripts / Prometheus | ❌ verified per request |

- Sessions last 7 days idle-free, die after 12h of inactivity, and live **in memory only** — restarting the container logs everyone out.
- **Settings → Login sessions** lists device, source IP, login time and last activity; you can kick individually or "sign out everywhere".
- A session that **changes source IP** (a copied cookie) is flagged `IP changed` in the table, written to the audit log and pushed as a notification (toggle it under "Notifications").
- **Changing the panel password or viewer account revokes every session** and redirects to the login page.
- Write requests authenticated by session require a same-origin `Sec-Fetch-Site` / `Origin`, otherwise 403 (CSRF guard).

### 10.4 English / Chinese UI

Toggle with 🌐 in the top bar; the choice is stored in the `cfp_lang` cookie. The server renders nav and `<html lang>`, the client replaces **229** strings by exact "Chinese → English" lookup. Unknown strings stay Chinese on purpose — no machine translation, so you never get half-translated text.

### 10.5 Audit log

Bottom of the Observe page: who changed what, when, from which IP. Only state-changing requests and failed requests are recorded; high-frequency read-only endpoints (`/metrics`, `/badge.svg`, assets, log stream) are skipped so the log stays useful. Written to `data/audit.log` (JSON Lines, trimmed to the last 3000 lines past 2MB); API: `GET /api/audit?limit=&q=`.

## 11. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Tunnel URL opens, then `502` | upstream isn't listening, or you pointed at a non-HTTP port |
| Cloudflare shows `1033` | public hostname not created; a CNAME alone is not enough |
| `530` | cloudflared is not connected (invalid token, or the tunnel is paused) |
| Everything after a path returns 404 | a `/` catch-all rule sits above it — reorder |
| New exit serves the panel's 404 | no rule matches `/`; that is the default (add a rule or a `/` catch-all) |
| IP allow-list has no effect | real client IP missing — see §9 (`trusted_proxies`) |
| Quick tunnel keeps failing | Cloudflare `429`: too many quick tunnels, wait or switch to a named tunnel |
| Rules/edit boxes reset while typing | fixed in v0.7.6+; make sure you are not on an older build |
| `compose build` fails with registry 401 | your registry mirror is broken; `docker compose up -d --no-build` then `docker cp`, or fix the mirror |

Every action that changes state writes a backup first, and Settings → backups lets you diff a backup against
the current configuration and restore it in one click.

## 12. Project layout & tests

```
cf-tunnel-panel/
├── docker-compose.yml       # three containers, host network
├── Dockerfile               # node:22 + cloudflared binary
├── caddy.bootstrap.json     # initial Caddy config
├── src/server.js            # HTTP router + wiring only (~800 lines)
├── src/core/                # backend split by responsibility (see below)
├── src/web/                 # multi-page frontend (no build step)
│   ├── assets/app.css       # design system: dark/light, responsive
│   ├── assets/*.js          # one script per page
│   └── pages/*.html         # page fragments, wrapped by the backend shell
├── src/ui.html              # legacy single page (served at /legacy)
├── test/                    # end-to-end tests (API + jsdom)
├── tools/                   # bench.sh, fix-perms.sh, git-snapshot.sh
├── data/                    # state.json + backups/ + caddy-logs/ (gitignored)
└── docs/                    # ROADMAP, Prometheus/Grafana, rate limiting
```

Backend modules (`src/core/`, split out of the 2500-line `server.js` in v0.9.0):

| Module | Responsibility |
| --- | --- |
| `paths.js` | paths, constants, Cloudflare IP ranges |
| `util.js` | log ring buffer, JSON helpers, parsers, rate limit, security headers |
| `state.js` | state shape, migration, validation, persistence + rolling backups |
| `registry.js` | tunnel runtime registry (Map + read-only accessors) |
| `auth.js` | panel auth (Basic, read-only account, brute-force lockout) |
| `caddy.js` | turns rules into a Caddy JSON config (routing, maintenance page) |
| `pusher.js` | pushes that config to Caddy (debounced, records failures) |
| `tunnels.js` | cloudflared process pool (start/stop, 429 backoff, fatal errors) |
| `insight.js` | access stats, hourly buckets, match simulation, shadow analysis, upstream health, metrics |
| `bench.js` / `probe.js` | speed test endpoints / upstream + WebSocket probing |
| `integrations.js` | Docker API, Cloudflare API |
| `notify.js` | webhook pushes, cooldown, quiet hours, history |
| `web.js` | page shell + static assets (ETag/gzip) |
| `monitor.js` | background patrol (status sampling, expired shares) |
| `audit.js` | audit log (who changed what, from where) |

Tests (143 assertions total):

```bash
export PANEL_PASS='your-panel-password'   # tests attach credentials automatically
npm i -D jsdom
npm test                                  # = npm run test:api && npm run test:dom
```

- `test/api.test.mjs` — 86 endpoint assertions: exits, rules, upstream probing, match simulation, share links,
  maintenance mode, blacklist, backoff, WebSocket test, backup restore/diff, export/import, Cloudflare API,
  brute-force lockout, read-only account, traffic/history/notify/system, audit log. It inserts a temporary `/qa` probe
  rule and removes it afterwards; it never changes your password.
- `test/dom.test.cjs` — 57 page assertions in jsdom: six pages load without script errors, theme toggle,
  polling does not clobber typing, rule search, inline import, scope memory, observe filters, log pause,
  charts, Ctrl+K palette, read-only form, system info.

## 13. Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) (Chinese) for the version-by-version plan, design decisions and known
limits — including why the panel is built this way: Caddy in front (not cloud-side ingress rules), host
networking, zero-dependency Node, hand-written SVG charts.


## 14. What's new in v0.12.0

Twelve items that turn a "config web page" into a small operations console. Every one of them is wired into the automated tests (116 API + 75 DOM assertions).

| Area | What changed | Why it matters |
| --- | --- | --- |
| **Login sessions** | Cookie sessions (`cfp_sid`, HttpOnly, SameSite=Lax) with `remember me` (30 days) and a 12-hour idle timeout. Sessions are **persisted to `data/sessions.json`** — a container restart no longer logs you out. Only SHA-256 hashes of the cookie values are stored. | Basic auth is fine for curl, terrible for a browser: no logout, no device list, no way to revoke. |
| **Kick devices** | Settings → *Login sessions* lists every session (IP, UA, last seen, whether it changed IP) with **kick** and **kick all**. Changing the panel password kicks everything and forces a re-login. | If a cookie leaks, you can kill it from your phone in five seconds. |
| **Unsaved-changes guard** | Any edit on Tunnels / Rules / Settings marks the page dirty, shows a `未保存` badge in the top bar, blocks in-page navigation with a confirm, and hooks `beforeunload`. | The 5-second polling used to eat your typing. That is fixed, and now you also cannot lose it by clicking a nav link. |
| **Single-instance lock** | `data/.state.lock` with pid + `/proc/<pid>/cmdline` verification. A second instance exits with a clear message. | Two panels writing `state.json` overwrite each other; worse, one can push its own Caddy config over the live one (this really happened in CI). |
| **Caddy admin hardening** | The admin API moved off the well-known `:2019` to **`127.0.0.1:20190`**, and the generated config now derives its listen address from `CADDY_ADMIN` instead of hard-coding it. The pusher falls back across addresses so an upgrade cannot leave you stranded. | `:2019` is the default every Caddy tutorial and tool assumes; a non-default loopback port is one less free win for anything else running on the box. |
| **Hostname manager** | Tools → *Public hostnames*: list, add, and delete a tunnel's ingress rules, with the matching CNAME created (or deleted) automatically. `addDns:false` skips DNS. | Adding a public hostname used to mean a trip to the Cloudflare dashboard. Now it is one form, and it is written through the same API the dashboard uses. |
| **Per-route stats** | Observe → *Route hit stats*: for each rule, how many requests, error rate, P50/P95/max latency, bytes — computed by attributing real access-log lines through the same matcher the engine uses. Requests that matched nothing are reported separately. | "Which rule is slow / broken" used to be a `grep`. |
| **More alerts** | Two new notify events: **5xx spike** (>10% of requests in 5 min, min 20 samples) and **repeated login failures** (≥5 in 10 min, with source IPs). Both honour the existing cooldown and quiet hours. | The panel already told you when a tunnel died. Now it tells you when it is up but failing. |
| **YAML export** | `GET /api/export.yaml` — a secret-free, single-file snapshot for git (`settings` / `tunnels` / `routes`). | JSON exports are diff-hostile. This one is meant to be committed. |
| **PWA** | Manifest + icon + service worker. Install it from the browser; the shell works offline, **only `/assets/*` is cached** (pages and `/api` never are). | On a phone the panel is now an app on the home screen instead of a bookmark. |
| **GHCR images** | `.github/workflows/release.yml` builds multi-arch images (`amd64` + `arm64`) on a `v*` tag and pushes to `ghcr.io/<owner>/cf-tunnel-panel`. | No more "build it yourself to get a fix". |
| **Legacy page removed** | The 96 KB single-file UI at `/legacy` is gone. | Two UIs drifted apart; keeping the old one cost more than it helped. |

Two things were deliberately **not** done in this release, and they are still open in the roadmap: TOTP second factor, and per-role permission sets beyond admin/read-only.

## License

[MIT](LICENSE) — use it, change it, ship it commercially; keep the copyright notice.

> It exposes your services to the internet. Read [§9 Security](#9-security) before publishing anything
> that has a login behind it.
