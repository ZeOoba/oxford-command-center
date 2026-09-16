### Task 03: Normalization (pure)

**Files:**
- Create: `src/analytics/lease-market/normalize.ts`
- Test: `tests/unit/lease-market-normalize.test.ts`

**Interfaces:**
- Consumes (Task 02): `RentBasis`, `SizeBand`, `SIZE_BANDS`, `LmSubtype`, `OfficeStratum`, `BuildingStatus`, `OriginTier`, `OpexComponent`, `LmThresholds` types from `src/contracts/lease-market.ts`.
- Produces:
  - `daysBetween(fromIsoDate: string, toIsoDate: string): number` (whole days, UTC dates)
  - `addDays(isoDate: string, days: number): string` (YYYY-MM-DD)
  - `normalizeSuite(raw: string | null | undefined): string` ('' when none)
  - `splitAddress(rawAddress: string, rawSuite: string | null): { addressNorm: string; suiteNorm: string }`
  - `sizeBandFor(sf: number): SizeBand | null`
  - `officeStratumFor(subtype: LmSubtype, officePct: number | null, splitPct: number): OfficeStratum`
  - `interface ParsedRentText { rentLow: number | null; rentHigh: number | null; rentPeriod: 'yr' | 'mo' | null; basis: RentBasis | null; withheld: boolean }` and `parseRentText(text: string): ParsedRentText`
  - `interface RentInput { rentLow: number | null; rentHigh: number | null; rentPeriod: 'yr' | 'mo' | null; rentBasis: RentBasis }`
  - `interface OpexInput { tax: number; ins: number; cam: number }`
  - `interface PricedObservation { askingPsfYr: number | null; effectiveBasis: RentBasis; askingNnnEq: number | null; opexEstPsf: number | null; confidence: 'high' | 'low' }`
  - `priceObservation(input: RentInput, opex: OpexInput | null, mgLandlordPays: readonly OpexComponent[], t: Pick<LmThresholds, 'rangeMaxSpread' | 'monthlyValueCeiling'>): PricedObservation`
  - `interface EligibilityInput { confidence: 'high' | 'low'; effectiveBasis: RentBasis; isSublease: boolean; originTier: OriginTier; buildingStatus: BuildingStatus; askingNnnEq: number | null; buildingSf: number | null }` and `isBenchmarkEligible(o: EligibilityInput, maxBuildingSf: number): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-normalize.test.ts
import { describe, it, expect } from 'vitest';
import {
  addDays, daysBetween, isBenchmarkEligible, normalizeSuite, officeStratumFor, parseRentText,
  priceObservation, sizeBandFor, splitAddress, type EligibilityInput,
} from '../../src/analytics/lease-market/normalize';

const T = { rangeMaxSpread: 0.2, monthlyValueCeiling: 3 };
const OPEX = { tax: 1, ins: 0.25, cam: 0.5 };

describe('dates', () => {
  it('counts whole days and shifts dates', () => {
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
    expect(daysBetween('2026-03-01T12:00:00Z', '2026-03-02')).toBe(1);
    expect(addDays('2026-03-01', -365)).toBe('2025-03-01');
  });
});

describe('addresses', () => {
  it('abbreviates suffixes and directionals and splits embedded suites', () => {
    expect(splitAddress('1100 Rarig Avenue, Suite 200', null)).toEqual({ addressNorm: '1100 RARIG AVE', suiteNorm: '200' });
    expect(splitAddress('3540 East 5th Ave.', 'Ste. B')).toEqual({ addressNorm: '3540 E 5TH AVE', suiteNorm: 'B' });
    expect(splitAddress('55 New Plant Ct #104', null)).toEqual({ addressNorm: '55 NEW PLANT CT', suiteNorm: '104' });
  });
  it('does not treat a street-name word as a unit designator', () => {
    expect(splitAddress('100 Unit Road', null)).toEqual({ addressNorm: '100 UNIT RD', suiteNorm: '' });
  });
  it('explicit suite wins over an embedded one', () => {
    expect(splitAddress('9 Main St Suite 5', 'Unit 7')).toEqual({ addressNorm: '9 MAIN ST', suiteNorm: '7' });
  });
  it('normalizes suites', () => {
    expect(normalizeSuite('Unit A-2')).toBe('A-2');
    expect(normalizeSuite('# 104')).toBe('104');
    expect(normalizeSuite(null)).toBe('');
  });
});

describe('size bands and strata', () => {
  it('bands on the boundaries', () => {
    expect(sizeBandFor(4999)).toBe('<5K');
    expect(sizeBandFor(5000)).toBe('5-15K');
    expect(sizeBandFor(49999)).toBe('30-50K');
    expect(sizeBandFor(50000)).toBe('50-80K');
    expect(sizeBandFor(80000)).toBe('50-80K');
    expect(sizeBandFor(80001)).toBeNull();
    expect(sizeBandFor(0)).toBeNull();
  });
  it('stratifies only flex with a known office share', () => {
    expect(officeStratumFor('warehouse', 50, 40)).toBe('all');
    expect(officeStratumFor('flex', null, 40)).toBe('all');
    expect(officeStratumFor('flex', 40, 40)).toBe('office_ge40');
    expect(officeStratumFor('flex', 39.9, 40)).toBe('office_lt40');
  });
});

describe('parseRentText', () => {
  it('reads single yearly NNN quotes', () => {
    expect(parseRentText('$8.50/SF/YR NNN')).toEqual({ rentLow: 8.5, rentHigh: 8.5, rentPeriod: 'yr', basis: 'NNN', withheld: false });
  });
  it('reads ranges and modified gross', () => {
    expect(parseRentText('$8.00 - $10.00 /SF/YR Modified Gross')).toEqual({ rentLow: 8, rentHigh: 10, rentPeriod: 'yr', basis: 'MG', withheld: false });
  });
  it('reads monthly and industrial gross', () => {
    expect(parseRentText('$0.75/SF/MO IG')).toEqual({ rentLow: 0.75, rentHigh: 0.75, rentPeriod: 'mo', basis: 'IG', withheld: false });
    expect(parseRentText('$9.25 Industrial Gross')).toEqual({ rentLow: 9.25, rentHigh: 9.25, rentPeriod: null, basis: 'IG', withheld: false });
  });
  it('treats withheld / negotiable / blank as withheld', () => {
    expect(parseRentText('Withheld').withheld).toBe(true);
    expect(parseRentText('Call for pricing').withheld).toBe(true);
    expect(parseRentText('').withheld).toBe(true);
  });
  it('reads thousands separators without splitting numbers', () => {
    expect(parseRentText('$12000/YR').rentLow).toBe(12000);
    expect(parseRentText('$1,250/MO').rentLow).toBe(1250);
  });
});

describe('priceObservation', () => {
  const p = (rentLow: number | null, rentHigh: number | null, rentPeriod: 'yr' | 'mo' | null, rentBasis: Parameters<typeof priceObservation>[0]['rentBasis'], opex = OPEX as typeof OPEX | null) =>
    priceObservation({ rentLow, rentHigh, rentPeriod, rentBasis }, opex, ['tax', 'ins'], T);

  it('NNN yearly is high confidence and unchanged', () => {
    expect(p(8.5, 8.5, 'yr', 'NNN')).toEqual({ askingPsfYr: 8.5, effectiveBasis: 'NNN', askingNnnEq: 8.5, opexEstPsf: null, confidence: 'high' });
  });
  it('NNN monthly annualizes at high confidence', () => {
    const r = p(0.75, 0.75, 'mo', 'NNN');
    expect(r.askingNnnEq).toBeCloseTo(9);
    expect(r.confidence).toBe('high');
  });
  it('no period with a sub-3.00 value is monthly at low confidence', () => {
    const r = p(0.75, null, null, 'NNN');
    expect(r.askingPsfYr).toBeCloseTo(9);
    expect(r.confidence).toBe('low');
  });
  it('no period with a value >= 3.00 is yearly at high confidence', () => {
    expect(p(7, null, null, 'NNN').confidence).toBe('high');
  });
  it('a range wider than 20% becomes UNKNOWN', () => {
    expect(p(8, 10, 'yr', 'NNN')).toEqual({ askingPsfYr: null, effectiveBasis: 'UNKNOWN', askingNnnEq: null, opexEstPsf: null, confidence: 'low' });
  });
  it('a narrow range uses the midpoint and swaps inverted bounds', () => {
    expect(p(9, 10, 'yr', 'NNN').askingNnnEq).toBeCloseTo(9.5);
    expect(p(10, 9, 'yr', 'NNN').askingNnnEq).toBeCloseTo(9.5);
  });
  it('gross subtracts tax+ins+cam at low confidence', () => {
    expect(p(12, 12, 'yr', 'GROSS')).toEqual({ askingPsfYr: 12, effectiveBasis: 'GROSS', askingNnnEq: 10.25, opexEstPsf: 1.75, confidence: 'low' });
  });
  it('MG subtracts only the configured landlord-paid components', () => {
    expect(p(11, 11, 'yr', 'MG')).toEqual({ askingPsfYr: 11, effectiveBasis: 'MG', askingNnnEq: 9.75, opexEstPsf: 1.25, confidence: 'low' });
  });
  it('MG with no opex default has no NNN equivalent', () => {
    expect(p(11, 11, 'yr', 'MG', null).askingNnnEq).toBeNull();
  });
  it('withheld and missing rents carry nothing', () => {
    expect(p(8, 8, 'yr', 'WITHHELD').askingPsfYr).toBeNull();
    expect(p(null, null, 'yr', 'NNN').effectiveBasis).toBe('WITHHELD');
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
  ])('rejects %s', (_label, patch) => {
    expect(isBenchmarkEligible({ ...base, ...patch }, 80000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-normalize.test.ts`
Expected: FAIL — cannot resolve `normalize`.

- [ ] **Step 3: Write the implementation**

```ts
// src/analytics/lease-market/normalize.ts
//
// Lease Market Intelligence — pure normalization (spec §3.3). No I/O.
// Every rule here decides whether a listing enters a benchmark, so each has a boundary test in
// tests/unit/lease-market-normalize.test.ts. Financial-decision source: changes need a refute pass.
import {
  SIZE_BANDS,
  type BuildingStatus, type LmSubtype, type LmThresholds, type OfficeStratum, type OpexComponent,
  type OriginTier, type RentBasis, type SizeBand,
} from '../../contracts/lease-market';

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

export function normalizeSuite(raw: string | null | undefined): string {
  if (!raw) return '';
  const parts = raw.toUpperCase().replace(/#/g, ' # ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (parts.length > 0 && UNIT_TOKENS.has(parts[0]!)) parts.shift();
  return parts.join('');
}

export function splitAddress(rawAddress: string, rawSuite: string | null): { addressNorm: string; suiteNorm: string } {
  const tokens = rawAddress.toUpperCase().replace(/#/g, ' # ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let embeddedSuite: string | null = null;
  // A unit designator needs a house number and a street name before it, and a value after it.
  const unitIdx = tokens.findIndex((t, i) => i >= 2 && i < tokens.length - 1 && UNIT_TOKENS.has(t));
  if (unitIdx >= 0) {
    embeddedSuite = tokens.slice(unitIdx).join(' ');
    tokens.length = unitIdx;
  }
  const addressNorm = tokens.map((t) => STREET_SUFFIX[t] ?? DIRECTIONAL[t] ?? t).join(' ');
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
}

export function parseRentText(text: string): ParsedRentText {
  const t = text.trim();
  const withheld: ParsedRentText = { rentLow: null, rentHigh: null, rentPeriod: null, basis: null, withheld: true };
  if (!t || /withheld|negotiable|upon request|\bcall\b|\btbd\b|n\/a/i.test(t)) return withheld;
  const nums = [...t.matchAll(/(\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]!.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return withheld;
  const rentPeriod = /\/\s*(mo|month)\b|per\s+month|monthly/i.test(t)
    ? 'mo'
    : /\/\s*(yr|year)\b|per\s+year|annual/i.test(t)
      ? 'yr'
      : null;
  let basis: RentBasis | null = null;
  if (/\bNNN\b|triple\s+net/i.test(t)) basis = 'NNN';
  else if (/\bMG\b|modified\s+gross/i.test(t)) basis = 'MG';
  else if (/\bIG\b|industrial\s+gross/i.test(t)) basis = 'IG';
  else if (/\bFSG?\b|full\s+service/i.test(t)) basis = 'FSG';
  else if (/\bgross\b/i.test(t)) basis = 'GROSS';
  return { rentLow: nums[0]!, rentHigh: nums.length > 1 ? nums[1]! : nums[0]!, rentPeriod, basis, withheld: false };
}

// ── Pricing ──────────────────────────────────────────────────────────────────
export interface RentInput {
  rentLow: number | null;
  rentHigh: number | null;
  rentPeriod: 'yr' | 'mo' | null;
  rentBasis: RentBasis;
}
export interface OpexInput { tax: number; ins: number; cam: number }
export interface PricedObservation {
  askingPsfYr: number | null;
  effectiveBasis: RentBasis;
  askingNnnEq: number | null;
  opexEstPsf: number | null;
  confidence: 'high' | 'low';
}

const GROSS_COMPONENTS: readonly OpexComponent[] = ['tax', 'ins', 'cam'];

export function priceObservation(
  input: RentInput,
  opex: OpexInput | null,
  mgLandlordPays: readonly OpexComponent[],
  t: Pick<LmThresholds, 'rangeMaxSpread' | 'monthlyValueCeiling'>,
): PricedObservation {
  const none = (basis: RentBasis): PricedObservation => ({ askingPsfYr: null, effectiveBasis: basis, askingNnnEq: null, opexEstPsf: null, confidence: 'low' });
  if (input.rentBasis === 'WITHHELD' || input.rentBasis === 'UNKNOWN') return none(input.rentBasis);

  let low = input.rentLow ?? input.rentHigh;
  let high = input.rentHigh ?? input.rentLow;
  if (low === null || high === null) return none('WITHHELD');
  if (high < low) [low, high] = [high, low];
  if (low <= 0) return none('UNKNOWN');
  if ((high - low) / low > t.rangeMaxSpread) return none('UNKNOWN');

  const mid = (low + high) / 2;
  let askingPsfYr = mid;
  let periodInferred = false;
  if (input.rentPeriod === 'mo') askingPsfYr = mid * 12;
  else if (input.rentPeriod === null && mid < t.monthlyValueCeiling) {
    askingPsfYr = mid * 12;
    periodInferred = true;
  }

  if (input.rentBasis === 'NNN') {
    return { askingPsfYr, effectiveBasis: 'NNN', askingNnnEq: askingPsfYr, opexEstPsf: null, confidence: periodInferred ? 'low' : 'high' };
  }
  const components = input.rentBasis === 'MG' || input.rentBasis === 'IG' ? mgLandlordPays : GROSS_COMPONENTS;
  if (opex === null) {
    return { askingPsfYr, effectiveBasis: input.rentBasis, askingNnnEq: null, opexEstPsf: null, confidence: 'low' };
  }
  const opexEstPsf = components.reduce((sum, c) => sum + opex[c], 0);
  const nnn = askingPsfYr - opexEstPsf;
  return { askingPsfYr, effectiveBasis: input.rentBasis, askingNnnEq: nnn > 0 ? nnn : null, opexEstPsf, confidence: 'low' };
}

// ── Benchmark eligibility (spec §3.3) ────────────────────────────────────────
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

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-normalize.test.ts && npm run typecheck && npx eslint src/analytics/lease-market tests/unit/lease-market-normalize.test.ts --max-warnings 0`
Expected: all PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/lease-market/normalize.ts tests/unit/lease-market-normalize.test.ts
git commit -F <message-file>   # "feat(analytics): lease market normalization"
```
