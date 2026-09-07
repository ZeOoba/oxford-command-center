// server/ar/clear-dropped-leases.ts
//
// Real defect (2026-09-06 adversarial review, HIGH): scripts/ar-import-headless.ts only ever
// WRITES rows present in a report -- it never retracts a persisted arrears record for a lease
// that drops off a NEWER report of the same property/series. Every AR-aging report is a
// point-in-time "Balance: Greater than 0.00" style export, so a tenant absent from a newer
// same-series report has paid down to zero AS OF that report's date; the read model already has
// a concept for this (server/ar/derive-ar-balances.ts: an all-zero record means "checked,
// current", distinct from an ABSENT record, which means "no AR data ever collected"), but nothing
// ever emitted one. The ingest just upserts, so a paid-off ghost sits at its old, aging as-of
// forever. Because src/analytics/conditions.ts's staleness gate is all-or-nothing (ANY stamped
// record older than 35 days suppresses EVERY per-lease collections alert, not just that lease's
// own), a handful of these ghosts silently disabled collections alerting portfolio-wide.
//
// This module supplies the missing retraction step as a pure function. It went through TWO
// same-day adversarial passes before landing here:
//
//   v1 treated "no fresh write this sweep" as "absent from the report". A same-day self-review
//   (5/5 lenses, HIGH) proved that's wrong: a tenant can be PRESENT on the newer report but still
//   fail to produce a write -- routed to the review queue (a name match that fell to 'none'/
//   ambiguous, a lease that flipped Expired between sweeps, a re-let unit) or skipped (a cached
//   SKIP). "Not written" != "not on the report", and the review queue has no resolver (see
//   reference_ar_review_queue_has_no_resolver.md) -- so v1 could silently zero a balance that is
//   still genuinely owed, with no durable trace. v1 also protected a lease for an ENTIRE sweep
//   merely for appearing in ANY write, even one sourced from an OLDER report of the same series
//   processed in the same catch-up sweep -- missing the exact backlog pattern (irregular,
//   hand-pulled exports) that produced the original ghosts.
//
// v2 failed closed on both counts: (1) a series with ANY unresolved row this sweep is entirely
// exempted from clearing -- a report this pipeline could not fully attribute cannot prove any
// tenant paid off; (2) a lease is protected from clearing only if its fresh write this sweep came
// from that series' NEWEST report specifically, not merely "somewhere in the sweep". Both trade
// some clearing effectiveness for correctness ("silent mis-attribution is the worst failure mode").
// A THIRD same-day pass found v2 itself had two more problems, confirmed by running the real
// script against real archived exports in an isolated sandbox:
//
//   (a) v2 counted a cached SKIP the same as a review row for `hadUnresolvedRow`. A SKIP is a
//   durable, ALREADY-RESOLVED human decision ("never attribute this name"), not an ambiguous one --
//   and on the live data, a standing SKIP for a perpetually-reappearing non-tenant name ("(Past)
//   REDACTED-697, Inc.") exempted an entire series from clearing on EVERY sweep,
//   permanently blocking the very ghosts this fix exists to close. Only a REVIEW row (a name/unit
//   the matcher genuinely could not attribute this sweep) triggers the series-wide exemption now;
//   a SKIP is treated as resolved-as-omitted and does not block clearing.
//
//   (b) the CALLER (scripts/ar-import-headless.ts) computed clears against the persisted map BEFORE
//   applying this sweep's writes, then applied writes on top of the clears afterward -- so a
//   catch-up sweep's write sourced from an OLDER report of a series (which this module's
//   sourceFile-scoped protection correctly refuses to protect) got silently re-applied over the
//   clear by the caller's own merge order, reproducing the exact stale-ghost outcome while the
//   console falsely logged the lease as cleared. `applyWritesAndClears` below is the single
//   entry point that gets the order right: it computes clears against the POST-write state and
//   applies them LAST, so a stale same-sweep write can never survive a clear -- while this module's
//   own `asOfMs(existing) >= series.asOfMs` check still protects a legitimately fresh write.

import type { TenantArrears } from '../../src/contracts/index';
import { asOfMs } from './resolve-latest';

/** Strip a report filename down to its recurring SERIES name -- the part shared by every dated
 *  export of the same scheduled report (e.g. "1100 Rarig Delinquency 8.21.2026.xlsx" and a later
 *  "1100 Rarig Delinquency 9.18.2026.xlsx" are the same series). Recognizes both date conventions
 *  this pipeline's own extractAsOfDateFromFilename accepts: the dot form (M.D.YYYY, the live Rent
 *  Manager xlsx convention) and ISO (YYYY-MM-DD, the PDF/QuickBooks convention) -- an earlier
 *  version only stripped the dot form, so every PDF-sourced record was silently its own series and
 *  could never be cleared. Falls back to the whole extension-stripped basename when no trailing
 *  date is found (including a filename carrying a Windows auto-dedup "(1)" suffix AFTER the date,
 *  which deliberately does NOT strip to the same key as its un-suffixed sibling -- an earlier
 *  version stripped that suffix too, which let two DIFFERENT properties whose exports happened to
 *  share a generic default filename on the same day collide into one series and clear each other;
 *  failing to recognize a series is always safe here (a missed clear), so an unrecognized filename
 *  keying to itself is the correct, conservative default). Lowercased for case-insensitive
 *  comparison. */
export function reportSeriesKey(sourceFile: string): string {
  const noExt = sourceFile.replace(/\.[^./\\]+$/, '');
  const m = noExt.match(/^(.*?)[\s_-]+(?:\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2})$/);
  return (m?.[1] ?? noExt).trim().toLowerCase();
}

export interface SweepReportInfo {
  sourceFile: string;
  /** The report's own as-of date; null when it couldn't be recovered (extractAsOfDateFromFilename
   *  / the in-file "Current tenants as of" line both came up empty). A series with no dated report
   *  this sweep is skipped entirely -- never clear a persisted record against an unknown date. */
  asOfDate: Date | null;
  /** True when this report produced at least one row QUEUED FOR REVIEW this sweep -- a name/unit
   *  the matcher genuinely could not attribute (ambiguous tie, below-floor confidence, an Expired
   *  lease excluded from the roster, an unresolved Format-B unit). Such a report does not prove any
   *  OTHER tenant on it paid off: the unattributed row might be the very lease a stale persisted
   *  record belongs to, just under a name/unit the matcher no longer resolves. A series with any
   *  such report this sweep is exempted from clearing entirely, not just for the unresolved row's
   *  own lease -- fail closed rather than try to prove a negative from a queue entry that carries
   *  no reliable leaseId (an Expired-lease name match returns null, not a candidate to protect).
   *
   *  Deliberately EXCLUDES a cached-SKIP row: a SKIP is a durable, already-resolved human decision
   *  ("never attribute this name"), not an ambiguous one, and on live data a standing SKIP for a
   *  perpetually-reappearing non-tenant name would otherwise exempt its whole series from clearing
   *  forever. Set this from review-queue rows only; do NOT fold a skip count into it. */
  hadUnresolvedRow: boolean;
}

/** One lease actually written this sweep, with the file it was written FROM -- used to scope
 *  "protected from clearing" to the series' newest report specifically, not the whole sweep. */
export interface SweepWrite {
  leaseId: string;
  sourceFile: string | null;
}

/**
 * For every persisted lease whose arrears record was stamped by a report in a SERIES this sweep
 * also fully attributed (no review/skip row anywhere in that series this sweep), whose stamped
 * date is strictly older than that series' as-of THIS sweep, and that was NOT written this sweep
 * FROM that series' newest report specifically -- the tenant is absent from the newer report --
 * return an all-zero record dated to the new report. Also left untouched: a lease with no
 * `sourceFile` provenance (a manual overlay entry), a record already at or past the new as-of, and
 * an UNDATED persisted record (asOfDate null/unparseable) -- this pipeline's own filterAgainstPersisted
 * refuses to call an undated record "stale" for the same reason (its true vintage is unproven, not
 * established), so clearing it here would contradict that existing doctrine.
 */
export function computeDroppedLeaseClears(
  persisted: Readonly<Record<string, TenantArrears>>,
  sweepReports: ReadonlyArray<SweepReportInfo>,
  sweepWrites: ReadonlyArray<SweepWrite>,
): Record<string, TenantArrears> {
  // Newest dated report per series processed this sweep, and which series had ANY unresolved row.
  const seriesNewest = new Map<string, { asOfMs: number; asOfDate: Date; sourceFile: string }>();
  const seriesUnresolved = new Set<string>();
  for (const r of sweepReports) {
    const key = reportSeriesKey(r.sourceFile);
    if (r.hadUnresolvedRow) seriesUnresolved.add(key);
    if (!r.asOfDate || Number.isNaN(r.asOfDate.getTime())) continue;
    const ms = r.asOfDate.getTime();
    const cur = seriesNewest.get(key);
    if (!cur || ms > cur.asOfMs) seriesNewest.set(key, { asOfMs: ms, asOfDate: r.asOfDate, sourceFile: r.sourceFile });
  }
  if (seriesNewest.size === 0) return {};

  // A lease is protected from clearing for series S only if THIS sweep wrote it from S's newest
  // report specifically -- a write sourced from an OLDER report of S (a catch-up sweep processing
  // two dates of one series at once) must not block the clear.
  const writtenFromFile = new Set(sweepWrites.map((w) => `${w.leaseId}::${w.sourceFile ?? ''}`));

  const clears: Record<string, TenantArrears> = {};
  for (const [leaseId, existing] of Object.entries(persisted)) {
    if (!existing.sourceFile) continue; // no report provenance (manual entry) -- never auto-cleared
    if (asOfMs(existing) === -Infinity) continue; // undated vintage is unproven, not "old" -- never auto-cleared
    const key = reportSeriesKey(existing.sourceFile);
    if (seriesUnresolved.has(key)) continue; // this series had a row this sweep we could not attribute -- can't prove absence
    const series = seriesNewest.get(key);
    if (!series) continue; // no report of this lease's series ran this sweep
    if (writtenFromFile.has(`${leaseId}::${series.sourceFile}`)) continue; // written from THIS series' newest report this sweep
    if (asOfMs(existing) >= series.asOfMs) continue; // already current (or already the zero record)
    clears[leaseId] = { d30: 0, d60: 0, d90: 0, d90plus: 0, asOfDate: series.asOfDate, sourceFile: series.sourceFile };
  }
  return clears;
}

/**
 * The single, correctly-ordered entry point for a sweep's write-then-clear step. Computing clears
 * against the PRE-write persisted map and applying this sweep's writes afterward (the caller's
 * original approach) lets a same-sweep write sourced from an OLDER report of a series silently
 * override a clear that was correctly computed for it -- see the module doc above. This function
 * stages `toWrite` onto `persisted` FIRST, computes clears against that staged state, then applies
 * the clears LAST so they win over any stale write for the same lease this sweep; a legitimately
 * fresh write (from the series' own newest report, or simply a series computeDroppedLeaseClears
 * doesn't touch) is unaffected, since `computeDroppedLeaseClears`'s own `asOfMs` and
 * sourceFile-scoped protection checks run against the same staged state a caller would otherwise
 * have to reconstruct by hand.
 */
export function applyWritesAndClears(
  persisted: Readonly<Record<string, TenantArrears>>,
  sweepReports: ReadonlyArray<SweepReportInfo>,
  toWrite: ReadonlyArray<{ leaseId: string; arrears: TenantArrears }>,
): { newArrears: Record<string, TenantArrears>; clearedLeaseIds: string[] } {
  const staged: Record<string, TenantArrears> = { ...persisted };
  for (const r of toWrite) staged[r.leaseId] = r.arrears;
  const sweepWrites: SweepWrite[] = toWrite.map((r) => ({ leaseId: r.leaseId, sourceFile: r.arrears.sourceFile ?? null }));
  const clears = computeDroppedLeaseClears(staged, sweepReports, sweepWrites);
  const newArrears: Record<string, TenantArrears> = {};
  for (const r of toWrite) newArrears[r.leaseId] = r.arrears;
  Object.assign(newArrears, clears); // clears win over a stale (older-report) write for the same lease this sweep
  return { newArrears, clearedLeaseIds: Object.keys(clears) };
}
