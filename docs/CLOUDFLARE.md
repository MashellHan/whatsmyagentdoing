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
npx wrangler@4 whoami                 # verify the account; use login --use-keyring if needed
npm run cf:build                      # copies only allowlisted UI files to cloudflare/dist
npx wrangler@4 deploy --config cloudflare/wrangler.ingest.jsonc  # first deployment: owns the DO
npx wrangler@4 secret put PUSH_TOKEN --config cloudflare/wrangler.ingest.jsonc  # via stdin
npx wrangler@4 deploy --config cloudflare/wrangler.viewer.jsonc
```

For a UI-only update, rebuild the assets and deploy the viewer; the ingest Worker and its secret can
stay in place. The local push config's `token` must match the ingest Worker's `PUSH_TOKEN`.

Protect `agent-town.mxhan.workers.dev` with a hostname-based Cloudflare Access application and an
Allow policy for the exact `ALLOWED_VIEWER_EMAIL`. In the Worker dashboard, this is configured from
Settings → Domains & Routes → Cloudflare Access. Set `ACCESS_AUD` in `wrangler.viewer.jsonc` to that
application's audience and `ACCESS_TEAM_URL` to its team domain, then deploy the viewer. These values
must come from the actual application. Wrangler OAuth can publish Workers while lacking permission
to create Access applications; configure Access in the dashboard if its API returns `auth.forbidden`.
Do not put `agent-town-ingest` behind interactive Access. A bare 403 from the viewer is not a working
login flow: verify that an unauthenticated visitor reaches Access login and the allowed user can open
the town.

## mini-1 push agent

`cloudflare/push/push.mjs`, config `~/.config/agent-town/push.json` (mode 0600: `url`, `token`, `source`).
Set `source` to the running dashboard's `/api/sessions` URL. The CLI's default port is 4546; this
desktop installation uses `http://127.0.0.1:4545/api/sessions`.
LaunchAgent label: `com.mxhan.agent-town-push`.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mxhan.agent-town-push.plist   # start
launchctl bootout   gui/$(id -u)/com.mxhan.agent-town-push                                # stop
```
