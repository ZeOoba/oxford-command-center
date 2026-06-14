// scripts/install-git-hooks.mjs
//
// Idempotently install the pre-push confidentiality hook (audit finding H1). Resolves the real
// hooks dir via `git rev-parse --git-path hooks` (works for worktrees, where .git is a file), writes
// a tiny POSIX wrapper that invokes scripts/prepush-confidential-scan.mjs, and marks it executable.
// Safe to run repeatedly — invoked from `npm run hooks:install` and from `prepare` on install.
//
// Node built-ins only.
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute } from 'node:path';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const WRAPPER = `#!/bin/sh
# Managed by scripts/install-git-hooks.mjs — pre-push confidentiality scanner (audit H1).
# Fail-closed: a non-zero exit blocks the push.
root="$(git rev-parse --show-toplevel)"
exec node "$root/scripts/prepush-confidential-scan.mjs"
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
