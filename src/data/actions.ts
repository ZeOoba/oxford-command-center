import type { DealStage, RenewalStage } from '@contracts/index';

/**
 * Write-back actions (Phase 5). These POST to the Brain Server, which persists to the local
 * overlay (the workbook stays read-only). They are only available in live mode; the deployed
 * mirror has no server. The server emits an SSE `snapshot` event on success, so the snapshot
 * query refetches automatically — callers may also invalidate for immediacy.
 */
async function postAction(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Action failed (${res.status})`);
}

export const advanceDealStage = (dealId: string, stage: DealStage): Promise<void> =>
  postAction('/api/actions/deal-stage', { dealId, stage });

export const advanceRenewalStage = (leaseId: string, stage: RenewalStage): Promise<void> =>
  postAction('/api/actions/renewal-stage', { leaseId, stage });

export interface NewTask {
  label: string;
  section?: string;
  type?: string;
  dueDay?: string;
  notes?: string;
}
export const createTask = (task: NewTask): Promise<void> => postAction('/api/actions/task', task);
