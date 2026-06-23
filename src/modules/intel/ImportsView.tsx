// src/modules/intel/ImportsView.tsx
//
// The import audit trail + review queue. A DataTable of every import (status Badge) →
// row click opens an inline detail panel: the classified ledger rows, any DQ issues, and
// (for a pending-review batch) Approve / Reject. Approve can come back 409 with the list
// of still-unmapped accounts — we surface a per-account "Add mapping" inline form that
// posts a manual override (useAddMapping) and then retries the approve automatically.
import { useState, useMemo } from 'react';
import { fmtUsd, fmtDate } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { DataTable, type Column } from '@/primitives/DataTable';
import {
  useImportDetail,
  useImportAction,
  useAddMapping,
  type ImportSummary,
  type LedgerRowView,
  type ApproveResult,
  type SimpleResult,
} from './hooks';
import { NORMALIZED_CATEGORIES, CLASSIFICATIONS, statusTone, severityTone } from './constants';
import type { Classification } from '@contracts/warehouse';

export function ImportsView({ imports }: { imports: ImportSummary[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const cols = useMemo((): Column<ImportSummary>[] => [
    {
      key: 'fileName',
      header: 'File',
      render: (r) => <span style={{ fontWeight: 600 }}>{r.fileName}</span>,
      sortValue: (r) => r.fileName,
    },
    { key: 'propertyName', header: 'Property', render: (r) => r.propertyName ?? dash(r.propertyId), sortValue: (r) => r.propertyName ?? '' },
    { key: 'period', header: 'Period', render: (r) => r.period ?? '—', sortValue: (r) => r.periodStart ?? '' },
    { key: 'version', header: 'Ver', align: 'right', render: (r) => `v${r.version}`, sortValue: (r) => r.version },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>, sortValue: (r) => r.status },
    { key: 'importedAt', header: 'Imported', align: 'right', render: (r) => fmtDate(r.importedAt), sortValue: (r) => r.importedAt },
  ], []);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Import Audit Trail" trailing={<Badge tone="gold">{imports.length} imports</Badge>} />
        <DataTable
          columns={cols}
          rows={imports}
          getRowId={(r) => String(r.id)}
          onRowClick={(r) => setSelectedId((id) => (id === r.id ? null : r.id))}
          initialSort={{ key: 'importedAt', dir: 'desc' }}
        />
      </Card>
      {selectedId !== null && <ImportDetailPanel id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function ImportDetailPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useImportDetail(id);
  const action = useImportAction();
  const [unmapped, setUnmapped] = useState<string[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (detail.isLoading) {
    return (
      <Card>
        <div className="px-4 py-8 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>Loading import detail…</div>
      </Card>
    );
  }
  if (!detail.data) {
    return (
      <Card>
        <div className="px-4 py-8 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>Import not found.</div>
      </Card>
    );
  }

  const d = detail.data;
  const isPending = d.status === 'pending-review';

  const runApprove = () => {
    setActionError(null);
    action.mutate(
      { id, action: 'approve' },
      {
        onSuccess: (res) => {
          const r = res as ApproveResult;
          if (r.ok) {
            setUnmapped(null);
          } else {
            setUnmapped(r.unmapped);
            if (r.unmapped.length === 0 && r.error) setActionError(r.error);
          }
        },
        onError: (e) => setActionError(e instanceof Error ? e.message : 'Approve failed'),
      },
    );
  };

  const runReject = () => {
    setActionError(null);
    action.mutate(
      { id, action: 'reject' },
      {
        onSuccess: (res) => {
          const r = res as SimpleResult;
          if (!r.ok) setActionError(r.error ?? 'Reject failed');
        },
        onError: (e) => setActionError(e instanceof Error ? e.message : 'Reject failed'),
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title={`${d.fileName} — ${d.status}`}
        trailing={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{d.basis}</Badge>
            <Badge tone="neutral">{d.sourceSystem}</Badge>
            <Button size="sm" variant="ghost" onPress={onClose} aria-label="Close detail">Close</Button>
          </div>
        }
      />
      <div className="flex flex-col gap-4 p-4">
        {/* Ledger rows */}
        <LedgerTable rows={d.rows} />

        {/* DQ issues for this import */}
        {d.issues.length > 0 && (
          <div>
            <SectionLabel>Data-quality issues</SectionLabel>
            <div className="flex flex-col gap-1">
              {d.issues.map((i) => (
                <div key={i.id} className="flex items-center gap-2 py-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <span className="num text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>{i.kind}</span>
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{i.detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Review actions */}
        {isPending && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onPress={runApprove} isDisabled={action.isPending}>Approve</Button>
              <Button variant="subtle" size="sm" onPress={runReject} isDisabled={action.isPending}>Reject</Button>
              {action.isPending && <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Working…</span>}
            </div>
            {actionError && <span className="text-2xs" style={{ color: 'var(--color-neg)' }}>{actionError}</span>}
            {unmapped && unmapped.length > 0 && (
              <UnmappedResolver
                accounts={unmapped}
                propertyId={d.propertyId}
                onAllMapped={runApprove}
              />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function LedgerTable({ rows }: { rows: LedgerRowView[] }) {
  return (
    <div>
      <SectionLabel>Ledger rows</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse" style={{ minWidth: 560 }}>
          <thead>
            <tr>
              {['Account', 'GL', 'Category', 'Class', 'Amount', ''].map((h, i) => (
                <th key={h} className="num px-3 py-2 text-2xs font-semibold uppercase"
                  style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', textAlign: i === 4 ? 'right' : 'left', borderBottom: '1px solid var(--border-strong)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={`${r.rawAccount}-${idx}`} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td className="px-3 py-1.5 text-xs" style={{ color: 'var(--text-primary)' }}>{r.rawAccount}</td>
                <td className="num px-3 py-1.5 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{r.glCode ?? '—'}</td>
                <td className="px-3 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{r.normalizedCategory}</td>
                <td className="px-3 py-1.5"><Badge tone="neutral">{r.classification}</Badge></td>
                <td className="num px-3 py-1.5 text-right text-xs" style={{ color: 'var(--text-primary)' }}>{fmtUsd(r.amount)}</td>
                <td className="px-3 py-1.5">{!r.isActive && <Badge tone="neutral">inactive</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Per-account "Add mapping" forms shown when approve returns a 409 unmapped list.
 *  Once every listed account has been mapped, calls back to retry the approve. */
function UnmappedResolver({ accounts, propertyId, onAllMapped }: { accounts: string[]; propertyId: string | null; onAllMapped: () => void }) {
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const remaining = accounts.filter((a) => !resolved.has(a));

  const markResolved = (account: string) => {
    setResolved((prev) => {
      const next = new Set(prev);
      next.add(account);
      if (accounts.every((a) => next.has(a))) onAllMapped();
      return next;
    });
  };

  return (
    <div className="rounded-[var(--radius-sm)] p-3" style={{ background: 'var(--color-warn-soft)', border: '1px solid color-mix(in oklab, var(--color-warn) 40%, transparent)' }}>
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="amber">approval blocked</Badge>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {remaining.length} unmapped account{remaining.length === 1 ? '' : 's'} — add a mapping for each, then approval retries automatically.
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {accounts.map((account) => (
          <AddMappingRow key={account} account={account} propertyId={propertyId} done={resolved.has(account)} onResolved={() => markResolved(account)} />
        ))}
      </div>
    </div>
  );
}

function AddMappingRow({ account, propertyId, done, onResolved }: { account: string; propertyId: string | null; done: boolean; onResolved: () => void }) {
  const addMapping = useAddMapping();
  const [category, setCategory] = useState<string>('Repairs & Maintenance');
  const [classification, setClassification] = useState<Classification>('opex');
  const [scoped, setScoped] = useState(false);

  if (done) {
    return (
      <div className="flex items-center gap-2 py-1">
        <Badge tone="green" dot>mapped</Badge>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{account}</span>
      </div>
    );
  }

  const submit = () => {
    addMapping.mutate(
      { account, normalizedCategory: category, classification, ...(scoped && propertyId ? { propertyId } : {}) },
      { onSuccess: onResolved },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)', minWidth: 160 }}>{account}</span>
      <CategorySelect value={category} onChange={setCategory} />
      <ClassificationSelect value={classification} onChange={setClassification} />
      {propertyId && (
        <label className="flex items-center gap-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
          this property only
        </label>
      )}
      <Button size="sm" variant="subtle" onPress={submit} isDisabled={addMapping.isPending}>Add mapping</Button>
      {addMapping.isError && <span className="text-2xs" style={{ color: 'var(--color-neg)' }}>failed</span>}
    </div>
  );
}

const selectStyle = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
} as const;

export function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Normalized category"
      className="h-7 rounded-[var(--radius-sm)] px-2 text-xs outline-none" style={selectStyle}>
      {NORMALIZED_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

export function ClassificationSelect({ value, onChange }: { value: Classification; onChange: (v: Classification) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Classification)} aria-label="Classification"
      className="h-7 rounded-[var(--radius-sm)] px-2 text-xs outline-none" style={selectStyle}>
      {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>{children}</div>
  );
}

function dash(text: string | null) {
  return text ?? '—';
}
