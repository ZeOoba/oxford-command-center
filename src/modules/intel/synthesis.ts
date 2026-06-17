// src/modules/intel/synthesis.ts
//
// THE INTELLIGENCE — pure, deterministic transforms that turn the analytics engine's
// outputs (PropertyScore[], AnomalyFlag[], SinceAcquisition[], PmScorecard[]) into the
// ownership-decision surface: an attention ranking, a capital-action grouping, the top
// risks, improving/deteriorating lists, and a prioritized human ACTION LIST. No I/O, no
// React, no clock — re-running on the same inputs deep-equals the prior result, so the
// "so what" is verifiable (pre-mortem #10) rather than vibes. Inputs are never mutated.
import type { AnomalyFlag, CapitalAction, PmScorecard, PropertyScore, SinceAcquisition } from './analytics-hooks';

// ---------------------------------------------------------------------------
// Orderings — worst-first, so a stable sort surfaces what ownership acts on next.
// ---------------------------------------------------------------------------

/** Attention bands worst→best. Index = sort key for rankByAttention. */
export const ATTENTION_ORDER = ['red', 'orange', 'yellow', 'green'] as const;

/** Anomaly severities worst→best. Index = sort key for topRisks. */
export const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low'] as const;

const attentionIndex = (band: string): number => {
  const i = (ATTENTION_ORDER as readonly string[]).indexOf(band);
  return i === -1 ? ATTENTION_ORDER.length : i; // unknown bands sort last, deterministically
};

const severityIndex = (sev: string): number => {
  const i = (SEVERITY_ORDER as readonly string[]).indexOf(sev);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

// ---------------------------------------------------------------------------
// Attention ranking + capital-action grouping.
// ---------------------------------------------------------------------------

/** Scores ordered red→green (worst attention first); tie-break by health ascending
 *  (worse health first). Stable, non-mutating (operates on a shallow copy). */
export function rankByAttention(scores: PropertyScore[]): PropertyScore[] {
  return [...scores].sort(
    (a, b) => attentionIndex(a.attentionBand) - attentionIndex(b.attentionBand) || a.health - b.health,
  );
}

export interface CapitalActionGroups {
  invest: PropertyScore[];
  hold: PropertyScore[];
  monitor: PropertyScore[];
  'disposition-candidate': PropertyScore[];
}

/** Bucket scores by capitalAction into the four stable buckets, preserving input order
 *  within each bucket. Unknown actions are dropped (the four are the engine's full enum). */
export function groupByCapitalAction(scores: PropertyScore[]): CapitalActionGroups {
  const groups: CapitalActionGroups = { invest: [], hold: [], monitor: [], 'disposition-candidate': [] };
  for (const s of scores) {
    const bucket = groups[s.capitalAction as CapitalAction];
    if (bucket) bucket.push(s);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Risks.
// ---------------------------------------------------------------------------

const absMetric = (f: AnomalyFlag): number => (f.metricValue === null ? 0 : Math.abs(f.metricValue));

/** Dedupe anomalies by `propertyId|kind|subkey` (keep the worst severity, tie-break larger |move|),
 *  then rank by severity (critical→low) then |metricValue| desc, then slice to `limit`. The subkey
 *  is in the key so two co-occurring distinct-category spikes (e.g. Taxes AND Utilities) each rank
 *  as the separate real risks they are, instead of one silently collapsing the other — the same
 *  collision class the alert id and calibration verdictSubkind fixed (refute F1). */
export function topRisks(anomalies: AnomalyFlag[], limit: number): AnomalyFlag[] {
  const worstByKey = new Map<string, AnomalyFlag>();
  for (const f of anomalies) {
    const key = `${f.propertyId}|${f.kind}|${f.subkey}`;
    const existing = worstByKey.get(key);
    if (
      !existing ||
      severityIndex(f.severity) < severityIndex(existing.severity) ||
      (severityIndex(f.severity) === severityIndex(existing.severity) && absMetric(f) > absMetric(existing))
    ) {
      worstByKey.set(key, f);
    }
  }
  return [...worstByKey.values()]
    .sort((a, b) =>
      severityIndex(a.severity) - severityIndex(b.severity) ||
      absMetric(b) - absMetric(a) ||
      // Total-order tiebreak over the unique (propertyId, kind, subkey) identity, so the slice cutoff
      // between two equally-severe, equally-large risks is deterministic regardless of the upstream
      // anomaly-feed order (refute determinism hardening — future-proofs against a feed reorder).
      a.propertyId.localeCompare(b.propertyId) || a.kind.localeCompare(b.kind) || a.subkey.localeCompare(b.subkey))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Improving / deteriorating since acquisition.
// ---------------------------------------------------------------------------

/** Properties whose since-acquisition NOI declined: comparable && noiGrowth != null && < 0,
 *  sorted ascending (worst decline first). Incomparable / null excluded. */
export function deterioratingProperties(sinceAcq: SinceAcquisition[]): SinceAcquisition[] {
  return sinceAcq
    .filter((s) => s.comparable && s.noiGrowth !== null && s.noiGrowth < 0)
    .sort((a, b) => (a.noiGrowth ?? 0) - (b.noiGrowth ?? 0));
}

/** Properties whose since-acquisition NOI grew: comparable && noiGrowth > 0, sorted
 *  descending (best gain first). Incomparable / null / flat excluded. */
export function improvingProperties(sinceAcq: SinceAcquisition[]): SinceAcquisition[] {
  return sinceAcq
    .filter((s) => s.comparable && s.noiGrowth !== null && s.noiGrowth > 0)
    .sort((a, b) => (b.noiGrowth ?? 0) - (a.noiGrowth ?? 0));
}

export interface SinceAcqLeaderboard {
  /** Comparable properties ranked by NOI/SF growth since acquisition, best gain first. */
  ranked: SinceAcquisition[];
  /** Count excluded for insufficient history (incomparable or null NOI/SF growth). */
  insufficient: number;
}

/** The since-acquisition NOI/SF growth leaderboard (PFI Phase B.3 item 4) — "which assets are
 *  compounding since we bought them". Includes only comparable rows with a non-null
 *  `noiPerSfGrowth`, sorted descending; everything excluded is tallied into `insufficient` for
 *  the "insufficient history" note. Non-mutating, deterministic, empty-safe. */
export function rankBySinceAcqGrowth(sinceAcq: SinceAcquisition[]): SinceAcqLeaderboard {
  const ranked = sinceAcq
    .filter((s) => s.comparable && s.noiPerSfGrowth !== null)
    .sort((a, b) => (b.noiPerSfGrowth ?? 0) - (a.noiPerSfGrowth ?? 0));
  return { ranked, insufficient: sinceAcq.length - ranked.length };
}

// ---------------------------------------------------------------------------
// Action list — the operating-system core.
// ---------------------------------------------------------------------------

export type ActionPriority = 'high' | 'medium' | 'low';

export interface Action {
  priority: ActionPriority;
  text: string;
  propertyId?: string;
}

export interface ActionListInput {
  scores: PropertyScore[];
  anomalies: AnomalyFlag[];
  pm: PmScorecard[];
}

const PRIORITY_RANK: Record<ActionPriority, number> = { high: 0, medium: 1, low: 2 };

const pct = (n: number | null): string => (n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`);

const quartileLabel = (q: number | null): string =>
  q === 4 ? 'bottom-quartile NOI/SF' : q === 1 ? 'top-quartile NOI/SF' : q === null ? 'NOI/SF unranked' : `Q${q} NOI/SF`;

/** Turn scores + anomalies + PM scorecards into a prioritized, deduped, human action list.
 *
 *  Priority rules (first applicable per source signal):
 *   - HIGH: a disposition-candidate property, or any property carrying a critical/high anomaly.
 *   - MEDIUM: a property in attention band 'orange', or a 'monitor' property whose manager's
 *     avg NOI growth is declining (avgNoiGrowth < 0).
 *   - LOW: invest opportunities and the watch-list (attention 'yellow').
 *
 *  Dedupe by `text`; sort by priority high→low (stable within a priority, preserving the
 *  emission order below). Deterministic — no clock, no randomness, no mutation. */
export function buildActionList(input: ActionListInput): Action[] {
  const { scores, anomalies, pm } = input;
  const actions: Action[] = [];
  const seen = new Set<string>();

  const push = (priority: ActionPriority, text: string, propertyId?: string): void => {
    if (seen.has(text)) return;
    seen.add(text);
    actions.push(propertyId === undefined ? { priority, text } : { priority, text, propertyId });
  };

  // Anomalies grouped per property so a property's worst flag drives a HIGH action.
  const worstAnomalyByProperty = new Map<string, AnomalyFlag>();
  for (const f of anomalies) {
    const cur = worstAnomalyByProperty.get(f.propertyId);
    if (!cur || severityIndex(f.severity) < severityIndex(cur.severity)) worstAnomalyByProperty.set(f.propertyId, f);
  }

  const name = (s: PropertyScore): string => s.propertyName ?? s.propertyId;

  // 1) HIGH — disposition candidates (lead with the most consequential ownership decision).
  for (const s of scores) {
    if (s.capitalAction !== 'disposition-candidate') continue;
    const flag = worstAnomalyByProperty.get(s.propertyId);
    const tail = flag ? `, ${flag.detail}` : '';
    push('high', `Review ${name(s)} — disposition candidate (${quartileLabel(s.noiPerSfQuartile)}${tail})`, s.propertyId);
  }

  // 2) HIGH — any property with a critical/high anomaly not already surfaced above.
  for (const s of scores) {
    if (s.capitalAction === 'disposition-candidate') continue;
    const flag = worstAnomalyByProperty.get(s.propertyId);
    if (!flag || (flag.severity !== 'critical' && flag.severity !== 'high')) continue;
    push('high', `Investigate ${name(s)} — ${flag.severity} anomaly: ${flag.detail}`, s.propertyId);
  }

  // 3) MEDIUM — orange attention (elevated, not yet disposition).
  for (const s of scores) {
    if (s.capitalAction === 'disposition-candidate') continue;
    if (s.attentionBand !== 'orange') continue;
    push('medium', `Monitor ${name(s)} — elevated attention (orange band, health ${s.health})`, s.propertyId);
  }

  // 4) MEDIUM — managers whose avg NOI growth is declining (operational follow-up).
  for (const card of pm) {
    if (card.avgNoiGrowth === null || card.avgNoiGrowth >= 0) continue;
    const sample = card.smallSample ? ' [small sample]' : '';
    push(
      'medium',
      `Review PM ${card.propertyManager} — avg NOI growth ${pct(card.avgNoiGrowth)} across ${card.propertyCount} ${card.propertyCount === 1 ? 'property' : 'properties'}${sample}`,
    );
  }

  // 5) LOW — invest opportunities.
  for (const s of scores) {
    if (s.capitalAction !== 'invest') continue;
    push('low', `Consider ${name(s)} for capital — invest opportunity (${quartileLabel(s.noiPerSfQuartile)})`, s.propertyId);
  }

  // 6) LOW — yellow watch-list (keep an eye, no action yet).
  for (const s of scores) {
    if (s.attentionBand !== 'yellow') continue;
    if (s.capitalAction === 'disposition-candidate' || s.capitalAction === 'invest') continue;
    push('low', `Watch ${name(s)} — yellow attention band`, s.propertyId);
  }

  // Stable priority sort (emission order is the within-priority tiebreak).
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => PRIORITY_RANK[x.a.priority] - PRIORITY_RANK[y.a.priority] || x.i - y.i)
    .map(({ a }) => a);
}
