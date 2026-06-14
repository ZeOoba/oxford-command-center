import { useState } from 'react';
import { Lock } from 'lucide-react';
import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsdCompact, fmtPct, fmtMultiple, fmtNum, fmtSf } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { BarList } from '@/charts/BarList';
import type { Deal, DealStage } from '@contracts/index';
import { AcquisitionWorkbench } from './AcquisitionWorkbench';

const STAGE_ORDER: DealStage[] = ['Sourcing', 'Candidate', 'LOI/PSA', 'Due Diligence', 'Refinance', 'Closing', 'Closed', 'Dead'];
const STAGE_TONE: Record<DealStage, BadgeTone> = {
  Sourcing: 'neutral',
  Candidate: 'neutral',
  'LOI/PSA': 'purple',
  'Due Diligence': 'blue',
  Refinance: 'red',
  Closing: 'amber',
  Closed: 'green',
  Dead: 'neutral',
};

export function AcquisitionsModule() {
  const { data } = useSnapshot();
  const ui = useUi();
  const [scoreDealId, setScoreDealId] = useState<string>('');
  if (!data) return null;
  const deals = data.snapshot.deals;
  const scoreDeal = deals.find((d) => d.id === scoreDealId) ?? null;
  const active = deals.filter((d) => d.stage !== 'Closed' && d.stage !== 'Dead');
  const stageCounts = STAGE_ORDER.map((s) => ({ label: s, value: deals.filter((d) => d.stage === s).length })).filter((x) => x.value > 0);
  const bestCap = Math.max(0, ...deals.map((d) => d.capRate ?? 0));
  const pipelineSf = active.reduce((s, d) => s + (d.sf ?? 0), 0);

  const cols: Column<Deal>[] = [
    {
      key: 'name',
      header: 'Deal',
      render: (d) => (
        <div className="flex items-center gap-1.5">
          <span style={{ fontWeight: 600 }}>{d.name}</span>
          {d.confidential && <Lock size={11} style={{ color: 'var(--color-accent2)' }} />}
        </div>
      ),
      sortValue: (d) => d.name,
    },
    { key: 'stage', header: 'Stage', render: (d) => <Badge tone={STAGE_TONE[d.stage]}>{d.stage}</Badge>, sortValue: (d) => STAGE_ORDER.indexOf(d.stage) },
    { key: 'market', header: 'Market', render: (d) => d.market ?? '—', sortValue: (d) => d.market ?? '' },
    { key: 'sf', header: 'SF', align: 'right', render: (d) => (d.sf !== null ? fmtNum(d.sf) : '—'), sortValue: (d) => d.sf ?? 0 },
    { key: 'price', header: 'Est. Price', align: 'right', render: (d) => fmtUsdCompact(d.estPrice), sortValue: (d) => d.estPrice ?? 0 },
    { key: 'cap', header: 'Cap', align: 'right', render: (d) => (d.capRate !== null ? fmtPct(d.capRate, 2) : '—'), sortValue: (d) => d.capRate ?? 0 },
    { key: 'em', header: 'EM', align: 'right', render: (d) => (d.equityMultiple !== null ? fmtMultiple(d.equityMultiple) : '—'), sortValue: (d) => d.equityMultiple ?? 0 },
    { key: 'next', header: 'Next Action', render: (d) => <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{d.nextAction ?? '—'}</span>, sortValue: (d) => d.nextAction ?? '' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber" dot>Seed pipeline — HubSpot / Notion sync pending</Badge>
        <span className="num text-2xs uppercase" style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
          from firm memory
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Active Deals" value={active.length} format={fmtNum} accentColor="var(--accent)" sublabel={`${deals.length} total`} />
        <KpiStat label="Closing Now" value={deals.filter((d) => d.stage === 'Closing').length} format={fmtNum} accentColor="var(--color-neg)" />
        <KpiStat label="Best Active Cap" value={bestCap === 0 ? null : bestCap * 100} format={(n) => (n === null ? '—' : `${n.toFixed(2)}%`)} accentColor="var(--color-pos)" />
        <KpiStat label="Pipeline SF" value={pipelineSf} format={fmtSf} accentColor="var(--color-info)" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader title="Pipeline by Stage" />
          <div className="p-3">
            <BarList items={stageCounts.map((s) => ({ label: s.label, value: s.value, display: String(s.value) }))} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Active Deals" trailing={<Badge tone="gold">{deals.length} deals</Badge>} />
          <DataTable columns={cols} rows={deals} getRowId={(d) => d.id} onRowClick={(d) => ui.openEntity({ type: 'deal', id: d.id })} initialSort={{ key: 'stage', dir: 'asc' }} />
        </Card>
      </div>

      <Card>
        <CardHeader title="Acquisition Workbench" trailing={<Badge tone="gold">Oxford Acquisition Score · live</Badge>} />
        <div className="flex items-center gap-2 px-3 pt-3">
          <span className="text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>Prefill from</span>
          <select
            className="rounded-[var(--radius-sm)] px-2 py-1 text-xs num"
            style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
            value={scoreDealId}
            onChange={(e) => setScoreDealId(e.target.value)}
          >
            <option value="">— blank deal —</option>
            {deals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="p-3">
          <AcquisitionWorkbench deal={scoreDeal} />
        </div>
      </Card>
    </div>
  );
}
