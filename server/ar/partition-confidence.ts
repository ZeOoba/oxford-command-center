// server/ar/partition-confidence.ts
//
// The auto-write policy for the HEADLESS AR-aging feed (Layer 2). The interactive importer
// (scripts/ar-import.ts) asks a human to confirm every below-HIGH-confidence tenant→lease match,
// because "silent mis-attribution is the worst failure mode" for delinquency data. A scheduled feed
// has no human at the terminal, so this splits parsed rows into:
//
//   - write:  matches safe to write UNATTENDED — an exact match, OR a high-confidence match with
//             ≥2 report tokens, OR a previously human-confirmed cache hit. Never ambiguous ties,
//             never single-token high matches (a lone "Summit" can hit the wrong lease at score 1.0).
//   - review: everything else — queued for a human to map. NEVER written silently.
//   - skipped: rows a human previously chose to omit (cache 'SKIP').
//
// The write predicate is byte-for-byte the same `autoAccept` rule the interactive script uses, so
// headless and interactive never disagree on what counts as safe.

import type { ArAgingRow } from './ar-aging';
import { matchTenantToLease, normalizeTokens, type LeaseLite, type MatchConfidence } from './match-tenant';
import { cacheKey } from './mapping-cache';
import { mergeByLease, type MergedRow } from './merge-buckets';

/** One row that did NOT clear the unattended-write bar — carries the buckets + why, for the queue. */
export interface ArReviewRow {
  tenant: string;
  property: string | null;
  d30: number;
  d60: number;
  d90: number;
  d90plus: number;
  proposedLeaseId: string | null;
  proposedCandidate: string | null;
  confidence: MatchConfidence;
  ambiguous: boolean;
  reason: string;
}

export interface ArPartition {
  /** Merged-by-lease arrears safe to write to the overlay unattended. */
  write: MergedRow[];
  /** Rows needing a human map — surfaced in the review queue, never written. */
  review: ArReviewRow[];
  /** Count of rows skipped via a cached 'SKIP' decision. */
  skipped: number;
  /** New cacheKey→leaseId entries learned from auto-accepts, for the caller to persist. */
  learned: Record<string, string>;
}

function reviewReason(match: ReturnType<typeof matchTenantToLease>, tokens: number): string {
  if (match.leaseId === null) return 'no match — human must map';
  if (match.ambiguous) return `ambiguous tie (score ${match.score.toFixed(2)}) — ${match.confidence}`;
  if (match.confidence === 'high' && tokens < 2)
    return `single-token high match (score ${match.score.toFixed(2)}) — needs confirmation`;
  if (match.confidence === 'low') return `low confidence (score ${match.score.toFixed(2)})`;
  return `confidence ${match.confidence} (score ${match.score.toFixed(2)})`;
}

/**
 * Split parsed AR rows into auto-writable / review / skipped against the live leases and the
 * confirmed-mapping cache. Pure — no I/O; the caller loads the cache/leases and persists results.
 *
 * `cacheEntries` is the MappingCache.entries map (cacheKey → leaseId | 'SKIP'). A cache hit is a
 * previously human-confirmed decision, so it is trusted: a leaseId → write, 'SKIP' → skip.
 */
export function partitionArRows(
  rows: ReadonlyArray<ArAgingRow>,
  leases: ReadonlyArray<LeaseLite>,
  cacheEntries: Readonly<Record<string, string>> = {},
): ArPartition {
  const writePre: Array<{ leaseId: string; arrears: { d30: number; d60: number; d90: number; d90plus: number }; tenant: string }> = [];
  const review: ArReviewRow[] = [];
  const learned: Record<string, string> = {};
  let skipped = 0;
  // Refute 2026-07-22: a cached mapping was trusted with NO check that the leaseId still exists —
  // the fresh-match path validates implicitly via matchTenantToLease, but the cache path did not.
  // A vacated tenant's lease drops out of `leases` on the next workbook refresh while the AR export
  // keeps listing them; a stale cache hit then writes to a dead leaseId, and deriveArBalances
  // silently skips that orphan — the delinquency vanishes from every read model with zero
  // visibility. Validate every cache hit against the live roster before trusting it.
  const leaseIds = new Set(leases.map((l) => l.id));

  for (const row of rows) {
    const { tenant, property, d30, d60, d90, d90plus } = row;
    const arrears = { d30, d60, d90, d90plus };
    const key = cacheKey(tenant);

    const cached = cacheEntries[key];
    if (cached === 'SKIP') {
      skipped++;
      continue;
    }
    if (cached !== undefined) {
      if (!leaseIds.has(cached)) {
        review.push({
          tenant,
          property,
          d30,
          d60,
          d90,
          d90plus,
          proposedLeaseId: cached,
          proposedCandidate: null,
          confidence: 'none',
          ambiguous: false,
          reason: `cached mapping → ${cached} no longer exists in the current lease roster (lease removed/vacated) — needs re-mapping`,
        });
        continue;
      }
      // Previously human-confirmed mapping, and the leaseId is still live — trusted.
      writePre.push({ leaseId: cached, arrears, tenant });
      continue;
    }

    const match = matchTenantToLease(tenant, leases);
    const tokens = normalizeTokens(tenant).length;
    const autoAccept =
      (match.confidence === 'exact' || (match.confidence === 'high' && tokens >= 2)) &&
      !match.ambiguous &&
      match.leaseId !== null;

    if (autoAccept && match.leaseId) {
      learned[key] = match.leaseId;
      writePre.push({ leaseId: match.leaseId, arrears, tenant });
      continue;
    }

    review.push({
      tenant,
      property,
      d30,
      d60,
      d90,
      d90plus,
      proposedLeaseId: match.leaseId,
      proposedCandidate: match.candidate,
      confidence: match.confidence,
      ambiguous: match.ambiguous,
      reason: reviewReason(match, tokens),
    });
  }

  return { write: mergeByLease(writePre), review, skipped, learned };
}
