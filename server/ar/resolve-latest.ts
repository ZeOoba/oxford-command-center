// server/ar/resolve-latest.ts
//
// Cross-report resolution for the AR feed (both the headless runner and the interactive script). A
// single inbox sweep — or a human resolving a review-queue backlog days later — can carry rows from
// MORE THAN ONE aging report (a missed run, a corrected re-export dropped next to the original, or
// two property exports). AR aging is a POINT-IN-TIME balance, not additive across reports: the same
// unpaid $5,000 appearing on both the June and July aging is still $5,000 owed, not $10,000. Summing
// across reports (which mergeByLease would do) silently double-counts and mis-dates the balance.
//
// So: within one report, multiple units for a tenant sum (handled upstream by partitionArRows →
// mergeByLease, same as-of). ACROSS reports, the latest as-of SUPERSEDES — a newer report replaces an
// older one for that lease. This module does the cross-report supersede (within one batch:
// resolveLatestArrears) AND the cross-SWEEP/cross-CALLER supersede (against whatever is already
// persisted: filterAgainstPersisted, isSafeToWrite) — every entrance that writes tenantArrears must
// agree on the SAME one rule, or a stale write can silently regress a newer balance through whichever
// entrance skips the check.

import type { TenantArrears } from '../../src/contracts/index';

export interface DatedArrearsWrite {
  leaseId: string;
  /** Arrears buckets plus the report's asOfDate/sourceFile provenance. */
  arrears: TenantArrears;
  tenant: string;
}

/** Comparable as-of instant. null/undefined/unparseable-string/invalid-Date → -Infinity, so any
 *  VALID dated report supersedes an undated (or corrupt-dated) one. Total over every reachable input
 *  — including an invalid Date instance (refute 2026-07-22/determinism: NaN is not comparable via
 *  >=, so an unmapped invalid Date used to reject every future write for that lease forever). */
export function asOfMs(a: TenantArrears): number {
  const d = a.asOfDate;
  if (d instanceof Date) {
    const t = d.getTime();
    return Number.isNaN(t) ? -Infinity : t;
  }
  if (typeof d === 'string') {
    const t = Date.parse(d);
    return Number.isNaN(t) ? -Infinity : t;
  }
  return -Infinity;
}

/** Cent-precision equality — mirrors rent-manager-delinquency.ts's own subtotal cross-check
 *  convention. Real defect (2026-09-06 adversarial review, MEDIUM): comparing bucket floats with
 *  strict `===` made a last-ulp summation difference (the same charges totaled in a different row
 *  order — see merge-buckets.ts/rent-manager-delinquency.ts) register as a genuine disagreement
 *  even though both sides are the same money to the cent. Rounding is defense-in-depth here: both
 *  producers now round their own output to cents, but this comparison must not silently regress if
 *  a future caller doesn't. */
function sameCents(x: number, y: number): boolean {
  return Math.round((x - y) * 100) === 0;
}

/** Whether two arrears records agree on EVERY bucket to the cent, not just the sum (refute round
 *  3/determinism, demonstrated with a repro): a comparison on `sumBuckets` alone treats an
 *  equal-TOTAL, different-DISTRIBUTION pair (e.g. $5,000 re-dated from d60 into d90plus, an
 *  invoice-correction re-export) as harmless agreement and silently keeps whichever row scans
 *  later — but the bucket split is itself a financial signal downstream
 *  (src/analytics/conditions.ts fires CRITICAL only on d90+d90plus, WARNING on d30+d60), so that
 *  "harmless" tie was silently flipping an alert tier on a scan-order coin-flip. Only a full
 *  bucket-vector match (to the cent) is a genuine, safe-to-resolve agreement. */
function sameBuckets(a: TenantArrears, b: TenantArrears): boolean {
  return sameCents(a.d30, b.d30) && sameCents(a.d60, b.d60) && sameCents(a.d90, b.d90) && sameCents(a.d90plus, b.d90plus);
}

/**
 * Keep one arrears record per lease: the one with the latest asOfDate. A dated report beats an
 * undated one. NEVER sums across rows. Returns the winners, the leaseIds that had >1 contributing
 * report (so the caller can surface the supersede rather than let it happen silently), and
 * `ambiguousTies` — leaseIds where two reports share the EXACT same as-of but disagree on ANY bucket
 * (refute 2026-07-22/determinism: picking either side by mere array-scan-order — which on an
 * exact-mtime-tie collapses to filesystem enumeration order — would silently persist a coin-flip
 * financial number; a sum-only comparison missed an equal-total/different-distribution disagreement,
 * which matters because conditions.ts's alert severity is bucket-driven, not total-driven). Ambiguous
 * leaseIds are EXCLUDED from `resolved`; a later, decisively-newer row for the same lease still
 * resolves it normally and clears the ambiguity.
 */
export function resolveLatestArrears(
  rows: readonly DatedArrearsWrite[],
): { resolved: DatedArrearsWrite[]; superseded: string[]; ambiguousTies: string[] } {
  const best = new Map<string, DatedArrearsWrite>();
  const superseded = new Set<string>();
  const ambiguousTies = new Set<string>();
  for (const row of rows) {
    const prev = best.get(row.leaseId);
    if (prev === undefined) {
      best.set(row.leaseId, row);
      continue;
    }
    superseded.add(row.leaseId); // this lease appeared in more than one report this sweep
    const curMs = asOfMs(row.arrears);
    const prevMs = asOfMs(prev.arrears);
    if (curMs > prevMs) {
      best.set(row.leaseId, row);
      ambiguousTies.delete(row.leaseId); // a decisively later row resolves any prior ambiguity
    } else if (curMs === prevMs) {
      if (sameBuckets(row.arrears, prev.arrears)) {
        best.set(row.leaseId, row); // harmless tie — both reports agree on EVERY bucket, not just the sum
      } else {
        ambiguousTies.add(row.leaseId); // same as-of, DIFFERENT bucket vector — refuse to silently pick a side
      }
    }
    // curMs < prevMs: prev already correctly retained; nothing to do.
  }
  return {
    resolved: [...best.values()].filter((r) => !ambiguousTies.has(r.leaseId)),
    superseded: [...superseded],
    ambiguousTies: [...ambiguousTies],
  };
}

export interface RejectedStaleWrite {
  leaseId: string;
  incomingAsOf: Date | string | null | undefined;
  persistedAsOf: Date | string | null | undefined;
}

export interface UndatedConflict {
  leaseId: string;
  persistedAsOf: Date | string | null | undefined;
}

export interface EqualDateOverwrite {
  leaseId: string;
  asOf: Date | string | null | undefined;
}

/**
 * Guard against a WITHIN-SWEEP resolve being undone at the persistence boundary (refute 2026-07-22,
 * all 3 lenses independently): resolveLatestArrears only supersedes rows collected in one sweep/batch.
 * A missed/stale report processed ALONE in a LATER sweep has no competing row to lose to — the naive
 * `{...overlay.tenantArrears, ...newArrears}` merge in the caller would silently let it overwrite a
 * newer persisted balance with no comparison at all. This closes that gap: for each row about to be
 * written, compare its asOfDate against the CURRENTLY-PERSISTED entry for that lease.
 *
 * Three outcomes, not two — refute round 2 found the original two-way split created a NEW regression:
 * an incoming UNDATED report was silently and PERMANENTLY rejected once any dated record ever
 * persisted for that lease (self-reinforcing: every subsequent undated import re-triggers the same
 * rejection, mislabeled "stale" even when the undated file is actually the fresher one). That case is
 * genuinely ambiguous — an undated report's true vintage is unknown, so it must not blindly overwrite
 * a dated record, but it is dishonest to call it "stale" (staleness is unproven, not established) —
 * so it is now split into `undatedConflict`, reported separately for the caller to surface distinctly
 * (never silently, and never mislabeled) rather than folded into `rejectedStale`.
 *
 * A FOURTH signal, `equalDateOverwrite` (refute round 3): an incoming report whose as-of EQUALS the
 * persisted entry's but whose bucket vector DIFFERS is still written (the `>=` tie deliberately
 * favors incoming — a same-day correction must be able to update its own day's entry, which is what
 * makes recovery from an in-sweep `ambiguousTies` refusal possible at all once a decisive re-export
 * lands). But that write was previously indistinguishable in the log from a routine newer-date write
 * — this makes it visible without changing the write decision.
 *
 * This as-of comparison is deliberately NOT applied as a blanket gate on server/brain.ts's
 * general-purpose setTenantArrears, which is also the write path for a human manually correcting a
 * number in the app UI — a manual edit typically carries no asOfDate at all, and blindly rejecting
 * "undated incoming vs dated persisted" there would silently block every manual correction on any
 * lease ever auto-imported. Both PDF-import entrances (scripts/ar-import-headless.ts and
 * scripts/ar-import.ts) call this function directly instead.
 */
export function filterAgainstPersisted(
  rows: readonly DatedArrearsWrite[],
  persisted: Readonly<Record<string, TenantArrears>>,
): {
  toWrite: DatedArrearsWrite[];
  rejectedStale: RejectedStaleWrite[];
  undatedConflict: UndatedConflict[];
  equalDateOverwrite: EqualDateOverwrite[];
} {
  const toWrite: DatedArrearsWrite[] = [];
  const rejectedStale: RejectedStaleWrite[] = [];
  const undatedConflict: UndatedConflict[] = [];
  const equalDateOverwrite: EqualDateOverwrite[] = [];
  for (const row of rows) {
    const existing = persisted[row.leaseId];
    if (existing === undefined) {
      toWrite.push(row);
      continue;
    }
    // Defined via asOfMs itself (refute round 3), not a narrow null/undefined literal check: an
    // unparseable string or invalid Date also has no usable vintage and must take the same honestly
    // labeled path as a null asOfDate, not the "genuinely older" rejectedStale label.
    const incomingMs = asOfMs(row.arrears);
    const existingMs = asOfMs(existing);
    if (incomingMs === -Infinity && existingMs > -Infinity) {
      undatedConflict.push({ leaseId: row.leaseId, persistedAsOf: existing.asOfDate });
      continue;
    }
    if (incomingMs >= existingMs) {
      if (incomingMs === existingMs && !sameBuckets(row.arrears, existing)) {
        equalDateOverwrite.push({ leaseId: row.leaseId, asOf: row.arrears.asOfDate });
      }
      toWrite.push(row);
    } else {
      rejectedStale.push({ leaseId: row.leaseId, incomingAsOf: row.arrears.asOfDate, persistedAsOf: existing.asOfDate });
    }
  }
  return { toWrite, rejectedStale, undatedConflict, equalDateOverwrite };
}
