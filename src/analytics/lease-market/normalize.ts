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
  // A blank/whitespace rawSuite must not shadow an embedded suite parsed from the address itself.
  const suiteSource = rawSuite !== null && rawSuite.trim() !== '' ? rawSuite : embeddedSuite;
  return { addressNorm, suiteNorm: normalizeSuite(suiteSource) };
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

const WITHHELD_RE = /\bwithheld\b|(?<!non-)\bnegotiable\b|upon request|\bcall\b|\btbd\b|(?:^|\s)n\/a(?:\s|$)/i;
const NUM_RE = /(\d+(?:,\d{3})+(?:\.\d+)?|\d*\.\d+|\d+)/g;
const EXPENSE_RE = /\b(NNN|CAM|TICAM|opex|op\s*ex|expenses|nets?)\b/i;
const PER_SF_RE = /\/\s*(?:SF|sq\.?\s*ft\.?)\b|\bpsf\b|per\s+(?:SF|sq\.?\s*ft|square\s+foot)/i;
const MO_RE = /\/\s*(mo|month)\b|per\s+month|\bmonthly\b/i;
const YR_RE = /\/\s*(yr|year|annum)\b|per\s+(year|annum)/i;
// A basis token allowed to sit between the two figures of a range (e.g. "$8/SF/YR NNN - $10/SF/YR NNN").
const RANGE_BASIS_WORD = '(?:NNN|MG|IG|FSG?|triple\\s+net|modified\\s+gross|industrial\\s+gross|full\\s+service|gross)';
// Gap between the first two rent numbers that makes them a range rather than two independent figures
// (e.g. a base rent followed by an unrelated CAM figure or escalation %).
const RANGE_SEP_RE = new RegExp(
  `^\\s*(?:\\/\\s*(?:SF|sq\\.?\\s*ft\\.?)(?:\\s*\\/\\s*(?:yr|year|mo|month))?\\s*)?(?:${RANGE_BASIS_WORD}\\s*)?(?:-|–|—|to)\\s*\\$?\\s*$`,
  'i',
);
const HEAD_DELIM_RE = /,|;|\(| w\/| with /i;
// A bare "gross" that is not just the tail end of "modified gross" / "industrial gross" / "full
// service (gross)" (those are already counted as MG/IG/FSG) — used to detect a genuinely
// contradictory second basis token.
const BARE_GROSS_RE = /(?<!modified\s)(?<!industrial\s)(?<!service\s)\bgross\b/i;
// A bare range separator with nothing else around it — used when the second figure isn't itself
// $-anchored (e.g. "$12-14/SF/YR"), so only a plain "12-14"/"12 to 14" gap still counts as a range
// and an unrelated bare number elsewhere in the text (a term length, a CAM %) does not.
const BARE_RANGE_SEP_RE = /^\s*(?:-|–|—|to)\s*$/i;

interface NumMatch {
  value: number;
  index: number;
  end: number;
}

function numberMatches(s: string): NumMatch[] {
  return [...s.matchAll(NUM_RE)]
    .map((m) => ({ value: Number(m[0].replace(/,/g, '')), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter((n) => Number.isFinite(n.value) && n.value > 0);
}

// All distinct basis tokens found in s, in the same priority order basisIn used to return the first
// of (NNN > MG > IG > FSG > bare GROSS). More than one distinct token means the text states two
// contradictory bases (e.g. "MG NNN") — a real find from adversarial review, not a hypothetical.
function basisTokensIn(s: string): RentBasis[] {
  const found: RentBasis[] = [];
  if (/\bNNN\b|triple\s+net/i.test(s)) found.push('NNN');
  if (/\bMG\b|modified\s+gross/i.test(s)) found.push('MG');
  if (/\bIG\b|industrial\s+gross/i.test(s)) found.push('IG');
  if (/\bFSG?\b|full\s+service/i.test(s)) found.push('FSG');
  if (BARE_GROSS_RE.test(s)) found.push('GROSS');
  return found;
}

// Rent-text head (rule 5) plus the truncated-away tail, so callers can check whether the tail
// contradicts what the head implies (e.g. a parenthetical "(monthly)" dropped by truncation).
function headAndTailOf(basePart: string, lastNumEnd: number): { head: string; tail: string } {
  const rest = basePart.slice(lastNumEnd);
  const m = HEAD_DELIM_RE.exec(rest);
  const cut = m ? lastNumEnd + m.index : basePart.length;
  return { head: basePart.slice(0, cut), tail: basePart.slice(cut) };
}

// A number is only a rent-figure candidate when the text quotes a dollar amount ($) if it is
// itself dollar-anchored — otherwise an unrelated integer elsewhere in the string (a lease-term
// year count, a floor number) can be mistaken for the rent.
function isDollarAnchored(s: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(s[i]!)) i--;
  return i >= 0 && s[i] === '$';
}

// Add-on opex derivation from the expense text after a "+" (rule 7). Returns null when the
// figure isn't plausibly a per-SF/monthly opex add-on (e.g. a bare total-dollar CAM amount).
function addonOpexValue(addon: string): number | null {
  const n = numberMatches(addon)[0]?.value ?? null;
  if (n === null) return null;
  const addonMonthly = MO_RE.test(addon);
  const addonPerSf = PER_SF_RE.test(addon);
  let value: number | null;
  if (addonPerSf) {
    value = addonMonthly ? n * 12 : n;
  } else if (!addonMonthly && n < 30) {
    value = n;
  } else {
    value = null;
  }
  return value !== null && value > 30 ? null : value;
}

export function parseRentText(text: string): ParsedRentText {
  const t = text.trim();
  const withheld: ParsedRentText = { rentLow: null, rentHigh: null, rentPeriod: null, basis: null, withheld: true, isTotal: false, opexQuoted: null, ambiguous: false };
  if (!t) return withheld;
  const hasDollar = t.includes('$');
  if (numberMatches(t).length === 0) return withheld;
  if (WITHHELD_RE.test(t) && !hasDollar) return withheld;

  // "$7.25/SF + $2.50 NNN" / "$12,000/month + expenses": base rent + expense add-on => NNN base
  // (unless the base rent itself states a contradictory MG/IG/GROSS/FSG basis), quoted opex.
  let basePart = t;
  let addon: string | null = null;
  const plusIdx = t.indexOf('+');
  if (plusIdx >= 0 && EXPENSE_RE.test(t.slice(plusIdx + 1))) {
    basePart = t.slice(0, plusIdx);
    addon = t.slice(plusIdx + 1);
  }

  const allNums = numberMatches(basePart);
  // When the text quotes a dollar figure, the FIRST rent candidate must itself be $-anchored — an
  // unrelated bare integer ("5+ year term", "2nd floor") must not be mistaken for the rent. The
  // second (range-high) figure is not required to repeat the "$" (short forms like "$12-14/SF/YR"
  // only carry one) — it just needs a plausible range gap to the first figure; see below.
  const anchoredNums = hasDollar ? allNums.filter((n) => isDollarAnchored(basePart, n.index)) : allNums;
  if (anchoredNums.length === 0) return withheld;
  const m1 = anchoredNums[0]!;
  const m2 = allNums[allNums.indexOf(m1) + 1] ?? null;
  const gap = m2 !== null ? basePart.slice(m1.end, m2.index) : '';
  // An un-anchored m2 only counts as a range high-end on a BARE separator (no unit/basis token in
  // between) — otherwise a trailing CAM figure or escalation % must not become a false range.
  const m2Anchored = m2 !== null && (!hasDollar || isDollarAnchored(basePart, m2.index));
  const isRange = m2 !== null && (m2Anchored ? RANGE_SEP_RE.test(gap) : BARE_RANGE_SEP_RE.test(gap));
  const rentLow = m1.value;
  const rentHigh = isRange ? m2!.value : m1.value;

  const { head, tail } = headAndTailOf(basePart, isRange ? m2!.end : m1.end);
  const headMo = MO_RE.test(head);
  const headYr = YR_RE.test(head);
  // A head that states both a monthly and a yearly marker is self-contradictory, not "monthly wins".
  const periodConflict = headMo && headYr;
  const rentPeriod = periodConflict ? null : headMo ? 'mo' : headYr ? 'yr' : null;
  // The text truncated out of the head (rule 5) may still state a period that contradicts — or
  // supplies where the head lacks — one; either way that makes this parse suspect, not silently clean.
  const tailPeriod = MO_RE.test(tail) ? 'mo' : YR_RE.test(tail) ? 'yr' : null;
  const tailConflict = tailPeriod !== null && tailPeriod !== rentPeriod;

  const statedTokens = basisTokensIn(head);
  const stated = statedTokens[0] ?? null;
  const basisConflict = statedTokens.length > 1;
  let basis: RentBasis | null;
  let addonContradiction = false;
  if (addon !== null) {
    if (stated === null || stated === 'NNN') {
      basis = 'NNN';
    } else {
      basis = stated;
      addonContradiction = true;
    }
  } else {
    basis = stated;
  }

  const perSf = PER_SF_RE.test(head);
  const maxVal = Math.max(rentLow, rentHigh);
  const isTotal = !perSf && (maxVal >= 1000 || (rentPeriod === 'mo' && maxVal >= 50));
  const ambiguous =
    addonContradiction || basisConflict || periodConflict || tailConflict || (!perSf && !isTotal && maxVal >= 60);
  const opexQuoted = addon !== null ? addonOpexValue(addon) : null;
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
  if (!Number.isFinite(low) || !Number.isFinite(high)) return none('UNKNOWN', 'non-numeric rent');
  if (high < low) [low, high] = [high, low];
  if (low <= 0) return none('UNKNOWN', 'non-positive rent');
  const spread = (high - low) / low;
  if (spread > t.rangeMaxSpread + 1e-9) return none('UNKNOWN', `range spread ${(spread * 100).toFixed(0)}% > ${(t.rangeMaxSpread * 100).toFixed(0)}%`);
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
    } else if (opex.tax === null || opex.ins === null || opex.cam === null) {
      // MG/IG conversion needs a component-level estimate — a total-only (quoted-median) opex
      // estimate can't be attributed to specific landlord-paid components, even when
      // mgLandlordPays is empty (which would otherwise vacuously "sum" to zero).
      estimate = null;
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
