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
