import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import type { DealsDegradation } from '../server/sources/notion-deals';
import { checkSnapshot, hasReconciliationError } from '../server/reconcile-runtime';
import { getMacro } from '../server/macro/getMacro';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, referenceDate } from '../server/config';
import { etNow } from '../server/brief/state';
import type { GovernorSet, PortfolioSnapshot } from '../src/contracts/index';
// governors.ts is dependency-light (its ./db import is type-only); the sqlite driver itself is
// still loaded ONLY via the existsSync-gated dynamic import below (cadence decoupling preserved).
import { GOVERNOR_DEFAULTS } from '../server/warehouse/governors';

/**
 * Writer policy for the PUBLIC mirror: never bake a degraded deals source. Returns the refusal
 * message, or null when the bake may proceed.
 *
 * This is the strictest of portfolio.json's writers because its output is served EXTERNALLY by
 * brain.oxfordra.net. Brain.persist declines the shared mirror and keeps serving from memory; both
 * CLI writers refuse via requireLiveDealsSource. This script had NO gate at all, so a transient
 * Notion `fetch failed` during a scheduled bake published the ~6-deal seed placeholder set over the
 * ~20-deal live pipeline at exit 0 -- the 2026-08-09 failure mode on the worst possible surface.
 * `not-configured` refuses here too: unlike a dev server, a bake has no legitimate reason to run
 * without a token, and "the mirror is public" outranks "don't make the dev loop dirty".
 * (2026-08-11 integrity sweep, found by the refute pass on its own remediation branch.)
 */
/**
 * Writer policy for the PUBLIC mirror, part two: never bake an internally inconsistent snapshot.
 * Returns the refusal message, or null when the bake may proceed.
 *
 * This is the FOURTH publication path, and it ran no reconciliation gate at all — so a
 * phantom-lease-class rent overstatement (NOI overstated: the falsely-clearing direction) could ship
 * to an external surface while both CLI writers refused the very same snapshot. ERROR only, never
 * warn, matching Brain.persist and the CLI writers: warn-severity findings are long-lived and would
 * block the daily brief permanently.
 *
 * Deliberately evaluated on the PRE-redaction snapshot. Redaction removes confidential deals and
 * their counterparty links, which would itself look like an inconsistency to checkSnapshot — gating
 * after it would manufacture false refusals. (Catch-up sweep 2026-07-28..08-04, H2.)
 */
export function refuseBakeOnReconciliation(snapshot: PortfolioSnapshot): string | null {
  const flags = checkSnapshot(snapshot);
  if (!hasReconciliationError(flags)) return null;
  const which = flags
    .filter((f) => f.severity === 'error' && f.entity === 'reconciliation')
    .map((f) => `${f.field}: ${f.issue}`)
    .join('; ');
  return (
    `✗ bake-mirror: refusing to bake — this snapshot is internally inconsistent and this payload is ` +
    `served publicly. Both CLI writers refuse the same state. Reconciliation error(s): ${which}. ` +
    `Leaving the last good public/snapshot.json in place.`
  );
}

export function refuseBakeOnDegradedDeals(degraded: DealsDegradation | null): string | null {
  if (!degraded) return null;
  return (
    `✗ bake-mirror: refusing to bake — the Notion deals pipeline degraded (${degraded.reason}), so ` +
    `snapshot.deals would be the seed placeholder set rather than the live pipeline, and this payload ` +
    `is served publicly. Leaving the last good public/snapshot.json in place. Cause: ${degraded.detail}`
  );
}

loadEnvFile();

/**
 * Bakes the current workbook + macro into static JSON the client reads with no server —
 * powering the read-only Cloudflare mirror.
 *
 * CONFIDENTIALITY (non-negotiable): deals carrying `confidential: true` are REDACTED
 * by default. (No worked example is named here on purpose — the previous one, E. Fulton Street, was
 * declassified 2026-07-09 and the stale reference outlived it by weeks. The flag is the contract;
 * the current roster lives in confidential-terms.json.) They are included ONLY when MIRROR_INCLUDE_CONFIDENTIAL=1 is set explicitly,
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
  // dataQuality IS free text and DOES name deals. The previous justification for skipping it — "it is
  // parser-emitted" — was falsified in the same window it was written (ca068c5): checkSnapshot's
  // near-duplicate flag names both sides of a pair, and notion-deals' colliding-key design
  // deliberately routes CONFIDENTIAL rows into that detector. Until now the public mirror escaped only
  // by plumbing coincidence, because the bake path never ran checkSnapshot; gating the bake on it (H2)
  // without this sweep would have published those names. So the producer no longer emits them
  // (server/reconcile-runtime.ts) AND the publication boundary sweeps — belt and braces, because the
  // producer set is open-ended and any future flag author would otherwise have to remember this.
  // Swept over the whole flag, not just `issue`: `rawValue` is the field most likely to carry a raw
  // name or key. (Catch-up sweep 2026-07-28..08-04, M2.)
  // `?? []` deliberately: the contract makes dataQuality required, but a REDACTION step that throws on
  // a malformed snapshot is a worse failure mode than one that treats absent as empty -- a throw here
  // either fails the bake or, if some future caller catches it, skips redaction entirely.
  const dataQuality = (snapshot.dataQuality ?? []).filter(
    (f) => !mentionsRemoved(`${f.entity} ${f.field} ${f.issue} ${f.rawValue ?? ''}`),
  );
  // tenantNotes is TENANT-keyed, not deal-keyed, so the key alone never identifies a deal — but
  // its VALUE is free text (2nd refute pass: the initial "keyed fields are safe" audit reasoned
  // about keys only and missed this). Drop (not scrub — values are non-nullable) any entry
  // mentioning a removed deal's name. renewalStages/tenantArrears are structured, not free text;
  // loans/insurance are workbook-only (a pipeline deal produces neither).
  // dealComps' own free-text fields (CompSet.summary, comp addresses) are NOT
  // swept — accepted residual risk, same as today's zero-trigger status (bake never populates
  // dealComps/acquisitionInputs; the day a caller merges overlay data into the bake, this must be
  // revisited alongside them).
  const tenantNotes = Object.fromEntries(
    Object.entries(snapshot.tenantNotes).filter(([, note]) => !mentionsRemoved(note)),
  );
  return {
    snapshot: { ...snapshot, deals, counterparties, tasks, dealComps, acquisitionInputs, tenantNotes, dataQuality },
    removed: confidential.map((d) => d.name),
    removedCounterparties,
    removedTasks,
  };
}

/**
 * Should this bake run also produce the HEAVY `public/warehouse.json` (Fat Mirror)?
 *
 * Two inputs, deliberately narrow:
 *   - `--warehouse` as an exact argv token (a human at a terminal)
 *   - `BAKE_WAREHOUSE=1` in the environment (the scheduled daily task / deploy-mirror.ps1)
 *
 * STRICT on both: `=== '1'`, not a truthiness check, so `BAKE_WAREHOUSE=0` genuinely disables it;
 * and an exact argv match, so `--warehouse-dry-run` / `--no-warehouse` can never enable it by
 * prefix. Both matter because the warehouse bake is RAM/IO-heavy and contends with the live
 * server's WAL lock — the cadence decoupling this flag exists to enforce (spec §2.2) fails open
 * if the trigger is sloppy.
 *
 * Pure and injectable so the trigger can be tested without spawning the CLI or touching a DB.
 */
export function shouldBakeWarehouse(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  return argv.includes('--warehouse') || env.BAKE_WAREHOUSE === '1';
}

async function main() {
  const includeConfidential = process.env.MIRROR_INCLUDE_CONFIDENTIAL === '1';
  const pub = join(process.cwd(), 'public');
  mkdirSync(pub, { recursive: true });

  // Parse day-counts (lease monthsToExpiry) off the ET run date so the brief — and the mirror
  // this bake feeds — track the firm's timezone, not the process UTC date (a month-boundary
  // evening would otherwise roll monthsToExpiry a day early). Precedence mirrors run.ts:
  // REPORT_DATE pin → ET send date. Data-month selection is unaffected (still WORKBOOK_AS_OF).
  const { snapshot: raw, dealsDegraded } = await parseWorkbook(
    workbookPath(),
    referenceDate(etNow().date),
  );
  // This bake feeds an EXTERNAL surface, so it is the strictest of the writers: refuse outright
  // rather than publish placeholders. See refuseBakeOnDegradedDeals.
  const dealsRefusal = refuseBakeOnDegradedDeals(dealsDegraded);
  if (dealsRefusal) {
    console.error(dealsRefusal);
    process.exit(1);
  }
  // Reconciliation gate, on the PRE-redaction snapshot (see refuseBakeOnReconciliation).
  const reconRefusal = refuseBakeOnReconciliation(raw);
  if (reconRefusal) {
    console.error(reconRefusal);
    process.exit(1);
  }

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
  // NOTE: the trigger itself lives in shouldBakeWarehouse() below and is unit-tested
  // (tests/unit/bake-mirror-warehouse-flag.test.ts). It was inline and untested for two months,
  // during which nothing ever set either input and public/warehouse.json was never produced.
  // light hourly snapshot bake never pays for it (cadence decoupling). Dynamic import keeps the
  // warehouse deps (better-sqlite3, the api.ts router) out of the snapshot-only path entirely.
  if (shouldBakeWarehouse(process.argv, process.env)) {
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
