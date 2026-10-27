# Cloudflare remote view (phone, read-only)

Two Workers on `workers.dev`, no database, no persistence:

| Worker | Host | Role |
|---|---|---|
| `agent-town` | `agent-town.mxhan.workers.dev` | Viewer. Behind Cloudflare Access; also verifies the Access JWT (issuer, audience, expiry, exact email). Serves the town UI with `remote-shim.js`, which swaps `/events` for a WebSocket. Read-only. |
| `agent-town-ingest` | `agent-town-ingest.mxhan.workers.dev` | Push target for mini-1. Only `POST /ingest` and `GET /ingest/check` with the `PUSH_TOKEN` bearer secret; everything else 404. Owns the `TownState` Durable Object (memory only, WebSocket Hibernation). |

The viewer binds `TownState` directly (cross-script DO binding), so viewers never touch the ingest host,
and the ingest host is not behind interactive Access (same split as eagle / eagle-ingest).

## Privacy

`cloudflare/shared/whitelist.mjs` is applied on mini-1 before upload **and** again in the ingest Worker.
Only team id/name, member display name, agent type, status fields and timestamps pass. Prompts, replies,
titles, errors, activity, cwd/project, model, pane/session ids and team guidelines (AGENTS.md / TEAMS.md)
are never sent. Member keys are SHA-256 hashed on mini-1.

## Offline rule

mini-1 pushes on change and a full-snapshot heartbeat every 20 s. The viewer shows **mini-1 离线** when the
last push is older than 60 s (age computed from server time, not the phone clock).

## Deploy

```sh
npm run cf:build                     # copies only allowlisted UI files to cloudflare/dist
cd cloudflare
wrangler deploy --config wrangler.ingest.jsonc   # first: owns the DO
wrangler secret put PUSH_TOKEN --config wrangler.ingest.jsonc   # via stdin
wrangler deploy --config wrangler.viewer.jsonc
```

Access: add `agent-town.mxhan.workers.dev` as a destination of the existing hostname-based Access
application used for eagle (same exact-email Allow policy). The viewer's `ACCESS_AUD` is that app's
audience; if a separate app is created instead, put its AUD in `wrangler.viewer.jsonc` and redeploy.
Do not put `agent-town-ingest` behind interactive Access.

## mini-1 push agent

`cloudflare/push/push.mjs`, config `~/.config/agent-town/push.json` (mode 0600: `url`, `token`, `source`).
It reads the local privacy-mode snapshot from `http://127.0.0.1:4546/api/sessions`.
LaunchAgent label: `com.mxhan.agent-town-push`.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mxhan.agent-town-push.plist   # start
launchctl bootout   gui/$(id -u)/com.mxhan.agent-town-push                                # stop
```
