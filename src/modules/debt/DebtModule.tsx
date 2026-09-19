// src/modules/debt/DebtModule.tsx
//
// Phase 2 Step 6 — extended with a "Scorecard" tab alongside the existing loan positions view.
//
// Above the tabs (R2): KPI stats + balloon-watch banner.
// Tabs:
//   Positions   — the all-loans table (DSCR-adjacent LTV / maturity columns stay together, R1).
//   Maturities  — the Spine-A maturity ladder bar chart + Capital Composition.
//   Scorecard   — per-property debt score table (ScorecardView) + maturity ladder (LadderView,
//                 warehouse spine — deliberately NOT merged with the Maturities chart).
//
// The tab state lives in the URL (`?tab=`) via useTabParam (IA decongestion Phase 1).
// No changes to module registry (id: 'debt' already registered in shell/modules.tsx).
import { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtDate, fmtMonths } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Tabs, TabPanel } from '@/primitives/Tabs';
import { BarChart } from '@/charts/BarChart';
import { BarList } from '@/charts/BarList';
import { useTabParam } from '@/lib/useTabParam';
import { FORCE_MOUNT_PANEL } from '@/lib/forceMountPanel';
import type { Loan } from '@contracts/index';
import { ScorecardView } from './ScorecardView';
import { LadderView } from './LadderView';

const dirTone = (d: Loan['direction']): BadgeTone => (d === 'borrower' ? 'amber' : d === 'lender' ? 'blue' : 'neutral');
const dirLabel = (d: Loan['direction']) => (d === 'borrower' ? 'We pay' : d === 'lender' ? 'We receive' : 'Internal');

type Tab = 'positions' | 'maturities' | 'scorecard';
const TAB_KEYS: readonly Tab[] = ['positions', 'maturities', 'scorecard'];
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'positions', label: 'Positions' },
  { id: 'maturities', label: 'Maturities' },
  { id: 'scorecard', label: 'Scorecard' },
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

/** R2 — the KPI strip and the balloon-watch banner are true for every tab, so they render above
 *  the tab strip (rendered once from DebtModule). */
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
          sublabel={`${loans.filter((l) => l.direction === 'borrower').length} loans`}
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
  const [tab, setTab] = useTabParam<Tab>(TAB_KEYS, 'positions');

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Debt" />
      </Card>

      <DebtSummary />

      {/* keyboardActivation="manual" — the Scorecard tab mounts ScorecardView/LadderView, which
          fire fresh useDebtScores()/useDebtMaturity() warehouse queries on mount, so arrowing
          through the strip shouldn't fan out queries (plan R9). The positions / maturities panels
          are force-mounted (they were one scroll before the split; no queries of their own), so
          the loan-table sort survives a tab round-trip. */}
      <Tabs tabs={TABS} selectedKey={tab} onSelectionChange={(k) => setTab(k as Tab)} keyboardActivation="manual" aria-label="Debt views">
        <TabPanel id="positions" {...FORCE_MOUNT_PANEL}>
          <PositionsView />
        </TabPanel>
        <TabPanel id="maturities" {...FORCE_MOUNT_PANEL}>
          <MaturitiesView />
        </TabPanel>
        <TabPanel id="scorecard">
          <div className="flex flex-col gap-4">
            <ScorecardView />
            <LadderView />
          </div>
        </TabPanel>
      </Tabs>
    </div>
  );
}
