// scripts/ensure-local-data.ts
//
// Real firm data is never tracked (ruling 2026-11-10). Every path in
// scripts/fixtures/real-data-manifest.json is gitignored and local-only; a synthetic stand-in is
// committed at fixtures/synthetic/<same path>. This script copies the stand-ins into their runtime
// paths, under strict rules (refute run 2026-11-11):
//
//   - It only ever seeds a checkout that holds NO real manifest file at all (a fresh clone, CI, a
//     scratch worktree). If any real file is present, it seeds NOTHING and fails loudly naming the
//     missing files: synthetic records must never be mixed into real data (a missing pending queue or
//     one missing extraction next to real siblings would otherwise be back-filled with fakes).
//   - It only seeds in CI or a test run (CI=true, NODE_ENV=test, VITEST), or when explicitly opted in
//     with ORA_ALLOW_SYNTHETIC_SEED=1. On a developer machine the default is to fail loudly.
//   - It never overwrites. ORA_NO_SYNTHETIC_SEED=1 turns it into a no-op (the production mirror
//     build root and the snapshot-refresh worktrees use real copies and must never be seeded).
//
// Runs as `postinstall` and from the vitest globalSetup. One log line per file seeded; every seeded
// file is recorded in data/.synthetic-seeded.json (gitignored). Readers (server boot, reconcile,
// drift check, bake-mirror) detect synthetic files by content via server/real-data-status.ts.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_DIR, SEED_MARKER, isCiOrTest, isManifestPath, listFiles, loadManifest, realDataStatus } from '../server/real-data-status';

export { isManifestPath } from '../server/real-data-status';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface SeedResult {
  seeded: string[];
  present: string[];
}

/**
 * Seed the synthetic stand-ins where allowed. Throws (fail closed) when the manifest and the fixture
 * tree drift apart, when real and missing manifest files coexist, or when seeding is needed on a
 * machine that is not CI / test and has not opted in.
 */
export function ensureLocalData(root = ROOT, log: (line: string) => void = (l) => console.log(l), env: NodeJS.ProcessEnv = process.env): SeedResult {
  const m = loadManifest(root);
  const fixtureRoot = join(root, FIXTURE_DIR);
  const fixtures = listFiles(fixtureRoot).map((p) => relative(fixtureRoot, p).replace(/\\/g, '/'));
  const stray = fixtures.filter((f) => !isManifestPath(f, m));
  if (stray.length) throw new Error(`ensure-local-data: fixture(s) with no manifest entry: ${stray.join(', ')}`);
  const missingFixture = m.files.filter((f) => !fixtures.includes(f));
  if (missingFixture.length) throw new Error(`ensure-local-data: manifest file(s) with no synthetic fixture: ${missingFixture.join(', ')}`);
  const emptyDir = m.dirs.filter((d) => !fixtures.some((f) => f.startsWith(d)));
  if (emptyDir.length) throw new Error(`ensure-local-data: manifest dir(s) with no synthetic fixture: ${emptyDir.join(', ')}`);

  const result: SeedResult = { seeded: [], present: [] };
  if (env['ORA_NO_SYNTHETIC_SEED'] === '1') {
    log('[ensure-local-data] ORA_NO_SYNTHETIC_SEED=1 - seeding skipped');
    return result;
  }
  const status = realDataStatus(root);
  const absent = status.filter((s) => s.state === 'absent' && fixtures.includes(s.rel)).map((s) => s.rel);
  result.present = status.filter((s) => s.state !== 'absent').map((s) => s.rel);
  if (absent.length === 0) return result;

  const real = status.filter((s) => s.state === 'real').map((s) => s.rel);
  if (real.length) {
    throw new Error(
      `ensure-local-data: REFUSING to seed: this checkout holds real data (${real.length} file(s), e.g. ${real[0]}) but these ` +
        `manifest files are missing: ${absent.join(', ')}. Mixing synthetic records into real data is never done. Restore ` +
        'the missing real files (docs/ops/2026-11-11-real-data-untrack-pull-runbook.md), or run on a checkout with no real data.',
    );
  }
  if (!isCiOrTest(env) && env['ORA_ALLOW_SYNTHETIC_SEED'] !== '1') {
    throw new Error(
      `ensure-local-data: REFUSING to seed ${absent.length} synthetic file(s) outside CI / tests (e.g. ${absent[0]}). ` +
        'This checkout has no real firm data. Copy the real files in (docs/ops/2026-11-11-real-data-untrack-pull-runbook.md), ' +
        'or set ORA_ALLOW_SYNTHETIC_SEED=1 to run deliberately on synthetic stand-ins.',
    );
  }
  for (const rel of absent) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(fixtureRoot, rel), target);
    result.seeded.push(rel);
    log(`[ensure-local-data] seeded ${rel} from ${FIXTURE_DIR.replace(/\\/g, '/')}/ (synthetic)`);
  }
  const markerPath = join(root, SEED_MARKER);
  let prior: string[] = [];
  try {
    prior = existsSync(markerPath) ? ((JSON.parse(readFileSync(markerPath, 'utf8')) as { seeded?: string[] }).seeded ?? []) : [];
  } catch {
    prior = [];
  }
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ note: 'Synthetic stand-ins seeded by scripts/ensure-local-data.ts', seeded: [...new Set([...prior, ...result.seeded])].sort() }, null, 2) + '\n');
  return result;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/ensure-local-data.ts')) {
  try {
    ensureLocalData();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
