import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';

/**
 * Regression guard for test-run contamination of the TRACKED files under data/.
 *
 * data/snapshots/portfolio.json is auto-committed and auto-pushed to origin/main by the
 * ora-lease-snapshot-refresh / ora-cc-snapshot-refresh scheduled tasks, which decide whether to
 * commit from the working tree's state. So residue a test run leaves there is a real contamination
 * path into an unattended commit -- as well as a false positive for dirty-tree-triage and the
 * shared-checkout single-writer discipline.
 *
 * tests/setup.ts defaults every repo-data write target to a per-worker sandbox under os.tmpdir().
 * This pins that: if someone drops the override, or adds a fourth tracked data file with a new env
 * knob and forgets to sandbox it, this fails instead of the next full suite run silently dirtying
 * the shared checkout.
 */

const REPO = process.cwd();

/** True when `p` resolves inside this checkout (i.e. a write there would dirty the working tree). */
function insideRepo(p: string): boolean {
  const rel = relative(REPO, resolve(REPO, p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

describe('repo-data write isolation (tests/setup.ts)', () => {
  it.each([
    ['SNAPSHOT_PATH', 'data/snapshots/portfolio.json'],
    ['AR_MAPPING_CACHE', 'data/ar-mapping-cache.json'],
    // ar-import-headless.ts derives review-queue.json AND processed/ from dirname(AR_INBOX), so
    // sandboxing the inbox sandboxes all three tracked AR targets at once.
    ['AR_INBOX', 'data/ar/review-queue.json + data/ar/processed/'],
  ])('%s is redirected out of the repo (guards %s)', (envVar, guarded) => {
    const value = process.env[envVar];
    expect(value, `${envVar} must be set by tests/setup.ts to protect ${guarded}`).toBeTruthy();
    expect(insideRepo(value!), `${envVar}=${value} resolves inside the checkout`).toBe(false);
  });

  it('the tracked data files a test run could clobber still exist and are not the write target', () => {
    // Sanity: these are the real repo files the redirect exists to protect. If a rename ever moves
    // them, the env defaults above must move with them -- this catches the drift.
    for (const f of ['data/snapshots/portfolio.json', 'data/ar-mapping-cache.json', 'data/ar/review-queue.json']) {
      expect(existsSync(resolve(REPO, f)), `${f} missing -- update the sandbox defaults if it moved`).toBe(true);
    }
  });
});
