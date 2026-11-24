// server/workbook/parse.ts
//
// Master Workbook parser entry point: parseWorkbook() and the holding exclusions. Each sheet's
// parser lives in server/workbook/sheets/ (split 2026-11-24, no behaviour change); every name
// this module exported before is still exported from here, so importers are unchanged.
import ExcelJS from 'exceljs';
import { PortfolioSnapshot, SCHEMA_VERSION, slug, type Property, type Lease, type Loan, type InsurancePolicy, type DataQualityFlag } from '../../src/contracts/index';
import { LANDLORD_COSTS_NOT_SOURCED_FIELD } from '../../src/analytics/property-basis';
import { loadDeals, dealsDegradationFlag, type DealsDegradation } from '../sources/notion-deals';
import { loadM365Tasks, m365TasksDegradationFlag, type M365TasksDegradation } from '../sources/m365-tasks';
import { deriveCounterparties } from './counterparties';
import { crossCheckDebtService } from './debt-service-crosscheck';
import { assertRelationshipTargetsResolvable, describeOpenpyxlReadFailure, assertCachedValuesPresent } from './openpyxl-integrity';
import { WORKBOOK_AS_OF, referenceDate } from '../config';
import { parseAssumptions } from './sheets/assumptions';
import { parseCash } from './sheets/cash';
import { sheetDataAsOf } from './sheets/cells';
import { attachPremiumHistoryTiv, parseInsurance, parseInsurancePremiumHistory } from './sheets/insurance';
import { parseLeases } from './sheets/leases';
import { parseLoans } from './sheets/loans';
import { type PropertiesParseResult, parseProperties } from './sheets/properties';
import { normalizedAddress, resolvePropertyId } from './sheets/resolve-property';
import { parseTasks } from './sheets/tasks';
type Worksheet = ExcelJS.Worksheet;
export { datelineToIso, decPairOrFlag, inferMarket, inferType, isoOrNull } from './sheets/cells';
export { disambiguateLeaseIds, disambiguatePropertyIds } from './sheets/ids';
export { findRentRollColumns, rentTotalColumns } from './sheets/leases';
export { isTombstonedLoanRow } from './sheets/loans';
export type { PremiumHistoryTivRow } from './sheets/insurance';
export { isTaskBannerRow, statusFromSymbol } from './sheets/tasks';
export { attachPremiumHistoryTiv, parseInsurancePremiumHistory, resolvePropertyId, sheetDataAsOf };

// ── orchestrator ──────────────────────────────────────────────────────────────
export interface ParseResult {
  snapshot: PortfolioSnapshot;
  flags: DataQualityFlag[];
  /**
   * How the deals source degraded on this parse, or null when it was fully live.
   *
   * Reported SEPARATELY from `flags` on purpose. `dealsDegradationFlag` maps only the data-losing
   * reasons to an error-severity flag and deliberately returns null for `not-configured`, so a
   * developer without a NOTION_TOKEN isn't permanently "dirty" — but a WRITER still must not put
   * the ~6-deal seed placeholder set into the shared, git-tracked mirror. Threading the raw
   * degradation lets each writer apply its own policy without changing what the flag stream says.
   * (2026-08-11 integrity sweep, H1: Brain.persist gated only on the flag, so a token-less live
   * server rewrote portfolio.json with seed placeholders on every refresh.)
   */
  dealsDegraded: DealsDegradation | null;
  /**
   * How the M365 To-Do source degraded on this parse, or null when it was fully live (which
   * INCLUDES a healthy fetch that legitimately returned no open tasks).
   *
   * Threaded separately from `flags` for the same reason as `dealsDegraded` above:
   * `m365TasksDegradationFlag` returns null for `not-configured` so a Graph-less dev box isn't
   * permanently dirty, but a WRITER of the shared, git-tracked mirror still must not publish a
   * tasks section with every live M365 row missing. Added 2026-09-05 after a refresh silently
   * shipped `tasks` 115 -> 59 at Exit 0.
   */
  m365Degraded: M365TasksDegradation | null;
  /** Rows removed by excludeNonInvestmentHoldings (the residence), aggregate only. Not on the
   *  snapshot: only the independent workbook re-read in scripts/reconcile.ts needs it. */
  excludedHoldings: ExcludedHoldings;
}

/**
 * @param referenceDateIso Optional day-count reference (YYYY-MM-DD) for lease monthsToExpiry.
 *   The brief pipeline passes its ET send date so day-counts track the firm's timezone
 *   consistently; other callers (live server, reconcile, extract) default to referenceDate()
 *   (the UTC run date). Never governs data-month selection (monthCol) or data-snapshot labels.
 */
export async function parseWorkbook(path: string, referenceDateIso?: string): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  // An openpyxl re-save corrupts this workbook three ways: unresolvable relationship
  // targets (an opaque exceljs crash), stripped cached formula values (silent nulls for
  // every computed figure), and formulas replaced by static values (figures frozen
  // forever). Name each precisely instead of crashing or, worse, parsing a workbook whose
  // financials are null or stale. See ./openpyxl-integrity.ts.
  assertRelationshipTargetsResolvable(path);
  try {
    await wb.xlsx.readFile(path);
  } catch (err) {
    const diagnosis = describeOpenpyxlReadFailure(err, path);
    if (diagnosis) throw new Error(diagnosis, { cause: err });
    throw err;
  }
  assertCachedValuesPresent(wb, path);
  const flags: DataQualityFlag[] = [];
  const refIso = referenceDateIso ?? referenceDate();

  const get = (name: string): Worksheet => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`Worksheet not found: "${name}"`);
    return ws;
  };

  // Provenance "As of" (OI-023): the workbook's own rent-roll dateline is the data date the
  // snapshot advertises (TopBar / module badges / portfolio.json). The June-pinned
  // WORKBOOK_AS_OF constant is only the LOUD fallback — a missing dateline surfaces as a
  // DataQualityFlag, never a silent stale label. monthCol (parseTasks) deliberately stays on
  // WORKBOOK_AS_OF — see the comment above parseLeases.
  const rentRollWs = get('Master Tenant Rent Roll');
  const workbookDataAsOf = sheetDataAsOf(rentRollWs);
  if (!workbookDataAsOf) {
    flags.push({
      entity: 'meta',
      field: 'asOf',
      issue: `no parseable "As of" dateline on the Master Tenant Rent Roll sheet — provenance falls back to WORKBOOK_AS_OF (${WORKBOOK_AS_OF})`,
      severity: 'warn',
    });
  }
  const dataAsOf = workbookDataAsOf ?? WORKBOOK_AS_OF;

  const parsedProperties = parseProperties(get('Property NOI'), flags);
  // Leases resolve against EVERY workbook row so a rent-roll line keyed to an excluded holding is
  // dropped by id below, not mis-flagged as an unresolved property.
  const parsedLeases = parseLeases(rentRollWs, parsedProperties.properties, flags, refIso);
  const { properties, leases, excludedHoldings, excludedIds, workbookNoiTotal, workbookValueTotal, workbookRentTotal } =
    excludeNonInvestmentHoldings(parsedProperties, parsedLeases.leases, parsedLeases.workbookRentTotal, flags);
  const loans = parseLoans(get('Loan Index'), flags);
  // OI-092: parseLoans reads only `Loan Index`, so a wrong next-12-month debt-service window in
  // `External Loans Summary` reaches monthlyPmt (and therefore DSCR) with nothing in its path
  // able to see it. This cross-checks that figure against the amortization schedules themselves.
  // warn-severity by ruling — it reports on workbook formulas this pipeline does not own, and a
  // warn-severity advisory check must never be able to take down the whole refresh. Isolated in
  // its own try/catch for exactly that reason — everything else in parseWorkbook still runs even
  // if a future workbook edit produces a shape this check cannot handle.
  try {
    flags.push(...crossCheckDebtService(wb));
  } catch (err) {
    flags.push({
      entity: 'meta',
      field: 'annualDebtService',
      issue: `debt-service cross-check threw and did not complete: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'warn',
    });
  }
  const cash = parseCash(get('Cash Balances'), flags, dataAsOf);
  const premiumHistoryWs = wb.getWorksheet('Insurance Premium History');
  const insurance = attachPremiumHistoryTiv(
    parseInsurance(get('Insurance Renewals'), flags),
    premiumHistoryWs ? parseInsurancePremiumHistory(premiumHistoryWs) : null,
    flags,
  );
  flags.push(...flagExcludedReferences(loans, insurance, parsedProperties.properties, excludedIds));
  const checklistTasks = parseTasks(get('Monthly Checklist'));
  // live M365 To-Do prepended when Graph is configured, else the workbook checklist alone. A
  // data-losing degradation (token-failed / fetch-failed / empty-result) raises an ERROR-severity
  // flag so evaluateReconciliationGate refuses the write rather than publishing a tasks section
  // with every live M365 row silently dropped -- see loadM365Tasks' doc comment for the 2026-09-05
  // `tasks` 115 -> 59 incident this closes. Same shape as the deals gate directly below.
  const { tasks: m365Tasks, degraded: m365Degraded } = await loadM365Tasks();
  const m365Flag = m365TasksDegradationFlag(m365Degraded);
  if (m365Flag) flags.push(m365Flag);
  const tasks = m365Tasks.length ? [...m365Tasks, ...checklistTasks] : checklistTasks;
  const assumptions = parseAssumptions(get('Assumptions'), flags, dataAsOf);
  // live Notion pipeline merged onto seed when configured, else seed. A data-losing degradation
  // (fetch-failed / empty-result) raises an ERROR-severity flag so evaluateReconciliationGate
  // refuses the write rather than publishing seed placeholders over the live pipeline -- see
  // loadDeals' doc comment for the 2026-08-09 regression this closes.
  const { deals, degraded: dealsDegraded, flags: dealsMergeFlags } = await loadDeals();
  const dealsFlag = dealsDegradationFlag(dealsDegraded, deals.length);
  if (dealsFlag) flags.push(dealsFlag);
  // Merge-time join-key flags (collisions, refused locality-strip merges). Error-severity, so
  // evaluateReconciliationGate refuses the write until the names are disambiguated -- the joiner used
  // to log these and rely on a detector keyed differently that could miss them entirely.
  // (Catch-up sweep 2026-07-28..08-04, C1 + H1.)
  for (const f of dealsMergeFlags) flags.push(f);
  const counterparties = deriveCounterparties({ properties, loans, insurance, deals });

  // Standing basis disclosures go LAST so they never sit ahead of an actionable warn/error in a
  // capped list (refute wf_b6010683-4be).
  flags.push(...flagLandlordCostsNotSourced(properties));
  const snapshot = PortfolioSnapshot.parse({
    meta: {
      schemaVersion: SCHEMA_VERSION,
      asOf: dataAsOf,
      generatedAt: new Date().toISOString(),
      source: 'Master Excel Template Company Wide -- Oxford.xlsx',
      scenario: assumptions.activeScenario,
    },
    assumptions,
    properties,
    leases,
    loans,
    cash,
    insurance,
    deals,
    tasks,
    counterparties,
    workbookTotals: { noi: workbookNoiTotal, value: workbookValueTotal, rent: workbookRentTotal },
    dataQuality: flags,
  });

  return { snapshot, flags, dealsDegraded, m365Degraded, excludedHoldings };
}

/** Workbook rows dropped from the snapshot, as a non-identifying aggregate (no name or address) so
 *  the independent workbook re-read in scripts/reconcile.ts can still tie its Portfolio Totals. */
export interface ExcludedHoldings {
  count: number;
  noi: number;
  oxfordValue: number;
  /** Σ annualRent of the rent-roll lines dropped with them (the rent roll's Portfolio Total includes them). */
  annualRent: number;
}

/**
 * Ratified 2026-10-30 (Gabriel): the residence (9510 Persimmon Tree, `type === 'Residence'`) must
 * not appear anywhere in the command center. This supersedes the 2026-09-23 ruling that reported it
 * beside investment KPIs as "other holdings": it is removed at the one boundary every surface reads
 * through, so no table, KPI, chart, alert, AI answer, brief or public mirror can show it.
 *
 * Removal is EXACT, never fuzzy (refute wf_305adf92-ca4: a label matcher dropped non-residence rows
 * and netted them out of the tie-out, invisibly). Removed: the property row, rent-roll lines whose
 * propertyId resolved to it, and flags on those entities. Anything that cannot be attributed
 * exactly fails LOUD instead, with an error flag that blocks the persist and does not name the row:
 *  - an excluded row whose slug or normalized address equals an investment row's (lease
 *    attribution between them would depend on sheet order);
 *  - a loan collateral or insurance property label that resolves to an excluded row (the fix is to
 *    take it off the workbook sheet, not for the parser to guess).
 *
 * The workbook's Portfolio Total rows include the residence, so the three totals carried on the
 * snapshot (NOI, value, rent) are restated net of exactly what was removed. reconcile-runtime ties
 * them at $1; scripts/reconcile.ts subtracts `excludedHoldings` from its independent re-read.
 */
export function excludeNonInvestmentHoldings(
  parsed: PropertiesParseResult,
  leases: Lease[],
  workbookRentTotal: number | null,
  flags: DataQualityFlag[],
): {
  properties: Property[];
  leases: Lease[];
  excludedHoldings: ExcludedHoldings;
  excludedIds: ReadonlySet<string>;
  workbookNoiTotal: number | null;
  workbookValueTotal: number | null;
  workbookRentTotal: number | null;
} {
  const excluded = parsed.properties.filter((p) => p.type === 'Residence');
  const excludedIds = new Set(excluded.map((p) => p.id));
  const investment = parsed.properties.filter((p) => !excludedIds.has(p.id));
  // Same equivalences the id builder and lease resolver use (slug strips punctuation; the resolver's
  // tie-break compares normalizedAddress), so a punctuation-only difference is still a collision.
  const keysOf = (p: Property) => [slug(p.name), normalizedAddress(p.name)];
  const investmentKeys = new Set(investment.flatMap(keysOf));
  if (excluded.some((p) => keysOf(p).some((k) => investmentKeys.has(k)))) {
    flags.push({
      entity: 'reconciliation',
      field: 'properties.excludedHoldings',
      issue: 'a non-investment (residence) row has the same name or address as an investment row on Property NOI; rename one so the exclusion cannot depend on row order',
      severity: 'error',
    });
  }
  const isExcludedLease = (l: Lease) => l.propertyId !== null && excludedIds.has(l.propertyId);
  const droppedLeases = leases.filter(isExcludedLease);
  // Lease attribution is a token-overlap resolver, not an exact match, so a removal is never
  // silent: the line stays out of the snapshot (it may be the residence) and the persist and the
  // mirror bake are blocked until the rent roll is relabelled (refute wf_5ebf32b2-e5d).
  if (droppedLeases.length > 0) {
    flags.push({
      entity: 'reconciliation',
      field: 'leases.excludedHoldings',
      issue: `${droppedLeases.length} rent-roll line(s) resolve to a non-investment (residence) holding; remove them from the rent roll, or relabel any that belong to an investment property`,
      severity: 'error',
    });
  }
  // Lease-level flags carry the LEASE id as their entity, so those are dropped as well.
  dropFlagsFor(flags, new Set([...excludedIds, ...droppedLeases.map((l) => l.id)]));
  const sumOf = (pick: (p: Property) => number) => excluded.reduce((a, p) => a + pick(p), 0);
  const excludedHoldings: ExcludedHoldings = {
    count: excluded.length,
    noi: sumOf((p) => p.noi),
    oxfordValue: sumOf((p) => p.oxfordValue),
    annualRent: droppedLeases.reduce((a, l) => a + l.annualRent, 0),
  };
  const net = (total: number | null, less: number) => (total === null ? null : total - less);
  return {
    properties: investment,
    leases: leases.filter((l) => !isExcludedLease(l)),
    excludedHoldings,
    excludedIds,
    workbookNoiTotal: net(parsed.workbookNoiTotal, excludedHoldings.noi),
    workbookValueTotal: net(parsed.workbookValueTotal, excludedHoldings.oxfordValue),
    workbookRentTotal: net(workbookRentTotal, excludedHoldings.annualRent),
  };
}

/**
 * Loans and insurance rows are never dropped by the exclusion. If one RESOLVES (same resolver as
 * leases, over every workbook row) to an excluded holding, raise one error flag, without naming
 * it, so the persist is blocked until the workbook row is removed. Live data has none.
 */
export function flagExcludedReferences(
  loans: readonly Loan[],
  insurance: readonly InsurancePolicy[],
  allProperties: Property[],
  excludedIds: ReadonlySet<string>,
): DataQualityFlag[] {
  if (excludedIds.size === 0) return [];
  const hits = (label: string | null) => {
    const id = label ? resolvePropertyId(label, allProperties) : null;
    return id !== null && excludedIds.has(id);
  };
  const n = loans.filter((l) => hits(l.collateralProperty)).length + insurance.filter((i) => hits(i.property)).length;
  return n === 0
    ? []
    : [{
        entity: 'reconciliation',
        field: 'properties.excludedHoldings',
        issue: `${n} Loan Index / Insurance Renewals row(s) reference a non-investment (residence) holding; remove them from the workbook so they cannot surface it`,
        severity: 'error',
      }];
}

function dropFlagsFor(flags: DataQualityFlag[], entities: ReadonlySet<string>): void {
  for (let i = flags.length - 1; i >= 0; i--) {
    if (entities.has(flags[i]!.entity)) flags.splice(i, 1);
  }
}

/**
 * Ratified 2026-10-30 (Gabriel): the income properties whose Property NOI row carries $0 expenses
 * are NNN, NOT absolute NNN — the landlord still pays roof, structure and paving. Their workbook
 * NOI is therefore overstated by those costs. Until PCA capex schedules supply them (Wave C), each
 * such row is flagged (no $/SF reserve is assumed — ruling: PCA-driven, else "not sourced").
 *
 * The flag goes on the property AND the snapshot data-quality list, so it renders on the Portfolio
 * table and the Health surface. Values are not changed: this labels a known understatement, it
 * does not estimate it.
 */
export function flagLandlordCostsNotSourced(properties: Property[]): DataQualityFlag[] {
  const out: DataQualityFlag[] = [];
  for (const p of properties) {
    if (p.expenses !== 0 || p.grossIncome <= 0) continue;
    const flag: DataQualityFlag = {
      entity: p.id,
      field: LANDLORD_COSTS_NOT_SOURCED_FIELD,
      issue: 'NNN, not absolute: landlord-paid roof, structure and paving costs are not sourced (expenses are $0 or blank), so NOI is overstated by them until a PCA schedule supplies them',
      // info, not warn: a standing basis disclosure, not a workbook defect to fix; warn would hold
      // the Health signal on "Warnings" indefinitely (refute wf_4b941bed-52e, signal discipline).
      severity: 'info',
    };
    p.flags.push(flag);
    out.push(flag);
  }
  return out;
}
