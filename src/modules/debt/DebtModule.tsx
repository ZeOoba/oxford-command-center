import { AlertCircle } from 'lucide-react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtDate, fmtMonths } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { BarChart } from '@/charts/BarChart';
import { BarList } from '@/charts/BarList';
import type { Loan } from '@contracts/index';

const dirTone = (d: Loan['direction']): BadgeTone => (d === 'borrower' ? 'amber' : d === 'lender' ? 'blue' : 'neutral');
const dirLabel = (d: Loan['direction']) => (d === 'borrower' ? 'We pay' : d === 'lender' ? 'We receive' : 'Internal');

export function DebtModule() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const ui = useUi();
  if (!data || !analytics) return null;
  const loans = data.snapshot.loans;
  const d = analytics.debt;
  const balloons = loans.filter((l) => l.balloon);

  const cols: Column<Loan>[] = [
    {
      key: 'name',
      header: 'Loan',
      render: (l) => (
        <div>
          <div style={{ fontWeight: 600 }}>{l.name}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{l.counterparty ?? ''}</div>
        </div>
      ),
      sortValue: (l) => l.name,
    },
    { key: 'dir', header: 'Direction', render: (l) => <Badge tone={dirTone(l.direction)}>{dirLabel(l.direction)}</Badge>, sortValue: (l) => l.direction },
    { key: 'bal', header: 'Balance', align: 'right', render: (l) => fmtUsdCompact(l.absBalance), sortValue: (l) => l.absBalance },
    { key: 'rate', header: 'Rate', align: 'right', render: (l) => (l.rate !== null ? fmtPct(l.rate, 2) : '—'), sortValue: (l) => l.rate ?? 0 },
    { key: 'mat', header: 'Maturity', align: 'right', render: (l) => (l.isDemand ? 'Demand' : fmtDate(l.maturity)), sortValue: (l) => l.monthsToMaturity ?? 99999 },
    { key: 'mos', header: 'Mos', align: 'right', render: (l) => (l.monthsToMaturity !== null ? fmtMonths(l.monthsToMaturity) : '—'), sortValue: (l) => l.monthsToMaturity ?? 99999 },
    { key: 'ltv', header: 'LTV', align: 'right', render: (l) => fmtPct(l.ltv), sortValue: (l) => l.ltv ?? 0 },
    {
      key: 'status',
      header: 'Status',
      render: (l) => (l.balloon ? <Badge tone="red">Balloon</Badge> : <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{l.status ?? '—'}</span>),
      sortValue: (l) => l.status ?? '',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="External Debt" value={d.externalDebt} format={fmtUsdCompact} accentColor="var(--color-warn)" sublabel={`${loans.filter((l) => l.direction === 'borrower').length} loans`} />
        <KpiStat label="Weighted Avg Rate" value={d.weightedAvgRate === null ? null : d.weightedAvgRate * 100} format={(n) => (n === null ? '—' : `${n.toFixed(2)}%`)} />
        <KpiStat label="Annual Debt Service" value={d.annualDebtService} format={fmtUsdCompact} accentColor="var(--color-neg)" />
        <KpiStat label="Capital Deployed" value={d.lenderDeployed} format={fmtUsdCompact} accentColor="var(--color-info)" sublabel="we are lender" />
      </div>

      {balloons.length > 0 && (
        <Card accent>
          <div className="flex items-start gap-3 px-4 py-3">
            <AlertCircle size={18} style={{ color: 'var(--color-neg)', marginTop: 1 }} />
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Balloon watch</div>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {balloons.map((b) => `${b.name} — ${fmtUsd(b.absBalance)} due ${fmtDate(b.maturity)}`).join(' · ')}
              </div>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Maturity Ladder" />
          <div className="px-3 pb-2 pt-3">
            <BarChart data={d.ladder.map((b) => ({ label: b.period, value: b.balance }))} valueFormat={fmtUsdCompact} height={240} color="var(--color-warn)" />
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

      <Card>
        <CardHeader title="All Loan Positions" trailing={<Badge tone="neutral">{loans.length} positions</Badge>} />
        <DataTable columns={cols} rows={loans} getRowId={(l) => l.id} onRowClick={(l) => ui.openEntity({ type: 'loan', id: l.id })} initialSort={{ key: 'bal', dir: 'desc' }} />
      </Card>
    </div>
  );
}
