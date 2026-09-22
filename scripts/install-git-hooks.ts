// scripts/install-git-hooks.ts
//
// Idempotently install the pre-push hooks: the confidentiality scanner (audit finding H1,
// fail-closed/blocking) and the NOI cross-check reminder (OI-137/OI-162 fix #1, WARN-only/
// non-blocking — see scripts/prepush-noi-crosscheck.mjs for why it must never block). Resolves
// the real hooks dir via `git rev-parse --git-path hooks` (works for worktrees, where .git is a
// file), writes a tiny POSIX wrapper chaining both checks, and marks it executable. Safe to run
// repeatedly — invoked from `npm run hooks:install` and from `prepare` on install.
//
// Native TypeScript, run via tsx (see OI-206 / reference_vitest_green_typecheck_blind_spot —
// this file used to be plain .mjs with a hand-maintained sibling .d.mts, which drifted out of
// sync with its exports twice and broke `npm run typecheck` while `vitest` stayed green each
// time). Safe to convert: this script is only ever invoked through `npm run hooks:install` /
// `prepare`, both npm-context calls where node_modules (and therefore tsx) is guaranteed
// present — unlike the two scripts it installs as hooks, which stay plain .mjs on purpose (see
// their own headers: "Node built-ins only, no install step" — they run from the raw shared
// .git/hooks with no npm context and must survive a missing/wiped node_modules).
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute } from 'node:path';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

// Exported (not just a local const) so tests/unit/install-git-hooks.test.ts can assert on the
// literal template — this is what tests/unit/prepush-noi-crosscheck.test.ts guards against
// regressing back into a blocking 'exec' of the advisory-only stage.
export const WRAPPER = `#!/bin/sh
# Managed by scripts/install-git-hooks.ts.
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

// Exported for the same reason as WRAPPER (see above) -- installs the commit-msg trailer guard
// (scripts/commitmsg-trailer-guard.mjs), added to catch a malformed AI Co-Authored-By trailer at
// commit time instead of at push time. Unlike the pre-push NOI stage, this stage IS blocking (a
// non-zero exit fails the commit) -- that is the entire point: a blocked local commit is free to
// retry, unlike a pushed one that needs history rewritten. Git passes the commit-msg file path as
// $1; forwarded through verbatim. Missing/absent script (an older worktree checkout) must not
// break `git commit`, hence the same -f guard pattern as the pre-push NOI stage.
export const COMMIT_MSG_WRAPPER = `#!/bin/sh
# Managed by scripts/install-git-hooks.ts.
# Commit-msg trailer guard: blocks a malformed/incorrect AI Co-Authored-By trailer (fail-closed).
# .git/hooks is the common dir shared by every worktree; a checkout that predates this file (or
# lacks it for any other reason) must still allow commits, hence the -f guard.
root="$(git rev-parse --show-toplevel)"
if [ -f "$root/scripts/commitmsg-trailer-guard.mjs" ]; then
  node "$root/scripts/commitmsg-trailer-guard.mjs" "$1" || exit 1
fi
exit 0
`;

function installHook(hooksDir: string, hookName: string, contents: string): void {
  const hookPath = join(hooksDir, hookName);
  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;

  if (existing === contents) {
    console.log(`[install-git-hooks] ${hookName} hook already up to date: ${hookPath}`);
  } else {
    writeFileSync(hookPath, contents, 'utf8');
    console.log(
      existing === null
        ? `[install-git-hooks] installed ${hookName} hook: ${hookPath}`
        : `[install-git-hooks] updated ${hookName} hook: ${hookPath}`,
    );
  }

  try {
    chmodSync(hookPath, 0o755);
  } catch (err) {
    // chmod is a no-op / may fail on some Windows filesystems; the sh wrapper still runs under
    // Git for Windows. Don't fail the install over it.
    console.warn(`[install-git-hooks] chmod skipped: ${(err as Error)?.message ?? err}`);
  }
}

function main(): void {
  let hooksDir: string;
  let toplevel: string;
  try {
    hooksDir = git(['rev-parse', '--git-path', 'hooks']);
    toplevel = git(['rev-parse', '--show-toplevel']);
  } catch (err) {
    console.error(`[install-git-hooks] not a git repo or git unavailable: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  }

  // `--git-path` may return a path relative to the repo top level.
  if (!isAbsolute(hooksDir)) hooksDir = join(toplevel, hooksDir);

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
    console.log(`[install-git-hooks] created hooks dir: ${hooksDir}`);
  }

  installHook(hooksDir, 'pre-push', WRAPPER);
  installHook(hooksDir, 'commit-msg', COMMIT_MSG_WRAPPER);
}

main();
