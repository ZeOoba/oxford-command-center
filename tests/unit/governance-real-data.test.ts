// @vitest-environment node
//
// Real firm data is never tracked (ruling 2026-11-10): scripts/governance-check.ts fails the gate when
// any path in scripts/fixtures/real-data-manifest.json is in the index, and fails closed when the
// manifest or the index cannot be read. Kept apart from governance-check.test.ts, which mocks node:fs.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRealDataUntracked } from '../../scripts/governance-check';

const REPO = process.cwd();

describe('governance: real firm data is never tracked (checkRealDataUntracked)', () => {
  it('passes on this checkout (no manifest path is tracked)', () => {
    const r = checkRealDataUntracked(REPO);
    expect(r.errors).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('fails on a tracked manifest file or a file under a manifest directory, naming each', () => {
    const r = checkRealDataUntracked(REPO, [
      'README.md',
      'data/snapshots/portfolio.json',
      'data/building-specs/extractions/R01.json',
      'src/data/seed-deals.ts',
    ]);
    expect(r.pass).toBe(false);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.join('\n')).toMatch(/REAL_DATA_TRACKED: data\/snapshots\/portfolio\.json/);
    expect(r.errors.join('\n')).toMatch(/data\/building-specs\/extractions\/R01\.json/);
    expect(r.errors.join('\n')).toMatch(/src\/data\/seed-deals\.ts/);
  });

  it('allows the synthetic stand-ins under fixtures/synthetic/ and Windows-style separators are normalized', () => {
    expect(checkRealDataUntracked(REPO, ['fixtures/synthetic/data/snapshots/portfolio.json', 'fixtures/synthetic/src/data/seed-deals.ts']).pass).toBe(true);
    expect(checkRealDataUntracked(REPO, ['data\\cost-seg\\cost-seg.json']).pass).toBe(false);
  });

  it('fails closed when the manifest is missing or lists nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-real-data-'));
    try {
      expect(checkRealDataUntracked(dir, []).errors[0]).toMatch(/REAL_DATA: .*unreadable/);
      mkdirSync(join(dir, 'scripts', 'fixtures'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'fixtures', 'real-data-manifest.json'), '{"files":[],"dirs":[]}');
      expect(checkRealDataUntracked(dir, []).pass).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the index cannot be listed (not a git checkout)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-real-data-nogit-'));
    try {
      mkdirSync(join(dir, 'scripts', 'fixtures'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'fixtures', 'real-data-manifest.json'), '{"files":["a.json"],"dirs":[]}');
      const r = checkRealDataUntracked(dir);
      expect(r.pass).toBe(false);
      expect(r.errors[0]).toMatch(/could not list tracked files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
