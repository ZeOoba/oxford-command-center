# .claude/hooks — project guardrails

PreToolUse hooks wired via `.claude/settings.json`. They mechanically enforce
the CLAUDE.md rules that agents historically violated. Zero dependencies,
Node >= 20, identical behavior on the Windows desktop and the Linux server.

## What each guard enforces

### bash-guard.mjs (matcher: `Bash`)

Denies always-wrong commands. No override exists for these.

| Blocked | Doctrine |
|---|---|
| `git add -A` / `--all` / bare `.` pathspec | CLAUDE.md 2 — commit explicit paths only |
| `git commit --no-verify` / `-n` | CLAUDE.md 9 — never bypass the gate |
| `git push --force` / `-f` (`--force-with-lease` allowed) | CLAUDE.md 8 |
| `git config` / `git -c` touching `core.hooksPath` | hook tampering |
| `sqlite3` write DDL/DML (`DROP/ALTER/DELETE/UPDATE/INSERT/VACUUM`) against `data/warehouse/finance.sqlite` | CLAUDE.md 9 — use migrations |
| `rm`/`unlink` of `data/warehouse` or `data/overlay.json` | CLAUDE.md 9 |

Compound commands are split on `&&`, `||`, `;`, `|`, and newlines; git checks
are token-scoped to the actual `git <subcommand>` invocation, and quoted
strings are blanked first so a commit message containing `-n` does not
false-positive. The sqlite check runs on the whole command line so a piped
`echo "DELETE ..." | sqlite3 ...` is still caught.

### file-guard.mjs (matcher: `Edit|Write|MultiEdit|NotebookEdit`)

Resolves the target path (`file_path` / `notebook_path`) against the project
root and denies:

1. **Hard denies** (no override): `data/overlay.json`, `data/warehouse/**`,
   `.claude/settings.json`, `.claude/hooks/**` (self-protection — the
   guardrails cannot be loosened from inside a session; edit them outside a
   session via a reviewed PR).
2. **Architect-owned files** (CLAUDE.md 4), listed in
   `architect-owned.json` — the machine-readable mirror of CLAUDE.md 4.
   Keep that manifest in sync with CLAUDE.md in the same PR.

`confidential-terms.json` is denied fail-closed by `permissions.deny` in
`.claude/settings.json` (Read/Edit/Write on any path), not by these hooks.

## Override sentinel protocol (architect-owned files only)

1. The agent sets `review_needed: true` + `review_detail` for its entry in
   `architecture/status.json` (per CLAUDE.md 5).
2. The architect acknowledges by running, at the project root:

   ```sh
   mkdir -p .claude/overrides && touch .claude/overrides/architect-edit-ok
   ```

3. The sentinel is honored for **60 minutes** from its mtime, then expires.
   Re-touch to extend. `.claude/overrides/` is gitignored.

The sentinel never unlocks the hard-deny paths above.

## Fail-open rationale

Both guards exit 0 (allow) on any stdin/JSON/fs error. Per the EOS asymmetric
failure doctrine: productivity/process gates FAIL OPEN — a broken hook must
never block legitimate work. Confidentiality/egress gates FAIL CLOSED — which
is why confidential-terms.json protection lives in `permissions.deny`
(enforced by Claude Code itself even in bypassPermissions mode), not in a
script that could crash open. There is deliberately NO `permissions.ask`
block: sessions here run bypassPermissions, where `ask` is toothless —
enforcement lives in `deny` rules and these hooks.

## Cross-platform notes

- Hook commands are a single plain `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<guard>.mjs"`
  invocation — no shell operators — so they run under Git Bash on Windows and
  sh on Linux unchanged. Claude Code expands `$CLAUDE_PROJECT_DIR` itself; if
  a given install does not, the fallback is the relative form
  `node .claude/hooks/<guard>.mjs` (hooks run with cwd = project dir).
- The guards resolve the project root as
  `CLAUDE_PROJECT_DIR || input.cwd || process.cwd()`, so the same committed
  settings work in the main checkout AND in every `.claude/worktrees/*`
  worktree (each worktree gets its own sentinel).
- All hook output is ASCII (Windows cp1252 console contract).
