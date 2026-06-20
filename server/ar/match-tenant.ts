// server/ar/match-tenant.ts
//
// Tenant-name → Lease.id matcher for the AR-aging feed (audit Fix #2, review-then-write flow).
// The AR parser yields raw tenant names from a PM export; the collections condition keys arrears by
// Lease.id. The names rarely match the rent roll byte-for-byte — entity suffixes differ ("Acme" vs
// "Acme, LLC"), people appear "Last, First" on one side and "First Last" on the other, and PDF text
// extraction wraps/truncates long names. This is the PURE matcher: it proposes the best lease per
// report name WITH a confidence tier so a human reviews low-confidence rows before any write
// (review-then-write — no silent mis-attribution of a delinquency to the wrong tenant).

export interface LeaseLite {
  id: string;
  tenantName: string;
  company: string | null;
}

export type MatchConfidence = 'exact' | 'high' | 'low' | 'none';

export interface TenantMatch {
  /** Best lease id, or null when nothing clears the floor (→ human must map it). */
  leaseId: string | null;
  confidence: MatchConfidence;
  /** 0–1 token-overlap score for the chosen candidate (0 when none). */
  score: number;
  /** The lease's display name for the chosen candidate (for the review surface). */
  candidate: string | null;
  /** True when ≥2 leases tie at the top score — always force human review. */
  ambiguous: boolean;
}

// Entity suffixes stripped before comparison — they carry no disambiguating signal and differ freely
// between a rent roll and a PM export.
// True legal/entity suffixes only. Deliberately NOT 'service(s)' / 'division' — those are meaningful
// words in real business names ("REDACTED-495"); stripping them collapses distinct tenants and
// invites false matches. A trailing 'svcs'/'svc' abbreviation is left in too — the subset-overlap
// scorer already absorbs it (a report name without it still scores 1.0 against the fuller name).
const ENTITY_SUFFIXES = new Set([
  'llc', 'llp', 'lp', 'inc', 'ltd', 'co', 'corp', 'corporation', 'company', 'pllc', 'pc', 'pa',
  'incorporated', 'limited', 'the', 'dba',
]);

/** Normalize a name to a comparable token list: lowercased, de-punctuated, entity-suffixes dropped,
 *  and "Last, First" reordered to "first last". Returns the surviving content tokens. */
export function normalizeTokens(raw: string): string[] {
  let s = raw.toLowerCase().trim();
  // "Last, First M." → "first m. last" when the comma separates a person name (not an entity suffix).
  const comma = s.indexOf(',');
  if (comma > -1) {
    const before = s.slice(0, comma).trim();
    const after = s.slice(comma + 1).trim();
    const afterFirstTok = after.split(/\s+/)[0]?.replace(/\./g, '') ?? '';
    if (after && !ENTITY_SUFFIXES.has(afterFirstTok)) {
      s = `${after} ${before}`; // person: reorder
    } else {
      s = before; // entity suffix after the comma: drop it
    }
  }
  return s
    .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
    .split(/\s+/)
    .filter((t) => t && !ENTITY_SUFFIXES.has(t));
}

/** Symmetric token-overlap score (size of intersection / size of the SMALLER set) in [0,1]. Using
 *  the smaller set means a wrapped/truncated report name that is a subset of the full rent-roll name
 *  still scores 1.0 — the common real case ("Building Bridges Therapy" ⊂ "Building Bridges Therapy
 *  Svcs"). Empty either side → 0. */
function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter((t) => setB.has(t)).length;
  return inter / Math.min(a.length, b.length);
}

const HIGH_FLOOR = 0.8;
const LOW_FLOOR = 0.5;

/**
 * Propose the best lease for a report tenant name. Compares against each lease's tenantName AND
 * company (a PM export may carry either). Confidence: exact (normalized-equal), high (≥0.8 overlap),
 * low (≥0.5), none (below floor → null leaseId, human maps it). Ties at the top score set
 * `ambiguous` so the review surface never auto-accepts a coin-flip.
 */
export function matchTenantToLease(reportName: string, leases: ReadonlyArray<LeaseLite>): TenantMatch {
  const target = normalizeTokens(reportName);
  if (!target.length) return { leaseId: null, confidence: 'none', score: 0, candidate: null, ambiguous: false };

  let best = { leaseId: null as string | null, score: 0, candidate: null as string | null, exact: false };
  let topCount = 0;
  for (const l of leases) {
    for (const field of [l.tenantName, l.company]) {
      if (!field) continue;
      const cand = normalizeTokens(field);
      if (!cand.length) continue;
      const exact = cand.length === target.length && cand.every((t, i) => t === target[i]);
      const score = exact ? 1 : overlap(target, cand);
      if (score > best.score + 1e-9) {
        best = { leaseId: l.id, score, candidate: field, exact };
        topCount = 1;
      } else if (Math.abs(score - best.score) <= 1e-9 && best.leaseId !== null && l.id !== best.leaseId) {
        topCount++;
      }
    }
  }

  const confidence: MatchConfidence =
    best.exact ? 'exact' : best.score >= HIGH_FLOOR ? 'high' : best.score >= LOW_FLOOR ? 'low' : 'none';
  if (confidence === 'none') return { leaseId: null, confidence, score: best.score, candidate: null, ambiguous: false };
  return { leaseId: best.leaseId, confidence, score: best.score, candidate: best.candidate, ambiguous: topCount > 1 };
}
