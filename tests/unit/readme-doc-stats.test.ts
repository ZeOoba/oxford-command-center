import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Keeps the counts README.md states from drifting away from the tree (repo-eval 2026-10-06 P0-4:
// README said "33 numbered SQL migrations" and "~420 Vitest test files" while the tree held 35 and
// 434). The numbers are COMPUTED here from the filesystem, never hand-maintained in this file.
//
// Migrations are asserted exactly: they change rarely and a new one should update the README in
// the same PR. The test-file count is asserted DIRECTIONALLY (README states a floor, "N+"), so
// adding tests never breaks this check; only a README floor above the real count does.

const root = process.cwd();
const readme = readFileSync(join(root, 'README.md'), 'utf8');

function migrationFiles(): string[] {
  return readdirSync(join(root, 'server', 'warehouse', 'migrations')).filter((f) =>
    f.endsWith('.sql'),
  );
}

function countUnitTestFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countUnitTestFiles(join(dir, e.name));
    else if (/\.(test|spec)\.tsx?$/.test(e.name)) n += 1;
  }
  return n;
}

describe('README.md stated counts match the tree', () => {
  it('directory table states the real migration-file count and highest migration number', () => {
    const m = /(\d+) SQL migration files in `warehouse\/migrations\/`, numbered 001-(\d{3})/.exec(
      readme,
    );
    expect(m, 'README directory-table migration sentence not found').not.toBeNull();
    const files = migrationFiles();
    const highest = files
      .map((f) => f.slice(0, 3))
      .sort()
      .at(-1);
    expect(Number(m![1])).toBe(files.length);
    expect(m![2]).toBe(highest);
  });

  it('architecture diagram states the same migration-file count and range', () => {
    const m = /(\d+) migration files \(001-(\d{3})\)/.exec(readme);
    expect(m, 'README diagram migration label not found').not.toBeNull();
    const files = migrationFiles();
    expect(Number(m![1])).toBe(files.length);
    expect(m![2]).toBe(
      files
        .map((f) => f.slice(0, 3))
        .sort()
        .at(-1),
    );
  });

  it('stated unit-test-file floor does not exceed the real count', () => {
    const m = /\((\d+)\+ Vitest test files\)/.exec(readme);
    expect(m, 'README "(N+ Vitest test files)" phrase not found').not.toBeNull();
    const actual = countUnitTestFiles(join(root, 'tests', 'unit'));
    expect(actual).toBeGreaterThanOrEqual(Number(m![1]));
  });
});
