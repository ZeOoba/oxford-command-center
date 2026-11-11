// scripts/ensure-local-data.ts
//
// Real firm data is never tracked (ruling 2026-11-10). Every path in
// scripts/fixtures/real-data-manifest.json is gitignored and local-only; a synthetic stand-in is
// committed at fixtures/synthetic/<same path>. This script seeds each stand-in into its runtime path
// ONLY IF the runtime file is absent. It never overwrites, so on a machine that has the real files
// (the shared live checkout) it is a no-op.
//
// Runs as `postinstall` (so `npm ci` in CI and on a fresh clone yields a working, synthetic data set)
// and from tests/setup.ts (so the suite works in a checkout where install ran before this existed).
// One log line per file seeded. Set ORA_NO_SYNTHETIC_SEED=1 to skip seeding entirely (e.g. on the
// live checkout while restoring real files, so a half-restored tree is never back-filled).
//
// Every file it seeds is recorded in data/.synthetic-seeded.json (gitignored) so a later reader can
// tell that this machine is running on synthetic stand-ins.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join('fixtures', 'synthetic');
const MARKER = join('data', '.synthetic-seeded.json');

interface Manifest {
  files: string[];
  dirs: string[];
}

function loadManifest(root: string): Manifest {
  const m = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'real-data-manifest.json'), 'utf8')) as Manifest;
  return { files: m.files, dirs: m.dirs };
}

/** True when `rel` (repo-relative, forward slashes) is a real-data path the manifest covers. */
export function isManifestPath(rel: string, m: Manifest): boolean {
  const p = rel.replace(/\\/g, '/');
  return m.files.includes(p) || m.dirs.some((d) => p.startsWith(d));
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

export interface SeedResult {
  seeded: string[];
  present: string[];
}

/**
 * Seed every synthetic stand-in whose runtime path is absent. Throws (fail closed) when a fixture
 * does not map to a manifest path, or a manifest file has no fixture — either means the two lists
 * drifted and a fresh clone would be missing data.
 */
export function ensureLocalData(root = ROOT, log: (line: string) => void = (l) => console.log(l)): SeedResult {
  const m = loadManifest(root);
  const fixtures = listFiles(join(root, FIXTURE_DIR)).map((p) => relative(join(root, FIXTURE_DIR), p).replace(/\\/g, '/'));
  const stray = fixtures.filter((f) => !isManifestPath(f, m));
  if (stray.length) throw new Error(`ensure-local-data: fixture(s) with no manifest entry: ${stray.join(', ')}`);
  const missing = m.files.filter((f) => !fixtures.includes(f));
  if (missing.length) throw new Error(`ensure-local-data: manifest file(s) with no synthetic fixture: ${missing.join(', ')}`);
  const empty = m.dirs.filter((d) => !fixtures.some((f) => f.startsWith(d)));
  if (empty.length) throw new Error(`ensure-local-data: manifest dir(s) with no synthetic fixture: ${empty.join(', ')}`);

  const result: SeedResult = { seeded: [], present: [] };
  if (process.env['ORA_NO_SYNTHETIC_SEED'] === '1') {
    log('[ensure-local-data] ORA_NO_SYNTHETIC_SEED=1 - seeding skipped');
    return result;
  }
  for (const rel of fixtures) {
    const target = join(root, rel);
    if (existsSync(target)) {
      result.present.push(rel);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, FIXTURE_DIR, rel), target);
    result.seeded.push(rel);
    log(`[ensure-local-data] seeded ${rel} from ${FIXTURE_DIR.replace(/\\/g, '/')}/ (synthetic)`);
  }
  if (result.seeded.length) {
    const markerPath = join(root, MARKER);
    let prior: string[] = [];
    try {
      prior = (JSON.parse(readFileSync(markerPath, 'utf8')) as { seeded?: string[] }).seeded ?? [];
    } catch {
      prior = [];
    }
    mkdirSync(dirname(markerPath), { recursive: true });
    const seeded = [...new Set([...prior, ...result.seeded])].sort();
    writeFileSync(markerPath, JSON.stringify({ note: 'Synthetic stand-ins seeded by scripts/ensure-local-data.ts', seeded }, null, 2) + '\n');
  }
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
