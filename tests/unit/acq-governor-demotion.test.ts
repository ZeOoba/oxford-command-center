// @vitest-environment node
//
// Display rule for a governor-demoted acquisition score (src/analytics/acq-governor-demotion.ts):
// the persisted VERDICT decides where a row displays; a T1/T2 tier beside a PASS verdict is marked.
import { describe, expect, it } from 'vitest';
import { effectiveTier, governorDemotedLabel, isGovernorDemoted, preDemotionTier } from '../../src/analytics/acq-governor-demotion';

// The exact reason shape applyGovernorProxyToScore appends (server/warehouse/acq-governor-proxy.ts).
const DEMOTION_T1 = 'Governor demotion: PURSUE → PASS (tier T1 → PASS) — DSCR proxy failed or the live governor set is invalid.';
const DEMOTION_T2 = 'Governor demotion: WATCH → PASS (tier T2 → PASS) — LTV proxy failed.';

describe('effectiveTier', () => {
  it('follows the verdict when one is present', () => {
    expect(effectiveTier({ tier: 'T1', verdict: 'PASS' })).toBe('PASS');
    expect(effectiveTier({ tier: 'T1', verdict: 'PURSUE' })).toBe('T1');
    expect(effectiveTier({ tier: 'T2', verdict: 'WATCH' })).toBe('T2');
    expect(effectiveTier({ tier: 'PASS', verdict: 'KILLED' })).toBe('KILLED');
  });

  it('falls back to the persisted tier without a verdict, and null when unscored', () => {
    expect(effectiveTier({ tier: 'T2', verdict: null })).toBe('T2');
    expect(effectiveTier(null)).toBeNull();
    expect(effectiveTier(undefined)).toBeNull();
  });
});

describe('isGovernorDemoted / governorDemotedLabel', () => {
  it('flags a T1 or T2 tier beside a PASS verdict', () => {
    expect(isGovernorDemoted({ tier: 'T1', verdict: 'PASS' })).toBe(true);
    expect(isGovernorDemoted({ tier: 'T2', verdict: 'PASS' })).toBe(true);
    expect(governorDemotedLabel({ tier: 'T2', verdict: 'PASS' })).toBe('Governor-demoted (was T2)');
  });

  it('does not flag coherent rows, a kill, a missing verdict or an unscored row', () => {
    expect(isGovernorDemoted({ tier: 'T1', verdict: 'PURSUE' })).toBe(false);
    expect(isGovernorDemoted({ tier: 'PASS', verdict: 'PASS' })).toBe(false);
    expect(isGovernorDemoted({ tier: 'T1', verdict: 'KILLED' })).toBe(false);
    expect(isGovernorDemoted({ tier: 'T1', verdict: null })).toBe(false);
    expect(isGovernorDemoted(null)).toBe(false);
    expect(governorDemotedLabel({ tier: 'T1', verdict: 'PURSUE' })).toBeNull();
  });
});

describe('current-engine demotion shape (tier PASS + verdict PASS + "Governor demotion:" reason)', () => {
  it('is flagged and labelled with the tier parsed from the reason', () => {
    const t1 = { tier: 'PASS', verdict: 'PASS', reasons: ['Composite 80.6', DEMOTION_T1] } as const;
    const t2 = { tier: 'PASS', verdict: 'PASS', reasons: [DEMOTION_T2] } as const;
    expect(isGovernorDemoted(t1)).toBe(true);
    expect(preDemotionTier(t1)).toBe('T1');
    expect(governorDemotedLabel(t1)).toBe('Governor-demoted (was T1)');
    expect(governorDemotedLabel(t2)).toBe('Governor-demoted (was T2)');
    expect(effectiveTier(t1)).toBe('PASS');
  });

  it('a native PASS (no demotion reason) is not flagged', () => {
    expect(isGovernorDemoted({ tier: 'PASS', verdict: 'PASS', reasons: ['Composite 40.0'] })).toBe(false);
    expect(isGovernorDemoted({ tier: 'PASS', verdict: 'PASS', reasons: [] })).toBe(false);
  });

  it('the reason only counts beside a PASS verdict', () => {
    expect(isGovernorDemoted({ tier: 'T1', verdict: 'PURSUE', reasons: [DEMOTION_T1] })).toBe(false);
  });

  it('an unparseable reason still flags, with the plain label', () => {
    const s = { tier: 'PASS', verdict: 'PASS', reasons: ['Governor demotion: reworded'] } as const;
    expect(isGovernorDemoted(s)).toBe(true);
    expect(governorDemotedLabel(s)).toBe('Governor-demoted');
  });
});

describe('server-computed governorDemoted flag (pipeline items, no reasons)', () => {
  it('flags a PASS/PASS item the server marked, with the plain label', () => {
    const item = { tier: 'PASS', verdict: 'PASS', governorDemoted: true } as const;
    expect(isGovernorDemoted(item)).toBe(true);
    expect(governorDemotedLabel(item)).toBe('Governor-demoted');
  });

  it('a legacy item keeps the was-T1 label; absent or false flag on PASS/PASS is not demoted', () => {
    expect(governorDemotedLabel({ tier: 'T1', verdict: 'PASS', governorDemoted: true })).toBe('Governor-demoted (was T1)');
    expect(isGovernorDemoted({ tier: 'PASS', verdict: 'PASS', governorDemoted: false })).toBe(false);
    expect(isGovernorDemoted({ tier: 'PASS', verdict: 'PASS' })).toBe(false);
  });
});
