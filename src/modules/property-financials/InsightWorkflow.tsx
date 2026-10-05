// src/modules/property-financials/InsightWorkflow.tsx
//
// One review item with its workflow controls (owner, due date, status; a dismissal requires a
// reason), bound to PUT /api/warehouse/property-financials/insight-status/:id. The dataset's
// insights are read-only source data; only this workflow state is written, and only by the server's
// status store. Validation mirrors the server schema (insight-workflow.ts) so errors show before send.
import { useId, useState, type FormEvent } from 'react';
import type { PfEntityId, PfInsight } from '@contracts/property-financials';
import { usd } from '@analytics/property-financials/format';
import { SeverityPill } from './components';
import { useSaveInsightStatus } from './hooks';
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
  /** False when the status store could not be read: controls are disabled, the item still shows. */
  readonly workflowAvailable: boolean;
  readonly onOpenProperty: (entity: PfEntityId) => void;
}

export function InsightRow({ insight, record, workflowAvailable, onOpenProperty }: InsightRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<InsightStatusDraft>(() => draftFromRecord(record));
  const [errors, setErrors] = useState<InsightStatusErrors>({});
  const save = useSaveInsightStatus();
  const formId = useId();
  const entity = entityForInsight(insight);
  const v = insight.annual_impact_usd;
  const tone = impactTone(insight);
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

  return (
    <div className="pf-act" data-insight={insight.id}>
      <span className={`pf-amt pf-${tone}`}>{v === null ? 'verify' : usd(v, 'k')}</span>
      <div className="pf-act-t">
        <b>{insight.title}</b>
        <span>
          {insight.property} · {insight.type}
        </span>
        <div className="pf-act-meta">
          <SeverityPill severity={insight.severity} />
          <span className="pf-status" data-status={status}>
            {STATUS_LABEL[status]}
          </span>
          {record?.owner && <span>Owner: {record.owner}</span>}
          {record?.dueDate && <span>Due {record.dueDate}</span>}
          {record?.status === 'dismissed' && record.dismissReason && <span>Reason: {record.dismissReason}</span>}
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
            title={workflowAvailable ? undefined : 'Status store unavailable: needs the local Brain Server'}
            onClick={() => (editing ? setEditing(false) : open())}
          >
            {editing ? 'Close' : 'Update status'}
          </button>
        </div>
      </div>
      {editing && (
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
      )}
    </div>
  );
}
