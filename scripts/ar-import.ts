/**
 * scripts/ar-import.ts
 *
 * AR-aging import pipeline — collections data feed (audit Fix #2).
 * Usage: npx tsx scripts/ar-import.ts <pdf-path>
 *
 * Pipeline:
 *   PDF → pdfplumber text extraction → parse (yardi/appfolio) → fuzzy match
 *   against live snapshot leases → terminal review → overlay write via
 *   POST /api/actions/tenant-arrears → confirmed-mapping cache save.
 *
 * Designed for single-property or multi-property exports. All financial
 * attribution (tenant→Lease.id) requires human confirmation for any row
 * below HIGH confidence — silent mis-attribution is the worst failure mode.
 */

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { parseArAging, isGarbageExtraction, extractAsOfDateFromFilename } from '../server/ar/ar-aging';
import { matchTenantToLease, normalizeTokens } from '../server/ar/match-tenant';
import { loadCache, saveCache, cacheKey } from '../server/ar/mapping-cache';
import { mergeByLease } from '../server/ar/merge-buckets';
import { filterAgainstPersisted, type DatedArrearsWrite } from '../server/ar/resolve-latest';
import { parseSnapshotForImport, type SnapshotForImport } from '../server/ar/parse-snapshot-for-import';
import type { TenantArrears } from '../src/contracts/index';
import { ORA_JSON_MUTATION_HEADERS } from '../src/contracts/client-header';

const SERVER = process.env.ORA_SERVER ?? 'http://localhost:3000';
const PYTHON = process.env.ORA_PYTHON ?? 'python';

// ─── PDF text extraction ──────────────────────────────────────────────────────

/** Run pdfplumber in a subprocess and return the full text of all pages. */
function extractPdfText(pdfPath: string): string {
  const result = spawnSync(
    PYTHON,
    ['-c', `
import sys, pdfplumber
with pdfplumber.open(sys.argv[1]) as pdf:
    print("\\n".join((p.extract_text() or "") for p in pdf.pages))
`, pdfPath],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`Python not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pdfplumber error:\n${result.stderr}`);
  return result.stdout ?? '';
}

// ─── Snapshot / lease lookup ──────────────────────────────────────────────────

async function fetchSnapshotForImport(): Promise<SnapshotForImport> {
  let resp: Response;
  try {
    resp = await fetch(`${SERVER}/api/snapshot`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      console.error('\n✗ Cannot reach the Command Center server.');
      console.error(`  Start it first (npm run dev) then re-run this script.`);
      process.exit(1);
    }
    throw e;
  }
  if (!resp.ok) throw new Error(`/api/snapshot returned ${resp.status}`);
  return parseSnapshotForImport(await resp.json());
}

/** Pretty-print an as-of value for a console warning; 'undated' for null/undefined/unparseable. */
function fmtAsOf(d: Date | string | null | undefined): string {
  if (d === null || d === undefined) return 'undated';
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? 'undated' : dt.toISOString().slice(0, 10);
}

// ─── Overlay write ────────────────────────────────────────────────────────────

async function writeTenantArrears(leaseId: string, arrears: TenantArrears): Promise<boolean> {
  try {
    const resp = await fetch(`${SERVER}/api/actions/tenant-arrears`, {
      method: 'POST',
      headers: ORA_JSON_MUTATION_HEADERS,
      body: JSON.stringify({ leaseId, arrears }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`  ✗ Write failed for ${leaseId}: HTTP ${resp.status} ${body}`);
      return false;
    }
    return true;
  } catch (e: unknown) {
    console.error(`  ✗ Write error for ${leaseId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ─── Terminal review helpers ──────────────────────────────────────────────────

function fmtUsd(n: number): string {
  return n === 0 ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printRow(tenant: string, d30: number, d60: number, d90: number, d90plus: number, suffix: string): void {
  const name = tenant.length > 34 ? tenant.slice(0, 33) + '…' : tenant.padEnd(34);
  console.log(`  ${name}  ${fmtUsd(d30).padStart(11)}  ${fmtUsd(d60).padStart(11)}  ${fmtUsd(d90).padStart(11)}  ${fmtUsd(d90plus).padStart(11)}  ${suffix}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: npx tsx scripts/ar-import.ts <pdf-path>');
    process.exit(1);
  }

  const sourceFile = basename(pdfPath);
  const asOfDate = extractAsOfDateFromFilename(pdfPath);
  if (asOfDate) {
    console.log(`  As-of date: ${asOfDate.toISOString().slice(0, 10)} (from filename)`);
  } else {
    console.log(`  As-of date: not derivable from filename — records will have asOfDate=null`);
  }

  // 1 — Extract text
  console.log(`\n→ Extracting text from: ${pdfPath}`);
  let text: string;
  try {
    text = extractPdfText(pdfPath);
  } catch (e: unknown) {
    console.error(`✗ PDF extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (isGarbageExtraction(text)) {
    console.error('\n✗ This PDF has no text layer (image/scanned or CID-font encoded).');
    console.error('  Re-export from Yardi or AppFolio as a text PDF, or use the Print → PDF option.');
    console.error('  (The 9050 Red Branch Rd export currently falls into this category.)');
    process.exit(1);
  }

  // 2 — Parse
  const { format, rows, unsupportedReason } = parseArAging(text);
  if (unsupportedReason) {
    console.error(`\n✗ Format '${format}' is not supported for bucket parsing:`);
    console.error(`  ${unsupportedReason}`);
    process.exit(1);
  }
  console.log(`✓ Parsed as '${format}' — ${rows.length} tenant row(s)`);
  if (rows.length === 0) {
    console.log('  No rows with arrears found — nothing to import.');
    process.exit(0);
  }

  // 3 — Load leases + persisted arrears + cache
  console.log('→ Loading leases + persisted arrears from snapshot…');
  const { leases, allLeaseIds, tenantArrears: persistedArrears } = await fetchSnapshotForImport();
  console.log(`✓ ${leases.length} lease(s) loaded`);
  const cache = loadCache();
  // allLeaseIds (not leaseIds derived from `leases`, which excludes Expired leases as of 2026-08-24
  // PR #302): a human manually typing a leaseId may deliberately want to attribute to a dead lease
  // (e.g. correcting the fresh-match's own review-queue proposal) -- that is not the same risk class
  // as an unattended auto-match and must not be blocked by the same exclusion.
  const leaseIdSet = allLeaseIds;

  // 4 — Match + review
  console.log('\n─── Review ────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Tenant'.padEnd(34)}  ${'1–30d'.padStart(11)}  ${'31–60d'.padStart(11)}  ${'61–90d'.padStart(11)}  ${'91+d'.padStart(11)}  Status`);
  console.log('  ' + '─'.repeat(100));

  const rl = readline.createInterface({ input, output });
  const confirmed: Array<{ leaseId: string; arrears: TenantArrears; tenant: string }> = [];

  for (const row of rows) {
    const { tenant, d30, d60, d90, d90plus } = row;
    const key = cacheKey(tenant);

    // Cache hit — non-lossy key means this is the exact same raw name (modulo punctuation/case).
    // Object.hasOwn guard (2026-08-24, PR #302 review): cache.entries is a plain object indexed by
    // an untrusted normalized tenant string, reachable via the prototype chain for a key like
    // 'constructor' — see partition-confidence.ts's identical guard for the headless path.
    const cached = Object.hasOwn(cache.entries, key) ? cache.entries[key] : undefined;
    if (cached !== undefined) {
      if (cached === 'SKIP') {
        printRow(tenant, d30, d60, d90, d90plus, '[cached: skip]');
        continue;
      }
      printRow(tenant, d30, d60, d90, d90plus, `[cached → ${cached}]`);
      confirmed.push({ leaseId: cached, arrears: { d30, d60, d90, d90plus }, tenant });
      continue;
    }

    // Auto-accept: exact normalized-token match, OR high confidence with ≥2 report tokens.
    // Single-token report names (e.g. "Summit") can be a subset of one wrong lease at score 1.0 —
    // require ≥2 tokens so truncated single-word names always go to human review.
    const match = matchTenantToLease(tenant, leases);
    const reportTokenCount = normalizeTokens(tenant).length;
    const autoAccept =
      (match.confidence === 'exact' ||
        (match.confidence === 'high' && reportTokenCount >= 2)) &&
      !match.ambiguous &&
      match.leaseId !== null;

    if (autoAccept && match.leaseId) {
      printRow(tenant, d30, d60, d90, d90plus, `✓ auto → ${match.leaseId}`);
      cache.entries[key] = match.leaseId;
      confirmed.push({ leaseId: match.leaseId, arrears: { d30, d60, d90, d90plus }, tenant });
      continue;
    }

    // Manual review needed
    const proposal = match.leaseId
      ? `${match.confidence}${match.ambiguous ? '/ambiguous' : ''} → ${match.leaseId} ("${match.candidate ?? ''}")`
      : 'no match';
    printRow(tenant, d30, d60, d90, d90plus, `? ${proposal}`);

    let resolved = false;
    while (!resolved) {
      const ans = (await rl.question(`    Accept proposed leaseId? (y/n/skip/manual): `)).trim().toLowerCase();
      if (ans === 'y' && match.leaseId) {
        cache.entries[key] = match.leaseId;
        confirmed.push({ leaseId: match.leaseId, arrears: { d30, d60, d90, d90plus }, tenant });
        resolved = true;
      } else if (ans === 'n' || ans === 'manual') {
        // Validate the entered leaseId exists in the snapshot — a typo'd id would write
        // delinquency to the wrong tenant with no further guard.
        let manual = '';
        while (!manual) {
          const entered = (await rl.question(`    Enter leaseId (must exist in snapshot): `)).trim();
          if (!entered) continue;
          if (!leaseIdSet.has(entered)) {
            const sample = [...leaseIdSet].slice(0, 3).join(', ');
            console.log(`    ✗ '${entered}' not in snapshot. Sample IDs: ${sample}`);
            continue;
          }
          manual = entered;
        }
        cache.entries[key] = manual;
        confirmed.push({ leaseId: manual, arrears: { d30, d60, d90, d90plus }, tenant });
        resolved = true;
      } else if (ans === 'skip') {
        cache.entries[key] = 'SKIP';
        console.log(`    → Skipped (cached)`);
        resolved = true;
      } else {
        console.log(`    Enter y / n / skip / manual`);
      }
    }
  }

  rl.close();

  // 5 — Merge multi-unit rows by leaseId (sum buckets) before writing.
  // The overlay write does a REPLACE — without merging, a tenant with two units would have
  // the second write silently overwrite the first, losing one unit's delinquency balance.
  const merged = mergeByLease(confirmed);
  if (merged.some((r) => r.multiUnit)) {
    console.log('\n  ℹ Multi-unit tenants detected — buckets summed per lease:');
    for (const r of merged.filter((r) => r.multiUnit)) {
      console.log(`    ${r.leaseId}: ${r.tenant}`);
    }
  }

  // 5b — Guard against overwriting a fresher balance (refute 2026-07-22 round 2): this report's
  // asOfDate applies to every row (one file, one as-of), so compare each merged row against the
  // PERSISTED entry for that lease before it's ever offered for write/confirm — the headless feed
  // (scripts/ar-import-headless.ts) may have already imported a newer report for some of these leases
  // since this PDF was queued, and the review-queue workflow that sends a human here is by
  // construction working the OLDEST, stalest backlog rows.
  const withProvenance: DatedArrearsWrite[] = merged.map((r) => ({ leaseId: r.leaseId, tenant: r.tenant, arrears: { ...r.arrears, asOfDate, sourceFile } }));
  const { toWrite, rejectedStale, undatedConflict } = filterAgainstPersisted(withProvenance, persistedArrears);
  if (rejectedStale.length > 0) {
    console.log('\n  ⚠ SKIPPED — a PERSISTED record is already newer than this report:');
    for (const r of rejectedStale) console.log(`    ${r.leaseId}: persisted ${fmtAsOf(r.persistedAsOf)} > incoming ${fmtAsOf(r.incomingAsOf)}`);
  }
  if (undatedConflict.length > 0) {
    console.log('\n  ⚠ SKIPPED — this report has no as-of date but a DATED record is already persisted (cannot verify recency):');
    for (const r of undatedConflict) console.log(`    ${r.leaseId}: persisted ${fmtAsOf(r.persistedAsOf)}`);
  }

  // 6 — Summary + confirm write
  const skipped = rows.length - confirmed.length;
  console.log('\n─── Summary ───────────────────────────────────────────────────────────────────');
  console.log(`  ${'Tenant'.padEnd(34)}  ${'Lease ID'.padEnd(24)}  ${'1–30d'.padStart(11)}  ${'31–60d'.padStart(11)}  ${'61–90d'.padStart(11)}  ${'91+d'.padStart(11)}`);
  console.log('  ' + '─'.repeat(114));
  for (const { tenant, leaseId, arrears } of toWrite) {
    const name = tenant.length > 34 ? tenant.slice(0, 33) + '…' : tenant.padEnd(34);
    console.log(`  ${name}  ${leaseId.padEnd(24)}  ${fmtUsd(arrears.d30).padStart(11)}  ${fmtUsd(arrears.d60).padStart(11)}  ${fmtUsd(arrears.d90).padStart(11)}  ${fmtUsd(arrears.d90plus).padStart(11)}`);
  }
  console.log(`\n  ${toWrite.length} to write · ${skipped} skipped`);

  if (toWrite.length === 0) {
    console.log('\n  Nothing to write.');
    await saveCache(cache);
    process.exit(0);
  }

  const rl2 = readline.createInterface({ input, output });
  const confirm = (await rl2.question(`\nWrite ${toWrite.length} arrears record(s) to overlay? (y/n): `)).trim().toLowerCase();
  rl2.close();

  if (confirm !== 'y') {
    console.log('Aborted — no records written. Cache not saved.');
    process.exit(0);
  }

  // 7a — Re-check against a FRESH snapshot read (refute round 3/edges): the human review session
  // between step 5b's guard and this confirm can run for minutes to hours (per-row prompts), and a
  // scheduled headless sweep can persist a newer report for one of these SAME leases in that window —
  // the check-then-act gap step 5b alone can't close. Re-fetching now and re-filtering closes it with
  // one more cheap round-trip rather than trusting a staleness check that's now potentially stale
  // itself.
  const freshArrears = (await fetchSnapshotForImport()).tenantArrears;
  const recheck = filterAgainstPersisted(toWrite, freshArrears);
  if (recheck.rejectedStale.length > 0 || recheck.undatedConflict.length > 0) {
    console.log('\n  ⚠ SKIPPED at final confirm — a newer record was persisted DURING this review session:');
    for (const r of recheck.rejectedStale) console.log(`    ${r.leaseId}: persisted ${fmtAsOf(r.persistedAsOf)} > incoming ${fmtAsOf(r.incomingAsOf)}`);
    for (const r of recheck.undatedConflict) console.log(`    ${r.leaseId}: persisted ${fmtAsOf(r.persistedAsOf)} (this report is undated)`);
  }
  const finalWrite = recheck.toWrite;

  // 7b — Write. `arrears` already carries this report's asOfDate/sourceFile (stamped in step 5b) —
  // no need to re-spread it here.
  console.log('\n→ Writing…');
  let written = 0;
  for (const { leaseId, arrears, tenant } of finalWrite) {
    const ok = await writeTenantArrears(leaseId, arrears);
    if (ok) {
      written++;
      console.log(`  ✓ ${leaseId}  (${tenant})`);
    }
  }

  await saveCache(cache);
  console.log(`\n✓ Done — ${written}/${finalWrite.length} written · ${skipped} skipped · mapping cache saved`);
}

main().catch((e: unknown) => {
  console.error('\n✗ Fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
