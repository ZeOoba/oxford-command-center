// scripts/acq-sync.ts
//
// Weekly acquisition-pipeline sync (ruling 2026-10-30): pull the HubSpot and Notion acquisition
// pipelines into the warehouse's acq_candidates, the same work POST /api/warehouse/acq/sync/hubspot
// and /notion do. A CLI because the scheduled task must not depend on the Brain Server being up, and
// with ACCESS_REQUIRE=1 the server (correctly) denies an unsigned local POST.
//
// Writes the LIVE warehouse through openWarehouseNoMigrate: it refuses (exit 1) rather than migrate
// a warehouse that is behind this code. Each source runs independently; a missing token is reported
// and skipped, an error in one source does not stop the other. Exit 1 if any source failed.
//
// Usage: npx tsx scripts/acq-sync.ts   (run from the checkout that serves the warehouse)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../server/load-env';
import { openWarehouseNoMigrate } from '../server/warehouse/db';
import { syncHubSpotPipeline } from '../server/warehouse/acq-hubspot-sync';
import { syncNotionPipeline } from '../server/warehouse/acq-notion-sync';

loadEnvFile();

type Source = { name: string; tokenVar: string; run: (token: string) => Promise<{ inserted: number; updated: number; errors: unknown[] }> };

async function main(): Promise<number> {
  const path = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
  if (!existsSync(path)) {
    console.error(`✗ acq-sync: no warehouse DB at ${path}`);
    return 1;
  }
  const db = openWarehouseNoMigrate(path);
  const sources: Source[] = [
    { name: 'HubSpot', tokenVar: 'HUBSPOT_TOKEN', run: (t) => syncHubSpotPipeline(db, t) },
    { name: 'Notion', tokenVar: 'NOTION_TOKEN', run: (t) => syncNotionPipeline(db, t) },
  ];
  let failed = 0;
  try {
    for (const s of sources) {
      const token = process.env[s.tokenVar];
      if (!token) {
        console.error(`✗ acq-sync ${s.name}: ${s.tokenVar} not configured — skipped`);
        failed++;
        continue;
      }
      try {
        const r = await s.run(token);
        const tone = r.errors.length ? '⚠' : '✓';
        console.log(`${tone} acq-sync ${s.name}: ${r.inserted} inserted, ${r.updated} updated, ${r.errors.length} row error(s)`);
        if (r.errors.length) failed++;
      } catch (err) {
        console.error(`✗ acq-sync ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  } finally {
    db.close();
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error('✗ acq-sync crashed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
