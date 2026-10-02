// src/modules/acquisitions/EdgePullQueue.tsx
//
// Oxford Edge manual-pull queue (spec §8.6). One card per pull kind; done-state is server-side in
// edge_pull_log (append-only), replacing the retired artifact's localStorage checkboxes (the
// oe-guide-* keys are NOT imported: per-browser and unverifiable). Write controls render only when
// useWarehouseLive() is true — the same fail-safe as Sourcing status writes. Undo voids a row after
// window.confirm; nothing is ever deleted.
import { useState } from 'react';
import type { EdgePullItem, EdgePullKind, EdgePullScopeState } from '@contracts/edge';
import { Card, CardHeader } from '@/primitives/Card';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { isWarehouseUnavailable, useWarehouseLive } from '../intel/hooks';
import { localIsoToday, useEdgePullQueue, useRecordPull, useVoidPull } from './edge-hooks';

// Only the vetted source hosts the server builds links from (StorageCafe/RentCafe/Crexi/LoopNet and the
// state econ-dev newsrooms). The server owns the URLs; this is a render-time belt-and-braces filter so a
// malformed or tampered response can never produce an off-list or non-https anchor.
const VETTED_HOSTS: ReadonlySet<string> = new Set([
  'www.storagecafe.com', 'www.rentcafe.com', 'www.crexi.com', 'www.loopnet.com',
  'dced.pa.gov', 'commerce.maryland.gov', 'www.vedp.org', 'westvirginia.gov', 'www.jobsohio.com',
  'iedc.in.gov', 'www.michiganbusiness.org', 'ced.ky.gov', 'missouripartnership.com', 'www.kansascommerce.gov',
  'wedc.org', 'www.iowaeda.com', 'opportunity.nebraska.gov', 'dceo.illinois.gov', 'mn.gov',
]);

function isVettedLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && VETTED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** A message safe to render: Error text from the server's 4xx body, never a raw object or a Zod dump. */
function safeMutationMessage(error: unknown): string {
  if (!(error instanceof Error) || error.name === 'ZodError') return 'Could not save';
  const msg = error.message.trim();
  if (msg === '' || msg.startsWith('[') || msg.startsWith('{')) return 'Could not save';
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

const STATE_TONE: Record<EdgePullScopeState['state'], BadgeTone> = { open: 'red', due: 'amber', current: 'green' };
const NOTE = { color: 'var(--text-tertiary)', fontSize: '0.875rem' } as const;
const BUTTON = {
  fontSize: '0.6875rem',
  padding: '0.125rem 0.5rem',
  border: '1px solid var(--border-strong)',
  borderRadius: '0.25rem',
  background: 'var(--surface-overlay)',
  color: 'var(--text-primary)',
} as const;

interface DraftPull {
  kind: EdgePullKind;
  scopeKey: string;
  scopeLabel: string;
  doneOn: string;
  note: string;
}

function PullItemCard({
  item, live, busy, draft, onMarkDone, onUndo, onDraftChange, onSave, onCancel,
}: {
  item: EdgePullItem;
  live: boolean;
  busy: boolean;
  draft: DraftPull | null;
  onMarkDone: (s: EdgePullScopeState) => void;
  onUndo: (s: EdgePullScopeState) => void;
  onDraftChange: (d: DraftPull) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const editing = draft !== null && draft.kind === item.kind ? draft : null;
  const columns: Column<EdgePullScopeState>[] = [
    { key: 'scope', header: item.scopeType === 'market' ? 'Market' : 'State', render: (s) => s.scopeLabel },
    { key: 'status', header: 'Status', render: (s) => <Badge tone={STATE_TONE[s.state]}>{s.state}</Badge> },
    { key: 'last', header: 'Last done', render: (s) => s.lastDoneOn ?? '—' },
    { key: 'age', header: 'Age', align: 'right', render: (s) => (s.ageDays === null ? '—' : `${s.ageDays} d`) },
    {
      key: 'note',
      header: 'Note',
      render: (s) =>
        s.lastNote ? <span title={s.lastNote}>{s.lastNote.length > 48 ? `${s.lastNote.slice(0, 48)}…` : s.lastNote}</span> : '—',
    },
    {
      key: 'source',
      header: 'Source',
      render: (s) =>
        s.blocker ? (
          <span className="text-2xs" style={{ whiteSpace: 'normal', color: 'var(--text-secondary)', display: 'inline-block', maxWidth: '28rem' }}>
            {s.blocker}
          </span>
        ) : (
          <span className="flex gap-2">
            {s.links.filter((l) => isVettedLink(l.url)).map((l, i) => (
              <a key={`${l.label}-${i}`} href={l.url} target="_blank" rel="noopener noreferrer" className="text-2xs" style={{ color: 'var(--text-accent)' }}>
                {l.label}
              </a>
            ))}
          </span>
        ),
    },
    ...(live
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (s: EdgePullScopeState) => (
              <span className="flex gap-2">
                <button type="button" aria-label={`Mark ${s.scopeLabel} done`} disabled={busy} onClick={() => onMarkDone(s)} style={BUTTON}>
                  Mark done
                </button>
                {s.lastLogId !== null && (
                  <button type="button" aria-label={`Undo ${s.scopeLabel}`} disabled={busy} onClick={() => onUndo(s)} style={BUTTON}>
                    Undo
                  </button>
                )}
              </span>
            ),
          } satisfies Column<EdgePullScopeState>,
        ]
      : []),
  ];

  return (
    <Card>
      <div id={`edge-pull-${item.kind}`}>
        <CardHeader
          title={`${item.label} · ${item.cadenceLabel}`}
          trailing={
            <span className="flex gap-1.5">
              <Badge tone="red">{`${item.counts.open} open`}</Badge>
              <Badge tone="amber">{`${item.counts.due} due`}</Badge>
              <Badge tone="green">{`${item.counts.current} current`}</Badge>
            </span>
          }
        />
        <div className="flex flex-col gap-1 px-3 pt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <p><strong>Why it matters:</strong> {item.why}</p>
          <p style={{ color: 'var(--text-tertiary)' }}>{item.caveat}</p>
        </div>
        {editing && (
          <form
            className="mx-3 mt-2 flex flex-wrap items-end gap-2 rounded-[var(--radius-sm)] p-2"
            style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
          >
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{`Mark ${editing.scopeLabel} done`}</span>
            <input
              type="date"
              aria-label="Done on"
              value={editing.doneOn}
              max={localIsoToday()}
              required
              onChange={(e) => onDraftChange({ ...editing, doneOn: e.target.value })}
              style={BUTTON}
            />
            <textarea
              aria-label="Note"
              maxLength={2000}
              rows={1}
              value={editing.note}
              placeholder="Optional note (e.g. baseline $/SF)"
              onChange={(e) => onDraftChange({ ...editing, note: e.target.value })}
              style={{ ...BUTTON, minWidth: '16rem' }}
            />
            {editing.doneOn > localIsoToday() && (
              <span id={`edge-pull-date-hint-${item.kind}`} role="alert" className="text-2xs" style={{ color: 'var(--text-neg)' }}>
                The done date cannot be in the future.
              </span>
            )}
            <button type="submit" disabled={busy || editing.doneOn === '' || editing.doneOn > localIsoToday()} style={BUTTON}>Save</button>
            <button type="button" onClick={onCancel} style={BUTTON}>Cancel</button>
          </form>
        )}
        <div className="p-3">
          <DataTable columns={columns} rows={item.scopes} getRowId={(s) => s.scopeKey} />
        </div>
      </div>
    </Card>
  );
}

export function EdgePullQueue() {
  const { data, isLoading, error } = useEdgePullQueue();
  const live = useWarehouseLive();
  const record = useRecordPull();
  const voidPull = useVoidPull();
  const [draft, setDraft] = useState<DraftPull | null>(null);

  if (isLoading) {
    return (
      <div aria-busy="true" aria-live="polite" aria-label="Loading manual pull queue">
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Manual pull queue" />
        <p className="p-3" style={NOTE}>Warehouse offline — pull status unavailable</p>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <CardHeader title="Manual pull queue" />
        <p role="alert" className="p-3" style={NOTE}>Unable to load the pull queue. Try again shortly.</p>
      </Card>
    );
  }

  const undo = (scope: EdgePullScopeState) => {
    if (scope.lastLogId === null) return;
    if (!window.confirm(`Undo the ${scope.lastDoneOn ?? ''} pull for ${scope.scopeLabel}? The log row is kept and marked void.`)) return;
    record.reset();
    voidPull.mutate(scope.lastLogId);
  };
  const save = () => {
    // The Enter key submits the form even while Save is disabled-by-pending: guard here too.
    if (!draft || record.isPending || voidPull.isPending) return;
    const note = draft.note.trim();
    voidPull.reset();
    record.mutate(
      { kind: draft.kind, scopeKey: draft.scopeKey, doneOn: draft.doneOn, ...(note ? { note } : {}) },
      { onSuccess: () => setDraft(null) },
    );
  };
  const mutationError = record.error ?? voidPull.error;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.14em', color: 'var(--text-secondary)' }}>
        Manual pull queue
      </h3>
      {data.automatedCoverage.truck.length > 0 && (
        <p className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          {`Truck AADT automated (not queued): ${data.automatedCoverage.truck.join(', ')}`}
        </p>
      )}
      {mutationError && (
        <p role="alert" className="text-xs" style={{ color: 'var(--text-neg)' }}>{safeMutationMessage(mutationError)}</p>
      )}
      {data.items.length === 0 && <p style={NOTE}>No manual pulls are queued.</p>}
      {data.items.map((item) => (
        <PullItemCard
          key={item.kind}
          item={item}
          live={live}
          busy={record.isPending || voidPull.isPending}
          draft={draft}
          onMarkDone={(s) => {
            record.reset();
            voidPull.reset();
            setDraft({ kind: item.kind, scopeKey: s.scopeKey, scopeLabel: s.scopeLabel, doneOn: localIsoToday(), note: '' });
          }}
          onUndo={undo}
          onDraftChange={setDraft}
          onSave={save}
          onCancel={() => {
            setDraft(null);
            record.reset();
            voidPull.reset();
          }}
        />
      ))}
    </section>
  );
}
