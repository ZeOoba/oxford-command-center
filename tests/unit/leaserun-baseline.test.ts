// @vitest-environment node
//
// scripts/golden/leaserun-baseline.ts: golden:ratify reads the pre-untrack lease-run test from git
// history and refuses a leaseRun lock that disagrees with its pinned figures. Synthetic source here.
import { describe, expect, it } from 'vitest';
import { compareToPinned, parsePinnedLeaseRun } from '../../scripts/golden/leaserun-baseline';

const SOURCE = `
describe('projectLeaseRun — 401 Sunburst (5,130 SF, absolute NNN)', () => {
  const proj = projectLeaseRun(SUNBURST_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
  it('x', () => {
    expect(noiOf(proj.periods, "LY '27")).toBeCloseTo(1000.5, 2);
    expect(noiOf(proj.periods, "LY '29")).toBeCloseTo(2000.25, 2);
  });
  it('y', () => {
    expect(proj.stabilizedNoi).toBeCloseTo(1000.5, 2);
    expect(proj.indicativeValue).toBeCloseTo(12506.25, 2);
  });
});
describe('projectLeaseRun — 7658 Fishel (24,000 SF, NNN)', () => {
  const proj = projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
  it('z', () => {
    expect(noiOf(proj.periods, "LY '26")).toBeCloseTo(3000, 2);
    expect(proj.stabilizedNoi).toBeCloseTo(3100, 2);
  });
});
describe('engine math invariants', () => {
  it('w', () => { expect(noiOf(proj.periods, "LY '99")).toBeCloseTo(9, 2); });
});
`;

const lock = {
  '401-sunburst-hwy-cambridge-md': { stabilizedNoi: 1000.5, indicativeValue: 12506.25, noiByYear: { "LY '27": 1000.5, "LY '29": 2000.25, "LY '30": 2000.25 } },
  '7658-fishel-dr-n-dublin-oh': { stabilizedNoi: 3100, indicativeValue: 38750, noiByYear: { "LY '26": 3000 } },
};

describe('leaseRun baseline check', () => {
  it('parses each pinned lease block, and nothing from later blocks', () => {
    const p = parsePinnedLeaseRun(SOURCE);
    expect(p['401-sunburst-hwy-cambridge-md']).toEqual({ noiByYear: { "LY '27": 1000.5, "LY '29": 2000.25 }, stabilizedNoi: 1000.5, indicativeValue: 12506.25 });
    expect(p['7658-fishel-dr-n-dublin-oh']).toEqual({ noiByYear: { "LY '26": 3000 }, stabilizedNoi: 3100, indicativeValue: null });
  });

  it('a lock that matches every pinned figure to the cent passes', () => {
    expect(compareToPinned(lock, parsePinnedLeaseRun(SOURCE))).toEqual([]);
  });

  it('names every figure that drifted, and a property with no lock', () => {
    const drift = { ...lock, '401-sunburst-hwy-cambridge-md': { ...lock['401-sunburst-hwy-cambridge-md'], stabilizedNoi: 1000.51, noiByYear: { "LY '27": 1000.5, "LY '29": 2001 } } };
    expect(compareToPinned(drift, parsePinnedLeaseRun(SOURCE))).toEqual(["401-sunburst-hwy-cambridge-md LY '29 NOI", '401-sunburst-hwy-cambridge-md stabilized NOI']);
    const { ['7658-fishel-dr-n-dublin-oh']: _gone, ...partial } = lock;
    expect(compareToPinned(partial, parsePinnedLeaseRun(SOURCE))).toContain('7658-fishel-dr-n-dublin-oh: no leaseRun lock');
  });
});
