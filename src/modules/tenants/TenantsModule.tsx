import { useMemo, useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { useUi } from '@/brain/ui-context';
import { saveTenantNote } from '@/data/actions';
import { fmtUsd, fmtUsdCompact, fmtNum, fmtDate } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { tenantScorecards, type TenantScorecard, pctNoiText } from '@/brain/tenants';
import type { RenewalStage } from '@contracts/index';

const STAGE_TONE: Record<RenewalStage, BadgeTone> = {
  Expiring: 'red', Outreach: 'amber', Negotiating: 'blue', LOI: 'purple', Executed: 'green',
};

function NoiBar({ pct, max, label }: { pct: number; max: number; label: string }) {
  const w = max > 0 ? Math.min(100, (pct / max) * 100) : 0;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full" style={{ background: 'var(--surface-overlay)' }}>
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: 'var(--accent)' }} />
      </div>
      <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>{label}</span>
    </div>
  );
}

export function TenantsModule() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const ui = useUi();
  const qc = useQueryClient();
  const noteMut = useMutation({
    mutationFn: (v: { tenantId: string; note: string }) => saveTenantNote(v.tenantId, v.note),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });

  const cards = useMemo(
    () => (data ? tenantScorecards(data.snapshot, new Date().toISOString().slice(0, 10)) : []),
    [data],
  );
  const maxPct = useMemo(() => Math.max(0, ...cards.map((c) => c.pctNoi)), [cards]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = cards.find((c) => c.id === selectedId) ?? null;

  if (gate) return gate;
  if (!data) return null;

  const cols: Column<TenantScorecard>[] = [
    {
      key: 'tenant', header: 'Tenant',
      render: (t) => (
        <div>
          <div style={{ fontWeight: 600 }}>{t.name}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{t.properties.length} {t.properties.length === 1 ? 'property' : 'properties'} · {t.leaseCount} {t.leaseCount === 1 ? 'lease' : 'leases'}</div>
        </div>
      ),
      sortValue: (t) => t.name,
    },
    { key: 'rent', header: 'Annual Rent', align: 'right', render: (t) => fmtUsd(t.annualRent), sortValue: (t) => t.annualRent },
    { key: 'noi', header: '% Portfolio NOI', align: 'right', render: (t) => <NoiBar pct={t.pctNoi} max={maxPct} label={pctNoiText(t)} />, sortValue: (t) => t.pctNoi },
    { key: 'sf', header: 'SF', align: 'right', render: (t) => fmtNum(t.sf), sortValue: (t) => t.sf },
    { key: 'exp', header: 'Next Expiry', align: 'right', render: (t) => fmtDate(t.nextExpiry), sortValue: (t) => t.daysToExpiry ?? 999999 },
    { key: 'stage', header: 'Renewal', render: (t) => (t.renewalStage ? <Badge tone={STAGE_TONE[t.renewalStage]}>{t.renewalStage}</Badge> : <span style={{ color: 'var(--text-tertiary)' }}>—</span>), sortValue: (t) => t.renewalStage ?? '' },
    { key: 'health', header: 'Health', align: 'right', render: () => <span style={{ color: 'var(--text-tertiary)' }}>—</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Tenant Scorecard"
          trailing={
            <div className="flex items-center gap-2">
              <Badge tone="neutral">Health pending QuickBooks</Badge>
              <Badge tone="gold">{cards.length} tenants</Badge>
            </div>
          }
        />
        <DataTable
          columns={cols}
          rows={cards}
          getRowId={(t) => t.id}
          onRowClick={(t) => setSelectedId((id) => (id === t.id ? null : t.id))}
          initialSort={{ key: 'rent', dir: 'desc' }}
          maxHeight={520}
        />
        {/* A blank workbook NOI is left out of the basis, so every share is incomplete (follow-up to audit HIGH #2). */}
        {(cards[0]?.pctNoiIncomplete.length ?? 0) > 0 && (
          <p className="num px-4 pb-3 pt-2 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            % Portfolio NOI is incomplete: blank NOI on {cards[0]!.pctNoiIncomplete.join(', ')} is left out of the basis.
          </p>
        )}
      </Card>

      {selected && <TenantDetail key={selected.id} tenant={selected} onOpenLease={(id) => ui.openEntity({ type: 'lease', id })} onDraft={(id) => ui.openDraft({ kind: 'renewal', entity: { type: 'lease', id } })} onSaveNote={(note) => noteMut.mutate({ tenantId: selected.id, note })} isSaving={noteMut.isPending} />}
    </div>
  );
}

function TenantDetail({
  tenant, onOpenLease, onDraft, onSaveNote, isSaving,
}: {
  tenant: TenantScorecard;
  onOpenLease: (leaseId: string) => void;
  onDraft: (leaseId: string) => void;
  onSaveNote: (note: string) => void;
  isSaving: boolean;
}) {
  const [note, setNote] = useState(tenant.notes);
  useEffect(() => setNote(tenant.notes), [tenant.notes]);

  return (
    <Card>
      <CardHeader title={tenant.name} trailing={<Badge tone="gold">{pctNoiText(tenant)} of portfolio NOI</Badge>} />
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-3">
        <div>
          <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>Financial Exposure</div>
          <Row label="Annual Rent" value={fmtUsd(tenant.annualRent)} />
          <Row label="% Portfolio NOI" value={pctNoiText(tenant)} />
          <Row label="Total SF" value={fmtNum(tenant.sf)} />
          <Row label="Leases" value={String(tenant.leaseCount)} />
          <Row label="Renewal Stage" value={tenant.renewalStage ?? '—'} />
          <Row label="Health" value={tenant.health ?? '— (pending QuickBooks)'} />
        </div>

        <div>
          <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>Leases</div>
          <div className="flex flex-col gap-1.5">
            {tenant.leases.map((l) => (
              <div key={l.id} className="flex items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5" style={{ background: 'var(--surface-overlay)' }}>
                <button onClick={() => onOpenLease(l.id)} className="text-left">
                  <div className="num text-2xs" style={{ fontWeight: 600 }}>{l.propertyKey} {l.unit ?? ''}</div>
                  <div className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>exp {fmtDate(l.leaseEnd)} · {fmtUsdCompact(l.annualRent)}</div>
                </button>
                <button onClick={() => onDraft(l.id)} className="flex items-center gap-1 text-2xs" style={{ color: 'var(--text-accent)' }} aria-label={`Draft renewal for ${l.propertyKey}`}>
                  <Mail size={11} /> Draft
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>Notes</div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (note !== tenant.notes) onSaveNote(note); }}
            placeholder="e.g. Eric to follow up directly…"
            aria-label={`Notes for ${tenant.name}`}
            rows={5}
            className="w-full rounded-[var(--radius-sm)] p-2 text-xs outline-none"
            style={{ background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          />
          <div className="mt-1 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{isSaving ? 'Saving…' : 'Saved on blur · requires the live Brain Server'}</div>
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="num text-xs" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
