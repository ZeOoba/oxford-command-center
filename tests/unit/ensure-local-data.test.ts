// @vitest-environment node
//
// scripts/ensure-local-data.ts seeds the committed synthetic stand-ins (fixtures/synthetic/<path>)
// into the real-data runtime paths (ruling 2026-11-10: real firm data is never tracked) under strict
// rules (refute run 2026-11-11): only on a checkout with NO real manifest file, only in CI / tests or
// with an explicit opt-in, never overwriting, never mixing synthetic files in beside real ones, and
// failing closed when the manifest and the fixture tree drift apart.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureLocalData, isManifestPath } from '../../scripts/ensure-local-data';
import { realDataStatus, refuseIfSynthetic, syntheticDataFlags, syntheticInUse, syntheticNotice } from '../../server/real-data-status';

let root: string;
const write = (rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const manifest = (files: string[], dirs: string[]): void => write('scripts/fixtures/real-data-manifest.json', JSON.stringify({ files, dirs }));
const CI = { CI: 'true' } as NodeJS.ProcessEnv;
const DEV = {} as NodeJS.ProcessEnv;
const quiet = (): void => {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ensure-local-data-'));
  manifest(['data/snapshots/portfolio.json'], ['data/calibration/']);
  write('fixtures/synthetic/data/snapshots/portfolio.json', '{"synthetic":true}\n');
  write('fixtures/synthetic/data/calibration/observations.json', '[]\n');
  write('fixtures/synthetic/data/calibration/calibration_pending.json', '[]\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ensureLocalData', () => {
  it('in CI on a checkout with no real data: seeds every file, one log line each, and records them', () => {
    const lines: string[] = [];
    const r = ensureLocalData(root, (l) => lines.push(l), CI);
    expect(r.seeded.sort()).toEqual(['data/calibration/calibration_pending.json', 'data/calibration/observations.json', 'data/snapshots/portfolio.json']);
    expect(lines).toHaveLength(3);
    expect(readFileSync(join(root, 'data/snapshots/portfolio.json'), 'utf8')).toBe('{"synthetic":true}\n');
    expect(JSON.parse(readFileSync(join(root, 'data/.synthetic-seeded.json'), 'utf8')).seeded).toHaveLength(3);
    expect(syntheticInUse(root)).toHaveLength(3);
  });

  it('on a developer machine it REFUSES by default (fails loudly) and seeds nothing', () => {
    expect(() => ensureLocalData(root, quiet, DEV)).toThrow(/REFUSING to seed .* outside CI/);
    expect(existsSync(join(root, 'data/snapshots/portfolio.json'))).toBe(false);
    expect(ensureLocalData(root, quiet, { ORA_ALLOW_SYNTHETIC_SEED: '1' } as NodeJS.ProcessEnv).seeded).toHaveLength(3);
  });

  it('NEVER mixes: any real manifest file present means nothing is seeded, even in CI', () => {
    write('data/snapshots/portfolio.json', '{"real":true}\n');
    expect(() => ensureLocalData(root, quiet, CI)).toThrow(/REFUSING to seed: this checkout holds real data/);
    expect(existsSync(join(root, 'data/calibration/observations.json'))).toBe(false);
    expect(readFileSync(join(root, 'data/snapshots/portfolio.json'), 'utf8')).toBe('{"real":true}\n');
  });

  it('never back-fills a partially present real directory', () => {
    write('data/calibration/observations.json', '[{"real":1}]\n');
    write('data/snapshots/portfolio.json', '{"real":true}\n');
    expect(() => ensureLocalData(root, quiet, CI)).toThrow(/calibration_pending\.json/);
    expect(existsSync(join(root, 'data/calibration/calibration_pending.json'))).toBe(false);
  });

  it('a complete real checkout is a no-op, and a second CI run is a no-op', () => {
    ensureLocalData(root, quiet, CI);
    expect(ensureLocalData(root, quiet, CI).seeded).toEqual([]);
    const statuses = realDataStatus(root).map((s) => s.state);
    expect(statuses.every((s) => s === 'synthetic')).toBe(true);
  });

  it('ORA_NO_SYNTHETIC_SEED=1 skips seeding entirely', () => {
    expect(ensureLocalData(root, quiet, { CI: 'true', ORA_NO_SYNTHETIC_SEED: '1' } as NodeJS.ProcessEnv).seeded).toEqual([]);
    expect(existsSync(join(root, 'data/snapshots/portfolio.json'))).toBe(false);
  });

  it('fails closed on drift: a fixture with no manifest entry, a manifest file or dir with no fixture', () => {
    write('fixtures/synthetic/data/stray.json', '{}');
    expect(() => ensureLocalData(root, quiet, CI)).toThrow(/no manifest entry: data\/stray\.json/);
    rmSync(join(root, 'fixtures/synthetic/data/stray.json'));
    manifest(['data/snapshots/portfolio.json', 'data/missing.json'], ['data/calibration/']);
    expect(() => ensureLocalData(root, quiet, CI)).toThrow(/no synthetic fixture: data\/missing\.json/);
    manifest(['data/snapshots/portfolio.json'], ['data/calibration/', 'data/empty/']);
    expect(() => ensureLocalData(root, quiet, CI)).toThrow(/dir\(s\) with no synthetic fixture: data\/empty\//);
  });

  it('isManifestPath matches exact files and directory prefixes, case-insensitively, never fixtures/synthetic/', () => {
    const m = { files: ['src/data/seed-deals.ts'], dirs: ['data/building-specs/'] };
    expect(isManifestPath('src/data/seed-deals.ts', m)).toBe(true);
    expect(isManifestPath('SRC/Data/Seed-Deals.ts', m)).toBe(true);
    expect(isManifestPath('data\\building-specs\\reports.json', m)).toBe(true);
    expect(isManifestPath('./Data/Building-Specs/R01.json', m)).toBe(true);
    expect(isManifestPath('src/data/seed-deals.test.ts', m)).toBe(false);
    expect(isManifestPath('data/building-specs-old/x.json', m)).toBe(false);
    expect(isManifestPath('fixtures/synthetic/src/data/seed-deals.ts', m)).toBe(false);
  });

  it('readers see synthetic stand-ins: banner + error flags + refusal outside CI/tests, silence in CI', () => {
    ensureLocalData(root, quiet, CI);
    expect(syntheticNotice('Brain Server', root, CI)).toBeNull();
    expect(syntheticDataFlags(root, CI)).toEqual([]);
    expect(() => refuseIfSynthetic('bake-mirror', root, CI)).not.toThrow();
    const notice = syntheticNotice('Brain Server', root, DEV);
    expect(notice).toMatch(/RUNNING ON SYNTHETIC STAND-IN DATA/);
    expect(notice).toContain('data/snapshots/portfolio.json');
    const flags = syntheticDataFlags(root, DEV);
    expect(flags.length).toBe(3);
    expect(flags.every((f) => f.severity === 'error')).toBe(true);
    expect(() => refuseIfSynthetic('bake-mirror', root, DEV)).toThrow(/REFUSING to run on synthetic stand-in data/);
    // a real file (different bytes) is not reported
    write('data/snapshots/portfolio.json', '{"real":true}\n');
    expect(syntheticDataFlags(root, DEV).map((f) => f.field)).not.toContain('data/snapshots/portfolio.json');
  });

  it("the repo's own manifest and fixture tree agree (every manifest path has a synthetic stand-in)", () => {
    // The validation runs before any seeding decision; ORA_NO_SYNTHETIC_SEED keeps this a pure check.
    expect(() => ensureLocalData(process.cwd(), quiet, { ORA_NO_SYNTHETIC_SEED: '1' } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
