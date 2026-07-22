/**
 * scripts/ar-import-headless.ts
 *
 * HEADLESS AR-aging feed (Layer 2) — the unattended counterpart to the interactive
 * scripts/ar-import.ts. Built for a scheduled task: no prompts, no running server required.
 *
 * Per-run pipeline:
 *   scan AR_INBOX/*.pdf
 *     → pdfplumber text  (server/ar/pdf-extract)
 *     → parse buckets    (server/ar/ar-aging — Yardi/AppFolio "Aging Detail"; RM delinquency unsupported)
 *     → partition        (server/ar/partition-confidence — AUTO-WRITE HIGH-CONFIDENCE ONLY)
 *          · exact / high-≥2-token / cache-confirmed  → write
 *          · everything else                          → review queue (never written)
 *     → write overlay (canonical) + patch snapshot (immediate 4c visibility)
 *     → append review queue · update mapping cache · archive the PDF
 *
 * SAFETY: mirrors the interactive script's `autoAccept` rule exactly — a below-high-confidence or
 * ambiguous match is NEVER auto-attributed. Those land in AR_INBOX/../review-queue.json for a human
 * to map with the interactive tool. Silent mis-attribution of a delinquency is the worst failure
 * mode and this run cannot produce one.
 *
 * WRITE PATH (documented design choice): writes arrears to the overlay (data/overlay.json — the
 * canonical mutation Brain re-reads on every refresh) AND patches the persisted snapshot
 * (portfolio.json) in place so the daily brief's 4c sees the numbers this morning without waiting
 * for a full Brain refresh. Recommended cadence: run just BEFORE the workbook ingest/refresh so the
 * refresh rebuilds a clean snapshot from workbook+overlay. Known limitation: if the dev server is
 * actively writing the overlay at the same instant, its in-memory copy (lacking these arrears)
 * could overwrite them on its next saveOverlay — schedule the feed off-hours to avoid the race.
 *
 * Usage:  npx tsx scripts/ar-import-headless.ts
 * Env:    AR_INBOX (default data/ar/inbox), ORA_PYTHON, AR_MAPPING_CACHE, SNAPSHOT_PATH
 * Exit:   0 always on a completed sweep (per-file failures are logged + quarantined, not fatal).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { extractPdfText } from '../server/ar/pdf-extract';
import { parseArAging, isGarbageExtraction, extractAsOfDateFromFilename } from '../server/ar/ar-aging';
import { partitionArRows, type ArReviewRow } from '../server/ar/partition-confidence';
import { resolveLatestArrears } from '../server/ar/resolve-latest';
import { loadCache, saveCache } from '../server/ar/mapping-cache';
import { loadOverlay, saveOverlay } from '../server/overlay';
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
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
}

function appendReviewQueue(rows: QueuedReview[]): void {
  if (rows.length === 0) return;
  let existing: QueuedReview[] = [];
  if (existsSync(REVIEW_QUEUE)) {
    try {
      existing = JSON.parse(readFileSync(REVIEW_QUEUE, 'utf8')) as QueuedReview[];
    } catch {
      existing = [];
    }
  }
  mkdirSync(dirname(REVIEW_QUEUE), { recursive: true });
  writeFileSync(REVIEW_QUEUE, JSON.stringify([...existing, ...rows], null, 2));
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
  const pdfs = readdirSync(INBOX).filter((f) => f.toLowerCase().endsWith('.pdf')).map((f) => join(INBOX, f));
  if (pdfs.length === 0) {
    console.log('  No PDFs in inbox — nothing to do.');
    return;
  }

  const leases = loadLeasesFromSnapshot();
  const cache = loadCache();
  console.log(`  ${pdfs.length} PDF(s) · ${leases.length} lease(s) loaded`);

  // Accumulate across ALL files, then apply once so two files touching the same lease sum rather
  // than clobber (the overlay write is a per-lease REPLACE).
  const allWrites: Array<{ leaseId: string; arrears: TenantArrears; tenant: string }> = [];
  const allReviews: QueuedReview[] = [];
  const processed: string[] = [];
  let totalSkipped = 0;

  for (const pdf of pdfs) {
    const sourceFile = basename(pdf);
    let text: string;
    try {
      text = extractPdfText(pdf);
    } catch (e) {
      quarantine(pdf, e instanceof Error ? e.message : String(e));
      continue;
    }
    if (isGarbageExtraction(text)) {
      quarantine(pdf, 'no text layer (image/scanned) — re-export as a text PDF');
      continue;
    }
    const { format, rows, unsupportedReason } = parseArAging(text);
    if (unsupportedReason) {
      quarantine(pdf, `format '${format}': ${unsupportedReason}`);
      continue;
    }

    const part = partitionArRows(rows, leases, cache.entries);
    const asOfDate = extractAsOfDateFromFilename(pdf);
    for (const w of part.write) {
      allWrites.push({ leaseId: w.leaseId, arrears: { ...w.arrears, asOfDate, sourceFile }, tenant: w.tenant });
    }
    for (const r of part.review) allReviews.push({ ...r, sourceFile, queuedAt: nowIso });
    Object.assign(cache.entries, part.learned);
    totalSkipped += part.skipped;
    processed.push(pdf);
    console.log(`  ✓ ${sourceFile} [${format}] — ${part.write.length} auto · ${part.review.length} review · ${part.skipped} skip`);
  }

  // Resolve across files, then apply to overlay + snapshot. AR aging is a point-in-time balance:
  // multi-unit rows within ONE report were already summed upstream (partition → mergeByLease); across
  // reports the LATEST as-of supersedes for a given lease — never sum, or the same unpaid balance on
  // two consecutive agings would double-count.
  const { resolved, superseded } = resolveLatestArrears(allWrites);
  if (superseded.length > 0) {
    console.log(`  ℹ ${superseded.length} lease(s) appeared in multiple reports this sweep — kept the latest as-of, not summed: ${superseded.join(', ')}`);
  }
  if (resolved.length > 0) {
    const overlay = loadOverlay();
    const newArrears: Record<string, TenantArrears> = {};
    for (const r of resolved) newArrears[r.leaseId] = r.arrears; // arrears already carries asOfDate/sourceFile
    overlay.tenantArrears = { ...overlay.tenantArrears, ...newArrears };
    await saveOverlay(overlay);
    patchSnapshot(newArrears);
    await saveCache(cache);
  }

  appendReviewQueue(allReviews);
  for (const pdf of processed) moveInto(pdf, PROCESSED); // archive successfully-parsed inputs

  console.log(
    `\n✓ Done — ${resolved.length} lease(s) written · ${allReviews.length} queued for review · ${totalSkipped} skipped · ${processed.length}/${pdfs.length} archived`,
  );
  if (allReviews.length > 0) {
    console.log(`  ⚠ ${allReviews.length} row(s) need a human map — see ${REVIEW_QUEUE} (run scripts/ar-import.ts to resolve).`);
  }
}

main().catch((e: unknown) => {
  console.error('\n✗ Fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
