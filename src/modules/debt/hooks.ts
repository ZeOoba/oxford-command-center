// src/modules/debt/hooks.ts
//
// Phase 2 Step 6 — TanStack Query hooks for the Debt Scorecard UI.
//
// Consumes:
//   GET /api/warehouse/debt/scores   → DebtScoreResponse
//   GET /api/warehouse/debt/maturity → MaturityLadderResponse
//
// Error policy: mirrors calibration/hooks.ts exactly.
//   - 503 / non-JSON (mirror) → WarehouseUnavailableError → module degrades gracefully.
//   - Real API errors surface as thrown Error (4xx with JSON body).
//   - Zod parse validates the full response at the client boundary (H6 read boundary).
//
// No write mutations in Step 6 — the debt scorecard is read-only.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { DebtScoreResponse, MaturityLadderResponse } from '@contracts/debt';
import type { DebtScore, MaturityLadderEntry, DebtSignal, DebtScoreBand } from '@contracts/debt';

export type { DebtScore, MaturityLadderEntry, DebtSignal, DebtScoreBand };

// ── Query keys ─────────────────────────────────────────────────────────────────────────────

export const DEBT_KEYS = {
  scores: ['warehouse', 'debt', 'scores'] as const,
  maturity: ['warehouse', 'debt', 'maturity'] as const,
};

// ── Read hooks ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-property debt scores from the scoring engine.
 * Degrades gracefully on the static mirror (WarehouseUnavailableError → empty state).
 */
export function useDebtScores() {
  return useQuery({
    queryKey: DEBT_KEYS.scores,
    queryFn: () =>
      fetchParsedOrMirror('/api/warehouse/debt/scores', DebtScoreResponse).then((r) => r.scores),
    ...QUERY_OPTS,
  });
}

/**
 * Maturity ladder: all active loans bucketed into 4 time horizons.
 * Sorted ascending by months_to_maturity (server-guaranteed).
 */
export function useDebtMaturity() {
  return useQuery({
    queryKey: DEBT_KEYS.maturity,
    queryFn: () =>
      fetchParsedOrMirror('/api/warehouse/debt/maturity', MaturityLadderResponse).then((r) => r.ladder),
    ...QUERY_OPTS,
  });
}

// ── Pure display helpers (unit-testable; no React dependencies) ──────────────────────────

/** Map a DebtSignal to a badge tone. */
export function signalTone(signal: DebtSignal): 'green' | 'amber' | 'red' | 'blue' | 'neutral' {
  switch (signal) {
    case 'refi':      return 'blue';
    case 'cash-out':  return 'green';
    case 'hold':      return 'neutral';
    case 'governor-block': return 'red';
    case 'no-debt':   return 'neutral';
  }
}

/** Human label for a DebtSignal (title-case, suitable for badge text). */
export function signalLabel(signal: DebtSignal): string {
  switch (signal) {
    case 'refi':           return 'Refi';
    case 'cash-out':       return 'Cash-Out';
    case 'hold':           return 'Hold';
    case 'governor-block': return 'Gov Block';
    case 'no-debt':        return 'No Debt';
  }
}

/** Map a DebtScoreBand to a badge tone. */
export function bandTone(band: DebtScoreBand): 'green' | 'amber' | 'red' | 'neutral' {
  switch (band) {
    case 'strong':   return 'green';
    case 'adequate': return 'neutral';
    case 'watch':    return 'amber';
    case 'critical': return 'red';
  }
}

/** Map a MaturityLadderEntry bucket to a badge tone. */
export function bucketTone(bucket: MaturityLadderEntry['bucket']): 'red' | 'amber' | 'neutral' | 'green' {
  switch (bucket) {
    case '0-12':  return 'red';
    case '13-24': return 'amber';
    case '25-36': return 'neutral';
    case '37+':   return 'green';
  }
}

/**
 * Group maturity ladder entries by bucket.
 * Returns a map bucket → entries[], preserving the server's ascending sort within each group.
 */
export function groupByBucket(
  ladder: MaturityLadderEntry[],
): Map<MaturityLadderEntry['bucket'], MaturityLadderEntry[]> {
  const buckets: MaturityLadderEntry['bucket'][] = ['0-12', '13-24', '25-36', '37+'];
  const result = new Map<MaturityLadderEntry['bucket'], MaturityLadderEntry[]>();
  for (const b of buckets) result.set(b, []);
  for (const entry of ladder) {
    result.get(entry.bucket)?.push(entry);
  }
  return result;
}

/** Total balance per bucket (for the summary row). */
export function bucketBalance(entries: MaturityLadderEntry[]): number {
  return entries.reduce((acc, e) => acc + e.currentBalance, 0);
}
