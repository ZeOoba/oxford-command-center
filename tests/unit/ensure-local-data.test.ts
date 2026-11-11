// @vitest-environment node
//
// scripts/ensure-local-data.ts seeds the committed synthetic stand-ins (fixtures/synthetic/<path>)
// into each real-data runtime path ONLY when the runtime file is absent (ruling 2026-11-10: real firm
// data is never tracked). It must never overwrite, and it must fail closed when the manifest and the
// fixture tree drift apart.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureLocalData, isManifestPath } from '../../scripts/ensure-local-data';

let root: string;
const write = (rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const manifest = (files: string[], dirs: string[]): void => write('scripts/fixtures/real-data-manifest.json', JSON.stringify({ files, dirs }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ensure-local-data-'));
  manifest(['data/snapshots/portfolio.json'], ['data/calibration/']);
  write('fixtures/synthetic/data/snapshots/portfolio.json', '{"synthetic":true}\n');
  write('fixtures/synthetic/data/calibration/observations.json', '[]\n');
});
afterEach(() => {
  delete process.env['ORA_NO_SYNTHETIC_SEED'];
  rmSync(root, { recursive: true, force: true });
});

describe('ensureLocalData', () => {
  it('seeds every absent runtime file, one log line each, and records them in the marker', () => {
    const lines: string[] = [];
    const r = ensureLocalData(root, (l) => lines.push(l));
    expect(r.seeded.sort()).toEqual(['data/calibration/observations.json', 'data/snapshots/portfolio.json']);
    expect(lines).toHaveLength(2);
    expect(readFileSync(join(root, 'data/snapshots/portfolio.json'), 'utf8')).toBe('{"synthetic":true}\n');
    expect(JSON.parse(readFileSync(join(root, 'data/.synthetic-seeded.json'), 'utf8')).seeded).toHaveLength(2);
  });

  it('NEVER overwrites a runtime file that exists (the real data on a live checkout)', () => {
    write('data/snapshots/portfolio.json', '{"real":true}\n');
    const r = ensureLocalData(root, () => {});
    expect(r.present).toEqual(['data/snapshots/portfolio.json']);
    expect(r.seeded).toEqual(['data/calibration/observations.json']);
    expect(readFileSync(join(root, 'data/snapshots/portfolio.json'), 'utf8')).toBe('{"real":true}\n');
  });

  it('is a no-op on the second run', () => {
    ensureLocalData(root, () => {});
    const lines: string[] = [];
    expect(ensureLocalData(root, (l) => lines.push(l)).seeded).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('ORA_NO_SYNTHETIC_SEED=1 skips seeding entirely', () => {
    process.env['ORA_NO_SYNTHETIC_SEED'] = '1';
    expect(ensureLocalData(root, () => {}).seeded).toEqual([]);
    expect(existsSync(join(root, 'data/snapshots/portfolio.json'))).toBe(false);
  });

  it('fails closed on drift: a fixture with no manifest entry, a manifest file or dir with no fixture', () => {
    write('fixtures/synthetic/data/stray.json', '{}');
    expect(() => ensureLocalData(root, () => {})).toThrow(/no manifest entry: data\/stray\.json/);
    rmSync(join(root, 'fixtures/synthetic/data/stray.json'));
    manifest(['data/snapshots/portfolio.json', 'data/missing.json'], ['data/calibration/']);
    expect(() => ensureLocalData(root, () => {})).toThrow(/no synthetic fixture: data\/missing\.json/);
    manifest(['data/snapshots/portfolio.json'], ['data/calibration/', 'data/empty/']);
    expect(() => ensureLocalData(root, () => {})).toThrow(/dir\(s\) with no synthetic fixture: data\/empty\//);
  });

  it('isManifestPath matches exact files and directory prefixes only', () => {
    const m = { files: ['src/data/seed-deals.ts'], dirs: ['data/building-specs/'] };
    expect(isManifestPath('src/data/seed-deals.ts', m)).toBe(true);
    expect(isManifestPath('data\\building-specs\\reports.json', m)).toBe(true);
    expect(isManifestPath('src/data/seed-deals.test.ts', m)).toBe(false);
    expect(isManifestPath('data/building-specs-old/x.json', m)).toBe(false);
  });

  it("the repo's own manifest and fixture tree agree (every manifest path has a synthetic stand-in)", () => {
    expect(() => ensureLocalData(process.cwd(), () => {})).not.toThrow();
  });
});
