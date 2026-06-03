import type { PortfolioSnapshot, DataQualityFlag } from '../src/contracts/index';

/**
 * In-process reconciliation (Phase 6, §10). Runs on every brain.refresh() and verifies the
 * snapshot's internal invariants — no second workbook read. Any breach becomes a DataQualityFlag
 * on the snapshot so the UI can show a degraded state and downgrade provenance, rather than
 * silently serving inconsistent numbers. The $0 cross-check against the workbook's own total cells
 * still lives in scripts/reconcile.ts (the local gate); this is the always-on runtime guard.
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

  // Core entity sets must be non-empty (a parse that silently emptied a sheet).
  if (s.properties.length === 0) flag('properties', 'no properties parsed');
  if (s.leases.length === 0) flag('leases', 'no leases parsed');

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
