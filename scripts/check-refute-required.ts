// scripts/check-refute-required.ts
//
// Enforce the Engineering-OS doctrine (architecture/coding-standards.md): a change to
// financial-decision SOURCE — engine math / scoring / NOI / collections conditions / the financial
// overlay — must carry a `Refute-Reviewed:` (or, with justification, `Refute-Skip:`) commit trailer
// attesting that the refute-financial-change adversarial pass ran on it. Turns the written doctrine
// into a mechanical check so it cannot silently lapse.
//
// Default mode WARNS and exits 0 (local dev — never blocks WIP). `--strict` EXITS 1 on a violation
// (wired into CI for PRs; also usable from /ship). Fails OPEN on any git/tooling gap.
//
// Usage: tsx scripts/check-refute-required.ts [--strict] [--base=<ref>]
//   base defaults to $REFUTE_BASE, else 'origin/main'.
//
// Exported functions are pure (no I/O) so they unit-test without the process.exit side effects —
// the bottom-of-file guard runs main() only when executed directly (mirrors governance-check.ts).
import { execFileSync } from 'node:child_process';

// Pure route-plumbing / dispatch files in server/warehouse/ that contain no financial math —
// subtracted from the broad prefix. Fail-CLOSED elsewhere: any warehouse file NOT listed here
// still requires a refute trailer. See architecture/coding-standards.md.
// NOTE: actions.ts dispatches recompute (scoreProperties/detectAnomalies) but holds no math;
// re-evaluate this entry if it gains analytic logic.
export const DELIVERY_ONLY_PATHS: ReadonlySet<string> = new Set([
  'server/warehouse/api.ts',
  'server/warehouse/debt-api.ts',
  'server/warehouse/actions.ts',
  // Phase 3 W1: pure route-plumbing/dispatch; no financial math (math lives in
  // src/analytics/lease-forecast.ts and server/warehouse/lease-velocity.ts).
  'server/warehouse/lease-forecast-api.ts',
  // Lease Market Intelligence P1 Task 14: pure route plumbing (math lives in
  // src/analytics/lease-market/* and server/warehouse/lease-market/*, which stay refute-required
  // via the broad server/warehouse/ prefix).
  'server/warehouse/lease-market-api.ts',
  // Phase 5: pure route-plumbing; financial math lives in capital-allocation.ts + market-intel.ts.
  'server/warehouse/capital-allocation-api.ts',
  // Phase 5 W4: pure property-registration write; no financial math.
  'server/warehouse/property-onboarding.ts',
  // Direction 2: pure HTML IC-Memo renderer; all financial math lives in buildPortfolioAllocation
  // (capital-allocation.ts). This file only formats PortfolioAllocation for print-to-PDF.
  'server/warehouse/ic-memo.ts',
  // server/sources/ subtractions (2026-08-12): transport and indexing plumbing that carries no deal
  // or portfolio figures. Everything else under that prefix requires a trailer.
  'server/sources/graph-auth.ts',
  'server/sources/m365-tasks.ts',
  'server/sources/documents.ts',
]);

// Financial CONTRACT schemas (2026-07-24, PR #233 follow-up): a Zod contract change can carry
// direct governor blast radius — the LTV-bound episode put a magnitude bound on loan.ts's ltv
// field that made ONE bad workbook cell fail the ENTIRE portfolio snapshot parse, and the same
// field feeds computePortfolioAggregateLtv's Hard-Invariant-4 verdict. Yet no contracts file
// required a refute trailer: this gate had the same file-enumeration blind spot the weekly
// sweep's path list did. Enumerated (not the whole src/contracts/ dir) because most contracts
// there are non-financial plumbing (lease, property, insurance display shapes) — these four are
// the ones whose fields are consumed by governor/scoring math.
const FINANCIAL_CONTRACT_PATHS: ReadonlySet<string> = new Set([
  'src/contracts/loan.ts',
  'src/contracts/debt.ts',
  // deal.ts (2026-08-12): carries estPrice / capRate / irr / equityMultiple, the `confidential`
  // flag the bake redaction acts on, and notionDealId — the join key that decides which live
  // economics attach to which record. Added with the server/sources/ prefix below.
  'src/contracts/deal.ts',
  // common.ts holds the Market enum, which keys RCT_V03 (the ratified replacement-cost
  // denominator) and the cap-rate benchmark table.
  'src/contracts/common.ts',
  'src/contracts/warehouse.ts',
  'src/contracts/macro.ts',
  // Round-9 (fifth adversarial pass — all three lenses flagged the omission independently, one
  // by executing this very function): capital.ts holds HurdleRateConfig, the RATIFIED
  // hurdle-rate governor (bounds + ratification superRefine) consumed by capital-allocation.ts
  // and calibration.ts; capital-allocation.ts is the H6 read boundary bounding the capstone
  // scoring response (priorityScore/debtScore/dscr). Both meet the inclusion criterion above.
  // Evaluated and deliberately NOT included (yet): scenario.ts (alert display thresholds, no
  // governor math consumes its fields directly) and tax.ts (feeds tax-analysis display; add it
  // if a capital-decision path ever branches on its parsed fields — re-evaluate on next sweep).
  'src/contracts/capital.ts',
  'src/contracts/capital-allocation.ts',
  // Fix round 1 (Task 14 review, 2026-09-17): lease-market.ts carries LmThresholds — the
  // benchmark-n / similarity / radar-score / stale / withdrawn-lookback governor thresholds — plus
  // CellBenchmark and ComparableStats, consumed directly by the radar score and comparable-set math
  // in src/analytics/lease-market/{benchmarks,similarity,signals,radar}.ts. Same inclusion
  // criterion as loan.ts/debt.ts/capital.ts above: a silently dropped or renamed field desyncs the
  // contract from the governor math it types.
  'src/contracts/lease-market.ts',
]);

// Financial CONFIG (2026-09-21, weekly sweep — fifth occurrence of the scope-staleness mode): every
// `.json` under config/ is financial-decision input. The 2026-09-17 fix enumerated ONE file
// (lease-market.json) and, in its own comment, exempted config/lease-market.costar-headers.json as
// "a column-label map with no governor math" — but that file's rentPeriodDefault and rentBasisMap
// drive the x12 rent-period conversion and the NNN/MG/IG basis classification of every ingested
// rent (costar-parse.ts / normalize.ts), so a one-token edit repriced every listing with no
// attestation demanded. The enumeration also still missed replacement-cost.v3.json (RCT v03, the
// ratified basis denominator) and acquisition-ruleset.v1.json (the 0.65/0.90 basis floors).
// Per the doctrine this file's history keeps re-learning — an enumeration goes stale silently, a
// prefix fails closed — config/ is now a prefix, not a list. A genuinely non-financial config would
// have to be subtracted explicitly in NON_FINANCIAL_CONFIG_PATHS (empty today), which makes the
// exemption a reviewed, visible decision rather than an omission.
export const NON_FINANCIAL_CONFIG_PATHS: ReadonlySet<string> = new Set<string>();

// Financial DATA .json outside config/ (2026-09-21 refute round, same failure mode): the blanket `.json`
// exclusion below also exempted (a) the PFI account-mapping seed -- 339 GL accounts mapped to
// normalized_category / `excluded`, i.e. what counts as revenue vs opex in NOI, read by warehouse-backfill,
// warehouse-verify and warehouse-live-drift-check -- and (b) any `.json` sitting inside a financial source
// directory (server/warehouse/om-extract-fields.json is the OM price/SF extraction spec). Directories are
// a prefix (fail closed); the one out-of-tree data file is named.
const FINANCIAL_JSON_PREFIXES: readonly string[] = [
  'server/warehouse/',
  'server/workbook/',
  'src/analytics/',
];
// Subtracted from the prefixes above (Gabriel, 2026-09-21): server/warehouse/placeholders/*.placeholder.json are
// self-labelled PLACEHOLDER stand-ins for broker/assessor data (docs/placeholder-data.md), overridden
// automatically once real rows exist -- not live governor inputs. Without this every edit demanded a refute
// trailer, which trains people to reach for Refute-Skip.
const NON_FINANCIAL_JSON_PREFIXES: readonly string[] = ['server/warehouse/placeholders/'];
const FINANCIAL_DATA_PATHS: ReadonlySet<string> = new Set([
  'docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json',
]);

/** True when a changed path holds financial-decision SOURCE (not a test / doc / json fixture). */
export function isFinancialSourcePath(p: string): boolean {
  const path = p.replace(/\\/g, '/');
  if (path.startsWith('config/') && path.endsWith('.json') && !NON_FINANCIAL_CONFIG_PATHS.has(path)) {
    return true;
  }
  if (
    path.endsWith('.json') &&
    !NON_FINANCIAL_JSON_PREFIXES.some((pre) => path.startsWith(pre)) &&
    (FINANCIAL_DATA_PATHS.has(path) || FINANCIAL_JSON_PREFIXES.some((pre) => path.startsWith(pre)))
  ) {
    return true;
  }
  if (/\.(test|spec)\.(ts|tsx)$/.test(path) || path.endsWith('.md') || path.endsWith('.json')) return false;
  if (DELIVERY_ONLY_PATHS.has(path)) return false;
  return (
    path.startsWith('src/analytics/') ||
    path.startsWith('server/warehouse/') ||
    // server/workbook/ added 2026-08-11 after the weekly integrity sweep found it uncovered.
    // parse.ts produces the loans/NOI/debt-service snapshot and debt-service-crosscheck.ts audits
    // the next-12-month figure; BOTH sit in the annualDebtService chain feeding debt-scoring.ts
    // (the DSCR verdict) and src/analytics/engine.ts. Three commits touching the DSCR denominator
    // (9ab137d, 59d1995, b9a58c2) merged without this gate ever requiring a refute trailer.
    // Second occurrence of the scope-staleness mode — 2026-07-24 was the first, one directory
    // over — so prefer a broad directory prefix and subtract via DELIVERY_ONLY_PATHS above.
    path.startsWith('server/workbook/') ||
    // server/sources/ added 2026-08-12 — the THIRD occurrence of this scope-staleness mode, after
    // src/contracts (2026-07-24) and server/workbook (2026-08-11). The Deal-ID join redesign
    // rewrote the seed<->Notion joiner, which decides which live price / cap rate / IRR / lender
    // lands on which deal record AND which rows keep the fail-closed confidential default — and
    // this gate reported "no financial-decision source files changed" for the entire branch.
    // quickbooks.ts and notion-tenants.ts sit on the same prefix and carry cash and rent figures.
    // Broad prefix with subtractions above, per the doctrine the workbook entry established: an
    // enumeration goes stale silently, a prefix fails closed.
    path.startsWith('server/sources/') ||
    // The seed pipeline: source of truth for Deal.confidential AND the fallback deal set a Notion
    // outage publishes. A wrong edit here is a Hard-Invariant-3 exposure, not a fixture change.
    path === 'src/data/seed-deals.ts' ||
    path === 'src/data/public-deals.ts' ||
    FINANCIAL_CONTRACT_PATHS.has(path) ||
    path === 'src/brain/anomaly-insights.ts' ||
    path === 'src/brain/principal-digest.ts' ||
    // Priced against RCT v03, the ratified basis denominator — a governor-adjacent constant table.
    path === 'src/brain/replacement-cost.ts' ||
    path === 'server/overlay.ts'
  );
}

/** True when a refute attestation trailer appears anywhere in the commit-message blob. */
export function hasRefuteApproval(messageBlob: string): boolean {
  return /(^|\n)\s*Refute-(Reviewed|Skip):/i.test(messageBlob);
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function main(): void {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const base =
    argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ??
    process.env.REFUTE_BASE ??
    'origin/main';

  let changed: string[];
  let messageBlob: string;
  try {
    changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').map((s) => s.trim()).filter(Boolean);
    messageBlob = git(['log', `${base}..HEAD`, '--format=%B']);
  } catch (err) {
    // No usable base ref (shallow clone, detached HEAD, fresh repo) — never block on a tooling gap.
    console.warn(`check:refute — skipped: could not diff against '${base}' (${(err as Error).message.split('\n')[0]}).`);
    return;
  }

  const financial = changed.filter(isFinancialSourcePath);
  if (financial.length === 0) {
    console.log('check:refute — OK: no financial-decision source files changed in this range.');
    return;
  }
  if (hasRefuteApproval(messageBlob)) {
    console.log(`check:refute — OK: ${financial.length} financial file(s) changed; a Refute-Reviewed/Skip trailer is present.`);
    return;
  }

  const msg = [
    `check:refute — ${financial.length} financial-decision source file(s) changed WITHOUT a refute attestation:`,
    ...financial.map((f) => `    ${f}`),
    '',
    'Run the refute-financial-change workflow on the change, then add a commit trailer:',
    '    Refute-Reviewed: wf_<runId>        (or, with justification)  Refute-Skip: <reason>',
    `(checked range: ${base}..HEAD)`,
  ].join('\n');

  if (strict) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-refute-required.ts')) {
  main();
}
