---
name: myoffice
description: Open a local dashboard of Herdr teams and Claude Code, Codex, Gemini CLI, Copilot CLI, OMP, Kimi Code, DeepSeek Harness and Grok Build activity. Use when the user invokes myoffice, asks what their local agents or Herdr teams are doing, or wants to start, stop, or restart the office dashboard.
---

# myoffice

This is the Team Houses fork. It shows Herdr workspaces and members, using exact
session logs for activity when available and Herdr status otherwise.
Requires Node.js 18+ and has no runtime packages to install.
In Codex, invoke it with `$myoffice` or select it through `/skills`.

## Choose the source and start

Use the skill's base directory for `bin/cli.js`.

For Herdr teams:

- Inside a Herdr-managed terminal (`HERDR_ENV=1`), the dashboard inherits that
  session. Start `node "<base directory>/bin/cli.js"` in the background.
- Outside Herdr, run `herdr session list --json` and select a running session
  using the user's context. When there is only one running session, use its
  returned name. If several sessions remain plausible, ask which one to show.
  Start in the background:

  ```bash
  node "<base directory>/bin/cli.js" --herdr-session "<session name>"
  ```

An explicit session uses bounded, read-only workspace and agent queries. It does
not require opening a Herdr terminal or setting `HERDR_ENV` manually.
Do not switch a request for Herdr teams to `--logs`: that option deliberately
omits Herdr identity and groups local session logs into one ungrouped house.
Use `--logs` when the user wants that view, or `--demo` for sample data.

The default port is 4546; preserve a port the user requests or is already using
by passing `--port`. The command opens the browser unless given `--no-open`.
Keep the process running independently of the chat, with output redirected to a
local log. Report the printed URL.

Verify `/api/sessions` after starting. Herdr mode should report
`source.kind: "logs+herdr"` and `source.presence: "fresh"`, with the expected
teams and members. Explicit selection also reports `source.session`.
A stale source is a connection failure, not evidence that the team is idle.

## Stop and restart

Determine the dashboard's actual port. To stop it, run in the foreground:

```bash
node "<base directory>/bin/cli.js" --stop --port <port>
```

For a restart, wait until that port is released, then start with the intended
source and the same port. Starting a second command while the dashboard is
already running only reopens the page; it does not change its source mode.
Confirm the resulting source and teams before reporting a successful restart.

## Other options

- `--json`: print a snapshot and exit. Keep the chosen `--herdr-session` or
  `--logs` option when summarizing agents in chat.
- `--hours 4`: include local logs active in the last four hours (default 24).
- `--omp-dir PATH`: select an OMP sessions root or direct session directory;
  see [OMP support](docs/omp.md) for profiles and resume limitations.
- `--team-map FILE`: use explicit, local leader/member mappings. Do not infer
  roles from names or pane order.
- `--scenes`: list built-in and already-installed scenes.
- `--scene ID`: open an installed scene, using an ID from that list.

This fork always hides prompts/replies and binds to loopback. Self-updates and
scene downloads/removal are disabled. Use the repository's normal installation
workflow for updates instead of `--update`.
For team identity, status binding, and role configuration, see
[Team Houses](docs/TEAM-HOUSES.md).

## Optional approval hook

If the user wants Claude Code permission prompts to show as "Waiting for you"
(Claude Code doesn't log them), offer `node "<base directory>/bin/cli.js" --install-hook`.
It adds one Notification hook to their Claude Code settings; `--uninstall-hook` removes it.
Ask before running it, since it changes their settings.

Sessions are read locally from the agents' own session folders (`~/.claude/projects`,
`~/.codex/sessions`, `~/.gemini/tmp`, `~/.copilot/session-state`, `~/.omp`, `~/.kimi-code`,
`~/.dsh`, `~/.grok`). Optional Magpie ingestion must be explicitly configured
through its local URL and server-side sign-in key; see the README.
