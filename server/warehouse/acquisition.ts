// server/warehouse/acquisition.ts
//
// Deterministic Acquisition Scorecard engine — a PURE function of (input, ruleset). Re-running on the
// same inputs deep-equals the prior result (scoredAt is the only wall-clock field, and it is injectable
// for tests). The LLM/analyst may POPULATE inputs (comp research, characteristics, motivation signals);
// the engine NEVER lets the model move the number (mirrors scores.ts:1–6 determinism boundary).
//
// Precedence (the skill's STAGE 0 → 1 → 2 → 2.5 → verdict cascade):
//   gate KILL  >  floor KILL  >  composite band  >  (DD-unknown | incomplete-ruleset | Q3 guard |
//   floor-indeterminate) cap-to-T2.  Caps only ever DOWNGRADE; nothing upgrades a KILLED/PASS.
//
// FAIL-CLOSED: this file is financial-decision code feeding capital allocation. The production caller
// MUST call assertProductionRuleset() first; the engine refuses to bless a verdict computed on a
// 'proposed' or incomplete ruleset (advisoryOnly / incompleteRuleset surface that to every consumer).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stableStringify } from './stable-stringify';
import { assertPinnedRct, assertPlausibleRct, assertRawIsCanonical, isSyntheticRct, RATIFIED_RCT_HMAC, RCT_PIN_KEY_ENV } from './rct-pin';
import {
  AcquisitionInput,
  AcquisitionRuleset,
  AcquisitionScore,
  RCT_VERSION,
  ReplacementCostTable,
} from '../../src/contracts/acquisition';
import type {
  ClusterTier,
  ConstructionType,
  FloorResult,
  GateResult,
  ScorecardCategoryId,
  SubScore,
  SubScoreResult,
  Tier,
  Verdict,
} from '../../src/contracts/acquisition';
import type { Confidence, DataQualityFlag } from '../../src/contracts/common';
import { adderTotal, adjustBand, basisClearsFloor, basisDiscount, constructionMultiplier, tiltSfFor } from '../../src/lib/rct-adjust';
import { clamp } from './clamp';
const round1 = (v: number): number => Math.round(v * 10) / 10;

// ─── Ruleset load + fail-closed production guard ───────────────────────────────────────────────
export function parseRuleset(json: unknown): AcquisitionRuleset {
  return AcquisitionRuleset.parse(json);
}
export function loadRuleset(path: string): AcquisitionRuleset {
  return parseRuleset(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
/** Refuse to allocate capital on a non-ratified or incomplete ruleset. Production callers MUST call this. */
export function assertProductionRuleset(r: AcquisitionRuleset): void {
  if (r.ratification !== 'ratified') {
    throw new Error(
      `acquisition ruleset ${r.rulesetVersion} is '${r.ratification}', not 'ratified' — engine fail-closed; Gabriel must ratify the scorecard Q1–Q6 decision list first`,
    );
  }
  if (r.scoring.cat3.clearHeightBands === null) {
    throw new Error(
      `acquisition ruleset ${r.rulesetVersion} has clearHeightBands=null (SKILL.md:52-57 not transcribed) — incomplete; engine fail-closed`,
    );
  }
  if (r.ratifiedBy === null || r.ratifiedDate === null) {
    throw new Error(
      `acquisition ruleset ${r.rulesetVersion} is 'ratified' but missing provenance (ratifiedBy/ratifiedDate) — fail-closed (Invariant 4)`,
    );
  }
  // Refute-fix (2026-07-14, RCT v03 refute pass, sonnet lens x2): basisFullCreditDiscount and the
  // vintage floors are a MATCHED PAIR — the Cat 1 Basis formula divides by (basisFull - vintageFloor).
  // A prior edit bumped the floors (RCT v03 recalibration) without re-solving basisFullCreditDiscount,
  // leaving it BELOW both floors — the divide-by-zero guard silently clamped the denominator to ~0,
  // collapsing the graduated 25-pt Basis ramp into a step function (any deal that cleared the floor at
  // all scored the full 25 points, identically). Fail closed on a repeat of this exact class of mistake
  // rather than silently degrading score granularity.
  const worstFloor = Math.max(r.floors.basisDiscountMinPreMillennium, r.floors.basisDiscountMinPostMillennium);
  if (r.scoring.basisFullCreditDiscount <= worstFloor) {
    throw new Error(
      `acquisition ruleset ${r.rulesetVersion} has basisFullCreditDiscount (${r.scoring.basisFullCreditDiscount}) <= its strictest vintage floor (${worstFloor}) — the Basis scorecard ramp would collapse to a step function; engine fail-closed`,
    );
  }
}

/** Canonical homes of the ratified production config. */
export const RATIFIED_RULESET_PATH = 'config/acquisition-ruleset.v1.json';
export const REPLACEMENT_COST_TABLE_PATH = 'config/replacement-cost.v3.json';
/** Load + assert the ratified production ruleset (fail-closed). */
export function loadRatifiedRuleset(path: string = RATIFIED_RULESET_PATH): AcquisitionRuleset {
  const r = loadRuleset(path);
  assertProductionRuleset(r);
  return r;
}
/** Refuse a non-ratified or unsigned Replacement-Cost Table — symmetric to assertProductionRuleset. */
export function assertProductionRct(rct: ReplacementCostTable): void {
  if (rct.ratification !== 'ratified') {
    throw new Error(`replacement-cost table ${rct.rctVersion} is '${rct.ratification}', not 'ratified' — engine fail-closed`);
  }
  if (rct.ratifiedBy === null || rct.ratifiedDate === null) {
    throw new Error(`replacement-cost table ${rct.rctVersion} is 'ratified' but missing provenance (ratifiedBy/ratifiedDate) — fail-closed`);
  }
}
/**
 * Options for the RCT loaders. The defaults are the PRODUCTION posture. Only code can relax them (tests load the
 * synthetic stand-in through tests/support/rct.ts); no environment variable can.
 */
export interface RctLoadOptions {
  /** Accept the committed synthetic stand-in (`_synthetic: true`). Default false: production refuses it. */
  allowSynthetic?: boolean;
  /** HMAC the table must match under RCT_PIN_KEY; null skips the pin (tests only). Default: RATIFIED_RCT_HMAC. */
  pinnedHmac?: string | null;
  /** Where RCT_PIN_KEY is read from. Default process.env. */
  env?: Record<string, string | undefined>;
}
function readRctRaw(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`replacement-cost table not found at ${path} (${code ?? 'read error'}); the ratified table is local-only, see docs/ops/rct-runtime-config.md — fail-closed`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`replacement-cost table at ${path} is not valid JSON — fail-closed`);
  }
}
/** Parse a Replacement-Cost Table (no ratification or pin assertion; still refuses the synthetic stand-in unless allowed). */
export function loadReplacementCostTable(path: string = REPLACEMENT_COST_TABLE_PATH, opts: RctLoadOptions = {}): ReplacementCostTable {
  const raw = readRctRaw(path);
  if (isSyntheticRct(raw) && opts.allowSynthetic !== true) {
    throw new Error(`replacement-cost table at ${path} is the synthetic test stand-in, not the ratified table — fail-closed. See docs/ops/rct-runtime-config.md`);
  }
  const parsed = ReplacementCostTable.parse(raw);
  assertRawIsCanonical(raw, parsed);
  return parsed;
}
/** Load + assert the ratified Replacement-Cost Table (fail-closed; Q5): ratified + signed, plausible, and the pinned table. */
export function loadRatifiedRct(path: string = REPLACEMENT_COST_TABLE_PATH, opts: RctLoadOptions = {}): ReplacementCostTable {
  const rct = loadReplacementCostTable(path, opts);
  assertProductionRct(rct);
  assertPlausibleRct(rct);
  const pinned = opts.pinnedHmac === undefined ? RATIFIED_RCT_HMAC : opts.pinnedHmac;
  if (pinned !== null) assertPinnedRct(rct, (opts.env ?? process.env)[RCT_PIN_KEY_ENV], pinned);
  return rct;
}
/**
 * Per-market replacement cost $/SF from the RCT — the Basis floor/score divisor.
 *
 * Uses the deal's market row when the RCT covers it. Falls back to the CONSERVATIVE firm-wide `psf`
 * row (the cheapest market to build in ⇒ the STRICTEST floor) when the market is null or uncovered.
 * We never hand a deal a looser floor because we failed to identify its market.
 */
export function replacementCostPsf(
  rct: ReplacementCostTable,
  band: 'low' | 'mid' | 'high' = 'mid',
  market: string | null = null,
  /** Construction-type multiplier and adder $/SF (src/lib/rct-adjust.ts). Omitted => the tilt-up baseline, no adders. */
  adj: { multiplier: number; adderPsf: number } = { multiplier: 1, adderPsf: 0 },
): { psf: number; marketCovered: boolean; proxy: boolean } {
  // Own keys only: a free-string market such as 'constructor' must take the fallback, never an Object.prototype member.
  const row = market !== null && Object.prototype.hasOwnProperty.call(rct.markets, market) ? rct.markets[market] : undefined;
  const base = row === undefined ? { low: rct.psf.low, point: rct.psf.mid, high: rct.psf.high } : row;
  const b = adjustBand(base, adj.multiplier, adj.adderPsf);
  const psf = band === 'low' ? b.low : band === 'high' ? b.high : b.point;
  return row === undefined ? { psf, marketCovered: false, proxy: false } : { psf, marketCovered: true, proxy: row.proxy };
}

/** Replacement-cost total for a building from the RCT — the Basis floor/score divisor. */
export function replacementCostTotal(
  sf: number,
  rct: ReplacementCostTable,
  band: 'low' | 'mid' | 'high' = 'mid',
  market: string | null = null,
  /** Construction-type multiplier and adders; omitted => the tilt-up baseline (×1.00, no adders), NOT the engine's
   *  construction-adjusted divisor. */
  adj: { multiplier: number; adderPsf: number } = { multiplier: 1, adderPsf: 0 },
): number {
  return sf * replacementCostPsf(rct, band, market, adj).psf;
}

/**
 * Basis discount floor for a vintage — LINEAR RAMP (RCT v03, ratified 2026-07-14).
 *
 * Slides from `basisDiscountMinPreMillennium` at/below `basisVintageRampStartYear` to
 * `basisDiscountMinPostMillennium` at/above `basisVintageCutoffYear`. This replaced a CLIFF, which
 * was a step function AND calibrated to the old, understated denominator.
 *
 * Unknown vintage ⇒ the STRICTEST (pre) floor. Never credit a building with a looser floor because
 * we failed to look up its year.
 */
export function basisVintageFloor(yearBuilt: number | null, ruleset: AcquisitionRuleset): number {
  const { basisDiscountMinPreMillennium: strict, basisDiscountMinPostMillennium: loose } = ruleset.floors;
  const start = ruleset.floors.basisVintageRampStartYear;
  const end = ruleset.floors.basisVintageCutoffYear;
  if (yearBuilt === null) return strict;
  if (end <= start) return yearBuilt >= end ? loose : strict; // degenerate config ⇒ behave as a cliff
  const clamped = Math.min(end, Math.max(start, yearBuilt));
  return strict + ((clamped - start) / (end - start)) * (loose - strict);
}

/** Floor-comparison precision (1e-8). Both sides of a STAGE 1 IRR/yield comparison are rounded to it, so a percent the
 *  Grader form converts with n/100 (10.1/100 = 0.10099999999999999) meets a floor computed as 0.046 + 0.055 = 0.101
 *  (refute wf_27e6656a-51c: 429 of 4,002 exact-boundary form entries were KILLED before this). */
export function atFloorPrecision(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}

/** Parse a date ONLY when it is anchored to UTC: 'YYYY-MM-DD' (parsed as UTC midnight) or an ISO date-time carrying Z
 *  or an explicit offset. Anything else (a zone-less date-time, '10/13/2026') would be read in the host's local timezone,
 *  so the same input could flag differently on the local server and the UTC edge function; it returns NaN instead. */
export function parseUtcAnchoredDate(v: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(v);
  if (m === null) return NaN;
  // Calendar-validate the fields: V8 silently rolls an impossible day forward ('2026-02-30' => 2026-03-02).
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const daysInMonth = mo >= 1 && mo <= 12 ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 0;
  if (d < 1 || d > daysInMonth) return NaN;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return NaN;
  return Date.parse(v);
}

export interface UnleveredIrrFloor {
  /** The 10-yr unlevered IRR the deal must meet or beat (>=). */
  required: number;
  /** When the vacant share at close is UNKNOWN on a not-fully-vacant deal, the floor WITH the majority-vacant premium:
   *  an IRR between `required` and this value clears only because the premium was skipped, so the floor is
   *  indeterminate (Gabriel in-turn 2026-11-12: cap at T2 when the unknown share decides). Null otherwise. */
  requiredIfMajorityVacant: number | null;
  /** Human-readable derivation for the floor line: UST value and date, and any majority-vacant premium. */
  basis: string;
  /** Data-quality flags as [field, issue]. */
  flags: Array<[string, string]>;
}

/**
 * The STAGE 1 IRR floor (ruleset 2.0.0, Gabriel in-turn 2026-11-12; acquisition-underwriting SKILL.md v4.45, v4.33 +
 * v4.40): MAX(unleveredIrrFloorMin, UST + unleveredIrrUstSpread), + majorityVacantIrrPremium when MORE than
 * majorityVacantSfShare of the SF is vacant at close.
 *   - UST unknown ⇒ test at unleveredIrrFloorMin and flag [UST UNVERIFIED] (doctrine's FRED-unreachable rule).
 *   - Vacant share: isVacant (100% vacant) is decisive and always takes the premium — the strictest reading wins over
 *     a contradictory share. Otherwise the supplied share decides; unknown ⇒ no premium, flagged (a fully-vacant deal
 *     is caught by isVacant; a partial vacancy needs the share supplied).
 * Rounded to 1e-8 so a sum such as 0.05 + 0.055 compares equal to the decimal 0.105 a caller supplies at the boundary.
 */
export function unleveredIrrFloor(
  input: Pick<AcquisitionInput, 'ust10yr' | 'ustAsOf' | 'vacantSfShareAtClose' | 'isVacant' | 'asAtUtc'>,
  ruleset: AcquisitionRuleset,
  /** The screen date the UST must be current as of: input.asAtUtc when supplied, else the engine's scoring clock
   *  (refute wf_47a03538-486: no production caller sets asAtUtc, so the check never ran). Null => unverifiable, flagged. */
  screenAtIso: string | null = input.asAtUtc,
): UnleveredIrrFloor {
  const f = ruleset.floors;
  const flags: Array<[string, string]> = [];
  const pct = (x: number, dp: number): string => `${(x * 100).toFixed(dp)}%`;
  let base = f.unleveredIrrFloorMin;
  let basis: string;
  if (input.ust10yr === null) {
    flags.push(['ust10yr', `[UST UNVERIFIED] 10-yr UST not supplied — IRR floor tested at ${pct(f.unleveredIrrFloorMin, 1)}`]);
    basis = `MAX(${pct(f.unleveredIrrFloorMin, 1)}, UST + ${pct(f.unleveredIrrUstSpread, 2)}) — UST UNVERIFIED, tested at ${pct(f.unleveredIrrFloorMin, 1)}`;
  } else {
    if (input.ustAsOf === null) flags.push(['ustAsOf', '10-yr UST supplied without its as-of date — the floor line must cite value and date']);
    else {
      // Doctrine: the trailing 30-day average AS OF THE SCREEN DATE. A UST dated after the screen, or more than 30 days
      // before it, is still used (it is the cited value) but flagged so a stale or mis-dated rate is visible.
      const ustAt = parseUtcAnchoredDate(input.ustAsOf);
      const screenAt = screenAtIso !== null ? parseUtcAnchoredDate(screenAtIso) : NaN;
      if (Number.isNaN(ustAt)) flags.push(['ustAsOf', `10-yr UST as-of date '${input.ustAsOf}' is not a UTC-anchored date (use YYYY-MM-DD) — recency not checked`]);
      else if (Number.isNaN(screenAt)) flags.push(['ustAsOf', '10-yr UST recency unverifiable — no usable screen date']);
      else {
        // Whole UTC calendar days, so the flag depends only on the two dates, never on the time of day the score runs.
        const days = Math.floor(screenAt / 86_400_000) - Math.floor(ustAt / 86_400_000);
        if (days < 0) flags.push(['ustAsOf', `10-yr UST is dated ${input.ustAsOf}, after the screen date — check the rate`]);
        else if (days > 30) flags.push(['ustAsOf', `10-yr UST is dated ${input.ustAsOf}, ${days} days before the screen — doctrine uses the 30-day average as of the screen date`]);
      }
    }
    base = Math.max(f.unleveredIrrFloorMin, input.ust10yr + f.unleveredIrrUstSpread);
    basis = `MAX(${pct(f.unleveredIrrFloorMin, 1)}, UST ${pct(input.ust10yr, 2)} as of ${input.ustAsOf ?? 'undated'} + ${pct(f.unleveredIrrUstSpread, 2)})`;
  }
  let majorityVacant: boolean;
  let shareUnknown = false;
  if (input.isVacant) majorityVacant = true;
  else if (input.vacantSfShareAtClose !== null) majorityVacant = input.vacantSfShareAtClose > f.majorityVacantSfShare;
  else {
    majorityVacant = false;
    shareUnknown = true;
    flags.push(['vacantSfShareAtClose', `vacant SF share at close unknown — majority-vacant IRR premium (+${Math.round(f.majorityVacantIrrPremium * 10_000)} bps above ${pct(f.majorityVacantSfShare, 0)} vacant) not applied; if it would decide the floor, the floor is indeterminate`]);
  }
  if (majorityVacant) basis += ` + majority-vacant +${Math.round(f.majorityVacantIrrPremium * 10_000)} bps`;
  const required = atFloorPrecision(base + (majorityVacant ? f.majorityVacantIrrPremium : 0));
  const requiredIfMajorityVacant = shareUnknown && f.majorityVacantIrrPremium > 0 ? atFloorPrecision(base + f.majorityVacantIrrPremium) : null;
  return { required, requiredIfMajorityVacant, basis: `10-yr unlevered; ${basis}`, flags };
}

/** True when an UNKNOWN portfolio status (isPortfolio === null) changes the size-price gate: the price is within the
 *  portfolio cap but above the single-asset cap, so "single asset" would KILL and "portfolio" would pass. Anywhere else
 *  null decides exactly like false (refute wf_6e927240-7cc). Shared by the gate and the inputs_version fold. */
export function portfolioStatusDecidesPriceGate(price: number | null, isPortfolio: boolean | null, ruleset: AcquisitionRuleset): boolean {
  const g = ruleset.gates.sizePrice;
  return isPortfolio === null && price !== null
    && price >= g.singleAssetPriceMin && price > g.singleAssetPriceMax && price <= g.portfolioPriceMax;
}

// ─── Deterministic inputs_version (Q5: pins rulesetVersion; rctVersion folds in once the RCT config lands) ──
/** Canonicalize ddKnown's .partial() shape to the four booleans the engine actually reads (absent ≡ false). */
function canonicalDd(dd: AcquisitionInput['ddKnown']): Record<string, boolean> {
  return {
    flood: dd.flood === true,
    zoning: dd.zoning === true,
    roof: dd.roof === true,
    'deferred-maintenance-capex': dd['deferred-maintenance-capex'] === true,
  };
}
export function computeInputsVersion(
  rawInput: AcquisitionInput,
  ruleset: AcquisitionRuleset,
  rctVersion: string = RCT_VERSION,
  governorFingerprint?: string | null,
): string {
  if (governorFingerprint === '') {
    // An empty string would silently fall into the legacy keyspace via the truthiness fold below —
    // a keyspace collision, not a degradation. Pass null for the legacy hash, or a real fingerprint.
    throw new Error('computeInputsVersion: empty governor fingerprint — pass null or a real fingerprint (refusing silent keyspace collision)');
  }
  const input = AcquisitionInput.parse(rawInput); // apply defaults → canonical form
  // ddKnown is .partial(): an ABSENT key and an explicit false are decision-identical (engine reads `!== true`),
  // so canonicalize to the four booleans — otherwise logically-identical deals hash differently. (Refute fix.)
  // Same idea for the other-use inputs (refute wf_5337efe6-574, determinism lens): childSafetyReviewed is read only when
  // childRelated is true, and with a ground-lease term supplied groundLeased null and true decide identically (the term is
  // tested, nothing flagged). Fold both so a decision-identical save -> reload -> re-save keeps the same key.
  // groundLeased === false with a term stays distinct: it raises the contradiction flag.
  const canonicalUse = input.use === null ? null
    : { ...input.use, childSafetyReviewed: input.use.childRelated ? input.use.childSafetyReviewed : false };
  const canonicalGroundLeased = input.groundLeaseYearsRemaining !== null && input.groundLeased !== false ? null : input.groundLeased;
  // isPortfolio is tri-state since refute wf_6e927240-7cc (default null, was false). Wherever null decides exactly like
  // false (price unknown, within the single-asset cap, or KILLed by either answer) fold it to false, so every input
  // that hashed under the old default keeps its key; only a price between the two caps hashes unknown separately.
  const canonicalIsPortfolio = input.isPortfolio === null && !portfolioStatusDecidesPriceGate(input.price, null, ruleset)
    ? false : input.isPortfolio;
  // rctAdders (RCT v3.2): adderTotal dedups and treats null and [] alike, so order, duplicates and empty-vs-null are
  // decision-identical; fold them to one key (refute wf_3124f132-f17, determinism lens). null keeps every pre-v3.2 key.
  const canonicalAdders = input.rctAdders === null || input.rctAdders.length === 0 ? null : [...new Set(input.rctAdders)].sort();
  const canonicalInput = {
    ...input, ddKnown: canonicalDd(input.ddKnown), use: canonicalUse, groundLeased: canonicalGroundLeased, isPortfolio: canonicalIsPortfolio,
    rctAdders: canonicalAdders,
  };
  const canonical = stableStringify({
    input: canonicalInput,
    rulesetVersion: ruleset.rulesetVersion,
    ratification: ruleset.ratification,
    rctVersion,
    // Persistence-layer callers fold the governor regime into the dedup key so a DSCR/LTV change
    // re-derives persisted verdicts (I1). Folded ONLY when provided: pure/edge callers with no DB
    // pass nothing and keep their legacy hashes — absent and null are hash-identical by design.
    ...(governorFingerprint ? { governors: governorFingerprint } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ─── helpers ───────────────────────────────────────────────────────────────────────────────────
const CONF_RANK: Record<Confidence, number> = { confirmed: 3, derived: 2, estimated: 1 };
function weakest(cs: Confidence[]): Confidence {
  let out: Confidence = 'confirmed';
  for (const c of cs) if (CONF_RANK[c] < CONF_RANK[out]) out = c;
  return out;
}

function tierBase(r: AcquisitionRuleset, tier: ClusterTier): number {
  const t = r.scoring.cat4.tierPoints;
  switch (tier) {
    case 'owned-submarket': return t.ownedSubmarket;
    case 'established': return t.established;
    case 'entry': return t.entry;
    case 'satellite': return t.satellite;
    default: return 0; // 'none' (gate would already KILL)
  }
}
function constructionPts(r: AcquisitionRuleset, ct: ConstructionType): number | null {
  const c = r.scoring.cat3.constructionPoints;
  switch (ct) {
    // Doctrine (Cat 3): block / tilt-up / brick full credit. The 2026-11-12 split keeps every masonry/concrete type on
    // the full-credit key; hybrid (block wainscot + metal panel on PEMB) takes the mixed points.
    case 'tilt-precast': case 'cmu': case 'brick': return c.blockTiltBrick;
    case 'hybrid': case 'mixed': return c.mixed;
    case 'pemb': return c.pemb;
    default: return null; // 'unknown'
  }
}

interface ScoreOpts { now?: string; rctVersion?: string; rct?: ReplacementCostTable; }

/** Score one acquisition. Pure: deterministic in (input, ruleset) except the injectable scoredAt. */
export function scoreAcquisition(
  rawInput: AcquisitionInput,
  ruleset: AcquisitionRuleset,
  opts: ScoreOpts = {},
): AcquisitionScore {
  const input = AcquisitionInput.parse(rawInput); // apply defaults (null/false) — never trust a partial caller
  const scoredAt = opts.now ?? new Date().toISOString();
  const dq: DataQualityFlag[] = [];
  const flag = (field: string, issue: string): void => {
    dq.push({ entity: input.dealId, field, issue, severity: 'warn' });
  };
  const vacant = input.isVacant;
  const capOf = new Map<ScorecardCategoryId, number>();
  for (const c of ruleset.scorecard) {
    capOf.set(c.id, vacant && c.vacantPoints !== null ? c.vacantPoints : c.points);
  }
  const cap = (id: ScorecardCategoryId): number => capOf.get(id) ?? 0;

  // Ground-level access, resolved ONCE. Door counts are authoritative when both provided (0 docks AND 0
  // drive-ins ⇒ no access); else fall back to the presence flags. Flag the contradiction when a count says
  // 0 but a presence flag says true. The gate + gateIndeterminate both consume this. (Refute fix.)
  const dc = input.dockCount;
  const dic = input.driveInCount;
  if ((dc === 0 && input.hasDock === true) || (dic === 0 && input.hasDriveIn === true) ||
      (dc !== null && dc > 0 && input.hasDock === false) || (dic !== null && dic > 0 && input.hasDriveIn === false)) {
    flag('doors', 'dock/drive-in counts contradict presence flags');
  }
  const accessConfirmedGood = (dc !== null && dic !== null) ? (dc > 0 || dic > 0) : (input.hasDock === true || input.hasDriveIn === true);
  const accessConfirmedKill = (dc !== null && dic !== null) ? (dc === 0 && dic === 0) : (input.hasDock === false && input.hasDriveIn === false);

  // ── STAGE 0 — GATES ──
  const gates: GateResult[] = [];
  const portfolioStatusUnknownMatters = portfolioStatusDecidesPriceGate(input.price, input.isPortfolio, ruleset);
  // product
  {
    const pt = input.productType;
    const killOnlyUse = pt === 'office-only' || pt === 'retail-only';
    const passed = !killOnlyUse;
    if (pt === null) flag('productType', 'unknown product type — gate not confirmable');
    gates.push({ id: 'product', passed, detail: pt === null ? 'product type unknown' : killOnlyUse ? `${pt} — killed` : `${pt} OK` });
  }
  // size-price
  {
    const g = ruleset.gates.sizePrice;
    // isPortfolio is tri-state (refute wf_6e927240-7cc). Unknown (null) never KILLs on the single-asset cap: a price
    // between the two caps passes unconfirmed and caps at T2 (portfolioStatusUnknownMatters, in gateIndeterminate).
    // Outside the portfolio cap / below the minimum, both answers KILL, so unknown KILLs too.
    const priceMax = input.isPortfolio === false ? g.singleAssetPriceMax : g.portfolioPriceMax;
    let passed = true;
    const bits: string[] = [];
    if (input.price !== null) {
      if (input.price < g.singleAssetPriceMin || input.price > priceMax) { passed = false; bits.push(`price ${input.price} outside [${g.singleAssetPriceMin}, ${priceMax}]`); }
      else if (portfolioStatusUnknownMatters) {
        flag('isPortfolio', 'portfolio status unknown — price cap not confirmable');
        bits.push(`portfolio status unknown — price ${input.price} is above the single-asset cap ${g.singleAssetPriceMax}`);
      }
    } else { flag('price', 'price unknown — size/price gate not confirmable'); bits.push('price unknown'); }
    if (input.maxBuildingSf !== null) {
      if (input.maxBuildingSf >= g.maxSfPerBuilding) { passed = false; bits.push(`maxBuildingSf ${input.maxBuildingSf} ≥ ${g.maxSfPerBuilding}`); }
    } else { flag('maxBuildingSf', 'building SF unknown — size gate not confirmable'); bits.push('SF unknown'); }
    gates.push({ id: 'size-price', passed, detail: bits.length ? bits.join('; ') : 'within size/price box' });
  }
  // market
  {
    const tier = input.clusterTier;
    let passed = true;
    let detail = '';
    if (tier === null) { passed = true; flag('clusterTier', 'cluster tier unknown — market gate not confirmable'); detail = 'cluster tier unknown'; }
    else if (tier === 'none') { passed = false; detail = 'outside target clusters'; }
    else if (tier === 'satellite') {
      // An UNKNOWN drive time is not a KILL (audit 2026-11-08, satellite-null-drive-kills): it used to fail the gate as if
      // it were over the max. Unknown never KILLs; it caps at T2 via gateIndeterminate below. The ratified max is unchanged.
      const dm = input.driveMinutesToCluster;
      if (dm === null) { flag('driveMinutesToCluster', 'satellite drive time to cluster unknown — market gate not confirmable'); detail = 'satellite drive unknown'; }
      else if (dm > ruleset.gates.satelliteMaxDriveMinutes) { passed = false; detail = `satellite drive ${dm} min > ${ruleset.gates.satelliteMaxDriveMinutes}`; }
      else detail = `satellite within ${ruleset.gates.satelliteMaxDriveMinutes} min`;
    } else detail = `${tier} cluster`;
    gates.push({ id: 'market', passed, detail });
  }
  // physical
  {
    let passed = true;
    const bits: string[] = [];
    if (input.clearHeightFt !== null) {
      if (input.clearHeightFt < ruleset.gates.physical.minClearHeightFt) { passed = false; bits.push(`clear ${input.clearHeightFt}' < ${ruleset.gates.physical.minClearHeightFt}'`); }
    } else { flag('clearHeightFt', 'clear height unknown — physical gate not confirmable'); }
    if (input.multiStory === true) { passed = false; bits.push('multi-story warehouse'); }
    if (accessConfirmedKill) { passed = false; bits.push('no ground-level access (0 docks AND 0 drive-ins)'); }
    gates.push({ id: 'physical', passed, detail: bits.length ? bits.join('; ') : 'physical OK' });
  }
  // flood
  {
    let passed = true;
    let detail = 'no SFHA on pad';
    if (input.sfhaOnPad === true && ruleset.gates.flood.sfhaOnPadKills) { passed = false; detail = 'SFHA on building pad'; }
    else if (input.sfhaOnPad === null) { flag('sfhaOnPad', 'flood (SFHA) status unknown'); detail = 'flood status unknown'; }
    else if (input.sfhaOnExcessLandOnly === true) detail = 'SFHA on excess land only — value land at $0, proceed';
    gates.push({ id: 'flood', passed, detail });
  }
  // other-use
  // An UNKNOWN other-use input is not a confirmed pass (audit 2026-11-08, other-use-gate-unfed-fail-open): it used to
  // pass silently and never reached gateIndeterminate, so a deal nobody had screened for a ground lease, environmental
  // remediation or an automotive/child-related use could reach PURSUE. Same rule as every other gate: unknown never
  // KILLs, it caps at T2 via gateIndeterminate below. Mechanism only — the ratified thresholds are unchanged.
  // Tenure is tri-state: a supplied term is always tested; with no term, only a CONFIRMED fee simple
  // (groundLeased === false) is determinate.
  const groundLeaseTerm = input.groundLeaseYearsRemaining;
  const otherUseUnknown: string[] = [];
  {
    let passed = true;
    const bits: string[] = [];
    if (groundLeaseTerm !== null && groundLeaseTerm < ruleset.gates.other.minGroundLeaseYearsRemaining) {
      passed = false; bits.push(`ground lease ${groundLeaseTerm}yr < ${ruleset.gates.other.minGroundLeaseYearsRemaining}yr`);
    }
    if (groundLeaseTerm !== null && input.groundLeased === false) {
      flag('groundLeased', `groundLeased=false (fee simple) contradicts the supplied ground-lease term of ${groundLeaseTerm}yr — the term was tested; correct the tenure`);
    } else if (groundLeaseTerm === null && input.groundLeased === true) {
      otherUseUnknown.push('ground-lease term');
      flag('groundLeaseYearsRemaining', 'ground-leased but the remaining term is unknown — other-use gate not confirmable');
    } else if (groundLeaseTerm === null && input.groundLeased === null) {
      otherUseUnknown.push('tenure');
      flag('groundLeased', 'tenure unknown (fee simple vs ground lease) — other-use gate not confirmable');
    }
    if (input.envRemediationPctOfPrice !== null && input.envRemediationPctOfPrice > ruleset.gates.other.maxEnvRemediationPctOfPrice) {
      passed = false; bits.push(`env remediation ${(input.envRemediationPctOfPrice * 100).toFixed(0)}% > ${(ruleset.gates.other.maxEnvRemediationPctOfPrice * 100).toFixed(0)}%`);
    } else if (input.envRemediationPctOfPrice === null) {
      otherUseUnknown.push('environmental remediation');
      flag('envRemediationPctOfPrice', 'environmental remediation estimate unknown (0 = Phase I clean) — other-use gate not confirmable');
    }
    if (input.use) {
      if (input.use.automotive) { passed = false; bits.push('automotive use'); }
      if (input.use.childRelated && !input.use.childSafetyReviewed) { passed = false; bits.push('child-related use without safety review'); }
    } else {
      otherUseUnknown.push('automotive / child-related use');
      flag('use', 'automotive / child-related use not screened — other-use gate not confirmable');
    }
    const detail = bits.length ? bits.join('; ')
      : otherUseUnknown.length ? `not confirmable: ${otherUseUnknown.join(', ')} unknown`
        : 'no disqualifying use';
    gates.push({ id: 'other-use', passed, detail });
  }
  const gatesPassed = gates.every((g) => g.passed);
  // A gate that "passed" only because a KILL-determining input was UNKNOWN is NOT a confirmed pass.
  // Symmetric to floorIndeterminate (STAGE 1): missing hard-KILL knowledge must cap the verdict at T2 —
  // an unverified multi-story / no-access / sub-12' / oversized deal must never reach PURSUE just because
  // the disqualifying fact is unknown at screen time. (Adversarial refute finding, 2026-06-13.)
  const gateIndeterminate =
    input.productType === null ||
    input.price === null || input.maxBuildingSf === null || portfolioStatusUnknownMatters ||
    input.clusterTier === null ||
    (input.clusterTier === 'satellite' && input.driveMinutesToCluster === null) ||
    input.clearHeightFt === null || input.multiStory === null ||
    (!accessConfirmedGood && !accessConfirmedKill) ||
    input.sfhaOnPad === null ||
    otherUseUnknown.length > 0;

  // ── STAGE 1 — FLOORS ──
  const floors: FloorResult[] = [];
  let floorIndeterminate = false;
  // basis floor — discount to replacement, vintage-adjusted via the LINEAR RAMP (RCT v03).
  // Slides from the (stricter) pre floor at/below rampStart to the (looser) post floor at/above
  // cutoff. Unknown vintage ⇒ the STRICTEST floor: never credit a building with a looser floor
  // because we failed to look up its year.
  const vintageFloor = basisVintageFloor(input.yearBuilt, ruleset);
  // Replacement cost (the Basis divisor, Q5) is derived ONLY from a RATIFIED + SIGNED RCT × gross SF. A
  // caller replacementCostTotal is an appraisal override used solely for reconciliation (>10% divergence is
  // flagged) — it can NEVER be a standalone divisor. With no usable ratified RCT the Basis is indeterminate
  // (floorIndeterminate ⇒ caps at T2): a live PURSUE can never rest on an unbacked or unratified replacement
  // cost. (Confirmatory refute fix: close the no-RCT and unratified-RCT branches.)
  const suppliedRct = opts.rct ?? null;
  const rctUsable = suppliedRct !== null
    && suppliedRct.ratification === 'ratified'
    && suppliedRct.ratifiedBy !== null
    && suppliedRct.ratifiedDate !== null;
  const validRct = rctUsable ? suppliedRct : null;
  const grossSf = input.totalSf ?? input.maxBuildingSf;
  // Refute-fix (2026-07-14, RCT v03 refute pass): the Basis floor AND Basis score ALWAYS divide by
  // RCT LOW — this is stated as settled doctrine everywhere (acquisition-underwriting skill,
  // target-markets.json, src/brain/replacement-cost.ts's own doc comment), but this line was
  // resolving `input.replacementCostBand ?? 'mid'` — i.e. defaulting to POINT, not LOW — so the
  // engine's actual PURSUE/WATCH/KILLED verdict silently used a different (looser) divisor than
  // every doc comment claimed and than the new client-side DealDrawer badge computed, producing
  // contradictory pass/fail readings for the same deal. `replacementCostBand` turns out to encode a
  // DIFFERENT, pre-existing concept (subject building-class selection) that nothing in this codebase
  // actually sets — reusing it for RCT-confidence-band selection was the conflation. Hardcoded to
  // 'low' here rather than reusing that dormant field; if building-class-adjusted replacement cost is
  // wanted as a distinct feature later, it needs its own design, not silent reuse of this enum.
  const rcBand = 'low' as const;
  // Per-market divisor (RCT v03). Unknown/uncovered market ⇒ conservative firm-wide fallback (the
  // cheapest market to build in ⇒ the strictest floor), and we SAY SO rather than pass it silently.
  // Construction-type multiplier then adders (SKILL.md v4.37): POINT × multiplier + adders, LOW at −10%. The PEMB size
  // tilt is read ONLY at maxBuildingSf, a real building's SF (the scoring form fills it from the total for a known
  // one-building deal). With it unknown the tilt reads at null, the strictest band: missing data never buys a looser
  // floor. Never at totalSf, and never keyed on isPortfolio: 'not a portfolio' does not mean one building (a 6+ building
  // deal is 'no'), and inputs_version folds isPortfolio null into false, so a tilt that read isPortfolio would let one
  // cache key carry two verdicts (refute wf_3124f132-f17 and wf_9e4b0fd3-241). Unknown type => the strictest applicable
  // multiplier (PEMB for the SF, capped at the table's unknownCap), so skipping the type check never loosens the floor either.
  const ctMult = validRct !== null ? constructionMultiplier(input.constructionType, tiltSfFor(input.maxBuildingSf, input.totalSf), validRct.constructionMultipliers) : null;
  if (input.maxBuildingSf !== null && input.totalSf !== null && input.totalSf > 0 && input.maxBuildingSf > input.totalSf) {
    flag('maxBuildingSf', `largest building SF (${input.maxBuildingSf.toLocaleString('en-US')}) exceeds total SF (${input.totalSf.toLocaleString('en-US')}) — the size tilt is read at the total; check the inputs`);
  }
  const adders = validRct !== null ? adderTotal(input.rctAdders, validRct.adders) : null;
  const rcResolved = validRct !== null && ctMult !== null && adders !== null
    ? replacementCostPsf(validRct, rcBand, input.market, { multiplier: ctMult.multiplier, adderPsf: adders.psf })
    : null;
  const replacementCost = rcResolved !== null && grossSf !== null && grossSf > 0 ? grossSf * rcResolved.psf : null;
  if (ctMult !== null && ctMult.assumed) {
    flag('replacementCost', `construction type ${input.constructionType === 'mixed' ? 'is a mixed façade (no façade weighting in the engine)' : 'unknown'} — RCT ${ctMult.label}, the strictest applicable multiplier. Confirm the type from the OM, CAMA or photos.`);
  } else if (ctMult !== null && ctMult.outsideBand) {
    flag('replacementCost', `PEMB above 50,000 SF is outside the size-tilt band — RCT ${ctMult.label}.`);
  }
  if (ctMult !== null && input.maxBuildingSf === null && (input.constructionType === 'pemb' || ctMult.assumed)) {
    flag('replacementCost', 'largest building SF unknown — the PEMB size tilt is read at the strictest band (under 20,000 SF). Enter the largest building SF.');
  } else if (ctMult !== null && input.maxBuildingSf !== null && input.totalSf !== null && input.totalSf > input.maxBuildingSf
    && (input.constructionType === 'pemb' || ctMult.assumed)) {
    // Multi-building: every building is priced at the LARGEST building's tilt, the loosest PEMB band in the deal, until
    // per-building allocation (Amendment H) exists. Disclosed, not hidden.
    flag('replacementCost', `total SF exceeds the largest building SF (a multi-building deal, or OM vs county SF that disagree) — the PEMB size tilt is read at the largest building (${input.maxBuildingSf.toLocaleString('en-US')} SF), an upper bound for a multi-building deal until per-building allocation (Amendment H).`);
  }
  if (adders !== null && adders.siteWorkStacked) {
    flag('rctAdders', 'both site-work adders applied (excess site work + paving/lighting) — doctrine forbids stacking them for the same paving scope; confirm they are separate scopes.');
  }
  if (rcResolved !== null && !rcResolved.marketCovered) {
    flag('replacementCost', `market ${input.market === null ? 'not supplied' : `'${input.market}' not in ${validRct!.rctVersion}`} — using the conservative firm-wide fallback ($${validRct!.psf[rcBand]}/SF baseline LOW, the strictest floor). Supply a covered market for a per-market basis.`);
  } else if (rcResolved !== null && rcResolved.proxy) {
    flag('replacementCost', `RCT row for '${input.market}' is a [PROXY] from a neighbouring metro — DENOMINATOR-SENSITIVE: a local insurance comp or GC quote is required pre-LOI.`);
  }
  if (suppliedRct === null) {
    flag('replacementCost', 'no ratified RCT supplied to the engine — Basis floor/score indeterminate');
  } else if (!rctUsable) {
    flag('replacementCost', `supplied RCT ${suppliedRct.rctVersion} is not ratified/signed — not used; Basis indeterminate`);
  } else if (replacementCost === null) {
    flag('replacementCost', 'gross SF unknown — cannot derive replacement cost from the ratified RCT');
  } else if (input.replacementCostTotal !== null && input.replacementCostTotal > 0) {
    const div = Math.abs(input.replacementCostTotal - replacementCost) / replacementCost;
    if (div > 0.10) flag('replacementCostTotal', `caller replacement cost ${Math.round(input.replacementCostTotal)} diverges ${(div * 100).toFixed(0)}% from ratified RCT ${Math.round(replacementCost)} — using the ratified RCT`);
  }
  const discount = input.allInBasis !== null && input.allInBasis > 0 && replacementCost !== null && replacementCost > 0
    ? basisDiscount(input.allInBasis, grossSf!, rcResolved!.psf)
    : null;
  if (discount === null) { floorIndeterminate = true; flag('basis', 'basis indeterminate (all-in basis ≤ 0 / missing, or replacement cost not RCT-derivable)'); }
  const rctCite = ctMult !== null && adders !== null && rcResolved !== null
    ? ` (RCT ${ctMult.label}${adders.psf > 0 ? ` + $${adders.psf}/SF adders` : ''}, LOW $${rcResolved.psf.toFixed(2)}/SF)`
    : '';
  // basisClearsFloor: the one predicate the deal drawer uses too (src/lib/rct-adjust.ts), at 1e-8 floor precision.
  floors.push({ id: 'basis', passed: discount !== null && basisClearsFloor(discount, vintageFloor), actual: discount, required: vintageFloor, detail: discount === null ? 'inputs missing' : `${(discount * 100).toFixed(1)}% vs ${(vintageFloor * 100).toFixed(0)}% required${rctCite}` });
  // yield floor — stabilized YoC
  if (input.stabilizedYoc === null) { floorIndeterminate = true; flag('stabilizedYoc', 'stabilized YoC missing — yield floor indeterminate'); }
  // Strictly ABOVE the floor (SKILL.md v4.45 STAGE 1: "stabilized YoC >8%"); exactly 8.0% does not clear.
  floors.push({ id: 'yield', passed: input.stabilizedYoc !== null && atFloorPrecision(input.stabilizedYoc) > atFloorPrecision(ruleset.floors.stabilizedYocFloorPct), actual: input.stabilizedYoc, required: ruleset.floors.stabilizedYocFloorPct, detail: input.stabilizedYoc === null ? 'YoC missing' : `${(input.stabilizedYoc * 100).toFixed(1)}% vs >${(ruleset.floors.stabilizedYocFloorPct * 100).toFixed(0)}% floor` });
  // irr floor — 10-yr UNLEVERED (ruleset 2.0.0; SKILL.md v4.45 STAGE 1, v4.33 + v4.40). Levered IRR is reported only
  // and never read here: a strong levered IRR cannot stand in for a missing unlevered one.
  const irr = unleveredIrrFloor(input, ruleset, input.asAtUtc ?? scoredAt);
  // Two vacancy inputs exist: isVacant (100% vacant; drives the Tenancy/Value-Add scorecard) and vacantSfShareAtClose
  // (drives the IRR premium). Disclose a contradiction rather than silently scoring the two halves on different facts.
  if (input.vacantSfShareAtClose !== null) {
    if (!input.isVacant && atFloorPrecision(input.vacantSfShareAtClose) >= 1) {
      flag('vacantSfShareAtClose', 'vacant SF share at close is 100% but the deal is not marked 100% vacant — the scorecard scores it as leased; check the inputs');
    } else if (input.isVacant && atFloorPrecision(input.vacantSfShareAtClose) < 1) {
      flag('vacantSfShareAtClose', `deal is marked 100% vacant but vacant SF share at close is ${(input.vacantSfShareAtClose * 100).toFixed(0)}% — the IRR floor takes the majority-vacant premium; check the inputs`);
    }
  }
  for (const [field, issue] of irr.flags) flag(field, issue);
  if (input.unleveredIrr10yr === null) { floorIndeterminate = true; flag('unleveredIrr10yr', '10-yr unlevered IRR missing — IRR floor indeterminate (levered IRR is reported only, never the floor)'); }
  const irrCmp = input.unleveredIrr10yr === null ? null : atFloorPrecision(input.unleveredIrr10yr);
  // Unknown vacant share decides the floor: the IRR clears without the majority-vacant premium but not with it. The
  // floor is then INDETERMINATE (null actual: caps at T2, not BUY-eligible, never KILLED) until the share is supplied
  // (Gabriel in-turn 2026-11-12). The IRR itself stays visible in the detail line.
  const irrUndecided = irrCmp !== null && irrCmp >= irr.required
    && irr.requiredIfMajorityVacant !== null && irrCmp < irr.requiredIfMajorityVacant;
  const irrDetailValue = input.unleveredIrr10yr === null ? '10-yr unlevered IRR missing' : `${(input.unleveredIrr10yr * 100).toFixed(2)}%`;
  // The vacantSfShareAtClose flag was already raised by unleveredIrrFloor(); the floor's detail line carries the specifics.
  if (irrUndecided) floorIndeterminate = true;
  floors.push({
    id: 'irr',
    passed: irrCmp !== null && !irrUndecided && irrCmp >= irr.required,
    actual: irrUndecided ? null : input.unleveredIrr10yr,
    required: irr.required,
    detail: irrUndecided
      ? `${irrDetailValue} vs ${(irr.required * 100).toFixed(2)}% required, ${(irr.requiredIfMajorityVacant! * 100).toFixed(2)}% if majority-vacant — vacant share at close unknown, indeterminate (${irr.basis})`
      : `${irrDetailValue} vs ${(irr.required * 100).toFixed(2)}% required (${irr.basis})`,
  });
  // A floor with a COMPUTABLE actual that fails ⇒ KILLED. A null-actual floor ⇒ indeterminate (caps at T2, never KILL).
  const floorsHardFail = floors.some((f) => f.actual !== null && !f.passed);
  const floorsPassed = floors.every((f) => f.passed);

  // ── STAGE 2 — SCORECARD ──
  let incompleteRuleset = false;
  // Cat 1 Basis (linear from vintage floor → basisFullCreditDiscount)
  const basisFull = ruleset.scoring.basisFullCreditDiscount;
  const cat1 = discount === null ? 0 : clamp((discount - vintageFloor) / Math.max(1e-9, basisFull - vintageFloor) * cap('basis'), 0, cap('basis'));
  // Cat 2 Yield (linear yocZero → yocFull)
  const yoc = input.stabilizedYoc;
  const cat2 = yoc === null ? 0 : clamp((yoc - ruleset.scoring.yocZeroPct) / Math.max(1e-9, ruleset.scoring.yocFullPct - ruleset.scoring.yocZeroPct) * cap('yield'), 0, cap('yield'));
  // Cat 3 Product & Physical (clear + loading + product-fit + construction + site)
  const s3 = ruleset.scoring.cat3;
  // clear height: needs the size-banded cutoffs. null bands ⇒ incomplete ruleset (cannot compute).
  let clearPts = 0;
  if (s3.clearHeightBands === null) { incompleteRuleset = true; flag('clearHeightBands', 'SKILL.md:52-57 clear-height cutoffs pending — clear-height sub-score indeterminate'); }
  else if (input.clearHeightFt === null) { flag('clearHeightFt', 'clear height unknown'); }
  else {
    const bands = [...s3.clearHeightBands].sort((a, b) => a.maxSf - b.maxSf || a.idealClearFt - b.idealClearFt);
    const sf = input.maxBuildingSf ?? 0;
    const band = bands.find((b) => sf <= b.maxSf) ?? bands[bands.length - 1];
    const ideal = band ? band.idealClearFt : ruleset.gates.physical.minClearHeightFt;
    const floorFt = ruleset.gates.physical.minClearHeightFt;
    clearPts = clamp((input.clearHeightFt - floorFt) / Math.max(1e-9, ideal - floorFt), 0, 1) * s3.clearHeightPoints;
  }
  // loading + site share a truck-court adequacy + door adequacy basis.
  const tcRaw = input.truckCourtFt;
  const tcScore = tcRaw === null ? 0.5 : clamp((tcRaw - s3.truckCourtZeroFt) / Math.max(1e-9, s3.truckCourtIdealFt - s3.truckCourtZeroFt), 0, 1);
  // Door adequacy (ratified Q1: ideally 1 dock + 1 drive-in per 10k SF). Uses counts when known; falls back
  // to the binary presence (hasDock/hasDriveIn) so partial inputs still score. (Gabriel, 2026-06-14.)
  const loadSf = input.totalSf ?? input.maxBuildingSf;
  let doorAdequacy: number;
  if (input.dockCount !== null && input.driveInCount !== null && loadSf !== null && loadSf > 0) {
    const per10k = loadSf / 10000;
    const dockAdeq = clamp(input.dockCount / Math.max(s3.loadingDoorsPer10kSf.docks * per10k, 1e-9), 0, 1);
    const driveAdeq = clamp(input.driveInCount / Math.max(s3.loadingDoorsPer10kSf.driveIns * per10k, 1e-9), 0, 1);
    // CONJUNCTIVE ("1 dock AND 1 drive-in per 10k SF"): the weaker door type limits — a glut of one cannot
    // buy back the absence of the other. min, not average. (Refute fix.)
    doorAdequacy = Math.min(dockAdeq, driveAdeq);
  } else {
    // Counts unknown ⇒ NEUTRAL (mirrors the truck-court-null 0.5) — never full credit for mere presence,
    // else withholding door data would outscore reporting sparse doors. (Refute fix.)
    doorAdequacy = 0.5;
  }
  const loadingPts = s3.loadingPoints * clamp(0.5 * tcScore + 0.5 * doorAdequacy, 0, 1);
  const sitePts = s3.siteFunctionPoints * clamp(0.5 * tcScore + 0.5 * doorAdequacy, 0, 1);
  // product fit: full unless office-heavy; null product ⇒ 0
  let productFitPts = 0;
  if (input.productType === null) flag('productType', 'product type unknown — product-fit sub-score 0');
  else if (input.officePct === null) {
    // Unknown office share ⇒ NEUTRAL half credit, flagged — the same rule as truck court and door counts
    // above. It used to default to 0% office and earn FULL credit, so an unfilled field outscored a
    // reported one (2026-09-30 audit). Mechanism fix only: no ratified weight or threshold changes.
    productFitPts = s3.productFitPoints * 0.5;
    flag('officePct', 'office percentage unknown — product-fit scored neutral (half credit)');
  } else {
    const office = input.officePct;
    productFitPts = s3.productFitPoints * (office > 0.30 ? clamp(1 - (office - 0.30) / 0.70, 0, 1) : 1);
  }
  // construction
  let constrPts = 0;
  if (input.constructionType === null || input.constructionType === 'unknown') flag('constructionType', 'construction type unknown — construction sub-score 0');
  else { const cp = constructionPts(ruleset, input.constructionType); constrPts = cp ?? 0; }
  const cat3 = clamp(clearPts + loadingPts + productFitPts + constrPts + sitePts, 0, cap('product-physical'));
  // Cat 4 Market & Location: tier base + bounded fundamentals ±, ± zeroed when stale (Q6) or absent
  const tier = input.clusterTier;
  const tierPts = tier === null ? 0 : tierBase(ruleset, tier);
  if (tier === null) flag('clusterTier', 'cluster tier unknown — market base 0');
  const fresh = isFresh(input.compSourcedAt, input.asAtUtc, ruleset.freshness.marketFundamentalsWindowDays);
  let adjPts = 0;
  let estimatedAdjRaw = 0; // raw estimated ± before Cat4 clamping
  if (input.marketFundamentalsAdj !== null && input.marketFundamentalsConfidence !== null) {
    if (!fresh) flag('marketFundamentalsAdj', `market fundamentals stale or freshness unverifiable (no asAtUtc / > ${ruleset.freshness.marketFundamentalsWindowDays}d) — ± defaulted to 0`);
    else {
      adjPts = input.marketFundamentalsAdj * ruleset.scoring.cat4.fundamentalsAdjustMax;
      if (input.marketFundamentalsConfidence !== 'confirmed') estimatedAdjRaw = adjPts;
    }
  }
  const cat4 = clamp(tierPts + adjPts, 0, cap('market-location'));
  // Q3 must subtract only the REALIZED estimated contribution. When the tier is already at the Cat4 cap the
  // estimated ± is clamped out and contributes 0 — subtracting its raw value would wrongly demote a deal
  // carried entirely by confirmed adjacency. (Refute fix.)
  const cat4NoEstimated = clamp(tierPts + (adjPts - estimatedAdjRaw), 0, cap('market-location'));
  const estimatedAdjPts = round1(cat4 - cat4NoEstimated);
  // Cat 5 Seller / Motivation
  const cat5 = input.sellerMotivationScore === null ? 0 : clamp(input.sellerMotivationScore * cap('seller-motivation'), 0, cap('seller-motivation'));
  if (input.sellerMotivationScore === null) flag('sellerMotivationScore', 'seller motivation not scored — 0');
  // Cat 6 Tenancy & Lease (inverse upside). Vacant ⇒ 0 (reallocated to Cat 7 via vacant cap).
  let cat6 = 0;
  if (!vacant) {
    if (input.inPlaceRentPsf === null || input.marketRentPsf === null || input.marketRentPsf <= 0) {
      flag('mtm', 'in-place/market rent missing — tenancy upside 0');
    } else {
      const mtmGap = (input.marketRentPsf - input.inPlaceRentPsf) / input.marketRentPsf; // >0 = below market
      const c6 = ruleset.scoring.cat6;
      const mtmPts = clamp(mtmGap / Math.max(1e-9, c6.mtmFullDiscountPct), 0, 1) * c6.mtmMaxPoints;
      const walt = input.waltYears;
      const waltFactor = walt === null ? 0 : walt <= c6.waltSweetSpotYr ? 1 : walt <= c6.waltDecayYr ? 0.5 : 0;
      cat6 = mtmGap > 0 ? clamp(mtmPts + waltFactor * c6.waltMaxPoints, 0, cap('tenancy-lease')) : 0;
    }
  }
  // Cat 7 Value-Add (cap 6, or 13 vacant)
  const cat7 = input.valueAddScore === null ? 0 : clamp(input.valueAddScore * cap('value-add'), 0, cap('value-add'));
  if (input.valueAddScore === null) flag('valueAddScore', 'value-add optionality not scored — 0');

  // ── Sub-scores (§2 lossless re-grouping) ──
  const basisInputsKnown = discount !== null && yoc !== null;
  const assetInputsKnown = input.productType !== null && input.constructionType !== null && input.officePct !== null && !incompleteRuleset;
  const riskInputsKnown = input.sellerMotivationScore !== null && (vacant || (input.inPlaceRentPsf !== null && input.marketRentPsf !== null));
  const marketConfidence: Confidence = estimatedAdjPts !== 0 ? 'estimated' : 'confirmed'; // adjacency is confirmed
  const subScores: SubScoreResult[] = [
    mkSub('basis', cat1 + cat2, cap('basis') + cap('yield'), basisInputsKnown ? 'confirmed' : 'estimated'),
    mkSub('asset', cat3 + cat7, cap('product-physical') + cap('value-add'), assetInputsKnown ? 'confirmed' : 'estimated'),
    mkSub('market', cat4, cap('market-location'), marketConfidence),
    mkSub('risk', cat5 + cat6, cap('seller-motivation') + cap('tenancy-lease'), riskInputsKnown ? 'confirmed' : 'estimated'),
  ];
  // §2 identity: the composite IS the sum of the (rounded) sub-scores the UI displays — not a separately
  // rounded sum of raw categories (which can differ by 0.1 and break reconciliation). (Refute fix.)
  const composite = clamp(round1(subScores.reduce((s, x) => s + x.points, 0)), 0, 100);
  const confirmedComposite = composite - estimatedAdjPts; // Q3: composite minus the REALIZED estimated market ±

  // ── STAGE 2.5 — DD-critical ──
  const known = input.ddKnown;
  const ddCriticalUnresolved = ruleset.ddCritical.filter((id) => known[id] !== true).map(String);

  // ── VERDICT (precedence) ──
  const reasons: string[] = [];
  let tier_: Tier;
  let verdict: Verdict;
  let cappedAtT2 = false;

  if (!gatesPassed) {
    tier_ = 'KILLED'; verdict = 'KILLED';
    reasons.push(`KILLED at gate: ${gates.filter((g) => !g.passed).map((g) => `${g.id} (${g.detail})`).join('; ')}.`);
  } else if (floorsHardFail) {
    tier_ = 'KILLED'; verdict = 'KILLED';
    reasons.push(`KILLED at floor: ${floors.filter((f) => f.actual !== null && !f.passed).map((f) => `${f.id} ${f.detail}`).join('; ')}.`);
  } else {
    // composite band first
    if (composite >= ruleset.bands.t1PursueMin) { tier_ = 'T1'; verdict = 'PURSUE'; }
    else if (composite >= ruleset.bands.t2WatchMin) { tier_ = 'T2'; verdict = 'WATCH'; }
    else { tier_ = 'PASS'; verdict = 'PASS'; }
    reasons.push(`Composite ${composite}/100 → ${tier_}.`);

    // downgrade-only caps (never upgrade)
    const capReasons: string[] = [];
    if (ddCriticalUnresolved.length > 0) capReasons.push(`DD-critical unresolved: ${ddCriticalUnresolved.join(', ')}`);
    if (floorIndeterminate) capReasons.push('a floor is indeterminate (missing inputs)');
    if (incompleteRuleset) capReasons.push('ruleset incomplete (clear-height bands pending SKILL.md)');
    if (gateIndeterminate) capReasons.push('a Stage-0 gate input is unconfirmed — cannot clear the kill screen');
    if (ruleset.guards.marketEstimatedCannotCarryT1 && composite >= ruleset.bands.t1PursueMin && confirmedComposite < ruleset.bands.t1PursueMin) {
      capReasons.push('PURSUE rests on estimated market upside — Basis/Asset do not carry it alone (Q3)');
    }
    if (tier_ === 'T1' && capReasons.length > 0) {
      tier_ = 'T2'; verdict = 'WATCH'; cappedAtT2 = true;
      reasons.push(`Capped T1 → T2: ${capReasons.join('; ')}.`);
    } else if (capReasons.length > 0) {
      reasons.push(`Notes: ${capReasons.join('; ')}.`);
    }
  }

  // An unconfirmed Stage-0 gate degrades confidence — the screen cannot be called 'confirmed' on unknown kills.
  const subConfs = subScores.map((s) => s.confidence);
  const confidence = gateIndeterminate ? weakest(subConfs.concat('estimated')) : weakest(subConfs);
  // Advisory when the ruleset isn't ratified OR a supplied RCT is not ratified/signed — a non-ratified RCT
  // must never drive a live capital-allocation verdict. (Confirmatory refute fix.)
  const advisoryOnly = ruleset.ratification !== 'ratified' || (suppliedRct !== null && !rctUsable);
  if (advisoryOnly) {
    const why = ruleset.ratification !== 'ratified' ? `ruleset '${ruleset.ratification}'` : 'RCT not ratified/signed';
    reasons.push(`ADVISORY ONLY — ${why}; not a capital-allocation verdict.`);
  }

  const result: AcquisitionScore = {
    schemaVersion: '1.0.0',
    inputsVersion: computeInputsVersion(input, ruleset, opts.rctVersion ?? opts.rct?.rctVersion ?? RCT_VERSION),
    rulesetVersion: ruleset.rulesetVersion,
    ratification: ruleset.ratification,
    scoredAt,
    dealId: input.dealId,
    isVacant: vacant,
    gates,
    gatesPassed,
    floors,
    floorsPassed,
    floorIndeterminate,
    ddCriticalUnresolved,
    subScores,
    composite,
    tier: tier_,
    verdict,
    cappedAtT2,
    incompleteRuleset,
    advisoryOnly,
    confidence,
    reasons,
    dataQuality: dq,
  };
  return AcquisitionScore.parse(result); // contract conformance is part of the function's guarantee
}

function mkSub(id: SubScore, points: number, maxPoints: number, confidence: Confidence): SubScoreResult {
  const p = round1(clamp(points, 0, maxPoints));
  return { id, points: p, maxPoints, normalized: maxPoints > 0 ? round1((p / maxPoints) * 100) : 0, confidence };
}

// Comp freshness vs the Q6 window. PURE: the "as-at" clock is an INPUT field (asAtUtc). When it is absent
// or unparseable, freshness cannot be established deterministically, so the comp is treated as STALE (± → 0)
// rather than reading the wall clock — Date.now() must NEVER feed the composite/verdict. (Refute fix.)
function isFresh(sourcedAt: string | null, asAt: string | null, windowDays: number): boolean {
  if (sourcedAt === null || asAt === null) return false;
  const src = Date.parse(sourcedAt);
  // A date-only as-at ('2026-06-13') parses to 00:00Z; compare it as END of that UTC day so a comp
  // time-stamped later the same day is not treated as future-dated (fail-closed applies to a later DAY).
  const now = /^\d{4}-\d{2}-\d{2}$/.test(asAt) ? Date.parse(asAt) + 24 * 60 * 60 * 1000 - 1 : Date.parse(asAt);
  if (Number.isNaN(src) || Number.isNaN(now)) return false;
  // A comp sourced AFTER the as-at date is unverifiable at that as-at (clock skew, a typo'd year, or a
  // forward-dated import) — the freshness window is one-sided, so it must fail closed like null/NaN
  // rather than pass because `now - src` is negative. (Audit 2026-09-25: fails-open finding.)
  if (src > now) return false;
  return (now - src) <= windowDays * 24 * 60 * 60 * 1000;
}
