import '@testing-library/jest-dom/vitest';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// server/briefing/confidential.ts fails loud when CONFIDENTIAL_TERMS_PATH is unreadable, by design
// (a confidentiality gate must fail closed, not silently scan a placebo). Point the whole suite at a
// git-tracked SYNTHETIC fixture (tests/fixtures/confidential-terms.synthetic.json -- no real deal data)
// so tests exercise the real matching logic instead of needing a real confidential-terms.json on the
// box. Individual tests may still override CONFIDENTIAL_TERMS_PATH per-test (save/restore) as several
// already do -- this only sets the suite-wide default.
if (process.env.CONFIDENTIAL_TERMS_PATH === undefined) {
  process.env.CONFIDENTIAL_TERMS_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'confidential-terms.synthetic.json',
  );
}

// ---- Repo-data write isolation ---------------------------------------------------------------
// The tracked files under data/ are real repo content, and data/snapshots/portfolio.json is
// auto-committed and auto-pushed to origin/main by the ora-lease-snapshot-refresh /
// ora-cc-snapshot-refresh scheduled tasks. Anything a test run leaves in the working tree there is
// therefore a contamination path into an unattended commit, plus a false positive for
// dirty-tree-triage and the shared-checkout single-writer discipline.
//
// No test writes them today (verified 2026-08-24: full suite in an isolated worktree, with the real
// .env and data/overlay.json present, left `git status --short` empty). This is the guard that keeps
// it that way. Every repo-data write target defaults to a per-worker sandbox under os.tmpdir(), so a
// test that imports a CLI script with an unguarded top-level main(), or calls saveCache() /
// patchSnapshot() directly, writes to tmp instead of into the repo.
//
// Defaults ONLY -- a test that sets these itself (tests/unit/mapping-cache.test.ts) keeps its own
// value, and a real CLI/scheduled-task run never loads this file, so production paths are unchanged.
// AR_INBOX covers three tracked targets at once: ar-import-headless.ts derives data/ar/review-queue
// .json and data/ar/processed/ from dirname(AR_INBOX).
//
// Keyed by pid, not mkdtemp: setupFiles run once per test FILE, so a fresh mkdtemp here would leave
// one temp dir per file (~272) behind instead of one per worker.
const dataSandbox = join(tmpdir(), `ora-test-data-${process.pid}`);
if (process.env.SNAPSHOT_PATH === undefined) {
  process.env.SNAPSHOT_PATH = join(dataSandbox, 'snapshots', 'portfolio.json');
}
if (process.env.AR_MAPPING_CACHE === undefined) {
  process.env.AR_MAPPING_CACHE = join(dataSandbox, 'ar-mapping-cache.json');
}
if (process.env.AR_INBOX === undefined) {
  process.env.AR_INBOX = join(dataSandbox, 'ar', 'inbox');
}
