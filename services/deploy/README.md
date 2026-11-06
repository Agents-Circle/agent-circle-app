# Running the services on a server you own

Written for a plain VPS with root access, because that is where these four processes
belong and the alternatives all failed on something:

| Host | Why not |
|---|---|
| Render free | spins down after ~15 min without inbound HTTP, which gaps the feed, and has no persistent disk |
| Render paid | needs a payment method the workspace does not have; `$7`/mo plus disk |
| Cloudflare Workers | no filesystem and no long-lived process; `inputlog.ts`, `api.ts` and the recorder would all need rewriting, and both scorers take a **file path** |
| A laptop | works, and is where the recorder runs today — but it puts the season's only authoritative record on one machine |

A VPS needs no code changes at all. Everything below is configuration.

## What runs

| Service | Entry point | Shape |
|---|---|---|
| Arena season | `src/arena/main.ts` | WebSocket in, append-only log, HTTP order API out |
| Recorder | `src/arena/record.ts` | WebSocket in, one gzipped file per UTC day |
| Indexer | `src/indexer/main.ts` | polls the chain, writes Postgres |
| Keeper | `src/keeper/main.ts` | **holds a private key and signs**; treat its host accordingly |

Only the Arena needs to be reachable from the internet.

## Before anything

**Node 22.18 or newer.** `services/` has no build step — it runs TypeScript through Node's
native type stripping. Most distro packages are older, and the failure is `node` refusing a
`.ts` entry point, which reads like a broken start command rather than a wrong runtime.
Check with `node --version` and install from nodesource or nvm if it is older.

**Python 3.10+** if the independent scorer will run on the same box. It only needs the
standard library.

**A non-root service user.** None of these need root. The keeper especially: it holds a key.

## The checkout

Use a checkout nobody switches branches in — a detached worktree. The recorder unit's
comment says why: a `git checkout` in a shared clone changes the code under a running
service, and the first you hear of it is a replay that disagrees with the log.

```
git clone https://github.com/Agents-Circle/agent-circle-app .runtime/src
git -C .runtime/src worktree add --detach ../arena main
cd .runtime/arena/services && npm ci --omit=dev
```

## The log, and what "durable" has to mean

**The input log is the season.** A restart replays it; `npm run arena:replay -- <log>` and
`scorer/arena_scorer.py <log>` both re-score the season from that file alone, which is the
check run before a prize is paid.

Put it on the largest suitable filesystem and **back it up off the box**. A copy on the
same server is not a backup — it survives a mistake but not the server. Something that
runs on a schedule and writes somewhere else: `restic` to object storage, or at minimum a
cron'd `rsync` to a different machine. Whatever it is, write down what it is and test a
restore once, because an untested backup is a belief.

`src/arena/main.ts` refuses to start when the database holds published scores for a season
and the log replays nothing — a lost log fails the boot instead of silently restarting the
season from the opening equity. That is a backstop against silence. It is not storage.

## Exactly one Arena per season, ever

Not a capacity choice. Two Arenas each hold their own input log and engine state, both
accept orders on the same API keys, and both upsert `scores` for the same entries — so the
leaderboard shows whichever wrote last and neither log is the season. Nothing locks against
it. The indexer and keeper tolerate a second copy (wasteful, not wrong); the Arena does not.

## The units

`agent-circle-arena@.service` and `agent-circle-recorder@.service` here are systemd **user**
units, which is how the recorder has run on a laptop since 4 November. On a server, run them
as system units instead: drop them in `/etc/systemd/system/`, replace `%h` with real paths,
and add `User=` and `Group=` for the service user. Keep `KillSignal=SIGINT` — it lets the
sequencer finish the line it is appending, and a torn final line is recoverable (the next
start trims it) while a lost event is not.

```
systemctl enable --now agent-circle-arena@season-0
systemctl enable --now agent-circle-recorder@mainnet
```

`%i` is the season slug for the Arena and the network for the recorder.

## Secrets

Environment files, `0600`, owned by the service user, outside the repo. The Arena needs
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The keeper needs a private key, and that
belongs in its environment file and nowhere else — not in the repo, not in a config module,
not in a container image.

## Reaching the order API

Entrants call `/v1/orders` and `/v1/account` over HTTPS, so the Arena needs a hostname and
a certificate. It binds `ARENA_PORT`, falling back to `PORT`, default 8787, and serves plain
HTTP — terminate TLS in front of it.

Caddy is the least work, because it gets a certificate on its own:

```
arena.agentscircle.network {
  reverse_proxy 127.0.0.1:8787
}
```

Then an `A` record for that name pointing at the server. `/v1/health` needs no key and is
the right thing to check first.

Do not expose the port directly. The API authenticates with a bearer key and rate-limits
per key, but it has no TLS of its own, and an API key sent in cleartext is an API key given
away.

## Verifying it works

1. `systemctl status` on each unit, and `journalctl -u ... -f` for the first minute.
2. The Arena logs `season resumed from log` with a `replayed` count. On a fresh season that
   is `0`; on a restart it should be the number of events in the log, not zero.
3. `curl https://<host>/v1/health`.
4. Reboot the box once and confirm everything comes back. `enable` is a promise; a reboot
   is the test.

With no season row in the database yet, `ARENA_SEASON_SLUG=season-0` cannot resolve and the
unit will fail with a clear message and restart. That is the correct state before Season 0
exists — a clean failure proves the wiring without inventing a season.

## Taking over the recording

The recorder has been running on a laptop since 4 November, about 135 MB a compressed day,
with no backups. Moving it here is a clear improvement, with one thing to carry across:

**`recorder.json` freezes the coin set** at first start — the top 15 perps by open-interest
notional, always including BTC, ETH and SOL. A fresh start on a new host picks its own
universe from that day's open interest, which may differ. Copy the existing `recorder.json`
into the new `ARENA_RECORD_DIR` before first start if the recorded days are meant to be
continuous with what is already captured, and copy the existing days across too.

## Server install: system units and off-box backup

What was actually deployed on the Ubuntu 24.04 VPS (Arena and recorder only; the indexer
and keeper are not on a Season 0 entrant's path).

- Service user `agentcircle` (system user, no login shell). Worktrees live in
  `/home/agentcircle/.runtime/{src,arena,arena-recorder}`; the recorder gets its own
  detached worktree, as its unit expects.
- Data in `/var/lib/agent-circle/{seasons,recorder}`. Env files in `/etc/agent-circle/`,
  `0600`, owned by `agentcircle`: `<season>.env` (Arena: `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ARENA_COINS`, `ARENA_PORT`) and the optional
  `recorder-<network>.env`.
- `system/` holds the two units for `/etc/systemd/system/`. They are the user units above
  with `User=`/`Group=`, absolute paths and `WantedBy=multi-user.target`. `KillSignal=SIGINT`
  is kept.
- `backup/` is an hourly `restic` backup of `/var/lib/agent-circle` to an S3-compatible
  bucket (Cloudflare R2), with `restic forget --prune` and `restic check
  --read-data-subset=5%` on every run. Copy `restic.env.example` to
  `/etc/agent-circle/restic.env` (`0600`, root), fill it in, install the script to
  `/usr/local/sbin/`, the service and timer to `/etc/systemd/system/`, then
  `systemctl enable --now agent-circle-backup.timer`. Use a bucket and API token that
  nothing else shares, and keep the `RESTIC_PASSWORD` somewhere off the box: without it
  the backups cannot be read. The env file with the Supabase key is deliberately not
  backed up.
- If R2 token access is restricted by IP, allow both the server's IPv4 and IPv6 addresses:
  outbound traffic to Cloudflare uses IPv6 by default.
- Arena behind an existing Caddy in Docker: bind stays `0.0.0.0:8787`, allow only the
  Docker bridge with `ufw allow from 172.18.0.0/16 to any port 8787 proto tcp`, and proxy
  to the bridge gateway (`reverse_proxy 172.18.0.1:8787`). A Caddyfile with `admin off`
  cannot be reloaded; applying a new site block needs a container restart.
