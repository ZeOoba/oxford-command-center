import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  isFinancialSourcePath,
  hasRefuteApproval,
  findUnattestedCommits,
  parseCommitShow,
  collectCommits,
  evaluate,
  probeToolingGap,
  SHOW_ARGS,
  OCTOPUS_SHOW_ARGS,
  GIT_GLOBAL_ARGS,
  type CommitRecord,
  type GitRunner,
  DELIVERY_ONLY_PATHS,
  NON_FINANCIAL_CONFIG_PATHS,
  DEFAULT_DENY_ROOTS,
  NON_FINANCIAL_ROOT_PATHS,
} from '../../scripts/check-refute-required';

describe('check-refute-required — financial-source classification', () => {
  it('flags financial-decision source (incl. Windows separators)', () => {
    expect(isFinancialSourcePath('src/analytics/conditions.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/scores.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/calibration.ts')).toBe(true);
    expect(isFinancialSourcePath('server/overlay.ts')).toBe(true);
    expect(isFinancialSourcePath('src/brain/anomaly-insights.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\warehouse\\anomalies.ts')).toBe(true);
  });
  // 2026-08-11 sweep: server/workbook/ was absent from the gate while parse.ts and
  // debt-service-crosscheck.ts both sit in the annualDebtService chain feeding debt-scoring.ts
  // (DSCR) and src/analytics/engine.ts. Three commits touching the DSCR denominator landed
  // without a gate-required refute trailer. This is the second occurrence of the scope-staleness
  // mode (2026-07-24 was the first, one directory over) — a NEW financial directory must not be
  // invisible by default.
  it('flags server/workbook/ — the workbook parser and debt-service cross-check feed DSCR', () => {
    expect(isFinancialSourcePath('server/workbook/parse.ts')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/debt-service-crosscheck.ts')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/counterparties.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\workbook\\parse.ts')).toBe(true);
  });
  it('still ignores workbook tests and docs', () => {
    expect(isFinancialSourcePath('tests/unit/debt-service-crosscheck.test.ts')).toBe(false);
    expect(isFinancialSourcePath('server/workbook/debt-maturity.DESIGN.md')).toBe(false);
  });
  // 2026-08-12, THIRD occurrence of the scope-staleness mode. The Deal-ID join redesign rewrote
  // the seed<->Notion joiner — which decides which live price / cap rate / IRR / lender attaches
  // to which deal record, and which rows keep the fail-closed confidential default — and this gate
  // reported "no financial-decision source files changed" for the whole branch. Same shape as
  // src/contracts (2026-07-24) and server/workbook (2026-08-11): an enumeration that goes stale
  // silently. Fixed with a prefix, which fails closed as new files appear.
  it('flags server/sources/ — the deal joiner, the confidentiality gate, QuickBooks, tenants', () => {
    expect(isFinancialSourcePath('server/sources/notion-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/deal-name.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/deal-declassification.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/quickbooks.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/notion-tenants.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\sources\\notion-deals.ts')).toBe(true);
  });
  it('subtracts the transport/indexing plumbing under server/sources/', () => {
    expect(isFinancialSourcePath('server/sources/graph-auth.ts')).toBe(false);
    expect(isFinancialSourcePath('server/sources/m365-tasks.ts')).toBe(false);
    expect(isFinancialSourcePath('server/sources/documents.ts')).toBe(false);
    // …but a test beside them is still a test.
    expect(isFinancialSourcePath('server/sources/notion-deals.test.ts')).toBe(false);
  });
  it('flags the seed deal set and the RCT denominator table', () => {
    // seed-deals.ts is the source of truth for Deal.confidential AND the set published when Notion
    // is unreachable; replacement-cost.ts holds RCT v03, the ratified basis denominator.
    expect(isFinancialSourcePath('src/data/seed-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('src/data/public-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('src/brain/replacement-cost.ts')).toBe(true);
  });
  it('flags the deal + common contracts (deal economics, confidential flag, Market enum)', () => {
    expect(isFinancialSourcePath('src/contracts/deal.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/common.ts')).toBe(true);
  });
  it('ignores tests, docs, json, and non-financial source', () => {
    expect(isFinancialSourcePath('tests/unit/conditions.test.ts')).toBe(false);
    expect(isFinancialSourcePath('src/analytics/conditions.test.ts')).toBe(false);
    expect(isFinancialSourcePath('architecture/coding-standards.md')).toBe(false);
    expect(isFinancialSourcePath('architecture/status.json')).toBe(false);
    expect(isFinancialSourcePath('src/modules/principal/PrincipalModule.tsx')).toBe(false);
    expect(isFinancialSourcePath('src/lib/cn.ts')).toBe(false);
  });

  // 2026-07-24 (PR #233 follow-up): the LTV-bound episode proved a CONTRACT schema change can
  // carry direct governor blast radius — a bound briefly added to src/contracts/loan.ts's ltv
  // field made one bad workbook cell fail the entire portfolio snapshot, and the field feeds
  // computePortfolioAggregateLtv's Hard-Invariant-4 verdict. Yet no contracts file required a
  // refute trailer: the enforcement gate had the same file-enumeration blind spot the weekly
  // sweep's path list did. The four financial contracts are now classified as financial source.
  it('flags the financial contract schemas (loan/debt/warehouse/macro + capital pair)', () => {
    expect(isFinancialSourcePath('src/contracts/loan.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/debt.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/warehouse.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/macro.ts')).toBe(true);
    // Round-9 (fifth adversarial pass, all three lenses independently): capital.ts holds
    // HurdleRateConfig — the ratified hurdle-rate governor consumed by capital-allocation.ts and
    // calibration.ts — and capital-allocation.ts bounds the capstone scoring response. Both meet
    // the same inclusion criterion that added loan.ts; omitting them repeated the exact
    // enumeration blind spot this set exists to close.
    expect(isFinancialSourcePath('src/contracts/capital.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/capital-allocation.ts')).toBe(true);
  });

  it('still ignores non-financial contract schemas', () => {
    expect(isFinancialSourcePath('src/contracts/index.ts')).toBe(false);
    // common.ts moved to the financial set 2026-08-12 — see the case below. Deliberately narrow:
    // the barrel index stays out, so a re-export edit does not demand an attestation.
    expect(isFinancialSourcePath('src/contracts/lease.ts')).toBe(false);
    expect(isFinancialSourcePath('src/contracts/property.ts')).toBe(false);
  });

  // 2026-08-12: common.ts was explicitly pinned as NON-financial until this date. It holds the
  // Market enum, which keys RCT_V03 (the ratified replacement-cost denominator) and the cap-rate
  // benchmark table — so dropping or renaming a member silently unprices every deal in that market
  // rather than failing loudly. That meets this gate's stated inclusion criterion ("fields consumed
  // by governor/scoring math"). Accepted cost: the file also holds generic plumbing (Cell, slug,
  // DataQualityFlag), so unrelated edits there now need a trailer too. Fail closed on the enum
  // beats staying quiet on it.
  it('flags src/contracts/common.ts — the Market enum keys the RCT denominator', () => {
    expect(isFinancialSourcePath('src/contracts/common.ts')).toBe(true);
  });

  // Fix round 1, item 6 (Task 14 review): src/contracts/lease-market.ts carries LmThresholds (the
  // benchmark/similarity/radar governor thresholds) and CellBenchmark/ComparableStats — fields
  // consumed directly by the radar score and comparable-set math in
  // src/analytics/lease-market/{benchmarks,similarity,signals,radar}.ts. A silent field drop/rename
  // there would desync the contract from the math it types, the same governor-adjacent risk that put
  // loan.ts/debt.ts/capital.ts on this list.
  it('flags src/contracts/lease-market.ts — LmThresholds/CellBenchmark type the radar and comparable-set governor math', () => {
    expect(isFinancialSourcePath('src/contracts/lease-market.ts')).toBe(true);
  });

  // Broad-prefix coverage (server/warehouse/, src/analytics/) already reaches these — asserted
  // explicitly so a future DELIVERY_ONLY_PATHS or prefix change can't silently exempt them.
  it('reaches lease-market math files via the existing broad prefixes', () => {
    expect(isFinancialSourcePath('server/warehouse/lease-market/compute.ts')).toBe(true);
    expect(isFinancialSourcePath('src/analytics/lease-market/radar.ts')).toBe(true);
  });
});

describe('check-refute-required — financial config prefix (weekly sweep 2026-09-21)', () => {
  // 2026-09-17 enumerated config/lease-market.json only and explicitly exempted
  // config/lease-market.costar-headers.json as "no governor math" — but that file's
  // rentPeriodDefault / rentBasisMap drive the x12 rent-period conversion and NNN/MG/IG basis
  // classification of every ingested rent. replacement-cost.v3.json (RCT v03) and
  // acquisition-ruleset.v1.json (0.65/0.90 basis floors) were also uncovered. config/ is now a
  // fail-closed prefix: every .json under it is financial unless explicitly subtracted.
  it.each([
    'config/lease-market.json',
    'config/lease-market.costar-headers.json',
    'config/replacement-cost.v3.json',
    'config/acquisition-ruleset.v1.json',
    'config/acquisition-ruleset.v1.proposed.json',
    'config/archive/acquisition-ruleset.v1.0.0.json',
  ])('flags %s', (p) => {
    expect(isFinancialSourcePath(p)).toBe(true);
  });
  it('flags a config file added later without anyone remembering to enumerate it', () => {
    expect(isFinancialSourcePath('config/some-future-thresholds.json')).toBe(true);
  });
  it('normalizes Windows separators', () => {
    expect(isFinancialSourcePath('config\\lease-market.costar-headers.json')).toBe(true);
    expect(isFinancialSourcePath('config\\replacement-cost.v3.json')).toBe(true);
  });
  it('keeps the non-financial subtraction list empty and visible', () => {
    // Adding to this set is a reviewed decision. If you are here to add a config, justify it.
    expect(NON_FINANCIAL_CONFIG_PATHS.size).toBe(0);
  });
  it('flags financial DATA json outside config/: the account-mapping seed and json inside financial source dirs', () => {
    expect(isFinancialSourcePath('docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/om-extract-fields.json')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/some-table.json')).toBe(true);
    expect(isFinancialSourcePath('src/analytics/some-thresholds.json')).toBe(true);
  });
  it('exempts the self-labelled placeholder fixtures (Gabriel, 2026-09-21) but nothing else beside them', () => {
    for (const f of ['dec-pages', 'depreciable-basis', 'filed-returns', 'loss-runs']) {
      expect(isFinancialSourcePath(`server/warehouse/placeholders/${f}.placeholder.json`)).toBe(false);
      expect(isFinancialSourcePath(`server\\warehouse\\placeholders\\${f}.placeholder.json`)).toBe(false);
    }
    // a sibling json in the same directory tree is still financial
    expect(isFinancialSourcePath('server/warehouse/om-extract-fields.json')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/placeholders-real/x.json')).toBe(true);
    // only the *.placeholder.json fixtures directly in the folder: a future non-placeholder json is NOT exempt
    expect(isFinancialSourcePath('server/warehouse/placeholders/anything.json')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/placeholders/sub/deep.placeholder.json')).toBe(true);
  });
  it('still exempts .json outside config/ — the blanket rule applies elsewhere', () => {
    expect(isFinancialSourcePath('docs/superpowers/specs/some-other-spec.json')).toBe(false);
    expect(isFinancialSourcePath('architecture/status.json')).toBe(false);
    expect(isFinancialSourcePath('data/snapshots/portfolio.json')).toBe(false);
  });
});

describe('check-refute-required — AR delinquency subsystem (sweep 2026-09-22)', () => {
  // 2026-09-22: the SIXTH occurrence of the scope-staleness mode. server/ar/** — tenant-name →
  // Lease.id matching, confidence partitioning, latest-as-of resolution, dropped-lease clears — is
  // what decides WHICH lease a delinquency balance attaches to, and scripts/ar-import-headless.ts
  // writes those balances (tenantArrears / arBalances) into the overlay and snapshot unattended.
  // Against a real diff touching match-tenant.ts + ar-import-headless.ts, `check:refute --strict`
  // reported "no financial-decision source files changed". The weekly sweep's own SKILL.md has
  // listed `server/ar/**, scripts/ar-import-headless.ts, scripts/seed-ar-mappings.ts` in scope
  // since 2026-08-17; the gate that is supposed to enforce that sweep never did. Same remedy as
  // workbook/sources: a directory prefix (fails closed on new files) plus the named scripts.
  it('flags server/ar/ — the attribution matchers, the mapping cache, and the arrears resolvers', () => {
    expect(isFinancialSourcePath('server/ar/match-tenant.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/partition-confidence.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/mapping-cache.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/resolve-latest.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/resolve-by-unit.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/clear-dropped-leases.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/derive-ar-balances.ts')).toBe(true);
    // the report parsers turn PDF/xlsx text into per-tenant balances — figures, not plumbing
    expect(isFinancialSourcePath('server/ar/ar-aging.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/rent-manager-delinquency.ts')).toBe(true);
    // a file added to the directory later is in scope by default
    expect(isFinancialSourcePath('server/ar/some-future-matcher.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\ar\\match-tenant.ts')).toBe(true);
  });
  it('flags the AR writer scripts: the headless feed and the hand-confirmed mapping seed', () => {
    expect(isFinancialSourcePath('scripts/ar-import-headless.ts')).toBe(true);
    // seed-ar-mappings.ts hardcodes human-ruled tenant→lease attributions and writes them into the
    // cache; editing which lease a name resolves to is the same decision class as the matcher.
    expect(isFinancialSourcePath('scripts/seed-ar-mappings.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts\\ar-import-headless.ts')).toBe(true);
    // Refute pass: the interactive importer holds its own `autoAccept` attribution threshold and
    // writes cache entries + arrears; the sweep SKILL.md's scope list omits it — same stale-enumeration
    // mode as everything above.
    expect(isFinancialSourcePath('scripts/ar-import.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts\\ar-import.ts')).toBe(true);
  });
  it('treats a .json inside server/ar/ as financial data, like the other financial source dirs', () => {
    expect(isFinancialSourcePath('server/ar/tenant-aliases.json')).toBe(true);
    expect(isFinancialSourcePath('server\\ar\\property-headers.json')).toBe(true);
  });
  it('still ignores AR tests', () => {
    expect(isFinancialSourcePath('tests/unit/mapping-cache.test.ts')).toBe(false);
    expect(isFinancialSourcePath('server/ar/match-tenant.test.ts')).toBe(false);
  });
  // Same 2026-09-21 failure mode, missed for two files: the blanket `.json` exemption also covered
  // data/ar-mapping-cache.json (persistent tenant-name → Lease.id map incl. durable human SKIP
  // rulings — it governs which delinquency rows auto-attribute without review) and data/overlay.json
  // (the canonical mutation store the headless feed writes arrears into). overlay.json is gitignored,
  // so the entry is defense-in-depth against a force-add; the cache IS tracked and PR-committed.
  it('flags the AR mapping cache and the overlay store — top-level data/ json the blanket rule exempted', () => {
    expect(isFinancialSourcePath('data/ar-mapping-cache.json')).toBe(true);
    expect(isFinancialSourcePath('data/overlay.json')).toBe(true);
    expect(isFinancialSourcePath('data\\ar-mapping-cache.json')).toBe(true);
  });
  it('does not widen to the rest of data/ — the snapshot and review queue stay exempt', () => {
    expect(isFinancialSourcePath('data/snapshots/portfolio.json')).toBe(false);
    expect(isFinancialSourcePath('data/ar/review-queue.json')).toBe(false);
  });
});

describe('check-refute-required — default-deny roots server/ and scripts/ (Gabriel, 2026-09-22)', () => {
  // Six times by the identical mechanism (contracts 2026-07-24, workbook 2026-08-11, sources
  // 2026-08-12, AR data 2026-08-17, config/data json 2026-09-21, server/ar + writer scripts
  // 2026-09-22) a financial subsystem landed in a directory the allow-list had not been told about,
  // and this gate said "no financial-decision source files changed" until someone noticed. An
  // allow-list defaults every unlisted path to NOT financial — the unsafe direction. server/ and
  // scripts/ are now DEFAULT-DENY: every path under them is financial-decision source unless it is
  // named in NON_FINANCIAL_ROOT_PATHS with a justification. The cases below are files that exist on
  // main today, hold financial decisions, and were NOT reached by any prefix or name before this.
  it('flags top-level server/ files no prefix ever reached', () => {
    // brain.ts orchestrates the snapshot: which QuickBooks block wins, when persist() declines.
    expect(isFinancialSourcePath('server/brain.ts')).toBe(true);
    // reconcile-runtime.ts holds the NOI / rent / cash invariants and the 1% unresolved-rent share.
    expect(isFinancialSourcePath('server/reconcile-runtime.ts')).toBe(true);
    // anomaly-floor.ts is the refusal threshold on every lease-set write.
    expect(isFinancialSourcePath('server/anomaly-floor.ts')).toBe(true);
    // config.ts holds WORKBOOK_AS_OF / referenceDate — the run-date basis for WALT and day-counts.
    expect(isFinancialSourcePath('server/config.ts')).toBe(true);
    // index.ts is the write surface: noi-budget, tenant-arrears, market-rent, acquisition-input.
    expect(isFinancialSourcePath('server/index.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\brain.ts')).toBe(true);
  });
  it('flags server/ subdirectories no prefix ever reached', () => {
    // insights/: the ranking weights and the honesty constants (MIN_PAIRS) behind every insight.
    expect(isFinancialSourcePath('server/insights/rank.ts')).toBe(true);
    expect(isFinancialSourcePath('server/insights/stats.ts')).toBe(true);
    expect(isFinancialSourcePath('server/insights/generators/cf-hurdle-drag.ts')).toBe(true);
    // macro/: the DGS5 market rate conditions.ts reads, and the cap-rate benchmark bands.
    expect(isFinancialSourcePath('server/macro/fred.ts')).toBe(true);
    expect(isFinancialSourcePath('server/macro/market-benchmarks.ts')).toBe(true);
    // brief/: the collections alerts' confirm-clear lifecycle and the daily-brief conditions run.
    expect(isFinancialSourcePath('server/brief/run.ts')).toBe(true);
    expect(isFinancialSourcePath('server/brief/state.ts')).toBe(true);
    // briefing/compose.ts selects which engine figures a briefing carries; confidential.ts is the
    // Hard-Invariant-3 scanner behind it.
    expect(isFinancialSourcePath('server/briefing/compose.ts')).toBe(true);
    expect(isFinancialSourcePath('server/briefing/confidential.ts')).toBe(true);
    // notion/capital-writeback.ts persists capitalAction + priorityScore into the Property Register.
    expect(isFinancialSourcePath('server/notion/capital-writeback.ts')).toBe(true);
    // reconcile/: the workbook-vs-Notion lease reconciliation.
    expect(isFinancialSourcePath('server/reconcile/lease-source-reconciliation.ts')).toBe(true);
    // ai/: the tools that decide which figures the agent quotes, and the comps egress guard.
    expect(isFinancialSourcePath('server/ai/tools.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ai/comps.ts')).toBe(true);
    // lib/pdf-text.ts is the input boundary of every PDF figure — same reasoning that kept
    // server/ar/pdf-extract.ts in scope.
    expect(isFinancialSourcePath('server/lib/pdf-text.ts')).toBe(true);
    // alerts/store.ts persists which collections/DSCR alerts are acknowledged or snoozed.
    expect(isFinancialSourcePath('server/alerts/store.ts')).toBe(true);
  });
  it('flags the warehouse access boundary — a silent weakening exposes every figure at once', () => {
    expect(isFinancialSourcePath('server/access-authz.ts')).toBe(true);
    expect(isFinancialSourcePath('server/host-guard.ts')).toBe(true);
    expect(isFinancialSourcePath('server/cors-policy.ts')).toBe(true);
    expect(isFinancialSourcePath('server/rate-limit.ts')).toBe(true);
  });
  it('flags scripts/ writers and gates that were never named', () => {
    // extract-workbook.ts and lease-snapshot-drift-check.ts WRITE data/snapshots/portfolio.json.
    expect(isFinancialSourcePath('scripts/extract-workbook.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/lease-snapshot-drift-check.ts')).toBe(true);
    // bake-mirror.ts / bake-warehouse.ts publish the snapshot and computed route payloads externally.
    expect(isFinancialSourcePath('scripts/bake-mirror.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/bake-warehouse.ts')).toBe(true);
    // debt-scores-snapshot.ts persists DSCR verdicts; debt-snapshot-backfill.ts writes debt_positions.
    expect(isFinancialSourcePath('scripts/debt-scores-snapshot.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/debt-snapshot-backfill.ts')).toBe(true);
    // calibration-refit.ts proposes health weights; calibration-snapshot.ts logs verdicts.
    expect(isFinancialSourcePath('scripts/calibration-refit.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/calibration-snapshot.ts')).toBe(true);
    // importers write premiums / tax assessments into the warehouse.
    expect(isFinancialSourcePath('scripts/import-insurance-data.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/import-assessments.ts')).toBe(true);
    // the workbook / warehouse / NOI reconciliation gates and the lease-market CLI.
    expect(isFinancialSourcePath('scripts/reconcile.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/reconcile-noi-crosscheck.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/warehouse-verify.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/warehouse-backfill.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/lease-market.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/migrate-lease-overlay-ids.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts\\extract-workbook.ts')).toBe(true);
  });
  it('flags scripts/ files in other languages — the root is what matters, not the extension', () => {
    // The owner-screen bridge classifies which owners may be called (fail-closed guard).
    expect(isFinancialSourcePath('scripts/lease-market-owner-screen.py')).toBe(true);
    // deploy-mirror.ps1 sets MIRROR_INCLUDE_CONFIDENTIAL=1 and owns the Access-gate probe that keeps
    // a confidential bake from being left publicly reachable — Hard-Invariant-3 wiring.
    expect(isFinancialSourcePath('scripts/deploy-mirror.ps1')).toBe(true);
    // lib/deploy-alert.ps1 (refute pass, 2026-09-22): Test-SuppressibleReason + the -Critical guard
    // decide whether the GATE CHECK FAILED (confidential bake publicly reachable) alert can be
    // suppressed — the same Hard-Invariant-3 wiring that keeps deploy-mirror.ps1 in scope. Its
    // sibling helpers (beacon, buildroot, timeouts) stay exempt.
    expect(isFinancialSourcePath('scripts/lib/deploy-alert.ps1')).toBe(true);
    expect(NON_FINANCIAL_ROOT_PATHS.has('scripts/lib/deploy-alert.ps1')).toBe(false);
    // The pre-push confidentiality scanner and the installer that decides whether it blocks.
    expect(isFinancialSourcePath('scripts/prepush-confidential-scan.mjs')).toBe(true);
    expect(isFinancialSourcePath('scripts/install-git-hooks.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/prepare-hooks.mjs')).toBe(true);
    expect(isFinancialSourcePath('scripts/prepush-noi-crosscheck.mjs')).toBe(true);
    // governance-check.ts carries checkGovernorLiteralCoupling — the DSCR/LTV literal-drift guard.
    expect(isFinancialSourcePath('scripts/governance-check.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/check-snapshot-freshness.ts')).toBe(true);
  });
  it('flags this gate itself — the file that defines the financial scope is in that scope', () => {
    expect(isFinancialSourcePath('scripts/check-refute-required.ts')).toBe(true);
  });
  it('flags a subsystem added later without anyone remembering to enumerate it', () => {
    // The seventh occurrence cannot happen by this mechanism: an unlisted directory is IN scope.
    expect(isFinancialSourcePath('server/some-future-subsystem/engine.ts')).toBe(true);
    expect(isFinancialSourcePath('server/new-top-level-file.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/some-future-writer.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/lib/some-future-helper.ps1')).toBe(true);
    expect(isFinancialSourcePath('scripts/new-dir/anything.mjs')).toBe(true);
  });
  it('still reaches every path the retired explicit prefixes and names covered', () => {
    // These were the six patched-in entries. Under default-deny they are reached by the root; this
    // pins that folding the prefixes into the root never narrowed coverage.
    expect(isFinancialSourcePath('server/warehouse/scores.ts')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/parse.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/notion-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/match-tenant.ts')).toBe(true);
    expect(isFinancialSourcePath('server/overlay.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/ar-import-headless.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/seed-ar-mappings.ts')).toBe(true);
    // ar-import.ts is reached by the root — the weekly sweep SKILL.md no longer needs to name it.
    expect(isFinancialSourcePath('scripts/ar-import.ts')).toBe(true);
  });
  it('keeps the test / doc / json rules ahead of the root rule', () => {
    expect(isFinancialSourcePath('server/brain.test.ts')).toBe(false);
    expect(isFinancialSourcePath('server/insights/rank.spec.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/debt-maturity.DESIGN.md')).toBe(false);
    expect(isFinancialSourcePath('scripts/README.md')).toBe(false);
    // scripts/data/*.json is an ingest receipt nothing reads back (import-insurance-data.ts writes
    // it); the blanket .json rule still applies outside the FINANCIAL_JSON_PREFIXES — unchanged.
    expect(isFinancialSourcePath('scripts/data/2026-08-22-insurance-premium-history.json')).toBe(false);
    // …but a .json ANYWHERE under server/ is financial data (refute pass, 2026-09-22): the header's
    // "every path under server/ is financial" was untrue for a weights or benchmark table dropped
    // beside the source that reads it, because the blanket .json exemption runs before the root
    // rule. FINANCIAL_JSON_PREFIXES now carries 'server/' (subsuming warehouse/workbook/ar).
    expect(isFinancialSourcePath('server/insights/weights.json')).toBe(true);
    expect(isFinancialSourcePath('server/macro/benchmarks.json')).toBe(true);
    expect(isFinancialSourcePath('server/some-future-subsystem/table.json')).toBe(true);
    expect(isFinancialSourcePath('server\\macro\\benchmarks.json')).toBe(true);
    // The reviewed placeholder subtraction is unchanged.
    expect(isFinancialSourcePath('server/warehouse/placeholders/loss-runs.placeholder.json')).toBe(false);
  });
  it('keeps the DELIVERY_ONLY_PATHS subtractions ahead of the root rule', () => {
    expect(isFinancialSourcePath('server/warehouse/api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/sources/graph-auth.ts')).toBe(false);
  });
  it('exposes the two roots so a future edit cannot silently drop one', () => {
    expect([...DEFAULT_DENY_ROOTS]).toEqual(['server/', 'scripts/']);
  });
});

describe('check-refute-required — reviewed non-financial exemptions under the default-deny roots', () => {
  // Every entry below was read (2026-09-22 survey) and exempted for a stated reason; each holds no
  // financial figure, threshold, mapping or writer, is not an input/output boundary for one, and is
  // not Hard-Invariant-3 gate wiring. Adding to this set is a reviewed decision — justify it inline
  // in NON_FINANCIAL_ROOT_PATHS, then add the path here with the same reason.
  it('exempts server/ plumbing that carries no figure', () => {
    // .env KEY=VALUE loader with override-on-empty.
    expect(isFinancialSourcePath('server/load-env.ts')).toBe(false);
    // Outlook COM transport + data/outbox fallback; recipients and content are decided in run.ts.
    expect(isFinancialSourcePath('server/brief/send.ts')).toBe(false);
    // attachment-filename sanitizer.
    expect(isFinancialSourcePath('server/briefing/filename.ts')).toBe(false);
    // brand tokens + font registration, and the WOFF1 -> TTF decoder behind it.
    expect(isFinancialSourcePath('server/briefing/theme.ts')).toBe(false);
    expect(isFinancialSourcePath('server/briefing/woff-to-ttf.ts')).toBe(false);
    // pure BriefingModel -> PDF renderer; every figure is read off the model (ic-memo.ts precedent).
    expect(isFinancialSourcePath('server/briefing/pdf.tsx')).toBe(false);
    expect(isFinancialSourcePath('server\\briefing\\pdf.tsx')).toBe(false);
  });
  it('exempts scripts/ dev tooling that never touches a figure', () => {
    // bundle-size gate, dev-CSS parse gate, dev-server startup watchdog, npm-ci self-heal.
    expect(isFinancialSourcePath('scripts/check-bundle.ts')).toBe(false);
    expect(isFinancialSourcePath('scripts/check-dev-css.ts')).toBe(false);
    expect(isFinancialSourcePath('scripts/dev-watchdog.cjs')).toBe(false);
    expect(isFinancialSourcePath('scripts/ensure-deps.mjs')).toBe(false);
    // static analysis over route/migration/Zod source text — reads no figure, writes no table.
    expect(isFinancialSourcePath('scripts/check-write-schema-drift.ts')).toBe(false);
    // document-embedding driver (server/sources/documents.ts is already delivery-only).
    expect(isFinancialSourcePath('scripts/index-docs.ts')).toBe(false);
    // git-worktree helper.
    expect(isFinancialSourcePath('scripts/safe-worktree.ts')).toBe(false);
  });
  it('exempts the Windows scheduled-task and mirror-deploy ops helpers (the historical false-positive class)', () => {
    // 17 ops PRs (#172 … #341) touched only these; none decided a figure. deploy-mirror.ps1 itself
    // stays IN scope (confidential bake flag + Access-gate probe) — only its helpers are exempt.
    for (const p of [
      'scripts/mirror-run-classify.ps1',
      'scripts/mirror-classify-offfleet.ps1',
      'scripts/register-brain-server-task.ps1',
      'scripts/register-mirror-classify-offfleet-task.ps1',
      'scripts/register-mirror-task.ps1',
      'scripts/reindex-loop.ps1',
      'scripts/start-brain-server.ps1',
      'scripts/stop-brain-server.ps1',
      'scripts/lib/cmd-arg-guard.ps1',
      'scripts/lib/deploy-beacon.ps1',
      'scripts/lib/deploy-buildroot.ps1',
      'scripts/lib/git-capture.ps1',
      'scripts/lib/job-timeout.ps1',
      'scripts/lib/mirror-task-action.ps1',
      'scripts/lib/native-timeout.ps1',
    ]) {
      expect(isFinancialSourcePath(p), p).toBe(false);
      expect(isFinancialSourcePath(p.replace(/\//g, '\\')), p).toBe(false);
    }
  });
  it('exempts PowerShell smoke tests as test scaffolding, in scripts/ and scripts/lib/ only', () => {
    expect(isFinancialSourcePath('scripts/deploy-beacon.smoke-test.ps1')).toBe(false);
    expect(isFinancialSourcePath('scripts/mirror-run-classify.smoke-test.ps1')).toBe(false);
    expect(isFinancialSourcePath('scripts/lib/fake-mailer.smoke-test.ps1')).toBe(false);
    expect(isFinancialSourcePath('scripts\\job-timeout.smoke-test.ps1')).toBe(false);
    // a future smoke test is still a test …
    expect(isFinancialSourcePath('scripts/some-future.smoke-test.ps1')).toBe(false);
    // … but the suffix alone does not exempt a file outside those two folders or a non-ps1.
    expect(isFinancialSourcePath('scripts/deep/nested.smoke-test.ps1')).toBe(true);
    expect(isFinancialSourcePath('scripts/something.smoke-test.ts')).toBe(true);
  });
  it('exposes the exemption set with the expected membership so a silent widening is visible', () => {
    expect(NON_FINANCIAL_ROOT_PATHS.size).toBe(28);
    for (const p of NON_FINANCIAL_ROOT_PATHS) {
      expect(p.startsWith('server/') || p.startsWith('scripts/'), p).toBe(true);
      expect(isFinancialSourcePath(p), p).toBe(false);
    }
    // No entry may name a path that a narrower, already-reviewed rule keeps in scope.
    expect(NON_FINANCIAL_ROOT_PATHS.has('scripts/deploy-mirror.ps1')).toBe(false);
    expect(NON_FINANCIAL_ROOT_PATHS.has('scripts/check-refute-required.ts')).toBe(false);
  });
});

describe('check-refute-required — delivery-only allowlist', () => {
  it('treats delivery-only warehouse routing files as non-financial', () => {
    expect(isFinancialSourcePath('server/warehouse/api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/debt-api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/actions.ts')).toBe(false);
    // Phase 3 W1: lease-forecast-api.ts is pure route-plumbing (no math)
    expect(isFinancialSourcePath('server/warehouse/lease-forecast-api.ts')).toBe(false);
    // Lease Market Intelligence P1 Task 14: lease-market-api.ts is pure route-plumbing (no math)
    expect(isFinancialSourcePath('server/warehouse/lease-market-api.ts')).toBe(false);
    // Windows separators normalize before set lookup
    expect(isFinancialSourcePath('server\\warehouse\\api.ts')).toBe(false);
  });
  it('still flags non-allowlisted warehouse files', () => {
    expect(isFinancialSourcePath('server/warehouse/scores.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/debt-scoring.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/acq-engine.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/queries.ts')).toBe(true);
    // lease-velocity.ts holds financial math — must NOT be in delivery-only
    expect(isFinancialSourcePath('server/warehouse/lease-velocity.ts')).toBe(true);
  });
  it('exposes the delivery-only allowlist with the expected membership', () => {
    expect(DELIVERY_ONLY_PATHS.size).toBe(11);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/debt-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/actions.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/lease-forecast-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/lease-market-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/capital-allocation-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/property-onboarding.ts')).toBe(true);
    // server/sources/ subtractions, added with the prefix 2026-08-12: transport and indexing
    // plumbing that carries no deal or portfolio figures.
    expect(DELIVERY_ONLY_PATHS.has('server/sources/graph-auth.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/sources/m365-tasks.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/sources/documents.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/ic-memo.ts')).toBe(true);
  });
});

describe('check-refute-required — trailer detection', () => {
  it('detects Refute-Reviewed / Refute-Skip in a commit message (case-insensitive)', () => {
    expect(hasRefuteApproval('fix: x\n\nRefute-Reviewed: wf_abc123')).toBe(true);
    expect(hasRefuteApproval('chore\n\nRefute-Skip: docs-only adjustment')).toBe(true);
    expect(hasRefuteApproval('refute-reviewed: wf_x')).toBe(true);
  });
  it('returns false when no attestation trailer is present', () => {
    expect(hasRefuteApproval('fix: something\n\nCo-Authored-By: someone')).toBe(false);
    expect(hasRefuteApproval('')).toBe(false);
  });
});

// 2026-09-23: attestation is per COMMIT, not per range. The gate used to search the concatenated
// `git log base..HEAD` blob, so one Refute-Skip anywhere attested every commit in the PR.
describe('check-refute-required — trailer value', () => {
  it('a trailer needs a real value on its own line', () => {
    expect(hasRefuteApproval('fix\n\nRefute-Skip:\n')).toBe(false);
    expect(hasRefuteApproval('fix\n\nRefute-Skip:   \n')).toBe(false);
    expect(hasRefuteApproval('fix\n\nRefute-Skip:\nnot a value on the same line\n')).toBe(false);
    expect(hasRefuteApproval('fix\n\n  Refute-Skip: indented is still a trailer\n')).toBe(true);
  });
  it("pasting the gate's own hint line does not attest", () => {
    expect(
      hasRefuteApproval('fix\n\n    Refute-Reviewed: wf_<runId>        (or, with justification)  Refute-Skip: <reason>\n'),
    ).toBe(false);
    expect(hasRefuteApproval('fix\n\nRefute-Skip: <reason>\n')).toBe(false);
    // A second, real trailer in the same message still counts.
    expect(hasRefuteApproval('fix\n\nRefute-Skip: <reason>\nRefute-Reviewed: wf_real1\n')).toBe(true);
  });
});

describe('check-refute-required — per-commit attestation', () => {
  const skipParent: CommitRecord = {
    sha: '4e2be44000000000000000000000000000000000',
    message:
      'fix(warehouse): JSON error bodies for uncaught route errors\n\n' +
      'Refute-Skip: error transport only — no financial computation, ranking, or threshold touched\n',
    files: ['server/warehouse/sub-routers.ts', 'src/modules/sourcing/SourcingModule.tsx'],
  };
  const unattestedChild: CommitRecord = {
    sha: '588fa81000000000000000000000000000000000',
    message: 'fix(alerts): one expiry insight per lease — stop double-counting risk $\n',
    files: ['src/analytics/conditions.ts', 'tests/unit/conditions.test.ts'],
  };
  const showOutput = (c: CommitRecord): string => `${c.message}\0\0\n${c.files.map((f) => `${f}\0`).join('')}`;

  it('a Refute-Skip on the parent does NOT attest an unattested financial child (the 2026-09-23 repro)', () => {
    // The old range-level check passed this range: the concatenated blob contains a trailer.
    expect(hasRefuteApproval([skipParent, unattestedChild].map((c) => c.message).join('\n'))).toBe(true);
    expect(findUnattestedCommits([skipParent, unattestedChild])).toEqual([
      {
        sha: unattestedChild.sha,
        subject: 'fix(alerts): one expiry insight per lease — stop double-counting risk $',
        financial: ['src/analytics/conditions.ts'],
      },
    ]);
  });

  it('order does not matter — a later trailer does not attest an earlier commit', () => {
    expect(findUnattestedCommits([unattestedChild, skipParent]).map((u) => u.sha)).toEqual([unattestedChild.sha]);
  });

  it('passes when every financial commit carries its own trailer', () => {
    const attestedChild = { ...unattestedChild, message: unattestedChild.message + '\nRefute-Reviewed: wf_abc123\n' };
    expect(findUnattestedCommits([skipParent, attestedChild])).toEqual([]);
  });

  it('a commit with no financial source needs no trailer', () => {
    const docsOnly: CommitRecord = { sha: 'd0c5', message: 'docs: x\n', files: ['README.md', 'tests/unit/a.test.ts'] };
    expect(findUnattestedCommits([docsOnly])).toEqual([]);
  });

  it('parseCommitShow splits the -z output: message, NUL, NUL-terminated paths (never trimmed)', () => {
    const raw = 'fix: x\n\nbody\n\nRefute-Skip: y\n\0\0\nsrc/analytics/conditions.ts\0 lead space.ts\0src/analytics/q"x.ts\0';
    expect(parseCommitShow('abc', raw)).toEqual({
      sha: 'abc',
      message: 'fix: x\n\nbody\n\nRefute-Skip: y\n',
      files: ['src/analytics/conditions.ts', ' lead space.ts', 'src/analytics/q"x.ts'],
    });
    // A clean merge under --remerge-diff: message and terminators, no paths.
    expect(parseCommitShow('m', 'Merge x into y\n\0\0').files).toEqual([]);
    // A trailer-looking path after the NUL is a path, not an attestation.
    expect(parseCommitShow('e', 'chore\n\0\0\nRefute-Skip: evil.ts\0').message).toBe('chore\n');
  });

  it('parseCommitShow throws on output without the terminator', () => {
    expect(() => parseCommitShow('abc', 'fix: x\n\nsrc/analytics/conditions.ts\n')).toThrow(/no message terminator/);
  });

  it('parseCommitShow throws on anything after the last path terminator (the octopus warning shape)', () => {
    // git 2.55 on an octopus under --remerge-diff: the warning replaces the path list.
    expect(() => parseCommitShow('o', 'octo\n\0\0diff: warning: Skipping remerge-diff for octopus merges.\n')).toThrow(
      /unterminated path list/,
    );
    expect(() => parseCommitShow('o', 'x\n\0\0\nsrc/analytics/a.ts\0trailing')).toThrow(/unterminated path list/);
  });

  it('collectCommits reads an octopus (3+ parents) against its first parent', () => {
    const calls: string[][] = [];
    const run = (args: string[]): string => {
      calls.push(args);
      if (args.includes('rev-list')) return 'octo p1 p2 p3\n';
      return 'octo\n\0\0\nsrc/analytics/a.ts\0';
    };
    expect(collectCommits('b', 'HEAD', run)[0]?.files).toEqual(['src/analytics/a.ts']);
    expect(calls[1]).toEqual([...OCTOPUS_SHOW_ARGS, 'octo']);
    expect(OCTOPUS_SHOW_ARGS).toContain('--diff-merges=first-parent');
    expect(OCTOPUS_SHOW_ARGS).not.toContain('--remerge-diff');
  });

  it('a commit that cannot be read inside a resolved range is a VIOLATION, not a skip', () => {
    // A ~5 KiB tree listing 256k paths overflows any output buffer; failing open there would let one
    // crafted commit switch the gate off for the whole range.
    const run = (args: string[]): string => {
      if (args.includes('rev-list')) return `${skipParent.sha} b0\nbig0 b0\n`;
      if (args[args.length - 1] === 'big0') throw new Error('spawnSync git ENOBUFS');
      return showOutput(skipParent);
    };
    const r = evaluate('origin/main', run);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('are unattested or unreadable');
    expect(r.message).toContain('cannot be cleared by any trailer');
    expect(r.message).toContain('big0 (could not be read)');
    expect(r.message).toContain('unreadable, so unverifiable: spawnSync git ENOBUFS');
    expect(r.message).not.toContain('4e2be44');
  });

  it('collectCommits reads every commit in the range, merges included, with its own git show', () => {
    const calls: string[][] = [];
    const run = (args: string[]): string => {
      calls.push(args);
      if (args.includes('rev-list')) return `${unattestedChild.sha} ${skipParent.sha}\n${skipParent.sha} b0\n`;
      const sha = args[args.length - 1];
      const c = [skipParent, unattestedChild].find((x) => x.sha === sha);
      if (!c) throw new Error(`unexpected sha ${sha}`);
      return showOutput(c);
    };
    const commits = collectCommits('origin/main', 'HEAD', run);
    expect(calls[0]).toEqual([...GIT_GLOBAL_ARGS, 'rev-list', '--parents', 'origin/main..HEAD']);
    expect(GIT_GLOBAL_ARGS).toContain('--no-replace-objects');
    expect(GIT_GLOBAL_ARGS).toContain('merge.renameLimit=0');
    expect(calls.slice(1)).toEqual([
      [...SHOW_ARGS, unattestedChild.sha],
      [...SHOW_ARGS, skipParent.sha],
    ]);
    expect(commits).toEqual([unattestedChild, skipParent]);
  });

  it('evaluate: violation names only the unattested commit; the remedy is in the message', () => {
    const run = (args: string[]): string =>
      args.includes('rev-list')
        ? `${unattestedChild.sha} ${skipParent.sha}\n${skipParent.sha} b0\n`
        : showOutput(args[args.length - 1] === skipParent.sha ? skipParent : unattestedChild);
    const r = evaluate('origin/main', run);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('1 of 2 commit(s)');
    expect(r.message).toContain('588fa81 fix(alerts)');
    expect(r.message).toContain('src/analytics/conditions.ts');
    expect(r.message).not.toContain('4e2be44');
    expect(r.message).toContain('git interpret-trailers --in-place');
    expect(r.message).toContain('git commit --fixup=reword:<sha>');
    expect(r.message).toContain('GIT_SEQUENCE_EDITOR=: git rebase -i --rebase-merges --autosquash origin/main');
  });

  it('evaluate fails OPEN on a git failure and on an empty base', () => {
    const boom = (): string => {
      throw new Error("fatal: bad revision 'nope..HEAD'");
    };
    expect(evaluate('nope', boom)).toMatchObject({ outcome: 'skip' });
    expect(evaluate('nope', boom).message).toContain('bad revision');
    // `--base=` would otherwise read the empty range `..HEAD` and report OK without looking at anything.
    const never = (): string => {
      throw new Error('must not be called');
    };
    expect(evaluate('', never)).toMatchObject({ outcome: 'skip' });
    expect(evaluate('  ', never)).toMatchObject({ outcome: 'skip' });
  });

  it('evaluate skips (fails open) on a shallow clone and on git < 2.40, before reading any commit', () => {
    const probe = (version: string, shallow: string) => (args: string[]): string => {
      if (args[0] === 'version') return version;
      if (args[0] === 'rev-parse') return shallow;
      throw new Error('commits must not be read');
    };
    expect(evaluate('origin/main', probe('git version 2.39.5\n', 'false\n'))).toMatchObject({ outcome: 'skip' });
    expect(evaluate('origin/main', probe('git version 2.39.5\n', 'false\n')).message).toContain('2.40');
    expect(evaluate('origin/main', probe('git version 2.55.0.windows.2\n', 'true\n')).message).toContain('shallow clone');
    expect(probeToolingGap(probe('git version 2.40.0\n', 'false\n'))).toBeUndefined();
    expect(GIT_GLOBAL_ARGS.some((a) => a.startsWith('--attr-source='))).toBe(true);
    expect(probeToolingGap(probe('git version 3.0.0\n', 'false\n'))).toBeUndefined();
  });

  it('evaluate: an unresolvable BASE skips; an unresolvable explicit --head, or a rev-list failure after the range resolved, is a violation', () => {
    const runner =
      (opts: { base?: boolean; head?: boolean; revList?: boolean }) =>
      (args: string[]): string => {
        if (args[0] === 'version') return 'git version 2.55.0\n';
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false\n';
        if (args[0] === 'rev-parse') {
          const ref = args[args.length - 1] ?? '';
          const ok = ref.startsWith('origin/main') ? opts.base !== false : opts.head !== false;
          if (!ok) throw new Error(`fatal: Needed a single revision (${ref})`);
          return 'f'.repeat(40) + '\n';
        }
        if (args.includes('rev-list')) {
          // e.g. 830k commits: `rev-list --parents` output overflows maxBuffer.
          if (opts.revList === false) throw new Error('spawnSync git ENOBUFS');
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      };
    expect(evaluate('origin/main', runner({ base: false }))).toMatchObject({ outcome: 'skip' });
    const badHead = evaluate('origin/main', runner({ head: false }), '588fa8l');
    expect(badHead.outcome).toBe('violation');
    expect(badHead.message).toContain('588fa8l');
    // The default HEAD not resolving (a repo with no commits) is a tooling gap, not a violation.
    expect(evaluate('origin/main', runner({ head: false }))).toMatchObject({ outcome: 'skip' });
    const overflow = evaluate('origin/main', runner({ revList: false }));
    expect(overflow.outcome).toBe('violation');
    expect(overflow.message).toContain('ENOBUFS');
    expect(evaluate('origin/main', runner({}))).toMatchObject({ outcome: 'ok' });
  });

  // A runner that answers every probe and range call, so an assertion cannot pass because some
  // unrelated call threw (the earlier empty-base test used a throw-on-everything runner, which
  // made probeToolingGap return "git unusable" -> skip even with the guard deleted).
  const healthy =
    (commits: CommitRecord[], fail: Record<string, string> = {}) =>
    (args: string[]): string => {
      if (args[0] === 'version') return 'git version 2.55.0\n';
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false\n';
      if (args[0] === 'rev-parse') return 'f'.repeat(40) + '\n';
      if (args[0] === 'merge-base') return 'e'.repeat(40) + '\n';
      if (args.includes('rev-list')) return commits.map((c) => `${c.sha} p0\n`).join('');
      const sha = args[args.length - 1] ?? '';
      if (fail[sha] !== undefined) throw new Error(fail[sha]);
      const c = commits.find((x) => x.sha === sha);
      if (!c) throw new Error(`unexpected ${args.join(' ')}`);
      return showOutput(c);
    };

  it('evaluate: an empty base skips on the guard itself, not on a probe failure', () => {
    const fin: CommitRecord = { sha: 'f1n', message: 'fin, no trailer\n', files: ['src/analytics/a.ts'] };
    for (const empty of ['', '  ']) {
      const r = evaluate(empty, healthy([fin]));
      expect(r.outcome).toBe('skip');
      expect(r.message).toContain('empty base ref');
    }
  });

  it('evaluate: an unreadable commit is a violation even when nothing else in the range is financial', () => {
    const docs: CommitRecord = { sha: 'd0c5', message: 'docs\n', files: ['README.md'] };
    const big: CommitRecord = { sha: 'b1g0', message: '', files: [] };
    const r = evaluate('origin/main', healthy([docs, big], { b1g0: 'spawnSync git ENOBUFS' }));
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('b1g0 (could not be read)');
    // Control: the same docs-only range without the unreadable commit is OK.
    expect(evaluate('origin/main', healthy([docs]))).toMatchObject({ outcome: 'ok' });
  });

  it('evaluate: OK when nothing financial changed', () => {
    const docs: CommitRecord = { sha: 'd0c5', message: 'docs\n', files: ['README.md'] };
    const run = (args: string[]): string => (args.includes('rev-list') ? 'd0c5 b0\n' : showOutput(docs));
    expect(evaluate('origin/main', run)).toMatchObject({ outcome: 'ok' });
  });
});

// Real git, real SHOW_ARGS: the stub tests above only prove the parser agrees with itself. Every
// scenario is built with plumbing (hash-object / update-index / commit-tree / merge-tree) into a
// throwaway repo under os.tmpdir(), so paths NTFS cannot hold as files ('"', tab) still get
// committed, and nothing touches this checkout. Isolated from the user's git config.
describe('check-refute-required — integration against real git', () => {
  let root = ''; // the mkdtemp result — the ONLY path afterAll may delete
  let dir = '';
  let env: NodeJS.ProcessEnv = {};
  const g = (args: string[], input?: string): string =>
    execFileSync('git', ['-c', 'core.protectNTFS=false', ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      input,
      maxBuffer: 16 * 1024 * 1024,
    });
  const run: GitRunner = (args) => g(args);
  const lines = (n: number, edit?: [number, string]): string =>
    Array.from({ length: n }, (_, i) => (edit && edit[0] === i ? edit[1] : `line ${i}`)).join('\n') + '\n';

  type Entry = string | { gitlink: string } | null;
  /** Commit `files` on top of parents[0] (or `fromTree`); null removes a path. Returns the sha. */
  const mk = (parents: string[], files: Record<string, Entry>, msg: string, fromTree?: string): string => {
    const tree = fromTree ?? (parents[0] ? `${parents[0]}^{tree}` : undefined);
    if (tree) g(['read-tree', tree]);
    else g(['read-tree', '--empty']);
    for (const [path, entry] of Object.entries(files)) {
      if (entry === null) g(['update-index', '--force-remove', '--', path]);
      else if (typeof entry === 'string') {
        const blob = g(['hash-object', '-w', '--stdin'], entry).trim();
        g(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
      } else g(['update-index', '--add', '--cacheinfo', `160000,${entry.gitlink},${path}`]);
    }
    const written = g(['write-tree']).trim();
    return g(['commit-tree', written, ...parents.flatMap((p) => ['-p', p]), '-m', msg]).trim();
  };

  let b0 = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'refute-gate-it-'));
    dir = root;
    const emptyCfg = join(root, '.empty-gitconfig');
    writeFileSync(emptyCfg, '');
    // Strip every inherited GIT_* variable: under `git rebase --exec` or a pre-commit hook in a linked
    // worktree, GIT_DIR / GIT_INDEX_FILE point at the REAL repo, and every g() call would rewrite
    // that repo's index with these fixtures.
    env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: emptyCfg,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    g(['init', '-q', 'repo']);
    dir = join(root, 'repo');
    b0 = mk([], { 'src/analytics/a.ts': lines(12), 'README.md': 'r\n' }, 'root');
  });
  afterAll(() => {
    // afterAll runs even when beforeAll throws. Delete only a non-empty mkdtemp result under
    // tmpdir(), never a path derived from `dir`: '' + '..' would be the parent of the cwd.
    if (!root || !resolve(root).startsWith(resolve(tmpdir())) || !basename(root).startsWith('refute-gate-it-')) return;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows AV can hold a handle in tmpdir; a leftover temp dir is harmless.
    }
  });

  it('skip-trailer parent + unattested financial child → violation on the child only', () => {
    const parent = mk([b0], { 'server/x.ts': 'x\n' }, 'plumb\n\nRefute-Skip: error transport only');
    const child = mk([parent], { 'src/analytics/a.ts': lines(12, [3, 'dedup']) }, 'fix(alerts): dedup');
    const r = evaluate(b0, run, child);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${child.slice(0, 7)} fix(alerts): dedup`);
    expect(r.message).not.toContain(parent.slice(0, 7));
    // The same range with the child attested passes.
    const fixed = mk([parent], { 'src/analytics/a.ts': lines(12, [3, 'dedup']) }, 'fix: dedup\n\nRefute-Reviewed: wf_1');
    expect(evaluate(b0, run, fixed).outcome).toBe('ok');
  }, 60_000);

  it('a clean merge (CI synthetic merge, or catch-up of main) needs no trailer', () => {
    const mainSide = mk([b0], { 'src/analytics/a.ts': lines(12, [0, 'main']) }, 'main\n\nRefute-Reviewed: wf_m');
    const prSide = mk([b0], { 'src/analytics/a.ts': lines(12, [11, 'pr']) }, 'pr\n\nRefute-Reviewed: wf_p');
    const tree = g(['merge-tree', '--write-tree', mainSide, prSide]).trim().split('\n')[0] ?? '';
    const synthetic = mk([mainSide, prSide], {}, `Merge ${prSide} into ${mainSide}`, tree);
    expect(evaluate(mainSide, run, synthetic)).toMatchObject({ outcome: 'ok' });
  }, 60_000);

  it('an evil merge that hand-edits financial source needs its own trailer (--no-merges skipped it)', () => {
    const mainSide = mk([b0], { 'README.md': 'main\n' }, 'main docs');
    const prSide = mk([b0], { 'docs/x.md': 'x\n' }, 'pr docs');
    const tree = g(['merge-tree', '--write-tree', mainSide, prSide]).trim().split('\n')[0] ?? '';
    const evil = mk([mainSide, prSide], { 'src/analytics/a.ts': lines(12, [5, 'evil']) }, 'Merge branch pr', tree);
    const r = evaluate(mainSide, run, evil);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${evil.slice(0, 7)} Merge branch pr`);
    expect(r.message).toContain('src/analytics/a.ts');
  }, 60_000);

  it('moving a file OUT of a financial path still names the financial path', () => {
    const moved = mk([b0], { 'src/analytics/a.ts': null, 'docs/a.ts': lines(12) }, 'chore: move');
    expect(evaluate(b0, run, moved).message).toContain('src/analytics/a.ts');
  }, 60_000);

  it('paths git would C-quote still match the financial prefixes', () => {
    const q = mk([b0], { 'src/analytics/risk"calc.ts': 'x\n', 'src/analytics/tab\there.ts': 'y\n' }, 'feat: q');
    const r = evaluate(b0, run, q);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('src/analytics/risk"calc.ts');
    expect(r.message).toContain('src/analytics/tab\there.ts');
  }, 60_000);

  it('an octopus merge that hand-edits financial source is caught (git skips remerge-diff for it)', () => {
    const a = mk([b0], { 'docs/a.md': 'a\n' }, 'a');
    const b = mk([b0], { 'docs/b.md': 'b\n' }, 'b');
    const c = mk([b0], { 'docs/c.md': 'c\n' }, 'c');
    const clean = mk([a], { 'docs/b.md': 'b\n', 'docs/c.md': 'c\n' }, 'unused');
    const octo = mk([a, b, c], { 'docs/b.md': 'b\n', 'docs/c.md': 'c\n', 'src/analytics/a.ts': lines(12, [7, 'octo']) }, 'Merge b, c', `${clean}^{tree}`);
    const r = evaluate(a, run, octo);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${octo.slice(0, 7)} Merge b, c`);
    expect(r.message).toContain('src/analytics/a.ts');
  }, 60_000);

  it('a shallow clone skips instead of silently checking only the boundary commit', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [2, 'fin']) }, 'fin, no trailer');
    const tip = mk([fin], { 'README.md': 'tip\n' }, 'docs tip\n\nRefute-Skip: docs only');
    g(['update-ref', 'refs/heads/shallow-src', tip]);
    const clone = join(root, 'shallow');
    g(['clone', '-q', '--depth', '1', '--branch', 'shallow-src', `file://${dir.replace(/\\/g, '/')}`, clone]);
    const inClone: GitRunner = (args) =>
      execFileSync('git', args, { cwd: clone, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const r = evaluate('HEAD~1', inClone);
    expect(r.outcome).toBe('skip');
    expect(r.message).toContain('shallow clone');
    // The full repo, same range: the unattested commit is found.
    expect(evaluate(b0, run, tip).message).toContain(`${fin.slice(0, 7)} fin, no trailer`);
  }, 60_000);

  it('the printed reword recipe rebases onto the merge-base sha, not a base ref that may have moved', () => {
    const movedMain = mk([b0], { 'README.md': 'moved\n' }, 'main moved on');
    const child = mk([b0], { 'src/analytics/a.ts': lines(12, [9, 'x']) }, 'fin, no trailer');
    const r = evaluate(movedMain, run, child);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`git rebase -i --rebase-merges --autosquash ${b0}`);
    expect(r.message).not.toContain(`--autosquash ${movedMain}`);
  }, 60_000);

  it('a committed .gitattributes merge=union cannot make a conflict in financial source look clean', () => {
    // The attack: attributes in the checked-out tree (the PR controls it in CI) make git's own
    // re-merge resolve a real conflict, so --remerge-diff would list nothing.
    const aSide = mk([b0], { 'src/analytics/a.ts': lines(12, [4, 'LTV_MAX = 0.41']) }, 'a\n\nRefute-Reviewed: wf_a');
    const bSide = mk([b0], { 'src/analytics/a.ts': lines(12, [4, 'LTV_AGG = 0.40']), '.gitattributes': 'src/** merge=union\n' }, 'b\n\nRefute-Reviewed: wf_b');
    const attrs = join(dir, '.gitattributes');
    writeFileSync(attrs, 'src/** merge=union\n');
    try {
      // Parent order must match the merge-tree order, or the union's line order differs and the
      // re-merge lists the path for the wrong reason.
      const unionTree = g(['merge-tree', '--write-tree', bSide, aSide]).trim().split('\n')[0] ?? '';
      const merge = mk([bSide, aSide], {}, 'Merge a into b', unionTree);
      const r = evaluate(bSide, run, merge);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain(`${merge.slice(0, 7)} Merge a into b`);
      expect(r.message).toContain('src/analytics/a.ts');
    } finally {
      rmSync(attrs, { force: true });
    }
  }, 60_000);

  it('a root commit in the range is read even under log.showRoot=false (--root)', () => {
    g(['config', 'log.showRoot', 'false']);
    try {
      const orphan = mk([], { 'src/analytics/z.ts': 'z\n' }, 'orphan root, no trailer');
      const r = evaluate(b0, run, orphan);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain('src/analytics/z.ts');
    } finally {
      g(['config', '--unset', 'log.showRoot']);
    }
  }, 60_000);

  it('clean rename catch-up merges stay clean under a local merge.renames=false / directoryRenames=false', () => {
    // main renames a.ts -> b.ts; the branch edits a.ts. The recorded merge (built with git's
    // defaults, as GitHub and a default-config author would) carries the edit into b.ts.
    const mainR = mk([b0], { 'src/analytics/a.ts': null, 'src/analytics/b.ts': lines(12) }, 'main: rename\n\nRefute-Reviewed: wf_m');
    const edit = mk([b0], { 'src/analytics/a.ts': lines(12, [1, 'edited']) }, 'edit\n\nRefute-Reviewed: wf_e');
    const t1 = g(['merge-tree', '--write-tree', edit, mainR]).trim().split('\n')[0] ?? '';
    const catchup = mk([edit, mainR], {}, 'Merge main into branch', t1);
    // main moves a directory; the branch adds a file inside it.
    const base2 = mk([b0], { 'src/analytics/d/x.ts': lines(8) }, 'dir\n\nRefute-Reviewed: wf_d');
    const mainD = mk([base2], { 'src/analytics/d/x.ts': null, 'src/analytics/e/x.ts': lines(8) }, 'main: move dir\n\nRefute-Reviewed: wf_md');
    const addY = mk([base2], { 'src/analytics/d/y.ts': 'y\n' }, 'add y\n\nRefute-Reviewed: wf_y');
    // Git's default merge.directoryRenames=conflict reports a file-location conflict here (exit 1)
    // but still writes the moved result tree on stdout's first line.
    let t2 = '';
    try {
      t2 = g(['merge-tree', '--write-tree', addY, mainD]);
    } catch (err) {
      t2 = String((err as { stdout?: string }).stdout ?? '');
    }
    t2 = t2.trim().split('\n')[0] ?? '';
    expect(g(['ls-tree', '-r', '--name-only', t2])).toContain('src/analytics/e/y.ts');
    const catchupD = mk([addY, mainD], {}, 'Merge main (dir move) into branch', t2);
    // Default config: both merges are clean.
    expect(evaluate(mainR, run, catchup)).toMatchObject({ outcome: 'ok' });
    expect(evaluate(mainD, run, catchupD)).toMatchObject({ outcome: 'ok' });
    // A local config that would re-merge differently must not change the answer (pinned via -c).
    g(['config', 'merge.renames', 'false']);
    g(['config', 'merge.directoryRenames', 'false']);
    try {
      expect(evaluate(mainR, run, catchup)).toMatchObject({ outcome: 'ok' });
      expect(evaluate(mainD, run, catchupD)).toMatchObject({ outcome: 'ok' });
    } finally {
      g(['config', '--unset', 'merge.renames']);
      g(['config', '--unset', 'merge.directoryRenames']);
    }
  }, 60_000);

  it('a gitlink bump is visible even when .gitmodules says ignore = all', () => {
    const gitmodules = '[submodule "lib"]\n\tpath = src/analytics/lib\n\turl = ./lib\n\tignore = all\n';
    const g1 = mk([b0], { '.gitmodules': gitmodules, 'src/analytics/lib': { gitlink: b0 } }, 'add lib\n\nRefute-Skip: vendoring');
    const other = mk([b0], { 'README.md': 'o\n' }, 'other');
    const g2 = mk([g1], { 'src/analytics/lib': { gitlink: other } }, 'bump lib');
    const r = evaluate(g1, run, g2);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('src/analytics/lib');
  }, 60_000);
});
