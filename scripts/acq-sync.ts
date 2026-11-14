// scripts/acq-sync.ts
//
// Weekly acquisition-pipeline sync (ruling 2026-10-30): pull the HubSpot and Notion acquisition
// pipelines into the warehouse's acq_candidates, the same work POST /api/warehouse/acq/sync/hubspot
// and /notion do (both go through server/warehouse/acq-sync-runner.ts). A CLI because the scheduled
// task must not depend on the Brain Server being up, and with ACCESS_REQUIRE=1 the server (correctly)
// denies an unsigned local POST.
//
// Writes the LIVE warehouse through openWarehouseNoMigrate: it refuses (exit 1) rather than migrate
// a warehouse that is behind this code. The default DB path is anchored to this checkout (like
// load-env.ts's .env), not process.cwd(), so a task launched from another directory still hits the
// warehouse whose .env it loaded. Each source runs independently; a missing token is reported and
// skipped (not a failure — a token-less source is a supported mode), an error in one source does not
// stop the other. Exit code: acqSyncExitCode() — 1 if any configured source failed or had row errors,
// or if no source ran.
//
// Usage: npx tsx scripts/acq-sync.ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/load-env';
import { openWarehouseNoMigrate } from '../server/warehouse/db';
import { acqSyncExitCode, runAcqSync } from '../server/warehouse/acq-sync-runner';
import type { AcqSyncOutcome, AcqSyncSourceId } from '../server/warehouse/acq-sync-runner';

loadEnvFile();

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES: readonly AcqSyncSourceId[] = ['hubspot', 'notion'];

function report(o: AcqSyncOutcome): void {
  const name = o.source.name;
  if (o.status === 'not-configured') {
    console.log(`– acq-sync ${name}: ${o.source.tokenVar} not configured — skipped`);
  } else if (o.status === 'failed') {
    console.error(`✗ acq-sync ${name}: ${o.error}`);
  } else {
    const r = o.result;
    console.log(`${r.errors.length ? '⚠' : '✓'} acq-sync ${name}: ${r.inserted} inserted, ${r.updated} updated, ${r.errors.length} row error(s)`);
    for (const e of r.errors) console.error(`    ${e}`);
  }
}

async function main(): Promise<number> {
  const path = process.env.WAREHOUSE_DB ?? join(REPO_ROOT, 'data', 'warehouse', 'finance.sqlite');
  if (!existsSync(path)) {
    console.error(`✗ acq-sync: no warehouse DB at ${path}`);
    return 1;
  }
  const db = openWarehouseNoMigrate(path);
  const outcomes: AcqSyncOutcome[] = [];
  try {
    for (const id of SOURCES) {
      const o = await runAcqSync(db, id);
      report(o);
      outcomes.push(o);
    }
  } finally {
    db.close();
  }
  if (outcomes.every((o) => o.status === 'not-configured')) {
    console.error('✗ acq-sync: no source configured (set HUBSPOT_TOKEN and/or NOTION_TOKEN)');
  }
  return acqSyncExitCode(outcomes);
}

// exitCode, not process.exit(): exit() can drop stdout/stderr still buffered for a piped scheduled-task log.
main().then((code) => { process.exitCode = code; }).catch((e: unknown) => {
  console.error('✗ acq-sync crashed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
