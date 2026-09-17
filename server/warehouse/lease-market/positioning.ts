// server/warehouse/lease-market/positioning.ts
//
// Lease Market Intelligence — Oxford Rent Position and listing hygiene (spec rev 3 §3.9, cross-exam A7/A8).
// Pure over MarketState; the API supplies vacant units from the live rent-roll snapshot. Every active,
// config-mapped ORA listing also produces its own row (source: 'listing'), priced off its own asking
// rent, so Rent Position never depends on the rent roll actually recording vacancies (go-live change,
// 2026-09-17 — see PositioningRow.source's contract doc comment).
import type { CompRow, LeaseMarketConfig, ListedButLeased, ListingHygieneFlag, PositioningRow } from '../../../src/contracts/lease-market';
import { normalizeSuite } from '../../../src/analytics/lease-market/normalize';
import { midRankPercentile } from '../../../src/analytics/lease-market/benchmarks';
import { resolveComparables, type ResolvedComparables } from '../../../src/analytics/lease-market/similarity';
import { effectiveDom } from '../../../src/analytics/lease-market/signals';
import { comparablesForOraSpace, isActive, matchesOraOwnerName, oraSubject, type MarketState, type SpaceState } from './compute';

export interface VacantUnit {
  propertyKey: string;
  unit: string | null;
  sf: number;
}

const money = (v: number | null) => (v === null ? '—' : `$${v.toFixed(2)}`);

// I-2: strips a leading R9 building designator ("B1-", "B2-", ...) from a CoStar-side suiteNorm, for
// the building-stripped match step below. Returns null when suiteNorm carries no building prefix at
// all — a bare suite ("A") must never be treated as if stripping it produced itself, or step 2 would
// just re-run the exact-match step 1 and call it a "building-stripped" match.
function stripBuildingPrefix(suiteNorm: string): string | null {
  const stripped = suiteNorm.replace(/^B[0-9A-Z]+-/, '');
  return stripped === suiteNorm ? null : stripped;
}

// Rounds a fractional gap to 9 decimal places so a nominally-exact ratio (e.g. 7.70/7.00 - 1 = 0.10)
// that floating-point division turns into 0.10000000000000003 doesn't spuriously cross a band edge.
function roundedGap(asking: number, median: number): number {
  return Math.round(((asking - median) / median) * 1e9) / 1e9;
}

// Prints the gap as a whole percent, EXCEPT when that rounded whole number equals the band
// threshold itself — printing plain "10%" for a 10.4% gap that is (correctly) outside a 10% band
// would read as a contradiction ("10%" looks like the boundary, not past it), so that one case gets
// one decimal of precision instead.
function percentText(gap: number, bandPct: number): string {
  const pctAbs = Math.abs(gap) * 100;
  const roundedInt = Math.round(pctAbs);
  const thresholdPct = Math.round(bandPct * 100);
  return roundedInt === thresholdPct ? `${pctAbs.toFixed(1)}%` : `${roundedInt}%`;
}

// Shared by both row-building loops below (rent-roll-driven and listing-driven) so the comp-row shape
// and its rowLevel redaction stay in one place.
function compRowsFor(stats: ResolvedComparables | null, rowLevel: boolean): CompRow[] {
  return (stats?.comps ?? []).slice(0, 15).map((c) => ({
    listingId: c.candidate.listingId,
    propertyId: c.candidate.propertyId,
    address: rowLevel ? c.candidate.addressDisplay : null,
    availableSf: c.candidate.availableSf,
    askingNnnEq: c.candidate.askingNnnEq,
    score: Math.round(c.similarity.score),
    distanceMi: c.similarity.distanceMi === null ? null : Math.round(c.similarity.distanceMi * 10) / 10,
  }));
}

function bandFor(gapPct: number | null, bandPct: number): PositioningRow['band'] {
  return gapPct === null ? 'unknown' : gapPct > bandPct ? 'above' : gapPct < -bandPct ? 'below' : 'in_band';
}

export function recommendationFor(input: { asking: number | null; matched: boolean; stats: ResolvedComparables | null; bandPct: number }): string {
  const s = input.stats;
  if (!s || s.median === null) return 'No comparable asking rents yet for this size and type.';
  const range = `${money(s.p25)}–${money(s.p75)}`;
  if (input.asking === null) {
    return input.matched
      ? `ORA listing found in CoStar but its asking rent is withheld or not normalizable. Comparable range ${range}.`
      : `No ORA asking rent found in CoStar — confirm the unit is being marketed. Comparable range ${range}.`;
  }
  // Guarded consistently with gapPct in computePositioning: a non-positive median can't support a
  // reliable directional gap, so fall straight to the neutral "within range" wording.
  const gap = s.median > 0 ? roundedGap(input.asking, s.median) : 0;
  const sentence =
    gap > input.bandPct
      ? `Asking is ${percentText(gap, input.bandPct)} above the comparable median (${money(s.median)}); comparable range ${range}.`
      : gap < -input.bandPct
        ? `Asking is ${percentText(gap, input.bandPct)} below the comparable median (${money(s.median)}); room to move toward ${money(s.p25)}–${money(s.median)}.`
        : `Within the comparable range (${range}).`;
  return s.confidence === 'LOW' ? `Thin comparable set (n=${s.n}) — indicative only. ${sentence}` : sentence;
}

export function computePositioning(
  units: readonly VacantUnit[],
  config: LeaseMarketConfig,
  state: MarketState,
  rowLevel: boolean,
): { rows: PositioningRow[]; unconfiguredPropertyKeys: string[]; listedButLeased: ListedButLeased[]; hygieneFlags: ListingHygieneFlag[] } {
  const t = config.thresholds;
  const props = new Map(config.oraProperties.map((p) => [p.propertyKey, p]));

  // ORA spaces per property key, scoped to the market the config declares for that key. Ingest
  // (server/warehouse/lease-market/ingest.ts) already scopes its own address match to the SAME
  // market (`p.addressNorms.includes(addressNorm) && p.marketId === marketId`), so a current ingest
  // run cannot itself produce a cross-market oraPropertyKey — but this is still a defensive
  // re-check, not a dead one: legacy/manually-edited rows (a pre-market-scoping ingest, or a manual
  // correction to lm_property.ora_property_key) can carry a stale cross-market key that today's
  // ingest logic would never produce, and that must never enter matching here. Sorted by listingId
  // ascending so an exact-suite tie across multiple buildings sharing one key (a legitimate
  // multi-building portfolio under one ORA key) resolves deterministically to the lowest listingId.
  const oraSpaces = new Map<string, SpaceState[]>();
  for (const s of state.spaces) {
    const key = s.property.oraPropertyKey;
    if (key === null || !isActive(s)) continue;
    const p = props.get(key);
    if (!p || p.marketId !== s.marketId) continue;
    const list = oraSpaces.get(key) ?? [];
    list.push(s);
    oraSpaces.set(key, list);
  }
  for (const list of oraSpaces.values()) list.sort((a, b) => a.listingId - b.listingId);

  const unconfigured = new Set<string>();
  const unitSuite: string[] = units.map((u) => normalizeSuite(u.unit));
  const unitPropertyIndices = new Map<string, number[]>();
  units.forEach((u, i) => {
    if (!props.has(u.propertyKey)) {
      unconfigured.add(u.propertyKey);
      return;
    }
    const list = unitPropertyIndices.get(u.propertyKey) ?? [];
    list.push(i);
    unitPropertyIndices.set(u.propertyKey, list);
  });

  // Exact-suite matches are resolved first, across every unit of a property, before any fallback —
  // so a fallback can never steal a space another unit of the same property matches exactly.
  const unitMatch: Array<SpaceState | undefined> = new Array(units.length).fill(undefined);
  for (const [key, indices] of unitPropertyIndices) {
    // M1: a tenant subletting ORA's own space is a tenant-exit signal, not space ORA itself is
    // marketing — it must never satisfy a vacant rent-roll unit's match (exact-suite, building-stripped,
    // or the only-space fallback below), or a real vacancy would silently price against a sublease
    // instead of getting the 'not_listed' signal it should. Excluded from the candidate pool up front so
    // every match step below (and the only-space-count check) sees the space as if it weren't there.
    const candidates = (oraSpaces.get(key) ?? []).filter((s) => !s.observations[s.observations.length - 1]!.isSublease);
    const assigned = new Set<number>();
    for (const i of indices) {
      const suite = unitSuite[i]!;
      if (suite === '') continue;
      const match = candidates.find((s) => s.suiteNorm === suite);
      if (match) {
        unitMatch[i] = match;
        assigned.add(match.listingId);
      }
    }
    // I-2: building-stripped comparison. R9's building-designator normalization means a CoStar suite
    // in a multi-building complex reads "B1-A", while the rent roll (which doesn't track buildings)
    // just says "A" — the exact match above can never see them as the same space. Only a candidate
    // whose suiteNorm actually CARRIES a building prefix is eligible here (stripBuildingPrefix returns
    // null otherwise), so this step can never re-match a plain suite that step 1 already ruled out.
    // Tie rule (deterministic, matches the exact-match tie-break elsewhere in this file): when more
    // than one building's stripped suite matches the same unit (e.g. "B1-A" and "B2-A" both strip to
    // "A"), the lowest listingId wins, and units are resolved in their given order so one candidate can
    // never satisfy two different units.
    for (const i of indices) {
      if (unitMatch[i]) continue;
      const suite = unitSuite[i]!;
      if (suite === '') continue;
      const match = candidates
        .filter((s) => !assigned.has(s.listingId) && stripBuildingPrefix(s.suiteNorm) === suite)
        .sort((a, b) => a.listingId - b.listingId)[0];
      if (match) {
        unitMatch[i] = match;
        assigned.add(match.listingId);
      }
    }
    // The "only ORA space" fallback applies only when there is exactly one active ORA space for the
    // property AND either the vacant unit's suite or that space's own suite is blank — and only when
    // that space isn't already claimed by an exact match on another unit of the same property.
    if (candidates.length === 1) {
      const only = candidates[0]!;
      for (const i of indices) {
        if (unitMatch[i]) continue;
        const suite = unitSuite[i]!;
        if ((suite === '' || only.suiteNorm === '') && !assigned.has(only.listingId)) {
          unitMatch[i] = only;
          assigned.add(only.listingId);
        }
      }
    }
  }

  const matchedSpaceIds = new Set<number>();
  const vacantSuites = new Map<string, Set<string>>();
  const rows: PositioningRow[] = [];
  const hygieneFlags: ListingHygieneFlag[] = [];

  units.forEach((u, i) => {
    const p = props.get(u.propertyKey);
    if (!p) return; // unconfigured — already recorded above, no row.
    const suite = unitSuite[i]!;
    // A blank vacant-unit suite must never stand in for "matches any blank-suite listing" when
    // computing listedButLeased below — only track genuinely-stated suites there.
    if (suite !== '') {
      const suites = vacantSuites.get(p.propertyKey) ?? new Set<string>();
      suites.add(suite);
      vacantSuites.set(p.propertyKey, suites);
    }

    const usedTypicalSf = !(u.sf > 0);
    const sf = usedTypicalSf ? p.typicalUnitSf : u.sf;
    const { profile, matchedPropertyId, target } = oraSubject(p, state, sf, t);
    const stats = target
      ? resolveComparables(profile, matchedPropertyId, state.candidates, state.cellFor(target), config.similarityWeights, t)
      : null;

    const match = unitMatch[i];
    if (match) matchedSpaceIds.add(match.listingId);
    const asking = match ? match.observations[match.observations.length - 1]!.askingNnnEq : null;

    const percentile = asking !== null && stats && stats.values.length > 0 ? midRankPercentile(asking, stats.values) : null;
    const gapPct = asking !== null && stats && stats.median !== null && stats.median > 0 ? roundedGap(asking, stats.median) : null;
    const band = bandFor(gapPct, t.positioningBandPct);
    const comps = compRowsFor(stats, rowLevel);

    const baseRecommendation = recommendationFor({ asking, matched: match !== undefined, stats, bandPct: t.positioningBandPct });
    const recommendation = usedTypicalSf ? `SF not stated in the rent roll; analysed at ${p.typicalUnitSf} SF. ${baseRecommendation}` : baseRecommendation;

    rows.push({
      propertyKey: u.propertyKey,
      unit: u.unit,
      sf: u.sf,
      oraAskingNnnEq: asking,
      stats: stats
        ? {
            basis: stats.basis, n: stats.n, low: stats.low, p25: stats.p25, median: stats.median, p75: stats.p75, high: stats.high,
            confidence: stats.confidence, cellKey: stats.cellKey, unknown: stats.unknown,
          }
        : null,
      comps,
      percentile,
      gapPct,
      band,
      recommendation,
      flags: match ? [] : ['not_listed'],
      effectiveDom: match ? effectiveDom(match, state.asOf) : null,
      source: 'rent-roll',
    });
  });

  // Gabriel's go-live decision (2026-09-17): the real rent roll carries 138 leases and ZERO vacant
  // rows, so the loop above (driven by rent-roll vacancies) produces nothing on its own, and every
  // ORA-owned listing would otherwise fall into "listed in CoStar but not vacant in the rent roll" —
  // inverting the feature, since those six listings ARE the space ORA is marketing. Every active,
  // config-mapped ORA listing NOT already claimed by a matched rent-roll vacant above gets its own
  // row here, sourced 'listing' and priced against comparables using ITS OWN asking rent (never the
  // property's, so two listings sharing one propertyKey with different lease bases — e.g. one NNN,
  // one MG — each convert to NNN-equivalent independently; see comparablesForSpace/priceObservation).
  // rowSpaceIds tracks every listingId that now has a row (either source) so listedButLeased below
  // can never re-report one of them.
  const rowSpaceIds = new Set(matchedSpaceIds);
  // H2: flags at most once per matched lm_property row (a key like 'Zettler' can span more than one
  // addressNorm/property row) when config.subtype disagrees with what CoStar itself reports for that
  // building — Gabriel should see that CoStar classifies a building differently than ORA's own config
  // does, even though comparablesForOraSpace below now makes the config's classification win either way.
  const flaggedSubtypeMismatch = new Set<number>();
  for (const [key, spaces] of oraSpaces) {
    const p = props.get(key)!;
    for (const space of spaces) {
      if (rowSpaceIds.has(space.listingId)) continue;
      rowSpaceIds.add(space.listingId);

      if (!flaggedSubtypeMismatch.has(space.propertyId) && space.property.subtype !== p.subtype) {
        flaggedSubtypeMismatch.add(space.propertyId);
        hygieneFlags.push({
          listingId: space.listingId,
          marketId: space.marketId,
          address: rowLevel ? space.property.addressDisplay : null,
          reason: `CoStar classifies this building as subtype '${space.property.subtype}' but config.oraProperties maps it as '${p.subtype}' — verify which is correct`,
        });
      }

      const latest = space.observations[space.observations.length - 1]!;

      // M1: a tenant subletting ORA's own space is a tenant-exit signal, not space ORA is marketing —
      // it must never become a positioning row (which would otherwise read "ORA listing found in CoStar
      // but its asking rent is withheld", implying ORA itself withheld an ask it never quoted). Routed
      // to the hygiene surface instead; rowSpaceIds already marks it covered so the defensive
      // listedButLeased loop below never re-reports it either.
      if (latest.isSublease) {
        hygieneFlags.push({
          listingId: space.listingId,
          marketId: space.marketId,
          address: rowLevel ? space.addressDisplay : null,
          reason: 'tenant sublease — a tenant is subletting this ORA-owned space (a tenant-exit signal), not ORA\'s own asking rent',
        });
        continue;
      }

      const stats = comparablesForOraSpace(state, space, p, config);
      const asking = latest.askingNnnEq;
      const percentile = asking !== null && stats && stats.values.length > 0 ? midRankPercentile(asking, stats.values) : null;
      const gapPct = asking !== null && stats && stats.median !== null && stats.median > 0 ? roundedGap(asking, stats.median) : null;
      const band = bandFor(gapPct, t.positioningBandPct);
      const comps = compRowsFor(stats, rowLevel);

      rows.push({
        propertyKey: key,
        unit: space.suiteNorm !== '' ? space.suiteNorm : null,
        // SF is the listing's own reported available SF — never a rent-roll figure, since no rent-roll
        // unit claimed this space.
        sf: latest.availableSf,
        // Rule 5: a matched (source: 'listing') space with no normalizable asking rent (e.g. a sublet
        // quoted "Negotiable") still gets a row — asking stays null, never fabricated, and
        // recommendationFor's `matched: true` branch says the rent is withheld/not normalizable rather
        // than computing a gap from nothing.
        oraAskingNnnEq: asking,
        stats: stats
          ? {
              basis: stats.basis, n: stats.n, low: stats.low, p25: stats.p25, median: stats.median, p75: stats.p75, high: stats.high,
              confidence: stats.confidence, cellKey: stats.cellKey, unknown: stats.unknown,
            }
          : null,
        comps,
        percentile,
        gapPct,
        band,
        recommendation: recommendationFor({ asking, matched: true, stats, bandPct: t.positioningBandPct }),
        flags: [],
        effectiveDom: effectiveDom(space, state.asOf),
        source: 'listing',
      });
    }
  }

  // Kept as a defensive surface, not a dead one: every active, config-mapped ORA listing is now
  // covered above (either a matched rent-roll row or its own listing row), so this should be empty in
  // ordinary operation. It stays in case a future change reintroduces a gap in that coverage.
  const listedButLeased: ListedButLeased[] = [];
  for (const [key, spaces] of oraSpaces) {
    const vacant = vacantSuites.get(key) ?? new Set<string>();
    for (const s of spaces) {
      if (rowSpaceIds.has(s.listingId) || vacant.has(s.suiteNorm)) continue;
      listedButLeased.push({
        propertyKey: key,
        listingId: s.listingId,
        suite: s.suiteNorm,
        askingNnnEq: s.observations[s.observations.length - 1]!.askingNnnEq,
        effectiveDom: effectiveDom(s, state.asOf),
        address: rowLevel ? s.addressDisplay : null,
      });
    }
  }

  // Deferred R2 / M2: a listing whose owner screens as ORA-self (compute.ts isOraOwnedProperty's
  // `ownerType === 'affiliated'` branch) — OR whose owner name matches config.oraOwnerNamePatterns,
  // screen-independently (M2: the screen can be unavailable, leaving owner_type stuck at 'unknown'
  // forever) — is excluded from comps/benchmarks/radar everywhere, but when its address isn't in
  // config.oraProperties.addressNorms it has no oraPropertyKey and so can never become a PositioningRow
  // or a listedButLeased entry (both keyed off configured oraProperties) — without its own surface, it's
  // an ORA-owned listing with no hygiene visibility at all. state.spaces is already ordered by listing id
  // (loadMarketState's `ORDER BY l.id`), so this list is deterministic.
  for (const s of state.spaces) {
    if (!isActive(s)) continue;
    if (s.property.oraPropertyKey !== null) continue;
    if (s.property.ownerType === 'affiliated' || matchesOraOwnerName(s.property.ownerName, config.oraOwnerNamePatterns)) {
      hygieneFlags.push({
        listingId: s.listingId,
        marketId: s.marketId,
        address: rowLevel ? s.addressDisplay : null,
        reason: 'CoStar shows an ORA-owned listing at an address that is not mapped — add it to oraProperties',
      });
    }
  }

  return { rows, unconfiguredPropertyKeys: [...unconfigured].sort(), listedButLeased, hygieneFlags };
}
