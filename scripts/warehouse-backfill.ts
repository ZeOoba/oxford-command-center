// scripts/warehouse-backfill.ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { seedMappingsFromFile } from '../server/warehouse/mapping';
import { seedPropertyMaster } from '../server/warehouse/property-master';

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const DB_PATH = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const RAW_DIR = join(process.cwd(), 'data', 'warehouse', 'raw');
const SEED_PATH = join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-06-12-pfi-account-mapping-seed.json');

async function main(): Promise<void> {
  const db = openWarehouse(DB_PATH);
  seedPropertyMaster(db);
  const seeded = seedMappingsFromFile(db, SEED_PATH);
  console.log(`property master seeded (14 units); ${seeded} new seed mappings loaded`);

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

  const noi = db.prepare(`
    SELECT property_id, period,
      ROUND(SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                     WHEN classification='opex' THEN -amount ELSE 0 END), 2) AS noi
    FROM ledger_entries WHERE is_active = 1
    GROUP BY property_id, period ORDER BY property_id, period
  `).all();
  console.table(noi);
  db.close();
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
