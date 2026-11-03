// scripts/acq-sync.ts
//
// Weekly acquisition-pipeline sync (ruling 2026-10-30): pull the HubSpot and Notion acquisition
// pipelines into the warehouse's acq_candidates, the same work POST /api/warehouse/acq/sync/hubspot
// and /notion do. A CLI because the scheduled task must not depend on the Brain Server being up, and
// with ACCESS_REQUIRE=1 the server (correctly) denies an unsigned local POST.
//
// Writes the LIVE warehouse through openWarehouseNoMigrate: it refuses (exit 1) rather than migrate
// a warehouse that is behind this code. The default DB path is anchored to this checkout (like
// load-env.ts's .env), not process.cwd(), so a task launched from another directory still hits the
// warehouse whose .env it loaded. Each source runs independently; a missing token is reported and
// skipped (not a failure — a token-less source is a supported mode), an error in one source does not
// stop the other. Exit 1 if any configured source failed or had row errors, or if no source ran.
//
// Usage: npx tsx scripts/acq-sync.ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/load-env';
import { openWarehouseNoMigrate } from '../server/warehouse/db';
import { syncHubSpotPipeline, type AcqSyncResult } from '../server/warehouse/acq-hubspot-sync';
import { syncNotionPipeline } from '../server/warehouse/acq-notion-sync';

loadEnvFile();

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Source = { name: string; tokenVar: string; run: (token: string) => Promise<AcqSyncResult> };

// The sync modules throw `<Vendor> API <status>: <full response body>` on a first-page failure. The
// server route never surfaces that body; neither should a scheduled-task log — keep the status only.
function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const api = /^(\w+ API \d{3})\b/.exec(msg);
  if (api) return api[1]!;
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

async function main(): Promise<number> {
  const path = process.env.WAREHOUSE_DB ?? join(REPO_ROOT, 'data', 'warehouse', 'finance.sqlite');
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
  let ran = 0;
  try {
    for (const s of sources) {
      const token = process.env[s.tokenVar];
      if (!token) {
        console.log(`– acq-sync ${s.name}: ${s.tokenVar} not configured — skipped`);
        continue;
      }
      ran++;
      try {
        const r = await s.run(token);
        const tone = r.errors.length ? '⚠' : '✓';
        console.log(`${tone} acq-sync ${s.name}: ${r.inserted} inserted, ${r.updated} updated, ${r.errors.length} row error(s)`);
        for (const e of r.errors) console.error(`    ${e}`);
        if (r.errors.length) failed++;
      } catch (err) {
        console.error(`✗ acq-sync ${s.name}: ${describeError(err)}`);
        failed++;
      }
    }
  } finally {
    db.close();
  }
  if (ran === 0) {
    console.error('✗ acq-sync: no source configured (set HUBSPOT_TOKEN and/or NOTION_TOKEN)');
    return 1;
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error('✗ acq-sync crashed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
