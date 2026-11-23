// The portfolio data-ops KPI band (committed imports / open DQ issues / properties covered /
// latest period). Moved verbatim from IntelModule in IA decongestion Phase 4a — it anchors the
// warehouse data-ops tabs, which now live in the Data destination.
import { KpiStat } from '@/primitives/KpiStat';
import type { LedgerCoverage } from './latestPeriod';

const count = (n: number | null) => (n === null ? '—' : String(Math.round(n)));

export function DataOpsKpiRow({ committed, pending, openIssues, propertiesCovered, latestPeriod, coverage }: {
  committed: number;
  pending: number;
  openIssues: number;
  propertiesCovered: number;
  latestPeriod: string | null;
  /** How far the committed ledger runs (2026-11-23 review); falls back to the bare latest period. */
  coverage?: LedgerCoverage | null;
}) {
  const periodLabel = coverage?.label ?? latestPeriod;
  const warehouseProv = { source: 'Warehouse · committed imports', confidence: 'derived' as const, ...(latestPeriod ? { asOf: latestPeriod } : {}) };
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiStat label="Committed Imports" value={committed} format={count} accentColor="var(--color-pos)" sublabel={pending > 0 ? `${pending} pending review` : undefined} prov={warehouseProv} />
      <KpiStat label="Open DQ Issues" value={openIssues} format={count} accentColor={openIssues > 0 ? 'var(--color-warn)' : 'var(--color-pos)'} prov={warehouseProv} />
      <KpiStat label="Properties Covered" value={propertiesCovered} format={count} accentColor="var(--color-info)" prov={warehouseProv} />
      <KpiStat label="Ledger Runs Through" value={periodLabel ? 1 : null} format={() => periodLabel ?? '—'} sublabel={coverage?.detail ?? undefined} accentColor="var(--accent)" prov={warehouseProv} />
    </div>
  );
}
