// src/modules/command-brain/hooks.ts
//
// TanStack Query hooks + pure display helpers for the Command Brain module — the read/write surface
// over server/warehouse/brain-api.ts (Phase 5a.2). Read: GET /api/warehouse/brain/report →
// BrainReport, Zod-parsed at the client boundary via fetchParsedOrMirror (live-first, Fat-Mirror
// fallback on a 503/non-JSON mirror — the SAME pattern as calibration/hooks.ts and debt/hooks.ts, no
// duplicate fetch logic). Write: POST /api/warehouse/brain/feedback → FeedbackDecision.
//
// The feedback loop is DISPLAY-ONLY (brain-api.ts's + FeedbackInput's own comments): accepting or
// dismissing a question records an append-only row and NEVER re-weights or re-ranks anything. No
// helper or component built on top of this file may imply otherwise.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tier, TierItem } from '@/primitives/TierBoard';
import type { BadgeTone } from '@/primitives/Badge';
import { ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';
import { fetchParsedOrMirror, QUERY_OPTS, WarehouseUnavailableError, isWarehouseUnavailable } from '../intel/hooks';
import {
  BrainReport,
  FeedbackDecision,
  FeedbackInput,
  type AccuracyPoint,
  type ConfidenceRow,
  type OpenQuestion,
  type OpenQuestionKind,
  type FeedbackSubjectKind,
  type TrackRecordOutcome,
} from '@contracts/brain-report';

export { isWarehouseUnavailable };
export type { BrainReport, FeedbackInput, OpenQuestion, ConfidenceRow, AccuracyPoint, TrackRecordOutcome, FeedbackSubjectKind };

export const BRAIN_KEYS = {
  report: ['warehouse', 'brain', 'report'] as const,
};

/** The composed Command Brain report. Degrades to an isUnavailable error on the static mirror / a
 *  cold brain server, mirroring calibration/hooks.ts's useCalibrationReport exactly. */
export function useBrainReport() {
  return useQuery({
    queryKey: BRAIN_KEYS.report,
    queryFn: (): Promise<BrainReport> => fetchParsedOrMirror('/api/warehouse/brain/report', BrainReport),
    ...QUERY_OPTS,
  });
}

async function postFeedback(body: FeedbackInput): Promise<FeedbackDecision> {
  let res: Response;
  try {
    res = await fetch('/api/warehouse/brain/feedback', {
      method: 'POST',
      headers: ORA_JSON_MUTATION_HEADERS,
      body: JSON.stringify(body),
    });
  } catch {
    throw new WarehouseUnavailableError('brain server offline');
  }
  if (res.status === 503) throw new WarehouseUnavailableError();
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new WarehouseUnavailableError('warehouse routes not present');
  const json = (await res.json()) as FeedbackDecision | { error?: string };
  if (!res.ok) throw new Error(('error' in json && json.error) || `feedback failed (${res.status})`);
  return FeedbackDecision.parse(json);
}

/** Record an accept/dismiss decision (append-only, display-only — see file header). Validates the
 *  body against the contract before it leaves the client, then invalidates the report query on
 *  success (the only downstream effect: a fresh report read, never a re-scored one). */
export function useSubmitFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: FeedbackInput) => postFeedback(FeedbackInput.parse(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BRAIN_KEYS.report });
    },
  });
}

// ── Pure display helpers (unit-testable; no React dependencies) ──────────────────────────

/** Badge tone for a track-record outcome — EXACTLY 3 values, no 'partial' (see contract header). */
export function outcomeTone(outcome: TrackRecordOutcome): BadgeTone {
  switch (outcome) {
    case 'hit': return 'green';
    case 'miss': return 'red';
    case 'not-scoreable': return 'neutral';
  }
}

export function outcomeLabel(outcome: TrackRecordOutcome): string {
  switch (outcome) {
    case 'hit': return 'Hit';
    case 'miss': return 'Miss';
    case 'not-scoreable': return 'Not scoreable';
  }
}

/** A predicted/realized band-or-value cell → display string. Prefers the band label; falls back to
 *  the numeric value; never fabricates a number when both are null. */
export function fmtBandOrValue(band: string | null, value: number | null): string {
  if (band) return band;
  if (value !== null && !Number.isNaN(value)) return value.toFixed(2);
  return '—';
}

export type ConfidenceTierKey = 'well-covered' | 'building-coverage' | 'sparse';

/** Bucket a coverage-confidence value into the Memory Board's 3 tiers. */
export function confidenceTier(coverageConfidence: number): ConfidenceTierKey {
  if (coverageConfidence >= 0.7) return 'well-covered';
  if (coverageConfidence >= 0.4) return 'building-coverage';
  return 'sparse';
}

/** Combine confidence-by-market + confidence-by-manager into the 3 TierBoard tiers. This is NOT
 *  literal "memory" — nothing in the BrainReport contract stores memory entries — it is a derived
 *  coverage-confidence bucketing. Every card keeps the row's own basisNote ('coverage-based, not
 *  predictive skill') visible as its caption: that note IS the point of the doctrine, never a detail
 *  to hide. Rows are tagged Market/Manager via a `category` chip so a mixed board stays legible. */
export function buildMemoryTiers(confidenceByMarket: ConfidenceRow[], confidenceByManager: ConfidenceRow[]): Tier[] {
  const tagged: Array<{ row: ConfidenceRow; source: 'Market' | 'Manager' }> = [
    ...confidenceByMarket.map((row) => ({ row, source: 'Market' as const })),
    ...confidenceByManager.map((row) => ({ row, source: 'Manager' as const })),
  ];

  const buckets: Record<ConfidenceTierKey, TierItem[]> = {
    'well-covered': [],
    'building-coverage': [],
    sparse: [],
  };
  for (const { row, source } of tagged) {
    buckets[confidenceTier(row.coverageConfidence)].push({
      id: `${source.toLowerCase()}:${row.key}`,
      category: source,
      title: `${row.label} — ${Math.round(row.coverageConfidence * 100)}%`,
      detail: `n=${row.sampleN} · ${row.basisNote}`,
    });
  }

  return [
    { key: 'well-covered', title: 'Well-covered', subtitle: '≥70% coverage confidence', tone: 'pos', items: buckets['well-covered'] },
    { key: 'building-coverage', title: 'Building coverage', subtitle: '40–70% coverage confidence', tone: 'accent', items: buckets['building-coverage'] },
    { key: 'sparse', title: 'Sparse', subtitle: '<40% coverage confidence', tone: 'warn', items: buckets.sparse },
  ];
}

/** Split an accuracy series into contiguous runs of SCOREABLE (non-null hitRate) months. A
 *  null-hitRate month (scoreableN<5, the honesty gate — see contract header) ends the current run
 *  instead of being coerced to 0; the caller renders each run as its own Sparkline segment, so a gap
 *  in coverage reads as a broken line, never a theatrical dip to zero. */
export function accuracySegments(series: AccuracyPoint[]): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];
  for (const point of series) {
    if (point.hitRate === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(point.hitRate);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Map an OpenQuestion's kind to the feedback subject kind it most resembles. Needed only because the
 *  Feedback section reuses openQuestions as its actionable feed — the contract hands us no separate
 *  ranked-insights feed to accept/dismiss against. Judgment call, documented here: a data-quality gap
 *  reads as an analytic insight about the ledger; a dormant-generator question is watch/alert-shaped;
 *  a floor-indeterminate question is about a capital-allocation input. */
export function openQuestionSubjectKind(kind: OpenQuestionKind): FeedbackSubjectKind {
  switch (kind) {
    case 'data-quality': return 'insight';
    case 'dormant-generator': return 'alert';
    case 'floor-indeterminate': return 'allocation';
  }
}

/** Deterministic content hash → a stable subjectId for an OpenQuestion. OpenQuestion carries no id in
 *  the contract, so we derive one from (kind, title, detail): stable across renders/refetches for the
 *  SAME question, distinct across different questions, and NOT dependent on array position — an
 *  index-based id would silently reassign a prior decision to a different question if the report ever
 *  reorders openQuestions between fetches. */
export function openQuestionSubjectId(q: OpenQuestion): string {
  const input = `${q.kind}::${q.title}::${q.detail}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return `oq-${(hash >>> 0).toString(16)}`;
}
