import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsd, fmtUsdCompact, fmtDate, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import type { InsurancePolicy, InsuranceStatus } from '@contracts/index';

const tone = (s: InsuranceStatus): BadgeTone =>
  s === 'Expired' || s === 'Cancelled' ? 'red' : s === 'Renew Now' || s === 'Renewing Soon' ? 'amber' : s === 'Current' ? 'green' : 'neutral';

export function InsuranceModule() {
  const { data } = useSnapshot();
  const ui = useUi();
  if (!data) return null;
  const pol = data.snapshot.insurance;
  const totalPremium = pol.reduce((s, p) => s + p.premium, 0);
  const expired = pol.filter((p) => p.status === 'Expired' || p.status === 'Cancelled').length;
  const active = pol.filter((p) => p.status !== 'Cancelled' && p.status !== 'Expired').length;
  const renewingSoon = pol.filter((p) => p.status === 'Renewing Soon' || p.status === 'Renew Now').length;
  const asOf = new Date(data.snapshot.meta.asOf).getTime();
  const upcoming = pol
    .filter((p) => p.expires && new Date(p.expires).getTime() >= asOf)
    .sort((a, b) => new Date(a.expires!).getTime() - new Date(b.expires!).getTime())[0];

  const cols: Column<InsurancePolicy>[] = [
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
    { key: 'days', header: 'Days', align: 'right', render: (p) => (p.daysToExpiry ?? '—'), sortValue: (p) => p.daysToExpiry ?? 99999 },
    { key: 'status', header: 'Status', render: (p) => <Badge tone={tone(p.status)}>{p.status}</Badge>, sortValue: (p) => p.status },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Active Policies" value={active} format={fmtNum} accentColor="var(--color-info)" />
        <KpiStat label="Annual Premium" value={totalPremium} format={fmtUsdCompact} accentColor="var(--accent)" />
        <KpiStat label="Expired / Cancelled" value={expired} format={fmtNum} accentColor="var(--color-neg)" />
        <KpiStat label="Renewing Soon" value={renewingSoon} format={fmtNum} accentColor="var(--color-warn)" sublabel={upcoming ? `next ${fmtDate(upcoming.expires)}` : undefined} />
      </div>
      <Card>
        <CardHeader title="Policy Tracker" trailing={<Badge tone="gold">{pol.length} policies</Badge>} />
        <DataTable columns={cols} rows={pol} getRowId={(p) => p.id} onRowClick={(p) => ui.openEntity({ type: 'insurance', id: p.id })} initialSort={{ key: 'days', dir: 'asc' }} maxHeight={520} />
      </Card>
    </div>
  );
}
