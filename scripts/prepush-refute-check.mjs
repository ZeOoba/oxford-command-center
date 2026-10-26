// scripts/prepush-refute-check.mjs
//
// Pre-push stage: run the per-commit refute-trailer gate CI runs (`npm run check:refute -- --strict`,
// scripts/check-refute-required.ts) on every branch the push updates, so a missing `Refute-Reviewed:`
// / `Refute-Skip:` trailer on a financial-decision commit stops the push locally instead of failing
// the PR's CI job after the push (and forcing a history rewrite on a shared branch). STRICTER than CI
// in two ways: the base is always origin/main (CI uses the PR's base branch), and it applies to every
// branch push, PR or not, so WIP financial commits need their trailer before they are pushed.
//
// Plain Node built-ins on purpose, like the other hook stages: the raw .git/hooks/pre-push wrapper
// runs with no npm context. The gate itself is TypeScript, so it is run through the repo's own tsx.
//
// Blocks ONLY on the checker's "unattested commits" verdict. Everything else warns and lets the push
// through (fail open): no tsx or check script in this checkout (e.g. a fresh worktree before `npm ci`),
// an origin/main that does not resolve, a shallow clone, a spawn error or signal, and ANY other
// non-zero exit. Under --strict the checker itself exits 1 on those tooling gaps (CI wants that), and a
// crashing tsx also exits 1, so the exit code alone cannot tell a verdict from a gap: this stage checks
// the base and shallow state itself up front and matches the verdict text. A false block here would
// push people to `git push --no-verify`, which also skips the confidentiality scanner.
//
// Reads git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. Skips
// deletions (all-zero local sha) and anything that is not a branch (tags carry no review trailer).
// A stale local `origin/main` can only widen the range when the branch merged a main newer than the
// local ref, so fetch first in that case.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ZERO_SHA = /^0+$/;
const SHA = /^[0-9a-f]{40,64}$/;
// The one message evaluate() prints for a real violation (check-refute-required.ts, "N of M commit(s)
// changing financial-decision source are unattested[ or unreadable]").
const VERDICT = /commit\(s\) changing financial-decision source are unattested/;

/** A reason the checker cannot give a trustworthy answer in this checkout, or undefined. */
function toolingGap(root, base) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    return `base '${base}' does not resolve (git fetch origin main)`;
  }
  try {
    if (git(['rev-parse', '--is-shallow-repository']) === 'true') return 'shallow clone (fetch full history)';
  } catch {
    return 'git could not report whether this clone is shallow';
  }
  return undefined;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function main() {
  const heads = [];
  for (const raw of readStdin().split('\n')) {
    const [, localSha, remoteRef] = raw.trim().split(/\s+/);
    if (!localSha || ZERO_SHA.test(localSha) || !SHA.test(localSha)) continue;
    if (!remoteRef || !remoteRef.startsWith('refs/heads/')) continue;
    heads.push(localSha);
  }
  if (heads.length === 0) process.exit(0);

  let root;
  try {
    root = repoRoot();
  } catch (err) {
    console.warn(`[prepush-refute-check] skipped: not a git checkout (${String(err.message).split('\n')[0]}).`);
    process.exit(0);
  }
  const script = join(root, 'scripts', 'check-refute-required.ts');
  const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(script) || !existsSync(tsxCli)) {
    console.warn(
      '[prepush-refute-check] skipped: tsx or scripts/check-refute-required.ts is missing in this checkout ' +
        "(run 'npm ci'). CI still runs the gate.",
    );
    process.exit(0);
  }

  const base = process.env['REFUTE_BASE'] || 'origin/main';
  const gap = toolingGap(root, base);
  if (gap) {
    console.warn(`[prepush-refute-check] skipped: ${gap}. CI still runs the gate.`);
    process.exit(0);
  }
  let blocked = false;
  for (const head of new Set(heads)) {
    const r = spawnSync(process.execPath, [tsxCli, script, '--strict', `--base=${base}`, `--head=${head}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error || r.status === null) {
      console.warn(`[prepush-refute-check] skipped ${head.slice(0, 12)}: could not run the checker (${r.error?.message ?? `signal ${r.signal}`}).`);
      continue;
    }
    if (r.status === 0) {
      if (r.stdout) console.log(r.stdout.trimEnd());
      if (r.stderr) console.warn(r.stderr.trimEnd());
      continue;
    }
    const text = `${r.stderr}\n${r.stdout}`;
    if (r.status === 1 && VERDICT.test(text)) {
      blocked = true;
      console.error(`\n✖  PUSH BLOCKED — refute-trailer gate (stricter than CI: base origin/main, every branch) for ${head.slice(0, 12)}:\n`);
      console.error((r.stderr || r.stdout).trimEnd());
      console.error(
        "\nIf the listed commits are already on main (a stale local origin/main), run 'git fetch origin main' and push again; " +
          'rewording commits that are already on main is not possible.',
      );
      continue;
    }
    // Not a verdict (a crash, a FAILED CLOSED tooling gap, an unresolvable --head): warn, do not block.
    console.warn(
      `[prepush-refute-check] skipped ${head.slice(0, 12)}: checker exited ${r.status} without an unattested-commits verdict.\n${(r.stderr || r.stdout || '').trimEnd()}`,
    );
  }
  if (blocked) process.exit(1);
  process.exit(0);
}

main();
