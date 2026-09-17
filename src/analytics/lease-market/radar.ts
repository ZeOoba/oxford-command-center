// src/analytics/lease-market/radar.ts
//
// Lease Market Intelligence — Acquisition Radar (spec rev 3 §3.8, cross-exam A9). Pure; no I/O.
// Hard gates decide eligibility; a transparent 100-point score ranks. Every part is returned so the
// dashboard can show exactly why a property surfaced. indicativeRentGapUsd is gross, vacant space only —
// NOT NOI (cross-exam R5). Refute pass required.
import type { BuildingStatus, ConfidenceLabel, LmSubtype, LmThresholds, OwnerType, RadarScoreParts } from '../../contracts/lease-market';

export interface RadarSpaceInput {
  listingId: number;
  availableSf: number;
  isSublease: boolean;
  effectiveDom: number;
  reductionCount: number;
  cumulativeReductionPct: number | null;
  askingNnnEq: number | null;
  eligible: boolean;
  comparableMedian: number | null;
  comparableConfidence: ConfidenceLabel;
}

export interface RadarPropertyInput {
  propertyId: number;
  buildingSf: number | null;
  buildingStatus: BuildingStatus;
  subtype: LmSubtype;
  ownerType: OwnerType;
  isOraOwned: boolean;
  spaces: RadarSpaceInput[];
}

export interface RadarContext {
  staleThresholdDays: number;
  ownerScreenAvailable: boolean;
  thresholds: LmThresholds;
}

export interface RadarResult {
  eligible: boolean;
  gateFailures: string[];
  isCandidate: boolean;
  score: number;
  parts: RadarScoreParts;
  confidence: ConfidenceLabel;
  vacancyShare: number | null;
  maxEffectiveDom: number;
  reductionCount: number;
  cumulativeReductionPct: number | null;
  bestGapPct: number | null;
  comparableMedian: number | null;
  indicativeRentGapUsd: number | null;
}

const EXCLUDED_OWNERS: ReadonlySet<OwnerType> = new Set<OwnerType>(['institutional', 'never_call', 'unknown']);
const CONFIDENCE_RANK: Record<ConfidenceLabel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const EPS = 1e-9;

export function scoreRadar(p: RadarPropertyInput, ctx: RadarContext): RadarResult {
  const t = ctx.thresholds;
  const live = p.spaces.filter((s) => !s.isSublease);
  const buildingSf = p.buildingSf;
  const buildingSfKnown = buildingSf !== null && buildingSf > 0;

  const gateFailures: string[] = [];
  if (!ctx.ownerScreenAvailable) gateFailures.push('owner screen unavailable');
  if (EXCLUDED_OWNERS.has(p.ownerType)) gateFailures.push(`owner type ${p.ownerType}`);
  if (p.isOraOwned) gateFailures.push('ORA-owned');
  if (!buildingSfKnown) gateFailures.push('building SF unknown');
  else if (buildingSf > t.candidateMaxBuildingSf) gateFailures.push(`building ${buildingSf} SF > ${t.candidateMaxBuildingSf}`);
  if (p.buildingStatus !== 'existing') gateFailures.push(`building ${p.buildingStatus}`);
  if (live.length === 0) gateFailures.push('no direct (non-sublease) space');

  const maxEffectiveDom = live.reduce((m, s) => Math.max(m, s.effectiveDom), 0);
  const domRatio = ctx.staleThresholdDays > 0 ? maxEffectiveDom / ctx.staleThresholdDays : 0;
  const dom =
    !Number.isFinite(maxEffectiveDom) || !Number.isFinite(domRatio)
      ? 0
      : domRatio < 0.75 - EPS ? 0 : domRatio < 1 - EPS ? 10 : domRatio < 1.5 - EPS ? 18 : 25;

  const reductionCount = live.reduce((m, s) => Math.max(m, s.reductionCount), 0);
  const depths = live.map((s) => s.cumulativeReductionPct).filter((v): v is number => v !== null);
  const cumulativeReductionPct = depths.length > 0 ? Math.min(...depths) : null;
  const countPts = reductionCount >= 2 ? 12 : reductionCount === 1 ? 6 : 0;
  const depthPts = cumulativeReductionPct !== null && cumulativeReductionPct <= -0.1 + EPS ? 8 : cumulativeReductionPct !== null && cumulativeReductionPct <= -0.05 + EPS ? 4 : 0;
  const reductions = Math.min(20, countPts + depthPts);

  let bestGapPct: number | null = null;
  let bestSpace: RadarSpaceInput | null = null;
  for (const s of live) {
    if (
      !s.eligible || s.askingNnnEq === null || !Number.isFinite(s.askingNnnEq) ||
      s.comparableMedian === null || s.comparableMedian <= 0 || s.comparableConfidence === 'LOW'
    ) continue;
    const gap = (s.askingNnnEq - s.comparableMedian) / s.comparableMedian;
    if (bestGapPct === null || gap < bestGapPct) {
      bestGapPct = gap;
      bestSpace = s;
    }
  }
  const belowMarket = bestGapPct === null ? 0 : bestGapPct <= -0.25 + EPS ? 25 : bestGapPct <= -0.15 + EPS ? 18 : bestGapPct <= -0.1 + EPS ? 10 : 0;

  const liveSf = live.reduce((sum, s) => sum + s.availableSf, 0);
  const vacancyShare = buildingSfKnown ? liveSf / buildingSf : null;
  const shareForPoints = vacancyShare === null ? 0 : Math.min(1, vacancyShare);
  const vacancy = shareForPoints >= 0.5 - EPS ? 15 : shareForPoints >= 0.3 - EPS ? 10 : shareForPoints >= 0.15 - EPS ? 5 : 0;

  const sizePts = buildingSfKnown ? (buildingSf >= 10000 && buildingSf <= 50000 ? 6 : buildingSf < 10000 ? 3 : 0) : 0;
  const buyBoxFit = sizePts + (p.subtype === 'warehouse' ? 4 : 3);
  const owner = p.ownerType === 'private' ? 5 : p.ownerType === 'verify' || p.ownerType === 'affiliated' ? 2 : 0;

  const parts: RadarScoreParts = { dom, reductions, belowMarket, vacancy, buyBoxFit, owner };
  const score = dom + reductions + belowMarket + vacancy + buyBoxFit + owner;
  const confidence = bestSpace
    ? bestSpace.comparableConfidence
    : live.reduce<ConfidenceLabel>((best, s) => (CONFIDENCE_RANK[s.comparableConfidence] > CONFIDENCE_RANK[best] ? s.comparableConfidence : best), 'LOW');
  const comparableMedian = bestSpace ? bestSpace.comparableMedian : null;
  const indicativeRentGapUsd =
    bestSpace && bestGapPct !== null && bestGapPct < 0 && bestSpace.askingNnnEq !== null && bestSpace.comparableMedian !== null
      ? (bestSpace.comparableMedian - bestSpace.askingNnnEq) * bestSpace.availableSf
      : null;
  const eligible = gateFailures.length === 0;

  return {
    eligible, gateFailures, isCandidate: eligible && score >= t.radarMinScore, score, parts, confidence, vacancyShare,
    maxEffectiveDom, reductionCount, cumulativeReductionPct, bestGapPct, comparableMedian, indicativeRentGapUsd,
  };
}
