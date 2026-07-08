import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { getMacro } from '../server/macro/getMacro';
import { loadEnvFile } from '../server/load-env';
import { workbookPath } from '../server/config';
import type { PortfolioSnapshot } from '../src/contracts/index';

loadEnvFile();

/**
 * Bakes the current workbook + macro into static JSON the client reads with no server —
 * powering the read-only Cloudflare mirror.
 *
 * CONFIDENTIALITY (non-negotiable): confidential deals (e.g. E. Fulton Street) are REDACTED
 * by default. They are included ONLY when MIRROR_INCLUDE_CONFIDENTIAL=1 is set explicitly,
 * which must happen ONLY for a target verified to be gated behind Cloudflare Access. A public
 * *.pages.dev deploy must always run in the default (redacted) mode.
 */
function redactConfidential(snapshot: PortfolioSnapshot): { snapshot: PortfolioSnapshot; removed: string[] } {
  const confidential = snapshot.deals.filter((d) => d.confidential);
  if (confidential.length === 0) return { snapshot, removed: [] };
  const removedIds = new Set(confidential.map((d) => d.id));
  const deals = snapshot.deals.filter((d) => !d.confidential);
  const counterparties = snapshot.counterparties.map((cp) => ({
    ...cp,
    links: { ...cp.links, deals: cp.links.deals.filter((id) => !removedIds.has(id)) },
  }));
  return { snapshot: { ...snapshot, deals, counterparties }, removed: confidential.map((d) => d.name) };
}

async function main() {
  const includeConfidential = process.env.MIRROR_INCLUDE_CONFIDENTIAL === '1';
  const pub = join(process.cwd(), 'public');
  mkdirSync(pub, { recursive: true });

  const { snapshot: raw } = await parseWorkbook(workbookPath());
  if (process.env.BRIEF_ENABLED === '1') {
    const { runBrief } = await import('../server/brief/run');
    // M3: thread getMacro as macroProvider so the brief's refi-spread signal uses the live
    // DGS10 rate rather than the 0.065 fallback. Fail-open if getMacro throws.
    const r = await runBrief(raw, { macroProvider: getMacro });
    console.log(`  Brief: sent=${r.briefSent}, alerts=${r.alertsSent}`);
  }
  const { snapshot, removed } = includeConfidential ? { snapshot: raw, removed: [] } : redactConfidential(raw);

  writeFileSync(join(pub, 'snapshot.json'), JSON.stringify(snapshot));
  writeFileSync(join(pub, 'macro.json'), JSON.stringify(await getMacro()));

  const mode = includeConfidential ? 'FULL (confidential included — Access-gated targets only)' : 'REDACTED (public-safe)';
  console.log(`✓ Baked public/snapshot.json (${snapshot.properties.length} props, ${snapshot.leases.length} leases, ${snapshot.deals.length} deals) + public/macro.json`);
  console.log(`  Mode: ${mode}`);
  if (removed.length) console.log(`  Redacted ${removed.length} confidential deal(s): ${removed.join(', ')}`);
  if (includeConfidential) console.warn('  ⚠ CONFIDENTIAL DATA INCLUDED — deploy ONLY to a Cloudflare Access-gated target.');

  // Fat Mirror (Phase 1b): the HEAVY warehouse bake is OPT-IN (--warehouse / BAKE_WAREHOUSE=1) so the
  // light hourly snapshot bake never pays for it (cadence decoupling). Dynamic import keeps the
  // warehouse deps (better-sqlite3, the api.ts router) out of the snapshot-only path entirely.
  if (process.argv.includes('--warehouse') || process.env.BAKE_WAREHOUSE === '1') {
    const { bakeWarehouseJson } = await import('./bake-warehouse');
    const r = await bakeWarehouseJson();
    console.log(`✓ Baked public/warehouse.json (${r.count} endpoints, source: ${r.warehouseSource})`);
  }
}

// Run only as the invoked entry point — importing this module (e.g. from a test) must NOT bake.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/bake-mirror.ts')) {
  main().catch((err) => {
    console.error('✗ Bake failed:', err);
    process.exit(1);
  });
}
