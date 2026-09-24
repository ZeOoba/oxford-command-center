import { useMemo } from 'react';
import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsd, fmtUsdCompact, fmtDate, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { SegmentedControl } from '@/primitives/SegmentedControl';
import { useTabParam } from '@/lib/useTabParam';
import type { InsurancePolicy, InsuranceStatus } from '@contracts/index';
import { useInsuranceAnalysis, computeInsuranceKpis, fmtRatePer100 } from './hooks';
import { SavingsBoard } from './SavingsBoard';
import { SelfInsureView } from './SelfInsureView';
import { PremiumHistoryCard } from './PremiumHistoryCard';

const tone = (s: InsuranceStatus): BadgeTone =>
  s === 'Expired' || s === 'Cancelled' ? 'red' : s === 'Renew Now' || s === 'Renewing Soon' ? 'amber' : s === 'Current' ? 'green' : 'neutral';

const daysTone = (d: number | null): BadgeTone => {
  if (d === null) return 'neutral';
  if (d < 0) return 'red';
  if (d <= 45) return 'amber';
  if (d <= 90) return 'blue';
  return 'neutral';
};

type View = 'savings' | 'register' | 'selfinsure';
const VIEW_KEYS: readonly View[] = ['savings', 'register', 'selfinsure'];
const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'savings', label: 'Savings Board' },
  { value: 'register', label: 'Policy Register' },
  { value: 'selfinsure', label: 'Self-Insure & Bids' },
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
    <div className="flex flex-col gap-4">
      <PremiumHistoryCard />
      <Card>
        <CardHeader title="Policy Tracker" trailing={<Badge tone="gold">{pol.length} policies</Badge>} />
        <DataTable columns={cols} rows={pol} getRowId={(p) => p.id} onRowClick={(p) => ui.openEntity({ type: 'insurance', id: p.id })} initialSort={{ key: 'days', dir: 'asc' }} maxHeight={520} />
      </Card>
    </div>
  );
}

export function InsuranceModule() {
  const [view, setView] = useTabParam<View>(VIEW_KEYS, 'savings', 'view');
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

      {/* Only the selected view is mounted — the Self-Insure & Bids view fires a fresh
          useInsuranceLoss() warehouse query on mount, so nothing fans out until it is chosen
          (plan R9). Tradeoff: SegmentedControl is a react-aria RadioGroup where arrow-key roving
          SELECTS, so arrowing across segments mounts each view in turn (the old
          keyboardActivation="manual" guard is not preserved); mouse and deep-link use load only
          the chosen view. Insurance is a tab of the Obligations destination, so its own switch
          is a SegmentedControl on ?view= (R5: no nested tab strips). */}
      <SegmentedControl options={VIEWS} value={view} onChange={setView} aria-label="Insurance views" />

      {view === 'savings' && <SavingsBoard />}
      {view === 'register' && <PolicyRegisterView />}
      {view === 'selfinsure' && <SelfInsureView />}
    </div>
  );
}
