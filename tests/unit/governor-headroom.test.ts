// tests/unit/governor-headroom.test.ts
//
// Design review 2026-10-31 finding 9: the Overview KPI strip's governor tiles (DSCR vs 1.25x, LTV vs
// 40%, total cash vs the $1.5M firm floor). Pins the new ratified cash-floor constant, proves the
// existing governors are untouched, and pins the pure headroom math the tiles render.
import { describe, expect, it } from 'vitest';
import type { Property } from '../../src/contracts/index';
import { RATIFIED_GOVERNORS, LIQUIDITY_POLICY, assertLiquidityPolicy, GOVERNOR_FALLBACK } from '../../src/contracts/index';
import { dscrHeadroom, ltvHeadroom, cashHeadroom, firmCashBalance } from '../../src/analytics/governor-headroom';

const base = {
  index: 1, address: '1 Test Way', city: null, state: null, market: 'Columbus OH', type: 'Flex',
  sf: 10_000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 1_000_000,
  grossIncome: 0, expenses: 0, noiScenarioAdj: 0, netCashFlow: 0, capRate: null, ltv: null, valuePerSf: null,
  rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: true, flags: [],
};
const prop = (o: Partial<Property> & Pick<Property, 'id' | 'name' | 'noi' | 'debtService' | 'dscr' | 'lender' | 'loanBalance'>): Property =>
  ({ ...base, ...o }) as Property;

describe('ratified constants', () => {
  it('carries the $1.5M firm cash floor (ratified 2026-09-18) in config/liquidity-policy.v1.json', () => {
    expect(LIQUIDITY_POLICY.firmCashFloorUsd).toBe(1_500_000);
    expect(LIQUIDITY_POLICY.ratifiedOn).toBe('2026-09-18');
  });

  it('fails closed on a malformed policy document', () => {
    const ok = { version: 1, ratifiedOn: '2026-09-18', ratifiedBy: 'Gabriel Goldberg', firmCashFloorUsd: 1_500_000 };
    expect(assertLiquidityPolicy(ok).firmCashFloorUsd).toBe(1_500_000);
    expect(() => assertLiquidityPolicy({ ...ok, firmCashFloorUsd: undefined })).toThrow(/fail closed/);
    expect(() => assertLiquidityPolicy({ ...ok, firmCashFloorUsd: -1 })).toThrow(/fail closed/);
    expect(() => assertLiquidityPolicy({ ...ok, version: 2 })).toThrow(/fail closed/);
    expect(() => assertLiquidityPolicy({ ...ok, extra: 1 })).toThrow(/fail closed/);
  });

  it('leaves the existing governors untouched (Invariant 4)', () => {
    expect(RATIFIED_GOVERNORS.dscrFloor).toBe(1.25);
    expect(RATIFIED_GOVERNORS.ltvCeiling).toBe(0.4);
    expect(GOVERNOR_FALLBACK.dscrFloor).toBe(1.25);
    expect(GOVERNOR_FALLBACK.ltvCeiling).toBe(0.4);
    expect(Object.keys(RATIFIED_GOVERNORS)).not.toContain('firmCashFloorUsd');
  });
});

describe('dscrHeadroom', () => {
  const a = prop({ id: 'a', name: 'Alpha', noi: 300_000, debtService: 150_000, dscr: 2.0, lender: 'Symetra', loanBalance: 2_000_000 });
  const b = prop({ id: 'b', name: 'Bravo', noi: 120_000, debtService: 100_000, dscr: 1.2, lender: 'Huntington', loanBalance: 1_000_000 });
  const unlevered = prop({ id: 'u', name: 'Free & Clear', noi: 500_000, debtService: 0, dscr: null, lender: null, loanBalance: 0 });
  const affiliate = prop({ id: 'f', name: 'Affiliate', noi: 10_000, debtService: 50_000, dscr: 0.2, lender: 'Oxford Capital', loanBalance: 400_000 });
  const residence = prop({ id: 'r', name: 'Residence', type: 'Residence', noi: 0, debtService: 40_000, dscr: 0, lender: 'Bank', loanBalance: 500_000 });

  it('aggregates Σ NOI / Σ debt service over levered investment properties, affiliate notes INCLUDED', () => {
    // Split basis ratified 2026-09-27 (src/analytics/debt-basis.ts header): affiliate debt service
    // stays in DSCR. Unlevered NOI and the residence are out.
    const h = dscrHeadroom([a, b, unlevered, affiliate, residence], 1.25);
    // (300k + 120k + 10k) / (150k + 100k + 50k) = 1.4333…
    expect(h.portfolio).toBeCloseTo(430 / 300, 10);
    expect(h.leveredCount).toBe(3);
    expect(h.breached).toBe(false);
  });

  it('names the weakest levered property (an affiliate-note row included) and flags it below the floor', () => {
    expect(dscrHeadroom([a, b], 1.25).weakest).toEqual({ id: 'b', name: 'Bravo', dscr: 1.2 });
    const h = dscrHeadroom([a, b, affiliate], 1.25);
    expect(h.weakest).toEqual({ id: 'f', name: 'Affiliate', dscr: 0.2 });
    expect(h.weakestBelowFloor).toBe(true);
  });

  it('picks the weakest on the workbook DSCR field the alerts read; a blank cell still counts in the aggregate', () => {
    const blank = prop({ id: 'k', name: 'Blank', noi: 90_000, debtService: 100_000, dscr: null, lender: 'Bank', loanBalance: 800_000 });
    const h = dscrHeadroom([a, blank], 1.25);
    expect(h.weakest).toEqual({ id: 'a', name: 'Alpha', dscr: 2.0 });
    expect(h.portfolio).toBeCloseTo(390 / 250, 10);
    expect(h.leveredCount).toBe(2);
  });

  it('is independent of array order (aggregate and weakest tie-break)', () => {
    const twin = prop({ id: 'a2', name: 'Alpha Twin', noi: 200_000, debtService: 100_000, dscr: 2.0, lender: 'Bank', loanBalance: 1 });
    const fwd = dscrHeadroom([twin, a], 1.25);
    const rev = dscrHeadroom([a, twin], 1.25);
    expect(fwd).toEqual(rev);
    expect(fwd.weakest?.id).toBe('a');
  });

  it('breaches when the aggregate is strictly below the floor (alert-engine semantics)', () => {
    const low = prop({ id: 'l', name: 'Low', noi: 110_000, debtService: 100_000, dscr: 1.1, lender: 'Bank', loanBalance: 900_000 });
    expect(dscrHeadroom([low], 1.25).breached).toBe(true);
    const atFloor = prop({ id: 'e', name: 'Even', noi: 125_000, debtService: 100_000, dscr: 1.25, lender: 'Bank', loanBalance: 900_000 });
    const h = dscrHeadroom([atFloor], 1.25);
    expect(h.breached).toBe(false);
    expect(h.weakestBelowFloor).toBe(false);
  });

  it('returns nulls (never a fabricated figure) when nothing is levered', () => {
    const h = dscrHeadroom([unlevered, residence], 1.25);
    expect(h.portfolio).toBeNull();
    expect(h.weakest).toBeNull();
    expect(h.leveredCount).toBe(0);
    expect(h.breached).toBe(false);
    expect(h.weakestBelowFloor).toBe(false);
  });

  it('skips non-finite rows instead of poisoning the aggregate', () => {
    const bad = prop({ id: 'x', name: 'Bad', noi: Number.NaN, debtService: 100_000, dscr: null, lender: 'Bank', loanBalance: 1 });
    const h = dscrHeadroom([a, bad], 1.25);
    expect(h.portfolio).toBeCloseTo(2.0, 10);
    expect(h.leveredCount).toBe(1);
    expect(h.weakest?.id).toBe('a');
  });
});

describe('ltvHeadroom', () => {
  it('breaches only strictly above the ceiling', () => {
    expect(ltvHeadroom(0.38, 0.4).breached).toBe(false);
    expect(ltvHeadroom(0.4, 0.4).breached).toBe(false);
    expect(ltvHeadroom(0.41, 0.4).breached).toBe(true);
  });
  it('passes a missing LTV through as null, unbreached', () => {
    expect(ltvHeadroom(null, 0.4)).toEqual({ value: null, ceiling: 0.4, breached: false });
  });
});

describe('cashHeadroom', () => {
  it('reports the cushion over the floor and breaches strictly below it', () => {
    expect(cashHeadroom(2_000_000, 1_500_000)).toEqual({ value: 2_000_000, floor: 1_500_000, cushion: 500_000, breached: false });
    expect(cashHeadroom(1_500_000, 1_500_000).breached).toBe(false);
    expect(cashHeadroom(1_200_000, 1_500_000)).toEqual({ value: 1_200_000, floor: 1_500_000, cushion: -300_000, breached: true });
  });
  it('treats a non-finite balance as unknown, not as a breach', () => {
    expect(cashHeadroom(Number.NaN, 1_500_000)).toEqual({ value: null, floor: 1_500_000, cushion: null, breached: false });
  });
});

describe('firmCashBalance (interim sweepable-cash proxy, Gabriel 2026-11-02)', () => {
  const e = (entity: string, id: string, currentBalance: number) => ({ entity, id, currentBalance });
  it('reads the Oxford entity by exact id or trimmed name', () => {
    expect(firmCashBalance([e('Fairground Village Center', 'fairground-village-center', 4_500_000), e('Oxford', 'oxford', 1_507_172)])).toBe(1_507_172);
    expect(firmCashBalance([e(' Oxford ', 'x1', 900_000)])).toBe(900_000);
  });
  it('never substring-matches another entity', () => {
    expect(firmCashBalance([e('Oxford Capital', 'oxford-capital', 5_000_000), e('EG 5600', 'eg-5600', 212_000)])).toBeNull();
  });
  it('is unknown (null) when absent, ambiguous or non-finite', () => {
    expect(firmCashBalance([])).toBeNull();
    expect(firmCashBalance([e('Oxford', 'oxford', 1), e('Oxford', 'oxford-2', 2)])).toBeNull();
    expect(firmCashBalance([e('Oxford', 'oxford', Number.NaN)])).toBeNull();
  });
});
