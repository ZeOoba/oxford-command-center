// src/modules/intel/LeaseRunView.tsx
//
// The "Lease Run" intelligence tab (PFI Lease-Run Pro Forma). Forward contractual NOI for one
// property from its lease terms + overlay-overridable assumptions: a projection table (contractual
// rows solid, assumption/option rows flagged), an NOI trajectory chart with rollover markers, a
// below-market "rollover upside" chip, an editable assumptions panel (confirm-before-write), and a
// diligence-notes callout. Reconciled to the v1.0 Excel models to the dollar by the engine.
//
// Browser-verified (not jsdom-rendered) like PropertyIntelView — the testable logic lives in the
// pure helpers (lease-run-view.ts). Every null is guarded; an unavailable warehouse → offline Card;
// a property with no lease terms → an informational empty state, never a crash. No raw hex — theme
// tokens / ORA Style Guide only.
import { useMemo, useState } from 'react';
import { FileWarning, TrendingDown } from 'lucide-react';
import { fmtUsd, fmtUsdCompact, fmtPct } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { DataTable, type Column } from '@/primitives/DataTable';
import { AreaChart } from '@/charts/AreaChart';
import { isWarehouseUnavailable } from './hooks';
import { useSetLeaseRunAssumptions, useWarehouseLive, type LeaseRunAssumptionsPatch } from './hooks';
import { useLeaseRun, type LeaseRunPeriod } from './analytics-hooks';
import {
  assumptionRows,
  assumptionYearCount,
  markToMarketChip,
  noiChartPoints,
  rolloverLabels,
  statusLabel,
} from './lease-run-view';

interface Props {
  /** The property to project. Null until a property is selected upstream. */
  propertyId: string | null;
}

const ASSUMPTION_TONE = 'gold' as const;

export function LeaseRunView({ propertyId }: Props) {
  const query = useLeaseRun(propertyId);
  const unavailable = isWarehouseUnavailable(query.error);
  const env = query.data ?? null;

  const points = useMemo(() => (env ? noiChartPoints(env.periods) : []), [env]);
  const rollovers = useMemo(() => (env ? new Set(rolloverLabels(env.periods)) : new Set<string>()), [env]);
  const chip = useMemo(() => markToMarketChip(env?.markToMarket ?? null), [env]);

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton style={{ height: 56 }} />
        <Skeleton style={{ height: 240 }} />
      </div>
    );
  }

  if (unavailable) {
    return (
      <Card>
        <CardHeader title="Lease Run" />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
          The financial warehouse is offline. Lease-run projections are served by the brain server.
        </div>
      </Card>
    );
  }

  if (!env || env.isEmpty || !propertyId) {
    return (
      <Card>
        <CardHeader title="Lease Run" />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
          No abstracted lease terms for this property yet. Lease-run pro formas are available for
          properties with a seeded or ingested lease abstract.
        </div>
      </Card>
    );
  }

  const assumptionCount = assumptionYearCount(env.periods);

  return (
    <div className="flex flex-col gap-4">
      {/* Verdict header: stabilized economics + the mark-to-market chip. */}
      <Card>
        <CardHeader
          title={`Lease Run — ${env.tenant ?? propertyId}`}
          trailing={
            chip.show ? (
              <Badge tone={chip.tone}>
                <TrendingDown size={12} style={{ marginRight: 4 }} />
                {chip.label}
              </Badge>
            ) : (
              <Badge tone="neutral">NNN — net to landlord</Badge>
            )
          }
        />
        <div className="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-4">
          <KpiStat
            label={`Stabilized NOI${env.stabilizedYearLabel ? ` (${env.stabilizedYearLabel})` : ''}`}
            value={env.stabilizedNoi}
            format={(n) => fmtUsd(n)}
          />
          <KpiStat label="Indicative value" value={env.indicativeValue} format={(n) => fmtUsdCompact(n)} />
          <KpiStat label="Indicative $/SF" value={env.indicativeValuePsf} format={(n) => fmtUsd(n, true)} />
          <KpiStat
            label="Assumption years"
            value={assumptionCount}
            format={(n) => (n === null ? '—' : String(n))}
            sublabel={assumptionCount > 0 ? 'option rows modeled, not contracted' : 'all contractual'}
          />
        </div>
        {chip.detail ? (
          <div className="px-4 pb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {chip.detail}
          </div>
        ) : null}
      </Card>

      {/* NOI trajectory with rollover markers. */}
      <Card>
        <CardHeader title="Forward NOI trajectory" />
        <div className="px-2 py-2">
          <AreaChart
            data={points.map((p) => ({ date: p.label, value: p.value }))}
            valueFormat={(n) => fmtUsdCompact(n)}
            ariaLabel="Forward NOI trajectory (projected from the lease run)"
          />
          <div className="px-2 pb-2 text-2xs" style={{ color: 'var(--text-secondary)' }}>
            Rollover / option boundaries:{' '}
            {rollovers.size > 0 ? [...rollovers].join(', ') : 'none in term'} · NNN-net (recoveries
            pass-through; no reimbursement income or opex modeled).
          </div>
        </div>
      </Card>

      {/* Projection table — assumption rows flagged. */}
      <Card>
        <CardHeader
          title="Lease-run cash flow"
          trailing={
            <span className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
              dashed = assumption / unexercised option
            </span>
          }
        />
        <ProjectionTable periods={env.periods} rollovers={rollovers} />
      </Card>

      {/* Editable assumptions (confirm-before-write). */}
      <AssumptionsPanel propertyId={propertyId} env={env} />

      {/* Diligence notes. */}
      {env.diligenceNotes.length > 0 ? (
        <Card>
          <CardHeader title="Notes & diligence items" />
          <ul className="flex flex-col gap-2 px-4 py-3">
            {env.diligenceNotes.map((note, i) => (
              <li key={i} className="flex gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <FileWarning size={13} style={{ marginTop: 1, flexShrink: 0, color: 'var(--accent)' }} />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

// ── Projection table ──────────────────────────────────────────────────────────────────────
function ProjectionTable({
  periods,
  rollovers,
}: {
  periods: LeaseRunPeriod[];
  rollovers: Set<string>;
}) {
  const columns: Column<LeaseRunPeriod>[] = [
    {
      key: 'leaseYear',
      header: 'Lease year',
      render: (p) => (
        <span
          style={{
            fontStyle: p.isAssumption ? 'italic' : 'normal',
            color: rollovers.has(p.leaseYearLabel) ? 'var(--text-accent)' : undefined,
          }}
        >
          {p.leaseYearLabel}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (p) => <Badge tone={p.isAssumption ? ASSUMPTION_TONE : 'neutral'}>{statusLabel(p.status)}</Badge> },
    { key: 'baseRent', header: 'Base rent', align: 'right', render: (p) => fmtUsd(p.baseRent), sortValue: (p) => p.baseRent },
    { key: 'baseRentPsf', header: '$/SF', align: 'right', render: (p) => fmtUsd(p.baseRentPsf, true) },
    { key: 'egr', header: 'EGR', align: 'right', render: (p) => fmtUsd(p.egr) },
    { key: 'mgmt', header: 'Mgmt fee', align: 'right', render: (p) => fmtUsd(p.managementFee) },
    { key: 'reserve', header: 'Reserve', align: 'right', render: (p) => fmtUsd(p.reserve) },
    { key: 'noi', header: 'NOI', align: 'right', render: (p) => <strong>{fmtUsd(p.noi)}</strong>, sortValue: (p) => p.noi },
    { key: 'noiPsf', header: 'NOI $/SF', align: 'right', render: (p) => fmtUsd(p.noiPsf, true) },
    { key: 'yoy', header: 'YoY', align: 'right', render: (p) => fmtPct(p.noiGrowthYoY) },
  ];
  return (
    <DataTable
      columns={columns}
      rows={periods}
      getRowId={(p) => p.leaseYearLabel}
      minWidth={860}
    />
  );
}

// ── Editable assumptions (confirm-before-write) ───────────────────────────────────────────
function AssumptionsPanel({
  propertyId,
  env,
}: {
  propertyId: string;
  env: NonNullable<ReturnType<typeof useLeaseRun>['data']>;
}) {
  const rows = assumptionRows(env);
  const mutation = useSetLeaseRunAssumptions();
  // The assumption override is a server WRITE (overlay); on the baked mirror it has no edge home, so
  // values render read-only (Phase 1b).
  const live = useWarehouseLive();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');

  function startEdit(key: string, value: number) {
    setEditing(key);
    // Percent/rate fields edit as percent points for ergonomics; reserve as raw $/SF.
    const isPct = key !== 'roofStructuralReservePsf';
    setDraft(isPct ? String(value * 100) : String(value));
  }

  function commit(key: string) {
    // If the live server dropped while editing, never fire the write — close the editor read-only.
    if (!live) {
      setEditing(null);
      return;
    }
    const raw = Number(draft);
    if (!Number.isFinite(raw)) {
      setEditing(null);
      return;
    }
    const isPct = key !== 'roofStructuralReservePsf';
    const value = isPct ? raw / 100 : raw;
    mutation.mutate({ propertyId, [key]: value } as LeaseRunAssumptionsPatch);
    setEditing(null);
  }

  return (
    <Card>
      <CardHeader
        title="Assumptions"
        trailing={
          <div className="flex items-center gap-1.5">
            {!live && <Badge tone="neutral">read-only</Badge>}
            <Badge tone={env.assumptionsAreDefault ? 'neutral' : 'gold'}>
              {env.assumptionsAreDefault ? 'spec defaults' : 'overridden'}
            </Badge>
          </div>
        }
      />
      <div className="flex flex-col divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
            {editing === r.key && live ? (
              <span className="flex items-center gap-2">
                <input
                  className="num w-20 rounded border px-2 py-1 text-right text-sm"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface, transparent)' }}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(r.key);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
                <button className="text-xs font-semibold" style={{ color: 'var(--text-accent)' }} onClick={() => commit(r.key)}>
                  Confirm
                </button>
                <button className="text-xs" style={{ color: 'var(--text-secondary)' }} onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </span>
            ) : live ? (
              <button
                className="num font-semibold"
                onClick={() => startEdit(r.key, r.value)}
                title="Click to edit (confirm-before-write)"
              >
                {r.format === 'usdPsf' ? fmtUsd(r.value, true) : fmtPct(r.value)}
              </button>
            ) : (
              <span className="num font-semibold" style={{ color: 'var(--text-primary)' }}>
                {r.format === 'usdPsf' ? fmtUsd(r.value, true) : fmtPct(r.value)}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="px-4 py-2 text-2xs" style={{ color: 'var(--text-secondary)' }}>
        Management fee, reserve, vacancy, renewal growth, and cap rate are editable landlord-cost
        assumptions — not lease terms. Overrides persist to the local overlay; the workbook and
        warehouse are never written.{!live && ' Editing is a workstation-only action — this mirror is read-only.'}
      </div>
    </Card>
  );
}
