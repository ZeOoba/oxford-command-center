// src/contracts/acquisition.ts
//
// Acquisition Scorecard contract — the ONE shared shape imported by the platform engine
// (server/warehouse/acquisition.ts) and referenced as the numeric source of record by the Cowork
// `acquisition-underwriting` skill, so the two surfaces never re-derive scoring logic and never drift.
//
// Encodes Buy Box & Scorecard v1.0 (calibrated with Gabriel 2026-06-09). The answers to the §6 open
// calibration questions (2026-06-13-acquisition-scorecard-contract.md) are encoded as a PROPOSED ruleset
// (config/acquisition-ruleset.v1.proposed.json). Per CLAUDE.md Invariant 4 + the CAPITAL_CONFIG/INTEL_CONFIG
// ratified-vs-proposed discipline, the production engine is FAIL-CLOSED on a `proposed` ruleset: it will
// not emit a capital-allocation verdict until Gabriel ratifies. Nothing here is `ratified` until he signs.
import { z } from 'zod';
import { Confidence, DataQualityFlag } from './common';

/** Ruleset identity — both surfaces assert against it; bumped on any calibration change. */
export const RULESET_VERSION = '1.0.0' as const;

/** Ratification provenance (mirrors intel-config / CAPITAL_CONFIG ratified-vs-proposed). */
export const Ratification = z.enum(['ratified', 'proposed']);
export type Ratification = z.infer<typeof Ratification>;

/** Replacement-Cost Table (Q5) — versioned, ratified; the Basis floor + Basis score both divide by it. */
export const RCT_VERSION = 'replacement-cost.v1' as const;
export const ReplacementCostTable = z.object({
  rctVersion: z.literal(RCT_VERSION),
  ratification: Ratification,
  ratifiedBy: z.string().nullable().default(null),
  ratifiedDate: z.string().nullable().default(null),
  basis: z.string(),
  psf: z.object({ low: z.number().positive(), mid: z.number().positive(), high: z.number().positive() }),
});
export type ReplacementCostTable = z.infer<typeof ReplacementCostTable>;

// ─── Identity enums ──────────────────────────────────────────────────────────────────────────
export const GateId = z.enum(['product', 'size-price', 'market', 'physical', 'flood', 'other-use']); // SKILL.md:25–30
export type GateId = z.infer<typeof GateId>;

export const FloorId = z.enum(['basis', 'yield', 'irr']); // SKILL.md:34–36
export type FloorId = z.infer<typeof FloorId>;

export const SubScore = z.enum(['market', 'asset', 'basis', 'risk']);
export type SubScore = z.infer<typeof SubScore>;

export const ScorecardCategoryId = z.enum([
  'basis', 'yield', 'product-physical', 'market-location', 'seller-motivation', 'tenancy-lease', 'value-add',
]);
export type ScorecardCategoryId = z.infer<typeof ScorecardCategoryId>;

export const ClusterTier = z.enum(['owned-submarket', 'established', 'entry', 'satellite', 'none']);
export type ClusterTier = z.infer<typeof ClusterTier>;

export const ConstructionType = z.enum(['block-tilt-brick', 'mixed', 'pemb', 'unknown']);
export type ConstructionType = z.infer<typeof ConstructionType>;

export const DdCriticalId = z.enum(['flood', 'zoning', 'roof', 'deferred-maintenance-capex']); // SKILL.md:69–75
export type DdCriticalId = z.infer<typeof DdCriticalId>;

export const Tier = z.enum(['T1', 'T2', 'PASS', 'KILLED']);
export type Tier = z.infer<typeof Tier>;

export const Verdict = z.enum(['PURSUE', 'WATCH', 'PASS', 'KILLED']);
export type Verdict = z.infer<typeof Verdict>;

// ─── RULESET (single source of truth; imported by skill + engine) ──────────────────────────────

/** One of the seven calibrated scorecard categories. Points are RATIFIED structure — never tuned in code. */
export const ScorecardCategory = z.object({
  id: ScorecardCategoryId,
  label: z.string(),
  points: z.number().int().positive(),                       // base cap (SKILL.md:44–50)
  vacantPoints: z.number().int().nonnegative().nullable(),   // value-add 13 if vacant; tenancy-lease 0; else null
  subScore: SubScore,                                        // §2 fold-in target
  reallocatesToWhenVacant: z.enum(['value-add']).nullable(), // tenancy-lease → value-add (SKILL.md:49)
});
export type ScorecardCategory = z.infer<typeof ScorecardCategory>;

/** A size-banded clear-height minimum (SKILL.md:52–57). A NULL `clearHeightBands` array is the
 *  PENDING sentinel — the exact cutoffs were not transcribed into the platform spec and cannot be
 *  read in CI; the engine treats a null bands table as an incomplete ruleset (caps verdict at T2). */
export const ClearHeightBand = z.object({
  maxSf: z.number().positive(),        // upper SF bound of this size band
  idealClearFt: z.number().positive(), // full clear-height credit at/above this
});
export type ClearHeightBand = z.infer<typeof ClearHeightBand>;

export const AcquisitionRuleset = z.object({
  rulesetVersion: z.literal(RULESET_VERSION),
  ratification: Ratification,            // 'ratified' only after Gabriel signs the §7 decision list
  calibratedWith: z.string(),            // "Gabriel Goldberg 2026-06-09"
  skillVersion: z.string(),              // "acquisition-underwriting v3.0"
  sourceOfRecord: z.string(),            // SKILL.md path/citation
  ratifiedBy: z.string().nullable().default(null),   // who signed the ratification (Invariant 4 provenance)
  ratifiedDate: z.string().nullable().default(null), // ISO date of sign-off

  // STAGE 0 — gates (SKILL.md:23–30). Bounds, NOT governors.
  gates: z.object({
    sizePrice: z.object({
      singleAssetPriceMin: z.number().positive(),
      singleAssetPriceMax: z.number().positive(),
      portfolioPriceMax: z.number().positive(),
      maxSfPerBuilding: z.number().positive(), // strictly < this
    }),
    physical: z.object({ minClearHeightFt: z.number().positive() }),
    flood: z.object({ sfhaOnPadKills: z.boolean(), sfhaOnLandValuesAtZero: z.boolean() }),
    other: z.object({
      minGroundLeaseYearsRemaining: z.number().nonnegative(),
      maxEnvRemediationPctOfPrice: z.number().min(0).max(1),
    }),
    establishedClusters: z.array(z.string()),
    entryClusters: z.array(z.string()),
    satelliteMaxDriveMinutes: z.number().positive(),
  }),

  // STAGE 1 — floors (SKILL.md:32–38). NO score overrides a floor.
  floors: z.object({
    basisDiscountMinPostMillennium: z.number().min(0).max(1), // built ≥ cutoff
    basisDiscountMinPreMillennium: z.number().min(0).max(1),  // built < cutoff
    basisVintageCutoffYear: z.number().int(),
    stabilizedYocFloorPct: z.number().min(0).max(1),
    leveredIrrFloor5yr: z.number().min(0).max(1),
    leveredIrrFloor10yr: z.number().min(0).max(1),
  }),

  // STAGE 2 — 100-pt scorecard (SKILL.md:40–50). Base points MUST total 100.
  scorecard: z.array(ScorecardCategory)
    .refine((cs) => cs.reduce((s, c) => s + c.points, 0) === 100, 'base scorecard points must total 100'),

  // Linear anchors + the Q1/Q2 piecewise knobs (PROPOSED calibration — tunable until ratified).
  scoring: z.object({
    basisFullCreditDiscount: z.number().min(0).max(1), // 25 pts at ≥ this discount (SKILL.md:44)
    yocZeroPct: z.number().min(0).max(1),              // 0 pts at this YoC (SKILL.md:45)
    yocFullPct: z.number().min(0).max(1),              // full pts at ≥ this YoC
    // Q1 — Cat 3 (Product & Physical, 20)
    cat3: z.object({
      clearHeightPoints: z.number().nonnegative(),
      loadingPoints: z.number().nonnegative(),
      productFitPoints: z.number().nonnegative(),
      constructionPoints: z.object({
        blockTiltBrick: z.number().nonnegative(),
        mixed: z.number().nonnegative(),
        pemb: z.number().nonnegative(),               // PROPOSED: 2 of 4 (Q1)
      }),
      siteFunctionPoints: z.number().nonnegative(),
      truckCourtIdealFt: z.number().positive(),
      truckCourtZeroFt: z.number().positive(),
      loadingDoorsPer10kSf: z.object({                // ratified Q1 loading rule: ideally 1 dock + 1 drive-in / 10k SF
        docks: z.number().nonnegative(),
        driveIns: z.number().nonnegative(),
      }),
      clearHeightBands: z.array(ClearHeightBand)
        .refine((b) => new Set(b.map((x) => x.maxSf)).size === b.length, 'clearHeightBands maxSf values must be unique (deterministic banding)')
        .nullable(), // null = PENDING (SKILL.md:52–57)
    }),
    // Q1 — Cat 4 (Market & Location, 12)
    cat4: z.object({
      tierPoints: z.object({
        ownedSubmarket: z.number().nonnegative(),
        established: z.number().nonnegative(),
        entry: z.number().nonnegative(),
        satellite: z.number().nonnegative(),          // PROPOSED: 6 of 12 (Q1, "capped at half")
      }),
      fundamentalsAdjustMax: z.number().nonnegative(), // ± bound (PROPOSED: 3)
    }),
    // Q2 — Cat 6 (Tenancy & Lease, 7) inverse upside scoring
    cat6: z.object({
      mtmFullDiscountPct: z.number().min(0).max(1),    // PROPOSED: 0.30 below-market → full MtM pts
      mtmMaxPoints: z.number().nonnegative(),          // PROPOSED: 5
      waltSweetSpotYr: z.number().positive(),          // PROPOSED: ≤2yr → full capture factor
      waltDecayYr: z.number().positive(),              // PROPOSED: 2–4yr → half; >4yr → 0
      waltMaxPoints: z.number().nonnegative(),         // PROPOSED: 2
    }),
  }),

  guards: z.object({ marketEstimatedCannotCarryT1: z.boolean() }),    // Q3
  freshness: z.object({ marketFundamentalsWindowDays: z.number().positive() }), // Q6 (PROPOSED: 90)
  ddCritical: z.array(DdCriticalId),                                  // SKILL.md:69–75
  bands: z.object({ t1PursueMin: z.number(), t2WatchMin: z.number() }), // SKILL.md:85–87
});
export type AcquisitionRuleset = z.infer<typeof AcquisitionRuleset>;

// ─── INPUT (what must be known to score; the LLM/analyst populates it, the engine never invents it) ──
//
// The boundary (mirrors scores.ts:1–6): the engine is a pure f(input, ruleset). The model may populate
// these fields (comp research, motivation-signal detection, characteristics abstraction) but may NEVER
// move the resulting number. Qualitative signal lists (seller motivation, value-add optionality) enter
// as a pre-scored 0..1 strength so the deterministic core stays deterministic; their confidence rides
// along so a low-confidence input is visible in the output.
export const AcquisitionInput = z.object({
  dealId: z.string(),
  isPortfolio: z.boolean().default(false),

  // size / price (gate: size-price)
  price: z.number().nullable().default(null),
  maxBuildingSf: z.number().nullable().default(null),  // largest single building SF (the <50k test)
  totalSf: z.number().nullable().default(null),

  // product (gate: product) + Cat 3 product fit
  productType: z.enum([
    'shallow-bay-multi', 'flex', 'office-warehouse', 'functional-single-tenant',
    'quasi-ios', 'retail-only', 'office-only', 'other',
  ]).nullable().default(null),
  officePct: z.number().min(0).max(1).nullable().default(null),
  demisableOffice: z.boolean().nullable().default(null),

  // physical (gate: physical) + Cat 3 clear/loading/site
  clearHeightFt: z.number().nullable().default(null),
  hasDriveIn: z.boolean().nullable().default(null),
  hasDock: z.boolean().nullable().default(null),
  dockCount: z.number().int().nonnegative().nullable().default(null),     // for the 1-dock-per-10k-SF loading rule
  driveInCount: z.number().int().nonnegative().nullable().default(null),  // for the 1-drive-in-per-10k-SF loading rule
  multiStory: z.boolean().nullable().default(null),
  truckCourtFt: z.number().nullable().default(null),
  constructionType: ConstructionType.nullable().default(null),
  yearBuilt: z.number().int().nullable().default(null),

  // flood (gate: flood)
  sfhaOnPad: z.boolean().nullable().default(null),
  sfhaOnExcessLandOnly: z.boolean().nullable().default(null),

  // other kills (gate: other-use)
  groundLeaseYearsRemaining: z.number().nullable().default(null), // null = fee simple (not ground-leased)
  envRemediationPctOfPrice: z.number().nullable().default(null),
  use: z.object({
    automotive: z.boolean(),
    childRelated: z.boolean(),
    childSafetyReviewed: z.boolean(),
  }).nullable().default(null),

  // basis / yield / irr (floors + Cat 1 Basis, Cat 2 Yield)
  allInBasis: z.number().nullable().default(null),
  replacementCostTotal: z.number().nullable().default(null), // appraisal OVERRIDE; reconciled vs the ratified RCT (Q5)
  replacementCostBand: z.enum(['low', 'mid', 'high']).nullable().default(null), // building-class band into the RCT (default mid)
  stabilizedYoc: z.number().nullable().default(null),
  leveredIrr: z.number().nullable().default(null),
  underwriteHorizonYrs: z.union([z.literal(5), z.literal(10)]).nullable().default(null),

  // market (Cat 4)
  clusterTier: ClusterTier.nullable().default(null),
  driveMinutesToCluster: z.number().nullable().default(null),
  marketFundamentalsAdj: z.number().min(-1).max(1).nullable().default(null), // structured ± in [-1,1]; null/stale ⇒ 0 (Q6)
  marketFundamentalsConfidence: Confidence.nullable().default(null),
  compSourcedAt: z.string().nullable().default(null),                        // ISO; drives Q6 staleness

  // seller / motivation (Cat 5) — pre-scored signal strength 0..1 of the 10 pts
  sellerMotivationScore: z.number().min(0).max(1).nullable().default(null),

  // tenancy / lease (Cat 6 inverse upside)
  isVacant: z.boolean().default(false),
  inPlaceRentPsf: z.number().nullable().default(null),
  marketRentPsf: z.number().nullable().default(null),
  marketRentConfidence: Confidence.nullable().default(null),
  waltYears: z.number().nullable().default(null),

  // value-add optionality (Cat 7) — pre-scored 0..1 of the 6 (13 if vacant) pts. INFO-ONLY, never a filter.
  valueAddScore: z.number().min(0).max(1).nullable().default(null),

  // STAGE 2.5 — DD-critical knowledge. A flag true = that item is KNOWN/resolved; missing/false ⇒ caps at T2.
  ddKnown: z.object({
    flood: z.boolean(),
    zoning: z.boolean(),
    roof: z.boolean(),
    'deferred-maintenance-capex': z.boolean(),
  }).partial().default({}),

  asAtUtc: z.string().nullable().default(null), // ISO "now" for deterministic staleness math; null ⇒ engine default
});
export type AcquisitionInput = z.infer<typeof AcquisitionInput>;

// ─── SCORED OUTPUT (engine result; UI + skill render from this) ────────────────────────────────
export const GateResult = z.object({
  id: GateId,
  passed: z.boolean(),
  detail: z.string(),
});
export type GateResult = z.infer<typeof GateResult>;

export const FloorResult = z.object({
  id: FloorId,
  passed: z.boolean(),
  actual: z.number().nullable(),
  required: z.number(),
  detail: z.string(),
});
export type FloorResult = z.infer<typeof FloorResult>;

export const SubScoreResult = z.object({
  id: SubScore,
  points: z.number(),                      // achieved, on native base
  maxPoints: z.number(),                   // 45/26/12/17 (vacant-shifted)
  normalized: z.number().min(0).max(100),  // for the UI gauge
  confidence: Confidence,                  // Market is the weak link (§5)
});
export type SubScoreResult = z.infer<typeof SubScoreResult>;

export const AcquisitionScore = z.object({
  schemaVersion: z.literal('1.0.0'),
  inputsVersion: z.string(),              // hash/version of the deal-input snapshot scored
  rulesetVersion: z.literal(RULESET_VERSION),
  ratification: Ratification,             // echoes the ruleset that produced this score
  scoredAt: z.string(),                   // ISO

  dealId: z.string(),
  isVacant: z.boolean(),

  gates: z.array(GateResult),
  gatesPassed: z.boolean(),
  floors: z.array(FloorResult),
  floorsPassed: z.boolean(),
  /** true when ANY hard floor input is null (basis / yield / IRR) so the floor could not be evaluated.
   *  Surfaced independently of cappedAtT2, which only flips on a T1→T2 band demotion (audit B5). */
  floorIndeterminate: z.boolean(),
  ddCriticalUnresolved: z.array(z.string()), // non-empty ⇒ cap at T2

  subScores: z.array(SubScoreResult),     // market / asset / basis / risk
  composite: z.number().min(0).max(100),  // = Σ scorecard pts = skill 100-pt total

  tier: Tier,
  verdict: Verdict,
  cappedAtT2: z.boolean(),
  /** true when the loaded ruleset is incomplete (e.g. clear-height bands pending) — verdict capped, never PURSUE. */
  incompleteRuleset: z.boolean(),
  /** true when the loaded ruleset is not ratified — production callers MUST treat the score as advisory only. */
  advisoryOnly: z.boolean(),
  confidence: Confidence,                 // weakest-link of the four sub-score confidences
  reasons: z.array(z.string()),           // deterministic narration (scores.ts pattern)
  dataQuality: z.array(DataQualityFlag),  // quarantined / missing inputs
});
export type AcquisitionScore = z.infer<typeof AcquisitionScore>;

// ─── WAREHOUSE PERSISTENCE SHAPES (Phase 4 additions) ────────────────────────────────────

/** Row shape written to / read from acq_candidates. */
export const AcqCandidateRow = z.object({
  id: z.string(),
  source: z.enum(['parcel-screen', 'notion-pipeline', 'manual']),
  sourceBatchId: z.string().nullable(),
  address: z.string().nullable(),
  county: z.string().nullable(),
  state: z.string().nullable(),
  market: ClusterTier.nullable(),
  rentableSf: z.number().nullable(),
  yearBuilt: z.number().int().nullable(),
  ownerName: z.string().nullable(),
  parcelScreenScore: z.number().int().min(0).max(100).nullable(),
  status: z.enum(['active', 'archived', 'acquired', 'passed']),
  notionDealId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AcqCandidateRow = z.infer<typeof AcqCandidateRow>;

/** Scored candidate — candidate row + latest score + calibration signal. */
export const RankedCandidate = z.object({
  candidate: AcqCandidateRow,
  latestScore: AcquisitionScore.nullable(),   // null = not yet scored
  governorDscrCleared: z.boolean().nullable(),
  governorLtvCleared: z.boolean().nullable(),
  calibrationHitRate: z.number().nullable(),  // from calibration_report for this subject_id; null until outcomes
  scoredAt: z.string().nullable(),
});
export type RankedCandidate = z.infer<typeof RankedCandidate>;

/** API response for the ranked deal-flow list. */
export const AcqIntelResponse = z.object({
  rankedCandidates: z.array(RankedCandidate),
  calibrationSummary: z.object({            // kind='acquisition-score' slice of calibrationReport
    totalVerdicts: z.number(),
    resolvedVerdicts: z.number(),
    overallHitRate: z.number().nullable(),
    wilsonLow: z.number().nullable(),
    wilsonHigh: z.number().nullable(),
  }),
  advisoryOnly: z.boolean(),                // true until ruleset + RCT ratified
  rulesetVersion: z.string(),
  asOf: z.string(),                         // ISO
});
export type AcqIntelResponse = z.infer<typeof AcqIntelResponse>;

/** Parcel-screen import batch request body. */
export const ParcelScreenImportRequest = z.object({
  batchLabel: z.string().trim().min(1),
  county: z.string().trim().min(1),
  state: z.string().trim().min(1),
  candidates: z.array(z.object({
    apn: z.string().trim().min(1),
    address: z.string().nullable(),
    market: ClusterTier.nullable(),
    rentableSf: z.number().nullable(),
    yearBuilt: z.number().int().nullable(),
    ownerName: z.string().nullable(),
    parcelScreenScore: z.number().int().min(0).max(100).nullable(),
  })),
});
export type ParcelScreenImportRequest = z.infer<typeof ParcelScreenImportRequest>;
