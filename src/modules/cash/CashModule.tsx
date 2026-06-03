import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge } from '@/primitives/Badge';
import { AreaChart } from '@/charts/AreaChart';
import type { CashEntity } from '@contracts/index';

export function CashModule() {
  const { data } = useSnapshot();
  const ui = useUi();
  if (!data) return null;
  const cash = data.snapshot.cash;
  const series = cash.history.map((h) => ({ date: h.date, value: h.total }));
  const largest = cash.entities.reduce((m, e) => Math.max(m, e.currentBalance), 0);

  const cols: Column<CashEntity>[] = [
    { key: 'entity', header: 'Entity', render: (c) => <span style={{ fontWeight: 600 }}>{c.entity}</span>, sortValue: (c) => c.entity },
    { key: 'bal', header: 'Current', align: 'right', render: (c) => fmtUsd(c.currentBalance), sortValue: (c) => c.currentBalance },
    { key: 'prior', header: 'Prior', align: 'right', render: (c) => fmtUsd(c.priorBalance), sortValue: (c) => c.priorBalance ?? 0 },
    {
      key: 'delta',
      header: 'Δ Period',
      align: 'right',
      render: (c) => (c.deltaPct !== null ? <span style={{ color: c.deltaPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)' }}>{fmtPct(c.deltaPct)}</span> : '—'),
      sortValue: (c) => c.deltaPct ?? 0,
    },
    { key: 'pct', header: '% of Cash', align: 'right', render: (c) => fmtPct(c.pctOfPortfolio), sortValue: (c) => c.pctOfPortfolio ?? 0 },
    {
      key: 'trend',
      header: 'Trend',
      align: 'right',
      render: (c) =>
        c.trend === 'up' ? <TrendingUp size={14} style={{ color: 'var(--color-pos)' }} /> : c.trend === 'down' ? <TrendingDown size={14} style={{ color: 'var(--color-neg)' }} /> : <Minus size={14} style={{ color: 'var(--text-tertiary)' }} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Total Cash" value={cash.totalCash} format={fmtUsdCompact} accentColor="var(--color-pos)" spark={series.map((s) => s.value)} sparkColor="var(--color-pos)" />
        <KpiStat label="Active Entities" value={cash.activeEntities} format={fmtNum} accentColor="var(--color-info)" />
        <KpiStat label="Top Concentration" value={cash.concentrationTopPct === null ? null : cash.concentrationTopPct * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} accentColor="var(--color-warn)" sublabel={cash.largestEntity ?? undefined} />
        <KpiStat label="Largest Balance" value={largest} format={fmtUsdCompact} />
      </div>

      <Card>
        <CardHeader title="Total Cash — 12-Month Trend" trailing={<Badge tone="gold">{series.length} months</Badge>} />
        <div className="px-3 pb-2 pt-3">
          <AreaChart data={series} valueFormat={fmtUsdCompact} height={250} color="var(--color-pos)" />
        </div>
      </Card>

      <Card>
        <CardHeader title="Entity Balances" trailing={<Badge tone="neutral">{cash.entities.length} entities</Badge>} />
        <DataTable columns={cols} rows={cash.entities} getRowId={(c) => c.id} onRowClick={(c) => ui.openEntity({ type: 'cashEntity', id: c.id })} initialSort={{ key: 'bal', dir: 'desc' }} />
      </Card>
    </div>
  );
}
