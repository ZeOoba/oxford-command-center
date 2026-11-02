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
import { fmtUsd, fmtUsdCompact, fmtPct, fmtDate, fmtMonths, isAffiliateBorrowerLoan } from '@analytics/index';
import { externalDebtSublabel } from './debt-sublabels';
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

/** Months-to-maturity horizon inside which a borrower position is "needs action" (matches the
 *  balloon-warning window in src/analytics/conditions.ts: 365 days). Presentation only. */
const ACTION_HORIZON_MONTHS = 12;

/** Positions that need a decision now: we-pay loans maturing within the horizon (balloon or not —
 *  `Loan.balloon` is structural, so it is NOT by itself an "act now" signal; a balloon 5 years out
 *  is a maturity-ladder fact, not a verdict). */
function atRiskLoans(loans: Loan[]): Loan[] {
  return loans.filter(
    (l) => l.direction === 'borrower' && l.monthsToMaturity !== null && l.monthsToMaturity <= ACTION_HORIZON_MONTHS,
  );
}

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
  const atRisk = atRiskLoans(loans);
  const atRiskBalance = atRisk.reduce((n, l) => n + l.absBalance, 0);
  const balloons = atRisk.filter((l) => l.balloon).length;

  return (
    <Card>
      <CardHeader title="All Loan Positions" trailing={<Badge tone="neutral">{loans.length} positions</Badge>} />
      {/* Lead verdict — the default view must say what needs a decision, not just list balances. */}
      <div
        className="flex items-center gap-2 px-4 pb-3 text-sm"
        style={{ color: atRisk.length > 0 ? 'var(--color-warn)' : 'var(--text-tertiary)' }}
        data-testid="debt-positions-verdict"
      >
        <AlertCircle size={14} />
        {atRisk.length > 0
          ? `${atRisk.length} of ${loans.length} positions need action within ${ACTION_HORIZON_MONTHS} months — ${fmtUsdCompact(atRiskBalance)} outstanding` +
            (balloons > 0 ? `, ${balloons} balloon${balloons === 1 ? '' : 's'}` : '') +
            '. Sorted nearest maturity first.'
          : `No borrower position balloons or matures within ${ACTION_HORIZON_MONTHS} months.`}
      </div>
      <DataTable
        columns={cols}
        rows={loans}
        getRowId={(l) => l.id}
        onRowClick={(l) => ui.openEntity({ type: 'loan', id: l.id })}
        initialSort={{ key: 'mat', dir: 'asc' }}
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
  // Provenance for the KPI strip: every figure is a Σ over the workbook loan schedule as-of the
  // snapshot date — surfaced so the tiles carry the same source/confidence stamp as the rest of the app.
  const asOf = data.snapshot.meta?.asOf;
  const loanProv = (formula: string) =>
    ({ source: 'Master Workbook › Loan schedule', confidence: 'derived', asOf, formula }) as const;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat
          label="External Debt"
          value={d.externalDebt}
          format={fmtUsdCompact}
          accentColor="var(--color-warn)"
          sublabel={externalDebtSublabel(d, loans.filter((l) => l.direction === 'borrower' && !isAffiliateBorrowerLoan(l)).length)}
          prov={loanProv('Σ |balance| over direction = borrower, affiliate notes excluded')}
        />
        <KpiStat
          label="Weighted Avg Rate"
          value={d.weightedAvgRate === null ? null : d.weightedAvgRate * 100}
          format={(n) => (n === null ? '—' : `${n.toFixed(2)}%`)}
          prov={loanProv('Σ(rate · balance) / Σ balance, borrower loans with a rate')}
        />
        <KpiStat
          label="Annual Debt Service"
          value={d.annualDebtService}
          format={fmtUsdCompact}
          accentColor="var(--color-neg)"
          prov={loanProv('Σ monthly payment × 12, borrower loans')}
        />
        <KpiStat
          label="Capital Deployed"
          value={d.lenderDeployed}
          format={fmtUsdCompact}
          accentColor="var(--color-info)"
          sublabel="we are lender"
          prov={loanProv('Σ |balance| over direction = lender')}
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
            ariaLabel="Loan balance maturing by period"
          />
        </div>
      </Card>
      <Card>
        <CardHeader title="Capital Composition" />
        <div className="p-3">
          <BarList
            items={[
              { label: 'External — we pay', value: d.externalDebt, display: fmtUsdCompact(d.externalDebt) },
              ...(d.affiliateDebt > 0
                ? [{ label: 'Affiliate notes — Oxford to Oxford', value: d.affiliateDebt, display: fmtUsdCompact(d.affiliateDebt) }]
                : []),
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
