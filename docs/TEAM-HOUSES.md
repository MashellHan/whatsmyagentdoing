# Team Houses

A local-only, private team neighborhood. Each Herdr workspace is a house that opens the original 2D/3D office, list and picture-in-picture views. A full member roster stays available in each house.

## Run

From the current Herdr-managed terminal, using Node.js 18+:

```sh
WMAD_NO_UPDATE_CHECK=1 node bin/cli.js --no-open --private --port 4546
```

Open `http://127.0.0.1:4546`. No runtime dependency installation is needed. Only loopback is bound; a busy port fails instead of silently selecting another port. `--stop --port 4546` validates the Team Houses app identity and stops only that exact instance, never another original dashboard. Updates and downloads are disabled.

## Identity and activity

- Fixed, bounded, read-only `herdr workspace list` / `herdr agent list` calls supply team, name, pane and configured role.
- The original session watcher/parsers supply activity. Binding requires exact provider + session ID; directories and names are never used for fuzzy matching.
- Joined log states retain the original typing/thinking/tool/waiting/error timeout rules. The UI shows a per-member log source label.
- Only an unavailable/ambiguous log binding falls back to clearly marked Herdr status. Unregistered logs appear in a separate house and are not duplicated.
- Prompt/reply/title/error content is removed from private snapshots. Infrastructure names, session IDs and original path metadata are not anonymized; do not publish live snapshots.
- Herdr read failures retain the last identity snapshot as stale. They do not fabricate agent completion. Team room filters apply before notifications and rendering, including PiP.

Configure known leaders explicitly in `config/team-houses.json` (or `--team-map FILE`). The checked-in configuration is deliberately empty. Example with synthetic IDs:

```json
{"scope":"current-herdr-session","workspaces":{"team-a":{"leaderPane":"team-a:leader","expectedName":"example-lead"}},"members":{}}
```

No role is inferred from pane order, project directory, or a name containing “leader”. The leader keeps a neutral main seat when idle; other members keep original work/wander/off-duty behavior.

## Checks

`npm test` uses isolated synthetic records and temporary files. `npm run test:town` and `npm run test:ui` use local fixture servers and an installed Playwright/Chromium. Set `WMAD_BROWSER_EXECUTABLE` to an existing browser executable if Chrome is not in its default location. Do not download dependencies merely to run the dashboard.

All public tests use synthetic data. Keep local mapping files, real status evidence and internal rule documents out of pull requests. This fork does not send terminal input, publish state, or deploy a remote service.
