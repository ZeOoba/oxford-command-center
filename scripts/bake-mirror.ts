import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { getMacro } from '../server/macro/getMacro';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, referenceDate } from '../server/config';
import { etNow } from '../server/brief/state';
import type { GovernorSet, PortfolioSnapshot } from '../src/contracts/index';
// governors.ts is dependency-light (its ./db import is type-only); the sqlite driver itself is
// still loaded ONLY via the existsSync-gated dynamic import below (cadence decoupling preserved).
import { GOVERNOR_DEFAULTS } from '../server/warehouse/governors';

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
export function redactConfidential(snapshot: PortfolioSnapshot): {
  snapshot: PortfolioSnapshot; removed: string[]; removedCounterparties: string[]; removedTasks: number;
} {
  const confidential = snapshot.deals.filter((d) => d.confidential);
  if (confidential.length === 0) return { snapshot, removed: [], removedCounterparties: [], removedTasks: 0 };
  const removedIds = new Set(confidential.map((d) => d.id));
  // Free-text residue sweep (refute finding, high): human-typed text can name a confidential deal
  // anywhere free text exists, not just tasks. An exhaustive walk, not a bet on the producer —
  // computed once, applied to every free-text field below.
  const removedNames = confidential
    .flatMap((d) => [d.name, d.shortName])
    .filter((s): s is string => !!s)
    .map((s) => s.toLowerCase());
  const mentionsRemoved = (s: string | null): boolean => !!s && removedNames.some((n) => s.toLowerCase().includes(n));
  const scrub = (s: string | null): string | null => (mentionsRemoved(s) ? null : s);

  const deals = snapshot.deals
    .filter((d) => !d.confidential)
    .map((d) => ({ ...d, nextAction: scrub(d.nextAction), status: scrub(d.status) }));
  const counterparties: PortfolioSnapshot['counterparties'] = [];
  const removedCounterparties: string[] = [];
  for (const cp of snapshot.counterparties) {
    const keptDeals = cp.links.deals.filter((id) => !removedIds.has(id));
    const droppedAny = keptDeals.length !== cp.links.deals.length;
    const linkless = keptDeals.length === 0 && cp.links.properties.length === 0
      && cp.links.loans.length === 0 && cp.links.insurance.length === 0;
    if (droppedAny && linkless) {
      // Orphaned BY this redaction (I8): an orphaned lender name + market in the public bake
      // identifies the confidential deal it financed. Nodes with surviving links are kept
      // (deal link filtered); linkless memory-seeded nodes were never deal-linked and stay.
      removedCounterparties.push(cp.name);
      continue;
    }
    counterparties.push({ ...cp, notes: scrub(cp.notes), links: { ...cp.links, deals: keptDeals } });
  }
  // Task-text residue (refute finding C1): snapshot.tasks carries live M365 To-Do titles + note
  // bodies and workbook checklist labels — a task like "Send PSA redline — <deal name>" leaks the
  // deal redaction just deleted. Drop any task whose text mentions a removed deal's name.
  // (Residual risk accepted + documented: a task referencing only the ADDRESS is not caught.)
  const tasks = snapshot.tasks.filter((t) => !mentionsRemoved(`${t.label} ${t.notes ?? ''}`));
  const removedTasks = snapshot.tasks.length - tasks.length;
  // Deal-keyed overlay records (refute finding C3): dealComps/acquisitionInputs are keyed by deal
  // id — and the id is a slug of the deal NAME, so the key alone identifies the deal. Empty on
  // today's bake path (parseWorkbook supplies neither) but redaction must be an exhaustive walk
  // of the contract, not a bet on the current producer.
  const dealComps = Object.fromEntries(
    Object.entries(snapshot.dealComps).filter(([id]) => !removedIds.has(id)),
  );
  const acquisitionInputs = Object.fromEntries(
    Object.entries(snapshot.acquisitionInputs).filter(([id]) => !removedIds.has(id)),
  );
  // tenantNotes is TENANT-keyed, not deal-keyed, so the key alone never identifies a deal — but
  // its VALUE is free text (2nd refute pass: the initial "keyed fields are safe" audit reasoned
  // about keys only and missed this). Drop (not scrub — values are non-nullable) any entry
  // mentioning a removed deal's name. renewalStages/tenantArrears are structured, not free text;
  // loans/insurance are workbook-only (a pipeline deal produces neither); dataQuality is
  // parser-emitted. dealComps' own free-text fields (CompSet.summary, comp addresses) are NOT
  // swept — accepted residual risk, same as today's zero-trigger status (bake never populates
  // dealComps/acquisitionInputs; the day a caller merges overlay data into the bake, this must be
  // revisited alongside them).
  const tenantNotes = Object.fromEntries(
    Object.entries(snapshot.tenantNotes).filter(([, note]) => !mentionsRemoved(note)),
  );
  return {
    snapshot: { ...snapshot, deals, counterparties, tasks, dealComps, acquisitionInputs, tenantNotes },
    removed: confidential.map((d) => d.name),
    removedCounterparties,
    removedTasks,
  };
}

async function main() {
  const includeConfidential = process.env.MIRROR_INCLUDE_CONFIDENTIAL === '1';
  const pub = join(process.cwd(), 'public');
  mkdirSync(pub, { recursive: true });

  // Parse day-counts (lease monthsToExpiry) off the ET run date so the brief — and the mirror
  // this bake feeds — track the firm's timezone, not the process UTC date (a month-boundary
  // evening would otherwise roll monthsToExpiry a day early). Precedence mirrors run.ts:
  // REPORT_DATE pin → ET send date. Data-month selection is unaffected (still WORKBOOK_AS_OF).
  const { snapshot: raw } = await parseWorkbook(workbookPath(), referenceDate(etNow().date));

  // I10: the client alert engine reads governor boundaries from the payload. Resolved BEFORE the
  // brief (refute finding: the brief's evaluateConditions needs the same live governors or its
  // alerts diverge from the dashboard after a DB-only re-ratification). Warehouse-fresh when the
  // sqlite exists on the bake machine — opened READ-ONLY + fileMustExist so the bake can never
  // create, migrate, or WAL-touch the DB (refute finding) — compile-time defaults otherwise.
  let governors: GovernorSet | null = null;
  let governorSource = `compile-time defaults (v${GOVERNOR_DEFAULTS.version})`;
  const dbPath = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
  if (existsSync(dbPath)) {
    try {
      const [{ loadCapitalConfig }, { default: Database }] = await Promise.all([
        import('../server/warehouse/capital-config'),
        import('better-sqlite3'),
      ]);
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const g = loadCapitalConfig(db as unknown as Parameters<typeof loadCapitalConfig>[0]);
        governors = { dscrFloor: g.dscrFloor, ltvCeiling: g.ltvCeiling, hurdleRatePct: g.hurdleRatePct, hurdleRateRatification: g.hurdleRateRatification, version: g.version, effectiveFrom: g.effectiveFrom };
        governorSource = `warehouse (v${g.version}, effective ${g.effectiveFrom})`;
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn(`  ⚠ Governors: warehouse read failed — using compile-time defaults: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!governors) {
    governors = {
      dscrFloor: GOVERNOR_DEFAULTS.dscrFloor, ltvCeiling: GOVERNOR_DEFAULTS.ltvCeiling,
      hurdleRatePct: GOVERNOR_DEFAULTS.hurdleRatePct,
      hurdleRateRatification: GOVERNOR_DEFAULTS.hurdleRateRatification,
      version: GOVERNOR_DEFAULTS.version, effectiveFrom: GOVERNOR_DEFAULTS.effectiveFrom,
    };
  }

  if (process.env.BRIEF_ENABLED === '1') {
    const { runBrief } = await import('../server/brief/run');
    // M3: thread getMacro as macroProvider so the brief's refi-spread signal uses the live
    // DGS10 rate rather than the 0.065 fallback. Fail-open if getMacro throws.
    // Governors attached so brief alerts use the same live boundaries as the dashboard (I10).
    const r = await runBrief({ ...raw, governors }, { macroProvider: getMacro });
    console.log(`  Brief: sent=${r.briefSent}, alerts=${r.alertsSent}`);
  }
  const { snapshot, removed, removedCounterparties, removedTasks } = includeConfidential
    ? { snapshot: raw, removed: [], removedCounterparties: [], removedTasks: 0 }
    : redactConfidential(raw);

  writeFileSync(join(pub, 'snapshot.json'), JSON.stringify({ ...snapshot, governors }));
  writeFileSync(join(pub, 'macro.json'), JSON.stringify(await getMacro()));

  const mode = includeConfidential ? 'FULL (confidential included — Access-gated targets only)' : 'REDACTED (public-safe)';
  console.log(`✓ Baked public/snapshot.json (${snapshot.properties.length} props, ${snapshot.leases.length} leases, ${snapshot.deals.length} deals) + public/macro.json`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Governors: ${governorSource} — DSCR ≥ ${governors.dscrFloor} / LTV ≤ ${governors.ltvCeiling}`);
  // Operator visibility (I9): enumerate every baked deal so an unexpectedly-public deal is
  // visible in the bake log. Names are printed ONLY in redacted mode (where every baked deal is
  // public by construction); FULL mode logs a count so confidential names never hit a log sink
  // (refute finding — a future Start-Transcript around the deploy must not become a name sink).
  console.log(includeConfidential
    ? `  Deals baked: ${snapshot.deals.length} (names withheld — FULL mode)`
    : `  Deals baked: ${snapshot.deals.length ? snapshot.deals.map((d) => d.name).join(' · ') : '(none)'}`);
  // Counts only — confidential deal names and their orphaned counterparties must never hit a log
  // sink, even one Task Scheduler discards today (same by-construction rule as the FULL-mode line).
  if (removed.length) console.log(`  Redacted ${removed.length} confidential deal(s)`);
  if (removedCounterparties.length) console.log(`  Dropped ${removedCounterparties.length} orphaned counterpart${removedCounterparties.length === 1 ? 'y' : 'ies'} (I8)`);
  if (removedTasks) console.log(`  Dropped ${removedTasks} task(s) mentioning a confidential deal name`);
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
