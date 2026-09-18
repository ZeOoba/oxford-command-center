// src/contracts/lease-market.ts
//
// Lease Market Intelligence — shared Zod contracts (spec rev 3). Server routes parse responses through
// these; client hooks validate with the same schemas.
import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────
export const RentBasis = z.enum(['NNN', 'MG', 'IG', 'GROSS', 'FSG', 'UNKNOWN', 'WITHHELD']);
export type RentBasis = z.infer<typeof RentBasis>;
export const LmSubtype = z.enum(['warehouse', 'flex']);
export type LmSubtype = z.infer<typeof LmSubtype>;
export const BuildingStatus = z.enum(['existing', 'proposed', 'under_construction', 'unknown']);
export type BuildingStatus = z.infer<typeof BuildingStatus>;
export const SIZE_BANDS = ['<5K', '5-15K', '15-30K', '30-50K', '50-80K'] as const;
export const SizeBand = z.enum(SIZE_BANDS);
export type SizeBand = z.infer<typeof SizeBand>;
export const OfficeStratum = z.enum(['all', 'office_lt40', 'office_ge40']);
export type OfficeStratum = z.infer<typeof OfficeStratum>;
export const OwnerType = z.enum(['institutional', 'verify', 'affiliated', 'never_call', 'private', 'unknown']);
export type OwnerType = z.infer<typeof OwnerType>;
export const ListingStatus = z.enum(['active', 'missing_once', 'removed', 'expired']);
export type ListingStatus = z.infer<typeof ListingStatus>;
export const OriginTier = z.enum(['T1', 'T2', 'T5']);
export type OriginTier = z.infer<typeof OriginTier>;
export const ObservationConfidence = z.enum(['high', 'low']);
export type ObservationConfidence = z.infer<typeof ObservationConfidence>;
export const OpexComponent = z.enum(['tax', 'ins', 'cam']);
export type OpexComponent = z.infer<typeof OpexComponent>;
export const ListingEventKind = z.enum(['new', 'returned', 'price_cut', 'price_increase', 'sf_change', 'dom_reset', 'missing', 'removed']);
export type ListingEventKind = z.infer<typeof ListingEventKind>;
export const SignalKind = z.enum(['new_listing', 'stale', 'rent_cut', 'below_market', 'withdrawn_after_stale', 'radar_candidate']);
export type SignalKind = z.infer<typeof SignalKind>;
export const SignalSeverity = z.enum(['info', 'watch', 'high']);
export type SignalSeverity = z.infer<typeof SignalSeverity>;
export const ConfidenceLabel = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type ConfidenceLabel = z.infer<typeof ConfidenceLabel>;
export const CompBasis = z.enum(['similarity', 'cell']);
export type CompBasis = z.infer<typeof CompBasis>;
export const RadarDecisionKind = z.enum(['investigate', 'monitor', 'pass', 'pursued', 'loi', 'closed']);
export type RadarDecisionKind = z.infer<typeof RadarDecisionKind>;
export const PositioningBand = z.enum(['above', 'in_band', 'below', 'unknown']);
export type PositioningBand = z.infer<typeof PositioningBand>;
export const EvidenceValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type EvidenceValue = z.infer<typeof EvidenceValue>;
// Mirrors src/analytics/lease-market/similarity.ts's SimilarityComponent union — the set of similarity
// components that can go into ResolvedComparables.unknown (deferred UI-fix round: surfaced on
// ComparableStats so a MEDIUM/LOW confidence caused by missing subject/comp data is explainable).
export const SimilarityComponent = z.enum(['location', 'size', 'clearHeight', 'age', 'loading', 'office']);
export type SimilarityComponent = z.infer<typeof SimilarityComponent>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── Canonical listing row (the ONLY shape downstream of a parser) ─────────────
export const CanonicalListingRow = z.object({
  costarPropertyId: z.string().nullable(),
  address: z.string().min(1),
  suite: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lon: z.number().min(-180).max(180).nullable(),
  submarket: z.string().nullable(),
  subtype: LmSubtype,
  buildingStatus: BuildingStatus,
  buildingSf: z.number().positive().nullable(),
  yearBuilt: z.number().int().nullable(),
  clearHeightFt: z.number().nonnegative().nullable(),
  docks: z.number().int().nonnegative().nullable(),
  driveIns: z.number().int().nonnegative().nullable(),
  officePct: z.number().min(0).max(100).nullable(),
  ownerName: z.string().nullable(),
  availableSf: z.number().positive(),
  minDivisibleSf: z.number().positive().nullable(),
  rentLow: z.number().nonnegative().nullable(),
  rentHigh: z.number().nonnegative().nullable(),
  rentPeriod: z.enum(['yr', 'mo']).nullable(),
  rentIsTotal: z.boolean(), // amount is a total $ for the space, not $/SF
  rentBasis: RentBasis,
  opexQuotedPsf: z.number().nonnegative().nullable(), // "$7.25/SF + $2.50 NNN" => 2.50
  isSublease: z.boolean(),
  costarDateOnMarket: IsoDate.nullable(),
  brokerName: z.string().nullable(),
  brokerCompany: z.string().nullable(),
  listingUrl: z.string().nullable(),
  description: z.string().max(4000).nullable(),
  sourceRow: z.number().int().positive(),
});
export type CanonicalListingRow = z.infer<typeof CanonicalListingRow>;

// ── Config ────────────────────────────────────────────────────────────────────
export const OpexDefaults = z.object({
  tax: z.number().nonnegative(),
  ins: z.number().nonnegative(),
  cam: z.number().nonnegative(),
  source: z.string().min(1),
  asOf: z.string().min(1),
});
export type OpexDefaults = z.infer<typeof OpexDefaults>;

export const LmMarketConfig = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  tier: z.enum(['established', 'entry']),
  enabled: z.boolean(), // Columbus-first validation gate (A17): only enabled markets ingest
  costarMarketNames: z.array(z.string()),
  mgLandlordPays: z.array(OpexComponent),
  opexDefaults: z.object({ warehouse: OpexDefaults.nullable(), flex: OpexDefaults.nullable() }),
});
export type LmMarketConfig = z.infer<typeof LmMarketConfig>;

export const OraPropertyConfig = z.object({
  propertyKey: z.string().min(1), // raw rent-roll label (Lease.propertyKey)
  marketId: z.string().min(1),
  submarket: z.string().nullable(),
  subtype: LmSubtype,
  officePct: z.number().min(0).max(100).nullable(),
  typicalUnitSf: z.number().positive(),
  leaseBasis: z.enum(['NNN', 'MG', 'GROSS', 'UNKNOWN']),
  addressNorms: z.array(z.string().min(1)),
  lat: z.number().min(-90).max(90).nullable(),
  lon: z.number().min(-180).max(180).nullable(),
  clearHeightFt: z.number().nonnegative().nullable(),
  yearBuilt: z.number().int().nullable(),
  docks: z.number().int().nonnegative().nullable(),
  driveIns: z.number().int().nonnegative().nullable(),
});
export type OraPropertyConfig = z.infer<typeof OraPropertyConfig>;

export const SimilarityWeights = z.object({
  location: z.number().nonnegative(),
  size: z.number().nonnegative(),
  clearHeight: z.number().nonnegative(),
  age: z.number().nonnegative(),
  loading: z.number().nonnegative(),
  office: z.number().nonnegative(),
});
export type SimilarityWeights = z.infer<typeof SimilarityWeights>;

export const LmThresholds = z.object({
  benchmarkMinN: z.number().int().positive(),
  belowMarketMinN: z.number().int().positive(),
  belowMarketMedianRatio: z.number().positive().max(1),
  lowCoverageQuotedShare: z.number().min(0).max(1),
  staleFloorDays: z.number().int().positive(),
  staleBaselineMultiple: z.number().positive(),
  staleFallbackDays: z.object({ established: z.number().int().positive(), entry: z.number().int().positive() }),
  completedDomMinN: z.number().int().positive(),
  vacancyShareMin: z.number().min(0).max(1),
  candidateMaxBuildingSf: z.number().positive(),
  benchmarkMaxBuildingSf: z.number().positive(),
  positioningBandPct: z.number().positive(),
  rangeMaxSpread: z.number().positive(),
  monthlyValueCeiling: z.number().positive(),
  rentMinPsfYr: z.number().positive(),
  rentMaxPsfYr: z.number().positive(),
  quotedOpexMinN: z.number().int().positive(),
  exportMinRowRatio: z.number().min(0).max(1),
  exportRowCap: z.number().int().positive(),
  freshnessDays: z.number().int().positive(),
  flexOfficeSplitPct: z.number().min(0).max(100),
  similarityMinScore: z.number().min(0).max(100),
  similarityTopK: z.number().int().positive(),
  similarityMinComps: z.number().int().positive(),
  similarityHighComps: z.number().int().positive(),
  // M-2: governor-shaped constants formerly hardcoded in similarity.ts — the per-property comp cap
  // (R8) and the count of unknown SUBJECT components that caps confidence at LOW (I-1) — moved into
  // config so they're changeable/auditable the same way every other lease-market threshold is.
  similarityPerPropertyCap: z.number().int().positive(),
  similarityUnknownLowCap: z.number().int().positive(),
  radarMinScore: z.number().min(0).max(100),
  radarPushScore: z.number().min(0).max(100),
  withdrawnLookbackDays: z.number().int().positive(),
  sfChangePct: z.number().positive(),
});
export type LmThresholds = z.infer<typeof LmThresholds>;

export const LeaseMarketConfig = z
  .object({
    version: z.literal(1),
    mirrorRowLevel: z.boolean(),
    ownerScreenModulePath: z.string().min(1),
    markets: z.array(LmMarketConfig).min(1),
    oraProperties: z.array(OraPropertyConfig),
    // M2: case-insensitive substring patterns matched against CoStar's reported owner name — a
    // screen-independent way to recognize an ORA-owned property (compute.ts matchesOraOwnerName),
    // treated as ORA-owned everywhere isOraOwnedProperty gates benchmarks/comps/candidates/signals/
    // radar/the stale-DOM baseline/KPI counts, even when the python owner screen is unavailable and
    // owner_type never resolves past 'unknown'. Defaulted to [] so an existing config file that omits
    // it still parses (the ORA-exclusion layer degrades to the pre-M2 behavior, not a parse failure).
    oraOwnerNamePatterns: z.array(z.string().min(1)).default([]),
    similarityWeights: SimilarityWeights,
    thresholds: LmThresholds,
  })
  .superRefine((c, ctx) => {
    const ids = new Set(c.markets.map((m) => m.id));
    if (ids.size !== c.markets.length) ctx.addIssue({ code: 'custom', message: 'duplicate market id in markets[]' });
    // Duplicate propertyKeys are a config error the positioning market filter would otherwise
    // silently hide: server/warehouse/lease-market/positioning.ts builds `new Map(config.oraProperties
    // .map((p) => [p.propertyKey, p]))`, so a second entry with the same key just overwrites the
    // first with no error -- catch the collision here instead, at config-load time.
    const propertyKeys = new Set<string>();
    for (const p of c.oraProperties) {
      if (propertyKeys.has(p.propertyKey)) {
        ctx.addIssue({ code: 'custom', message: `duplicate oraProperties propertyKey "${p.propertyKey}"` });
      }
      propertyKeys.add(p.propertyKey);
      if (!ids.has(p.marketId)) ctx.addIssue({ code: 'custom', message: `oraProperties["${p.propertyKey}"].marketId "${p.marketId}" is not a configured market` });
    }
    const sum = Object.values(c.similarityWeights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 1e-9) ctx.addIssue({ code: 'custom', message: `similarityWeights must sum to 100 (got ${sum})` });
    if (c.thresholds.rentMinPsfYr >= c.thresholds.rentMaxPsfYr) ctx.addIssue({ code: 'custom', message: 'rentMinPsfYr must be < rentMaxPsfYr' });
    // Ordering checks between related thresholds -- each pair is meaningless (or silently
    // self-defeating downstream) if inverted.
    if (c.thresholds.radarMinScore > c.thresholds.radarPushScore) {
      ctx.addIssue({ code: 'custom', message: 'radarMinScore must be <= radarPushScore' });
    }
    if (c.thresholds.similarityMinComps > c.thresholds.similarityHighComps) {
      ctx.addIssue({ code: 'custom', message: 'similarityMinComps must be <= similarityHighComps' });
    }
    if (c.thresholds.candidateMaxBuildingSf > c.thresholds.benchmarkMaxBuildingSf) {
      ctx.addIssue({ code: 'custom', message: 'candidateMaxBuildingSf must be <= benchmarkMaxBuildingSf' });
    }
    if (c.thresholds.similarityTopK < c.thresholds.similarityHighComps) {
      ctx.addIssue({ code: 'custom', message: 'similarityTopK must be >= similarityHighComps' });
    }
    if (c.thresholds.similarityPerPropertyCap > c.thresholds.similarityTopK) {
      ctx.addIssue({ code: 'custom', message: 'similarityPerPropertyCap must be <= similarityTopK' });
    }
    // There are exactly 6 SimilarityComponent values (location/size/clearHeight/age/loading/office) —
    // a cap above that count could never actually trigger.
    if (c.thresholds.similarityUnknownLowCap > 6) {
      ctx.addIssue({ code: 'custom', message: 'similarityUnknownLowCap must be <= 6 (there are only 6 similarity components)' });
    }
  });
export type LeaseMarketConfig = z.infer<typeof LeaseMarketConfig>;

// ── Shared response parts ─────────────────────────────────────────────────────
const NullableNum = z.number().nullable();

export const CellBenchmark = z.object({
  cellKey: z.string(),
  marketId: z.string(),
  submarket: z.string().nullable(),
  subtype: LmSubtype,
  sizeBand: SizeBand,
  officeStratum: OfficeStratum,
  rolledUp: z.enum(['none', 'size_band', 'market']),
  n: z.number().int().nonnegative(),
  totalN: z.number().int().nonnegative(),
  quotedShare: z.number().min(0).max(1),
  p25: NullableNum,
  median: NullableNum,
  p75: NullableNum,
  lowCoverage: z.boolean(),
});
export type CellBenchmark = z.infer<typeof CellBenchmark>;

export const ComparableStats = z.object({
  basis: CompBasis,
  n: z.number().int().nonnegative(),
  low: NullableNum,
  p25: NullableNum,
  median: NullableNum,
  p75: NullableNum,
  high: NullableNum,
  confidence: ConfidenceLabel,
  cellKey: z.string().nullable(),
  // Deferred UI-fix round: threaded from similarity.ts's ResolvedComparables.unknown (empty on the
  // cell/null-fallback bases, which carry no per-component data) so the UI can explain a confidence
  // cap ("unknown: location, clear height") instead of leaving it unexplained.
  unknown: z.array(SimilarityComponent),
});
export type ComparableStats = z.infer<typeof ComparableStats>;

export const CompRow = z.object({
  listingId: z.number().int(),
  propertyId: z.number().int(),
  address: z.string().nullable(),
  availableSf: z.number(),
  askingNnnEq: z.number(),
  score: z.number(),
  distanceMi: NullableNum,
});
export type CompRow = z.infer<typeof CompRow>;

export const ListingEventRow = z.object({
  id: z.number().int(),
  listingId: z.number().int(),
  propertyId: z.number().int(),
  marketId: z.string(),
  address: z.string().nullable(),
  kind: ListingEventKind,
  eventDate: z.string(),
  prevValue: NullableNum,
  newValue: NullableNum,
});
export type ListingEventRow = z.infer<typeof ListingEventRow>;

// ── /summary ──────────────────────────────────────────────────────────────────
export const MarketFreshness = z.object({
  marketId: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  lastLandingDate: z.string().nullable(),
  lastCompleteDate: z.string().nullable(),
  lastCompleteness: z.enum(['complete', 'partial']).nullable(),
  partialReason: z.string().nullable(),
  stale: z.boolean(),
});
export type MarketFreshness = z.infer<typeof MarketFreshness>;

export const MarketDataQuality = z.object({
  marketId: z.string(),
  activeSpaces: z.number().int().nonnegative(),
  lastExportRows: z.number().int().nonnegative(),
  lastExportSkipped: z.number().int().nonnegative(),
  quotedShare: z.number().min(0).max(1),
  coordsShare: z.number().min(0).max(1),
  lowConfidenceShare: z.number().min(0).max(1),
  rejectedRents: z.number().int().nonnegative(),
});
export type MarketDataQuality = z.infer<typeof MarketDataQuality>;

export const CurvePoint = z.object({
  listingId: z.number().int(),
  propertyId: z.number().int(),
  marketId: z.string(),
  subtype: LmSubtype,
  availableSf: z.number().positive(),
  askingNnnEq: z.number(),
  solid: z.boolean(),
  isOra: z.boolean(),
  address: z.string().nullable(),
});
export type CurvePoint = z.infer<typeof CurvePoint>;

export const DomBin = z.object({ label: z.string(), count: z.number().int().nonnegative() });
export type DomBin = z.infer<typeof DomBin>;

export const LeaseMarketKpis = z.object({
  marketsFresh: z.number().int().nonnegative(),
  marketsEnabled: z.number().int().nonnegative(),
  activeSpaces: z.number().int().nonnegative(),
  newInLatest: z.number().int().nonnegative(),
  priceCutsInLatest: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  radarCandidates: z.number().int().nonnegative(),
});
export type LeaseMarketKpis = z.infer<typeof LeaseMarketKpis>;

export const LeaseMarketSummaryResponse = z.object({
  asOf: z.string(),
  rowLevel: z.boolean(),
  // Whole-branch review finding I3: asOf is always referenceDate(), never the last compute run — an
  // operator who ingests without running compute would otherwise see populated Market Rents/Changes
  // (ingest-only reads) next to an empty Radar and zeroed stale/radarCandidates KPIs with no
  // explanation. MAX(computed_at) from lm_signal; null when compute has never run.
  lastComputedAt: z.string().nullable(),
  kpis: LeaseMarketKpis,
  freshness: z.array(MarketFreshness),
  dataQuality: z.array(MarketDataQuality),
  benchmarks: z.array(CellBenchmark),
  curve: z.array(CurvePoint),
  domByMarket: z.array(z.object({ marketId: z.string(), bins: z.array(DomBin) })),
});
export type LeaseMarketSummaryResponse = z.infer<typeof LeaseMarketSummaryResponse>;

// ── /positioning ──────────────────────────────────────────────────────────────
// Go-live change (2026-09-17, Gabriel): the real rent roll carries zero vacant rows, so Rent Position
// now sources ORA available space primarily from ORA-owned CoStar listings ('listing'), priced against
// comparables using the listing's own asking rent; a rent-roll vacancy that matches a listing keeps
// today's row instead ('rent-roll') so the two are never duplicated. `source` lets the UI tell "this is
// what CoStar says we're marketing" from "this is what our rent roll says is empty" apart.
export const PositioningRowSource = z.enum(['listing', 'rent-roll']);
export type PositioningRowSource = z.infer<typeof PositioningRowSource>;

export const PositioningRow = z.object({
  propertyKey: z.string(),
  unit: z.string().nullable(),
  sf: z.number().nonnegative(),
  oraAskingNnnEq: NullableNum,
  stats: ComparableStats.nullable(),
  comps: z.array(CompRow),
  percentile: z.number().min(0).max(1).nullable(),
  gapPct: NullableNum,
  band: PositioningBand,
  recommendation: z.string(),
  flags: z.array(z.enum(['not_listed'])),
  effectiveDom: z.number().int().nullable(),
  source: PositioningRowSource,
});
export type PositioningRow = z.infer<typeof PositioningRow>;

// Whole-branch review finding 6: oraListingId/brokerName/listingUrl/dateListed were removed from
// PositioningRow above — grep confirmed no consumer (src/ or server/) rendered or read them; they put
// a CoStar broker name on the wire for no benefit. See deferred-ui-fix-report.md.

// Deferred R2: a listing whose owner screens as ORA-self (ownerType === 'affiliated') but whose
// address is NOT in config.oraProperties.addressNorms — the ORA-exclusion layer still excludes it from
// comps/benchmarks/radar (compute.ts isOraOwnedProperty), but it can never appear as a PositioningRow
// (those are keyed off configured oraProperties), so it needs its own hygiene surface.
export const ListingHygieneFlag = z.object({
  listingId: z.number().int(),
  marketId: z.string(),
  address: z.string().nullable(),
  reason: z.string(),
});
export type ListingHygieneFlag = z.infer<typeof ListingHygieneFlag>;

// Go-live change (2026-09-17): since every active, config-mapped ORA listing now produces its own
// PositioningRow (source 'listing') when no rent-roll vacancy claims it, this array should be empty in
// ordinary operation — it is kept only as a defensive surface for a listing that is genuinely
// inconsistent (present in config.oraProperties' market scope but, for some reason, never covered by
// either a matched vacant row or its own listing row). See positioning.ts's rowSpaceIds guard.
export const ListedButLeased = z.object({
  propertyKey: z.string(),
  listingId: z.number().int(),
  suite: z.string(),
  askingNnnEq: NullableNum,
  effectiveDom: z.number().int(),
  address: z.string().nullable(),
});
export type ListedButLeased = z.infer<typeof ListedButLeased>;

export const PositioningResponse = z.object({
  asOf: z.string(),
  unconfiguredPropertyKeys: z.array(z.string()),
  rows: z.array(PositioningRow),
  listedButLeased: z.array(ListedButLeased),
  hygieneFlags: z.array(ListingHygieneFlag),
});
export type PositioningResponse = z.infer<typeof PositioningResponse>;

// ── /signals ──────────────────────────────────────────────────────────────────
export const WithheldMarket = z.object({ marketId: z.string(), reason: z.string() });
export type WithheldMarket = z.infer<typeof WithheldMarket>;

export const SignalRow = z.object({
  id: z.number().int(),
  propertyId: z.number().int(),
  listingId: z.number().int().nullable(),
  marketId: z.string(),
  address: z.string().nullable(),
  kind: SignalKind,
  severity: SignalSeverity,
  score: z.number().int().nullable(),
  confidence: ConfidenceLabel.nullable(),
  compBasis: CompBasis.nullable(),
  cellKey: z.string().nullable(),
  computedAt: z.string(),
  evidence: z.record(z.string(), EvidenceValue),
});
export type SignalRow = z.infer<typeof SignalRow>;

export const SignalsResponse = z.object({
  asOf: z.string(),
  candidatesWithheld: z.array(WithheldMarket),
  signals: z.array(SignalRow),
});
export type SignalsResponse = z.infer<typeof SignalsResponse>;

// ── /radar ────────────────────────────────────────────────────────────────────
export const RadarScoreParts = z.object({
  dom: z.number().int().nonnegative(),
  reductions: z.number().int().nonnegative(),
  belowMarket: z.number().int().nonnegative(),
  vacancy: z.number().int().nonnegative(),
  buyBoxFit: z.number().int().nonnegative(),
  owner: z.number().int().nonnegative(),
});
export type RadarScoreParts = z.infer<typeof RadarScoreParts>;

export const RadarDecisionRecord = z.object({ decision: RadarDecisionKind, decidedAt: z.string(), note: z.string().nullable() });
export type RadarDecisionRecord = z.infer<typeof RadarDecisionRecord>;

export const RadarCandidate = z.object({
  propertyId: z.number().int(),
  marketId: z.string(),
  address: z.string().nullable(),
  subtype: LmSubtype,
  buildingSf: NullableNum,
  score: z.number().int().min(0).max(100),
  parts: RadarScoreParts,
  confidence: ConfidenceLabel,
  vacancyShare: NullableNum,
  maxEffectiveDom: z.number().int().nonnegative(),
  reductionCount: z.number().int().nonnegative(),
  cumulativeReductionPct: NullableNum,
  bestGapPct: NullableNum,
  comparableMedian: NullableNum,
  indicativeRentGapUsd: NullableNum, // gross, vacant space only — NOT NOI
  ownerName: z.string().nullable(),
  ownerType: OwnerType,
  ownerListingCount: z.number().int().nonnegative(),
  brokerName: z.string().nullable(),
  latestDecision: RadarDecisionRecord.nullable(),
});
export type RadarCandidate = z.infer<typeof RadarCandidate>;

export const RadarResponse = z.object({
  asOf: z.string(),
  candidatesWithheld: z.array(WithheldMarket),
  candidates: z.array(RadarCandidate),
  monitor: z.array(SignalRow), // withdrawn_after_stale
});
export type RadarResponse = z.infer<typeof RadarResponse>;

export const RadarDecisionInput = z.object({
  propertyId: z.number().int().positive(),
  decision: RadarDecisionKind,
  note: z.string().max(500).nullable(),
});
export type RadarDecisionInput = z.infer<typeof RadarDecisionInput>;

export const RadarDecisionResponse = z.object({ ok: z.literal(true), id: z.number().int() });
export type RadarDecisionResponse = z.infer<typeof RadarDecisionResponse>;

// ── /changes and /history ─────────────────────────────────────────────────────
export const ChangesResponse = z.object({ asOf: z.string(), events: z.array(ListingEventRow) });
export type ChangesResponse = z.infer<typeof ChangesResponse>;

export const HistoryResponse = z.object({
  listingId: z.number().int(),
  address: z.string().nullable(),
  observations: z.array(
    z.object({
      observedAt: z.string(),
      availableSf: z.number(),
      askingNnnEq: NullableNum,
      rentBasis: RentBasis,
      confidence: ObservationConfidence,
      costarDom: z.number().int().nullable(),
    }),
  ),
  events: z.array(ListingEventRow),
});
export type HistoryResponse = z.infer<typeof HistoryResponse>;
