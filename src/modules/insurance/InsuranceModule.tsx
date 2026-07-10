import { useState, useMemo } from 'react';
import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsd, fmtUsdCompact, fmtDate, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { cn } from '@/lib/cn';
import type { InsurancePolicy, InsuranceStatus } from '@contracts/index';
import { useInsuranceAnalysis, computeInsuranceKpis, fmtRatePer100 } from './hooks';
import { SavingsBoard } from './SavingsBoard';
import { SelfInsureView } from './SelfInsureView';

const tone = (s: InsuranceStatus): BadgeTone =>
  s === 'Expired' || s === 'Cancelled' ? 'red' : s === 'Renew Now' || s === 'Renewing Soon' ? 'amber' : s === 'Current' ? 'green' : 'neutral';

const daysTone = (d: number | null): BadgeTone => {
  if (d === null) return 'neutral';
  if (d < 0) return 'red';
  if (d <= 45) return 'amber';
  if (d <= 90) return 'blue';
  return 'neutral';
};

type Tab = 'savings' | 'register' | 'selfinsure';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'savings', label: 'Savings Board' },
  { id: 'register', label: 'Policy Register' },
  { id: 'selfinsure', label: 'Self-Insure & Bids' },
];

function PolicyRegisterView() {
  const { data } = useSnapshot();
  const ui = useUi();

  const cols = useMemo((): Column<InsurancePolicy>[] => [
    {
      key: 'prop',
      header: 'Property',
      render: (p) => (
        <div className="max-w-[280px]">
          <div className="truncate" style={{ fontWeight: 600 }}>{p.property}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{p.coverage ?? ''}</div>
        </div>
      ),
      sortValue: (p) => p.property,
    },
    { key: 'carrier', header: 'Carrier', render: (p) => p.carrier ?? '—', sortValue: (p) => p.carrier ?? '' },
    { key: 'premium', header: 'Premium', align: 'right', render: (p) => fmtUsd(p.premium), sortValue: (p) => p.premium },
    { key: 'expires', header: 'Expires', align: 'right', render: (p) => fmtDate(p.expires), sortValue: (p) => (p.expires ? new Date(p.expires).getTime() : 0) },
    {
      key: 'days',
      header: 'Days',
      align: 'right',
      render: (p) => <Badge tone={daysTone(p.daysToExpiry)}>{p.daysToExpiry ?? '—'}</Badge>,
      sortValue: (p) => p.daysToExpiry ?? 99999,
    },
    { key: 'status', header: 'Status', render: (p) => <Badge tone={tone(p.status)}>{p.status}</Badge>, sortValue: (p) => p.status },
  ], []);

  if (!data) return null;
  const pol = data.snapshot.insurance;

  return (
    <Card>
      <CardHeader title="Policy Tracker" trailing={<Badge tone="gold">{pol.length} policies</Badge>} />
      <DataTable columns={cols} rows={pol} getRowId={(p) => p.id} onRowClick={(p) => ui.openEntity({ type: 'insurance', id: p.id })} initialSort={{ key: 'days', dir: 'asc' }} maxHeight={520} />
    </Card>
  );
}

export function InsuranceModule() {
  const [tab, setTab] = useState<Tab>('savings');
  const { data: report } = useInsuranceAnalysis();
  const kpis = computeInsuranceKpis(report);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Annual Premium" value={kpis.premiumAnnualTotal} format={fmtUsdCompact} accentColor="var(--accent)" />
        <KpiStat
          label="Rate vs Benchmark"
          value={kpis.medianRatePer100Tiv}
          format={fmtRatePer100}
          accentColor="var(--color-info)"
          sublabel={kpis.benchmarkSublabel}
        />
        <KpiStat label="Premium Above Median" value={kpis.premiumAboveMedian} format={fmtUsdCompact} accentColor="var(--color-warn)" />
        <KpiStat label="Renewals ≤90d" value={kpis.renewalsWithin90} format={fmtNum} accentColor="var(--color-accent2)" />
      </div>

      <Card>
        <CardHeader
          title="Insurance"
          trailing={
            <div className="flex items-center gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'num rounded-full px-2.5 py-0.5 text-2xs font-semibold uppercase transition-colors',
                    tab === t.id ? 'cursor-default' : 'cursor-pointer',
                  )}
                  style={
                    tab === t.id
                      ? {
                          background: 'color-mix(in oklab, var(--accent) 16%, transparent)',
                          color: 'var(--text-accent)',
                          border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)',
                          letterSpacing: '0.06em',
                        }
                      : {
                          background: 'transparent',
                          color: 'var(--text-tertiary)',
                          border: '1px solid transparent',
                          letterSpacing: '0.06em',
                        }
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        />
      </Card>

      {tab === 'savings' ? <SavingsBoard /> : tab === 'register' ? <PolicyRegisterView /> : <SelfInsureView />}
    </div>
  );
}
