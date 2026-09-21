/**
 * Seed entity_xref from the lease-market tables, and report what could not be linked.
 *
 * Usage: npm run xref:seed            # report only — writes nothing
 *        npm run xref:seed -- --write # mirror config-blessed links into entity_xref
 *
 * AUTHORITY: config/lease-market.json's `oraProperties` decides which listing is an ORA building.
 * This script mirrors that decision (a non-null lm_property.ora_property_key) and PROPOSES the
 * rest. It never invents a link from an address match alone — promote a proposal by adding the
 * property to `oraProperties`, then re-run.
 *
 * Opens the warehouse read-write but WITHOUT applying migrations (openWarehouseNoMigrate): a
 * warehouse that is behind this code is a hard error, so running this from an unmerged branch can
 * never change the live schema. The report-only run rolls its transaction back and writes nothing.
 */
import { loadEnvFile } from '../server/load-env';

loadEnvFile();

import { join } from 'node:path';
import { openWarehouseNoMigrate } from '../server/warehouse/db';
import { seedFromLeaseMarket, unmatchedReport } from '../server/warehouse/entity-xref';

const dbPath =
  process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const write = process.argv.includes('--write');

function main(): void {
  const db = openWarehouseNoMigrate(dbPath);
  try {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM entity_xref').get() as { n: number }).n;

    // A report-only run must not persist. The seeder writes through linkEntity, so hold the whole
    // thing in a transaction and roll it back unless --write was passed.
    let result = { linked: 0, proposed: [] as ReturnType<typeof seedFromLeaseMarket>['proposed'], skipped: [] as string[] };
    const run = db.transaction(() => {
      result = seedFromLeaseMarket(db);
      if (!write) throw new Error('__DRY_RUN__');
    });
    try {
      run();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__DRY_RUN__') throw err;
    }

    console.log(`${write ? 'WROTE' : 'DRY RUN'} — ${result.linked} propert${result.linked === 1 ? 'y' : 'ies'} linked (entity_xref had ${before} rows)`);

    // Surfaced first and separately: these are ORA's OWN buildings that the address map has not
    // caught up with. A null ora_property_key does not mean "not ORA" — owner_type is the
    // independent owner-name verdict, and burying these among third-party comps hides them.
    const oraUnmapped = result.proposed.filter((p) => p.reason === 'ora_owned_unmapped');
    if (oraUnmapped.length > 0) {
      console.log(`\n⚠ ${oraUnmapped.length} ORA-OWNED listing(s) missing from config oraProperties:`);
      for (const p of oraUnmapped) {
        console.log(`  lm_property ${p.lmPropertyId}  ${p.marketId}  ${p.addressNorm}  owner_type=${p.ownerType}`);
        console.log(`    likely ORA property: ${p.candidateCanonicalIds.join(', ') || '(no warehouse match)'}`);
      }
      console.log('  These are ORA buildings, not comps. Add each to config/lease-market.json oraProperties.');
    }

    const others = result.proposed.filter((p) => p.reason !== 'ora_owned_unmapped');
    if (others.length > 0) {
      console.log(`\n${others.length} listing(s) not linked:`);
      for (const p of others) {
        const candidates = p.candidateCanonicalIds.join(', ') || '(none)';
        console.log(`  lm_property ${p.lmPropertyId}  ${p.marketId}  ${p.addressNorm}`);
        console.log(`    reason=${p.reason}  candidates=${candidates}  ora_property_key=${p.oraPropertyKey ?? 'null'}`);
      }
      console.log('\nPromote a proposal by adding the property to config/lease-market.json oraProperties, then re-run.');
    }

    for (const s of result.skipped) console.log(`  SKIPPED: ${s}`);

    const orphans = unmatchedReport(db, 'property');
    if (orphans.length > 0) {
      console.log(`\n${orphans.length} warehouse propert${orphans.length === 1 ? 'y has' : 'ies have'} no link in any system:`);
      for (const o of orphans) console.log(`  ${o.canonicalId}  ${o.name}`);
    }

    if (!write) console.log('\nNothing was written. Re-run with --write to persist.');
  } finally {
    db.close();
  }
}

main();
