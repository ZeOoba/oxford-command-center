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
 * KNOWN ARCHITECTURAL LIMITATION (refute 2026-07-22 round 4/edges — corrects an earlier, understated
 * version of this caveat): Brain (server/brain.ts) loads the overlay file into memory ONCE at
 * construction and NEVER re-reads it — refresh() only re-parses the WORKBOOK (chokidar-watched); it
 * does not re-read overlay.json. So the risk is not "the same instant" — it is the ENTIRE remaining
 * lifetime of a running dev-server process after this script runs. If `npm run dev` is up when this
 * sweep writes to overlay.json on disk, the server's in-memory copy is stale for the rest of that
 * session; ANY subsequent server-mediated overlay write (a deal-stage change, a task, a manual arrears
 * edit, an interactive-script write) calls `saveOverlay(this.overlay)` with that STALE full copy and
 * durably ERASES every field this script wrote (and anything else that changed on disk meanwhile) —
 * not just AR. This is a genuine gap in Brain's overlay lifecycle, not specific to this feature;
 * properly fixing it (re-reading + merging on each mutation, or watching overlay.json for external
 * changes) touches every write-back method Brain exposes and is deliberately OUT OF SCOPE for this
 * PR. Mitigation until then: run this script only while the dev server is stopped (its own design
 * intent — "no running server required"), or restart the server immediately after a sweep before any
 * server-mediated overlay write.
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

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import ExcelJS from 'exceljs';
import { extractPdfText } from '../server/ar/pdf-extract';
import { parseArAging, isGarbageExtraction, extractAsOfDateFromFilename, type ArAgingRow } from '../server/ar/ar-aging';
import { detectRentManagerDelinquencyDetail, parseRentManagerWorksheet, type SubtotalMismatch } from '../server/ar/rent-manager-delinquency';
import { detectDelinquencyTransactional, parseDelinquencyTransactional } from '../server/ar/delinquency-transactional';
import { detectDelinquencyBucketed, parseDelinquencyBucketed } from '../server/ar/delinquency-bucketed';
import { resolveByUnit, type UnitLease } from '../server/ar/resolve-by-unit';
import { partitionArRows, type ArReviewRow } from '../server/ar/partition-confidence';
import { resolveLatestArrears, filterAgainstPersisted } from '../server/ar/resolve-latest';
import { loadCache, saveCache } from '../server/ar/mapping-cache';
import { loadOverlay, saveOverlay, overlayPath } from '../server/overlay';
import { deriveArBalances } from '../server/ar/derive-ar-balances';
import { SNAPSHOT_PATH } from '../server/config';
import type { LeaseLite } from '../server/ar/match-tenant';
import type { TenantArrears } from '../src/contracts/index';

const INBOX = process.env.AR_INBOX ?? join(process.cwd(), 'data', 'ar', 'inbox');
const AR_ROOT = dirname(INBOX);
const PROCESSED = join(AR_ROOT, 'processed');
const FAILED = join(AR_ROOT, 'failed');
const REVIEW_QUEUE = join(AR_ROOT, 'review-queue.json');

interface QueuedReview extends ArReviewRow {
  sourceFile: string;
  queuedAt: string;
}

/** Read {id, tenantName, company} for every lease from the persisted snapshot. */
function loadLeasesFromSnapshot(): LeaseLite[] {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`Snapshot not found at ${SNAPSHOT_PATH} — run a Brain refresh first (npm run dev).`);
  }
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
    leases?: Array<{ id: string; tenantName: string; company: string | null }>;
  };
  return (snap.leases ?? []).map((l) => ({ id: l.id, tenantName: l.tenantName, company: l.company ?? null }));
}

/** Read {id, unit, propertyId} for every lease from the persisted snapshot, for Format B's
 *  (property, unit) resolution — a different projection than loadLeasesFromSnapshot's
 *  {id, tenantName, company}, which match-tenant.ts's NAME-based matching needs instead. Kept as a
 *  separate loader rather than widening LeaseLite itself: LeaseLite is a shared type match-tenant.ts
 *  exports, and widening it would ripple into every consumer of name-based matching for no reason. */
function loadUnitLeasesFromSnapshot(): UnitLease[] {
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
    leases?: Array<{ id: string; unit: string | null; propertyId: string }>;
  };
  return (snap.leases ?? []).map((l) => ({ id: l.id, unit: l.unit, propertyId: l.propertyId }));
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
function patchSnapshot(newArrears: Record<string, TenantArrears>): void {
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as {
    leases?: unknown[];
    tenantArrears?: Record<string, TenantArrears>;
    arBalances?: unknown;
  };
  snap.tenantArrears = { ...(snap.tenantArrears ?? {}), ...newArrears };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  snap.arBalances = deriveArBalances((snap.leases ?? []) as any, snap.tenantArrears);
  // Atomic write (temp file + rename), same pattern as saveOverlay/appendReviewQueue (refute round
  // 3/edges): portfolio.json is read by the daily brief's 4c and by this script's own
  // loadLeasesFromSnapshot on the next run — a crash mid-write must not leave it truncated.
  const tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2));
  renameSync(tmp, SNAPSHOT_PATH);
}

function backupCorruptQueue(reason: string): void {
  const backup = REVIEW_QUEUE.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
  try {
    renameSync(REVIEW_QUEUE, backup);
    console.error(`  ✗ ${basename(REVIEW_QUEUE)} ${reason} — backed up to ${basename(backup)}; starting a fresh queue. Recover pending reviews from the backup manually.`);
  } catch {
    console.error(`  ✗ ${basename(REVIEW_QUEUE)} ${reason} and could not be backed up — starting a fresh queue; pending reviews may be LOST.`);
  }
}

function appendReviewQueue(rows: QueuedReview[]): void {
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
  // + same reason text is the same still-unresolved conflict, not a new one.
  const key = (r: QueuedReview) => `${r.proposedLeaseId ?? r.tenant}::${r.sourceFile}::${r.reason}`;
  const existingKeys = new Set(existing.map(key));
  const dedupedNew = rows.filter((r) => !existingKeys.has(key(r)));
  mkdirSync(dirname(REVIEW_QUEUE), { recursive: true });
  // Atomic write (temp file + rename): a crash mid-write must never leave REVIEW_QUEUE itself
  // truncated, or the NEXT sweep's read above would treat it as corrupt and re-trigger the same loss.
  const tmp = `${REVIEW_QUEUE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify([...existing, ...dedupedNew], null, 2));
  renameSync(tmp, REVIEW_QUEUE);
}

/** Move a PDF into a sibling dir (processed/failed); leaves it in place if the move fails. */
function moveInto(pdf: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  try {
    renameSync(pdf, join(dest, basename(pdf)));
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
  const allReviews: QueuedReview[] = [];
  const processed: string[] = [];
  const pdfBySourceFile = new Map<string, string>(); // basename -> full path, for the ambiguousTies handling below
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
            const reason =
              propertyId === null
                ? `property header not in the known-property table: '${row.property ?? '(none)'}' — add it to BUCKETED_PROPERTY_HEADERS once confirmed against a real property id`
                : res.ambiguous
                  ? `unit '${row.unit}' matches more than one lease at this property — needs a human look`
                  : `unit '${row.unit}' has no exact match at this property (may be part of a larger merged lease — never auto-attributed on a partial overlap)`;
            allReviews.push({
              tenant: label,
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
              queuedAt: nowIso,
            });
            reviewCount++;
          }
        }
        processed.push(file);
        pdfBySourceFile.set(sourceFile, file);
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

    const part = partitionArRows(rows, leases, cache.entries);
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
    console.log(`  ✓ ${sourceFile} [${format}] — ${part.write.length} auto · ${part.review.length} review · ${part.skipped} skip`);
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
  if (resolved.length > 0) {
    // Refute round 3/edges: loadOverlay() silently returns a clean/empty overlay on unparseable JSON
    // — a defensible default for a UI-driven mutation (a human would immediately notice an empty
    // app), but this feed is an UNATTENDED scheduled writer: loadOverlay-reset → merge this sweep's
    // arrears → saveOverlay would atomically cement a hand-edit typo (overlay.json is a documented
    // manual-entry surface) into a TOTAL wipe of every other overlay map — deal stages, tasks, NOI
    // budgets, everything — with exit 0. Pre-check the raw file BEFORE loadOverlay touches it and
    // abort loudly (leaving PDFs in place, same as the empty-lease-roster halt above) rather than
    // silently amplifying a read-side corruption into a write-side one. Scoped entirely to this
    // script's own write path — loadOverlay itself, and every other overlay consumer, is unchanged.
    const rawOverlayPath = overlayPath();
    if (existsSync(rawOverlayPath)) {
      try {
        const parsedOverlay: unknown = JSON.parse(readFileSync(rawOverlayPath, 'utf8'));
        // Round-5 REFUTE: a JSON.parse THROW only catches malformed JSON syntax. Content that is
        // syntactically valid JSON but the wrong shape (null/array/scalar) parses successfully,
        // passes a parse-only guard, but still causes loadOverlay() to fall back to EMPTY_OVERLAY
        // internally -- the same amplify-into-a-full-reset hazard this guard exists to prevent,
        // just via a different malformed-content shape than a parse error. This is the
        // highest-consequence copy of this guard in the codebase: unlike the drift-check/extract
        // scripts (which only zero enrichment in a regenerable snapshot), this script's save
        // path writes straight back to the canonical overlay.json mutation store.
        if (!parsedOverlay || typeof parsedOverlay !== 'object' || Array.isArray(parsedOverlay)) {
          throw new Error(`${rawOverlayPath} is valid JSON but not a valid overlay object — refusing to run (would amplify into a full overlay reset on save). Fix or restore it first.`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('not a valid overlay object')) throw e;
        throw new Error(`${rawOverlayPath} is corrupt/unparseable — refusing to run (would amplify into a full overlay reset on save). Fix or restore it first. (${e instanceof Error ? e.message : String(e)})`);
      }
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
    if (toWrite.length > 0) {
      const newArrears: Record<string, TenantArrears> = {};
      for (const r of toWrite) newArrears[r.leaseId] = r.arrears; // arrears already carries asOfDate/sourceFile
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

main().catch((e: unknown) => {
  console.error('\n✗ Fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
