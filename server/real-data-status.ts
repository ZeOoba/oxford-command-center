// server/real-data-status.ts
//
// Shared reader for the "real firm data is never tracked" model (ruling 2026-11-10):
// scripts/fixtures/real-data-manifest.json lists every real-data path; fixtures/synthetic/<path> holds
// the committed synthetic stand-in. A runtime file is SYNTHETIC when its bytes equal the stand-in (or
// it is listed in data/.synthetic-seeded.json and still unchanged), REAL when it differs, ABSENT when
// missing. Used by scripts/ensure-local-data.ts, the server boot banner, reconcile, the drift check,
// bake-mirror and the tests' golden selection. Node built-ins only.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DataQualityFlag } from '../src/contracts/common';

export interface RealDataManifest {
  files: string[];
  dirs: string[];
  /** Files that may be absent on a checkout holding real data (value locks, local operator tables). */
  optional?: string[];
}

export const FIXTURE_DIR = join('fixtures', 'synthetic');
export const SEED_MARKER = join('data', '.synthetic-seeded.json');

/** Normalized form used for every manifest comparison: forward slashes, no leading ./, lowercase. */
export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

export function loadManifest(root: string): RealDataManifest {
  const m = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'real-data-manifest.json'), 'utf8')) as RealDataManifest;
  return { files: m.files, dirs: m.dirs, optional: m.optional ?? [] };
}

/** True when `rel` is a real-data path the manifest covers (case-insensitive, either slash style). */
export function isManifestPath(rel: string, m: RealDataManifest): boolean {
  const p = normPath(rel);
  if (p.startsWith('fixtures/synthetic/')) return false;
  return m.files.some((f) => normPath(f) === p) || m.dirs.some((d) => p.startsWith(normPath(d)));
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export type FileState = 'absent' | 'synthetic' | 'real';

export interface PathStatus {
  /** Repo-relative path (forward slashes). */
  rel: string;
  state: FileState;
  /** The manifest directory this file belongs to, if any. */
  dir: string | null;
  /** Listed in the manifest's `optional` files. */
  optional: boolean;
}

/** Every manifest path that has a synthetic stand-in, plus every real file found under a manifest
 *  directory, with its state. */
export function realDataStatus(root: string): PathStatus[] {
  const m = loadManifest(root);
  const fixtureRoot = join(root, FIXTURE_DIR);
  const rels = new Set<string>(listFiles(fixtureRoot).map((p) => relative(fixtureRoot, p).replace(/\\/g, '/')));
  for (const d of m.dirs) for (const p of listFiles(join(root, d))) rels.add(relative(root, p).replace(/\\/g, '/'));
  for (const f of m.files) rels.add(f);
  const out: PathStatus[] = [];
  for (const rel of [...rels].sort()) {
    const target = join(root, rel);
    const fixture = join(fixtureRoot, rel);
    const dir = m.dirs.find((d) => normPath(rel).startsWith(normPath(d))) ?? null;
    let state: FileState = 'absent';
    if (existsSync(target)) state = existsSync(fixture) && sha(target) === sha(fixture) ? 'synthetic' : 'real';
    out.push({ rel, state, dir, optional: (m.optional ?? []).some((o) => normPath(o) === normPath(rel)) });
  }
  return out;
}

/** The manifest files currently in use that are synthetic stand-ins. */
export function syntheticInUse(root: string): string[] {
  return realDataStatus(root)
    .filter((s) => s.state === 'synthetic')
    .map((s) => s.rel);
}

/** True when this process is a CI or test run (where synthetic data is the expected state). */
export function isCiOrTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CI'] === 'true' || env['CI'] === '1' || env['NODE_ENV'] === 'test' || !!env['VITEST'];
}

/** One loud multi-line banner naming the synthetic files a reader is about to use. */
export function syntheticBanner(context: string, files: string[]): string {
  const bar = '!'.repeat(96);
  return [
    bar,
    `!! ${context}: RUNNING ON SYNTHETIC STAND-IN DATA, NOT THE FIRM'S REAL DATA`,
    ...files.map((f) => `!!   ${f}`),
    '!! These are the committed fixtures/synthetic/ copies (ruling 2026-11-10). Restore the real files',
    '!! (docs/ops/2026-11-11-real-data-untrack-pull-runbook.md) before trusting any figure.',
    bar,
  ].join('\n');
}

/** The synthetic manifest files in use, but only where that is NOT expected (outside CI / tests). */
function unexpectedSynthetic(root: string, env: NodeJS.ProcessEnv): string[] {
  if (isCiOrTest(env)) return [];
  try {
    return syntheticInUse(root);
  } catch {
    return [];
  }
}

/** A loud banner when this process is about to run on synthetic stand-ins outside CI / tests. */
export function syntheticNotice(context: string, root = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  const files = unexpectedSynthetic(root, env);
  return files.length ? syntheticBanner(context, files) : null;
}

/** Error-severity data-quality flags for the Brain snapshot when it is built on synthetic stand-ins. */
export function syntheticDataFlags(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): DataQualityFlag[] {
  return unexpectedSynthetic(root, env).map((f) => ({
    entity: 'data-source',
    field: f,
    issue: `${f} is the committed SYNTHETIC stand-in, not real firm data: restore the real file (docs/ops/2026-11-11-real-data-untrack-pull-runbook.md)`,
    severity: 'error' as const,
  }));
}

/** Writers and publishers (drift check, bake-mirror) refuse outright on synthetic stand-ins. */
export function refuseIfSynthetic(context: string, root = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const notice = syntheticNotice(context, root, env);
  if (notice) throw new Error(`${notice}\n${context}: REFUSING to run on synthetic stand-in data.`);
}
