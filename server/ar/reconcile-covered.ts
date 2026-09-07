// server/ar/reconcile-covered.ts
//
// Stale-row reconcile for the AR feed.
//
// THE DEFECT THIS EXISTS TO FIX. A delinquency export lists ONLY currently-delinquent tenants. A
// tenant who pays in full simply vanishes from the next report. Every tenantArrears write path is a
// spread merge (`{ ...overlay.tenantArrears, ...newArrears }` in scripts/ar-import-headless.ts, and
// the same in patchSnapshot), so a row is only ever added or overwritten — never cleared. A paid-off
// tenant therefore keeps their last non-zero balance and their last asOfDate FOREVER.
//
// That is not merely a cosmetic overstatement. src/analytics/conditions.ts's staleness gate degrades
// on the WORST stamped record: if ANY tenantArrears row is older than arStalenessMaxDays, `ar-stale`
// fires and ALL per-lease collections alerting is suppressed portfolio-wide. So a handful of tenants
// who paid months ago silently disable collections monitoring for every current tenant, while every
// source file in the inbox is fresh. Observed live 2026-09-02: 7 rows stamped 2026-07-15 (52 days,
// $19,152.40) held the gate shut across 37 fresh rows stamped 2026-08-21.
//
// WHY NOT SIMPLY "EVICT WHAT VANISHED". Absence of a row is ambiguous: it means "paid" only if the
// report actually COVERED that tenant AND the pipeline did not itself suppress the row. That second
// half is the one an earlier draft of this module got wrong and an adversarial review caught with an
// executed repro: the caller's `written` set is what survived SIX deliberate suppressions
// (rejectedStale, undatedConflict, ambiguousTies, review-queue routing, cache-'SKIP', dead-leaseId
// roster rejection), so treating "not in written" as "paid" silently zeroed balances the pipeline
// had just read and consciously refused to write — $18,333.71 at 1100 Rarig in the repro, including
// one $12,380.94 row sitting unresolved in the review queue. Hence `seen`: the caller must pass every
// leaseId this sweep touched in ANY way, and `written` is used ONLY as coverage/as-of evidence.
//
// This is the same class of ambiguity server/warehouse/debt-snapshot.ts hardened over rounds
// 18/19/19b/19e ("no way to tell the parser broke from you just paid off your last loan"), and this
// module keeps its posture: an ambiguous signal is NEVER resolved by guessing, and the conservative
// branch leaves a stale-but-honest row rather than risk a false all-clear.
//
// THE RULE.
//   1. A property is COVERED only if this run wrote >=1 VALIDLY-DATED row for it — structural proof
//      from the data itself that the run saw that property.
//   2. A persisted row is a CANDIDATE only if it is: not written this run, not `seen` (not suppressed
//      anywhere in the pipeline), mapped to a property in the roster, at a covered property, and NOT
//      on an Expired lease (a move-out balance is the most collectible-and-contested AR there is;
//      "absent = paid" is only a valid inference for a lease the matcher can still re-attribute).
//   3. A candidate is reconciled against the EARLIEST report of that property whose as-of is >= the
//      row's own stamp — never the property's max. Using the max fabricates a freshness no evidence
//      supports and, worse, makes the zero DURABLE: filterAgainstPersisted then rejects every later
//      report older than the fabricated stamp, so the row can never recover.
//   4. A row with a positive balance is ZEROED and re-stamped. A row already at zero — or carrying a
//      CREDIT (negative bucket, a prepayment) — is RE-STAMPED ONLY, never zeroed. Re-stamping these
//      is not optional bookkeeping: skipping them (as an earlier draft did) freezes their stamp
//      forever, and since conditions.ts gates on every stamped entry regardless of balance, those
//      frozen zeros become the new worst record and re-fire `ar-stale` permanently ~35 days later —
//      the module would have re-created the exact bug it exists to fix.
//   5. A property whose candidate zeroing would EXCEED the number of rows the run wrote for it is
//      REFUSED wholesale. That is the shape of a partial export (one propertyId can span several
//      buildings — `sepich-portfolio-columbus-oh-8-props` covers eight — so a file listing building
//      A but silently omitting building B is indistinguishable, at this granularity, from "B all
//      paid"). Refusing on that shape is the guard; `byProperty` is the report.
//
// Zeroing rather than deleting is the contract's own intent — src/contracts/quickbooks.ts: "An
// all-zero entry means 'checked, current' — distinct from an ABSENT entry, which means 'no AR
// data'." The re-stamp is what actually releases the staleness gate.
//
// KNOWN RESIDUAL, deliberately not solved here. A cache-'SKIP' row (a human previously chose to omit
// a tenant-name mapping) carries NO resolvable leaseId by construction, so it cannot be added to
// `seen`. Such a row is protected only by rule 5's refusal and by rule 2's Expired skip. This is
// recorded rather than papered over: it is a real, bounded hole, and the honest statement is that
// the caller cannot enumerate it.

import type { TenantArrears } from '../../src/contracts/index';

/** Minimal lease roster shape — matches loadUnitLeasesFromSnapshot() in ar-import-headless.ts. */
export interface LeaseProperty {
  id: string;
  propertyId: string | null;
  /** Snapshot lease status. 'Expired' is never reconciled — see rule 2. */
  status?: string | null;
}

export interface ReconcileInput {
  /** The CURRENT tenantArrears map (pre-merge). */
  persisted: Readonly<Record<string, TenantArrears>>;
  /** Rows this run is actually writing. Used ONLY as coverage proof and as-of evidence. */
  written: Readonly<Record<string, TenantArrears>>;
  /**
   * EVERY leaseId this sweep touched in any way — written, queued for review, ambiguous-tie,
   * rejected-stale, undated-conflict. A leaseId in here is never reconciled, because the pipeline
   * saw it and made a decision about it; its absence from `written` is a suppression, not a payment.
   */
  seen: ReadonlySet<string>;
  /** Lease roster supplying leaseId -> propertyId and status. */
  leases: readonly LeaseProperty[];
}

export interface ReconcileResult {
  /** leaseId -> zeroed, re-stamped arrears. Merge over the persisted map. */
  zeroed: Record<string, TenantArrears>;
  /** leaseId -> re-stamped only (was already zero, or carries a credit). Merge the same way. */
  restamped: Record<string, TenantArrears>;
  /** Dollars removed from the book by this reconcile. Accumulated in integer cents. */
  clearedUsd: number;
  /** Properties this run provably covered (>=1 validly-dated written row). */
  coveredPropertyIds: string[];
  /** Left alone — this run carried no data for their property. */
  skippedUncovered: string[];
  /** Left alone — lease absent from the roster, property unknowable, never guessed. */
  skippedUnmapped: string[];
  /** Left alone — strictly newer than every qualifying report for their property. */
  skippedNewer: string[];
  /** Left alone — the pipeline saw and suppressed this lease this sweep (see `seen`). */
  skippedSuppressed: string[];
  /** Left alone — Expired lease; a move-out balance is never auto-cleared. */
  skippedExpired: string[];
  /** Properties refused wholesale under rule 5, with the shape that triggered the refusal. */
  refusedProperties: Array<{ propertyId: string; written: number; wouldZero: number; leaseIds: string[] }>;
  /** Per-property shape: rows WRITTEN vs zeroed/re-stamped. `wouldZero > written` is a partial export. */
  byProperty: Record<string, { written: number; zeroed: number; restamped: number; clearedUsd: number }>;
}

/** Comparable as-of instant, matching server/ar/resolve-latest.ts: null/unparseable -> -Infinity. */
function asOfMs(a: TenantArrears | undefined): number {
  const d = a?.asOfDate;
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

/** Signed bucket total. NOT clamped: a negative total is a credit/prepayment and must stay visible,
 *  so it takes the re-stamp-only path rather than being zeroed as if it were a paid balance. */
function signedTotal(a: TenantArrears): number {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return n(a.d30) + n(a.d60) + n(a.d90) + n(a.d90plus);
}

const cents = (usd: number): number => Math.round(usd * 100);

/**
 * Reconcile persisted arrears against what this run saw, scoped to the properties the run provably
 * covered. Pure: returns the rows to change, never mutates its inputs.
 */
export function reconcileCoveredProperties(input: ReconcileInput): ReconcileResult {
  const { persisted, written, seen, leases } = input;

  const out: ReconcileResult = {
    zeroed: {}, restamped: {}, clearedUsd: 0, coveredPropertyIds: [],
    skippedUncovered: [], skippedUnmapped: [], skippedNewer: [],
    skippedSuppressed: [], skippedExpired: [],
    refusedProperties: [], byProperty: {},
  };

  // GUARD (debt-snapshot H2a, adapted): an empty incoming set is far more likely to mean an upstream
  // failure than a genuinely arrears-free portfolio, and the two are indistinguishable once the rows
  // are gone. Never reconcile anything on emptiness alone.
  if (Object.keys(written).length === 0) return out;

  const propertyOf = new Map<string, string>();
  const statusOf = new Map<string, string>();
  for (const l of leases) {
    if (l.propertyId) propertyOf.set(l.id, l.propertyId);
    if (l.status) statusOf.set(l.id, l.status);
  }

  // Per property, the DISTINCT as-of instants of the reports that contributed rows this run. Kept as
  // a sorted list, not a max, so a candidate can be reconciled against the EARLIEST report that
  // actually supersedes it (rule 3).
  const reportAsOfs = new Map<string, number[]>();
  const writtenByProperty = new Map<string, number>();
  for (const [leaseId, a] of Object.entries(written)) {
    const pid = propertyOf.get(leaseId);
    if (!pid) continue;
    writtenByProperty.set(pid, (writtenByProperty.get(pid) ?? 0) + 1);
    const ms = asOfMs(a);
    if (!Number.isFinite(ms)) continue;
    const list = reportAsOfs.get(pid);
    if (list === undefined) reportAsOfs.set(pid, [ms]);
    else if (!list.includes(ms)) list.push(ms);
  }
  for (const list of reportAsOfs.values()) list.sort((x, y) => x - y);
  if (reportAsOfs.size === 0) return out;

  out.coveredPropertyIds = [...reportAsOfs.keys()].sort();
  for (const pid of out.coveredPropertyIds) {
    out.byProperty[pid] = { written: writtenByProperty.get(pid) ?? 0, zeroed: 0, restamped: 0, clearedUsd: 0 };
  }

  // PASS 1 — classify candidates without committing, so rule 5's refusal can see the whole shape.
  interface Candidate { leaseId: string; pid: string; stampMs: number; prior: number; zero: boolean }
  const candidates: Candidate[] = [];

  for (const [leaseId, existing] of Object.entries(persisted)) {
    if (leaseId in written) continue;                                   // refreshed this run
    if (seen.has(leaseId)) { out.skippedSuppressed.push(leaseId); continue; }

    const pid = propertyOf.get(leaseId);
    if (!pid) { out.skippedUnmapped.push(leaseId); continue; }
    if (!reportAsOfs.has(pid)) { out.skippedUncovered.push(leaseId); continue; }
    if ((statusOf.get(leaseId) ?? '').toLowerCase() === 'expired') { out.skippedExpired.push(leaseId); continue; }

    const rowMs = asOfMs(existing);
    // EARLIEST qualifying report, not the property max (rule 3).
    const qualifying = reportAsOfs.get(pid)!.find((ms) => ms >= rowMs);
    if (qualifying === undefined) { out.skippedNewer.push(leaseId); continue; }

    const prior = signedTotal(existing);
    candidates.push({ leaseId, pid, stampMs: qualifying, prior, zero: prior > 0 });
  }

  // PASS 2 — rule 5. A property that would lose more balances than it gained rows is the shape of a
  // partial export; refuse the whole property rather than guess which building was omitted.
  const zeroCountByProperty = new Map<string, number>();
  for (const c of candidates) if (c.zero) zeroCountByProperty.set(c.pid, (zeroCountByProperty.get(c.pid) ?? 0) + 1);
  const refused = new Set<string>();
  for (const [pid, wouldZero] of zeroCountByProperty) {
    const w = writtenByProperty.get(pid) ?? 0;
    if (wouldZero > w) {
      refused.add(pid);
      out.refusedProperties.push({
        propertyId: pid, written: w, wouldZero,
        leaseIds: candidates.filter((c) => c.pid === pid).map((c) => c.leaseId).sort(),
      });
    }
  }

  // PASS 3 — commit. A refusal blocks ZEROING only, never re-stamping: a re-stamp moves no money
  // (the row is already at zero or is a credit), so withholding it buys no safety and would leave
  // that row's stale clock frozen forever — rule 4's defect, re-created at exactly the properties
  // we are most suspicious of.
  let clearedCents = 0;
  for (const c of candidates) {
    if (refused.has(c.pid) && c.zero) continue;
    const existing = persisted[c.leaseId]!;
    const stamped = { ...existing, asOfDate: new Date(c.stampMs) };
    const bucket = out.byProperty[c.pid];
    if (c.zero) {
      out.zeroed[c.leaseId] = {
        ...stamped, d30: 0, d60: 0, d90: 0, d90plus: 0,
        sourceFile: 'reconciled: absent from a covering report',
      };
      clearedCents += cents(c.prior);
      if (bucket) { bucket.zeroed += 1; bucket.clearedUsd += c.prior; }
    } else {
      // Already zero, or a credit. Re-stamp ONLY — balance untouched, but the stale clock is
      // released so this row cannot become the next worst-stamped record (rule 4).
      out.restamped[c.leaseId] = stamped;
      if (bucket) bucket.restamped += 1;
    }
  }
  out.clearedUsd = clearedCents / 100;
  for (const b of Object.values(out.byProperty)) b.clearedUsd = Math.round(b.clearedUsd * 100) / 100;

  out.skippedUncovered.sort();
  out.skippedUnmapped.sort();
  out.skippedNewer.sort();
  out.skippedSuppressed.sort();
  out.skippedExpired.sort();
  out.refusedProperties.sort((a, b) => a.propertyId.localeCompare(b.propertyId));
  return out;
}
