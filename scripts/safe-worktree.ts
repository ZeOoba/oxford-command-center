// scripts/safe-worktree.ts
//
// Safe git-worktree helper for this repo's multi-agent / isolated-worktree workflow on Windows.
//
// WHY THIS EXISTS (incident 2026-06-13): to give an isolated worktree its dependencies, node_modules
// was shared via a Windows directory JUNCTION into the repo's real node_modules. `git worktree remove
// --force` then recursed THROUGH the junction and DELETED the real node_modules — breaking tooling for
// every session until `npm install` restored it. The lesson: never share node_modules by junction, and
// never `--force`-remove a worktree whose node_modules is a reparse point.
//
//   safe-worktree add <path> [<base-ref>] [<new-branch>]
//       git worktree add (+ -b <new-branch>) at <base-ref> (default origin/main), then a REAL
//       `npm install` inside it. No junction — the only safe way to share deps.
//
//   safe-worktree remove <path>
//       If <path>/node_modules is a junction/symlink, UNLINK it first (never recursing into the
//       target), then `git worktree remove <path>` WITHOUT --force. REGISTERED worktrees only.
//
//   safe-worktree prune [--dry-run]
//       Sweep the worktree roots (.claude/worktrees, .claude-worktrees, .worktrees) for ORPHANED dirs —
//       leftover directories that `git worktree list` no longer tracks and that lack the `.git` link a
//       live linked worktree always has — and delete each JUNCTION-SAFELY (unlink reparse points, never
//       recurse through one; long-path tolerant so deep node_modules don't flake the way `rmdir /s`
//       does with "directory not empty"). `git worktree remove` cannot touch these — they are
//       deregistered — which is why they accumulate and slow `git status`. --dry-run only lists them
//       (no filesystem or git-metadata mutation).
//
// Invoke: `npx tsx scripts/safe-worktree.ts <add|remove|prune> ...` (or `npm run worktree -- <...>`).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readdirSync, rmdirSync, type Stats, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The directory roots under which isolated worktrees are created here. Two exist for historical
 *  reasons: `.claude/worktrees` (legacy) and `.claude-worktrees` (created by the harness EnterWorktree
 *  tool); `.worktrees` is an older stray. `prune` sweeps ALL of them so orphans can't hide in one. */
export const WORKTREE_ROOTS = ['.claude/worktrees', '.claude-worktrees', '.worktrees'] as const;

/** Windows extended-length form so fs calls tolerate >260-char paths — deep node_modules trees are the
 *  reason `rmdir /s` flaked with "directory not empty". No-op off win32 / for already-prefixed paths. */
function longPath(p: string): string {
  if (process.platform !== 'win32') return p;
  const abs = resolve(p);
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs;
}

/** True iff `p` is a reparse point (Windows junction or a symlink) — NOT a real directory/file.
 *  Node's lstat reports junctions as symbolic links. Returns false for a non-existent path.
 *  Long-path tolerant so a deeply-nested junction is still recognised (never silently mis-read as real). */
export function isReparsePoint(p: string): boolean {
  try {
    return lstatSync(longPath(p)).isSymbolicLink();
  } catch {
    return false; // does not exist (or unreadable) ⇒ not a reparse point to worry about
  }
}

/** Remove a junction/symlink at `p` WITHOUT recursing into its target — the whole point of this module.
 *  Refuses (throws) on a real directory so it can never delete an actual node_modules. */
export function unlinkReparsePoint(p: string): void {
  if (!isReparsePoint(p)) {
    throw new Error(`refusing to unlink ${p}: it is not a junction/symlink (a real directory would be deleted)`);
  }
  // unlink() removes a file/dir-symlink; a Windows junction is a directory reparse point that unlink
  // rejects (EPERM/EISDIR) — rmdir() removes the junction's reparse point WITHOUT recursing into the
  // target. NEVER use a recursive remove here: that is exactly the wipe this module prevents.
  try {
    unlinkSync(longPath(p));
  } catch {
    rmdirSync(longPath(p));
  }
}

/** lstat that returns null for a missing/unreadable path instead of throwing (tolerates mid-walk races). */
function tryLstat(p: string): Stats | null {
  try {
    return lstatSync(longPath(p));
  } catch {
    return null;
  }
}

/** Delete a real file, clearing a read-only bit if that is what blocks the unlink. */
function forceUnlinkFile(p: string): void {
  try {
    unlinkSync(longPath(p));
  } catch {
    chmodSync(longPath(p), 0o666);
    unlinkSync(longPath(p));
  }
}

/** Junction-SAFE recursive delete: lstat every entry, UNLINK reparse points (NEVER recurse through a
 *  junction — the 2026-06-13 wipe hazard), recurse only real directories, delete real files (clearing a
 *  read-only bit if needed). Long-path tolerant on Windows. Idempotent — a missing path is a no-op. */
export function removeDirSafely(target: string): void {
  const st = tryLstat(target);
  if (!st) return; // already gone
  if (st.isSymbolicLink()) {
    unlinkReparsePoint(target); // a reparse point itself — unlink, never recurse
    return;
  }
  if (!st.isDirectory()) {
    forceUnlinkFile(target);
    return;
  }
  for (const name of readdirSync(longPath(target))) {
    const child = join(target, name);
    const cst = tryLstat(child);
    if (!cst) continue;
    if (cst.isSymbolicLink()) unlinkReparsePoint(child);
    else if (cst.isDirectory()) removeDirSafely(child);
    else forceUnlinkFile(child);
  }
  rmdirSync(longPath(target));
}

/** Extract the worktree paths from `git worktree list --porcelain` output (the lines beginning
 *  `worktree `). Pure — split out from the git call so it is unit-testable without a repo. */
export function parseWorktreePorcelain(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean);
}

/** Canonical key for cross-referencing git's worktree paths against filesystem paths: absolute,
 *  forward-slashed, and lowercased on case-insensitive Windows so the two spellings compare equal. */
export function canonical(p: string): string {
  const r = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** An orphan is a directory under a worktree root that git no longer tracks. We require BOTH signals —
 *  absent from `git worktree list` AND missing the `.git` link file every live linked worktree has — so
 *  a path-normalization miss alone can never delete a registered worktree with real work in it. */
export function isOrphanWorktreeDir(dir: string, registeredCanonical: Set<string>): boolean {
  if (registeredCanonical.has(canonical(dir))) return false;
  if (existsSync(join(dir, '.git'))) return false;
  return true;
}

function git(args: string[], cwd?: string): void {
  execFileSync('git', args, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
}

function npmInstall(cwd: string): void {
  // npm on Windows is npm.cmd; shell:true lets execFileSync resolve it.
  execFileSync('npm', ['install'], { stdio: 'inherit', cwd, shell: true });
}

/** Registered worktree paths for the repo at `repoRoot`, via `git worktree list --porcelain`. */
export function listRegisteredWorktrees(repoRoot: string): string[] {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  return parseWorktreePorcelain(out);
}

function add(path: string, base = 'origin/main', newBranch?: string): void {
  const args = newBranch ? ['worktree', 'add', '-b', newBranch, path, base] : ['worktree', 'add', path, base];
  git(args);
  console.log(`installing real dependencies in ${path} (no junction) …`);
  npmInstall(path);
  console.log(`✓ worktree ready at ${path} with its own node_modules`);
}

function remove(path: string): void {
  const nm = join(path, 'node_modules');
  if (isReparsePoint(nm)) {
    unlinkReparsePoint(nm);
    console.log(`unlinked junctioned node_modules at ${nm} (target left intact)`);
  }
  // NO --force: a junction is already gone; any remaining refusal means real uncommitted content
  // the caller must resolve, never bulldoze.
  git(['worktree', 'remove', path]);
  console.log(`✓ removed worktree ${path}`);
}

/** Sweep every worktree root for orphaned dirs `git worktree remove` cannot touch and delete them
 *  junction-safely. Returns the dirs pruned (or that WOULD be pruned, under dryRun). A single stuck
 *  orphan (locked file) is logged and skipped — it never aborts the rest of the sweep. */
export function prune(repoRoot: string = process.cwd(), opts: { dryRun?: boolean } = {}): string[] {
  // git-native: drop admin metadata for worktrees whose dirs vanished. Mutates .git state, so it is
  // gated out of --dry-run (which must be side-effect-free).
  if (!opts.dryRun) git(['worktree', 'prune'], repoRoot);
  const registered = new Set(listRegisteredWorktrees(repoRoot).map(canonical));
  const pruned: string[] = [];
  const failed: string[] = [];
  for (const root of WORKTREE_ROOTS) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const dir = join(abs, name);
      const s = tryLstat(dir);
      if (!s || s.isSymbolicLink() || !s.isDirectory()) continue; // only ever sweep real directories
      if (!isOrphanWorktreeDir(dir, registered)) continue; // leave live/registered worktrees alone
      if (opts.dryRun) {
        console.log(`[dry-run] would prune orphan worktree dir ${dir}`);
        pruned.push(dir);
        continue;
      }
      try {
        removeDirSafely(dir);
        console.log(`✓ pruned orphan worktree dir ${dir}`);
        pruned.push(dir);
      } catch (err) {
        failed.push(dir);
        console.error(`✗ could not fully prune ${dir}: ${(err as Error).message} (a file may be locked by a running process)`);
      }
    }
  }
  if (!pruned.length && !failed.length) console.log('no orphan worktree dirs found');
  if (failed.length) console.error(`${failed.length} orphan dir(s) could not be fully removed — rerun after the holding process exits`);
  return pruned;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'add' && rest[0]) {
    add(rest[0], rest[1], rest[2]);
    return 0;
  }
  if (cmd === 'remove' && rest[0]) {
    remove(rest[0]);
    return 0;
  }
  if (cmd === 'prune') {
    prune(process.cwd(), { dryRun: rest.includes('--dry-run') });
    return 0;
  }
  console.error('usage: safe-worktree <add <path> [base-ref] [new-branch] | remove <path> | prune [--dry-run]>');
  return 1;
}

// Run the CLI only when this file is the invoked entry point — importing it (e.g. from the test
// runner) must NOT trigger git/npm side effects. When vitest imports the module, argv[1] is the
// runner's binary, not this file, so the CLI stays dormant.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/safe-worktree.ts')) {
  process.exit(main(process.argv.slice(2)));
}
