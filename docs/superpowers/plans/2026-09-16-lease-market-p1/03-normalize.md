### Task 03: Normalization (pure) — rent text with totals and base+expense quotes, bounds, opex estimate

**Files:**
- Create: `src/analytics/lease-market/normalize.ts`
- Test: `tests/unit/lease-market-normalize.test.ts`

**Depends on:** Task 02 contracts. Task 04's `medianOf` is imported — **implement Task 04 first if it does not exist yet** (the controller dispatches 04 before 03 in practice; the numbering follows the pipeline order).

**Interfaces (Produces):**
- `daysBetween(fromIsoDate, toIsoDate): number` · `addDays(isoDate, days): string`
- `normalizeSuite(raw): string` · `splitAddress(rawAddress, rawSuite): { addressNorm; suiteNorm }`
- `sizeBandFor(sf): SizeBand | null` · `officeStratumFor(subtype, officePct, splitPct): OfficeStratum`
- `interface ParsedRentText { rentLow; rentHigh; rentPeriod: 'yr'|'mo'|null; basis: RentBasis|null; withheld: boolean; isTotal: boolean; opexQuoted: number|null; ambiguous: boolean }` · `parseRentText(text): ParsedRentText`
- `interface RentInput { rentLow; rentHigh; rentPeriod; rentBasis; rentIsTotal: boolean; availableSf: number }`
- `interface OpexEstimate { tax: number|null; ins: number|null; cam: number|null; total: number; source: string }`
- `interface PricedObservation { askingPsfYr; effectiveBasis; askingNnnEq; opexEstPsf; opexSource: string|null; confidence: 'high'|'low'; rejectedReason: string|null }`
- `type PricingThresholds = Pick<LmThresholds, 'rangeMaxSpread'|'monthlyValueCeiling'|'rentMinPsfYr'|'rentMaxPsfYr'>`
- `priceObservation(input: RentInput, opex: OpexEstimate|null, mgLandlordPays: readonly OpexComponent[], t: PricingThresholds): PricedObservation`
- `opexFromDefaults(d: OpexDefaults|null): OpexEstimate|null` · `opexFromQuotedMedian(values: readonly number[], minN: number): OpexEstimate|null` · `resolveOpex(defaults, quotedValues, minN): OpexEstimate|null` (defaults ▸ quoted median ▸ null)
- `interface EligibilityInput { confidence; effectiveBasis; isSublease; originTier; buildingStatus; askingNnnEq; buildingSf }` · `isBenchmarkEligible(o, maxBuildingSf): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-normalize.test.ts
import { describe, it, expect } from 'vitest';
import {
  addDays, daysBetween, isBenchmarkEligible, normalizeSuite, officeStratumFor, opexFromDefaults, opexFromQuotedMedian,
  parseRentText, priceObservation, resolveOpex, sizeBandFor, splitAddress,
  type EligibilityInput, type OpexEstimate, type RentInput,
} from '../../src/analytics/lease-market/normalize';

const T = { rangeMaxSpread: 0.2, monthlyValueCeiling: 3, rentMinPsfYr: 1, rentMaxPsfYr: 60 };
const OPEX: OpexEstimate = { tax: 1, ins: 0.25, cam: 0.5, total: 1.75, source: 'test' };
const input = (patch: Partial<RentInput>): RentInput => ({ rentLow: 8.5, rentHigh: null, rentPeriod: 'yr', rentBasis: 'NNN', rentIsTotal: false, availableSf: 10000, ...patch });
const price = (patch: Partial<RentInput>, opex: OpexEstimate | null = OPEX) => priceObservation(input(patch), opex, ['tax', 'ins'], T);

describe('dates', () => {
  it('counts whole days and shifts dates', () => {
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
    expect(daysBetween('2026-03-01T12:00:00Z', '2026-03-02')).toBe(1);
    expect(addDays('2026-03-01', -365)).toBe('2025-03-01');
  });
});

describe('addresses', () => {
  it('abbreviates suffixes/directionals and splits embedded suites', () => {
    expect(splitAddress('1100 Rarig Avenue, Suite 200', null)).toEqual({ addressNorm: '1100 RARIG AVE', suiteNorm: '200' });
    expect(splitAddress('3540 East 5th Ave.', 'Ste. B')).toEqual({ addressNorm: '3540 E 5TH AVE', suiteNorm: 'B' });
    expect(splitAddress('55 New Plant Ct #104', null)).toEqual({ addressNorm: '55 NEW PLANT CT', suiteNorm: '104' });
    expect(splitAddress('100 Unit Road', null)).toEqual({ addressNorm: '100 UNIT RD', suiteNorm: '' });
    expect(splitAddress('9 Main St Suite 5', 'Unit 7')).toEqual({ addressNorm: '9 MAIN ST', suiteNorm: '7' });
  });
  it('normalizes suites', () => {
    expect(normalizeSuite('Unit A-2')).toBe('A-2');
    expect(normalizeSuite('# 104')).toBe('104');
    expect(normalizeSuite(null)).toBe('');
  });
});

describe('bands and strata', () => {
  it('bands on the boundaries', () => {
    expect([4999, 5000, 49999, 50000, 80000, 80001, 0].map(sizeBandFor)).toEqual(['<5K', '5-15K', '30-50K', '50-80K', '50-80K', null, null]);
  });
  it('stratifies only flex with a known office share', () => {
    expect(officeStratumFor('warehouse', 50, 40)).toBe('all');
    expect(officeStratumFor('flex', null, 40)).toBe('all');
    expect(officeStratumFor('flex', 40, 40)).toBe('office_ge40');
    expect(officeStratumFor('flex', 39.9, 40)).toBe('office_lt40');
  });
});

describe('parseRentText', () => {
  const base = { withheld: false, isTotal: false, opexQuoted: null, ambiguous: false };
  it('single yearly NNN, ranges, monthly', () => {
    expect(parseRentText('$8.50/SF/YR NNN')).toEqual({ ...base, rentLow: 8.5, rentHigh: 8.5, rentPeriod: 'yr', basis: 'NNN' });
    expect(parseRentText('$8.00 - $10.00 /SF/YR Modified Gross')).toEqual({ ...base, rentLow: 8, rentHigh: 10, rentPeriod: 'yr', basis: 'MG' });
    expect(parseRentText('$0.75/SF/MO IG')).toEqual({ ...base, rentLow: 0.75, rentHigh: 0.75, rentPeriod: 'mo', basis: 'IG' });
    expect(parseRentText('$9.25 Industrial Gross')).toEqual({ ...base, rentLow: 9.25, rentHigh: 9.25, rentPeriod: null, basis: 'IG' });
  });
  it('base + quoted expenses', () => {
    expect(parseRentText('$7.25/SF + $2.50 NNN')).toEqual({ ...base, rentLow: 7.25, rentHigh: 7.25, rentPeriod: null, basis: 'NNN', opexQuoted: 2.5 });
    expect(parseRentText('$6.50/SF/YR + $1.95 CAM/TAX/INS')).toMatchObject({ rentLow: 6.5, basis: 'NNN', opexQuoted: 1.95, isTotal: false });
  });
  it('total-dollar quotes', () => {
    expect(parseRentText('$12,000/month + expenses')).toEqual({ ...base, rentLow: 12000, rentHigh: 12000, rentPeriod: 'mo', basis: 'NNN', isTotal: true });
    expect(parseRentText('$1,250/MO')).toMatchObject({ rentLow: 1250, rentPeriod: 'mo', isTotal: true });
    expect(parseRentText('$950/mo')).toMatchObject({ rentLow: 950, isTotal: true });
    expect(parseRentText('$120,000/YR NNN')).toMatchObject({ rentLow: 120000, rentPeriod: 'yr', basis: 'NNN', isTotal: true });
  });
  it('flags ambiguous no-unit amounts', () => {
    expect(parseRentText('$150')).toMatchObject({ ambiguous: true, isTotal: false });
  });
  it('withheld phrases and blanks', () => {
    for (const s of ['Withheld', 'Call for pricing', 'Negotiable', '']) expect(parseRentText(s).withheld).toBe(true);
  });
});

describe('priceObservation', () => {
  it('NNN yearly passes through at high confidence', () => {
    expect(price({})).toEqual({ askingPsfYr: 8.5, effectiveBasis: 'NNN', askingNnnEq: 8.5, opexEstPsf: null, opexSource: null, confidence: 'high', rejectedReason: null });
  });
  it('monthly annualizes; inferred monthly is low confidence; >= 3.00 unstated is yearly high', () => {
    expect(price({ rentLow: 0.75, rentPeriod: 'mo' })).toMatchObject({ askingNnnEq: 9, confidence: 'high' });
    expect(price({ rentLow: 0.75, rentPeriod: null })).toMatchObject({ askingNnnEq: 9, confidence: 'low' });
    expect(price({ rentLow: 7, rentPeriod: null })).toMatchObject({ askingNnnEq: 7, confidence: 'high' });
  });
  it('ranges: wide => UNKNOWN with reason; narrow => midpoint; inverted bounds swap', () => {
    expect(price({ rentLow: 8, rentHigh: 10 })).toMatchObject({ effectiveBasis: 'UNKNOWN', askingNnnEq: null, rejectedReason: expect.stringMatching(/spread/) });
    expect(price({ rentLow: 9, rentHigh: 10 }).askingNnnEq).toBeCloseTo(9.5);
    expect(price({ rentLow: 10, rentHigh: 9 }).askingNnnEq).toBeCloseTo(9.5);
  });
  it('totals convert with available SF and need a period', () => {
    expect(price({ rentLow: 12000, rentPeriod: 'mo', rentIsTotal: true, availableSf: 16000 })).toMatchObject({ askingNnnEq: 9, confidence: 'high' });
    expect(price({ rentLow: 120000, rentPeriod: 'yr', rentIsTotal: true, availableSf: 12000 }).askingNnnEq).toBeCloseTo(10);
    expect(price({ rentLow: 12000, rentPeriod: null, rentIsTotal: true })).toMatchObject({ effectiveBasis: 'UNKNOWN', rejectedReason: expect.stringMatching(/period/) });
  });
  it('rejects out-of-bounds asking rents (the "$12,000/mo NNN" per-SF defect)', () => {
    expect(price({ rentLow: 12000, rentPeriod: 'mo', rentIsTotal: false })).toMatchObject({ effectiveBasis: 'UNKNOWN', askingNnnEq: null, rejectedReason: expect.stringMatching(/outside/) });
    expect(price({ rentLow: 0.5, rentPeriod: 'yr' })).toMatchObject({ effectiveBasis: 'UNKNOWN' });
  });
  it('gross subtracts the opex total; MG subtracts only configured components', () => {
    expect(price({ rentLow: 12, rentBasis: 'GROSS' })).toEqual({ askingPsfYr: 12, effectiveBasis: 'GROSS', askingNnnEq: 10.25, opexEstPsf: 1.75, opexSource: 'test', confidence: 'low', rejectedReason: null });
    expect(price({ rentLow: 11, rentBasis: 'MG' })).toMatchObject({ askingNnnEq: 9.75, opexEstPsf: 1.25, confidence: 'low' });
  });
  it('MG cannot convert with a total-only (quoted median) opex estimate; gross can', () => {
    const quoted: OpexEstimate = { tax: null, ins: null, cam: null, total: 2, source: 'quoted-market-median n=6' };
    expect(price({ rentLow: 11, rentBasis: 'MG' }, quoted).askingNnnEq).toBeNull();
    expect(price({ rentLow: 11, rentBasis: 'GROSS' }, quoted)).toMatchObject({ askingNnnEq: 9, opexSource: 'quoted-market-median n=6' });
  });
  it('no opex => no NNN equivalent; withheld and missing carry nothing', () => {
    expect(price({ rentLow: 11, rentBasis: 'MG' }, null).askingNnnEq).toBeNull();
    expect(price({ rentBasis: 'WITHHELD' }).askingPsfYr).toBeNull();
    expect(price({ rentLow: null }).effectiveBasis).toBe('WITHHELD');
  });
});

describe('opex estimates', () => {
  it('defaults win over quoted medians; quoted medians need n', () => {
    const d = { tax: 1, ins: 0.2, cam: 0.3, source: 'broker', asOf: '2026-01-01' };
    expect(opexFromDefaults(d)).toEqual({ tax: 1, ins: 0.2, cam: 0.3, total: 1.5, source: 'config: broker (2026-01-01)' });
    expect(opexFromQuotedMedian([2, 2.5, 3, 1.5], 5)).toBeNull();
    expect(opexFromQuotedMedian([2, 2.5, 3, 1.5, 2.2], 5)).toEqual({ tax: null, ins: null, cam: null, total: 2.2, source: 'quoted-market-median n=5' });
    expect(resolveOpex(d, [2, 2.5, 3, 1.5, 2.2], 5)?.total).toBe(1.5);
    expect(resolveOpex(null, [2, 2.5, 3, 1.5, 2.2], 5)?.total).toBe(2.2);
    expect(resolveOpex(null, [], 5)).toBeNull();
  });
});

describe('isBenchmarkEligible', () => {
  const base: EligibilityInput = { confidence: 'high', effectiveBasis: 'NNN', isSublease: false, originTier: 'T1', buildingStatus: 'existing', askingNnnEq: 8, buildingSf: 40000 };
  it('accepts the base case and unknown building SF', () => {
    expect(isBenchmarkEligible(base, 80000)).toBe(true);
    expect(isBenchmarkEligible({ ...base, buildingSf: null }, 80000)).toBe(true);
  });
  it.each([
    ['low confidence', { confidence: 'low' as const }],
    ['non-NNN basis', { effectiveBasis: 'MG' as const }],
    ['sublease', { isSublease: true }],
    ['alert-sourced', { originTier: 'T2' as const }],
    ['proposed building', { buildingStatus: 'proposed' as const }],
    ['no rent', { askingNnnEq: null }],
    ['building too large', { buildingSf: 90000 }],
  ])('rejects %s', (_l, patch) => {
    expect(isBenchmarkEligible({ ...base, ...patch }, 80000)).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/lease-market-normalize.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// src/analytics/lease-market/normalize.ts
//
// Lease Market Intelligence — pure normalization (spec rev 3 §3.3). No I/O.
// Every rule here decides whether a quote enters a benchmark; each has a boundary test.
// Financial-decision source: refute pass required.
import {
  SIZE_BANDS,
  type BuildingStatus, type LmSubtype, type LmThresholds, type OfficeStratum, type OpexComponent, type OpexDefaults,
  type OriginTier, type RentBasis, type SizeBand,
} from '../../contracts/lease-market';
import { medianOf } from './benchmarks';

const DAY_MS = 86_400_000;

export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  return Math.floor((Date.parse(toIsoDate.slice(0, 10)) - Date.parse(fromIsoDate.slice(0, 10))) / DAY_MS);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(isoDate.slice(0, 10)) + days * DAY_MS).toISOString().slice(0, 10);
}

// ── Addresses ────────────────────────────────────────────────────────────────
const STREET_SUFFIX: Readonly<Record<string, string>> = {
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', DRIVE: 'DR', BOULEVARD: 'BLVD', LANE: 'LN', COURT: 'CT',
  PLACE: 'PL', PARKWAY: 'PKWY', HIGHWAY: 'HWY', CIRCLE: 'CIR', TERRACE: 'TER', TRAIL: 'TRL', PIKE: 'PIKE',
};
const DIRECTIONAL: Readonly<Record<string, string>> = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
};
const UNIT_TOKENS: ReadonlySet<string> = new Set(['SUITE', 'STE', 'UNIT', 'BLDG', '#']);

function tokens(raw: string): string[] {
  return raw.toUpperCase().replace(/#/g, ' # ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

export function normalizeSuite(raw: string | null | undefined): string {
  if (!raw) return '';
  const parts = tokens(raw);
  while (parts.length > 0 && UNIT_TOKENS.has(parts[0]!)) parts.shift();
  return parts.join('');
}

export function splitAddress(rawAddress: string, rawSuite: string | null): { addressNorm: string; suiteNorm: string } {
  const parts = tokens(rawAddress);
  let embeddedSuite: string | null = null;
  // A unit designator needs a house number and a street name before it, and a value after it.
  const unitIdx = parts.findIndex((t, i) => i >= 2 && i < parts.length - 1 && UNIT_TOKENS.has(t));
  if (unitIdx >= 0) {
    embeddedSuite = parts.slice(unitIdx).join(' ');
    parts.length = unitIdx;
  }
  const addressNorm = parts.map((t) => STREET_SUFFIX[t] ?? DIRECTIONAL[t] ?? t).join(' ');
  return { addressNorm, suiteNorm: normalizeSuite(rawSuite ?? embeddedSuite) };
}

// ── Cells ────────────────────────────────────────────────────────────────────
export function sizeBandFor(sf: number): SizeBand | null {
  if (!Number.isFinite(sf) || sf <= 0) return null;
  if (sf < 5_000) return SIZE_BANDS[0];
  if (sf < 15_000) return SIZE_BANDS[1];
  if (sf < 30_000) return SIZE_BANDS[2];
  if (sf < 50_000) return SIZE_BANDS[3];
  if (sf <= 80_000) return SIZE_BANDS[4];
  return null;
}

export function officeStratumFor(subtype: LmSubtype, officePct: number | null, splitPct: number): OfficeStratum {
  if (subtype !== 'flex' || officePct === null) return 'all';
  return officePct >= splitPct ? 'office_ge40' : 'office_lt40';
}

// ── Rent text ────────────────────────────────────────────────────────────────
export interface ParsedRentText {
  rentLow: number | null;
  rentHigh: number | null;
  rentPeriod: 'yr' | 'mo' | null;
  basis: RentBasis | null;
  withheld: boolean;
  isTotal: boolean;
  opexQuoted: number | null;
  ambiguous: boolean;
}

const WITHHELD_RE = /withheld|negotiable|upon request|\bcall\b|\btbd\b|n\/a/i;
const NUM_RE = /(\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
const EXPENSE_RE = /\b(NNN|CAM|TICAM|opex|op\s*ex|expenses|nets?)\b/i;
const PER_SF_RE = /\/\s*(?:SF|sq\.?\s*ft\.?)\b|\bpsf\b|per\s+(?:SF|sq\.?\s*ft|square\s+foot)/i;

function numbersIn(s: string): number[] {
  return [...s.matchAll(NUM_RE)].map((m) => Number(m[1]!.replace(/,/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
}

function basisIn(s: string): RentBasis | null {
  if (/\bNNN\b|triple\s+net/i.test(s)) return 'NNN';
  if (/\bMG\b|modified\s+gross/i.test(s)) return 'MG';
  if (/\bIG\b|industrial\s+gross/i.test(s)) return 'IG';
  if (/\bFSG?\b|full\s+service/i.test(s)) return 'FSG';
  if (/\bgross\b/i.test(s)) return 'GROSS';
  return null;
}

export function parseRentText(text: string): ParsedRentText {
  const t = text.trim();
  const withheld: ParsedRentText = { rentLow: null, rentHigh: null, rentPeriod: null, basis: null, withheld: true, isTotal: false, opexQuoted: null, ambiguous: false };
  if (!t || WITHHELD_RE.test(t)) return withheld;

  // "$7.25/SF + $2.50 NNN" / "$12,000/month + expenses": base rent + expense add-on => NNN base, quoted opex.
  let basePart = t;
  let opexQuoted: number | null = null;
  let basis: RentBasis | null = null;
  const plusIdx = t.indexOf('+');
  if (plusIdx >= 0 && EXPENSE_RE.test(t.slice(plusIdx + 1))) {
    basePart = t.slice(0, plusIdx);
    opexQuoted = numbersIn(t.slice(plusIdx + 1))[0] ?? null;
    basis = 'NNN';
  }

  const nums = numbersIn(basePart);
  if (nums.length === 0) return withheld;
  const rentLow = nums[0]!;
  const rentHigh = nums.length > 1 ? nums[1]! : nums[0]!;
  const rentPeriod = /\/\s*(mo|month)\b|per\s+month|monthly/i.test(t) ? 'mo' : /\/\s*(yr|year)\b|per\s+year|annual/i.test(t) ? 'yr' : null;
  if (basis === null) basis = basisIn(t);

  const perSf = PER_SF_RE.test(t);
  const maxVal = Math.max(rentLow, rentHigh);
  const isTotal = !perSf && (maxVal >= 1000 || (rentPeriod === 'mo' && maxVal >= 50));
  const ambiguous = !perSf && !isTotal && maxVal >= 60;
  return { rentLow, rentHigh, rentPeriod, basis, withheld: false, isTotal, opexQuoted, ambiguous };
}

// ── Opex estimate ────────────────────────────────────────────────────────────
export interface OpexEstimate {
  tax: number | null;
  ins: number | null;
  cam: number | null;
  total: number;
  source: string;
}

export function opexFromDefaults(d: OpexDefaults | null): OpexEstimate | null {
  return d ? { tax: d.tax, ins: d.ins, cam: d.cam, total: d.tax + d.ins + d.cam, source: `config: ${d.source} (${d.asOf})` } : null;
}

export function opexFromQuotedMedian(values: readonly number[], minN: number): OpexEstimate | null {
  if (values.length < minN) return null;
  const total = medianOf(values);
  return total === null ? null : { tax: null, ins: null, cam: null, total, source: `quoted-market-median n=${values.length}` };
}

export function resolveOpex(defaults: OpexDefaults | null, quotedValues: readonly number[], minN: number): OpexEstimate | null {
  return opexFromDefaults(defaults) ?? opexFromQuotedMedian(quotedValues, minN);
}

// ── Pricing ──────────────────────────────────────────────────────────────────
export interface RentInput {
  rentLow: number | null;
  rentHigh: number | null;
  rentPeriod: 'yr' | 'mo' | null;
  rentBasis: RentBasis;
  rentIsTotal: boolean;
  availableSf: number;
}

export interface PricedObservation {
  askingPsfYr: number | null;
  effectiveBasis: RentBasis;
  askingNnnEq: number | null;
  opexEstPsf: number | null;
  opexSource: string | null;
  confidence: 'high' | 'low';
  rejectedReason: string | null;
}

export type PricingThresholds = Pick<LmThresholds, 'rangeMaxSpread' | 'monthlyValueCeiling' | 'rentMinPsfYr' | 'rentMaxPsfYr'>;

export function priceObservation(
  input: RentInput,
  opex: OpexEstimate | null,
  mgLandlordPays: readonly OpexComponent[],
  t: PricingThresholds,
): PricedObservation {
  const none = (basis: RentBasis, reason: string | null = null): PricedObservation => ({
    askingPsfYr: null, effectiveBasis: basis, askingNnnEq: null, opexEstPsf: null, opexSource: null, confidence: 'low', rejectedReason: reason,
  });
  if (input.rentBasis === 'WITHHELD' || input.rentBasis === 'UNKNOWN') return none(input.rentBasis);

  let low = input.rentLow ?? input.rentHigh;
  let high = input.rentHigh ?? input.rentLow;
  if (low === null || high === null) return none('WITHHELD');
  if (high < low) [low, high] = [high, low];
  if (low <= 0) return none('UNKNOWN', 'non-positive rent');
  const spread = (high - low) / low;
  if (spread > t.rangeMaxSpread) return none('UNKNOWN', `range spread ${(spread * 100).toFixed(0)}% > ${(t.rangeMaxSpread * 100).toFixed(0)}%`);
  const mid = (low + high) / 2;

  let askingPsfYr: number;
  let periodInferred = false;
  if (input.rentIsTotal) {
    if (input.rentPeriod === null) return none('UNKNOWN', 'total amount without a period');
    if (!(input.availableSf > 0)) return none('UNKNOWN', 'total amount without available SF');
    askingPsfYr = (input.rentPeriod === 'mo' ? mid * 12 : mid) / input.availableSf;
  } else if (input.rentPeriod === 'mo') {
    askingPsfYr = mid * 12;
  } else if (input.rentPeriod === 'yr') {
    askingPsfYr = mid;
  } else if (mid < t.monthlyValueCeiling) {
    askingPsfYr = mid * 12;
    periodInferred = true;
  } else {
    askingPsfYr = mid;
  }

  const outOfBounds = (v: number) => v < t.rentMinPsfYr || v > t.rentMaxPsfYr;
  if (outOfBounds(askingPsfYr)) {
    return none('UNKNOWN', `asking $${askingPsfYr.toFixed(2)}/SF/yr outside $${t.rentMinPsfYr}-$${t.rentMaxPsfYr}`);
  }

  if (input.rentBasis === 'NNN') {
    return { askingPsfYr, effectiveBasis: 'NNN', askingNnnEq: askingPsfYr, opexEstPsf: null, opexSource: null, confidence: periodInferred ? 'low' : 'high', rejectedReason: null };
  }

  let estimate: number | null = null;
  if (opex) {
    if (input.rentBasis === 'GROSS' || input.rentBasis === 'FSG') {
      estimate = opex.total;
    } else {
      const parts = mgLandlordPays.map((c) => opex[c]);
      estimate = parts.every((p) => p !== null) ? parts.reduce<number>((sum, p) => sum + (p as number), 0) : null;
    }
  }
  if (estimate === null || opex === null) {
    return { askingPsfYr, effectiveBasis: input.rentBasis, askingNnnEq: null, opexEstPsf: null, opexSource: null, confidence: 'low', rejectedReason: null };
  }
  const nnn = askingPsfYr - estimate;
  if (outOfBounds(nnn)) {
    return { askingPsfYr, effectiveBasis: input.rentBasis, askingNnnEq: null, opexEstPsf: estimate, opexSource: opex.source, confidence: 'low', rejectedReason: `NNN-equivalent $${nnn.toFixed(2)} outside bounds` };
  }
  return { askingPsfYr, effectiveBasis: input.rentBasis, askingNnnEq: nnn, opexEstPsf: estimate, opexSource: opex.source, confidence: 'low', rejectedReason: null };
}

// ── Benchmark eligibility ────────────────────────────────────────────────────
export interface EligibilityInput {
  confidence: 'high' | 'low';
  effectiveBasis: RentBasis;
  isSublease: boolean;
  originTier: OriginTier;
  buildingStatus: BuildingStatus;
  askingNnnEq: number | null;
  buildingSf: number | null;
}

export function isBenchmarkEligible(o: EligibilityInput, maxBuildingSf: number): boolean {
  return (
    o.confidence === 'high' &&
    o.effectiveBasis === 'NNN' &&
    !o.isSublease &&
    o.originTier === 'T1' &&
    o.buildingStatus === 'existing' &&
    o.askingNnnEq !== null &&
    o.askingNnnEq > 0 &&
    (o.buildingSf === null || o.buildingSf <= maxBuildingSf)
  );
}
```

- [ ] **Step 4:** `npx vitest run tests/unit/lease-market-normalize.test.ts && npm run typecheck && npx eslint src/analytics/lease-market tests/unit/lease-market-normalize.test.ts --max-warnings 0` — Expected: PASS / clean.

- [ ] **Step 5: Commit** — `git add src/analytics/lease-market/normalize.ts tests/unit/lease-market-normalize.test.ts` ("feat(analytics): lease market normalization with totals, expense quotes and bounds").

## Review fixes (plan rev 2.1)

Task review found that a misread rent quote could silently enter an NNN benchmark at high confidence. Fixes applied to `parseRentText` and `priceObservation` (existing exported signatures unchanged):

1. `NUM_RE` now captures match position, not just value, and supports leading-dot amounts (`$.75`).
2. Withheld = blank, OR no rent number found, OR `WITHHELD_RE` matches AND the text has no `$`; `WITHHELD_RE` updated so "non-negotiable" and slash-annual quotes aren't misread as withheld.
3. Base rent and an expense add-on (`+ ... NNN/CAM/...`) are now split and parsed separately.
4. A second number is only treated as a range high-end when a real range separator (`-`/`–`/`—`/`to`) sits between the two numbers — a trailing CAM figure or escalation % no longer becomes a false range or false rent value.
5. Period/per-SF/total detection now runs on the rent "head" (base rent text up to the first `,`/`;`/`(`/` w/`/` with `) only, not the whole string — trailing escalation clauses no longer leak into basis/period detection.
6. Basis precedence: an add-on with no stated basis or a stated NNN basis resolves to NNN; an add-on with a stated MG/IG/GROSS/FSG basis is flagged `ambiguous: true` (contradictory quote) instead of silently accepted.
7. Add-on opex value (`opexQuoted`) is derived from the add-on text alone, distinguishing per-SF/monthly figures from bare total-dollar CAM amounts (which now correctly return `null`).
8. `priceObservation` rejects non-finite (`NaN`/`Infinity`) low/high as `UNKNOWN` instead of propagating `NaN` into `askingNnnEq`.
9. Range-spread rejection uses a `+1e-9` epsilon so a spread exactly at `rangeMaxSpread` passes.
10. MG/IG-to-NNN conversion now requires all three opex components (tax/ins/cam) to be non-null before attributing landlord-paid components — a quoted-median-only estimate (all components null) can no longer vacuously "convert" via an empty `mgLandlordPays` list.
11. `splitAddress`: a blank/whitespace `rawSuite` no longer shadows an embedded suite parsed from the address.

### Adversarial-review addendum (same commit, discovered during the mandatory independent Fable review — 2 more rounds, 3 total)

The independent reviewer found 4 further regressions the literal rules above still permitted (each verified against concrete inputs, not hypothetical) and asked for guard-level fixes plus test coverage before approving:

13. **Period conflict.** If the rent "head" (rule 5) matches both a monthly and a yearly period marker (e.g. an explicit `/YR` alongside a bare "monthly" elsewhere in the head), `rentPeriod` is now `null` and `ambiguous: true` instead of monthly silently winning.
14. **Basis conflict.** `basisTokensIn()` collects every distinct basis token in the head (not just the first, priority-ordered one `basisIn` returned); more than one distinct token (e.g. "MG NNN") sets `ambiguous: true`. A lookbehind keeps "Modified Gross"/"Industrial Gross"/"Full Service (Gross)" from self-conflicting against the bare "gross" they contain.
15. **Tail conflict.** Text truncated out of the head by rule 5's cut (e.g. a parenthetical "(monthly)") is checked for a period marker that contradicts, or supplies where the head lacks, one; either way that sets `ambiguous: true` rather than silently losing the signal. A same-period tail (e.g. ", CAM $3.50" or "w/ $2.50/SF/YR CAM") does not falsely trip this.
16. **`$`-anchored rent candidate.** When the text quotes a `$`, the first rent-number candidate (m1) must itself be immediately preceded by `$` — an unrelated bare integer ("5+ year term", "2nd floor") is no longer mistaken for the rent. The second range figure (m2) is not required to repeat the `$` (short forms like "$12-14/SF/YR" only carry one) — it is accepted as a range high-end via the full range grammar if it is itself `$`-anchored, otherwise only via a bare separator with no intervening unit/basis token, so a trailing CAM figure or escalation % still cannot become a false range.
17. **Range separator admits a basis word.** `RANGE_SEP_RE` now also accepts an NNN/MG/IG/FSG/gross token between the two `$`-anchored range figures (e.g. "$8.00/SF/YR NNN - $10.00/SF/YR NNN"), so such quotes are correctly recognized as a range and go through the ordinary spread gate instead of silently collapsing to the low figure.

Two notes carried forward, not blockers for this diff:
- Rules 13–15's protection is only realized once the ingestion layer (`07-costar-parser.md`) maps `parsed.ambiguous` to `rentBasis: 'UNKNOWN'` as planned — `priceObservation`'s signature does not take `ambiguous` directly (frozen per this task's "keep every existing exported signature" instruction), so this file can only compute and expose the flag, not enforce it end-to-end.
- Low-severity, out of scope: `opexQuoted`'s add-on-period detection only looks at the add-on text itself, not the base rent's period, so a monthly base with a bare per-SF add-on figure can be under-scaled. Only feeds the always-low-confidence GROSS/FSG opex path, never benchmark-eligible.

### Fix round 2 (second re-review — 1 Important regression from the `$`-anchor guard, plus 4 cheap Minors)

18. **`$`-anchor over-promotion.** An earlier number with no `$` of its own that plausibly looks like the rent (`looksLikeRentFigure`: followed by a per-SF/period/basis token, or numerically within $1–$60 — but never a number glued to a letter or a `+`, which is an ordinal/floor number or a term-length marker, not a rent) is no longer shadowed by a later `$`-anchored figure (e.g. a CAM estimate quoted with its own "$"); `rentLow` stays the earlier number and `ambiguous: true` is set instead.
19. **Percentages excluded.** `numberMatches` now drops any number immediately followed by `%` (optional whitespace) — a rent bump, escalation, or admin-fee percentage can no longer be mistaken for a rent figure, a range high-end, or an add-on opex amount.
20. **Basis stated after the head cut.** When the head states no basis, `basisTokensIn(tail)` is now consulted as a fallback (e.g. "$8.50/SF/YR, NNN" or "$8.50 /SF/YR (NNN)"); if head and tail both state a basis and they disagree, that's a new `ambiguous` trigger (`crossBasisConflict`) distinct from rule 14's within-head conflict.
21. **Add-on split gated on position.** The `+` split (rule 3) now only fires when the `+` occurs AFTER the first rent-candidate figure (`firstRentCandidateIndex`, the same $-anchoring rule 16 already used for m1) — "5+ year term at $4.00/SF NNN" is recognized as a term-length marker, not an add-on separator, so the real `$4.00` rent is found (`withheld: false, rentLow: 4, basis: 'NNN'`) instead of being carved off into a discarded addon and lost. **This changes a prior pin**: the existing test at the end of the round-1 adversarial-follow-up block, previously asserting `withheld: true` for this exact string, was updated to assert the corrected (non-data-loss) result.
22. **Docs hygiene.** `04-benchmarks.md`'s rule-12 note (added in fix round 1) also had the same NUL-byte encoding defect as `benchmarks.ts` did — fixed to the literal `\u0000` escape.

No exported signature changed; all fixes are additive guards or narrower candidate-selection logic within `parseRentText`.

### Fix round 3 — canonical grammar gate (structural, not another string-chase)

Two review rounds each found a new high-confidence wrong-number path through the heuristic parser (`"2nd floor, 8.50/SF/YR NNN, $2.10 CAM"` giving 2.10; `"$10.50/SF/YR (Gross), NNN est. $2.25"` giving basis NNN) despite rules 1–21 already closing the prior rounds' specific findings. The controller's design decision: stop chasing individual strings and add a structural gate instead.

23. **Canonical grammar gate.** `parseRentText` now requires the WHOLE input string to match a strict canonical grammar — `amount[/unit][/period][ range][ basis][ + expenses]`, nothing else — for a non-withheld result to be trusted (`ambiguous: false`). `CANONICAL_RE` is built from named fragments (`AMT`/`UNIT`/`PER`/`BASIS_WORD`/`ADDON_WORD`) and applied last: `ambiguous = ambiguous || !CANONICAL_RE.test(t)`. Every existing heuristic (rules 1–22) is kept as defence in depth — they still compute the best-effort `rentLow`/`rentHigh`/`basis`/etc., and still independently set `ambiguous` for the cases they were built to catch — but the gate is now the final word on whether a quote is benchmark-grade. **Yield is deliberately traded for safety**: several real, mostly-clean-looking CoStar strings (e.g. `"$4.00/SF/YR NNN, CAM $3.50"`, `"$8.00/SF/YR NNN - $10.00/SF/YR NNN"`, `"2nd floor $8.50/SF/YR NNN"`) now parse to `ambiguous: true` even though their rentLow/rentHigh/basis are individually correct — narrower coverage is the intended cost of closing this defect class in one gate rather than one string at a time. This does not affect CoStar's own numeric rent columns (a separate, already-numeric ingestion path per `07-costar-parser.md`) — only free-text asking-rent strings ever reach `parseRentText`.
24. **`looksLikeRentFigure` scans all unanchored candidates.** Previously only checked the very first number in the text; now scans every unanchored number before the first `$`-anchored one and keeps the earliest one that plausibly looks like the rent — an excluded ordinal ("2nd") earlier in the text no longer stops a later genuinely-rent-like unanchored number ("8.50") from being found ahead of a `$`-anchored decoy (a CAM estimate quoted with its own "$").
25. **Tail-basis fallback restricted.** The tail-basis fallback (rule 20) now only fires when the tail states EXACTLY ONE basis token AND quotes no `$` figure of its own; a tail with two basis words, or one basis word alongside a second dollar amount (likely a separate expense clause, not a clean restatement), is rejected as a fallback and sets a new `ambiguous` trigger (`tailBasisRejected`) instead of silently picking the tail's first token.
26. **Percent exclusion extended.** The rule-19 percentage exclusion now also matches spelled-out `percent`/`pct`, not just a literal `%`.

Existing test pins that asserted `ambiguous: false` for a string that turns out to be non-canonical were updated to `ambiguous: true` (rentLow/rentHigh/basis expectations unchanged): `'$4.00/SF/YR NNN, CAM $3.50'`, `'$8.00/SF/YR NNN - $10.00/SF/YR NNN'`, `'2nd floor $8.50/SF/YR NNN'`, `'$8.50/SF/YR NNN, CAM $3.50'`, `'$8.50/SF/YR NNN w/ $2.50/SF/YR CAM'`.

### Fix round 4 — capture-based cross-check, performance guard, balanced parens

The round-3 gate matched the whole string but trusted the heuristic parser's `rentLow`/`rentHigh` blindly — a grammar match alone was never proof the parser extracted the same numbers the grammar just recognized. The gate's own unit/period grammar (`psf` bare, `per year`, an unanchored range high-end) is intentionally broader than the parser's independently-maintained `RANGE_SEP_RE`/`BARE_RANGE_SEP_RE`, so a genuine range the parser's range detector fails to recognize (e.g. `"$8.00 psf - $10.00 psf NNN"`) was passing the gate as clean while the parser silently returned only the low figure for both `rentLow` and `rentHigh`. Rather than keep hand-synchronizing two independently-maintained grammars indefinitely, the fix makes the two structurally **impossible to silently disagree**.

27. **Capture-based cross-check.** `CANONICAL_RE`'s first (base) amount and optional range amount are now capturing groups — every other sub-pattern (unit, period, basis, addon) stays non-capturing. When the grammar matches, the captured amounts are parsed the same way `numberMatches` parses a number (strip `$`/commas/whitespace, including a leading-decimal form) and compared against the parser's own `rentLow`/`rentHigh`: the first capture must equal `rentLow`; a range capture (when present) must equal `rentHigh`; with no range capture, `rentHigh` must equal `rentLow`. Any mismatch sets `ambiguous: true` — this closes the whole class of "gate says clean, parser silently drops the range" defects without editing `RANGE_SEP_RE`/`BARE_RANGE_SEP_RE` at all (verified against 8 concrete range forms the parser's detector still misses: bare `psf`, an unanchored range high-end, `to`/`per year` spellings, `/yr`/`/mo` shorthand — every one is now `ambiguous: true`, not a silently-wrong single figure).
28. **Performance guard.** `parseRentText` now collapses internal whitespace runs to a single space (cheap, linear) as its very first step, before any other processing; if the collapsed text is still longer than 200 characters, it returns immediately — `{ withheld: false, ambiguous: true, rentLow: null, ... }` — without running the (alternation-heavy, and empirically not linear-time on this input shape) `CANONICAL_RE`/heuristic pipeline at all. A 50,000-character whitespace-padded string previously took ~3 seconds through `CANONICAL_RE` alone; with the guard it completes in well under 200ms (it collapses to 4 characters before any expensive regex runs). Chose the non-withheld/`ambiguous: true` shape (over reusing the withheld shape) so a downstream consumer routing on `ambiguous → UNKNOWN` doesn't have to special-case "too long to trust" as a third state alongside withheld/parsed.
29. **Balanced parentheses.** The basis-word clause changed from `\(?BASIS\)?` (either paren independently optional — so `"(NNN"` with no closing paren still matched) to `(?:\(BASIS\)|BASIS)` (both parens together, or neither — never one without the other). `'$8.50/SF/YR (NNN'` (truncated/malformed) is now non-canonical; `'$8.50/SF/YR (NNN)'` (balanced) is unaffected.

No exported signature changed. New tests tighten the round-3 canonical `it.each` to also assert `rentLow`/`rentHigh` per string (not just `ambiguous`), and the round-3 "earlier unanchored number" test to `rentLow` `toBe(8.5)` (was `not.toBe(2.1)`) across all 5 excluded-prefix shapes (ordinal, unit code, hyphenated ordinal, term-length marker).

### Fix round 5 — partial add-on guard (controller convention decision)

Every prior round assumed ANY expense add-on (`+ CAM`, `+ CAM/TAX`, `+ NNN`, ...) implied the tenant covers the full NNN pass-through and resolved `basis` to `'NNN'` unconditionally. Controller decision (market convention, conservative per the plan's safety-over-yield rule): a *partial* add-on — one that names only some of the expense components — must not be read as "the tenant pays everything." `"+ CAM"` alone is a real, market-common quote shape meaning only CAM is being passed through (or discussed), not a full net lease.

30. **Partial expense add-on guard.** New `isFullExpenseAddon()`: an add-on resolves the basis to NNN only when it names a full-expense FORM — `NNN`, `TICAM`, `nets`/`net`, `expenses`, `opex` on their own (strict — no spaced `"op ex"`; see rule 34), OR ALL of `CAM`/`TAX`/`INS` present as a `"/"`-separated chain, any order (e.g. `"CAM/TAX/INS"`, `"INS/TAX/CAM"` — but NOT space-separated `"CAM TAX INS"`; see rule 34). Wired into the basis-resolution branch ONLY when the head/tail states no basis at all (`stated === null`) — when the head already explicitly states `NNN` independently, the add-on is supplementary detail, not what's resolving the basis, so a partial add-on there doesn't degrade an already-confirmed statement. A partial add-on (`"+ CAM"`, `"+ CAM/TAX"`, `"+ CAM/INS"`, `"+ TAX"` or `"+ INS"` alone) now keeps the parsed `rentLow`/`rentHigh` but sets `basis: null` and a new `ambiguous` trigger, `partialExpenseAddon`. *(Corrected in fix round 6: the original wording here claimed `"op ex"` (spaced) and space-separated `"CAM TAX INS"` were also accepted as full forms — round 6 found and closed that gap; see rule 34.)*
31. **`CANONICAL_RE`'s `ADDON_WORD` widened.** The grammar previously required an addon to START with `NNN`/`CAM`/`TICAM`/`opex`/`expenses`/`nets` before any `/TAX`/`/INS`/`/CAM` suffix — so `"+ INS/TAX/CAM"` (a legitimate full-form quote, just not CAM-first) was structurally non-canonical even though it names all three components. `ADDON_WORD` now accepts any of `{NNN, CAM, TICAM, opex, expenses, nets, TAX, INS}` in any order/position — the grammar recognizes the SHAPE of an expense add-on; whether it names a full FORM is rule 30's separate semantic check. *(Corrected in fix round 6: this was NOT "purely syntactic" as originally claimed — widening `ADDON_WORD` to accept bare `TAX`/`INS` as add-on tokens, without also widening `EXPENSE_RE` (the separate gate deciding whether a `"+"` is even treated as an add-on split point), reopened a real gate hole: a bare `"+ TAX"`/`"+ INS"` add-on never reached rule 30's check at all. See rule 34.)*
32. **Add-on opex ceiling tightened.** `addonOpexValue`'s rejection changed from `value > 30` to `value >= 30` — an add-on annualizing to exactly $30.00/SF/yr (e.g. `"$2.50/SF/MO"`) is exactly as implausible as one just over it.
33. **costar-parse.ts: UNKNOWN must survive the WITHHELD fallback.** The blanket `if (rentLow === null && rentHigh === null) rentBasis = 'WITHHELD'` fallback was written under a since-falsified assumption (its own comment claimed `parseRentText` only ever sets `ambiguous` alongside a non-null `rentLow` — true before fix round 4's performance guard, false after: the guard returns `rentLow: null, rentHigh: null, ambiguous: true`). A capped quote was silently downgraded from the correct `UNKNOWN` (a quote existed but couldn't be trusted) to `WITHHELD` (no quote existed at all) — two different claims. Fixed with a `textAmbiguous` flag tracked alongside `rentLow`/`rentHigh`, and the stale comment corrected.

Existing test updated: `'$12,000/month + $1,500 CAM'` (bare CAM, no TAX/INS) — was `basis: 'NNN'`, now `basis: null, ambiguous: true` (rentLow/rentPeriod/isTotal/opexQuoted unchanged). No other existing pin relied on a partial `"+ CAM"`-only add-on resolving to NNN (every other `+`-addon test either names a full form already, or the head/tail states a non-null, non-NNN basis independently, taking the unaffected `addonContradiction` branch).

### Fix round 6 — TAX/INS gate hole, partial-add-on opexQuoted, shared token list (sixth re-review)

Round 5's core CAM guard, the `>= 30` ceiling, and the `costar-parse.ts` UNKNOWN-vs-WITHHELD fix were all confirmed correct. But widening `ADDON_WORD` to accept `TAX`/`INS` as add-on tokens (rule 31) without also widening `EXPENSE_RE` — the separate, earlier gate that decides whether a `"+"` is even treated as an add-on split point at all — reopened exactly the class of gate hole rounds 3–5 exist to close: a bare `"+ TAX"` or `"+ INS"` add-on (or one following an explicit `MG`/`IG` head) never reached rule 30's partial-add-on check OR the `addonContradiction` check, because `addon` stayed `null` the whole time — the base rent parsed clean, and the (already-widened) canonical grammar raised no objection either, since it now recognized `"+ TAX"` as a syntactically valid add-on shape.

34. **`EXPENSE_RE` now includes `TAX`/`INS`, built from the SAME shared token list as the grammar and `isFullExpenseAddon`.** New module-level `FULL_FORM_ADDON_TOKENS` (`NNN`/`TICAM`/`nets`/`expenses`/`opex`) and `COMPONENT_ADDON_TOKENS` (`CAM`/`TAX`/`INS`) are now the ONE source of truth: `EXPENSE_RE`, `ADDON_TOKEN`/`ADDON_WORD` (the grammar), and `isFullExpenseAddon` are all built from them, so the three can never silently drift apart again. `EXPENSE_RE` keeps one deliberate extra tolerance beyond the shared list — a spaced `"op ex"` — since its only job is deciding whether to ATTEMPT the add-on split (broader is safe there); `isFullExpenseAddon` does NOT carry that tolerance (see rule 30's correction above) — it's the strict, final full-vs-partial call, and a looser check there than the grammar accepts is exactly how this round's defect happened. `isFullExpenseAddon`'s component check now specifically looks for a `"/"`-separated chain of `CAM`/`TAX`/`INS` (mirroring `ADDON_WORD`'s own shape) rather than independent presence anywhere in the addon text — so `"CAM TAX INS"` (space-separated, not the grammar's own separator) is correctly treated as partial, consistent with the grammar (which also wouldn't accept that spacing as a clean add-on).
35. **`opexQuoted` is null for any partial add-on.** `addon !== null && !isFullExpenseAddon(addon)` now forces `opexQuoted: null`, regardless of what `basis` resolved to — including the round-5-ratified carve-out where an explicit head `NNN` keeps `basis: 'NNN'` despite a partial add-on alongside it (`"$6.50/SF/YR NNN + $1.00/SF/YR CAM"` ⇒ `basis: 'NNN'`, `opexQuoted: null`). A partial add-on's own figure (e.g. a bare CAM estimate) is not total opex, and reporting it as such would feed a quoted-opex median as if it covered tax + insurance + CAM together.

Existing test updated: `'$7.25/SF/YR + $0.21/SF/MO CAM'` (bare CAM add-on) — `opexQuoted` was `2.52` (computed as if the bare-CAM figure were the whole opex estimate), now `null`. `rentPeriod`/`rentLow` unchanged.

Rules 30 and 31's original wording above is corrected in place (each with an inline *"Corrected in fix round 6"* note explaining what changed and why) rather than left to silently contradict the current, stricter behavior.

## REFUTE fixes (adversarial pass, 2026-09-17)

Four findings against `normalize.ts` were reproduced with probe scripts before fixing (see the session's `scratchpad/refute/probe-normalize.ts` and `probe-address.ts`), each confirmed against the pre-fix code, then closed test-first.

36. **R6 — add-on period inheritance.** `addonOpexValue` derived a period-less expense add-on's own period only from the add-on TEXT itself, never the base rent's stated period — `"$0.60/SF/MO + $0.20 NNN"` returned `opexQuoted: 0.20` (treated as already-annual) instead of `2.40` (`0.20 * 12`, since the add-on rides on a monthly head). Fixed: a period-less add-on now inherits `headPeriod` (the already-computed `rentPeriod` of the base rent); an add-on that states its OWN period (`/MO`/`/YR`) remains authoritative and never inherits. A non-perSf add-on that explicitly states `/MO` with no `/SF` stays rejected (`null`) — the same "ambiguous, not per-SF" rule as R7 below, applied to the add-on figure.
37. **R7 — a `/mo` amount with no `/SF` token below the total threshold.** `isTotal`'s existing `MONTHLY_TOTAL_THRESHOLD` (50) governed whether a monthly quote with no per-SF marker was treated as a TOTAL dollar amount; below that threshold it fell through to `priceObservation` as if it WERE per-SF, annualizing `$4.50/MO NNN` into `$54.00/SF/yr` at high confidence. Fixed: `!perSf && rentPeriod === 'mo' && !isTotal` now sets `ambiguous: true` — a sub-threshold `/mo`-no-`/SF` amount is neither a trusted total nor a trusted per-SF rate. `$2,500/MO NNN` (at/above the threshold) and `$0.60/SF/MO` (carries its own `/SF`) are unaffected.
38. **R9 — BLDG must stay a distinguishing identity token, not an ordinary suite unit token.** `BLDG` was in the general unit-token set, so it was either silently discarded (`splitAddress` prefers an explicit `rawSuite` over anything embedded in the address, including a building designator) or collapsed into the exact same normalized form as an ordinary suite (`normalizeSuite('Bldg 2') === normalizeSuite('Ste 2') === '2'`) — `"1100 Rarig Ave Bldg 1"` + suite `"A"` and `"...Bldg 2"` + suite `"A"` both produced `suiteNorm: 'A'`, and a bare `"Bldg 2"` collided with a bare `"Ste 2"`. **Design decision: fold the building designator into `suiteNorm`** (`"B2-A"`, or bare `"B2"` with no other suite), rather than keep it in `addressNorm`. Reasoning, checked against `ingest.ts` (read-only): property identity for a non-`costarPropertyId` row is keyed on `addressNorm` alone (`findAdoptableProperty`/`findLowestPropertyByAddress`/`identityKeyFor`), and ORA's own property matching (`config.oraProperties[].addressNorms`) matches on the SAME bare `addressNorm` string (e.g. `"1100 RARIG AVE"`) — folding `BLDG` into `addressNorm` instead would split an existing single-property, multi-building complex (like ORA's own 1100 Rarig Ave) into multiple `lm_property` rows and silently break any `oraProperties` config entry keyed to the bare address, which R8's per-property comp cap and the ORA-ownership exclusion both depend on. Keeping the property identity intact and distinguishing only at the suite/space level avoids both failure modes. `normalizeSuite` itself also extracts a `BLDG`/`BUILDING` token directly (regardless of position relative to a suite token), so it produces the same `B<n>-<suite>` form whether called standalone or via `splitAddress`.
39. **R15 — a numeric `rentHigh` of 0 (CoStar's blank-high sentinel) was read as a real $0.** `priceObservation` defaulted a null side from the other (`rentLow ?? rentHigh`), then swapped if `high < low`. A `{ rentLow: 8.50, rentHigh: 0 }` row swapped to `low: 0, high: 8.50` and was rejected as `"non-positive rent"`, losing an otherwise-clean quote. Fixed: a `0` on either `rentLow` or `rentHigh` is now treated as `null` (not stated) BEFORE the null-fallback and swap — `{ 8.50, 0 }` and `{ 0, 8.50 }` both resolve to a clean single-sided `$8.50` quote; `{ 0, 0 }` still correctly falls through to `WITHHELD` (no quote at all).

Verification: `npx vitest run tests/unit/lease-market-normalize.test.ts tests/unit/lease-market-costar-parse.test.ts` — 162/162 green (see `tests/unit/lease-market-normalize.test.ts` and `tests/unit/lease-market-costar-parse.test.ts` for the new pinned cases). `npx tsc --noEmit` and `eslint --max-warnings 0` clean on all touched files. No previously-approved `normalize.ts`/`costar-parse.ts` expectation changed silently — see R12 below for the one costar-parse expectation that DID change (by design, since it exercised the removed heuristic).

### R12 — `costar-parse.ts`: `parsePercent`'s value-magnitude heuristic

`parsePercent` multiplied any bare number in `(0, 1]` by 100 on the assumption it must be a fraction-of-whole — a genuine `"1%"` office share stored as the bare number `1` (as some CoStar exports do) was silently turned into `100`. Fixed: the value-magnitude guess is removed entirely; a bare number now stays in percentage points unless the header map explicitly says the column is fractional. Added `officePctIsFraction?: boolean` to `CostarHeaderMap` (optional, defaults `false` — an existing/older header map with the field omitted keeps the safe "already in points" behavior, never the old guess). `config/lease-market.costar-headers.json` documents the flag explicitly at `false`.

**This changes one previously-approved expectation**: `parsePercent('0.25')` used to return `25` (heuristic); it now returns `0.25` (no flag given ⇒ not fractional). The existing `lease-market-costar-parse.test.ts` "maps rows to canonical listings..." fixture's `officePct` input was changed from `0.25` to `25` (i.e., already in points) to keep asserting the same output (`officePct: 25`) under the corrected, non-heuristic behavior — the row-mapping test's purpose (exercising the whole field set) is unaffected. The `parsePercent` unit test itself was rewritten to assert the new default-false/explicit-true behavior directly, including the exact regression named in the finding (`parsePercent('1')` ⇒ `1`, not `100`).
