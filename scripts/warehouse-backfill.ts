// scripts/warehouse-backfill.ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { seedMappingsFromFile } from '../server/warehouse/mapping';
import { seedPropertyMaster } from '../server/warehouse/property-master';
import { seedLeaseTerms } from '../server/warehouse/lease-terms';
import { noiMatrix } from '../server/warehouse/queries';

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const DB_PATH = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const RAW_DIR = join(process.cwd(), 'data', 'warehouse', 'raw');
const SEED_PATH = join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-06-12-pfi-account-mapping-seed.json');

async function main(): Promise<void> {
  const db = openWarehouse(DB_PATH);
  seedPropertyMaster(db);
  const leaseTerms = seedLeaseTerms(db);
  const seeded = seedMappingsFromFile(db, SEED_PATH);
  console.log(`property master seeded (14 units); ${leaseTerms} lease-term rows seeded; ${seeded} new seed mappings loaded`);

  const files = readdirSync(FINANCIALS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  const counts: Record<string, number> = {};
  for (const f of files) {
    const r = await ingestFile(db, join(FINANCIALS_DIR, f), {
      rawDir: RAW_DIR,
      importedAt: new Date().toISOString(),
      importedBy: 'warehouse-backfill',
    });
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    const extra = r.unmapped ? ` unmapped=[${r.unmapped.join('; ')}]` : '';
    console.log(`${r.status.padEnd(15)} v${r.version ?? '-'} ${r.file}${extra}`);
  }
  console.log('\nSummary:', JSON.stringify(counts));

  console.table(noiPrintRows(db));
  db.close();
}

/**
 * NOI rows for the operator's `console.table`, derived from the COHERENT noiMatrix (queries.ts →
 * propertyPeriodMetrics → selectCoherentBatch). When a full-year (period_end 12-31) and a same-year
 * YTD (06-30) coexist they share ledger period 'YYYY' but differ on period_end, so neither supersedes
 * the other and both stay is_active=1; a raw GROUP BY over all active rows SUMMED both batches (the
 * ~2x double-count this CLI used to print). Going through noiMatrix resolves the group to ONE coherent
 * batch — the full year — so this CLI now prints exactly the figure warehouse-verify.ts and the /noi
 * API report (the doc comments in queries.ts / metrics.ts that say "the backfill CLI prints" are true).
 * Shape stays { property_id, period, noi } so the printed table is byte-for-byte unchanged for the
 * single-batch (non-coexisting) case the live ledger normally holds.
 */
export function noiPrintRows(db: WarehouseDb): Array<{ property_id: string; period: string; noi: number }> {
  return noiMatrix(db).map((c) => ({ property_id: c.propertyId, period: c.period, noi: c.noi }));
}

// Run the live backfill ONLY when invoked as the entry script — never on import (a test importing
// noiPrintRows must not trigger a real ingest into the live warehouse). Windows-path-safe match,
// matching scripts/safe-worktree.ts.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/warehouse-backfill.ts')) {
  main().catch((e: unknown) => { console.error(e); process.exit(1); });
}
