import type { WarehouseDb } from './db';
import { getMacro } from '../macro/getMacro';
import type { MacroIndicator, MacroSnapshot } from '../../src/contracts/macro';
import type { MarketSignal, MarketAction, MarketSourceTag } from '../../src/contracts/capital';
import type { Confidence } from '../../src/contracts/common';
import { DAY_MS } from './time-constants';

// ── Scoring ───────────────────────────────────────────────────────────────────

function fredScore(indicators: MacroIndicator[]): number | null {
  const dgs5 = indicators.find(i => i.id === 'DGS5')?.value ?? null;
  const cpi  = indicators.find(i => i.id === 'CPIAUCSL')?.value ?? null;
  if (dgs5 === null && cpi === null) return null;
  let score = 50;
  if (dgs5 !== null) score += Math.max(-25, Math.min(25, (5.0 - dgs5) * 12.5));
  if (cpi  !== null) score += Math.max(-10, Math.min(10, (2.0 - Math.abs(cpi - 3.0)) * 5));
  return Math.max(0, Math.min(100, score));
}

function compsScore(capRatePct: number | null): number | null {
  if (capRatePct === null) return null;
  const cr = capRatePct;
  const raw = cr <= 5.0
    ? 60 - (5.0 - cr) * 15
    : cr <= 7.0
    ? 60 + (cr - 5.0) * 15
    : Math.max(0, 90 - (cr - 7.0) * 20);
  return Math.max(0, Math.min(100, raw));
}

// ── Staleness ─────────────────────────────────────────────────────────────────

export const STALE_DAYS: Record<string, number> = { 'census-acs': 400, 'comps-ai': 90 };

/** The one metric census-acs rows carry: ACS RESIDENTIAL housing vacancy, displayed, never scored. */
export const CENSUS_HOUSING_METRIC = 'housing_vacancy_rate';

function daysBetween(isoA: string, isoB: string): number {
  return Math.abs(new Date(isoB).getTime() - new Date(isoA).getTime()) / DAY_MS;
}

// ── Action ────────────────────────────────────────────────────────────────────

function resolveAction(score: number | null, oraCount: number): MarketAction {
  if (score === null)                     return 'maintain';
  if (score >= 75 && oraCount === 0)      return 'enter';
  if (score >= 65 && oraCount < 3)        return 'expand';
  if (score >= 45)                        return 'maintain';
  return 'exit';
}

// ── Public API ─────────────────────────────────────────────────────────────────

interface MarketSeriesRow {
  cluster: string; as_of: string; source: string; metric: string; value: number | null; confidence: number;
}

export async function buildMarketIntel(
  db: WarehouseDb,
  cluster: string,
  asOf: string,
  macroSnapshot?: MacroSnapshot,
): Promise<MarketSignal> {
  const macro = macroSnapshot ?? await getMacro();

  const seriesRows = db.prepare(
    'SELECT cluster, as_of, source, metric, value, confidence FROM market_series WHERE cluster = ? ORDER BY as_of DESC',
  ).all(cluster) as MarketSeriesRow[];

  const oraCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM property_master WHERE market = ?').get(cluster) as { cnt: number } | undefined
  )?.cnt ?? 0;

  // ── FRED source ─────────────────────────────────────────────────────────
  // Never graded stale: getMacro() always returns rates, live or the seeded June-2026 snapshot. A
  // seeded input is named in `reasons` below instead, so a score on stale rates is labelled
  // (2026-11-23 review), without changing the composite.
  const fScore = fredScore(macro.indicators);
  const fredSrc = {
    source: 'fred' as MarketSourceTag,
    metric: 'composite-fred',
    value: macro.indicators.find(i => i.id === 'DGS5')?.value ?? null,
    confidence01: fScore !== null ? 1.0 : 0,
    asOf: macro.asOf,
    stale: false,
    score: fScore,
    weight: 0.5,
  };

  // ── Census ACS source: RESIDENTIAL context, never scored ─────────────────
  // ACS B25002/B25004 counts HOUSING units, so its vacancy says nothing about industrial space
  // (2026-11-27 review, Gabriel): it is displayed under metric housing_vacancy_rate with confidence 0
  // and is NOT in the composite below. Only rows under that metric are read; a legacy `vacancy_rate`
  // census row (pre-migration 038) is ignored rather than shown under the residential label.
  const censusRows = seriesRows.filter(r => r.source === 'census-acs' && r.metric === CENSUS_HOUSING_METRIC);
  const latestCensus = censusRows[0] as MarketSeriesRow | undefined;
  const censusStale = !latestCensus || daysBetween(latestCensus.as_of, asOf) > STALE_DAYS['census-acs']!;
  const censusSrc = {
    source: 'census-acs' as MarketSourceTag,
    metric: CENSUS_HOUSING_METRIC,
    value: latestCensus?.value ?? null,
    confidence01: 0,
    asOf: latestCensus?.as_of ?? asOf,
    stale: censusStale,
  };

  // ── Comps-AI source ──────────────────────────────────────────────────────
  const compsRows = seriesRows.filter(r => r.source === 'comps-ai');
  const latestComps = compsRows[0] as MarketSeriesRow | undefined;
  const compsStale = !latestComps || daysBetween(latestComps.as_of, asOf) > STALE_DAYS['comps-ai']!;
  const compsVal = compsStale ? null : (latestComps?.metric === 'cap_rate' ? latestComps.value : null);
  const compScore = compsScore(compsVal);
  const compsSrc = {
    source: 'comps-ai' as MarketSourceTag,
    metric: 'cap_rate',
    value: latestComps?.value ?? null,
    confidence01: compScore !== null && !compsStale ? 1.0 : 0,
    asOf: latestComps?.as_of ?? asOf,
    stale: compsStale,
    score: compsStale ? null : compScore,
    weight: 0.2,
  };

  // ── Composite (industrial inputs only: census housing vacancy is excluded) ─
  // Weights are NOT renormalized to fill census's old 0.3: confidence01 tops out at 0.7 (FRED + comps)
  // because no industrial vacancy input exists. The score itself is a weighted mean over active sources
  // (FRED + comps: comps carries 0.2/0.7 = 2/7 of it).
  const scoredSrcs = [fredSrc, compsSrc];
  const active = scoredSrcs.filter(s => !s.stale && s.score !== null);

  let marketScore: number | null = null;
  let confidence01 = 0;

  if (active.length > 0) {
    const totalW = active.reduce((s, x) => s + x.weight, 0);
    marketScore = active.reduce((s, x) => s + x.score! * x.weight, 0) / totalW;
    confidence01 = Math.min(1, active.reduce((s, x) => s + x.weight, 0));
    marketScore = Math.round(marketScore * 10) / 10;
  }

  const action = resolveAction(marketScore, oraCount);
  const confidenceTier: Confidence = confidence01 >= 0.8 ? 'confirmed' : confidence01 >= 0.5 ? 'estimated' : 'derived';

  const reasons: string[] = [];
  if (marketScore !== null) reasons.push(`Market score ${marketScore}/100`);
  if (marketScore === null) reasons.push('Insufficient data — defaulting to maintain');
  if (latestCensus && latestCensus.value !== null && !censusStale) {
    reasons.push(`Census ACS housing vacancy ${latestCensus.value}% is residential context only, not scored`);
  }
  if (censusStale && latestCensus) reasons.push('Census ACS housing vacancy stale (>400d); residential, not scored');
  if (compsStale && latestComps)   reasons.push('Comps data stale (>90d)');
  if (macro.source === 'mock' || macro.source === 'seed') {
    reasons.push(`FRED rates are the seeded snapshot (as of ${macro.asOf}), not a live fetch`);
  }
  reasons.push(`ORA properties in cluster: ${oraCount}`);

  return {
    cluster,
    asOf,
    marketScore,
    action,
    confidence01,
    confidenceTier,
    advisoryOnly: true,
    oraPropertyCount: oraCount,
    sources: [fredSrc, censusSrc, compsSrc].map(s => ({
      source: s.source,
      metric: s.metric,
      value: s.value,
      confidence01: s.confidence01,
      asOf: s.asOf,
      stale: s.stale,
    })),
    reasons,
    dataQuality: [],
  };
}
