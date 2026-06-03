import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtNum, fmtYears, fmtDate, fmtMonths } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { BarChart } from '@/charts/BarChart';
import type { Lease, LeaseStatus } from '@contracts/index';

const statusTone = (s: LeaseStatus): BadgeTone =>
  s === 'Expired' ? 'red' : s === 'Expiring Soon' ? 'amber' : s === 'Active' ? 'green' : 'neutral';

export function LeasesModule() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const ui = useUi();
  if (!data || !analytics) return null;
  const leases = data.snapshot.leases;
  const totalRent = leases.reduce((s, l) => s + l.annualRent, 0);
  const rar = analytics.revenueAtRisk;
  const expSoon = leases.filter((l) => l.status === 'Expiring Soon').length;

  const cols: Column<Lease>[] = [
    {
      key: 'tenant',
      header: 'Tenant',
      render: (l) => (
        <div>
          <div style={{ fontWeight: 600 }}>{l.company ?? l.tenantName}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{l.propertyKey} {l.unit ?? ''}</div>
        </div>
      ),
      sortValue: (l) => l.company ?? l.tenantName,
    },
    { key: 'sf', header: 'SF', align: 'right', render: (l) => fmtNum(l.sf), sortValue: (l) => l.sf },
    { key: 'rent', header: 'Annual Rent', align: 'right', render: (l) => fmtUsd(l.annualRent), sortValue: (l) => l.annualRent },
    { key: 'psf', header: '$/SF', align: 'right', render: (l) => (l.rentPerSf !== null ? `$${l.rentPerSf.toFixed(2)}` : '—'), sortValue: (l) => l.rentPerSf ?? 0 },
    { key: 'end', header: 'Expires', align: 'right', render: (l) => fmtDate(l.leaseEnd), sortValue: (l) => l.monthsToExpiry ?? 99999 },
    { key: 'mos', header: 'Mos', align: 'right', render: (l) => (l.monthsToExpiry !== null ? fmtMonths(l.monthsToExpiry) : '—'), sortValue: (l) => l.monthsToExpiry ?? 99999 },
    { key: 'esc', header: 'Esc', align: 'right', render: (l) => (l.escalationPct !== null ? fmtPct(l.escalationPct, 1) : '—'), sortValue: (l) => l.escalationPct ?? 0 },
    { key: 'status', header: 'Status', render: (l) => <Badge tone={statusTone(l.status)}>{l.status}</Badge>, sortValue: (l) => l.status },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="WALT" value={analytics.kpis.walt.value} format={fmtYears} prov={analytics.kpis.walt.prov} accentColor="var(--color-accent2)" sublabel="rent-weighted" />
        <KpiStat label="Annualized Rent" value={totalRent} format={fmtUsdCompact} accentColor="var(--color-pos)" sublabel={`${leases.length} leases`} />
        <KpiStat label="Expiring ≤90 Days" value={rar.within90dRent} format={fmtUsdCompact} accentColor="var(--color-warn)" sublabel={`${expSoon} leases`} />
        <KpiStat label="Holding Over" value={rar.expiredRent} format={fmtUsdCompact} accentColor="var(--color-neg)" sublabel="expired" />
      </div>

      <Card>
        <CardHeader title="Lease Rollover Schedule" trailing={<Badge tone="neutral">rent expiring</Badge>} />
        <div className="px-3 pb-2 pt-3">
          <BarChart data={analytics.rollover.map((b) => ({ label: b.period, value: b.expiringRent }))} valueFormat={fmtUsdCompact} height={230} color="var(--color-info)" />
        </div>
      </Card>

      <Card>
        <CardHeader title="Rent Roll" trailing={<Badge tone="gold">{leases.length} tenants</Badge>} />
        <DataTable columns={cols} rows={leases} getRowId={(l) => l.id} onRowClick={(l) => ui.openEntity({ type: 'lease', id: l.id })} initialSort={{ key: 'rent', dir: 'desc' }} maxHeight={520} />
      </Card>
    </div>
  );
}
