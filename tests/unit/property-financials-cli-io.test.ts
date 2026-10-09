// @vitest-environment node
//
// tests/unit/property-financials-cli-io.test.ts — refute finding F6: the refresh CLIs' --out guard
// (scripts/property-financials/lib/io.ts ensureOutDir) must not be bypassable by path spelling
// (case on Windows, `..` segments, UNC local-drive aliases; 8.3 short names go through the same
// realpathSync.native canonicalisation but are not reproducible in a temp dir, so they are not pinned
// here) and must refuse ANY checkout's committed data/property-financials directory, not only this
// worktree's. Runs against temp directories (removed afterwards): the committed files are never touched.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { COMMITTED_DIR, ensureOutDir } from '../../scripts/property-financials/lib/io';

const made: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function fakeCheckout(): { root: string; data: string } {
  const root = tmp('pf-io-');
  const data = join(root, 'data', 'property-financials');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'dataset.json'), '{}');
  writeFileSync(join(data, 'monthly-long.csv'), 'x\n');
  return { root, data };
}

describe('F6: ensureOutDir refuses the committed dataset directory however it is spelled', () => {
  it('the exact committed path (and a child of it) is refused', () => {
    const { data } = fakeCheckout();
    expect(() => ensureOutDir(data, data)).toThrow(/refusing to write into/);
    expect(() => ensureOutDir(join(data, 'sub'), data)).toThrow(/refusing to write into/);
    expect(existsSync(join(data, 'sub'))).toBe(false);
  });

  it('a `..` detour is refused', () => {
    const { root, data } = fakeCheckout();
    expect(() => ensureOutDir(join(root, 'data', 'x', '..', 'property-financials'), data)).toThrow(/refusing to write into/);
  });

  it.runIf(process.platform === 'win32')('a different letter case is refused on Windows (case-insensitive file system)', () => {
    const { data } = fakeCheckout();
    expect(() => ensureOutDir(data.toUpperCase(), data)).toThrow(/refusing to write into/);
    expect(() => ensureOutDir(data.toLowerCase(), data)).toThrow(/refusing to write into/);
    expect(() => ensureOutDir(COMMITTED_DIR.toUpperCase())).toThrow(/refusing to write into/);
  });

  it("another checkout's data/property-financials holding dataset.json or monthly-long.csv is refused", () => {
    const other = fakeCheckout();
    const mine = fakeCheckout();
    expect(() => ensureOutDir(other.data, mine.data)).toThrow(/already holds a committed dataset file/);
    // only the CSV present is enough
    const csvOnly = tmp('pf-io-');
    const d = join(csvOnly, 'Data', 'Property-Financials');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'monthly-long.csv'), 'x\n');
    expect(() => ensureOutDir(d, mine.data)).toThrow(/already holds a committed dataset file/);
  });

  it('a new subdirectory under ANY committed data/property-financials is refused (not only the dir itself)', () => {
    const other = fakeCheckout();
    const mine = fakeCheckout();
    expect(() => ensureOutDir(join(other.data, 'newsub'), mine.data)).toThrow(/already holds a committed dataset file/);
    expect(existsSync(join(other.data, 'newsub'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('a UNC admin-share spelling of a committed dir (or a new child of it) is refused', () => {
    const { data } = fakeCheckout();
    const unc = `\\\\localhost\\${data.slice(0, 1)}$${data.slice(2)}`;
    if (!existsSync(unc)) return; // admin shares disabled on this machine: nothing to bypass with
    expect(() => ensureOutDir(unc, data)).toThrow(/refusing to write into/);
    expect(() => ensureOutDir(`${unc}\\newsub`, data)).toThrow(/refusing to write into/);
    expect(existsSync(join(data, 'newsub'))).toBe(false);
  });

  it('an ordinary out directory is created and returned; an empty */data/property-financials is allowed', () => {
    const { data } = fakeCheckout();
    const out = join(tmp('pf-io-out-'), 'nested', '_out');
    expect(ensureOutDir(out, data)).toBe(out);
    expect(existsSync(out)).toBe(true);
    const emptyData = join(tmp('pf-io-'), 'data', 'property-financials');
    expect(ensureOutDir(emptyData, data)).toBe(emptyData);
  });
});
