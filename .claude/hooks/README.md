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
| `git commit --no-verify` / `-n`; `git merge` / `git pull` / `git am --no-verify` | CLAUDE.md 9 — never bypass the gate |
| `git push --force` / `-f` / `--no-verify` / `--mirror` / a `+refspec` (`--force-with-lease` allowed) | CLAUDE.md 8 + pre-push confidential-history scan |
| `git config` / `git -c` touching `core.hooksPath` | hook tampering |
| `sqlite3` write DDL/DML (`DROP/ALTER/DELETE/UPDATE/INSERT/VACUUM`) against `data/warehouse/finance.sqlite` | CLAUDE.md 9 — use migrations |
| `rm`/`unlink` of `data/warehouse` or `data/overlay.json` | CLAUDE.md 9 |
| writes (`>`/`>>`, `tee`, `sed -i`, `mv`/`cp`, `rm`) to `.claude/settings*.json` or `.claude/hooks/` | guardrails are edited only via a reviewed PR |

Long options match every abbreviation git accepts (`--no-verif`, `--forc`). Options are read
from the argv the shell actually builds (quotes, backslashes, `$'..'` and brace expansion
resolved), as well as from the quote-blanked view, and a check denies if either matches; the
value of a message/file option is data and is skipped (audit wf_9bf74429-aaf finding 13).

Compound commands are split on `&&`, `||`, `;`, `|`, and newlines; git checks
are token-scoped to the actual `git <subcommand>` invocation. The `git add`
scan reads through quoting/escaping bypasses (`git add "-A"`, `git add \-A`) and
sees into `sh -c "..."` / `bash -c "..."` payloads and `$( ... )` / backtick
substitutions, while a git-add string that is merely a search argument
(`rg "git add -A"`) is left alone. The `git commit -n` check runs on a
quote-blanked copy so a commit message containing `-n` does not false-positive
(note: for `git push`, `-n` is `--dry-run`, so only the long-form
`git push --no-verify` is denied). The sqlite check runs on the whole command
line so a piped `echo "DELETE ..." | sqlite3 ...` is still caught.

**Best-effort `cd` awareness (residual limitation).** The warehouse-DDL and
`rm` denies key off a path substring. A `cd data` / `cd data/warehouse` earlier
in the same compound command relaxes the match so a later bare `finance.sqlite`
/ `warehouse` token is still caught (`cd data/warehouse && sqlite3 finance.sqlite "DELETE ..."`).
This does not model arbitrary shell `cd` state across every construct — a
sufficiently indirect `cd` (conditional, variable-built path, subshell) can
still slip a bare-path command past. That residual gap is accepted: this is a
fail-open process gate backed by human review, not a sandbox.

### file-guard.mjs (matcher: `Edit|Write|MultiEdit|NotebookEdit`)

Resolves the target path (`file_path` / `notebook_path`) against the repo root
that **owns the target** (found by walking up for `CLAUDE.md`), not merely the
session's project dir, and denies:

1. **Hard denies** (no override): `data/overlay.json`, `data/warehouse/**`,
   `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/**`
   (self-protection — the guardrails cannot be loosened from inside a session;
   edit them outside a session via a reviewed PR).
2. **Architect-owned files** (CLAUDE.md 4), listed in
   `architect-owned.json` — the machine-readable mirror of CLAUDE.md 4.
   Keep that manifest in sync with CLAUDE.md in the same PR.

Because it resolves against the target's own repo root, an **absolute** path
that reaches out of a worktree session into the main checkout's protected files
is still caught. Only files in this project's repo family (the session root, an
ancestor of it, or a descendant of it — the main<->worktree relationship) are
policed; a genuinely unrelated repo is never denied. Path matching is
case-insensitive (lowercased), so `Data/overlay.json` cannot evade on the
case-insensitive desktop NTFS checkout.

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

## Guardrail self-protection is best-effort

Bash mutations of `.claude/settings*.json` and `.claude/hooks/` are now
**blocked** by bash-guard, and the Edit/Write tools are additionally blocked by
`permissions.deny` + file-guard. This is defense in depth, but it is still a
**fail-open process gate**: bash-guard exits 0 (allow) on any error, its write
detection is pattern-based (an exotic shell construct could evade), and a
guardrail change made *outside* a session is unrestricted by design. The real
control is that guardrail edits land only through a reviewed PR — the hooks
raise the cost of an in-session bypass, they do not make it impossible.

## Launch from the repo root

These hooks only load when the session is started **at the repo root** (the
directory containing `.claude/settings.json`). A session started in a
subdirectory loads no project settings and therefore **no hooks and no
permission denies** — none of the protections above apply. Always launch
Claude Code from the checkout root (or the worktree root); each worktree carries
its own committed `.claude/settings.json` and its own `.claude/overrides/`
sentinel.

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
- file-guard resolves the project root as
  `CLAUDE_PROJECT_DIR || input.cwd || process.cwd()` for the session, then
  resolves each TARGET against the repo root that owns it, so the same
  committed settings work in the main checkout AND in every `.claude/worktrees/*`
  worktree (each worktree gets its own sentinel).
- All hook output is ASCII (Windows cp1252 console contract).
