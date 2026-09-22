import { describe, it, expect } from 'vitest';
import {
  isFinancialSourcePath,
  hasRefuteApproval,
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
      'scripts/lib/deploy-alert.ps1',
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
    expect(NON_FINANCIAL_ROOT_PATHS.size).toBe(29);
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
  it('detects Refute-Reviewed / Refute-Skip anywhere in the blob (case-insensitive)', () => {
    expect(hasRefuteApproval('fix: x\n\nRefute-Reviewed: wf_abc123')).toBe(true);
    expect(hasRefuteApproval('chore\n\nRefute-Skip: docs-only adjustment')).toBe(true);
    expect(hasRefuteApproval('refute-reviewed: wf_x')).toBe(true);
  });
  it('returns false when no attestation trailer is present', () => {
    expect(hasRefuteApproval('fix: something\n\nCo-Authored-By: someone')).toBe(false);
    expect(hasRefuteApproval('')).toBe(false);
  });
});
