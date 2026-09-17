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
// R9: a building designator (BLDG) is NOT an ordinary suite unit token -- "1100 Rarig Ave Bldg 1" and
// "...Bldg 2" are two physically distinct buildings on the same street address and must stay
// distinguishable in identity, even when a separate, ordinary suite ("Ste A") is also given. Keeping
// BLDG in the general UNIT_TOKENS set (as it was) meant it was either silently discarded (when a
// rawSuite was also supplied -- see splitAddress below) or collapsed into the SAME normalized form as
// an ordinary suite token (normalizeSuite('Bldg 2') === normalizeSuite('Ste 2') === '2'), so two
// different buildings -- or a building and an unrelated suite -- could land on one property/space row.
const SUITE_TOKENS: ReadonlySet<string> = new Set(['SUITE', 'STE', 'UNIT', '#']);
const BLDG_TOKENS: ReadonlySet<string> = new Set(['BLDG', 'BUILDING']);

function tokens(raw: string): string[] {
  return raw.toUpperCase().replace(/#/g, ' # ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

// Extracts a BLDG/BUILDING designator's value from a token list (wherever it sits -- before or after
// an ordinary suite token) and returns the remaining tokens alongside it, so callers can fold the
// building value into the suite identity instead of discarding it. `minIndex` mirrors the ordinary
// unit-token guard below (a designator needs a house number and street name before it when scanning a
// full address) -- callers scanning a bare suite string (which has no house number) pass 0.
function extractBuilding(parts: string[], minIndex = 0): { building: string | null; rest: string[] } {
  const idx = parts.findIndex((t, i) => i >= minIndex && i + 1 < parts.length && BLDG_TOKENS.has(t));
  if (idx < 0) return { building: null, rest: parts };
  const rest = [...parts.slice(0, idx), ...parts.slice(idx + 2)];
  return { building: parts[idx + 1]!, rest };
}

export function normalizeSuite(raw: string | null | undefined): string {
  if (!raw) return '';
  const { building, rest } = extractBuilding(tokens(raw));
  const parts = rest;
  while (parts.length > 0 && SUITE_TOKENS.has(parts[0]!)) parts.shift();
  const suite = parts.join('');
  if (building === null) return suite;
  return suite ? `B${building}-${suite}` : `B${building}`;
}

export function splitAddress(rawAddress: string, rawSuite: string | null): { addressNorm: string; suiteNorm: string } {
  const { building: embeddedBuilding, rest: afterBuilding } = extractBuilding(tokens(rawAddress), 2);
  const parts = afterBuilding;
  let embeddedSuite: string | null = null;
  // A unit designator needs a house number and a street name before it, and a value after it.
  const unitIdx = parts.findIndex((t, i) => i >= 2 && i < parts.length - 1 && SUITE_TOKENS.has(t));
  if (unitIdx >= 0) {
    embeddedSuite = parts.slice(unitIdx).join(' ');
    parts.length = unitIdx;
  }
  const addressNorm = parts.map((t) => STREET_SUFFIX[t] ?? DIRECTIONAL[t] ?? t).join(' ');
  // A blank/whitespace rawSuite must not shadow an embedded suite parsed from the address itself.
  const suiteSource = rawSuite !== null && rawSuite.trim() !== '' ? rawSuite : embeddedSuite;
  const suiteNorm = normalizeSuite(suiteSource);
  // The building designator (if any) is ALWAYS folded into suiteNorm, even when a separate rawSuite
  // was also given -- previously the rawSuite branch discarded the embedded building entirely, so
  // "Bldg 1"+"A" and "Bldg 2"+"A" both normalized to the same suiteNorm "A".
  if (embeddedBuilding === null) return { addressNorm, suiteNorm };
  return { addressNorm, suiteNorm: suiteNorm ? `B${embeddedBuilding}-${suiteNorm}` : `B${embeddedBuilding}` };
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
// Fix round 6: ONE shared token list for (a) EXPENSE_RE — whether a "+" is treated as an add-on split
// point at all, (b) CANONICAL_RE's add-on grammar shape, and (c) isFullExpenseAddon's full-vs-partial
// semantic check — so the three can never silently drift apart again. Round 5 widened the grammar to
// accept TAX/INS as add-on tokens but never widened EXPENSE_RE to match, so a bare "+ TAX"/"+ INS" (or
// one following an explicit MG/IG head) never even reached the partial-add-on/addonContradiction
// checks — `addon` stayed null, and the canonical grammar (which DID recognize the shape post round 5)
// raised no objection either. A full-expense FORM is one of FULL_FORM_ADDON_TOKENS on its own, or ALL
// of COMPONENT_ADDON_TOKENS present as a "/"-separated chain (any order) — see isFullExpenseAddon.
const FULL_FORM_ADDON_TOKENS = ['NNN', 'TICAM', 'nets?', 'expenses', 'opex'] as const;
const COMPONENT_ADDON_TOKENS = ['CAM', 'TAX', 'INS'] as const;
const ALL_ADDON_TOKENS = [...FULL_FORM_ADDON_TOKENS, ...COMPONENT_ADDON_TOKENS];
// EXPENSE_RE additionally tolerates a spaced "op ex" — broader on purpose, since its only job is
// deciding whether to ATTEMPT the add-on split; isFullExpenseAddon (built from the same shared list,
// but strict — no spaced "op ex") makes the final full-vs-partial call once split.
const EXPENSE_RE = new RegExp(String.raw`\b(?:${ALL_ADDON_TOKENS.join('|')})\b|\bop\s*ex\b`, 'i');
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

// Structural safety gate (fix round 3, controller design decision): two review rounds found
// high-confidence wrong-number paths through heuristic parsing that chasing individual strings would
// not close as a class ("2nd floor, 8.50/SF/YR NNN, $2.10 CAM" => 2.10; "$10.50/SF/YR (Gross), NNN
// est. $2.25" => NNN). A free-text quote is benchmark-grade only if it EXACTLY matches this canonical
// grammar — amount[/unit][/period][ range][ basis][ + expenses] — end to end; everything else is
// ambiguous, regardless of what the heuristics above computed. The heuristics remain as defence in
// depth (still produce the best-effort rentLow/basis/etc.), but this gate is the final word on
// whether that result is trusted for a benchmark.
const AMT = String.raw`\$?\s*(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)`;
const UNIT = String.raw`(?:\s*\/\s*(?:SF|sq\.?\s*ft\.?)|\s*psf)?`;
const PER = String.raw`(?:\s*\/\s*(?:yr|year|mo|month)|\s*per\s+(?:year|month|annum))?`;
const BASIS_WORD = String.raw`(?:NNN|triple\s+net|MG|modified\s+gross|IG|industrial\s+gross|FSG?|full\s+service(?:\s+gross)?|gross)`;
// Any of ALL_ADDON_TOKENS (the shared list above), in any order, "/"-separated (fix round 5: "+
// INS/TAX/CAM" is exactly as canonical as "+ CAM/TAX/INS" — the grammar only recognizes the SHAPE of
// an expense add-on; whether it names a full-expense FORM is isFullExpenseAddon's separate semantic
// check below, built from the SAME token list — fix round 6 — deliberately NOT space-separated and
// NOT tolerant of a spaced "op ex": the grammar is strict on both, so isFullExpenseAddon must be too,
// or the two silently disagree on what counts as clean (round 5's exact defect).
const ADDON_TOKEN = String.raw`(?:${ALL_ADDON_TOKENS.join('|')})`;
const ADDON_WORD = String.raw`${ADDON_TOKEN}(?:\s*\/\s*${ADDON_TOKEN})*`;
// Group 1 = the first (base) amount; group 2 = the optional range high-end amount (present only when
// the range clause matched). Both — and only these two — are capturing, so the parsed values can be
// cross-checked against the parser's own rentLow/rentHigh below (fix round 4): a match on the whole
// string is not by itself proof the parser extracted the same numbers the grammar just recognized.
// The basis-word parenthesis is balanced (either both "(" and ")" or neither — never one without the
// other), so a truncated/malformed "(NNN" no longer slips through as if it were clean.
const CANONICAL_RE = new RegExp(
  String.raw`^\s*(?:asking\s*:?\s*)?(${AMT})${UNIT}${PER}(?:\s*(?:-|–|—|to)\s*(${AMT})${UNIT}${PER})?(?:\s*,?\s*(?:\(${BASIS_WORD}\)|${BASIS_WORD}))?(?:\s*\+\s*(?:${AMT}${UNIT}${PER}\s*)?${ADDON_WORD})?\s*\.?\s*$`,
  'i',
);

// Parses a captured CANONICAL_RE amount the same way numberMatches does: strip "$"/commas/whitespace,
// leaving a plain numeric string Number() parses correctly including a leading-decimal form (".75").
function parseCapturedAmount(s: string): number {
  return Number(s.replace(/[$,\s]/g, ''));
}

const CLOSE_ENOUGH = 1e-9;
function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) < CLOSE_ENOUGH;
}

// Performance guard (fix round 4): a pathological run of whitespace or an otherwise very long string
// must never be run through CANONICAL_RE's alternation-heavy grammar at full length — collapse first
// (cheap, linear), then refuse anything still long after that rather than parse it at all.
const WHITESPACE_RUN_RE = /\s+/g;
const MAX_PARSEABLE_LENGTH = 200;

interface NumMatch {
  value: number;
  index: number;
  end: number;
}

function numberMatches(s: string): NumMatch[] {
  return [...s.matchAll(NUM_RE)]
    .map((m) => ({ value: Number(m[0].replace(/,/g, '')), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter((n) => Number.isFinite(n.value) && n.value > 0)
    // A percentage figure (a rent bump, escalation, or admin-fee percentage — spelled out as
    // "percent"/"pct" or given as a literal "%") is never itself a rent or add-on-opex candidate.
    .filter((n) => !/^\s*(?:%|percent\b|pct\b)/i.test(s.slice(n.end)));
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

// True when an un-anchored number plausibly IS the rent (so a later $-anchored figure — e.g. a
// CAM/expense estimate quoted with its own "$" — must not silently be promoted over it). A number
// glued to a letter ("2nd") or a "+" ("5+ year") is a floor/ordinal/term-length marker, never a
// rent figure, regardless of its value or what follows.
function looksLikeRentFigure(s: string, num: NumMatch, boundaryIndex: number): boolean {
  const nextChar = s[num.end] ?? '';
  if (/[a-zA-Z]/.test(nextChar) || nextChar === '+') return false;
  if (num.value >= 1 && num.value <= 60) return true;
  const following = s.slice(num.end, boundaryIndex);
  return PER_SF_RE.test(following) || MO_RE.test(following) || YR_RE.test(following) || basisTokensIn(following).length > 0;
}

// The first plausible rent-figure position in s (rule 4): when the text quotes a "$", this is the
// first $-anchored number; otherwise the first number, period. Used to gate the add-on "+" split —
// a "+" before this point ("5+ year term at $4.00/SF NNN") is a term-length marker, not an add-on
// separator, and must not carve the real rent figure off into the discarded addon text.
function firstRentCandidateIndex(s: string, hasDollarSign: boolean): number | null {
  const nums = numberMatches(s);
  if (nums.length === 0) return null;
  if (!hasDollarSign) return nums[0]!.index;
  const anchored = nums.find((n) => isDollarAnchored(s, n.index));
  return anchored ? anchored.index : null;
}

// An expense add-on resolves the base rent's basis to NNN only when it names a full-expense FORM —
// controller decision (fix round 5, market convention, conservative per the safety-over-yield rule):
// a FULL_FORM_ADDON_TOKENS word on its own, OR all of COMPONENT_ADDON_TOKENS (CAM/TAX/INS) present as
// a "/"-separated chain, any order — the SAME shape CANONICAL_RE's ADDON_WORD recognizes, built from
// the SAME shared token list above. CAM alone (or CAM plus only one of TAX/INS, or the three given
// space-separated rather than "/"-separated) is a PARTIAL component and must not be read as "the
// tenant pays everything" — a real, market-common defect class, not a hypothetical. Fix round 6:
// deliberately strict (no spaced "op ex", no space-separated CAM/TAX/INS) to match the grammar exactly
// — a looser check here than the grammar accepts is exactly how round 5's gate hole happened.
const FULL_FORM_ADDON_RE = new RegExp(String.raw`\b(?:${FULL_FORM_ADDON_TOKENS.join('|')})\b`, 'i');
// A "/"-separated run of CAM/TAX/INS tokens — mirrors ADDON_WORD's own component-chain shape, so a
// chain is "full" here iff the grammar would also recognize it as covering all three components.
const COMPONENT_CHAIN_RE = new RegExp(
  String.raw`\b(?:${COMPONENT_ADDON_TOKENS.join('|')})(?:\s*\/\s*(?:${COMPONENT_ADDON_TOKENS.join('|')}))*\b`,
  'gi',
);
function isFullExpenseAddon(addon: string): boolean {
  if (FULL_FORM_ADDON_RE.test(addon)) return true;
  for (const chain of addon.matchAll(COMPONENT_CHAIN_RE)) {
    const seen = chain[0]!.toUpperCase().split('/').map((s) => s.trim());
    if (COMPONENT_ADDON_TOKENS.every((token) => seen.includes(token))) return true;
  }
  return false;
}

// Add-on opex derivation from the expense text after a "+" (rule 7). Returns null when the
// figure isn't plausibly a per-SF/monthly opex add-on (e.g. a bare total-dollar CAM amount).
// R6: an add-on that states no period of its own inherits the BASE rent's period (`headPeriod`) --
// "$0.60/SF/MO + $0.20 NNN" is a monthly add-on figure just like the head it rides on, not a bare
// annual one; annualizing it only when the add-on independently states "/MO" (and never otherwise)
// silently understated it by 12x whenever the head itself was monthly.
function addonOpexValue(addon: string, headPeriod: 'yr' | 'mo' | null): number | null {
  const n = numberMatches(addon)[0]?.value ?? null;
  if (n === null) return null;
  const addonStatesMonthly = MO_RE.test(addon);
  const addonStatesYearly = YR_RE.test(addon);
  const addonPerSf = PER_SF_RE.test(addon);
  // R6: a period-less add-on inherits the base rent's own stated period -- an add-on that states its
  // OWN period (explicit "/MO"/"/YR") is authoritative and never inherits.
  const inheritedMonthly = !addonStatesMonthly && !addonStatesYearly && headPeriod === 'mo';
  const addonMonthly = addonStatesMonthly || inheritedMonthly;
  let value: number | null;
  if (addonPerSf) {
    value = addonMonthly ? n * 12 : n;
  } else if (addonStatesMonthly) {
    // Same "no /SF token, stated monthly" ambiguity rule 7 applies to the base rent for: a bare
    // monthly dollar figure with no per-SF marker of its own is not trustworthy as a per-SF estimate.
    value = null;
  } else if (n < 30) {
    value = inheritedMonthly ? n * 12 : n;
  } else {
    value = null;
  }
  // Fix round 5: reject AT the ceiling too (was: only strictly above it) — an add-on annualizing to
  // exactly $30/SF/yr is exactly as implausible as one just over it.
  return value !== null && value >= 30 ? null : value;
}

export function parseRentText(text: string): ParsedRentText {
  // Collapse internal whitespace runs first (cheap, linear) so pathological whitespace padding can't
  // inflate what reaches the regex pipeline below; a still-long string after that (not just padding)
  // is refused outright — never run through the full heuristic/grammar pipeline — and marked
  // ambiguous rather than silently withheld, so a downstream consumer can't mistake "too long to
  // trust" for "no quote".
  const t = text.trim().replace(WHITESPACE_RUN_RE, ' ');
  if (t.length > MAX_PARSEABLE_LENGTH) {
    return { rentLow: null, rentHigh: null, rentPeriod: null, basis: null, withheld: false, isTotal: false, opexQuoted: null, ambiguous: true };
  }
  const withheld: ParsedRentText = { rentLow: null, rentHigh: null, rentPeriod: null, basis: null, withheld: true, isTotal: false, opexQuoted: null, ambiguous: false };
  if (!t) return withheld;
  const hasDollar = t.includes('$');
  if (numberMatches(t).length === 0) return withheld;
  if (WITHHELD_RE.test(t) && !hasDollar) return withheld;

  // "$7.25/SF + $2.50 NNN" / "$12,000/month + expenses": base rent + expense add-on => NNN base
  // (unless the base rent itself states a contradictory MG/IG/GROSS/FSG basis), quoted opex.
  // The "+" must occur AFTER the first rent figure — "5+ year term at $4.00/SF NNN" is a
  // term-length marker, not an add-on separator, and must not carve the real rent figure off into
  // the discarded addon text.
  let basePart = t;
  let addon: string | null = null;
  const plusIdx = t.indexOf('+');
  if (plusIdx >= 0) {
    const firstRentIdx = firstRentCandidateIndex(t, hasDollar);
    if (firstRentIdx !== null && plusIdx > firstRentIdx && EXPENSE_RE.test(t.slice(plusIdx + 1))) {
      basePart = t.slice(0, plusIdx);
      addon = t.slice(plusIdx + 1);
    }
  }

  const allNums = numberMatches(basePart);
  // When the text quotes a dollar figure, the rent candidate is normally the FIRST $-anchored
  // number — an unrelated bare integer ("5+ year term", "2nd floor") must not be mistaken for the
  // rent. But if an EARLIER un-anchored number plausibly looks like the rent itself (e.g. a base
  // rent quoted with no "$", followed later by a "$"-anchored CAM/expense estimate), don't silently
  // promote the later $ figure over it — keep the earlier number and flag the parse as suspect.
  let m1: NumMatch;
  let earlyUnanchoredAmbiguous = false;
  if (hasDollar) {
    const firstAnchoredIdx = allNums.findIndex((n) => isDollarAnchored(basePart, n.index));
    // Scan ALL unanchored numbers before the first $-anchored one (not just the very first number
    // overall) — an excluded ordinal/floor number ("2nd") earlier in the text must not stop a later,
    // genuinely rent-like unanchored number ("8.50") from being found.
    const unanchoredBeforeAnchor = firstAnchoredIdx > 0 ? allNums.slice(0, firstAnchoredIdx) : [];
    const earlyMatch = unanchoredBeforeAnchor.find((n) => looksLikeRentFigure(basePart, n, allNums[firstAnchoredIdx]!.index));
    if (earlyMatch !== undefined) {
      m1 = earlyMatch;
      earlyUnanchoredAmbiguous = true;
    } else if (firstAnchoredIdx >= 0) {
      m1 = allNums[firstAnchoredIdx]!;
    } else {
      return withheld;
    }
  } else {
    if (allNums.length === 0) return withheld;
    m1 = allNums[0]!;
  }
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

  // The basis may be stated only after the head cut ("$8.50/SF/YR, NNN") — fall back to the tail
  // when the head states none, but ONLY when the tail states exactly one basis token and quotes no
  // "$" figure of its own (a tail with a second dollar amount, e.g. "(Gross), NNN est. $2.25", is
  // likely a separate expense clause, not a clean basis restatement, and a tail with two distinct
  // basis words is itself internally ambiguous) — otherwise this is a genuine conflict, not a fallback.
  const headTokens = basisTokensIn(head);
  const headStated = headTokens[0] ?? null;
  const tailTokens = basisTokensIn(tail);
  const tailUsable = tailTokens.length === 1 && !tail.includes('$');
  const tailStated = tailUsable ? tailTokens[0]! : null;
  const stated = headStated ?? tailStated;
  const basisConflict = headTokens.length > 1;
  const crossBasisConflict = headStated !== null && tailStated !== null && headStated !== tailStated;
  const tailBasisRejected = headStated === null && tailTokens.length > 0 && !tailUsable;
  let basis: RentBasis | null;
  let addonContradiction = false;
  let partialExpenseAddon = false;
  if (addon !== null) {
    if (stated === null) {
      // The add-on is the ONLY thing resolving the basis here — it must name a full-expense form
      // (fix round 5) to be trusted as NNN; a partial one ("+ CAM" alone) keeps the parsed amounts
      // but leaves basis unresolved and flags the parse as suspect, rather than silently assuming
      // the tenant pays everything.
      if (isFullExpenseAddon(addon)) {
        basis = 'NNN';
      } else {
        basis = null;
        partialExpenseAddon = true;
      }
    } else if (stated === 'NNN') {
      // The head/tail already independently confirmed NNN — the add-on is supplementary detail
      // about what's covered, not what's resolving the basis, so a partial add-on here doesn't
      // degrade an already-explicit statement.
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
  // R7: MONTHLY_TOTAL_THRESHOLD is the boundary between "this monthly figure is plausibly a per-SF
  // rate" and "this is almost certainly a total monthly dollar amount" -- a /mo figure at or above it
  // is treated as a total (unchanged); below it, a /mo figure with NO /SF token of its own is neither
  // a trustworthy total NOR a trustworthy per-SF rate -- it must be ambiguous, not silently priced as
  // per-SF (the "$4.50/MO NNN" => $54.00/SF/yr defect).
  const MONTHLY_TOTAL_THRESHOLD = 50;
  const isTotal = !perSf && (maxVal >= 1000 || (rentPeriod === 'mo' && maxVal >= MONTHLY_TOTAL_THRESHOLD));
  const monthlyNoSfBelowThreshold = !perSf && rentPeriod === 'mo' && !isTotal;
  let ambiguous =
    addonContradiction ||
    basisConflict ||
    crossBasisConflict ||
    tailBasisRejected ||
    partialExpenseAddon ||
    periodConflict ||
    tailConflict ||
    earlyUnanchoredAmbiguous ||
    monthlyNoSfBelowThreshold ||
    (!perSf && !isTotal && maxVal >= 60);
  // Structural safety gate, applied last: a free-text quote is benchmark-grade only if the WHOLE
  // string matches the strict canonical grammar above — everything else is ambiguous, regardless of
  // what the heuristics above concluded. This is additive, not a replacement for them.
  const canonMatch = CANONICAL_RE.exec(t);
  if (canonMatch === null) {
    ambiguous = true;
  } else {
    // A grammar match alone is not proof the parser extracted the same numbers the grammar just
    // recognized — the parser's own range detector uses a narrower, independently-maintained unit/
    // period grammar (rules 4/16/17) that can miss a range form this grammar accepts (bare "psf",
    // "per year", an unanchored range high-end). Cross-checking the captured amounts against
    // rentLow/rentHigh makes the two impossible to silently disagree: any mismatch is ambiguous.
    const amt1 = parseCapturedAmount(canonMatch[1]!);
    const rangeCapture = canonMatch[2];
    const expectedHigh = rangeCapture !== undefined ? parseCapturedAmount(rangeCapture) : amt1;
    if (!closeEnough(amt1, rentLow) || !closeEnough(expectedHigh, rentHigh)) {
      ambiguous = true;
    }
  }
  // Fix round 6: a PARTIAL add-on's figure (e.g. bare "CAM") is not total opex — reporting it as
  // opexQuoted would feed a market quoted-opex estimate as if it covered tax+insurance+CAM together,
  // when it covers only one component. This applies regardless of what `basis` ended up being (even
  // when an explicit head NNN keeps `basis: 'NNN'` despite the add-on being partial).
  const opexQuoted = addon !== null && isFullExpenseAddon(addon) ? addonOpexValue(addon, rentPeriod) : null;
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

  // R15: CoStar uses a bare 0 as a "no high stated" sentinel on a numeric rentHigh column (and,
  // symmetrically, could on rentLow) -- treat a 0 on EITHER side as null (not a real $0 quote) BEFORE
  // falling back to the other side and swapping, so "rentLow 8.50, rentHigh 0" resolves to a clean
  // single-sided $8.50 quote instead of swapping to low=0 and being rejected as "non-positive rent".
  const rentLow0 = input.rentLow === 0 ? null : input.rentLow;
  const rentHigh0 = input.rentHigh === 0 ? null : input.rentHigh;
  let low = rentLow0 ?? rentHigh0;
  let high = rentHigh0 ?? rentLow0;
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
