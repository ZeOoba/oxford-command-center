import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Regression guard for test-run contamination of the data files under data/.
 *
 * On the live machine these are the REAL firm data (local-only and gitignored since 2026-11-10: real
 * data is never tracked; CI and fresh clones run on synthetic stand-ins from fixtures/synthetic/).
 * The app and the scheduled refresh tasks read them, so residue a test run leaves there silently
 * corrupts live data with no git history to restore it from.
 *
 * tests/setup.ts defaults every repo-data write target to a per-worker sandbox under os.tmpdir().
 * This pins that: if someone drops the override, or adds a fourth tracked data file with a new env
 * knob and forgets to sandbox it, this fails instead of the next full suite run silently dirtying
 * the shared checkout.
 */

const REPO = process.cwd();

/** True when `p` resolves inside this checkout (i.e. a write there would dirty the working tree).
 *  The repo root itself (rel === '') counts as inside: an env var set to process.cwd() or '.' puts
 *  writes squarely in the checkout, so it must fail this guard rather than slip through as "safe". */
function insideRepo(p: string): boolean {
  const rel = relative(REPO, resolve(REPO, p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

describe('repo-data write isolation (tests/setup.ts)', () => {
  it('insideRepo() treats the checkout root itself as inside', () => {
    // Guarding the guard: an earlier version returned false for the repo root, so an env var set to
    // process.cwd() or '.' would have passed the assertions below while writing into the checkout.
    expect(insideRepo(REPO)).toBe(true);
    expect(insideRepo('.')).toBe(true);
    expect(insideRepo('data/snapshots/portfolio.json')).toBe(true);
    expect(insideRepo(tmpdir())).toBe(false);
  });

  it.each([
    ['SNAPSHOT_PATH', 'data/snapshots/portfolio.json'],
    ['AR_MAPPING_CACHE', 'data/ar-mapping-cache.json'],
    // ar-import-headless.ts derives review-queue.json AND processed/ from dirname(AR_INBOX), so
    // sandboxing the inbox sandboxes all three tracked AR targets at once.
    ['AR_INBOX', 'data/ar/review-queue.json + data/ar/processed/'],
    // Gitignored, so it can never dirty the tree -- but it is live user state (deal stages, tasks,
    // notes) with no git history to restore from, which makes a stray write worse, not better.
    ['OVERLAY_PATH', 'data/overlay.json'],
  ])('%s is redirected out of the repo (guards %s)', (envVar, guarded) => {
    const value = process.env[envVar];
    expect(value, `${envVar} must be set by tests/setup.ts to protect ${guarded}`).toBeTruthy();
    expect(insideRepo(value!), `${envVar}=${value} resolves inside the checkout`).toBe(false);
  });

  it('the data files a test run could clobber still exist and are not the write target', () => {
    // Sanity: these are the (local-only) data files the redirect exists to protect; vitest globalSetup
    // seeds the synthetic stand-ins where they are absent. If a rename ever moves them, the env
    // defaults above must move with them -- this catches the drift.
    for (const f of ['data/snapshots/portfolio.json', 'data/ar-mapping-cache.json', 'data/ar/review-queue.json']) {
      expect(existsSync(resolve(REPO, f)), `${f} missing -- update the sandbox defaults if it moved`).toBe(true);
    }
  });
});
