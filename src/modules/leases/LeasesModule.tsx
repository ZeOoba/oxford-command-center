import { useMemo, useState, type CSSProperties } from 'react';
import Fuse from 'fuse.js';
import { Search, Download, CalendarClock } from 'lucide-react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { useLeaseForecast, gapChipLabel, buildGapMap } from '../leasing/hooks';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtNum, fmtYears, fmtDate, fmtMonths } from '@analytics/index';
import type { CriticalDate, CriticalDateKind } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { Tabs, TabPanel } from '@/primitives/Tabs';
import { BarChart } from '@/charts/BarChart';
import { useTabParam } from '@/lib/useTabParam';
import { FORCE_MOUNT_PANEL } from '@/lib/forceMountPanel';
import { downloadCsv } from '@/lib/export';
import type { Lease, LeaseStatus } from '@contracts/index';

const statusTone = (s: LeaseStatus): BadgeTone =>
  s === 'Expired' ? 'red' : s === 'Expiring Soon' ? 'amber' : s === 'Active' ? 'green' : 'neutral';

const kindTone: Record<CriticalDateKind, BadgeTone> = {
  'Notice Deadline': 'amber',
  Expiration: 'blue',
  Escalation: 'purple',
};

const urgencyTone = (days: number): BadgeTone => (days <= 30 ? 'red' : days <= 90 ? 'amber' : 'neutral');
const urgencyLabel = (days: number) => (days < 0 ? `${Math.abs(days)}d over` : `${days}d`);

const STATUS_ORDER: LeaseStatus[] = ['Active', 'Expiring Soon', 'Expired', 'Vacant', 'Unknown'];

type ExpiryFilter = 'all' | 'le90' | 'le12' | 'holdover';
const EXPIRY_LABEL: Record<ExpiryFilter, string> = {
  all: 'Any expiry',
  le90: 'Expiring ≤90d',
  le12: 'Expiring ≤12mo',
  holdover: 'Holdover (expired)',
};

type LeaseTab = 'rent-roll' | 'rollover';
const LEASE_TAB_KEYS: readonly LeaseTab[] = ['rent-roll', 'rollover'];

const fieldCls = 'num h-8 rounded-[var(--radius-sm)] px-2.5 text-2xs outline-none';
const fieldStyle: CSSProperties = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
};

export function LeasesModule() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const ui = useUi();
  const [tab, setTab] = useTabParam<LeaseTab>(LEASE_TAB_KEYS, 'rent-roll');

  // Market rent gaps from leasing forecast (warehouse-dependent; degrades gracefully)
  const { data: forecast } = useLeaseForecast();
  const gapMap = useMemo(() => buildGapMap(forecast?.marketGaps ?? []), [forecast?.marketGaps]);

  const leases = useMemo(() => data?.snapshot.leases ?? [], [data]);
  const asOf = data?.snapshot.meta.asOf ?? '';

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<LeaseStatus | 'all'>('all');
  const [property, setProperty] = useState('all');
  const [expiry, setExpiry] = useState<ExpiryFilter>('all');

  const fuse = useMemo(
    () => new Fuse(leases, { keys: ['company', 'tenantName', 'propertyKey', 'unit'], threshold: 0.34, ignoreLocation: true }),
    [leases],
  );
  const properties = useMemo(
    () => [...new Set(leases.map((l) => l.propertyKey))].sort((a, b) => a.localeCompare(b)),
    [leases],
  );
  const statuses = useMemo(
    () => STATUS_ORDER.filter((s) => leases.some((l) => l.status === s)),
    [leases],
  );

  const filtered = useMemo(() => {
    let rows = query.trim() ? fuse.search(query.trim()).map((r) => r.item) : leases;
    if (status !== 'all') rows = rows.filter((l) => l.status === status);
    if (property !== 'all') rows = rows.filter((l) => l.propertyKey === property);
    if (expiry === 'le90') rows = rows.filter((l) => l.monthsToExpiry !== null && l.monthsToExpiry >= 0 && l.monthsToExpiry <= 3);
    else if (expiry === 'le12') rows = rows.filter((l) => l.monthsToExpiry !== null && l.monthsToExpiry >= 0 && l.monthsToExpiry <= 12);
    else if (expiry === 'holdover') rows = rows.filter((l) => l.status === 'Expired');
    return rows;
  }, [leases, fuse, query, status, property, expiry]);

  const cols = useMemo((): Column<Lease>[] => [
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
    {
      key: 'market',
      header: 'Mkt $/SF',
      align: 'right',
      render: (l) => {
        const gap = gapMap.get(l.id);
        if (!gap || gap.provenance === 'absent') return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
        const label = gapChipLabel(gap);
        if (label === '—') return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
        if (gap.underMarket) return <Badge tone="amber">{label}</Badge>;
        return <span className="num text-2xs" style={{ color: 'var(--text-pos)' }}>{label}</span>;
      },
      sortValue: (l) => gapMap.get(l.id)?.gapPsf ?? null,
    },
  ], [gapMap]);

  const cdCols = useMemo((): Column<CriticalDate>[] => [
    { key: 'when', header: 'In', align: 'right', render: (c) => <Badge tone={urgencyTone(c.daysToDate)}>{urgencyLabel(c.daysToDate)}</Badge>, sortValue: (c) => c.daysToDate },
    { key: 'date', header: 'Date', align: 'right', render: (c) => fmtDate(c.date), sortValue: (c) => c.daysToDate },
    { key: 'kind', header: 'Event', render: (c) => <Badge tone={kindTone[c.kind]}>{c.kind}</Badge>, sortValue: (c) => c.kind },
    {
      key: 'tenant',
      header: 'Tenant',
      render: (c) => (
        <div>
          <div style={{ fontWeight: 600 }}>{c.tenant}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{c.propertyKey} {c.unit ?? ''}</div>
        </div>
      ),
      sortValue: (c) => c.tenant,
    },
    { key: 'rent', header: 'Rent', align: 'right', render: (c) => fmtUsdCompact(c.annualRent), sortValue: (c) => c.annualRent },
  ], []);

  if (!data || !analytics) return null;

  const totalRent = leases.reduce((s, l) => s + l.annualRent, 0);
  const filteredRent = filtered.reduce((s, l) => s + l.annualRent, 0);
  const rar = analytics.revenueAtRisk;
  const expSoon = leases.filter((l) => l.status === 'Expiring Soon').length;
  const isFiltered = query.trim() !== '' || status !== 'all' || property !== 'all' || expiry !== 'all';
  const cdOverdue = analytics.criticalDates.filter((c) => c.daysToDate < 0).length;

  const exportRentRoll = () => {
    const rows = filtered.map((l) => ({
      Tenant: l.company ?? l.tenantName,
      Property: l.propertyKey,
      Unit: l.unit ?? '',
      SF: l.sf,
      'Annual Rent': l.annualRent,
      '$/SF': l.rentPerSf ?? '',
      'Lease Start': l.leaseStart ?? '',
      'Lease End': l.leaseEnd ?? '',
      'Months To Expiry': l.monthsToExpiry ?? '',
      'Escalation %': l.escalationPct ?? '',
      Status: l.status,
    }));
    downloadCsv(`ORA_RentRoll_${asOf || 'export'}.csv`, rows);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="WALT" value={analytics.kpis.walt.value} format={fmtYears} prov={analytics.kpis.walt.prov} accentColor="var(--color-accent2)" sublabel="rent-weighted" />
        <KpiStat label="Annualized Rent" value={totalRent} format={fmtUsdCompact} accentColor="var(--color-pos)" sublabel={`${leases.length} leases`} />
        <KpiStat label="Expiring ≤90 Days" value={rar.within90dRent} format={fmtUsdCompact} accentColor="var(--color-warn)" sublabel={`${expSoon} leases`} />
        <KpiStat label="Holding Over" value={rar.expiredRent} format={fmtUsdCompact} accentColor="var(--color-neg)" sublabel="expired" />
      </div>

      {/* Both panels are force-mounted so the rent-roll search / filters / sort (and the Critical
          Dates sort) survive a tab round-trip. No queries of their own, so automatic keyboard
          activation. The overdue-holdover count rides on the Rollover tab label (R4) because that
          tab is non-default. */}
      <Tabs
        tabs={[
          { id: 'rent-roll', label: 'Rent roll' },
          { id: 'rollover', label: 'Rollover', badge: { count: cdOverdue, tone: 'red' } },
        ]}
        selectedKey={tab} onSelectionChange={(k) => setTab(k as LeaseTab)} aria-label="Lease views">
        <TabPanel id="rent-roll" {...FORCE_MOUNT_PANEL}>
          <Card>
            <CardHeader
              title="Rent Roll"
              trailing={
                <div className="flex items-center gap-2">
                  <Badge tone="gold">{isFiltered ? `${filtered.length} of ${leases.length}` : `${leases.length} tenants`}</Badge>
                  <Button size="sm" variant="subtle" onPress={exportRentRoll} isDisabled={filtered.length === 0} aria-label="Export rent roll to CSV">
                    <Download size={13} /> Export
                  </Button>
                </div>
              }
            />

            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="relative w-full sm:w-auto">
                <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tenant or property…"
                  aria-label="Search leases"
                  className={`${fieldCls} w-full pl-7 sm:w-56`}
                  style={fieldStyle}
                />
              </div>

              <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as LeaseStatus | 'all')} className={fieldCls} style={fieldStyle}>
                <option value="all">All statuses</option>
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>

              <select aria-label="Filter by property" value={property} onChange={(e) => setProperty(e.target.value)} className={`${fieldCls} w-full sm:w-auto sm:max-w-44`} style={fieldStyle}>
                <option value="all">All properties</option>
                {properties.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>

              <select aria-label="Filter by expiry window" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryFilter)} className={fieldCls} style={fieldStyle}>
                {(Object.keys(EXPIRY_LABEL) as ExpiryFilter[]).map((k) => <option key={k} value={k}>{EXPIRY_LABEL[k]}</option>)}
              </select>

              {isFiltered && (
                <>
                  <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{fmtUsdCompact(filteredRent)}/yr</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => { setQuery(''); setStatus('all'); setProperty('all'); setExpiry('all'); }}
                    aria-label="Clear all filters"
                  >
                    Clear
                  </Button>
                </>
              )}
            </div>

            <DataTable columns={cols} rows={filtered} getRowId={(l) => l.id} onRowClick={(l) => ui.openEntity({ type: 'lease', id: l.id })} initialSort={{ key: 'rent', dir: 'desc' }} maxHeight={520} />
          </Card>
        </TabPanel>
        <TabPanel id="rollover" {...FORCE_MOUNT_PANEL}>
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader title="Lease Rollover Schedule" trailing={<Badge tone="neutral">rent expiring</Badge>} />
              <div className="px-3 pb-2 pt-3">
                <BarChart data={analytics.rollover.map((b) => ({ label: b.period, value: b.expiringRent }))} valueFormat={fmtUsdCompact} height={230} color="var(--color-info)" />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Critical Dates"
                trailing={
                  <div className="flex items-center gap-2">
                    {cdOverdue > 0 && <Badge tone="red">{cdOverdue} overdue</Badge>}
                    <Badge tone="neutral">{analytics.criticalDates.length} items</Badge>
                  </div>
                }
              />
              <div className="flex items-center gap-1.5 px-4 pt-2 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                <CalendarClock size={12} />
                <span>Overdue holdovers + next 12 months · notice deadlines assume a 90-day window (estimated)</span>
              </div>
              {analytics.criticalDates.length > 0 ? (
                <div className="pt-2">
                  <DataTable
                    columns={cdCols}
                    rows={analytics.criticalDates}
                    getRowId={(c) => c.id}
                    onRowClick={(c) => ui.openEntity({ type: 'lease', id: c.leaseId })}
                    initialSort={{ key: 'when', dir: 'asc' }}
                    maxHeight={360}
                  />
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  No notice deadlines, expirations or escalations in the next 12 months.
                </div>
              )}
            </Card>
          </div>
        </TabPanel>
      </Tabs>
    </div>
  );
}
