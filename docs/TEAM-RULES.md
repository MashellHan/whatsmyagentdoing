# Local team guidelines reader

Rules are deliberately separate from status snapshots and remote synchronization. The reader lists known rules only on explicit request, then reads one selected document. No data is written to the repositories. Content is not sent to agents.

## Scope and configuration

Directory candidates come only from fresh Herdr workspace/member metadata, not browser paths or unregistered logs. Each candidate resolves to its nearest repository/worktree root. General discovery stops at that root and never scans sibling worktrees, `.git`, dependencies or nested repositories.

The bounded discovery patterns are root/known-cwd ancestor `AGENTS.md`, `AGENTS.override.md`, `TEAMS.md`, `TEAM.md`, `CLAUDE.md`, `GEMINI.md`; `.codex/AGENTS.md`; and one-level `docs/TEAM*.md`. ASCII case variants are supported. Files are not read to produce a list.

Shared workspace instructions can also live outside a Git repository. At known working-directory ancestors, stopping before the home/filesystem root, the reader checks only exact instruction names above and `.agents/team/playbook.md`; it does not scan those directories. A member's provider profile can contribute its standard global instructions. These non-repository scopes use the same descriptor, link, size and identity checks and accept only the fixed instruction-path patterns.

Each member has a **准则 / Skills** entry. Members often share AGENTS.md rather than having separate copies. The dialog labels shared rules, explicit member configuration, and files observed in that exact session's tool-read requests. Observed `.agents/team/roles/*.md`, `.agents/teams/<team>/playbook.md` / `roles/*.md`, `.claude/agents/*.md` and `skills/<name>/SKILL.md` references can be listed only under the member's known workspace ancestors or standard local skill profiles. This records a requested read, not a guarantee the tool succeeded or the document is still applied. Names and roles are never inferred from the member's display name, and merely installed skills are not assigned to every member. Large logs may omit older read references outside the watcher's bounded head/tail replay.

An optional local workspace map entry can add `rules.extraFiles` (exact relative Markdown paths) and `rules.roots` (explicit additional repository roots). Extra files still obey the same safety checks; they cannot escape roots or follow links. Keep real paths in local configuration, never in public PRs.

Member entries in the same map can supply `rules.extraFiles` / `rules.roots`, guarded by `expectedName` and optional `expectedSessionId`. Their working directory is private and scoped to the exact current member key, not the union of other members' directories. Lists and IDs are isolated by both team and member; departure, replacement, stale identity or context changes invalidate subsequent reads.

## File and HTTP safety

- An already-installed Python 3 with Unix `dir_fd`, `O_DIRECTORY` and `O_NOFOLLOW` is required. On macOS the default is `/usr/bin/python3`; `WMAD_RULES_PYTHON` can select an existing interpreter. The dashboard installs nothing and reports unavailable if the helper cannot run.
- Every directory is opened relative to a pinned descriptor with no-follow flags; the selected file is opened from that verified parent, checked by `fstat`, and read from the same handle. This prevents intermediate-symlink replacement from turning a checked path into an outside read.
- Symlinks, non-regular files, multi-hardlinks and nested repositories are rejected. Root/file identities are checked, file changes invalidate old list entries, and reads are capped at 256 KiB of valid UTF-8.
- Browser clients receive random team/member-scoped IDs, relative display paths and generic scope labels, not real root paths. IDs expire after five minutes; refreshing or a changed scope invalidates them.
- Requests require loopback, GET, a custom same-origin header and matching Origin/Fetch Metadata when present. No CORS or forwarded-host trust. Responses are no-store JSON. This is not authentication against other local same-user processes.
- Limits: at most 32 directory candidates, eight repository roots, 16 exact instruction roots (40 candidates each), 128 files overall, 512 entries per inspected directory, four helper processes, three-second helper timeout and per-team/member list rate limiting. Excess/inaccessible scope is reported rather than silently claimed complete.

Neither scope metadata, lists nor documents are part of `/events` or `/api/sessions`. The Cloudflare viewer's API/static allowlists do not expose this reader. Tests use synthetic repositories, malicious links and an explicit directory-swap race; no real team rules are included.

## Reading in a team room

Open a registered team's local room, then select **团队守则**, above **屋内成员**, or a member's **准则 / Skills** entry. Page load checks only capability: opening the dialog lists metadata, and selecting a file reads exactly that document. Desktop uses a larger file sidebar and reader with maximize/restore and a bottom-right resize handle (also adjustable with arrow keys; Shift makes larger steps). The window remains within the viewport; mobile fills the screen and switches between list and document. Escape returns focus to the opening entry, and closing/navigation or a member's departure cancels requests and clears content. There is no prefetch, persistent browser storage, editing or agent instruction injection.

Markdown is a deliberately limited DOM-only dialect: headings, paragraphs, lists, quotes, code and emphasis. Raw HTML remains text; all images and links are inert, including local/data URLs. Unsupported syntax stays readable as text, and an original-text toggle is available. No external parser, image, font, preview or code execution is used.

The entry is absent from non-local hostnames, ungrouped/global views and PiP. A missing capability fails closed. `npm run test:rules-ui` checks synthetic hostile content, delayed-response cancellation, keyboard/mobile layouts and an actual helper/server/browser round trip. Set `WMAD_RULES_SCREENSHOTS` to a local output directory for synthetic screenshots only.
