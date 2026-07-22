// scripts/reconcile-lease-sources.ts
//
// Cross-checks the Master Workbook's lease/tenant rows (the source portfolio.json is built from,
// via extract-workbook.ts) against the live Notion Tenant Database. Read-only report — writes
// nothing to either source. Built 2026-07-21 after discovering portfolio.json's "Expired" rows
// for three tenants were already retired by that day's Tenant DB rent-roll reconciliation, with
// no mechanism for the workbook pipeline to ever notice the two sources had diverged.
//
// Exit codes: 0 = clean (no divergences), 2 = advisory findings (divergences reported — NOT a
// script failure, deliberately distinct from scripts/reconcile.ts's use of 1 for a genuine
// workbook-integrity failure), 1 = the script itself errored (workbook unreadable, etc.). This is
// intentionally NOT wired into `npm run gate` — a report finding must never fail a build the way
// a real integrity check does; wire it in only with a exit-code convention that preserves this.
//
// Usage: npx tsx scripts/reconcile-lease-sources.ts [--workbook <path>]
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath } from '../server/config';
import { loadNotionTenants } from '../server/sources/notion-tenants';
import { reconcileLeaseSources } from '../server/reconcile/lease-source-reconciliation';

loadEnvFile();

export interface CliArgs {
  workbook?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workbook') {
      const next = argv[i + 1];
      if (!next) throw new Error('missing value for --workbook');
      args.workbook = next;
      i += 1;
    }
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const wbPath = args.workbook ?? workbookPath();

  console.log(`reconcile-lease-sources: parsing workbook at ${wbPath}`);
  const { snapshot } = await parseWorkbook(wbPath);

  console.log('reconcile-lease-sources: fetching live Notion Tenant Database...');
  const notionTenants = await loadNotionTenants();
  if (notionTenants.length === 0) {
    console.log('  Notion Tenant DB unavailable (no NOTION_TOKEN, or fetch failed) — nothing to compare. See warning above if fetch failed.');
    return 0;
  }
  console.log(`  ${notionTenants.length} Notion tenant row(s) fetched.`);

  const result = reconcileLeaseSources(snapshot.leases, notionTenants);

  console.log('── LEASE SOURCE RECONCILIATION ─────────────────────────');
  console.log(`Workbook leases:          ${snapshot.leases.length}`);
  console.log(`Notion tenant rows:       ${notionTenants.length}`);
  console.log(`Divergences:              ${result.divergences.length}`);
  for (const d of result.divergences) {
    console.log(`  ⚠ ${d.tenantName} (${d.propertyKey}): workbook=${d.workbookStatus} vs Notion=${d.notionStatus} [${d.severity}]`);
    console.log(`      ${d.note}`);
  }
  console.log(`Skipped (no comparable status pair): ${result.skippedIncomparable.length}`);
  console.log(`Unmatched (workbook only, by name):   ${result.unmatchedInWorkbook.length}`);
  console.log(`Unmatched (Notion only, by name):     ${result.unmatchedInNotion.length}`);
  console.log(`Ambiguous (excluded from matching):   ${result.ambiguousNames.length}${result.ambiguousNames.length ? ` [${result.ambiguousNames.join(', ')}]` : ''}`);
  console.log('─────────────────────────────────────────────────────────');

  return result.divergences.length > 0 ? 2 : 0;
}

// Run the CLI only when invoked directly -- importing for tests must never fetch or print.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/reconcile-lease-sources.ts')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('reconcile-lease-sources: failed:', err);
      process.exit(1);
    });
}
