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
//       target), then `git worktree remove <path>` WITHOUT --force.
//
// Invoke: `npx tsx scripts/safe-worktree.ts <add|remove> ...` (or `npm run worktree -- <add|remove> ...`).
import { execFileSync } from 'node:child_process';
import { lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** True iff `p` is a reparse point (Windows junction or a symlink) — NOT a real directory/file.
 *  Node's lstat reports junctions as symbolic links. Returns false for a non-existent path. */
export function isReparsePoint(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
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
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
}

function git(args: string[], cwd?: string): void {
  execFileSync('git', args, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
}

function npmInstall(cwd: string): void {
  // npm on Windows is npm.cmd; shell:true lets execFileSync resolve it.
  execFileSync('npm', ['install'], { stdio: 'inherit', cwd, shell: true });
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

function main(argv: string[]): number {
  const [cmd, path, base, branch] = argv;
  if (cmd === 'add' && path) { add(path, base, branch); return 0; }
  if (cmd === 'remove' && path) { remove(path); return 0; }
  console.error('usage: safe-worktree <add <path> [base-ref] [new-branch] | remove <path>>');
  return 1;
}

// Run the CLI only when this file is the invoked entry point — importing it (e.g. from the test
// runner) must NOT trigger git/npm side effects. When vitest imports the module, argv[1] is the
// runner's binary, not this file, so the CLI stays dormant.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/safe-worktree.ts')) {
  process.exit(main(process.argv.slice(2)));
}
