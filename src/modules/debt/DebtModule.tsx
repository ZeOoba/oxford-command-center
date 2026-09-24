// src/modules/debt/DebtModule.tsx
//
// The Debt surface (the "Debt" tab of the Capital destination since IA decongestion Phase 4b; /debt
// is a legacy alias). Capital owns the tab strip, so the three views here are switched by a
// SegmentedControl on `?view=` (rule R5: no nested tab strips) via useTabParam.
//
// Above the switch (R2): KPI stats + balloon-watch banner.
// Views:
//   Positions   — the all-loans table (DSCR-adjacent LTV / maturity columns stay together, R1). DEFAULT.
//   Maturities  — the Spine-A maturity ladder bar chart + Capital Composition.
//   Scorecard   — per-property debt score table (ScorecardView) + maturity ladder (LadderView,
//                 warehouse spine — deliberately NOT merged with the Maturities chart).
//
// Only the selected view is mounted, so Scorecard's warehouse queries fire only when it is chosen.
// Not a registry entry of its own: 'debt' was absorbed into the Capital destination in Phase 4b and
// survives only as a LEGACY_ALIASES row (src/brain/routing.ts) -> /capital?tab=debt.
import { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtDate, fmtMonths } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { SegmentedControl } from '@/primitives/SegmentedControl';
import { BarChart } from '@/charts/BarChart';
import { BarList } from '@/charts/BarList';
import { useTabParam } from '@/lib/useTabParam';
import type { Loan } from '@contracts/index';
import { ScorecardView } from './ScorecardView';
import { LadderView } from './LadderView';

const dirTone = (d: Loan['direction']): BadgeTone => (d === 'borrower' ? 'amber' : d === 'lender' ? 'blue' : 'neutral');
const dirLabel = (d: Loan['direction']) => (d === 'borrower' ? 'We pay' : d === 'lender' ? 'We receive' : 'Internal');

type View = 'positions' | 'maturities' | 'scorecard';
const VIEW_KEYS: readonly View[] = ['positions', 'maturities', 'scorecard'];
const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'positions', label: 'Positions' },
  { value: 'maturities', label: 'Maturities' },
  { value: 'scorecard', label: 'Scorecard' },
];

function PositionsView() {
  const { data } = useSnapshot();
  const ui = useUi();

  const cols = useMemo((): Column<Loan>[] => [
    {
      key: 'name',
      header: 'Loan',
      render: (l) => (
        <div>
          <div style={{ fontWeight: 600 }}>{l.name}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {l.counterparty ?? ''}
          </div>
        </div>
      ),
      sortValue: (l) => l.name,
    },
    {
      key: 'dir',
      header: 'Direction',
      render: (l) => <Badge tone={dirTone(l.direction)}>{dirLabel(l.direction)}</Badge>,
      sortValue: (l) => l.direction,
    },
    {
      key: 'bal',
      header: 'Balance',
      align: 'right',
      render: (l) => fmtUsdCompact(l.absBalance),
      sortValue: (l) => l.absBalance,
    },
    {
      key: 'rate',
      header: 'Rate',
      align: 'right',
      render: (l) => (l.rate !== null ? fmtPct(l.rate, 2) : '—'),
      sortValue: (l) => l.rate ?? 0,
    },
    {
      key: 'mat',
      header: 'Maturity',
      align: 'right',
      render: (l) => (l.isDemand ? 'Demand' : fmtDate(l.maturity)),
      sortValue: (l) => l.monthsToMaturity ?? 99999,
    },
    {
      key: 'mos',
      header: 'Mos',
      align: 'right',
      render: (l) => (l.monthsToMaturity !== null ? fmtMonths(l.monthsToMaturity) : '—'),
      sortValue: (l) => l.monthsToMaturity ?? 99999,
    },
    {
      key: 'ltv',
      header: 'LTV',
      align: 'right',
      render: (l) => fmtPct(l.ltv),
      sortValue: (l) => l.ltv ?? 0,
    },
    {
      key: 'status',
      header: 'Status',
      render: (l) =>
        l.balloon ? (
          <Badge tone="red">Balloon</Badge>
        ) : (
          <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {l.status ?? '—'}
          </span>
        ),
      sortValue: (l) => l.status ?? '',
    },
  ], []);

  if (!data) return null;
  const loans = data.snapshot.loans;

  return (
    <Card>
      <CardHeader title="All Loan Positions" trailing={<Badge tone="neutral">{loans.length} positions</Badge>} />
      <DataTable
        columns={cols}
        rows={loans}
        getRowId={(l) => l.id}
        onRowClick={(l) => ui.openEntity({ type: 'loan', id: l.id })}
        initialSort={{ key: 'bal', dir: 'desc' }}
      />
    </Card>
  );
}

/** R2 — the KPI strip and the balloon-watch banner are true for every view, so they render above
 *  the view switch (rendered once from DebtModule). */
function DebtSummary() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();

  if (!data || !analytics) return null;
  const loans = data.snapshot.loans;
  const d = analytics.debt;
  const balloons = loans.filter((l) => l.balloon);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat
          label="External Debt"
          value={d.externalDebt}
          format={fmtUsdCompact}
          accentColor="var(--color-warn)"
          sublabel={`${loans.filter((l) => l.direction === 'borrower').length} borrower loans · loan schedule`}
        />
        <KpiStat
          label="Weighted Avg Rate"
          value={d.weightedAvgRate === null ? null : d.weightedAvgRate * 100}
          format={(n) => (n === null ? '—' : `${n.toFixed(2)}%`)}
        />
        <KpiStat
          label="Annual Debt Service"
          value={d.annualDebtService}
          format={fmtUsdCompact}
          accentColor="var(--color-neg)"
        />
        <KpiStat
          label="Capital Deployed"
          value={d.lenderDeployed}
          format={fmtUsdCompact}
          accentColor="var(--color-info)"
          sublabel="we are lender"
        />
      </div>

      {balloons.length > 0 && (
        <Card accent>
          <div className="flex items-start gap-3 px-4 py-3">
            <AlertCircle size={18} style={{ color: 'var(--color-neg)', marginTop: 1 }} />
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Balloon watch
              </div>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {balloons.map((b) => `${b.name} — ${fmtUsd(b.absBalance)} due ${fmtDate(b.maturity)}`).join(' · ')}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function MaturitiesView() {
  const { analytics } = useAnalytics();

  if (!analytics) return null;
  const d = analytics.debt;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Maturity Ladder" />
        <div className="px-3 pb-2 pt-3">
          <BarChart
            data={d.ladder.map((b) => ({ label: b.period, value: b.balance }))}
            valueFormat={fmtUsdCompact}
            height={240}
            color="var(--color-warn)"
          />
        </div>
      </Card>
      <Card>
        <CardHeader title="Capital Composition" />
        <div className="p-3">
          <BarList
            items={[
              { label: 'External — we pay', value: d.externalDebt, display: fmtUsdCompact(d.externalDebt) },
              { label: 'Internal accrual', value: d.internalOutstanding, display: fmtUsdCompact(d.internalOutstanding) },
              { label: 'Deployed — we receive', value: d.lenderDeployed, display: fmtUsdCompact(d.lenderDeployed) },
            ]}
          />
        </div>
      </Card>
    </div>
  );
}

export function DebtModule() {
  const [view, setView] = useTabParam<View>(VIEW_KEYS, 'positions', 'view');

  return (
    <div className="flex flex-col gap-4">
      <DebtSummary />

      <SegmentedControl options={VIEWS} value={view} onChange={setView} aria-label="Debt views" />

      {view === 'positions' && <PositionsView />}
      {view === 'maturities' && <MaturitiesView />}
      {view === 'scorecard' && (
        <div className="flex flex-col gap-4">
          <ScorecardView />
          <LadderView />
        </div>
      )}
    </div>
  );
}
