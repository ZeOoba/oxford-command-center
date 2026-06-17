import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import type { Counterparty } from '@contracts/index';

const KIND_LABEL: Record<string, string> = {
  lender: 'Lender',
  carrier: 'Carrier',
  counsel: 'Counsel',
  title: 'Title / Closing',
  broker: 'Broker',
  principal: 'Principal',
  partner: 'Partner',
};
const KIND_TONE: Record<string, BadgeTone> = {
  counsel: 'purple',
  title: 'blue',
  lender: 'amber',
  carrier: 'green',
  principal: 'gold',
  broker: 'neutral',
  partner: 'neutral',
};

const linkCount = (cp: Counterparty): number =>
  cp.links.properties.length + cp.links.loans.length + cp.links.deals.length + cp.links.insurance.length;

export function RelationshipsModule() {
  const { data } = useSnapshot();
  const ui = useUi();
  if (!data) return null;
  const cps = data.snapshot.counterparties;

  const lenders = cps.filter((c) => c.kind === 'lender').length;
  const carriers = cps.filter((c) => c.kind === 'carrier').length;
  const advisors = cps.filter((c) => c.kind === 'counsel' || c.kind === 'title' || c.kind === 'broker').length;

  const cols: Column<Counterparty>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (c) => (
        <div className="max-w-[260px]">
          <div className="truncate" style={{ fontWeight: 600 }}>{c.name}</div>
          {c.role && <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{c.role}</div>}
        </div>
      ),
      sortValue: (c) => c.name,
    },
    { key: 'kind', header: 'Type', render: (c) => <Badge tone={KIND_TONE[c.kind] ?? 'neutral'}>{KIND_LABEL[c.kind] ?? c.kind}</Badge>, sortValue: (c) => c.kind },
    { key: 'firm', header: 'Firm', render: (c) => (c.firm && c.firm !== c.name ? c.firm : '—'), sortValue: (c) => c.firm ?? '' },
    { key: 'email', header: 'Contact', render: (c) => c.email ?? '—', sortValue: (c) => c.email ?? '' },
    { key: 'links', header: 'Links', align: 'right', render: (c) => fmtNum(linkCount(c)), sortValue: (c) => linkCount(c) },
    { key: 'src', header: 'Source', render: (c) => <Badge tone={c.source === 'memory' ? 'neutral' : 'gold'}>{c.source === 'memory' ? 'Memory' : 'Workbook'}</Badge>, sortValue: (c) => c.source },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Relationships" value={cps.length} format={fmtNum} accentColor="var(--accent)" />
        <KpiStat label="Lenders" value={lenders} format={fmtNum} accentColor="var(--color-warn)" />
        <KpiStat label="Advisors" value={advisors} format={fmtNum} accentColor="var(--color-accent2)" sublabel="counsel · title · broker" />
        <KpiStat label="Insurance Carriers" value={carriers} format={fmtNum} accentColor="var(--color-pos)" />
      </div>
      <Card>
        <CardHeader
          title="Counterparty Directory"
          trailing={<Badge tone="gold">{cps.length} entities</Badge>}
        />
        <DataTable
          columns={cols}
          rows={cps}
          getRowId={(c) => c.id}
          onRowClick={(c) => ui.openEntity({ type: 'counterparty', id: c.id })}
          initialSort={{ key: 'links', dir: 'desc' }}
          maxHeight={560}
        />
      </Card>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        Lenders &amp; carriers are derived live from the workbook (Loan Index, Insurance Renewals) and the
        acquisitions pipeline; counsel, title, and principals are grounded in firm memory. Select any row to
        traverse its linked deals, properties, loans, and policies.
      </p>
    </div>
  );
}
