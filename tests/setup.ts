import '@testing-library/jest-dom/vitest';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type * as AcquisitionModule from '../server/warehouse/acquisition';

// ---- Replacement-Cost Table: synthetic in every test -------------------------------------------
// The ratified RCT is local-only (docs/ops/rct-runtime-config.md). In production, loadRatifiedRct() with no
// arguments refuses the synthetic stand-in and checks the keyed-HMAC pin, so the production callers
// (server/warehouse/api.ts acqConfig, capital-allocation's live regime) would fail closed in every test. Here,
// and only here, that no-argument call loads the committed synthetic stand-in instead, so the suite exercises
// the real routes and the BUY gate on invented figures, never the real table. A call with an explicit path or
// options (tests/unit/rct-runtime-config.test.ts) reaches the real loader unchanged, so its fail-closed paths
// stay tested. The bundled imports are aliased to the same stand-in in vitest.config.ts.
vi.mock('../server/warehouse/acquisition', async (importOriginal) => {
  const actual = await importOriginal<typeof AcquisitionModule>();
  const { syntheticRctLoader } = await import('./support/rct-loader');
  return { ...actual, loadRatifiedRct: syntheticRctLoader(actual.loadRatifiedRct) };
});

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
// The data files under data/ are the live machine's REAL firm data (local-only and gitignored since
// 2026-11-10: real data is never tracked; CI and fresh clones run on the synthetic stand-ins seeded
// from fixtures/synthetic/). A test that wrote into them would silently corrupt live data the app and
// the scheduled refresh tasks read, with no git history to restore it from.
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
// .json and data/ar/processed/ from dirname(AR_INBOX). OVERLAY_PATH is here for a different reason:
// data/overlay.json is gitignored, so it can never dirty the tree -- but it holds live user mutations
// (deal stages, tasks, notes, NOI budgets) and CLAUDE.md 9 calls it irreplaceable local state, so a
// stray saveOverlay() in a test would destroy real work with no git history to recover it from.
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
if (process.env.OVERLAY_PATH === undefined) {
  process.env.OVERLAY_PATH = join(dataSandbox, 'overlay.json');
}
// runBrief writes brief-health.json after every run. Several suites call it (brief-run,
// reference-date) with fixture clocks, so without this each local run overwrote the real
// data/brief-health.json that the Data Feeds "Daily brief" row reads (2026-07-09 fixture, 86d stale).
if (process.env.BRIEF_HEALTH_PATH === undefined) {
  process.env.BRIEF_HEALTH_PATH = join(dataSandbox, 'brief-health.json');
}
