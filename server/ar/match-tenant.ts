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
  // Collapse a dotted initialism ('I.M.H', 'I.M.H.', 'REDACTED-695') into one run of bare letters BEFORE
  // the generic punctuation strip below, which would otherwise turn every '.' into a space and split
  // it into isolated single-letter tokens ('i','m','h') — zero overlap against an undotted spelling
  // of the same name ('IMH'). Requires 2+ consecutive single-letter-dot pairs, so a single first/
  // middle initial ('W.' in "REDACTED-692") is deliberately left untouched — that stays its own
  // token, exactly as it always has.
  s = s.replace(/\b(?:[a-z]\.){2,}[a-z]?\b/g, (m) => m.replace(/\./g, ''));
  return s
    .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
    .split(/\s+/)
    .filter((t) => t && !ENTITY_SUFFIXES.has(t));
}

/** Symmetric token-overlap score (size of intersection / size of the SMALLER set) in [0,1]. Using
 *  the smaller set means a wrapped/truncated report name that is a subset of the full rent-roll name
 *  still scores 1.0 — the common real case ("Building Bridges Therapy" ⊂ "Building Bridges Therapy
 *  Svcs"). Empty either side → 0.
 *
 *  Only the REPORT-name side (`a`) is de-duplicated for the intersection count — a token repeated in
 *  the report name (e.g. two tenants joined by "&" who share a surname) must not be counted once per
 *  occurrence, which could otherwise inflate the intersection past either side's true size and push
 *  the score above 1.0. The CANDIDATE side (`b`) and the denominator (`Math.min(a.length, b.length)`)
 *  are deliberately left as raw arrays/lengths, matching the original, pre-fix denominator exactly:
 *  an earlier version of this fix also de-duplicated `b` for the denominator, which shrinks it for a
 *  candidate whose OWN name repeats a token (e.g. "Smith & Smith LLC" → 1 distinct token) and wrongly
 *  promoted a genuinely low-confidence match ("John Smith" vs "Smith & Smith LLC", true overlap 0.5)
 *  to a high-confidence one (1.0) — an unattended auto-write to the wrong lease. Deduping only `a` is
 *  sufficient to bound the score to [0,1] (intersection can never exceed the number of distinct
 *  target tokens) without touching the candidate-side arithmetic at all. */
function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
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

  // Compare on the raw score (unchanged from the original design, deliberately NOT an "exact
  // strictly dominates" rule): a report name that exactly equals one lease's name AND is also a
  // genuine token-subset of a DIFFERENT lease's longer name (the wrap/truncation case this module
  // exists to handle, e.g. "REDACTED-675" vs "REDACTED-495") is exactly the kind of coin-flip the
  // ambiguity flag below exists to catch — a same-day adversarial re-review confirmed that an
  // earlier version of this fix which made exact strictly dominate silently converted that
  // legitimate human-review case into an unattended auto-write (real roster pair: "THE BAY AREA
  // CORPORATION" vs "REDACTED-330"). Bounding `overlap()` to [0,1] above is sufficient on
  // its own: a non-exact candidate can now at most TIE an exact match (never exceed it), and a tie
  // between two different leases already sets `ambiguous` below, which blocks any unattended write.
  //
  // Secondary tie-break (2026-09-14 weekly financial-code sweep, Fix C -- REPORTING ONLY): when a
  // DIFFERENT lease ties `best` within epsilon, the reported `best` becomes whichever of the two has
  // the lexicographically smaller leaseId. Before this, `best` was simply the tied lease the loop
  // met first, so the same report name produced a different review-queue row (leaseId, candidate
  // label, and -- because `exact` rides along -- `confidence`) depending on the order of the
  // snapshot's leases array: real roster, "REDACTED-310" reported as "exact ->
  // 401-sunburst..." forward and "high -> 29000-information-lane..." reversed. This changes NOTHING
  // about WHICH ties are flagged: `topCount` still increments on every different-lease tie and is
  // never reset by the swap, so `ambiguous` (topCount > 1) is exactly what it was, and both
  // consumers (partition-confidence.ts, scripts/ar-import.ts) require `!ambiguous` to auto-write.
  // The winner's OWN `exact` flag is carried, deliberately -- reporting the smaller id with the
  // other candidate's flag would be a lie about that candidate. Still not "exact dominates".
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
        if (l.id < best.leaseId) best = { leaseId: l.id, score, candidate: field, exact };
      }
    }
  }

  const confidence: MatchConfidence =
    best.exact ? 'exact' : best.score >= HIGH_FLOOR ? 'high' : best.score >= LOW_FLOOR ? 'low' : 'none';
  if (confidence === 'none') return { leaseId: null, confidence, score: best.score, candidate: null, ambiguous: false };
  return { leaseId: best.leaseId, confidence, score: best.score, candidate: best.candidate, ambiguous: topCount > 1 };
}
