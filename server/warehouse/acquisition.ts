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
import {
  AcquisitionInput,
  AcquisitionRuleset,
  AcquisitionScore,
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

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
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
}

// ─── Deterministic inputs_version (Q5: pins rulesetVersion; rctVersion folds in once the RCT config lands) ──
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
export function computeInputsVersion(input: AcquisitionInput, ruleset: AcquisitionRuleset, rctVersion = 'rct-v0'): string {
  const canonical = stableStringify({
    input,
    rulesetVersion: ruleset.rulesetVersion,
    ratification: ruleset.ratification,
    rctVersion,
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
    case 'block-tilt-brick': return c.blockTiltBrick;
    case 'mixed': return c.mixed;
    case 'pemb': return c.pemb;
    default: return null; // 'unknown'
  }
}

interface ScoreOpts { now?: string; rctVersion?: string; }

/** Score one acquisition. Pure: deterministic in (input, ruleset) except the injectable scoredAt. */
export function scoreAcquisition(
  rawInput: AcquisitionInput,
  ruleset: AcquisitionRuleset,
  opts: ScoreOpts = {},
): AcquisitionScore {
  const input = AcquisitionInput.parse(rawInput); // apply defaults (null/false) — never trust a partial caller
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

  // ── STAGE 0 — GATES ──
  const gates: GateResult[] = [];
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
    const priceMax = input.isPortfolio ? g.portfolioPriceMax : g.singleAssetPriceMax;
    let passed = true;
    const bits: string[] = [];
    if (input.price !== null) {
      if (input.price < g.singleAssetPriceMin || input.price > priceMax) { passed = false; bits.push(`price ${input.price} outside [${g.singleAssetPriceMin}, ${priceMax}]`); }
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
      const dm = input.driveMinutesToCluster;
      if (dm === null || dm > ruleset.gates.satelliteMaxDriveMinutes) { passed = false; detail = `satellite drive ${dm ?? '?'} min > ${ruleset.gates.satelliteMaxDriveMinutes}`; }
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
    if (input.hasDriveIn === false && input.hasDock === false) { passed = false; bits.push('no ground-level access (0 docks AND 0 drive-ins)'); }
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
  {
    let passed = true;
    const bits: string[] = [];
    if (input.groundLeaseYearsRemaining !== null && input.groundLeaseYearsRemaining < ruleset.gates.other.minGroundLeaseYearsRemaining) {
      passed = false; bits.push(`ground lease ${input.groundLeaseYearsRemaining}yr < ${ruleset.gates.other.minGroundLeaseYearsRemaining}yr`);
    }
    if (input.envRemediationPctOfPrice !== null && input.envRemediationPctOfPrice > ruleset.gates.other.maxEnvRemediationPctOfPrice) {
      passed = false; bits.push(`env remediation ${(input.envRemediationPctOfPrice * 100).toFixed(0)}% > ${(ruleset.gates.other.maxEnvRemediationPctOfPrice * 100).toFixed(0)}%`);
    }
    if (input.use) {
      if (input.use.automotive) { passed = false; bits.push('automotive use'); }
      if (input.use.childRelated && !input.use.childSafetyReviewed) { passed = false; bits.push('child-related use without safety review'); }
    }
    gates.push({ id: 'other-use', passed, detail: bits.length ? bits.join('; ') : 'no disqualifying use' });
  }
  const gatesPassed = gates.every((g) => g.passed);

  // ── STAGE 1 — FLOORS ──
  const floors: FloorResult[] = [];
  let floorIndeterminate = false;
  // basis floor — discount to replacement, vintage-adjusted
  const vintageFloor = input.yearBuilt === null
    ? ruleset.floors.basisDiscountMinPreMillennium // unknown vintage ⇒ stricter (conservative)
    : input.yearBuilt >= ruleset.floors.basisVintageCutoffYear
      ? ruleset.floors.basisDiscountMinPostMillennium
      : ruleset.floors.basisDiscountMinPreMillennium;
  const discount = input.allInBasis !== null && input.replacementCostTotal !== null && input.replacementCostTotal > 0
    ? 1 - input.allInBasis / input.replacementCostTotal
    : null;
  if (discount === null) { floorIndeterminate = true; flag('basis', 'all-in basis or replacement cost missing — basis floor indeterminate'); }
  floors.push({ id: 'basis', passed: discount !== null && discount >= vintageFloor, actual: discount, required: vintageFloor, detail: discount === null ? 'inputs missing' : `${(discount * 100).toFixed(1)}% vs ${(vintageFloor * 100).toFixed(0)}% required` });
  // yield floor — stabilized YoC
  if (input.stabilizedYoc === null) { floorIndeterminate = true; flag('stabilizedYoc', 'stabilized YoC missing — yield floor indeterminate'); }
  floors.push({ id: 'yield', passed: input.stabilizedYoc !== null && input.stabilizedYoc >= ruleset.floors.stabilizedYocFloorPct, actual: input.stabilizedYoc, required: ruleset.floors.stabilizedYocFloorPct, detail: input.stabilizedYoc === null ? 'YoC missing' : `${(input.stabilizedYoc * 100).toFixed(1)}% vs ${(ruleset.floors.stabilizedYocFloorPct * 100).toFixed(0)}% floor` });
  // irr floor — levered, horizon-dependent (unknown horizon ⇒ stricter 5yr bar)
  const irrReq = input.underwriteHorizonYrs === 10 ? ruleset.floors.leveredIrrFloor10yr : ruleset.floors.leveredIrrFloor5yr;
  if (input.leveredIrr === null) { floorIndeterminate = true; flag('leveredIrr', 'levered IRR missing — IRR floor indeterminate'); }
  floors.push({ id: 'irr', passed: input.leveredIrr !== null && input.leveredIrr >= irrReq, actual: input.leveredIrr, required: irrReq, detail: input.leveredIrr === null ? 'IRR missing' : `${(input.leveredIrr * 100).toFixed(1)}% vs ${(irrReq * 100).toFixed(0)}% (${input.underwriteHorizonYrs ?? 5}yr)` });
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
    const bands = [...s3.clearHeightBands].sort((a, b) => a.maxSf - b.maxSf);
    const sf = input.maxBuildingSf ?? 0;
    const band = bands.find((b) => sf <= b.maxSf) ?? bands[bands.length - 1];
    const ideal = band ? band.idealClearFt : ruleset.gates.physical.minClearHeightFt;
    const floorFt = ruleset.gates.physical.minClearHeightFt;
    clearPts = clamp((input.clearHeightFt - floorFt) / Math.max(1e-9, ideal - floorFt), 0, 1) * s3.clearHeightPoints;
  }
  // loading + site share a truck-court adequacy + ground-level-access basis
  const tcRaw = input.truckCourtFt;
  const tcScore = tcRaw === null ? 0.5 : clamp((tcRaw - s3.truckCourtZeroFt) / Math.max(1e-9, s3.truckCourtIdealFt - s3.truckCourtZeroFt), 0, 1);
  const access = input.hasDock === true || input.hasDriveIn === true ? 1 : 0;
  const loadingPts = s3.loadingPoints * clamp(0.5 * tcScore + 0.5 * access, 0, 1);
  const sitePts = s3.siteFunctionPoints * clamp(0.5 * tcScore + 0.5 * access, 0, 1);
  // product fit: full unless office-heavy; null product ⇒ 0
  let productFitPts = 0;
  if (input.productType === null) flag('productType', 'product type unknown — product-fit sub-score 0');
  else {
    const office = input.officePct ?? 0;
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
  let estimatedAdjPts = 0; // the portion of Cat4 that rides on ESTIMATED market data (Q3)
  let adjPts = 0;
  if (input.marketFundamentalsAdj !== null && input.marketFundamentalsConfidence !== null) {
    if (!fresh) flag('marketFundamentalsAdj', `market fundamentals stale (> ${ruleset.freshness.marketFundamentalsWindowDays}d) — ± defaulted to 0`);
    else {
      adjPts = input.marketFundamentalsAdj * ruleset.scoring.cat4.fundamentalsAdjustMax;
      if (input.marketFundamentalsConfidence !== 'confirmed') estimatedAdjPts = adjPts;
    }
  }
  const cat4 = clamp(tierPts + adjPts, 0, cap('market-location'));
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
  const assetInputsKnown = input.productType !== null && input.constructionType !== null && !incompleteRuleset;
  const riskInputsKnown = input.sellerMotivationScore !== null && (vacant || (input.inPlaceRentPsf !== null && input.marketRentPsf !== null));
  const marketConfidence: Confidence = estimatedAdjPts !== 0 ? 'estimated' : 'confirmed'; // adjacency is confirmed
  const subScores: SubScoreResult[] = [
    mkSub('basis', cat1 + cat2, cap('basis') + cap('yield'), basisInputsKnown ? 'confirmed' : 'estimated'),
    mkSub('asset', cat3 + cat7, cap('product-physical') + cap('value-add'), assetInputsKnown ? 'confirmed' : 'estimated'),
    mkSub('market', cat4, cap('market-location'), marketConfidence),
    mkSub('risk', cat5 + cat6, cap('seller-motivation') + cap('tenancy-lease'), riskInputsKnown ? 'confirmed' : 'estimated'),
  ];
  const composite = clamp(round1(cat1 + cat2 + cat3 + cat4 + cat5 + cat6 + cat7), 0, 100);
  const confirmedComposite = composite - estimatedAdjPts; // Q3: composite with the estimated market ± removed

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

  const confidence = weakest(subScores.map((s) => s.confidence));
  const advisoryOnly = ruleset.ratification !== 'ratified';
  if (advisoryOnly) reasons.push(`ADVISORY ONLY — ruleset '${ruleset.ratification}', not ratified; not a capital-allocation verdict.`);

  const result: AcquisitionScore = {
    schemaVersion: '1.0.0',
    inputsVersion: computeInputsVersion(input, ruleset, opts.rctVersion ?? 'rct-v0'),
    rulesetVersion: ruleset.rulesetVersion,
    ratification: ruleset.ratification,
    scoredAt: opts.now ?? new Date().toISOString(),
    dealId: input.dealId,
    isVacant: vacant,
    gates,
    gatesPassed,
    floors,
    floorsPassed,
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

/** Comp freshness vs the Q6 window. Unknown sourcedAt ⇒ stale (conservative). */
function isFresh(sourcedAt: string | null, asAt: string | null, windowDays: number): boolean {
  if (sourcedAt === null) return false;
  const src = Date.parse(sourcedAt);
  if (Number.isNaN(src)) return false;
  const now = asAt !== null && !Number.isNaN(Date.parse(asAt)) ? Date.parse(asAt) : Date.now();
  return (now - src) <= windowDays * 24 * 60 * 60 * 1000;
}
