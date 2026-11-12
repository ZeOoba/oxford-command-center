// @vitest-environment node
//
// scripts/golden/leaserun-baseline.ts: golden:ratify checks the leaseRun lock against the figures the
// pre-untrack lease-run test pinned, read from a local copy (config/local) or git history, and fails
// closed when the baseline is missing or incomplete. Synthetic source and figures here.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXPECTED_PINNED_FIGURES,
  LOCAL_BASELINE_REL,
  compareToPinned,
  loadPinned,
  parsePinnedLeaseRun,
  pinnedFigureCount,
  writeLocalBaseline,
} from '../../scripts/golden/leaserun-baseline';

const block = (title: string, years: Array<[string, number]>, stab: number, value: number): string => `
describe('projectLeaseRun — ${title}', () => {
  const proj = projectLeaseRun(SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
  it('x', () => {
${years.map(([ly, n]) => `    expect(noiOf(proj.periods, "${ly}")).toBeCloseTo(${n}, 2);`).join('\n')}
    expect(proj.stabilizedNoi).toBeCloseTo(${stab}, 2);
    expect(proj.indicativeValue).toBeCloseTo(${value}, 2);
  });
});`;

const SOURCE =
  block('401 Sunburst (5,130 SF, absolute NNN)', [["LY '27", 1000.5], ["LY '28", 1000.5], ["LY '29", 2000.25], ["LY '34", 2100.75]], 1000.5, 12506.25) +
  block('7658 Fishel (24,000 SF, NNN)', [["LY '26", 3000], ["LY '27", 3100], ["LY '31", 3300.5], ["LY '36", 3600.25]], 3100, 38750) +
  `\ndescribe('engine math invariants', () => {\n  it('w', () => { expect(noiOf(proj.periods, "LY '99")).toBeCloseTo(9, 2); });\n});\n`;

const lockFrom = (src: string): Parameters<typeof compareToPinned>[0] => {
  const out: Parameters<typeof compareToPinned>[0] = {};
  for (const [id, p] of Object.entries(parsePinnedLeaseRun(src))) {
    out[id] = { stabilizedNoi: p.stabilizedNoi, indicativeValue: p.indicativeValue, noiByYear: { ...p.noiByYear, "LY '50": 1 }, periods: {} };
  }
  return out;
};

describe('leaseRun baseline check', () => {
  it('parses each pinned lease block (all 12 figures), and nothing from later blocks', () => {
    const p = parsePinnedLeaseRun(SOURCE);
    expect(Object.keys(p['401-sunburst-hwy-cambridge-md']!.noiByYear)).toEqual(["LY '27", "LY '28", "LY '29", "LY '34"]);
    expect(p['7658-fishel-dr-n-dublin-oh']!.indicativeValue).toBe(38750);
    expect(pinnedFigureCount(p)).toBe(EXPECTED_PINNED_FIGURES);
  });

  it('a lock that matches every pinned figure to the cent passes', () => {
    expect(compareToPinned(lockFrom(SOURCE), parsePinnedLeaseRun(SOURCE))).toEqual([]);
  });

  it('names every figure that drifted, and a property with no lock', () => {
    const lock = lockFrom(SOURCE);
    lock['401-sunburst-hwy-cambridge-md'] = { ...lock['401-sunburst-hwy-cambridge-md']!, stabilizedNoi: 1000.51 };
    lock['401-sunburst-hwy-cambridge-md']!.noiByYear["LY '29"] = 2001;
    expect(compareToPinned(lock, parsePinnedLeaseRun(SOURCE))).toEqual(["401-sunburst-hwy-cambridge-md LY '29 NOI", '401-sunburst-hwy-cambridge-md stabilized NOI']);
    const { ['7658-fishel-dr-n-dublin-oh']: _gone, ...partial } = lockFrom(SOURCE);
    expect(compareToPinned(partial, parsePinnedLeaseRun(SOURCE))).toContain('7658-fishel-dr-n-dublin-oh: no leaseRun lock');
  });

  it('a redacted source (figures replaced) is an incomplete baseline: a mismatch, never a pass', () => {
    const redacted = SOURCE.replace(/toBeCloseTo\(-?[\d.]+, 2\)/g, 'toBeCloseTo(***REMOVED***, 2)');
    const bad = compareToPinned(lockFrom(SOURCE), parsePinnedLeaseRun(redacted));
    expect(bad).toContain('401-sunburst-hwy-cambridge-md: baseline incomplete');
    expect(bad.some((b) => /of 12 figures/.test(b))).toBe(true);
    expect(compareToPinned(lockFrom(SOURCE), {})).not.toEqual([]);
  });

  it('the local baseline file takes precedence and is written create-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'leaserun-baseline-'));
    expect(loadPinned(root)).toBeNull(); // not a git clone, no local file: no baseline (ratify fails closed)
    expect(() => writeLocalBaseline(root)).toThrow(/not reachable/);
    const pinned = parsePinnedLeaseRun(SOURCE);
    mkdirSync(join(root, 'config', 'local'), { recursive: true });
    writeFileSync(join(root, LOCAL_BASELINE_REL), JSON.stringify(pinned));
    expect(loadPinned(root)).toEqual({ pinned, source: 'local file' });
    expect(writeLocalBaseline(root)).toMatch(/already exists/);
    expect(JSON.parse(readFileSync(join(root, LOCAL_BASELINE_REL), 'utf8'))).toEqual(pinned);
  });
});
