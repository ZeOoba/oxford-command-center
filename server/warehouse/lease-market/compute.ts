// server/warehouse/lease-market/compute.ts
//
// Lease Market Intelligence — loads current properties/spaces, builds cells and similarity comparables,
// persists space signals + radar candidates + the market-rent feed, and serves read models
// (spec rev 3 §3.5–3.10, §4). Financial-decision source: refute pass required.
import type { WarehouseDb } from '../db';
import type {
  BuildingStatus, DomBin, LeaseMarketConfig, LeaseMarketKpis, ListingEventKind, ListingEventRow, ListingStatus, LmSubtype,
  MarketDataQuality, MarketFreshness, OfficeStratum, OraPropertyConfig, OriginTier, OwnerType, RentBasis, SizeBand, WithheldMarket,
} from '../../../src/contracts/lease-market';
import { addDays, daysBetween, isBenchmarkEligible, officeStratumFor, sizeBandFor } from '../../../src/analytics/lease-market/normalize';
import { cellIndex, type BenchRow, type CellTarget, type ComputedCell } from '../../../src/analytics/lease-market/benchmarks';
import { resolveComparables, type CompCandidate, type ResolvedComparables, type SpaceProfile } from '../../../src/analytics/lease-market/similarity';
import {
  completedDomBaseline, effectiveDom, spaceSignals, staleThresholdDays,
  type ObservationPoint, type SignalDraft, type SpaceHistory,
} from '../../../src/analytics/lease-market/signals';
import { scoreRadar, type RadarResult } from '../../../src/analytics/lease-market/radar';
import { latestCompleteLanding } from './ingest';

export const RENT_GAP_LABEL = 'gross, vacant space only — not NOI';

export interface PropertyState {
  propertyId: number; marketId: string; addressDisplay: string; submarket: string | null; subtype: LmSubtype;
  buildingStatus: BuildingStatus; buildingSf: number | null; yearBuilt: number | null; clearHeightFt: number | null;
  docks: number | null; driveIns: number | null; officePct: number | null; lat: number | null; lon: number | null;
  ownerName: string | null; ownerType: OwnerType; oraPropertyKey: string | null;
}

export interface SpaceState extends SpaceHistory {
  suiteNorm: string;
  property: PropertyState;
  sizeBand: SizeBand | null;
  officeStratum: OfficeStratum;
  originTier: OriginTier;
  latestEligible: boolean;
  latestConfidence: 'high' | 'low';
  latestRejected: boolean;
  brokerName: string | null;
  listingUrl: string | null;
}

export interface MarketState {
  asOf: string;
  properties: Map<number, PropertyState>;
  spaces: SpaceState[];
  benchRows: BenchRow[];
  candidates: CompCandidate[];
  cellFor: (t: CellTarget) => ComputedCell;
}

export function isActive(s: Pick<SpaceState, 'status'>): boolean {
  return s.status === 'active' || s.status === 'missing_once';
}

interface PropertyRow {
  id: number; market_id: string; address_display: string; submarket: string | null; subtype: LmSubtype; building_status: BuildingStatus;
  building_sf: number | null; year_built: number | null; clear_height_ft: number | null; docks: number | null; drive_ins: number | null;
  office_pct: number | null; lat: number | null; lon: number | null; owner_name: string | null; owner_type: OwnerType; ora_property_key: string | null;
}
interface SpaceRow {
  id: number; property_id: number; suite_norm: string; first_seen: string; first_landing_id: number; costar_date_on_market: string | null;
  status: ListingStatus; removed_at: string | null; origin_tier: OriginTier; broker_name: string | null; listing_url: string | null;
  original_asking: number | null; reduction_count: number; cumulative_reduction_pct: number | null;
}
interface ObservationRow {
  listing_id: number; observed_at: string; available_sf: number; asking_nnn_eq: number | null; rent_low: number | null; rent_basis: RentBasis;
  is_sublease: number; costar_dom: number | null; confidence: 'high' | 'low'; rejected_reason: string | null;
}

// The window of landings that count as "the latest export" for isNewInLatestExport / event-count
// purposes (fix round 2, requirement 1): every ok landing (complete OR partial) strictly after the
// SECOND-latest COMPLETE landing's observed_at, so a partial landing sandwiched between two complete
// exports is not lost — its events still count as part of "the latest export". Markets with fewer than
// one complete landing have no window at all (nothing is "the latest export" yet); markets with exactly
// one complete landing (no prior baseline) get every ok landing up to and including it.
function latestExportLandingIds(db: WarehouseDb, config: LeaseMarketConfig): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const m of config.markets) {
    if (!latestCompleteLanding(db, m.id)) continue;
    const prior = db
      .prepare(
        `SELECT observed_at FROM lm_landing WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok' AND completeness = 'complete'
         ORDER BY observed_at DESC, id DESC LIMIT 1 OFFSET 1`,
      )
      .get(m.id) as { observed_at: string } | undefined;
    const rows = db
      .prepare(`SELECT id FROM lm_landing WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok' AND observed_at > ?`)
      .all(m.id, prior?.observed_at ?? '') as Array<{ id: number }>;
    out.set(m.id, new Set(rows.map((r) => r.id)));
  }
  return out;
}

export function loadMarketState(db: WarehouseDb, config: LeaseMarketConfig, asOf: string): MarketState {
  const t = config.thresholds;
  const properties = new Map<number, PropertyState>();
  // ORDER BY id (fix round 2, requirement 2): the iteration order of this Map feeds oraSubject's
  // lowest-id-wins tie-break deterministically — without an explicit order, SQLite's row order for a
  // plain SELECT is unspecified.
  for (const p of db.prepare('SELECT * FROM lm_property ORDER BY id').all() as PropertyRow[]) {
    properties.set(p.id, {
      propertyId: p.id, marketId: p.market_id, addressDisplay: p.address_display, submarket: p.submarket, subtype: p.subtype,
      buildingStatus: p.building_status, buildingSf: p.building_sf, yearBuilt: p.year_built, clearHeightFt: p.clear_height_ft,
      docks: p.docks, driveIns: p.drive_ins, officePct: p.office_pct, lat: p.lat, lon: p.lon, ownerName: p.owner_name,
      ownerType: p.owner_type, oraPropertyKey: p.ora_property_key,
    });
  }

  const removedSince = addDays(asOf, -t.withdrawnLookbackDays);
  const filter = `(l.status IN ('active', 'missing_once') OR (l.status = 'removed' AND l.removed_at >= @removedSince))`;
  const spaceRows = db
    .prepare(
      `SELECT l.id, l.property_id, l.suite_norm, l.first_seen, l.first_landing_id, l.costar_date_on_market, l.status, l.removed_at,
              l.origin_tier, l.broker_name, l.listing_url, m.original_asking, m.reduction_count, m.cumulative_reduction_pct
       FROM lm_listing l JOIN lm_v_listing_metrics m ON m.listing_id = l.id WHERE ${filter} ORDER BY l.id`,
    )
    .all({ removedSince }) as SpaceRow[];
  const obsRows = db
    .prepare(
      `SELECT o.listing_id, o.observed_at, o.available_sf, o.asking_nnn_eq, o.rent_low, o.rent_basis, o.is_sublease, o.costar_dom, o.confidence, o.rejected_reason
       FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id WHERE ${filter} ORDER BY o.listing_id, o.observed_at, o.id`,
    )
    .all({ removedSince }) as ObservationRow[];
  const byListing = new Map<number, ObservationRow[]>();
  for (const o of obsRows) {
    const list = byListing.get(o.listing_id) ?? [];
    list.push(o);
    byListing.set(o.listing_id, list);
  }

  const windowIds = latestExportLandingIds(db, config);
  const cutIds = new Set<number>();
  const windowIdList = [...windowIds.values()].flatMap((s) => [...s]);
  if (windowIdList.length > 0) {
    const rows = db
      .prepare(`SELECT DISTINCT listing_id FROM lm_listing_event WHERE kind = 'price_cut' AND landing_id IN (${windowIdList.map(() => '?').join(',')})`)
      .all(...windowIdList) as Array<{ listing_id: number }>;
    for (const r of rows) cutIds.add(r.listing_id);
  }

  const spaces: SpaceState[] = [];
  const benchRows: BenchRow[] = [];
  const candidates: CompCandidate[] = [];
  for (const row of spaceRows) {
    const property = properties.get(row.property_id);
    const history = byListing.get(row.id) ?? [];
    if (!property || history.length === 0) continue;
    const observations: ObservationPoint[] = history.map((o) => ({
      observedAt: o.observed_at, availableSf: o.available_sf, askingNnnEq: o.asking_nnn_eq, rentLow: o.rent_low, costarDom: o.costar_dom,
      isSublease: o.is_sublease === 1,
      eligible: isBenchmarkEligible(
        { confidence: o.confidence, effectiveBasis: o.rent_basis, isSublease: o.is_sublease === 1, originTier: row.origin_tier,
          buildingStatus: property.buildingStatus, askingNnnEq: o.asking_nnn_eq, buildingSf: property.buildingSf },
        t.benchmarkMaxBuildingSf,
      ),
    }));
    const latestRow = history[history.length - 1]!;
    const latest = observations[observations.length - 1]!;
    const sizeBand = sizeBandFor(latest.availableSf);
    const officeStratum = officeStratumFor(property.subtype, property.officePct, t.flexOfficeSplitPct);
    const isOraOwned = property.oraPropertyKey !== null;
    const space: SpaceState = {
      listingId: row.id, propertyId: property.propertyId, marketId: property.marketId,
      addressDisplay: row.suite_norm ? `${property.addressDisplay} Ste ${row.suite_norm}` : property.addressDisplay,
      buildingStatus: property.buildingStatus, isOraOwned, status: row.status, removedAt: row.removed_at, firstSeen: row.first_seen,
      costarDateOnMarket: row.costar_date_on_market, isNewInLatestExport: windowIds.get(property.marketId)?.has(row.first_landing_id) ?? false,
      observations, priceCutInLatestExport: cutIds.has(row.id), reductionCount: row.reduction_count, originalAsking: row.original_asking,
      cumulativeReductionPct: row.cumulative_reduction_pct, suiteNorm: row.suite_norm, property, sizeBand, officeStratum,
      originTier: row.origin_tier, latestEligible: latest.eligible, latestConfidence: latestRow.confidence,
      latestRejected: latestRow.rejected_reason !== null, brokerName: row.broker_name, listingUrl: row.listing_url,
    };
    spaces.push(space);
    if (!isActive(space) || isOraOwned || sizeBand === null) continue;
    benchRows.push({
      listingId: row.id, marketId: property.marketId, submarket: property.submarket, subtype: property.subtype, sizeBand, officeStratum,
      askingNnnEq: latest.askingNnnEq, eligible: latest.eligible, clearHeightFt: property.clearHeightFt, yearBuilt: property.yearBuilt, docks: property.docks,
    });
    if (latest.eligible && latest.askingNnnEq !== null) {
      candidates.push({ ...profileOf(space), listingId: row.id, propertyId: property.propertyId, askingNnnEq: latest.askingNnnEq, addressDisplay: space.addressDisplay });
    }
  }

  return { asOf, properties, spaces, benchRows, candidates, cellFor: cellIndex(benchRows, { minN: t.benchmarkMinN, lowCoverageShare: t.lowCoverageQuotedShare }) };
}

export function profileOf(s: SpaceState): SpaceProfile {
  const p = s.property;
  return {
    marketId: p.marketId, submarket: p.submarket, subtype: p.subtype, lat: p.lat, lon: p.lon,
    availableSf: s.observations[s.observations.length - 1]!.availableSf, clearHeightFt: p.clearHeightFt, yearBuilt: p.yearBuilt,
    docks: p.docks, driveIns: p.driveIns, officePct: p.officePct,
  };
}

// Candidates are partitioned by market|subtype before similarity resolution (fix round 2, requirement 3)
// rather than relying solely on scoreSimilarity's own per-pair market/subtype check — defense in depth
// against cross-market comp leakage, and cheaper than scoring every other market's rows per space.
function candidatesInPartition(state: MarketState, marketId: string, subtype: LmSubtype): CompCandidate[] {
  return state.candidates.filter((c) => c.marketId === marketId && c.subtype === subtype);
}

export function comparablesForSpace(state: MarketState, s: SpaceState, config: LeaseMarketConfig): ResolvedComparables | null {
  if (s.sizeBand === null) return null;
  const cell = state.cellFor({ marketId: s.marketId, submarket: s.property.submarket, subtype: s.property.subtype, sizeBand: s.sizeBand, officeStratum: s.officeStratum });
  const partition = candidatesInPartition(state, s.marketId, s.property.subtype);
  return resolveComparables(profileOf(s), s.propertyId, partition, cell, config.similarityWeights, config.thresholds);
}

export function oraSubject(
  p: OraPropertyConfig,
  state: MarketState,
  availableSf: number,
  t: LeaseMarketConfig['thresholds'],
): { profile: SpaceProfile; matchedPropertyId: number | null; target: CellTarget | null } {
  // Market-filtered and deterministic (fix round 2, requirement 2): identity_key keying (Task 09) makes
  // it possible for more than one lm_property row to carry the same ora_property_key (e.g. an
  // unadopted duplicate at the same address, or — defensively — a stale cross-market collision); the
  // correct match is the lowest-id row IN THIS PROPERTY'S OWN MARKET, never a same-keyed row elsewhere.
  const matched = [...state.properties.values()].find((x) => x.oraPropertyKey === p.propertyKey && x.marketId === p.marketId) ?? null;
  const profile: SpaceProfile = {
    marketId: p.marketId,
    submarket: p.submarket ?? matched?.submarket ?? null,
    subtype: p.subtype,
    lat: p.lat ?? matched?.lat ?? null,
    lon: p.lon ?? matched?.lon ?? null,
    availableSf,
    clearHeightFt: p.clearHeightFt ?? matched?.clearHeightFt ?? null,
    yearBuilt: p.yearBuilt ?? matched?.yearBuilt ?? null,
    docks: p.docks ?? matched?.docks ?? null,
    driveIns: p.driveIns ?? matched?.driveIns ?? null,
    officePct: p.officePct ?? matched?.officePct ?? null,
  };
  const band = sizeBandFor(availableSf);
  const target = band === null ? null : { marketId: p.marketId, submarket: profile.submarket, subtype: p.subtype, sizeBand: band, officeStratum: officeStratumFor(p.subtype, profile.officePct, t.flexOfficeSplitPct) };
  return { profile, matchedPropertyId: matched?.propertyId ?? null, target };
}

export function staleThresholdsByMarket(db: WarehouseDb, config: LeaseMarketConfig, asOf: string): Map<string, number> {
  // Fix round 2, requirement 5: the baseline is a point-in-time statistic as of asOf — a removal dated
  // AFTER asOf must not leak into it (removed_at <= asOf), and ORA's own removed spaces are not market
  // comparables (p.ora_property_key IS NULL).
  const rows = db
    .prepare(
      `SELECT p.market_id, l.first_seen, l.costar_date_on_market, l.removed_at FROM lm_listing l JOIN lm_property p ON p.id = l.property_id
       WHERE l.status = 'removed' AND l.origin_tier = 'T1' AND p.ora_property_key IS NULL AND l.removed_at >= ? AND l.removed_at <= ?`,
    )
    .all(addDays(asOf, -365), asOf) as Array<{ market_id: string; first_seen: string; costar_date_on_market: string | null; removed_at: string }>;
  const doms = new Map<string, number[]>();
  for (const r of rows) {
    const list = doms.get(r.market_id) ?? [];
    list.push(effectiveDom({ firstSeen: r.first_seen, costarDateOnMarket: r.costar_date_on_market }, r.removed_at));
    doms.set(r.market_id, list);
  }
  return new Map(config.markets.map((m) => [m.id, staleThresholdDays(completedDomBaseline(doms.get(m.id) ?? [], config.thresholds.completedDomMinN), m.tier, config.thresholds)]));
}

export function ownerScreenOkByMarket(db: WarehouseDb, config: LeaseMarketConfig): Map<string, boolean> {
  return new Map(config.markets.map((m) => [m.id, latestCompleteLanding(db, m.id)?.owner_screen_ok === 1]));
}

// Fix round 2, requirement 1 (second half): built from the SAME screenOk map buildRadar's gate reads
// (ownerScreenOkByMarket) — not just "has a complete landing whose screen failed" — so every market the
// radar gate actually withholds candidates for is reported here too, including a market that has only
// ever landed a PARTIAL export (no complete landing yet means ownerScreenOkByMarket is false for it,
// and buildRadar's gate withholds it exactly the same way). Restricted to markets with at least one
// parse_status='ok' landing (complete or partial) so a never-ingested market is never reported as
// withheld — there is nothing to withhold yet.
export function withheldCandidateMarkets(db: WarehouseDb, config: LeaseMarketConfig): WithheldMarket[] {
  const screenOk = ownerScreenOkByMarket(db, config);
  const hasOkLanding = db.prepare(`SELECT 1 FROM lm_landing WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok' LIMIT 1`);
  return config.markets.flatMap((m) => {
    if (screenOk.get(m.id) === true) return [];
    if (!hasOkLanding.get(m.id)) return [];
    const reason = latestCompleteLanding(db, m.id)
      ? 'owner screen unavailable on the latest complete export; acquisition candidates withheld'
      : 'no complete export yet; acquisition candidates withheld';
    return [{ marketId: m.id, reason }];
  });
}

export function propertyVacancyShares(state: MarketState): Map<number, number | null> {
  const sums = new Map<number, number>();
  for (const s of state.spaces) {
    if (!isActive(s)) continue;
    const latest = s.observations[s.observations.length - 1]!;
    if (latest.isSublease) continue;
    sums.set(s.propertyId, (sums.get(s.propertyId) ?? 0) + latest.availableSf);
  }
  const out = new Map<number, number | null>();
  for (const [propertyId, sum] of sums) {
    const sf = state.properties.get(propertyId)?.buildingSf ?? null;
    out.set(propertyId, sf !== null && sf > 0 ? sum / sf : null);
  }
  return out;
}

export function ownerPropertyCounts(state: MarketState): Map<string, number> {
  const owners = new Map<string, Set<number>>();
  for (const s of state.spaces) {
    if (!isActive(s) || !s.property.ownerName) continue;
    const key = s.property.ownerName.trim().toUpperCase();
    const set = owners.get(key) ?? new Set<number>();
    set.add(s.propertyId);
    owners.set(key, set);
  }
  return new Map([...owners.entries()].map(([k, v]) => [k, v.size]));
}

export interface RadarEntry {
  property: PropertyState;
  result: RadarResult;
  ownerListingCount: number;
  brokerName: string | null;
}

export function buildRadar(
  state: MarketState,
  config: LeaseMarketConfig,
  thresholds: Map<string, number>,
  screenOk: Map<string, boolean>,
  compsFor: (s: SpaceState) => ResolvedComparables | null,
): RadarEntry[] {
  const owners = ownerPropertyCounts(state);
  const byProperty = new Map<number, SpaceState[]>();
  for (const s of state.spaces) {
    if (!isActive(s) || s.isOraOwned) continue;
    const list = byProperty.get(s.propertyId) ?? [];
    list.push(s);
    byProperty.set(s.propertyId, list);
  }
  const out: RadarEntry[] = [];
  for (const [propertyId, spaces] of byProperty) {
    const property = state.properties.get(propertyId)!;
    const threshold = thresholds.get(property.marketId);
    if (threshold === undefined) continue;
    const result = scoreRadar(
      {
        propertyId, buildingSf: property.buildingSf, buildingStatus: property.buildingStatus, subtype: property.subtype,
        ownerType: property.ownerType, isOraOwned: property.oraPropertyKey !== null,
        spaces: spaces.map((s) => {
          const latest = s.observations[s.observations.length - 1]!;
          const c = compsFor(s);
          return {
            listingId: s.listingId, availableSf: latest.availableSf, isSublease: latest.isSublease, effectiveDom: effectiveDom(s, state.asOf),
            reductionCount: s.reductionCount, cumulativeReductionPct: s.cumulativeReductionPct, askingNnnEq: latest.askingNnnEq,
            eligible: latest.eligible, comparableMedian: c?.median ?? null, comparableConfidence: c?.confidence ?? 'LOW',
          };
        }),
      },
      { staleThresholdDays: threshold, ownerScreenAvailable: screenOk.get(property.marketId) === true, thresholds: config.thresholds },
    );
    const ownerListingCount = property.ownerName ? (owners.get(property.ownerName.trim().toUpperCase()) ?? 1) : 0;
    out.push({ property, result, ownerListingCount, brokerName: spaces.find((s) => s.brokerName)?.brokerName ?? null });
  }
  return out;
}

export interface ComputeResult {
  signals: number;
  byKind: Record<string, number>;
  radarCandidates: number;
  feedRows: number;
  withheldMarkets: string[];
}

// Fix round 2, requirement 4: the ENTIRE compute — reading current state through writing the new
// signal/feed set — runs inside one IMMEDIATE transaction. Immediate mode takes SQLite's write lock at
// BEGIN (not on the first write), so a concurrent reader on another connection sees either the fully
// pre-run signal/feed set or the fully post-run one, never a half-written mix, and nothing else can
// interleave a write between the read-side computation and the delete+insert (which, before this fix,
// were two separate steps only the second of which was transactional).
//
// Fix round 2, requirement 7: `asOf` is a POINT-IN-TIME bound on the stale-baseline query only
// (staleThresholdsByMarket excludes any removal dated after asOf, and effectiveDom's own "now" is asOf
// throughout). It does not make this a historical replay — `loadMarketState`, the feed, and radar all
// read the CURRENT live warehouse rows (current status, current observations) regardless of `asOf`. A
// backdated `asOf` recomputes signals/feed against today's data with yesterday's stale-threshold
// baseline; it is not a supported way to reconstruct what compute would have produced on that date.
export function runCompute(db: WarehouseDb, config: LeaseMarketConfig, asOf: string): ComputeResult {
  const body = (): ComputeResult => {
    const t = config.thresholds;
    const state = loadMarketState(db, config, asOf);
    const thresholds = staleThresholdsByMarket(db, config, asOf);
    const screenOk = ownerScreenOkByMarket(db, config);
    const vacancy = propertyVacancyShares(state);
    const cache = new Map<number, ResolvedComparables | null>();
    const compsFor = (s: SpaceState) => {
      if (!cache.has(s.listingId)) cache.set(s.listingId, comparablesForSpace(state, s, config));
      return cache.get(s.listingId) ?? null;
    };

    const drafts: SignalDraft[] = [];
    for (const s of state.spaces) {
      const threshold = thresholds.get(s.marketId);
      if (threshold === undefined) continue;
      drafts.push(...spaceSignals(s, { asOf, staleThresholdDays: threshold, propertyVacancyShare: vacancy.get(s.propertyId) ?? null, comparables: isActive(s) ? compsFor(s) : null, thresholds: t }));
    }

    const radar = buildRadar(state, config, thresholds, screenOk, compsFor).filter((e) => e.result.isCandidate);
    for (const e of radar) {
      const r = e.result;
      // Minor fix (controller decision): record the best-gap space's comp basis on the signal row.
      // RadarResult doesn't expose which listing produced comparableMedian/confidence directly (radar.ts
      // is out of scope for this round), so the best space is recovered here by matching the same
      // (median, confidence) pair scoreRadar picked among this property's live, non-ORA spaces.
      //
      // Fix round 2, requirement 2 (minor #2): only attempt that recovery when r.comparableMedian is
      // non-null. scoreRadar sets comparableMedian to null whenever NO live space had a usable
      // (non-LOW-confidence) comparable — in that case every remaining live space's own resolveComparables
      // result can independently be `{ median: null, confidence: 'LOW' }` too (the "no comps at all"
      // fallback), which would otherwise satisfy `c.median === null && c.confidence === r.confidence`
      // and wrongly attribute a comp basis (e.g. 'cell') to a candidate whose score used no comp basis.
      const liveSpaces = state.spaces.filter((s) => s.propertyId === e.property.propertyId && isActive(s) && !s.observations[s.observations.length - 1]!.isSublease);
      const bestSpace =
        r.comparableMedian === null
          ? undefined
          : liveSpaces.find((s) => {
              const c = compsFor(s);
              return c !== null && c.median === r.comparableMedian && c.confidence === r.confidence;
            });
      drafts.push({
        propertyId: e.property.propertyId, listingId: null, kind: 'radar_candidate', severity: r.score >= t.radarPushScore ? 'high' : 'watch',
        score: r.score, confidence: r.confidence, compBasis: bestSpace ? (compsFor(bestSpace)?.basis ?? null) : null, cellKey: null,
        evidence: {
          address: e.property.addressDisplay, subtype: e.property.subtype, buildingSf: e.property.buildingSf,
          part_dom: r.parts.dom, part_reductions: r.parts.reductions, part_belowMarket: r.parts.belowMarket, part_vacancy: r.parts.vacancy,
          part_buyBoxFit: r.parts.buyBoxFit, part_owner: r.parts.owner, vacancyShare: r.vacancyShare, maxEffectiveDom: r.maxEffectiveDom,
          reductionCount: r.reductionCount, cumulativeReductionPct: r.cumulativeReductionPct, bestGapPct: r.bestGapPct,
          comparableMedian: r.comparableMedian, indicativeRentGapUsd: r.indicativeRentGapUsd, indicativeRentGapLabel: RENT_GAP_LABEL,
          ownerName: e.property.ownerName, ownerType: e.property.ownerType, ownerListingCount: e.ownerListingCount, brokerName: e.brokerName,
          gateFailures: r.gateFailures.join('; '),
        },
      });
    }

    const feed: Array<{ key: string; value: number; basis: string; confidence: string; cellKey: string | null; n: number }> = [];
    for (const p of config.oraProperties) {
      if (p.leaseBasis !== 'NNN') continue;
      const { profile, matchedPropertyId, target } = oraSubject(p, state, p.typicalUnitSf, t);
      if (target === null) continue;
      const partition = candidatesInPartition(state, p.marketId, p.subtype);
      const c = resolveComparables(profile, matchedPropertyId, partition, state.cellFor(target), config.similarityWeights, t);
      if (c.median === null || c.confidence === 'LOW') continue;
      feed.push({ key: p.propertyKey, value: c.median, basis: c.basis, confidence: c.confidence, cellKey: c.cellKey, n: c.n });
    }

    db.prepare('DELETE FROM lm_signal').run();
    const insertSignal = db.prepare(
      `INSERT INTO lm_signal (property_id, listing_id, kind, severity, score, confidence, comp_basis, cell_key, computed_at, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of drafts) {
      insertSignal.run(d.propertyId, d.listingId, d.kind, d.severity, d.score, d.confidence, d.compBasis, d.cellKey, asOf, JSON.stringify(d.evidence));
    }
    db.prepare('DELETE FROM lm_market_rent_feed').run();
    const insertFeed = db.prepare(
      `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, comp_basis, confidence, cell_key, n, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of feed) insertFeed.run(f.key, f.value, f.basis, f.confidence, f.cellKey, f.n, asOf);

    const byKind: Record<string, number> = {};
    for (const d of drafts) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    // withheldCandidateMarkets reads lm_landing only, so computing it here (inside the same immediate
    // transaction as everything above) is redundant for correctness but keeps the whole result — and
    // every read it's built from — inside one atomic, consistent snapshot.
    return { signals: drafts.length, byKind, radarCandidates: radar.length, feedRows: feed.length, withheldMarkets: withheldCandidateMarkets(db, config).map((w) => w.marketId) };
  };
  return db.transaction(body).immediate();
}

// ── Read models ────────────────────────────────────────────────────────────────
export function marketFreshness(db: WarehouseDb, config: LeaseMarketConfig, asOf: string): MarketFreshness[] {
  const latestStmt = db.prepare(
    `SELECT observed_at, completeness, partial_reason FROM lm_landing
     WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok' ORDER BY observed_at DESC, id DESC LIMIT 1`,
  );
  return config.markets.map((m) => {
    const last = latestStmt.get(m.id) as { observed_at: string; completeness: 'complete' | 'partial'; partial_reason: string | null } | undefined;
    const complete = latestCompleteLanding(db, m.id);
    const stale = !complete || daysBetween(complete.observed_at, asOf) > config.thresholds.freshnessDays || last?.completeness === 'partial';
    return {
      marketId: m.id, label: m.label, enabled: m.enabled, lastLandingDate: last?.observed_at ?? null, lastCompleteDate: complete?.observed_at ?? null,
      lastCompleteness: last?.completeness ?? null, partialReason: last?.partial_reason ?? null, stale,
    };
  });
}

export function marketDataQuality(db: WarehouseDb, config: LeaseMarketConfig, state: MarketState): MarketDataQuality[] {
  const lastStmt = db.prepare(
    `SELECT row_count, skipped_count FROM lm_landing WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok' ORDER BY observed_at DESC, id DESC LIMIT 1`,
  );
  return config.markets.map((m) => {
    const active = state.spaces.filter((s) => s.marketId === m.id && isActive(s));
    const last = lastStmt.get(m.id) as { row_count: number; skipped_count: number } | undefined;
    const n = active.length;
    const share = (count: number) => (n === 0 ? 0 : count / n);
    return {
      marketId: m.id,
      activeSpaces: n,
      lastExportRows: last?.row_count ?? 0,
      lastExportSkipped: last?.skipped_count ?? 0,
      quotedShare: share(active.filter((s) => s.latestEligible).length),
      coordsShare: share(active.filter((s) => s.property.lat !== null && s.property.lon !== null).length),
      lowConfidenceShare: share(active.filter((s) => s.latestConfidence === 'low').length),
      rejectedRents: active.filter((s) => s.latestRejected).length,
    };
  });
}

const DOM_BINS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '0-90d', min: 0, max: 90 },
  { label: '90-180d', min: 90, max: 180 },
  { label: '180-365d', min: 180, max: 365 },
  { label: '365d+', min: 365, max: Number.POSITIVE_INFINITY },
];

export function domBins(state: MarketState, asOf: string): Array<{ marketId: string; bins: DomBin[] }> {
  const byMarket = new Map<string, number[]>();
  for (const s of state.spaces) {
    if (!isActive(s) || s.isOraOwned || s.originTier !== 'T1') continue;
    const list = byMarket.get(s.marketId) ?? [];
    list.push(effectiveDom(s, asOf));
    byMarket.set(s.marketId, list);
  }
  return [...byMarket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([marketId, doms]) => ({ marketId, bins: DOM_BINS.map((b) => ({ label: b.label, count: doms.filter((d) => d >= b.min && d < b.max).length })) }));
}

// excludeOra (fix round 2, requirement 6): the KPI counts are a read on MARKET activity — ORA's own
// listing surfacing in the same CoStar export is not a market signal and must not inflate them.
function countLatestEvents(db: WarehouseDb, config: LeaseMarketConfig, kind: ListingEventKind, excludeOra: boolean): number {
  const ids = [...latestExportLandingIds(db, config).values()].flatMap((s) => [...s]);
  if (ids.length === 0) return 0;
  const oraFilter = excludeOra ? 'AND p.ora_property_key IS NULL' : '';
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM lm_listing_event e JOIN lm_listing l ON l.id = e.listing_id JOIN lm_property p ON p.id = l.property_id
         WHERE e.kind = ? AND e.landing_id IN (${ids.map(() => '?').join(',')}) ${oraFilter}`,
      )
      .get(kind, ...ids) as { n: number }
  ).n;
}

export function leaseMarketKpis(db: WarehouseDb, config: LeaseMarketConfig, state: MarketState, asOf: string): LeaseMarketKpis {
  const fresh = marketFreshness(db, config, asOf);
  const signalCount = (kind: string) => (db.prepare('SELECT COUNT(*) AS n FROM lm_signal WHERE kind = ?').get(kind) as { n: number }).n;
  return {
    marketsFresh: fresh.filter((f) => f.enabled && !f.stale).length,
    marketsEnabled: config.markets.filter((m) => m.enabled).length,
    // activeSpaces intentionally INCLUDES ORA's own active spaces (fix round 2, requirement 6) — it's an
    // inventory count of everything currently tracked, not a market-activity signal like the two below.
    activeSpaces: state.spaces.filter(isActive).length,
    // newInLatest/priceCutsInLatest EXCLUDE ORA's own events (excludeOra: true below) — the opposite of
    // latestExportEvents, which deliberately includes them (see its own JSDoc). Fix round 2, requirement 6.
    newInLatest: countLatestEvents(db, config, 'new', true),
    priceCutsInLatest: countLatestEvents(db, config, 'price_cut', true),
    stale: signalCount('stale'),
    radarCandidates: signalCount('radar_candidate'),
  };
}

// Fix round 2, requirement 6: intentionally INCLUDES ORA's own listing events. This is the full audit
// trail of everything that changed in "the latest export" window (see latestExportLandingIds), for an
// operator who wants to see the complete picture including ORA's own listings — unlike
// leaseMarketKpis' newInLatest/priceCutsInLatest below, which are a MARKET-ACTIVITY signal and
// deliberately exclude ORA's own events via countLatestEvents(..., excludeOra: true).
export function latestExportEvents(db: WarehouseDb, config: LeaseMarketConfig): ListingEventRow[] {
  const ids = [...latestExportLandingIds(db, config).values()].flatMap((s) => [...s]);
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT e.id, e.listing_id, l.property_id, p.market_id, p.address_display, l.suite_norm, e.kind, e.event_date, e.prev_value, e.new_value
       FROM lm_listing_event e JOIN lm_listing l ON l.id = e.listing_id JOIN lm_property p ON p.id = l.property_id
       WHERE e.landing_id IN (${ids.map(() => '?').join(',')}) ORDER BY p.market_id, e.kind, e.id`,
    )
    .all(...ids) as Array<{ id: number; listing_id: number; property_id: number; market_id: string; address_display: string; suite_norm: string; kind: ListingEventKind; event_date: string; prev_value: number | null; new_value: number | null }>;
  return rows.map((r) => ({
    id: r.id, listingId: r.listing_id, propertyId: r.property_id, marketId: r.market_id,
    address: r.suite_norm ? `${r.address_display} Ste ${r.suite_norm}` : r.address_display,
    kind: r.kind, eventDate: r.event_date, prevValue: r.prev_value, newValue: r.new_value,
  }));
}
