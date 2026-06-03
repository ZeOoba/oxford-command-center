import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsdCompact, fmtPct, fmtSf, fmtMultiple, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge } from '@/primitives/Badge';
import { BarList } from '@/charts/BarList';
import type { Property } from '@contracts/index';

export function PortfolioModule() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const ui = useUi();
  if (!data || !analytics) return null;
  const props = data.snapshot.properties;
  const k = analytics.kpis;

  const cols: Column<Property>[] = [
    {
      key: 'name',
      header: 'Property',
      render: (p) => (
        <div>
          <div style={{ fontWeight: 600 }}>{p.name}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{p.market}</div>
        </div>
      ),
      sortValue: (p) => p.name,
    },
    { key: 'type', header: 'Type', render: (p) => <Badge tone="neutral">{p.type}</Badge>, sortValue: (p) => p.type },
    { key: 'sf', header: 'SF', align: 'right', render: (p) => fmtNum(p.sf), sortValue: (p) => p.sf },
    { key: 'occ', header: 'Occ', align: 'right', render: (p) => fmtPct(p.occPct), sortValue: (p) => p.occPct },
    { key: 'noi', header: 'NOI', align: 'right', render: (p) => fmtUsdCompact(p.noi), sortValue: (p) => p.noi },
    { key: 'cap', header: 'Cap', align: 'right', render: (p) => fmtPct(p.capRate), sortValue: (p) => p.capRate ?? 0 },
    { key: 'dscr', header: 'DSCR', align: 'right', render: (p) => (p.dscr !== null ? fmtMultiple(p.dscr) : '—'), sortValue: (p) => p.dscr ?? 0 },
    { key: 'ltv', header: 'LTV', align: 'right', render: (p) => fmtPct(p.ltv), sortValue: (p) => p.ltv ?? 0 },
    { key: 'value', header: 'Value', align: 'right', render: (p) => fmtUsdCompact(p.oxfordValue), sortValue: (p) => p.oxfordValue },
    {
      key: 'lender',
      header: 'Lender',
      render: (p) => p.lender ?? <span style={{ color: 'var(--text-tertiary)' }}>—</span>,
      sortValue: (p) => p.lender ?? '',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Portfolio Value" value={k.value.value} format={fmtUsdCompact} prov={k.value.prov} sublabel={`${fmtNum(k.propertyCount.value)} assets`} />
        <KpiStat label="Net Operating Income" value={k.noi.value} format={fmtUsdCompact} prov={k.noi.prov} accentColor="var(--color-pos)" />
        <KpiStat label="Portfolio SF" value={k.totalSf.value} format={fmtSf} prov={k.totalSf.prov} accentColor="var(--color-info)" />
        <KpiStat label="Weighted Cap Rate" value={k.weightedCapRate.value === null ? null : k.weightedCapRate.value * 100} format={(n) => (n === null ? '—' : `${n.toFixed(2)}%`)} prov={k.weightedCapRate.prov} accentColor="var(--color-accent2)" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Property Detail — All Assets" trailing={<Badge tone="gold">{props.length} properties</Badge>} />
          <DataTable
            columns={cols}
            rows={props}
            getRowId={(p) => p.id}
            onRowClick={(p) => ui.openEntity({ type: 'property', id: p.id })}
            initialSort={{ key: 'value', dir: 'desc' }}
          />
        </Card>
        <Card>
          <CardHeader title="Value by Market" />
          <div className="p-3">
            <BarList
              items={analytics.marketByNoi.map((m) => ({ label: m.market, value: m.value, display: fmtUsdCompact(m.value) }))}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
