// scripts/warehouse-live-drift-check.ts — live-vs-fresh warehouse drift gate.
//
// warehouse:verify scores a FRESH temp warehouse, so it stays green while the SERVED persistent DB
// (data/warehouse/finance.sqlite) can be stale vs current code — because ingest dedups on file hash,
// so `warehouse:backfill` returns 'duplicate' and never re-derives an existing import after a parser
// improvement. This check rebuilds a fresh warehouse from the same source files and compares its
// committed accounting-basis-by-file against the LIVE DB, failing on any divergence. Complements the
// (separately-tracked) parser-version re-ingest fix that would PREVENT the staleness.
//
// Live DB is opened READ-ONLY — this check never mutates the served warehouse. Local-only (needs
// FINANCIALS_DIR); wire into `npm run gate` after warehouse:verify.
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../server/load-env';
import { openWarehouse } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { seedMappingsFromFile } from '../server/warehouse/mapping';
import { seedPropertyMaster } from '../server/warehouse/property-master';
import { basisDrift, committedBasisMap } from '../server/warehouse/live-drift';

loadEnvFile();

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const LIVE_DB = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const SEED_PATH = join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-06-12-pfi-account-mapping-seed.json');

async function main(): Promise<number> {
  if (!existsSync(LIVE_DB)) {
    // No served DB yet ⇒ nothing can be stale. Skip (pass) so the gate is safe on a fresh checkout;
    // warehouse:verify still validates the data via its own fresh build. The drift check is meaningful
    // only once a live DB exists (local dev / production).
    console.log(`warehouse:drift SKIPPED — no live DB at ${LIVE_DB} (nothing served yet).`);
    return 0;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'wh-drift-'));
  try {
    // Fresh rebuild from the same source files (same pipeline as warehouse:verify).
    const fresh = openWarehouse(join(tmp, 'finance.sqlite'));
    seedPropertyMaster(fresh);
    seedMappingsFromFile(fresh, SEED_PATH);
    const files = readdirSync(FINANCIALS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    for (const f of files) {
      await ingestFile(fresh, join(FINANCIALS_DIR, f), {
        rawDir: join(tmp, 'raw'),
        importedAt: new Date().toISOString(),
        importedBy: 'warehouse-live-drift-check',
      });
    }
    const freshMap = committedBasisMap(fresh);
    fresh.close();

    // Live (served) DB — READ-ONLY: never mutate the warehouse the app serves.
    const live = new Database(LIVE_DB, { readonly: true });
    const liveMap = committedBasisMap(live);
    live.close();

    const drift = basisDrift(liveMap, freshMap);
    if (drift.length > 0) {
      console.error(`\nwarehouse:drift FAILED — the SERVED warehouse (${LIVE_DB}) is stale vs a fresh rebuild `
        + `(${drift.length} file(s) drift):`);
      for (const d of drift) {
        console.error(`  - ${d.fileName}: live=${d.live ?? 'ABSENT'} fresh=${d.fresh ?? 'ABSENT'}`);
      }
      console.error(`\nRemedy: rebuild the served DB — archive data/warehouse/finance.sqlite* and run `
        + `'npm run warehouse:backfill'. (Plain backfill alone will NOT re-derive hash-identical files; `
        + `the parser-version re-ingest fix is the durable solution.)`);
      return 1;
    }
    console.log(`warehouse:drift PASSED — served warehouse matches a fresh rebuild `
      + `(${liveMap.size} committed imports, 0 basis drift).`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
