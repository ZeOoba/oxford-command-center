import type { PortfolioSnapshot, DataQualityFlag } from '../src/contracts/index';

/**
 * In-process reconciliation (Phase 6, §10). Runs on every brain.refresh() and verifies the
 * snapshot's internal invariants — no second workbook read. Any breach becomes a DataQualityFlag
 * on the snapshot so the UI can show a degraded state and downgrade provenance, rather than
 * silently serving inconsistent numbers. The workbook-total-cell cross-checks (NOI/value/rent) ARE
 * covered here too, at zero extra I/O cost: parse.ts captures those cells into
 * snapshot.workbookTotals during its single read, so this only compares numbers already on the
 * snapshot. scripts/reconcile.ts (the CI gate) still does its own fully independent second read of
 * the raw workbook as a from-scratch cross-check — deliberate defense in depth, not redundant dead
 * code; the two are allowed to diverge in *how* they source the workbook total without either one
 * being wrong.
 */
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export function checkSnapshot(s: PortfolioSnapshot): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];
  const flag = (field: string, issue: string, severity: DataQualityFlag['severity'] = 'error') =>
    flags.push({ entity: 'reconciliation', field, issue, severity });

  // Cash total must equal the sum of entity balances.
  const cashSum = sum(s.cash.entities.map((e) => e.currentBalance));
  if (Math.abs(cashSum - s.cash.totalCash) > 2) {
    flag('cash.totalCash', `total ${Math.round(s.cash.totalCash)} ≠ Σ entities ${Math.round(cashSum)}`);
  }

  // Annualized rent must equal Σ(monthly × 12).
  const annual = sum(s.leases.map((l) => l.annualRent));
  const monthlyX12 = sum(s.leases.map((l) => l.monthlyRent * 12));
  if (Math.abs(annual - monthlyX12) > 5) {
    flag('leases.annualRent', `Σ annual ${Math.round(annual)} ≠ Σ(monthly×12) ${Math.round(monthlyX12)}`, 'warn');
  }

  // Cash history's own latest snapshot must agree with the current total (a stale/misordered
  // history array would otherwise show a chart that silently disagrees with the headline number).
  const cashHistoryLatest = s.cash.history?.at(-1)?.total;
  if (cashHistoryLatest !== undefined && Math.abs(cashHistoryLatest - s.cash.totalCash) > 2) {
    flag(
      'cash.history',
      `latest history point ${Math.round(cashHistoryLatest)} ≠ current total ${Math.round(s.cash.totalCash)}`,
    );
  }

  // Derived totals must agree with the workbook's own declared "Portfolio Total" row (per-field:
  // null means the workbook had no such row, e.g. a legacy fixture -- skip rather than false-flag).
  const wt = s.workbookTotals;
  if (wt?.noi != null) {
    const noiSum = sum(s.properties.map((p) => p.noi));
    if (Math.abs(wt.noi - noiSum) > 1) {
      flag('properties.noi', `Σ property NOI ${Math.round(noiSum)} ≠ workbook total ${Math.round(wt.noi)}`);
    }
  }
  if (wt?.value != null) {
    const valueSum = sum(s.properties.map((p) => p.oxfordValue));
    if (Math.abs(wt.value - valueSum) > 1) {
      flag('properties.oxfordValue', `Σ Oxford value ${Math.round(valueSum)} ≠ workbook total ${Math.round(wt.value)}`);
    }
  }
  if (wt?.rent != null) {
    if (Math.abs(wt.rent - annual) > 1) {
      flag('leases.annualRent', `Σ annual rent ${Math.round(annual)} ≠ workbook total ${Math.round(wt.rent)}`);
    }
  }

  // Core entity sets must be non-empty (a parse that silently emptied a sheet).
  if (s.properties.length === 0) flag('properties', 'no properties parsed');
  if (s.leases.length === 0) flag('leases', 'no leases parsed');

  // Property.id is the join key for capital-allocation, debt-scoring, and the warehouse
  // crosswalk — duplicates would silently shadow a property in any id-keyed Map/Set.
  // parse.ts disambiguates at parse time; this is the always-on backstop.
  const propIds = s.properties.map((p) => p.id);
  if (new Set(propIds).size !== propIds.length) {
    const dupes = [...new Set(propIds.filter((id, i) => propIds.indexOf(id) !== i))];
    flag('properties.id', `duplicate property id(s): ${dupes.join(', ')}`);
  }

  // Relationship-graph edges must resolve to real nodes.
  const ids = {
    property: new Set(s.properties.map((p) => p.id)),
    loan: new Set(s.loans.map((l) => l.id)),
    deal: new Set(s.deals.map((d) => d.id)),
    insurance: new Set(s.insurance.map((i) => i.id)),
  };
  let dangling = 0;
  for (const cp of s.counterparties) {
    dangling += cp.links.properties.filter((id) => !ids.property.has(id)).length;
    dangling += cp.links.loans.filter((id) => !ids.loan.has(id)).length;
    dangling += cp.links.deals.filter((id) => !ids.deal.has(id)).length;
    dangling += cp.links.insurance.filter((id) => !ids.insurance.has(id)).length;
  }
  if (dangling > 0) flag('counterparties.links', `${dangling} dangling relationship edge(s)`, 'warn');

  return flags;
}
