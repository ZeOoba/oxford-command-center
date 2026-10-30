/**
 * scripts/ar-import-headless.ts
 *
 * HEADLESS AR-aging feed (Layer 2) — the unattended counterpart to the interactive
 * scripts/ar-import.ts. Built for a scheduled task: no prompts, no running server required.
 *
 * Per-run pipeline:
 *   scan AR_INBOX/*.pdf + *.xlsx — TWO parse branches, then a shared attribute/write path
 *     → xlsx: ExcelJS → ordered detect (each detector's row-1 check is disjoint, so the order is
 *             chosen for readability/frequency, not correctness):
 *               · rent-manager-delinquency  ("Delinquency (Detail)")
 *               · delinquency-transactional (Yardi "DB Caption:")
 *               · delinquency-bucketed      (two-bucket, unit-only "Delinquency")
 *       pdf:  pdfplumber text (server/ar/pdf-extract) → parse (server/ar/ar-aging — Yardi/AppFolio
 *             "Aging Detail" ONLY; an RM delinquency report is unsupported *as a PDF*, though the
 *             xlsx form of that same report parses fine via the first detector above)
 *     → attribute each row to a lease — which matcher runs depends on the format:
 *          · delinquency-bucketed → by UNIT (server/ar/resolve-by-unit). Format B carries NO tenant
 *            name, so it cannot use the name-matching path; it resolves and logs in its own branch.
 *          · every other format   → by NAME (server/ar/partition-confidence — AUTO-WRITE
 *            HIGH-CONFIDENCE ONLY)
 *               · exact / high-≥2-token / cache-confirmed  → write
 *               · everything else                          → review queue (never written)
 *     → write overlay (canonical) + patch snapshot (immediate 4c visibility)
 *     → append review queue · update mapping cache · archive the source file (pdf or xlsx alike)
 *
 * SAFETY: mirrors the interactive script's `autoAccept` rule exactly — a below-high-confidence or
 * ambiguous match is NEVER auto-attributed. Those land in AR_INBOX/../review-queue.json, which NOTHING
 * reads back — it is a report surface, not a work queue with a tool behind it. A queued row is resolved
 * by fixing the MATCHER (server/ar/resolve-by-unit.ts, or resolvePropertyId below) so the row attributes
 * by rule, then re-feeding its source file from ../processed back into AR_INBOX and re-running THIS
 * script; a re-import at the same as-of date overwrites the prior entry (resolve-latest.ts's `>=` tie).
 * scripts/ar-import.ts is NOT that tool: it takes a PDF path on argv and needs a running server.
 * Silent mis-attribution of a delinquency is the worst failure mode and this run cannot produce one.
 * Guards closing paths two rounds of 2026-07-22 adversarial refute passes found: a cache-confirmed
 * leaseId is validated against the CURRENT lease roster
 * (vacated-tenant dead leaseId → review, not a silent write-to-nowhere); an incoming report is
 * checked against the ALREADY-PERSISTED arrears for that lease, not just other rows in the same
 * sweep, before being written (server/ar/resolve-latest.ts's filterAgainstPersisted); the SAME
 * comparison is now also applied by the interactive script's write path, since the reports a human
 * hand-imports there are by construction the OLDEST, most stale ones; two reports sharing an exact
 * as-of date but reporting DIFFERENT totals are never silently resolved either way
 * (ambiguousTies); and an empty/degraded lease roster halts the run instead of silently routing every
 * cache-confirmed row to review.
 *
 * WRITE PATH (documented design choice): writes arrears directly to the overlay file on disk
 * (data/overlay.json — the canonical mutation store) AND patches the persisted snapshot
 * (portfolio.json) in place so the daily brief's 4c sees the numbers this morning without waiting
 * for a full Brain refresh.
 *
 * CONCURRENCY WITH A RUNNING SERVER (roadmap 2026-10-30 item 1.5 — supersedes the 2026-07-22
 * "known architectural limitation" caveat that used to stand here): Brain no longer saves its
 * startup copy of the overlay. Every server write-back is a queued read-modify-write against
 * overlay.json as it is on disk (server/overlay.ts mutateOverlay), so a sweep that lands while
 * `npm run dev` is up is carried forward by the next UI action rather than erased. The remaining
 * window is THIS script's own: it reads the overlay, computes, then saves the whole object through
 * saveOverlay, which takes its identity baseline only at save time and does not re-check before the
 * first rename. A server write-back published anywhere from loadOverlay() below through that rename
 * is overwritten. It also still reads the file twice (precondition, then loadOverlay, which fails
 * open to EMPTY on a lock between the two). Moving this script onto mutateOverlay closes both; until
 * then, stopping the server for a sweep removes the window entirely.
 *
 * If the overlay write itself fails (disk/permissions), the run does NOT patch the snapshot, archive
 * the inbox PDFs, or report success — see main()'s overlayWriteFailed branch.
 *
 * Usage:  npx tsx scripts/ar-import-headless.ts
 * Env:    AR_INBOX (default data/ar/inbox), ORA_PYTHON, AR_MAPPING_CACHE, SNAPSHOT_PATH
 * Exit:   0 on a completed sweep (per-file parse/format failures are logged + quarantined, not
 *         fatal); 1 if the canonical overlay write fails — the scheduled-task health monitor must
 *         see that as a real failure, not a silent no-op.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import ExcelJS from 'exceljs';
import { extractPdfText } from '../server/ar/pdf-extract';
import { parseArAging, isGarbageExtraction, extractAsOfDateFromFilename, type ArAgingRow } from '../server/ar/ar-aging';
import { detectRentManagerDelinquencyDetail, parseRentManagerWorksheet, type SubtotalMismatch } from '../server/ar/rent-manager-delinquency';
import { detectDelinquencyTransactional, parseDelinquencyTransactional } from '../server/ar/delinquency-transactional';
import { detectDelinquencyBucketed, parseDelinquencyBucketed, type BucketedUnitRow } from '../server/ar/delinquency-bucketed';
import { resolveByUnit, unitCandidates, expandUnitTokens, type UnitLease, type UnitResolution } from '../server/ar/resolve-by-unit';
import { isDeadLease } from '../server/ar/lease-liveness';
import { partitionArRows, type ArReviewRow } from '../server/ar/partition-confidence';
import { resolveLatestArrears, filterAgainstPersisted } from '../server/ar/resolve-latest';
import { applyWritesAndClears, type SweepReportInfo } from '../server/ar/clear-dropped-leases';
import { loadCache, saveCache, cacheKey } from '../server/ar/mapping-cache';
import { loadOverlay, saveOverlay, overlayPath, evaluateOverlayPrecondition } from '../server/overlay';
import { deriveArBalances } from '../server/ar/derive-ar-balances';
import { renameSyncWithRetry } from '../server/lib/rename-retry';
import { SNAPSHOT_PATH } from '../server/config';
import type { LeaseLite } from '../server/ar/match-tenant';
import type { TenantArrears } from '../src/contracts/index';

const INBOX = process.env.AR_INBOX ?? join(process.cwd(), 'data', 'ar', 'inbox');
const AR_ROOT = dirname(INBOX);
const PROCESSED = join(AR_ROOT, 'processed');
const FAILED = join(AR_ROOT, 'failed');
const REVIEW_QUEUE = join(AR_ROOT, 'review-queue.json');

export interface QueuedReview extends ArReviewRow {
  sourceFile: string;
  queuedAt: string;
  // ---- Format B (unit-only) rows ONLY -- absent on name-matched rows (2026-09-14 sweep, Fix B).
  // A Format B row carries no tenant name, so the fields below give the queue what the name path
  // gets for free: a stable identity for the source row, and a hint at who it is.
  /** The report's as-of date (ISO). With `unit`, `sourceFile` and the bucket sum it identifies ONE
   *  real-world source row across parse shapes -- see sourceRowKey. */
  asOfDate?: string | null;
  /** The resolved portfolio property id (BUCKETED_PROPERTY_HEADERS), or null when the header did not
   *  map. Part of the source-row identity: a multi-property export lists several buildings, and one
   *  building's 'C4' is not another's (refute of Fix B, 2026-09-22 -- without this, an UNMAPPED
   *  building's row that happened to share unit tokens and cents with a mapped building's write in
   *  the same file was silently dropped from the queue instead of surfacing its header). */
  propertyId?: string | null;
  /** The unit label exactly as the export printed it (annotation included), e.g. 'C 4 (storage)'. */
  unit?: string | null;
  /** Who the lease roster puts at this unit, ANY status ('Anibal Morales [Expired]'), joined with
   *  ' | ' when several -- DISPLAY ONLY. Never a matching input. */
  candidateTenant?: string | null;
  candidateLeaseIds?: string[];
  /** The mapping cache's standing ruling for the candidate name(s), e.g. 'anibal morales → SKIP'
   *  -- surfaced so a durable name-keyed human decision is VISIBLE from a unit-keyed row. Never
   *  auto-applied: a SKIP ruled on a name-matched row has different provenance than this one. */
  candidateCacheRuling?: string | null;
}

/** Read {id, tenantName, company} for every lease from the persisted snapshot, EXCLUDING any DEAD
 *  lease (server/ar/lease-liveness.ts's isDeadLease: status 'Expired' or 'Vacant', or annualRent 0).
 *  An exact tenant-name hit against a dead lease auto-writes at 'exact' confidence with no human
 *  review (matchTenantToLease has no status awareness) -- the 2026-08-24 integrity-sweep incident:
 *  a human SKIP ruling on an Expired lease's residual delinquency (2207-northwood-c4-anibal-morales,
 *  "no current occupant") was silently reversed the next time this loader fed that same dead lease
 *  back into the matcher. Dropping dead leases from the candidate pool entirely means a
 *  current-period export naming a vacated tenant can no longer auto-attribute -- it falls through
 *  to 'none' confidence and lands in the review queue instead, which is the correct place for a
 *  human to re-confirm a SKIP or re-attribute to whatever now occupies the unit.
 *
 *  Widened from Expired-only on 2026-09-14 (weekly financial-code sweep, Fix A): an Active lease
 *  carrying $0 rent (Tyson Consulting Group #202, Evans Gymnastics A15 -- roster placeholders that
 *  bill nothing) and a 'Vacant' record were still live candidates here. The predicate is shared
 *  with resolveByUnit so the two fresh-match pools cannot drift apart again. */
export function loadLeasesFromSnapshot(): LeaseLite[] {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`Snapshot not found at ${SNAPSHOT_PATH} — run a Brain refresh first (npm run dev).`);
  }
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
    leases?: Array<{ id: string; tenantName: string; company: string | null; status?: string | null; annualRent?: number | null; monthlyRent?: number | null }>;
  };
  return (snap.leases ?? [])
    .filter((l) => !isDeadLease(l))
    .map((l) => ({ id: l.id, tenantName: l.tenantName, company: l.company ?? null }));
}

/** Every lease id in the snapshot, INCLUDING Expired ones -- the wider roster partitionArRows'
 *  cache-hit validation needs (2026-08-24, PR #302 review finding). loadLeasesFromSnapshot's
 *  Expired-exclusion protects the FRESH-match path (a name hit that just happens to land on a dead
 *  lease), but a PREVIOUSLY human-CONFIRMED cache mapping to an Expired lease is a different,
 *  already-trusted decision -- excluding those ids too made partitionArRows' `leaseIds.has(cached)`
 *  check reject live, confirmed mappings as "lease removed/vacated", silently freezing real arrears
 *  behind a resolver-less review queue.
 *
 *  DELIBERATELY NOT narrowed by isDeadLease (2026-09-14 sweep, Fix A): the same reasoning applies
 *  verbatim to the wider dead set -- the real cache entry "tyson consulting group" maps to a lease
 *  that is Active with $0 rent, and that confirmed mapping must keep writing. */
export function loadAllLeaseIdsFromSnapshot(): Set<string> {
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as { leases?: Array<{ id: string }> };
  return new Set((snap.leases ?? []).map((l) => l.id));
}

/** Read {id, unit, propertyId, status} for every lease from the persisted snapshot, for Format B's
 *  (property, unit) resolution — a different projection than loadLeasesFromSnapshot's
 *  {id, tenantName, company}, which match-tenant.ts's NAME-based matching needs instead. Kept as a
 *  separate loader rather than widening LeaseLite itself: LeaseLite is a shared type match-tenant.ts
 *  exports, and widening it would ripple into every consumer of name-based matching for no reason.
 *
 * INCLUDES Expired leases, unlike loadLeasesFromSnapshot above (2026-08-24 integrity sweep, Finding
 * 1 follow-up, corrected after a further PR #302 review round): an EARLIER version of this fix
 * excluded them here too, mirroring the name-based loader -- but that opened an adjacent hole on a
 * re-let unit (an Expired lease and a new Active lease sharing the same unit label): excluding the
 * Expired lease turned a 2-hit AMBIGUOUS match (the safe pre-fix outcome) into a 1-hit EXACT
 * auto-write of the vacated tenant's arrears onto the NEW tenant's lease, with no tenant name in a
 * Format B row to catch the swap. resolveByUnit (server/ar/resolve-by-unit.ts) now does the
 * Expired-aware filtering itself, INSIDE resolution, so it can detect exactly this "Expired sibling
 * on the same unit" case and downgrade to review instead.
 *
 * Also carries annualRent (2026-09-14 sweep, Fix A -- resolveByUnit's live-hit filter now uses the
 * shared isDeadLease predicate, which needs it to see a zero-rent Active placeholder as dead) and
 * tenantName (Fix B -- so a Format B row that lands in the review queue can name who the roster
 * says is at that unit, since the row itself carries no tenant name). */
export function loadUnitLeasesFromSnapshot(): UnitLease[] {
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
    leases?: Array<{ id: string; unit: string | null; propertyId: string; status?: string | null; annualRent?: number | null; monthlyRent?: number | null; tenantName?: string | null }>;
  };
  return (snap.leases ?? []).map((l) => ({
    id: l.id,
    unit: l.unit,
    propertyId: l.propertyId,
    status: l.status ?? null,
    annualRent: l.annualRent ?? null,
    monthlyRent: l.monthlyRent ?? null,
    tenantName: l.tenantName ?? null,
  }));
}

// Format B's group-header text -> portfolio.json property id. EXPLICIT table, not a fuzzy/substring
// guess: verified against the one real Format B source (2203-2207 Northwood, 2026-08-16) — all three
// of its group headers, including the source's own 'Nothwood' typo, map to the SAME single property
// record (2203-2207-northwood-dr-salisbury-md covers all three buildings). A header not in this table
// returns null, which routes every row under it to review rather than guessing a property — the same
// "never guess across the portfolio" rule resolve-by-unit.ts applies to units. Add an entry here only
// after confirming a NEW Format B source's real header strings against a real property id; never widen
// this to a substring/keyword match.
const NORTHWOOD_PROPERTY_ID = '2203-2207-northwood-dr-salisbury-md';
const BUCKETED_PROPERTY_HEADERS: ReadonlyMap<string, string> = new Map([
  ['nbc-a - 2207 Nothwood Drive Bldg A Salisbury, MD 21801', NORTHWOOD_PROPERTY_ID],
  ['nbc-b - 2205 Northwood Drive Bldg B Salisbury, MD 21801', NORTHWOOD_PROPERTY_ID],
  ['nbc-c - 2203 Marvel Road Salisbury, MD 21801', NORTHWOOD_PROPERTY_ID],
]);

function resolvePropertyId(header: string | null): string | null {
  if (header === null) return null;
  return BUCKETED_PROPERTY_HEADERS.get(header) ?? null;
}

/** Patch the persisted snapshot's tenantArrears + recomputed arBalances in place (immediate 4c visibility). */
export function patchSnapshot(newArrears: Record<string, TenantArrears>): void {
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
    leases?: unknown[];
    tenantArrears?: Record<string, TenantArrears>;
    arBalances?: unknown;
  };
  snap.tenantArrears = { ...(snap.tenantArrears ?? {}), ...newArrears };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  snap.arBalances = deriveArBalances((snap.leases ?? []) as any, snap.tenantArrears);
  // Every rename in this script goes through renameSyncWithRetry: Windows AV / indexer / OneDrive
  // sync can briefly lock these files (EPERM/EBUSY/EACCES) -- see server/lib/rename-retry.ts.
  // Atomic write (temp file + rename), same pattern as saveOverlay/appendReviewQueue (refute round
  // 3/edges): portfolio.json is read by the daily brief's 4c and by this script's own
  // loadLeasesFromSnapshot on the next run — a crash mid-write must not leave it truncated.
  const tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2));
  renameSyncWithRetry(tmp, SNAPSHOT_PATH);
}

function backupCorruptQueue(reason: string): void {
  const backup = REVIEW_QUEUE.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
  try {
    renameSyncWithRetry(REVIEW_QUEUE, backup);
    console.error(`  ✗ ${basename(REVIEW_QUEUE)} ${reason} — backed up to ${basename(backup)}; starting a fresh queue. Recover pending reviews from the backup manually.`);
  } catch {
    console.error(`  ✗ ${basename(REVIEW_QUEUE)} ${reason} and could not be backed up — starting a fresh queue; pending reviews may be LOST.`);
  }
}

/** A date key for source-row identity: the calendar day (UTC) for a Date or any parseable string,
 *  the raw string when unparseable, 'undated' when absent. Tolerates the two shapes an as-of date
 *  has in this script -- a Date in-run (extractAsOfDateFromFilename) and an ISO string once
 *  round-tripped through JSON (a persisted queue row). */
function asOfKey(asOf: Date | string | null | undefined): string {
  if (asOf === null || asOf === undefined) return 'undated';
  const d = asOf instanceof Date ? asOf : new Date(asOf);
  return Number.isNaN(d.getTime()) ? String(asOf) : d.toISOString().slice(0, 10);
}

/** Identity of ONE real-world source row, independent of how it was parsed (2026-09-14 sweep,
 *  Fix B): (sourceFile, as-of day, CANONICAL unit tokens, amount to the cent). The unit is
 *  canonicalized through resolve-by-unit.ts's expandUnitTokens -- the same normalizer resolution
 *  uses -- so the export's annotated 'C 4 (storage)' and the roster's 'C4' key identically. Found
 *  live: the review queue held "C 4 (storage)" / $0.38 / 8.21.2026 while arBalances already
 *  carried that exact row attributed to the C4 lease, because the queue's legacy dedup key
 *  compares the RAW label. The resolved property id is part of the identity too (refute of Fix B,
 *  2026-09-22): a Format B export lists several buildings, and a unit label is only unique WITHIN
 *  one, so 'C4' at a mapped building and 'C4' at an unmapped one (same file, same cents) are two
 *  rows. Returns null when there is no identity to key on (missing, blank, or annotation-only
 *  label; or an unresolved property, which no write can ever carry) -- such a row can never be
 *  proven a duplicate, so it is never dropped. */
export function sourceRowKey(
  sourceFile: string,
  asOfDate: Date | string | null | undefined,
  propertyId: string | null | undefined,
  unit: string | null | undefined,
  amount: number,
): string | null {
  if (propertyId === null || propertyId === undefined || propertyId === '') return null;
  if (unit === null || unit === undefined || unit.trim() === '') return null;
  const tokens = [...expandUnitTokens(unit)].filter((t) => t !== '').sort();
  if (tokens.length === 0) return null;
  // Same to-the-cent idiom as merge-buckets.ts / delinquency-transactional.ts: float-order noise
  // in a bucket sum must not split one source row into two identities.
  const cents = (Math.round(amount * 100) / 100).toFixed(2);
  return `${sourceFile}::${asOfKey(asOfDate)}::${propertyId}::${tokens.join('+')}::${cents}`;
}

/** sourceRowKey for a queued row -- null for a name-matched row (no unit / as-of identity) or a
 *  pre-Fix-B Format B row persisted before those fields existed. */
function reviewSourceRowKey(r: QueuedReview): string | null {
  if (r.unit === undefined || r.asOfDate === undefined || r.propertyId === undefined) return null;
  return sourceRowKey(r.sourceFile, r.asOfDate, r.propertyId, r.unit, r.d30 + r.d60 + r.d90 + r.d90plus);
}

/** Build the review-queue row for a Format B (unit-only) row that did not resolve. Pure -- the
 *  reason text is exactly what the inline branch produced before (2026-09-14 sweep, Fix B lifted
 *  it out so it can be unit-tested), plus the source-row identity fields and the roster candidate:
 *  Format B carries NO tenant name, so a durable name-keyed SKIP ruling in the mapping cache
 *  (real: "anibal morales": "SKIP") was invisible from the queue. The candidate is whoever the
 *  roster puts at that unit at ANY status -- a dead lease is precisely the case a human needs to
 *  see -- and the cache's ruling for that name is shown beside it. DISPLAY ONLY: the row stays a
 *  'none'-confidence review with no proposal; nothing here auto-applies a SKIP or a mapping. */
export function buildBucketedReviewRow(args: {
  row: BucketedUnitRow;
  res: UnitResolution;
  propertyId: string | null;
  unitLeases: readonly UnitLease[];
  cacheEntries: Readonly<Record<string, string>>;
  sourceFile: string;
  asOfDate: Date | null;
  queuedAt: string;
}): QueuedReview {
  const { row, res, propertyId, unitLeases, cacheEntries, sourceFile, asOfDate, queuedAt } = args;
  const reason =
    propertyId === null
      ? `property header not in the known-property table: '${row.property ?? '(none)'}' — add it to BUCKETED_PROPERTY_HEADERS once confirmed against a real property id`
      : res.ambiguous
        ? `unit '${row.unit}' matches more than one lease at this property — needs a human look`
        : `unit '${row.unit}' has no exact match at this property (may be part of a larger merged lease — never auto-attributed on a partial overlap)`;
  const candidates = unitCandidates(row, unitLeases, propertyId);
  const candidateTenant = candidates.map((c) => `${c.tenantName ?? '(unnamed)'} [${c.status ?? 'unknown status'}]`).join(' | ') || null;
  // Object.hasOwn, not `in`/index -- same hygiene as partitionArRows: a name that normalizes to
  // 'constructor' must read undefined, not an inherited Object.prototype member.
  const rulings = candidates.flatMap((c) => {
    if (!c.tenantName) return [];
    const key = cacheKey(c.tenantName);
    const ruling = Object.hasOwn(cacheEntries, key) ? cacheEntries[key] : undefined;
    return ruling === undefined ? [] : [`${key} → ${ruling}`];
  });
  return {
    tenant: `${row.property ?? 'unknown property'} / ${row.unit}`,
    property: row.property,
    d30: row.d30,
    d60: 0,
    d90: 0,
    d90plus: row.d30plus,
    proposedLeaseId: null,
    proposedCandidate: null,
    confidence: 'none',
    ambiguous: res.ambiguous,
    reason,
    sourceFile,
    queuedAt,
    asOfDate: asOfDate === null ? null : asOfDate.toISOString(),
    propertyId,
    unit: row.unit,
    candidateTenant,
    candidateLeaseIds: candidates.map((c) => c.id),
    candidateCacheRuling: rulings.join(' | ') || null,
  };
}

/** Drop review rows that duplicate a source row THIS SWEEP already attributed (2026-09-14 sweep,
 *  Fix B). A write is keyed exactly like a Format B review row -- (sourceFile, as-of, the written
 *  lease's roster unit, bucket sum) -- so a row that reached the overlay through one parse shape
 *  is not also queued for a human through another. Only rows carrying a source-row identity (Format
 *  B) are ever dropped; name-matched review rows and writes to a lease the roster cannot place on
 *  a unit pass through untouched. Order-independent by construction: it runs over the whole
 *  sweep's writes after every file has been parsed, not file-by-file. */
export function dropReviewsAlreadyAttributed(
  reviews: readonly QueuedReview[],
  writes: ReadonlyArray<{ leaseId: string; arrears: TenantArrears }>,
  unitLeases: readonly UnitLease[],
): { kept: QueuedReview[]; dropped: QueuedReview[] } {
  const placeById = new Map(unitLeases.map((l) => [l.id, { unit: l.unit, propertyId: l.propertyId }] as const));
  const attributed = new Set<string>();
  for (const w of writes) {
    const place = placeById.get(w.leaseId);
    if (place === undefined || !w.arrears.sourceFile) continue;
    const key = sourceRowKey(
      w.arrears.sourceFile,
      w.arrears.asOfDate ?? null,
      place.propertyId,
      place.unit,
      w.arrears.d30 + w.arrears.d60 + w.arrears.d90 + w.arrears.d90plus,
    );
    if (key !== null) attributed.add(key);
  }
  const kept: QueuedReview[] = [];
  const dropped: QueuedReview[] = [];
  for (const r of reviews) {
    const key = reviewSourceRowKey(r);
    (key !== null && attributed.has(key) ? dropped : kept).push(r);
  }
  return { kept, dropped };
}

/** The queue-append dedup (lifted out of appendReviewQueue, 2026-09-14 sweep, Fix B). Two keys,
 *  either of which marks an incoming row as already queued:
 *   - legacy (proposedLeaseId ?? tenant, sourceFile, reason) -- refute round 4/medium's rule,
 *     unchanged: the same still-unresolved conflict re-queued by a repeat sweep.
 *   - source-row (sourceRowKey via unit / as-of / amount) -- so a Format B row re-queued under a
 *     DIFFERENT label or reason ('C 4 (storage)' vs 'C4'; 'no exact match' vs 'ambiguous' after a
 *     roster change) is still recognised as the same source row.
 *  Deliberately NOT applied within the incoming batch: the legacy key ignores amount, so a
 *  within-batch dedup would silently drop the second of two genuine rows one export carries for a
 *  single unit. Two files never collide anyway (sourceFile is in both keys). */
export function dedupReviewsAgainstQueue(existing: readonly QueuedReview[], rows: readonly QueuedReview[]): QueuedReview[] {
  const legacyKey = (r: QueuedReview) => `${r.proposedLeaseId ?? r.tenant}::${r.sourceFile}::${r.reason}`;
  const existingLegacy = new Set(existing.map(legacyKey));
  const existingSource = new Set(existing.map(reviewSourceRowKey).filter((k): k is string => k !== null));
  return rows.filter((r) => {
    if (existingLegacy.has(legacyKey(r))) return false;
    const sk = reviewSourceRowKey(r);
    return sk === null || !existingSource.has(sk);
  });
}

export function appendReviewQueue(rows: QueuedReview[]): void {
  if (rows.length === 0) return;
  let existing: QueuedReview[] = [];
  if (existsSync(REVIEW_QUEUE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(REVIEW_QUEUE, 'utf8'));
    } catch {
      // Refute 2026-07-22/edges: silently resetting to [] on a corrupt/truncated file would WIPE
      // every pending human-review row — each one a real delinquency awaiting a tenant mapping —
      // with zero trace. Back the corrupt file up under a timestamped name and log loudly instead.
      backupCorruptQueue('was corrupt/unreadable');
      parsed = [];
    }
    // Refute round 2/edges: valid JSON that ISN'T an array (e.g. `null` or `{}` from a hand-edit or a
    // foreign tool) parses fine but `[...existing, ...rows]` below would throw — the throw escapes to
    // main().catch AFTER the overlay write already happened, so every subsequent sweep re-crashes at
    // the same line forever. Route the same backup-aside path for a shape mismatch, not just a parse
    // failure.
    if (!Array.isArray(parsed)) {
      backupCorruptQueue('had the wrong shape (not an array)');
      parsed = [];
    }
    existing = parsed as QueuedReview[];
  }
  // Refute round 4/medium: a conflict left in the inbox (ambiguousTies) re-parses and re-queues an
  // IDENTICAL row every subsequent sweep with no dedup — a daily schedule turns one unresolved
  // conflict into an ever-growing pile of duplicates, degrading the queue a human is meant to work
  // from. Dedup on (proposedLeaseId, sourceFile, reason): the same lease + same contributing file(s)
  // + same reason text is the same still-unresolved conflict, not a new one. Plus, since the
  // 2026-09-14 sweep (Fix B), on source-row identity for Format B rows — see dedupReviewsAgainstQueue.
  const dedupedNew = dedupReviewsAgainstQueue(existing, rows);
  mkdirSync(dirname(REVIEW_QUEUE), { recursive: true });
  // Atomic write (temp file + rename): a crash mid-write must never leave REVIEW_QUEUE itself
  // truncated, or the NEXT sweep's read above would treat it as corrupt and re-trigger the same loss.
  const tmp = `${REVIEW_QUEUE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify([...existing, ...dedupedNew], null, 2));
  renameSyncWithRetry(tmp, REVIEW_QUEUE);
}

/** Move a PDF into a sibling dir (processed/failed); leaves it in place if the move fails. */
export function moveInto(pdf: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  try {
    renameSyncWithRetry(pdf, join(dest, basename(pdf)));
  } catch {
    /* leave in place if the move fails */
  }
}

/** Move a bad PDF to failed/ and log why (a real error). */
function quarantine(pdf: string, reason: string): void {
  moveInto(pdf, FAILED);
  console.error(`  ✗ ${basename(pdf)} → failed/: ${reason}`);
}

async function main(): Promise<void> {
  const nowIso = new Date().toISOString();
  console.log(`→ Headless AR import · inbox=${INBOX} · ${nowIso}`);

  if (!existsSync(INBOX)) {
    mkdirSync(INBOX, { recursive: true });
    console.log('  Inbox created (was absent). No files to process.');
    return;
  }
  // Sorted by mtime ASCENDING (oldest first): resolveLatestArrears's exact-as-of TIE-break keeps
  // whichever row appears LATER in its input array — this only matches "the more recent drop" (the
  // documented intent) if processing order actually tracks recency. readdirSync's own order is
  // filesystem/name-dependent, NOT chronological (refute 2026-07-22/determinism: a corrected
  // re-export saved as "AR_2026-07-15 (1).pdf" sorts BEFORE the original on NTFS name order and
  // would otherwise lose a tie it should win). mtime is a real, if imperfect, proxy for "dropped more
  // recently" — the closest thing available without parsing an as-of date from the report body text.
  //
  // Stat ONCE per file into a plain array before sorting (refute round 2/determinism): statSync
  // INSIDE the comparator was called O(n log n) times, so (a) a file vanishing mid-sort — a real risk
  // in this environment, whose scheduled-task fleets are documented to double-fire — threw ENOENT and
  // aborted the ENTIRE sweep including healthy files, and (b) a file still being copied into the
  // inbox had its mtime change BETWEEN comparator calls, violating the total-order contract sort()
  // requires and making the tie-break's outcome unspecified. A file that vanishes between the
  // readdirSync and the stat here is simply skipped (not fatal) — it will be picked up next sweep.
  const files = readdirSync(INBOX)
    .filter((f) => { const lower = f.toLowerCase(); return lower.endsWith('.pdf') || lower.endsWith('.xlsx'); })
    .map((f) => join(INBOX, f))
    .flatMap((p) => {
      try {
        return [{ p, m: statSync(p).mtimeMs }];
      } catch {
        return []; // vanished between readdirSync and stat — skip this run, retried next sweep
      }
    })
    .sort((a, b) => a.m - b.m)
    .map(({ p }) => p);
  if (files.length === 0) {
    console.log('  No PDF/xlsx files in inbox — nothing to do.');
    return;
  }

  const leases = loadLeasesFromSnapshot();
  const allLeaseIds = loadAllLeaseIdsFromSnapshot();
  if (leases.length === 0) {
    // Refute round 2/edges: proceeding here would route EVERY cache-confirmed row (including
    // long-established, previously-human-confirmed mappings) to review, since partitionArRows'
    // roster-validation guard (refute round 1/HIGH) sees an empty roster as "nothing exists". A
    // partial/interrupted workbook refresh leaving leases empty must halt the feed loudly, exactly
    // like the missing-snapshot case above, rather than silently degrade into an all-review sweep
    // that LOOKS like it ran (a per-file '✓' log line) but writes nothing useful.
    throw new Error(`Snapshot at ${SNAPSHOT_PATH} has zero leases — refusing to run against a degraded/partial snapshot. Wait for a full Brain refresh.`);
  }
  const cache = loadCache();
  const unitLeases = loadUnitLeasesFromSnapshot();
  console.log(`  ${files.length} file(s) · ${leases.length} lease(s) loaded`);

  // Accumulate across ALL files, then resolve once: AR aging is a point-in-time balance, so a lease
  // hit by more than one report in this sweep is resolved to the LATEST as-of (resolveLatestArrears)
  // — NEVER summed, or the same unpaid balance appearing on two consecutive agings would double-count.
  const allWrites: Array<{ leaseId: string; arrears: TenantArrears; tenant: string }> = [];
  let allReviews: QueuedReview[] = [];
  const processed: string[] = [];
  const pdfBySourceFile = new Map<string, string>(); // basename -> full path, for the ambiguousTies handling below
  // Every report successfully parsed this sweep (source file + as-of date), regardless of how many
  // rows it produced — the input to computeDroppedLeaseClears below, which needs to know which
  // report SERIES actually ran this sweep so it can retract a persisted balance for a tenant who
  // dropped off a newer report of the same series.
  const sweepReportInfos: SweepReportInfo[] = [];
  let totalSkipped = 0;

  for (const file of files) {
    const sourceFile = basename(file);
    const isXlsx = file.toLowerCase().endsWith('.xlsx');

    let rows: ArAgingRow[];
    let format: string;
    // Only the xlsx path has a reliable in-file as-of date (the report's own "Current tenants as
    // of MM/DD/YY" line — see rent-manager-delinquency.ts's module doc: more reliable than a
    // filename-derived date). Left null for PDFs, which fall back to extractAsOfDateFromFilename
    // below exactly as before.
    let xlsxAsOfDate: Date | null = null;

    if (isXlsx) {
      let workbook: ExcelJS.Workbook;
      try {
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(file);
      } catch (e) {
        quarantine(file, e instanceof Error ? e.message : String(e));
        continue;
      }
      // Ordered detection: A (Rent Manager "Delinquency (Detail)", 5/8 real files) → C (Yardi "DB
      // Caption" transactional, 2/8) → B (two-bucket unit-only "Delinquency", 1/8). Order is chosen
      // for readability/frequency, not correctness: each detector's own row-1 check is already
      // disjoint from the others (B requires an EXACT 'delinquency' match, which 'delinquency
      // (detail)' fails; C requires a 'db caption:' prefix neither A nor B can produce), so no two
      // can collide regardless of try-order.
      const worksheet = workbook.worksheets.find((ws) => detectRentManagerDelinquencyDetail(ws));
      const transactionalWs = worksheet ? undefined : workbook.worksheets.find((ws) => detectDelinquencyTransactional(ws));
      const bucketedWs = worksheet || transactionalWs ? undefined : workbook.worksheets.find((ws) => detectDelinquencyBucketed(ws));

      if (worksheet === undefined && transactionalWs === undefined && bucketedWs === undefined) {
        quarantine(
          file,
          'xlsx format not recognized as Rent Manager "Delinquency (Detail)", Yardi "DB Caption" transactional, or two-bucket "Delinquency" (Northwood-style)',
        );
        continue;
      }

      if (bucketedWs !== undefined) {
        // Format B carries NO TENANT NAME (unit-only identity) — it cannot go through the shared
        // partitionArRows() name-matching path below, which every other format uses. Resolved and
        // logged entirely here, then `continue`s to the next file directly.
        const bucketedRows = parseDelinquencyBucketed(bucketedWs);
        const asOfDate = extractAsOfDateFromFilename(file);
        if (asOfDate === null && bucketedRows.length > 0) {
          quarantine(file, 'two-bucket "Delinquency" export carries no in-file as-of date and none could be derived from the filename — refusing to age/write undated unit balances');
          continue;
        }
        let autoCount = 0;
        let reviewCount = 0;
        for (const row of bucketedRows) {
          const propertyId = resolvePropertyId(row.property);
          const res = resolveByUnit(row, unitLeases, propertyId);
          const label = `${row.property ?? 'unknown property'} / ${row.unit}`;
          if (res.leaseId !== null) {
            allWrites.push({
              leaseId: res.leaseId,
              arrears: { d30: row.d30, d60: 0, d90: 0, d90plus: row.d30plus, asOfDate, sourceFile },
              tenant: label,
            });
            autoCount++;
          } else {
            // Reason text, source-row identity, and the roster candidate (who the roster says is
            // at this unit, any status, plus the mapping cache's ruling on that name) all come
            // from buildBucketedReviewRow — display aids for the human; nothing auto-applies.
            allReviews.push(
              buildBucketedReviewRow({ row, res, propertyId, unitLeases, cacheEntries: cache.entries, sourceFile, asOfDate, queuedAt: nowIso }),
            );
            reviewCount++;
          }
        }
        processed.push(file);
        pdfBySourceFile.set(sourceFile, file);
        sweepReportInfos.push({ sourceFile, asOfDate, hadUnresolvedRow: reviewCount > 0 });
        console.log(`  ✓ ${sourceFile} [delinquency-bucketed] — ${autoCount} auto · ${reviewCount} review · 0 skip`);
        continue;
      }

      if (transactionalWs !== undefined) {
        // Format C has no in-file as-of line, so aging is relative to the filename date; without one,
        // every charge would silently age against "now" and report stale balances as current.
        const asOfDate = extractAsOfDateFromFilename(file);
        if (asOfDate === null) {
          quarantine(file, 'DB Caption export carries no in-file as-of date and none could be derived from the filename — refusing to age charges against an assumed date');
          continue;
        }
        rows = parseDelinquencyTransactional(transactionalWs, asOfDate);
        format = 'delinquency-transactional';
        xlsxAsOfDate = asOfDate;
      } else {
        // By elimination, not by re-checking `worksheet !== undefined`: the top-of-block guard
        // already `continue`d when all three detectors miss, and the `bucketedWs` branch already
        // `continue`d when THAT one hits — so reaching here with `transactionalWs` also undefined
        // means `worksheet` is the only detector that could have matched. Written as a plain `else`
        // (not `else if (worksheet !== undefined)`) so TypeScript can prove `rows`/`format` are
        // definitely assigned by the end of this block without relying on that external reasoning —
        // an `else if` here left a path where neither branch fires and both stay unassigned.
        const parsed = parseRentManagerWorksheet(worksheet!);
        if (parsed.unsupportedReason) {
          quarantine(file, `rent-manager-delinquency: ${parsed.unsupportedReason}`);
          continue;
        }
        if (parsed.subtotalMismatches.length > 0) {
          const detail: SubtotalMismatch[] = parsed.subtotalMismatches;
          console.log(
            `  ⚠ ${sourceFile}: ${detail.length} tenant subtotal mismatch(es) — computed buckets used anyway (see rent-manager-delinquency.ts docs): ${detail
              .map((m) => `${m.tenant} (computed ${m.computedTotal} vs reported ${m.reportedTotal})`)
              .join('; ')}`,
          );
        }
        rows = parsed.rows;
        format = 'rent-manager-delinquency';
        xlsxAsOfDate = parsed.asOfDate;
      }
    } else {
      let text: string;
      try {
        text = extractPdfText(file);
      } catch (e) {
        quarantine(file, e instanceof Error ? e.message : String(e));
        continue;
      }
      if (isGarbageExtraction(text)) {
        quarantine(file, 'no text layer (image/scanned) — re-export as a text PDF');
        continue;
      }
      const parsed = parseArAging(text);
      if (parsed.unsupportedReason) {
        quarantine(file, `format '${parsed.format}': ${parsed.unsupportedReason}`);
        continue;
      }
      rows = parsed.rows;
      format = parsed.format;
    }

    const part = partitionArRows(rows, leases, cache.entries, allLeaseIds);
    const asOfDate = isXlsx ? xlsxAsOfDate : extractAsOfDateFromFilename(file);
    if (asOfDate === null && part.write.length > 0) {
      // Refute round 2/edges: a null-stamped record SURVIVES overlay reload (fix #2 in this same
      // remediation made asOfDate round-trip) and conditions.ts's staleness gate treats a null asOf
      // as stale — which suppresses ALL per-lease AR alerts portfolio-wide until a dated report
      // re-imports. That is conditions.ts's own defensible fail-safe design, but writing it should
      // never be quiet: name the file so an operator can rename it with its as-of date if this recurs.
      const howToFix = isXlsx
        ? "confirm the report's \"Current tenants as of\" header line is present and well-formed"
        : 'rename the export with its as-of date';
      console.log(`  ⚠ ${sourceFile} has no recoverable as-of date — ${part.write.length} row(s) will be written UNDATED (asOfDate=null), which suppresses portfolio-wide AR staleness alerting until a dated report follows. Please ${howToFix} to avoid this.`);
    }
    for (const w of part.write) {
      allWrites.push({ leaseId: w.leaseId, arrears: { ...w.arrears, asOfDate, sourceFile }, tenant: w.tenant });
    }
    for (const r of part.review) allReviews.push({ ...r, sourceFile, queuedAt: nowIso });
    Object.assign(cache.entries, part.learned);
    totalSkipped += part.skipped;
    processed.push(file);
    pdfBySourceFile.set(sourceFile, file);
    // Real defect fix (2026-09-06 round-3 self-review, MEDIUM): a cached SKIP is a durable,
    // already-resolved human decision ("never attribute this name"), not an ambiguous row — do
    // NOT fold `part.skipped` into hadUnresolvedRow, or a standing SKIP for a perpetually
    // reappearing non-tenant name (real example: "(Past) Chesapeake Bay Movers, Inc.") would
    // exempt its whole series from clearing forever. Only a genuine review row counts.
    sweepReportInfos.push({ sourceFile, asOfDate, hadUnresolvedRow: part.review.length > 0 });
    console.log(`  ✓ ${sourceFile} [${format}] — ${part.write.length} auto · ${part.review.length} review · ${part.skipped} skip`);
  }

  // 2026-09-14 sweep, Fix B: a Format B review row that is the SAME source row (file · as-of · unit
  // · amount) as something this sweep already attributed is not also queued for a human. Runs over
  // the whole sweep's writes, after every file is parsed, so the outcome does not depend on inbox
  // order. The per-file `hadUnresolvedRow` above was computed BEFORE this drop and is left as-is on
  // purpose — it errs toward NOT clearing that series this sweep (fail closed), which is the safe
  // direction for clear-dropped-leases.
  const attributedDedup = dropReviewsAlreadyAttributed(allReviews, allWrites, unitLeases);
  if (attributedDedup.dropped.length > 0) {
    console.log(
      `  ℹ ${attributedDedup.dropped.length} review row(s) not queued — the same source row was already attributed this sweep: ${attributedDedup.dropped.map((r) => r.tenant).join('; ')}`,
    );
    allReviews = attributedDedup.kept;
  }

  // Multi-unit rows within ONE report were already summed upstream (partition → mergeByLease). Across
  // reports IN THIS SWEEP, the LATEST as-of supersedes for a given lease (resolveLatestArrears).
  const { resolved, superseded, ambiguousTies } = resolveLatestArrears(allWrites);
  if (superseded.length > 0) {
    console.log(`  ℹ ${superseded.length} lease(s) appeared in multiple reports this sweep — kept the latest as-of, not summed: ${superseded.join(', ')}`);
  }
  // Refute round 3 (all 3 lenses): an ambiguous tie must never just vanish. Round 2's fix correctly
  // refused to silently pick a side, but then let the outcome disappear entirely — not queued for
  // review, contributing PDFs archived, exit 0. Two durable surfaces now, not a console line alone:
  // (1) a review-queue row naming both totals and both source files, so a human sees it via the
  // designed remediation surface without needing to read a scheduled task's console log; (2) the
  // contributing PDFs are excluded from archival — left in the inbox — so the conflict keeps
  // resurfacing every sweep (never silently resolved by moving the evidence out of reach) until a
  // human resolves it or a decisively later report arrives.
  const conflictPdfPaths = new Set<string>();
  if (ambiguousTies.length > 0) {
    console.log(`  ⚠ ${ambiguousTies.length} lease(s) SKIPPED — two reports this sweep share an as-of date but report DIFFERENT bucket totals (not auto-resolved, needs a human look): ${ambiguousTies.join(', ')}`);
    for (const leaseId of ambiguousTies) {
      const contributing = allWrites.filter((w) => w.leaseId === leaseId);
      const sourceFiles = [...new Set(contributing.map((w) => w.arrears.sourceFile).filter((f): f is string => !!f))];
      const totals = contributing.map((w) => w.arrears.d30 + w.arrears.d60 + w.arrears.d90 + w.arrears.d90plus);
      allReviews.push({
        tenant: contributing[0]?.tenant ?? leaseId,
        property: null,
        d30: 0,
        d60: 0,
        d90: 0,
        d90plus: 0,
        proposedLeaseId: leaseId,
        proposedCandidate: null,
        confidence: 'none',
        ambiguous: true,
        reason: `exact as-of tie with conflicting reports (${sourceFiles.join(' vs ') || 'unknown files'}) — totals disagree (${totals.join(' vs ')}); open both PDFs, pick the correct one, and re-import it manually`,
        sourceFile: sourceFiles.join(' + ') || 'unknown',
        queuedAt: nowIso,
      });
      for (const f of sourceFiles) {
        const p = pdfBySourceFile.get(f);
        if (p) conflictPdfPaths.add(p);
      }
    }
  }

  let overlayWriteFailed = false;
  let writtenCount = 0;
  // Real defect fix (2026-09-06 adversarial review, MEDIUM): gating the whole overlay-load/clear
  // block on `resolved.length > 0` skipped the clear step entirely on a sweep whose only report(s)
  // parsed successfully but produced zero write-eligible rows (an all-paid-off single-property
  // drop) — exactly the case most likely to hold a stale ghost, and a realistic one given AR
  // exports are pulled by hand, often one property at a time. Also gate on any report having been
  // successfully parsed this sweep, regardless of row count.
  if (resolved.length > 0 || sweepReportInfos.length > 0) {
    // Refute round 3/edges: loadOverlay() silently returns a clean/empty overlay on unparseable JSON
    // — a defensible default for a UI-driven mutation (a human would immediately notice an empty
    // app), but this feed is an UNATTENDED scheduled writer: loadOverlay-reset → merge this sweep's
    // arrears → saveOverlay would atomically cement a hand-edit typo (overlay.json is a documented
    // manual-entry surface) into a TOTAL wipe of every other overlay map — deal stages, tasks, NOI
    // budgets, everything — with exit 0. Pre-check the raw file BEFORE loadOverlay touches it and
    // abort loudly (leaving PDFs in place, same as the empty-lease-roster halt above) rather than
    // silently amplifying a read-side corruption into a write-side one. Scoped entirely to this
    // script's own write path — loadOverlay itself, and every other overlay consumer, is unchanged.
    // Pre-flight overlay check — the HIGHEST-consequence copy in the codebase. Unlike the
    // drift-check/extract writers (which only zero enrichment in a regenerable snapshot), this
    // script's save path writes straight back to the canonical overlay.json mutation store, so a
    // loadOverlay-reset → merge → saveOverlay would atomically cement a bad read into a TOTAL wipe
    // of every overlay map (deal stages, tasks, NOI budgets) with exit 0 — and overlay.json is
    // gitignored, so there is no git history to recover it from. Abort loudly, leaving PDFs in
    // place (same as the empty-lease-roster halt above). Shared evaluator: server/overlay.ts.
    // The evaluator's own reason is surfaced verbatim: a previously-appended "would amplify into a
    // full overlay reset on save" clause was FALSE for the missing-file case (there is no overlay
    // to reset), and each reason already states its own consequence.
    // Deliberately NOT expectEnriched: an empty overlay is legitimate on a genuinely first AR
    // sweep, which POPULATES arrears rather than merging them onto a snapshot.
    const rawOverlayPath = overlayPath();
    const overlayCheck = evaluateOverlayPrecondition(rawOverlayPath);
    if (overlayCheck.refuse) {
      throw new Error(overlayCheck.reason);
    }
    const overlay = loadOverlay();
    // resolveLatestArrears only sees rows collected THIS sweep. A stale report processed alone in a
    // LATER sweep has no in-sweep competitor to lose to — filterAgainstPersisted closes that gap by
    // comparing against what's already on disk for each lease (refute 2026-07-22, all 3 lenses).
    const { toWrite, rejectedStale, undatedConflict, equalDateOverwrite } = filterAgainstPersisted(resolved, overlay.tenantArrears);
    if (rejectedStale.length > 0) {
      console.log(`  ⚠ ${rejectedStale.length} lease(s) SKIPPED — a PERSISTED arrears record is already newer than this sweep's report (stale re-import blocked): ${rejectedStale.map((r) => r.leaseId).join(', ')}`);
    }
    if (undatedConflict.length > 0) {
      // Distinct from rejectedStale on purpose (refute round 2): this report has NO date, so we
      // cannot claim it's stale — only that its vintage can't be verified against a dated persisted
      // record. Mislabeling this "stale" would be actively wrong when the undated file is the fresher
      // one; the honest answer is "unknown, needs a dated re-export or a human decision".
      console.log(`  ⚠ ${undatedConflict.length} lease(s) SKIPPED — this sweep's report has no as-of date, so it can't be verified against the DATED persisted record: ${undatedConflict.map((r) => r.leaseId).join(', ')}`);
    }
    if (equalDateOverwrite.length > 0) {
      // Refute round 3: the write still happens (a same-day correction must be able to update its own
      // day's entry) but was previously indistinguishable from a routine newer-date write in the log.
      console.log(`  ℹ ${equalDateOverwrite.length} lease(s) overwrote a SAME-DATE persisted record with a different bucket vector (same-day correction applied): ${equalDateOverwrite.map((r) => r.leaseId).join(', ')}`);
    }
    // Real defect fix (2026-09-06 adversarial review, HIGH, through THREE same-day rounds — see
    // clear-dropped-leases.ts's module doc for the full history): the write path above only ever
    // adds or updates a lease's arrears — a tenant who paid off and no longer appears on a NEWER
    // report of the same series (property) kept its old, aging record forever. Because
    // conditions.ts's staleness gate is all-or-nothing (any one stamped record older than 35 days
    // suppresses EVERY per-lease collections alert, not just that lease's own), a handful of
    // paid-off ghosts silently disabled collections alerting portfolio-wide. Zero-stamp them
    // instead — the read model already treats an all-zero record as "checked, current"
    // (server/ar/derive-ar-balances.ts). `applyWritesAndClears` (not a manual merge here) computes
    // the clear against the POST-write state and applies it last — round 3 found that computing
    // clears against the pre-write map and merging `toWrite` in afterward let a same-sweep write
    // sourced from an OLDER report of a series silently override a correct clear.
    const { newArrears, clearedLeaseIds } = applyWritesAndClears(overlay.tenantArrears, sweepReportInfos, toWrite);
    if (clearedLeaseIds.length > 0) {
      console.log(`  ℹ ${clearedLeaseIds.length} lease(s) cleared — no fresh write this sweep from a newer report of the same, fully-attributed series: ${clearedLeaseIds.join(', ')}`);
    }
    if (toWrite.length > 0 || clearedLeaseIds.length > 0) {
      overlay.tenantArrears = { ...overlay.tenantArrears, ...newArrears };
      const saved = await saveOverlay(overlay);
      if (!saved) {
        // Refute 2026-07-22/edges: saveOverlay deliberately returns false (never throws) on a write
        // failure — the caller MUST check it. Proceeding to patch the snapshot / archive the PDFs /
        // log success here would let the canonical write silently fail while today's brief still
        // shows the numbers, and the NEXT Brain refresh would revert them with the source PDFs
        // already moved out of the inbox (nothing left to retry from).
        overlayWriteFailed = true;
        console.error('  ✗ FATAL: overlay save failed (disk/permissions) — the canonical write did NOT happen.');
      } else {
        patchSnapshot(newArrears);
        writtenCount = toWrite.length;
      }
    }
  }
  await saveCache(cache); // tenant-name→lease mappings learned this sweep — independent of the arrears write outcome above

  let archivedCount = 0;
  if (overlayWriteFailed) {
    // Refute round 2/edges: PDFs are left in place for a full retry, so appending the review queue
    // here would duplicate identical rows on every failed attempt (a disk-full episode spanning
    // several scheduled runs compounds into N copies of the same pending delinquency). Skip it — the
    // retry re-parses the same files and re-queues the same rows once the underlying failure clears.
    console.error('  ✗ Leaving all inbox PDFs in place (not archiving, not queuing reviews) so this sweep retries on the next run.');
  } else {
    appendReviewQueue(allReviews);
    // Ambiguous-tie contributors are excluded from archival (left in the inbox) so the conflict keeps
    // resurfacing every sweep rather than vanishing into processed/ — see conflictPdfPaths above.
    for (const pdf of processed) {
      if (conflictPdfPaths.has(pdf)) continue;
      moveInto(pdf, PROCESSED);
      archivedCount++;
    }
  }

  console.log(
    `\n${overlayWriteFailed ? '✗' : '✓'} Done — ${writtenCount} lease(s) written · ${allReviews.length} queued for review · ${totalSkipped} skipped · ${archivedCount}/${files.length} archived${conflictPdfPaths.size > 0 ? ` · ${conflictPdfPaths.size} left in inbox (ambiguous tie)` : ''}`,
  );
  if (allReviews.length > 0) {
    console.log(`  ⚠ ${allReviews.length} row(s) need a human map — see ${REVIEW_QUEUE}.`);
    console.log(`    To resolve: fix the matcher (server/ar/resolve-by-unit.ts, or the propertyId map in this script) so the row attributes by rule, copy its source file from ${PROCESSED} back into ${INBOX}, and re-run this script. A re-import at the SAME as-of date overwrites the prior entry, so this is safe to repeat.`);
    console.log(`    NOT scripts/ar-import.ts — that takes a PDF path and needs a running server; it never reads this queue.`);
  }
  if (overlayWriteFailed) process.exitCode = 1;
}

// Run the sweep ONLY when invoked as the entry script -- never on import. This script is the single
// writer of THREE tracked files (data/ar/review-queue.json, data/ar-mapping-cache.json, and
// data/snapshots/portfolio.json via patchSnapshot) plus data/overlay.json, and portfolio.json is
// auto-committed/auto-pushed by the snapshot-refresh scheduled tasks -- so an accidental import (a
// future test reaching for a helper in here) would run a live AR sweep and land its residue in an
// unattended commit. Same guard, and same rationale, as every sibling script here.
// ora-ar-feed-sweep invokes `npx tsx scripts/ar-import-headless.ts`, so argv[1] still matches and
// the unattended run behaves exactly as before.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/ar-import-headless.ts')) {
  main().catch((e: unknown) => {
    console.error('\n✗ Fatal:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
