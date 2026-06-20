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
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { parseArAging, isGarbageExtraction } from '../server/ar/ar-aging';
import { matchTenantToLease, type LeaseLite } from '../server/ar/match-tenant';
import { loadCache, saveCache, cacheKey } from '../server/ar/mapping-cache';
import type { TenantArrears } from '../src/contracts/index';

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

async function fetchLeases(): Promise<LeaseLite[]> {
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
  const snap = await resp.json() as { leases?: Array<{ id: string; tenantName: string; company: string | null }> };
  return (snap.leases ?? []).map((l) => ({ id: l.id, tenantName: l.tenantName, company: l.company ?? null }));
}

// ─── Overlay write ────────────────────────────────────────────────────────────

async function writeTenantArrears(leaseId: string, arrears: TenantArrears): Promise<boolean> {
  try {
    const resp = await fetch(`${SERVER}/api/actions/tenant-arrears`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  // 3 — Load leases + cache
  console.log('→ Loading leases from snapshot…');
  const leases = await fetchLeases();
  console.log(`✓ ${leases.length} lease(s) loaded`);
  const cache = loadCache();

  // 4 — Match + review
  console.log('\n─── Review ────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Tenant'.padEnd(34)}  ${'1–30d'.padStart(11)}  ${'31–60d'.padStart(11)}  ${'61–90d'.padStart(11)}  ${'91+d'.padStart(11)}  Status`);
  console.log('  ' + '─'.repeat(100));

  const rl = readline.createInterface({ input, output });
  const confirmed: Array<{ leaseId: string; arrears: TenantArrears; tenant: string }> = [];

  for (const row of rows) {
    const { tenant, d30, d60, d90, d90plus } = row;
    const key = cacheKey(tenant);

    // Cache hit
    const cached = cache.entries[key];
    if (cached !== undefined) {
      if (cached === 'SKIP') {
        printRow(tenant, d30, d60, d90, d90plus, '[cached: skip]');
        continue;
      }
      printRow(tenant, d30, d60, d90, d90plus, `[cached → ${cached}]`);
      confirmed.push({ leaseId: cached, arrears: { d30, d60, d90, d90plus }, tenant });
      continue;
    }

    // Auto-accept: exact or high confidence, unambiguous
    const match = matchTenantToLease(tenant, leases);
    if ((match.confidence === 'exact' || match.confidence === 'high') && !match.ambiguous && match.leaseId) {
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
        const manual = (await rl.question(`    Enter leaseId: `)).trim();
        if (manual) {
          cache.entries[key] = manual;
          confirmed.push({ leaseId: manual, arrears: { d30, d60, d90, d90plus }, tenant });
          resolved = true;
        }
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

  // 5 — Summary + confirm write
  const skipped = rows.length - confirmed.length;
  console.log('\n─── Summary ───────────────────────────────────────────────────────────────────');
  console.log(`  ${'Tenant'.padEnd(34)}  ${'Lease ID'.padEnd(24)}  ${'1–30d'.padStart(11)}  ${'31–60d'.padStart(11)}  ${'61–90d'.padStart(11)}  ${'91+d'.padStart(11)}`);
  console.log('  ' + '─'.repeat(114));
  for (const { tenant, leaseId, arrears } of confirmed) {
    const name = tenant.length > 34 ? tenant.slice(0, 33) + '…' : tenant.padEnd(34);
    console.log(`  ${name}  ${leaseId.padEnd(24)}  ${fmtUsd(arrears.d30).padStart(11)}  ${fmtUsd(arrears.d60).padStart(11)}  ${fmtUsd(arrears.d90).padStart(11)}  ${fmtUsd(arrears.d90plus).padStart(11)}`);
  }
  console.log(`\n  ${confirmed.length} to write · ${skipped} skipped`);

  if (confirmed.length === 0) {
    console.log('\n  Nothing to write.');
    await saveCache(cache);
    process.exit(0);
  }

  const rl2 = readline.createInterface({ input, output });
  const confirm = (await rl2.question(`\nWrite ${confirmed.length} arrears record(s) to overlay? (y/n): `)).trim().toLowerCase();
  rl2.close();

  if (confirm !== 'y') {
    console.log('Aborted — no records written. Cache not saved.');
    process.exit(0);
  }

  // 6 — Write
  console.log('\n→ Writing…');
  let written = 0;
  for (const { leaseId, arrears, tenant } of confirmed) {
    const ok = await writeTenantArrears(leaseId, arrears);
    if (ok) {
      written++;
      console.log(`  ✓ ${leaseId}  (${tenant})`);
    }
  }

  await saveCache(cache);
  console.log(`\n✓ Done — ${written}/${confirmed.length} written · ${skipped} skipped · mapping cache saved`);
}

main().catch((e: unknown) => {
  console.error('\n✗ Fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
