# Cloudflare remote view (phone, read-only)

Two Workers on `workers.dev`. Team snapshots remain in memory; optional Copilot
account quota samples use the existing Durable Object's SQLite-backed storage:

| Worker | Host | Role |
|---|---|---|
| `agent-town` | `agent-town.mxhan.workers.dev` | Viewer. Behind Cloudflare Access; also verifies the Access JWT (issuer, audience, expiry, exact email). Serves the town UI with `remote-shim.js`, which swaps `/events` for a WebSocket. Read-only. |
| `agent-town-ingest` | `agent-town-ingest.mxhan.workers.dev` | Push target for mini-1. Only `POST /ingest` and `GET /ingest/check` with the `PUSH_TOKEN` bearer secret; everything else 404. Owns `TownState`: team snapshots in memory with WebSocket Hibernation, account quota samples in durable storage. |

The viewer binds `TownState` directly (cross-script DO binding), so viewers never touch the ingest host,
and the ingest host is not behind interactive Access (same split as eagle / eagle-ingest).

## Privacy

`cloudflare/shared/whitelist.mjs` is applied on mini-1 before upload **and** again in the ingest Worker.
Only team id/name, member display name, agent type, status fields and timestamps pass. Prompts, replies,
titles, errors, activity, cwd/project, model, pane/session ids and team guidelines (AGENTS.md / TEAMS.md)
are never sent. Member keys are SHA-256 hashed on mini-1.

When account monitoring is configured, its separate whitelist also permits
confirmed account login/host, plan, numeric quota counters, bounded error codes,
reset dates and collection times. GitHub credentials stay in the local system
keyring. Neither credentials nor raw upstream error messages are uploaded.

## Copilot account quota

Below the town, the homepage shows the selected accounts' premium usage, total allowance,
remaining percentage, reset date and collection status. Collection timestamps
include the full date and time in the viewer's local timezone. Ordinary chat and
completion allowances are kept separate. An `unlimited` marker has no measured
remaining percentage; a missing usage counter is unknown rather than zero.
Raw accounting values are not interpreted as requests, tokens or money, and
the API's remaining percentage is displayed independently of those counters.

Create `~/.config/agent-town/quota.json` on mini-1 (mode 0600). It contains no
credentials; select only profiles already confirmed in the github-accounts skill:

```json
{
  "helper": "/absolute/path/to/github-accounts/scripts/github_account.py",
  "profiles": ["enterprise", "personal", "github_menha_microsoft", "msft_menha"]
}
```

`WMAD_QUOTA_CONFIG` can select another local file. The helper resolves its
`../references/accounts.json`, retrieves the exact host/user credential from the
keyring and verifies `/user` before reading `copilot_internal/user`. This internal
GitHub endpoint may change. Monitoring is disabled without configuration and in
demo mode; `--json` does not trigger account requests.
Local account monitoring requires Python 3 and `gh` on the dashboard process's
PATH; the ordinary dashboard still requires only Node.js.

The running local dashboard polls the four accounts in parallel on startup and
every hour. `/api/quota` and the homepage read its cache; opening another
browser does not trigger more GitHub requests. The existing push process uploads
the whitelisted cache with its ordinary snapshot. A failed account keeps its last
successful values with a failure status and original success time. Results older
than 3 hours are labelled expired, independently of town presence.

Cloudflare Access protects `/api/quota`, `/api/quota/history` and `/quota.js` like
the rest of the viewer. `TownState` persists only the latest quota snapshot and
one history entry per new capture; repeated heartbeats do not create entries and
older captures cannot replace newer ones. New captures clean history older than
90 days. The history endpoint returns at most 144 captures from the past 24 hours.
Quota survives Worker eviction and deployments; team sessions are still not
persisted. No D1 database, cloud GitHub credentials or cloud polling job is needed.

Run `node --test tests/quota.cjs tests/cloud.cjs` and `npm run test:quota-ui` for
the contract, local HTTP, storage restoration, access and browser checks. Set
`WMAD_BROWSER_EXECUTABLE` if using an existing Chromium installation.

The v0.4.0 integration also recognizes Copilot CLI, OMP, Kimi Code, DSH and Grok
Build, with explicit log/Herdr/Magpie provenance. Today totals, context usage,
OMP profiles and resume commands are still excluded. Bundled provider SVGs are
included in the asset build and use the same Access protection as other assets.

## Offline rule

mini-1 pushes on change and a full-snapshot heartbeat every 20 s. The viewer shows **mini-1 离线** when the
last push is older than 60 s (age computed from server time, not the phone clock).

## Picture-in-picture

The popup embeds `/office?pip=1` in a same-origin iframe. Applying `X-Frame-Options: DENY`
to that page made the online popup blank. Only authenticated compact office pages
(`/office` or `/office/` with `pip=1`) use `X-Frame-Options: SAMEORIGIN` and
`Content-Security-Policy: frame-ancestors 'self'`. Other pages keep `DENY`; Access
authentication and WebSocket origin checks still apply.

Run `npm run test:cloud-ui` with Playwright Chromium installed, or set
`WMAD_BROWSER_EXECUTABLE` to a Chromium browser. It exercises the viewer Worker
with synthetic Access credentials and real browser framing rules, including live
updates, 2D/3D rendering, closing the popup and rejecting another origin's iframe.

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

When updating the shared whitelist, deploy the ingest Worker before the viewer,
then restart the existing local push service so both ends use the same projection.
If collector code changed, update the installed myoffice runtime and restart its
exact port with the existing Herdr session and local team map. Preserve the local
configuration when refreshing a copied skill installation. Verify local source
freshness, the authenticated `/ingest/check` response and the viewer deployment.

### Quota deployment verification — 2026-11-02

Ingest version `52fb8dc9-fa07-4a8a-8491-691b387cf6de` and viewer version
`610686f1-3de8-4ed8-8054-c90be8a3a51d` deployed successfully. Local port 4545
retained the `default` Herdr session with a fresh `logs+herdr` source. All four
selected accounts were collected successfully, and the authenticated ingestion
check returned their quota snapshot with a fresh push at 08:19:30 UTC.

During this rollout, the continuously active state object initially still
returned the old `/state` structure without `quota`, despite the deployment
API reporting the new version at 100%. A controlled 18-second pause of the push
process let the object reload. The first check then returned the restored quota
while `lastPushAt` was still null, verifying persistence across instance reload;
resuming push restored fresh team snapshots. Always resume a diagnostic pause
in a `finally` block. Verify the actual response structure and collection times
after deployments, rather than relying solely on the deployment version list.

The public homepage, quota API, history API and quota script all redirected an
unauthenticated request to the existing Access application. Browser fixtures
verified authenticated Worker access and the rendered quota states; the signed-in
production page was not automated. The visual detector also reported existing
homepage typography/contrast/decorative warnings; this change preserves the
incumbent town and uses at least 12px text in the quota section.

The subsequent viewer-only revision `777b0d00-4248-4894-8940-d6812f673a1f`
moved quota below the town. The installed local collector now polls every
2 hours, with expiry after 6 hours. All 148 Node tests, the quota browser checks
at 1440/768/390/320px, town journeys and remote PiP checks passed. The restarted
local dashboard retained its fresh `default` Herdr source; its four successful
account results matched the authenticated cloud cache. A real local browser
verified placement below the map with no page errors. All four public quota
routes still redirected anonymous requests to Access; the signed-in production
page remains outside the automated browser verification.

The latest viewer revision `d7731587-ac03-4658-8498-a868a6648cdc` includes
full dates in collection timestamps. The local collector now polls hourly,
with expiry after 3 hours. All eight quota tests and its four-width browser
checks passed; the installed dashboard displayed `最近采集 2026/11/02 16:37`
in both desktop and mobile checks. The local source remained fresh, all four
account results reached the cloud cache, and public routes retained Access
redirects. The signed-in production page was not checked in a browser.

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
