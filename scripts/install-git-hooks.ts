// scripts/install-git-hooks.ts
//
// Idempotently install the pre-push hooks: the confidentiality scanner (audit finding H1,
// fail-closed/blocking), the refute-trailer gate (blocking on a real violation, open on tooling
// gaps) and the NOI cross-check reminder (OI-137/OI-162 fix #1, WARN-only/
// non-blocking — see scripts/prepush-noi-crosscheck.mjs for why it must never block). Resolves
// the real hooks dir via `git rev-parse --git-path hooks` (works for worktrees, where .git is a
// file), writes a tiny POSIX wrapper chaining the checks, and marks it executable. Safe to run
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

/** File name of the Python term scanner's copy beside the installed pre-push hook (for trees that
 * predate runTermScan; see WRAPPER). */
export const PY_SCAN_FALLBACK = 'ora_prepush_confidential_scan.py';

// Exported (not just a local const) so tests/unit/install-git-hooks.test.ts can assert on the
// literal template — this is what tests/unit/prepush-noi-crosscheck.test.ts guards against
// regressing back into a blocking 'exec' of the advisory-only stage.
export const WRAPPER = `#!/bin/sh
# Managed by scripts/install-git-hooks.ts.
# 1) Confidentiality scanner (scripts/prepush-confidential-scan.mjs, Hard Invariant 3) — fail-closed.
#    It runs the shared Python term scanner (scripts/prepush_confidential_scan.py, vendored from
#    ora-skills) ITSELF, then the OCC payload checks (data/ binaries, real-data manifest paths, real
#    amounts, confidential:true). It gets git's argv ("$@": remote name and push URL) and the
#    buffered ref lines. .git/hooks is shared by every worktree, so both version skews are covered:
#    an older wrapper still reaches the term scan through the new scanner, and a worktree whose tree
#    predates runTermScan (its JS matches terms on the endpoint diff only) gets the Python term scan
#    here first, from the copy the installer places beside this hook. No usable Python 3.8+ or no
#    scanner copy => BLOCKED. Each candidate python is probed by running it (the Windows Store stub
#    fails); it runs isolated (-I).
# 2) NOI cross-check reminder (OI-137/OI-162 fix #1) — ADVISORY ONLY. Its exit status must never
#    determine this hook's exit status — no 'exec', no bare invocation as the last statement.
#    .git/hooks is the common dir shared by every worktree; a checkout that predates this file
#    (or lacks it for any other reason) must still push cleanly, hence the -f guard and '|| true'.
# 3) Refute-trailer gate (stricter than CI's refute-required job) — fail-closed on an unattested-
#    commits verdict only, fail-open on any tooling gap (see scripts/prepush-refute-check.mjs). Git's pre-push stdin is
#    buffered once so the scanner and this stage each read the full ref list. A failed read
#    blocks the push: an empty ref list would otherwise let every stage pass with nothing scanned.
#    (POSIX: a bare assignment's status is its command substitution's, so '||' sees cat's failure.)
# PATH is rebuilt FIRST, with shell built-ins only, before this hook runs any external command
# (refute runs wf_df157e64-c52, wf_954ebd83-729, wf_a50bf4bb-d1a). Kept: absolute entries with no
# '.' or '..' segment that are neither the current directory (git runs this hook in the worktree
# root) nor inside it. Each entry is resolved to its physical path (cd -P) before its parents are
# compared with test -ef, so case variants, a link to the worktree and a link INTO one of its
# subdirectories all count as inside. Dropped: empty, '.', relative and missing entries. So nothing untracked in the worktree (a planted
# cat, head, grep, node, python, git) can stand in for a tool this hook or its children run.
# Windows: children (node, python, git) must not search the current directory either.
NoDefaultCurrentDirectoryInExePath=1
export NoDefaultCurrentDirectoryInExePath
here="$(pwd -P)"
_safe=
_ifs=$IFS
IFS=:
set -f
for _d in $PATH; do
  case "$_d" in /*) ;; *) continue ;; esac
  case "$_d/" in */./*|*/../*) continue ;; esac
  # Walk the entry's PHYSICAL path: a junction or symlink outside the worktree that points INTO a
  # subdirectory of it has no string prefix equal to the worktree (refute run wf_39e200e8-462).
  # cd is a built-in, so no fork; an entry that cannot be entered is dropped.
  cd -P -- "$_d" 2>/dev/null || continue
  _p=$PWD
  cd -P -- "$here" || exit 1
  _in=
  while [ -n "$_p" ]; do
    if [ "$_p" -ef "$here" ]; then _in=1; break; fi
    _next=\${_p%/*}
    [ "$_next" = "$_p" ] && break
    _p=$_next
  done
  [ -n "$_in" ] && continue
  _safe=\${_safe:+$_safe:}$_d
done
set +f
IFS=$_ifs
PATH=$_safe
export PATH
if [ -z "$PATH" ]; then
  echo "pre-push BLOCKED (fail-closed): no usable PATH entry outside the worktree." >&2
  exit 1
fi
root="$(git rev-parse --show-toplevel)"
refs="$(cat)" || { echo "pre-push: could not read push refs from stdin" >&2; exit 1; }
scan_js="$root/scripts/prepush-confidential-scan.mjs"
# safe_exe NAME: every hit for NAME (or NAME.exe) on the rebuilt PATH, one per line, in PATH order
# (built-ins only). All are listed so a failing first hit (the Windows Store stub) does not hide a
# working interpreter later on PATH.
safe_exe() {
  _ifs=$IFS
  IFS=:
  set -f
  for _d in $PATH; do
    for _f in "$_d/$1" "$_d/$1.exe"; do
      if { [ -f "$_f" ] || [ -L "$_f" ]; } && [ ! -d "$_f" ]; then
        printf '%s\\n' "$_f"
      fi
    done
  done
  set +f
  IFS=$_ifs
}
node_bin="$(safe_exe node | head -n 1)"
if [ -z "$node_bin" ]; then
  echo "pre-push BLOCKED (fail-closed): node not found on an absolute PATH entry outside the worktree." >&2
  exit 1
fi
if ! grep -q 'runTermScan' "$scan_js" 2>/dev/null; then
  scan_py="$root/scripts/prepush_confidential_scan.py"
  [ -f "$scan_py" ] || scan_py="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/${PY_SCAN_FALLBACK}"
  if [ ! -f "$scan_py" ]; then
    echo "pre-push BLOCKED (fail-closed): this tree predates the Python term scan and no scanner copy sits beside the hook (run npm run hooks:install from an up-to-date tree)." >&2
    exit 1
  fi
  py=
  for c in python python3 py; do
    py="$(safe_exe "$c" | while IFS= read -r cand; do
      if "$cand" -I -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" </dev/null >/dev/null 2>&1; then
        printf '%s' "$cand"
        break
      fi
    done)"
    [ -n "$py" ] && break
  done
  if [ -z "$py" ]; then
    echo "pre-push BLOCKED (fail-closed): no Python 3.8+ found to run the confidentiality term scan." >&2
    exit 1
  fi
  printf '%s\\n' "$refs" | "$py" -I "$scan_py" "$@" || exit 1
  # Legacy call shape (no argv): an older scanner treats ANY '--staged' argument, e.g. a remote
  # named --staged, as its manual mode and skips the payload checks.
  printf '%s\\n' "$refs" | "$node_bin" "$scan_js" || exit 1
else
  printf '%s\\n' "$refs" | "$node_bin" "$scan_js" "$@" || exit 1
fi
if [ -f "$root/scripts/prepush-refute-check.mjs" ]; then
  printf '%s\\n' "$refs" | "$node_bin" "$root/scripts/prepush-refute-check.mjs" || exit 1
fi
if [ -f "$root/scripts/prepush-noi-crosscheck.mjs" ]; then
  "$node_bin" "$root/scripts/prepush-noi-crosscheck.mjs" || true
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

/**
 * Copy scripts/prepush_confidential_scan.py beside the hooks (as PY_SCAN_FALLBACK, LF line endings)
 * so a push from a worktree whose tree predates runTermScan still gets the Python term scan.
 * A tree without the scanner leaves any existing copy alone (and the wrapper blocks if none exists).
 */
function installPythonScanFallback(hooksDir: string, toplevel: string): void {
  const src = join(toplevel, 'scripts', 'prepush_confidential_scan.py');
  if (!existsSync(src)) {
    console.warn(`[install-git-hooks] ${src} not found; Python term-scan copy beside the hook not refreshed.`);
    return;
  }
  const contents = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
  const dst = join(hooksDir, PY_SCAN_FALLBACK);
  if (existsSync(dst) && readFileSync(dst, 'utf8') === contents) return;
  writeFileSync(dst, contents, 'utf8');
  console.log(`[install-git-hooks] installed Python term-scan copy: ${dst}`);
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
  installPythonScanFallback(hooksDir, toplevel);
}

// Only install when run as a script (`npm run hooks:install`, `prepare`). This module is also
// imported by tests/unit/install-git-hooks.test.ts for WRAPPER; an unconditional main() made every
// vitest run rewrite the SHARED .git/hooks (the common dir of every worktree) with whatever template
// the running checkout carried, so a test run in a feature worktree silently reinstalled that
// branch's hook for every other session.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/install-git-hooks.ts')) {
  main();
}
