// server/warehouse/lease-market/positioning.ts
//
// Lease Market Intelligence — Oxford Rent Position and listing hygiene (spec rev 3 §3.9, cross-exam A7/A8).
// Pure over MarketState; the API supplies vacant units from the live rent-roll snapshot.
import type { CompRow, LeaseMarketConfig, ListedButLeased, PositioningRow } from '../../../src/contracts/lease-market';
import { normalizeSuite } from '../../../src/analytics/lease-market/normalize';
import { midRankPercentile } from '../../../src/analytics/lease-market/benchmarks';
import { resolveComparables, type ResolvedComparables } from '../../../src/analytics/lease-market/similarity';
import { effectiveDom } from '../../../src/analytics/lease-market/signals';
import { isActive, oraSubject, type MarketState, type SpaceState } from './compute';

export interface VacantUnit {
  propertyKey: string;
  unit: string | null;
  sf: number;
}

const money = (v: number | null) => (v === null ? '—' : `$${v.toFixed(2)}`);

export function recommendationFor(input: { asking: number | null; stats: ResolvedComparables | null; bandPct: number }): string {
  const s = input.stats;
  if (!s || s.median === null) return 'No comparable asking rents yet for this size and type.';
  const range = `${money(s.p25)}–${money(s.p75)}`;
  if (input.asking === null) return `No ORA asking rent found in CoStar — confirm the unit is being marketed. Comparable range ${range}.`;
  const gap = (input.asking - s.median) / s.median;
  const pct = Math.round(Math.abs(gap) * 100);
  const sentence =
    gap > input.bandPct
      ? `Asking is ${pct}% above the comparable median (${money(s.median)}); comparable range ${range}.`
      : gap < -input.bandPct
        ? `Asking is ${pct}% below the comparable median (${money(s.median)}); room to move toward ${money(s.p25)}–${money(s.median)}.`
        : `Within the comparable range (${range}).`;
  return s.confidence === 'LOW' ? `Thin comparable set (n=${s.n}) — indicative only. ${sentence}` : sentence;
}

export function computePositioning(
  units: readonly VacantUnit[],
  config: LeaseMarketConfig,
  state: MarketState,
  rowLevel: boolean,
): { rows: PositioningRow[]; unconfiguredPropertyKeys: string[]; listedButLeased: ListedButLeased[] } {
  const t = config.thresholds;
  const props = new Map(config.oraProperties.map((p) => [p.propertyKey, p]));
  const oraSpaces = new Map<string, SpaceState[]>();
  for (const s of state.spaces) {
    const key = s.property.oraPropertyKey;
    if (key === null || !isActive(s) || !props.has(key)) continue;
    const list = oraSpaces.get(key) ?? [];
    list.push(s);
    oraSpaces.set(key, list);
  }

  const unconfigured = new Set<string>();
  const matchedSpaceIds = new Set<number>();
  const vacantSuites = new Map<string, Set<string>>();
  const rows: PositioningRow[] = [];

  for (const u of units) {
    const p = props.get(u.propertyKey);
    if (!p) {
      unconfigured.add(u.propertyKey);
      continue;
    }
    const suite = normalizeSuite(u.unit);
    const suites = vacantSuites.get(p.propertyKey) ?? new Set<string>();
    suites.add(suite);
    vacantSuites.set(p.propertyKey, suites);

    const sf = u.sf > 0 ? u.sf : p.typicalUnitSf;
    const { profile, matchedPropertyId, target } = oraSubject(p, state, sf, t);
    const stats = target
      ? resolveComparables(profile, matchedPropertyId, state.candidates, state.cellFor(target), config.similarityWeights, t)
      : null;

    const candidates = oraSpaces.get(p.propertyKey) ?? [];
    const match = (suite !== '' ? candidates.find((s) => s.suiteNorm === suite) : undefined) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (match) matchedSpaceIds.add(match.listingId);
    const asking = match ? (match.observations[match.observations.length - 1]!.askingNnnEq ?? null) : null;

    const percentile = asking !== null && stats && stats.values.length > 0 ? midRankPercentile(asking, stats.values) : null;
    const gapPct = asking !== null && stats && stats.median !== null && stats.median > 0 ? (asking - stats.median) / stats.median : null;
    const band: PositioningRow['band'] =
      gapPct === null ? 'unknown' : gapPct > t.positioningBandPct ? 'above' : gapPct < -t.positioningBandPct ? 'below' : 'in_band';
    const comps: CompRow[] = (stats?.comps ?? []).slice(0, 15).map((c) => ({
      listingId: c.candidate.listingId,
      propertyId: c.candidate.propertyId,
      address: rowLevel ? c.candidate.addressDisplay : null,
      availableSf: c.candidate.availableSf,
      askingNnnEq: c.candidate.askingNnnEq,
      score: Math.round(c.similarity.score),
      distanceMi: c.similarity.distanceMi === null ? null : Math.round(c.similarity.distanceMi * 10) / 10,
    }));

    rows.push({
      propertyKey: u.propertyKey,
      unit: u.unit,
      sf: u.sf,
      oraListingId: match?.listingId ?? null,
      oraAskingNnnEq: asking,
      stats: stats
        ? { basis: stats.basis, n: stats.n, low: stats.low, p25: stats.p25, median: stats.median, p75: stats.p75, high: stats.high, confidence: stats.confidence, cellKey: stats.cellKey }
        : null,
      comps,
      percentile,
      gapPct,
      band,
      recommendation: recommendationFor({ asking, stats, bandPct: t.positioningBandPct }),
      flags: match ? [] : ['not_listed'],
      effectiveDom: match ? effectiveDom(match, state.asOf) : null,
      brokerName: rowLevel ? (match?.brokerName ?? null) : null,
      listingUrl: rowLevel ? (match?.listingUrl ?? null) : null,
      dateListed: match ? (match.costarDateOnMarket ?? match.firstSeen) : null,
    });
  }

  const listedButLeased: ListedButLeased[] = [];
  for (const [key, spaces] of oraSpaces) {
    const vacant = vacantSuites.get(key) ?? new Set<string>();
    for (const s of spaces) {
      if (matchedSpaceIds.has(s.listingId) || vacant.has(s.suiteNorm)) continue;
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

  return { rows, unconfiguredPropertyKeys: [...unconfigured].sort(), listedButLeased };
}
