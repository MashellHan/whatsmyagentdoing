# Local team guidelines reader

Rules are deliberately separate from status snapshots and remote synchronization. The reader lists known rules only on explicit request, then reads one selected document. No data is written to the repositories. Content is not sent to agents.

## Scope and configuration

Directory candidates come only from fresh Herdr workspace/member metadata, not browser paths or unregistered logs. Each candidate resolves to its nearest repository/worktree root. Scope stops there: it never scans parents, sibling worktrees, `.git`, dependencies or nested repositories.

The bounded discovery patterns are root/known-cwd ancestor `AGENTS.md`, `TEAMS.md`, `TEAM.md`, `CLAUDE.md`, `GEMINI.md`; `.codex/AGENTS.md`; and one-level `docs/TEAM*.md`. ASCII case variants are supported. Files are not read to produce a list.

An optional local workspace map entry can add `rules.extraFiles` (exact relative Markdown paths) and `rules.roots` (explicit additional repository roots). Extra files still obey the same safety checks; they cannot escape roots or follow links. Keep real paths in local configuration, never in public PRs.

## File and HTTP safety

- An already-installed Python 3 with Unix `dir_fd`, `O_DIRECTORY` and `O_NOFOLLOW` is required. On macOS the default is `/usr/bin/python3`; `WMAD_RULES_PYTHON` can select an existing interpreter. The dashboard installs nothing and reports unavailable if the helper cannot run.
- Every directory is opened relative to a pinned descriptor with no-follow flags; the selected file is opened from that verified parent, checked by `fstat`, and read from the same handle. This prevents intermediate-symlink replacement from turning a checked path into an outside read.
- Symlinks, non-regular files, multi-hardlinks and nested repositories are rejected. Root/file identities are checked, file changes invalidate old list entries, and reads are capped at 256 KiB of valid UTF-8.
- Browser clients receive random team-scoped IDs, relative display paths and generic repository labels, not real root paths. IDs expire after five minutes; refreshing or a changed team scope invalidates them.
- Requests require loopback, GET, a custom same-origin header and matching Origin/Fetch Metadata when present. No CORS or forwarded-host trust. Responses are no-store JSON. This is not authentication against other local same-user processes.
- Limits: at most 32 directory candidates, eight roots, 128 files, 512 entries per inspected directory, four helper processes, three-second helper timeout and per-team list rate limiting. Excess/inaccessible scope is reported rather than silently claimed complete.

Neither scope metadata, lists nor documents are part of `/events` or `/api/sessions`. The Cloudflare viewer's API/static allowlists do not expose this reader. Tests use synthetic repositories, malicious links and an explicit directory-swap race; no real team rules are included.
