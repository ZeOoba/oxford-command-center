// src/modules/property-financials/InsightWorkflow.tsx
//
// Review items with their workflow controls (owner, due date, status; a dismissal requires a
// reason), bound to PUT /api/warehouse/property-financials/insight-status/:id. The dataset's
// insights are read-only source data; only this workflow state is written, and only by the server's
// status store. Validation mirrors the server schema (insight-workflow.ts) so errors show before send.
//
// Two layouts share ONE set of controls (useInsightWorkflow): the compact InsightRow (Overview "Where
// the money is") and the full InsightCard (Levers / Watchlist; the reference artifact's item()). The
// stored record is keyed by insight id, so an item that appears in several views shows the same
// owner / due date / status in each.
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { PfEntityId, PfInsight } from '@contracts/property-financials';
import { usd } from '@analytics/property-financials/format';
import { SeverityPill } from './components';
import { usePfInsightStatuses, useSaveInsightStatus } from './hooks';
import { entityForInsight, impactTone } from './model';
import {
  OWNER_MAX,
  PF_INSIGHT_STATUSES,
  REASON_MAX,
  STATUS_LABEL,
  draftFromRecord,
  validateInsightStatusDraft,
  type InsightStatusDraft,
  type InsightStatusErrors,
} from './insight-workflow';
import type { PfInsightStatus, PfInsightStatusRecord } from './types';

export interface InsightRowProps {
  readonly insight: PfInsight;
  readonly record: PfInsightStatusRecord | undefined;
  /**
   * False until the status store has been read (loading or failed): controls are disabled so a form
   * never opens on a blank draft that would overwrite a stored owner / due date; the item still shows.
   */
  readonly workflowAvailable: boolean;
  readonly onOpenProperty: (entity: PfEntityId) => void;
}

/** The workflow meta line (status, owner, due, links, toggle) and its edit form, for either layout. */
function useInsightWorkflow({ insight, record, workflowAvailable, onOpenProperty }: InsightRowProps, leading?: ReactNode): { meta: ReactNode; form: ReactNode } {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<InsightStatusDraft>(() => draftFromRecord(record));
  const [errors, setErrors] = useState<InsightStatusErrors>({});
  const save = useSaveInsightStatus();
  const formId = useId();
  const entity = entityForInsight(insight);
  const status: PfInsightStatus = record?.status ?? 'open';

  const open = () => {
    setDraft(draftFromRecord(record));
    setErrors({});
    save.reset();
    setEditing(true);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = validateInsightStatusDraft(draft);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    save.mutate({ id: insight.id, body: r.body }, { onSuccess: () => setEditing(false) });
  };
  const set = <K extends keyof InsightStatusDraft>(k: K, val: InsightStatusDraft[K]) => setDraft((d) => ({ ...d, [k]: val }));
  const errId = (k: keyof InsightStatusErrors) => (errors[k] ? `${formId}-${k}-err` : undefined);

  const meta = (
    <div className="pf-act-meta">
      {leading}
      <span className="pf-status" data-status={status}>
        {STATUS_LABEL[status]}
      </span>
      {record?.owner && <span>Owner: {record.owner}</span>}
      {record?.dueDate && <span>Due {record.dueDate}</span>}
      {record?.status === 'dismissed' && record.dismissReason && <span>Reason: {record.dismissReason}</span>}
      {record?.version === 'earlier' && (
        <span className="pf-neg" data-testid="pf-status-version">
          Status set against an earlier dataset version: figures restated since
        </span>
      )}
      {record?.version === 'unknown' && (
        <span className="pf-mut" data-testid="pf-status-version">
          Status set against an unknown dataset version
        </span>
      )}
      {entity && (
        <button type="button" className="pf-link" onClick={() => onOpenProperty(entity)}>
          View property
        </button>
      )}
      <button
        type="button"
        className="pf-link"
        aria-expanded={editing}
        aria-controls={editing ? formId : undefined}
        disabled={!workflowAvailable}
        title={workflowAvailable ? undefined : 'Status store not loaded: needs the local Brain Server'}
        onClick={() => (editing ? setEditing(false) : open())}
      >
        {editing ? 'Close' : 'Update status'}
      </button>
    </div>
  );

  const form = editing && (
    <form id={formId} className="pf-form" onSubmit={submit} noValidate aria-label={`Workflow for ${insight.id}`}>
      <label>
        Owner
        <input
          value={draft.owner}
          maxLength={OWNER_MAX + 20}
          onChange={(e) => set('owner', e.target.value)}
          aria-invalid={errors.owner ? true : undefined}
          aria-describedby={errId('owner')}
        />
        {errors.owner && (
          <span className="pf-err" id={errId('owner')}>
            {errors.owner}
          </span>
        )}
      </label>
      <label>
        Due date
        <input
          type="date"
          value={draft.dueDate}
          onChange={(e) => set('dueDate', e.target.value)}
          aria-invalid={errors.dueDate ? true : undefined}
          aria-describedby={errId('dueDate')}
        />
        {errors.dueDate && (
          <span className="pf-err" id={errId('dueDate')}>
            {errors.dueDate}
          </span>
        )}
      </label>
      <label>
        Status
        <select value={draft.status} onChange={(e) => set('status', e.target.value as PfInsightStatus)}>
          {PF_INSIGHT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {draft.status === 'dismissed' && (
        <label className="pf-wide">
          Reason for dismissing (required)
          <textarea
            rows={2}
            value={draft.dismissReason}
            maxLength={REASON_MAX + 20}
            required
            onChange={(e) => set('dismissReason', e.target.value)}
            aria-invalid={errors.dismissReason ? true : undefined}
            aria-describedby={errId('dismissReason')}
          />
          {errors.dismissReason && (
            <span className="pf-err" id={errId('dismissReason')}>
              {errors.dismissReason}
            </span>
          )}
        </label>
      )}
      <div className="pf-wide" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="submit" className="pf-btn" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="pf-btn ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {save.isError && (
          <span className="pf-err" role="alert">
            {save.error instanceof Error ? save.error.message : 'Save failed.'}
          </span>
        )}
      </div>
    </form>
  );
  return { meta, form };
}

/** Compact row: amount, title, property · type, then the workflow line (Overview). */
export function InsightRow(props: InsightRowProps) {
  const { insight } = props;
  const { meta, form } = useInsightWorkflow(props, <SeverityPill severity={insight.severity} />);
  const v = insight.annual_impact_usd;
  return (
    <div className="pf-act" data-insight={insight.id}>
      <span className={`pf-amt pf-${impactTone(insight)}`}>{v === null ? 'verify' : usd(v, 'k')}</span>
      <div className="pf-act-t">
        <b>{insight.title}</b>
        <span>
          {insight.property} · {insight.type}
        </span>
        {meta}
      </div>
      {form}
    </div>
  );
}

/**
 * Full card (the reference artifact's item()): severity pill (icon + label), id, type, property;
 * title; finding; "Next step" action; the annual impact with its basis, or "verify" when the dataset
 * carries no dollar estimate; then the workflow line and form.
 */
export function InsightCard(props: InsightRowProps) {
  const { insight } = props;
  const { meta, form } = useInsightWorkflow(props);
  const v = insight.annual_impact_usd;
  const headingId = `pf-item-${insight.id}`;
  return (
    <article className="pf-item" data-insight={insight.id} aria-labelledby={headingId}>
      <div className="pf-item-main">
        <div className="pf-tags">
          <SeverityPill severity={insight.severity} />
          <span>{insight.id}</span>
          <span>{insight.type}</span>
          <span>{insight.property}</span>
        </div>
        <h3 id={headingId}>{insight.title}</h3>
        <p>{insight.finding}</p>
        <p className="pf-do">
          <span className="pf-do-l">Next step</span> {insight.action}
        </p>
        {meta}
      </div>
      <div className="pf-imp" data-testid="pf-impact">
        {v === null ? (
          <>
            <strong className="pf-mut">verify</strong>
            <small>No dollar estimate</small>
          </>
        ) : (
          <>
            <strong className={`pf-${impactTone(insight)}`}>
              {v < 0 ? '-' : ''}
              {usd(Math.abs(v), 'k')}
            </strong>
            {insight.impact_basis && <small>{insight.impact_basis}</small>}
          </>
        )}
      </div>
      {form}
    </article>
  );
}

/** A list of InsightCards bound to the shared status store (one record per insight id). */
export function InsightCardList({ insights, onOpenProperty, empty }: { insights: readonly PfInsight[]; onOpenProperty: (entity: PfEntityId) => void; empty?: ReactNode }) {
  const statuses = usePfInsightStatuses();
  const byId = useMemo(() => new Map((statuses.data?.records ?? []).map((r) => [r.insightId, r])), [statuses.data]);
  return (
    <div>
      {statuses.isError && <p className="pf-note">Owner, due date and status are unavailable right now (status store unreachable).</p>}
      {insights.length === 0
        ? empty
        : insights.map((i) => <InsightCard key={i.id} insight={i} record={byId.get(i.id)} workflowAvailable={statuses.isSuccess} onOpenProperty={onOpenProperty} />)}
    </div>
  );
}
