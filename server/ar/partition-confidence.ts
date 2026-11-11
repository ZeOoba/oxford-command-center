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
  validLeaseIds?: ReadonlySet<string>,
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
  //
  // validLeaseIds is a SEPARATE, optional, wider roster than `leases` (2026-08-24, PR #302 review
  // finding): the 2026-08-24 integrity sweep started excluding Expired leases from `leases` so a
  // FRESH tenant-name match can no longer auto-attribute to a dead lease -- but `leases` also fed
  // this validation set, so a PREVIOUSLY human-CONFIRMED cache mapping to an Expired lease (a
  // different, already-trusted decision -- see the header doc) started failing validation too and
  // silently froze real, live arrears (verified: 2 cache entries with live arrears in
  // this repo's own data at review time). Callers that need the Expired-exclusion for fresh matches
  // but must still honor a confirmed mapping to an Expired lease should pass the FULL (unfiltered)
  // roster's ids here; omitting it falls back to deriving from `leases`, preserving old behavior for
  // any caller that has no such distinction.
  const leaseIds = validLeaseIds ?? new Set(leases.map((l) => l.id));

  for (const row of rows) {
    const { tenant, property, d30, d60, d90, d90plus } = row;
    const arrears = { d30, d60, d90, d90plus };
    const key = cacheKey(tenant);

    // Object.hasOwn guard (2026-08-24 integrity-sweep hygiene finding): cacheEntries is a plain
    // object indexed by a normalized tenant string — a tenant name that happens to normalize to
    // 'constructor'/'toString'/etc. would otherwise read an inherited Object.prototype member
    // instead of undefined. No real tenant name collides with one today (this already failed
    // CLOSED via the leaseIds.has() validation below, which routes any non-string/unrecognized
    // hit to review), but the guard removes the class of bug rather than relying on that
    // downstream check.
    const cached = Object.hasOwn(cacheEntries, key) ? cacheEntries[key] : undefined;
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
      // Deliberately NOT cached (2026-09-06 adversarial review, MEDIUM): a cache hit is trusted
      // unconditionally on the next sweep as "a previously human-CONFIRMED decision" (see the
      // module doc above and mapping-cache.ts's header) -- which was never true for an unattended
      // auto-accept nobody reviewed. Freezing it also bypassed re-evaluation forever: if the roster
      // later gained a competing lease with the same normalized name, the cache hit would keep
      // writing to the ORIGINAL lease with no ambiguity check, silently missing the now-real tie.
      // Auto-accepts re-derive from matchTenantToLease fresh every sweep instead — deterministic
      // and cheap, and the correct outcome (write, unattended) is unaffected when the roster hasn't
      // changed. `learned` is populated only by an explicit human decision on a row that did NOT
      // auto-accept (see scripts/ar-import.ts's interactive y/manual/skip branches).
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
