# Team Houses

A local-only, private team neighborhood. Each Herdr workspace is a house that opens the original 2D/3D office, list and picture-in-picture views. A full member roster stays available in each house.

## Run

From the current Herdr-managed terminal, using Node.js 18+:

```sh
WMAD_NO_UPDATE_CHECK=1 node bin/cli.js --no-open --private --port 4546
```

From a terminal outside Herdr, select a running session explicitly:

```sh
herdr session list --json
node bin/cli.js --herdr-session default --no-open --port 4546
```

Use the session name returned by the list command; `default` is the built-in
session name. Every workspace/agent read is routed through `herdr --session
<name>`, including retries. The snapshot reports the selected session under
`source.session`. This does not require setting `HERDR_ENV` or attaching a
terminal. Without an explicit selection, Herdr mode still requires an inherited
Herdr terminal context.

`--logs` deliberately disables Herdr discovery and shows only ungrouped local
logs. It cannot be combined with `--herdr-session`. To change an already-running
dashboard from logs to teams, stop the exact port and restart with the chosen
session; starting it again only reopens its current page.

Open `http://127.0.0.1:4546`. No runtime dependency installation is needed. Only loopback is bound; a busy port fails instead of silently selecting another port. `--stop --port 4546` validates the Team Houses app identity and stops only that exact instance, never another original dashboard. Updates and downloads are disabled.

## Identity and activity

- Fixed, bounded, read-only `herdr workspace list` / `herdr agent list` calls supply team, name, pane and configured role.
- The original session watcher/parsers supply activity. Binding requires exact provider + session ID; directories and names are never used for fuzzy matching.
- Joined log states retain the original typing/thinking/tool/waiting/error timeout rules. The UI shows a per-member log source label.
- Only an unavailable/ambiguous log binding falls back to clearly marked Herdr status. Unregistered logs appear in a separate house and are not duplicated.
- Upstream v0.4.0 adds Copilot CLI, OMP, Kimi Code, DSH and Grok Build logs. Kimi child resume IDs do not identify their parent as the child. Explicitly configured local Magpie observations keep a separate source label and cannot offer a native resume command.
- Prompt/reply/title/error content is removed from private snapshots. Infrastructure names, session IDs and original path metadata are not anonymized; do not publish live snapshots.
- Herdr read failures retain the last identity snapshot as stale. They do not fabricate agent completion. Team room filters apply before notifications and rendering, including PiP.

Configure known leaders explicitly in `config/team-houses.json` (or `--team-map FILE`). The checked-in configuration is deliberately empty. Example with synthetic IDs:

```json
{"scope":"current-herdr-session","workspaces":{"team-a":{"leaderPane":"team-a:leader","expectedName":"example-lead"}},"members":{}}
```

No role is inferred from pane order, project directory, or a name containing “leader”. The leader keeps a neutral main seat when idle; other members keep original work/wander/off-duty behavior.

The local Today panel totals only the selected house when a team room is open.
The remote viewer does not receive usage, context, project totals or resume
commands, and hides Today when those totals are unavailable. The optional Claude
approval hook requires an explicit `--install-hook` command; normal startup does
not edit Claude settings. Self-updates and scene mutations remain disabled.

Optional `members` mappings may assign `dev` or `designer` roles, keyed by pane ID and guarded by an exact `expectedName`. A renamed/replaced occupant safely falls back to member. These badges appear in the room roster and list; they do not change activity or elect a leader. Keep real mappings local.

## Local member details

The roster shows model, reasoning effort and context-window tags from the member's actual session log. Codex per-turn settings and OMP thinking-level changes are tracked; unsupported or missing values are marked unrecorded. The existing Claude context-window estimate is explicitly labeled with ≈. Context tags have the recorded capacity and, when available, used tokens in their tooltip. These tags do not read the current global CLI defaults, which may differ from a running session.

Click a member to expand a small **最近活动** panel. The watcher keeps at most 30 tool requests per tracked log; each displayed request is capped at 360 Unicode characters. It includes shell commands and other tools, not tool output, user prompts or reasoning text. Large logs retain only the history found in the existing bounded replay. A panel polls every 1.5 seconds while visible; closing it, switching members, hiding the page or opening the rules dialog cancels requests. Only one member panel is open at a time, and status updates preserve its scroll position.

`GET /api/members/activity?team=…&member=…` requires the same loopback, GET, same-origin header and no-forwarding checks as the rules reader. It validates a fresh current member plus an unambiguous provider/session binding before accessing that log's private history. Missing session IDs, ambiguous matches and remote-only observations report unavailable rather than guessing. The new history and document references never enter status snapshots or Cloudflare uploads. Model/effort/context remain excluded by the existing cloud whitelist, and private member/reader modules are excluded from the remote asset build.

**团队守则** is above the member heading; each member has an independent **准则 / Skills** entry. See [the rules reader](TEAM-RULES.md) for association labels, scope and resizing. `npm run test:members-ui` exercises live updates, cancellation, per-member isolation, viewport fit and reader resizing with synthetic data.

## Checks

`npm test` uses isolated synthetic records and temporary files. `npm run test:town` and `npm run test:ui` use local fixture servers and an installed Playwright/Chromium. Set `WMAD_BROWSER_EXECUTABLE` to an existing browser executable if Chrome is not in its default location. Do not download dependencies merely to run the dashboard.

All public tests use synthetic data. Keep local mapping files, real status evidence and internal rule documents out of pull requests. This fork does not send terminal input, publish state, or deploy a remote service.

## Accessible garden neighborhood

Houses keep their roof and wall colors and their enlarged size in every state, regardless of member count. Busy houses light their windows and porch lamp, emit continuous chimney puffs, and move a rooftop flag and a clipped window silhouette. Other houses have dark windows and an unlit porch lamp. Idle houses close their curtains and show a sleeping cat and Zzz. Monochrome symbols and text also identify waiting, unknown and empty houses. Manual pause, system reduced-motion and stale snapshots use deterministic static alternatives while counts keep updating.

Lawns, shrubs, small flower beds and street trees stay clear of the artwork and naturally-sized signs. Layout measurements handle long text and one-column mobile streets. `npm run test:town` checks five states, same-house colors, 12-second motion continuity, stale/reduce/pause, 13-house layouts and 200% text.

For safe sample images, run `HOMEPAGE_CAPTURE_FIXTURE=1 npm run capture:homepage` using an already installed browser. Without that flag the script reads only the local dashboard, and those outputs must remain private.

## Compact overview and optional large canvases

The homepage defaults to a compact overview: four houses across on larger desktops, two compact cards across on smaller windows, and one column on phones. The layout adapts to natural text height, so long names remain readable. Use “放大街区” for the original neighborhood, or expand “状态说明” for counting details.

All houses share the larger size, chimneys, and windows. Busy houses add continuous billowing smoke and gently pulsing warm light. The compact view gives the houses more room while tightening the surrounding spacing on short screens. Manual pause, reduced-motion settings, and stale data retain a static pose.

Offices default to “适应窗口”, fitting the complete room, controls, and legends within the desktop viewport. A long member roster scrolls inside its own panel. “放大查看” restores the large canvas with natural page scrolling. Small screens keep the roster below the room. PiP retains its own viewport and supports both original paths.

`npm run test:compact` checks one-screen layouts at 1440×900, 1280×720, and 1024×768 for the homepage and both office renderers, switching back from large views, and mobile reflow.

`npm run test:wide` measures actual person/furniture projection, full-room/label containment, 1440/1920/2560 widths, mobile and PiP sizes, DPR and pixel budgets. It uses synthetic fixtures only. Large canvases can exceed the viewport height: use page scrolling or select fit mode; 3D wheel zoom is disabled in large-stage mode so scrolling remains possible.

Desktop labels, provider badges and bubbles scale as a group from 1.2 to 1.6 (12–16 CSS px text) with the stage width. Exact screen-space label bounds are included in pointer picking, including labels shifted away from an edge. Phones and PiP retain the original compact scale. Full collision avoidance and separately repainted video-PiP labels are not implemented; video labels still scale with the captured scene.
