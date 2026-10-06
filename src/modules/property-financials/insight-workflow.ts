// src/modules/property-financials/insight-workflow.ts
//
// Form rules for an insight's workflow state (owner, due date, status, dismissal reason), mirroring
// the server's PUT schema in server/property-financials/status-store.ts so the user sees the problem
// before the request is sent. The server stays the authority; parity is pinned in
// tests/unit/property-financials-insight-workflow.test.ts. Pure TypeScript.
import type { PfInsightStatus, PfInsightStatusBody, PfInsightStatusRecord } from './types';

export const PF_INSIGHT_STATUSES = ['open', 'in_progress', 'resolved', 'dismissed'] as const satisfies readonly PfInsightStatus[];

export const STATUS_LABEL: Readonly<Record<PfInsightStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

/** Same limits as the server schema. */
export const OWNER_MAX = 80;
export const REASON_MAX = 500;

/** What the form holds: raw strings, '' = not set. */
export interface InsightStatusDraft {
  owner: string;
  dueDate: string;
  status: PfInsightStatus;
  dismissReason: string;
}

export type InsightStatusErrors = Partial<Record<'owner' | 'dueDate' | 'dismissReason', string>>;

export type DraftValidation = { ok: true; body: PfInsightStatusBody } | { ok: false; errors: InsightStatusErrors };

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateInsightStatusDraft(draft: InsightStatusDraft): DraftValidation {
  const errors: InsightStatusErrors = {};
  const owner = draft.owner.trim();
  const due = draft.dueDate.trim();
  const reason = draft.dismissReason.trim();
  if (owner.length > OWNER_MAX) errors.owner = `Owner must be ${OWNER_MAX} characters or fewer.`;
  if (due !== '' && !isRealDate(due)) errors.dueDate = 'Enter a real date (YYYY-MM-DD).';
  if (draft.status === 'dismissed') {
    if (reason === '') errors.dismissReason = 'A reason is required to dismiss an item.';
    else if (reason.length > REASON_MAX) errors.dismissReason = `Reason must be ${REASON_MAX} characters or fewer.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      owner: owner === '' ? null : owner,
      dueDate: due === '' ? null : due,
      status: draft.status,
      // The server refuses a reason on any other status; a leftover reason is dropped, not sent.
      dismissReason: draft.status === 'dismissed' ? reason : null,
    },
  };
}

export function draftFromRecord(rec: PfInsightStatusRecord | undefined): InsightStatusDraft {
  return {
    owner: rec?.owner ?? '',
    dueDate: rec?.dueDate ?? '',
    status: rec?.status ?? 'open',
    dismissReason: rec?.dismissReason ?? '',
  };
}
