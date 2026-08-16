// scripts/install-git-hooks.mjs
//
// Idempotently install the pre-push hooks: the confidentiality scanner (audit finding H1,
// fail-closed/blocking) and the NOI cross-check reminder (OI-137/OI-162 fix #1, WARN-only/
// non-blocking — see scripts/prepush-noi-crosscheck.mjs for why it must never block). Resolves
// the real hooks dir via `git rev-parse --git-path hooks` (works for worktrees, where .git is a
// file), writes a tiny POSIX wrapper chaining both checks, and marks it executable. Safe to run
// repeatedly — invoked from `npm run hooks:install` and from `prepare` on install.
//
// Node built-ins only.
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute } from 'node:path';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

// Exported (not just a local const) so tests/unit/install-git-hooks.test.ts can assert on the
// literal template — this is what tests/unit/prepush-noi-crosscheck.test.ts guards against
// regressing back into a blocking 'exec' of the advisory-only stage.
export const WRAPPER = `#!/bin/sh
# Managed by scripts/install-git-hooks.mjs.
# 1) pre-push confidentiality scanner (audit H1) — fail-closed: a non-zero exit blocks the push.
# 2) NOI cross-check reminder (OI-137/OI-162 fix #1) — ADVISORY ONLY. Its exit status must never
#    determine this hook's exit status — no 'exec', no bare invocation as the last statement.
#    .git/hooks is the common dir shared by every worktree; a checkout that predates this file
#    (or lacks it for any other reason) must still push cleanly, hence the -f guard and '|| true'.
root="$(git rev-parse --show-toplevel)"
node "$root/scripts/prepush-confidential-scan.mjs" || exit 1
if [ -f "$root/scripts/prepush-noi-crosscheck.mjs" ]; then
  node "$root/scripts/prepush-noi-crosscheck.mjs" || true
fi
exit 0
`;

function main() {
  let hooksDir;
  let toplevel;
  try {
    hooksDir = git(['rev-parse', '--git-path', 'hooks']);
    toplevel = git(['rev-parse', '--show-toplevel']);
  } catch (err) {
    console.error(`[install-git-hooks] not a git repo or git unavailable: ${err?.message ?? err}`);
    process.exit(1);
  }

  // `--git-path` may return a path relative to the repo top level.
  if (!isAbsolute(hooksDir)) hooksDir = join(toplevel, hooksDir);

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
    console.log(`[install-git-hooks] created hooks dir: ${hooksDir}`);
  }

  const hookPath = join(hooksDir, 'pre-push');
  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;

  if (existing === WRAPPER) {
    console.log(`[install-git-hooks] pre-push hook already up to date: ${hookPath}`);
  } else {
    writeFileSync(hookPath, WRAPPER, 'utf8');
    console.log(
      existing === null
        ? `[install-git-hooks] installed pre-push hook: ${hookPath}`
        : `[install-git-hooks] updated pre-push hook: ${hookPath}`,
    );
  }

  try {
    chmodSync(hookPath, 0o755);
  } catch (err) {
    // chmod is a no-op / may fail on some Windows filesystems; the sh wrapper still runs under
    // Git for Windows. Don't fail the install over it.
    console.warn(`[install-git-hooks] chmod skipped: ${err?.message ?? err}`);
  }
}

main();
