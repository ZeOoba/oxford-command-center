import type { DealStage, RenewalStage } from '@contracts/index';
import type { CompSet } from '@contracts/index';

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

export const saveTenantNote = (tenantId: string, note: string): Promise<void> =>
  postAction('/api/actions/tenant-note', { tenantId, note });

export interface NewTask {
  label: string;
  section?: string;
  type?: string;
  dueDay?: string;
  notes?: string;
}
export const createTask = (task: NewTask): Promise<void> => postAction('/api/actions/task', task);

export const saveNoiBudget = (propertyId: string, amount: number): Promise<void> =>
  postAction('/api/actions/noi-budget', { propertyId, amount });

export const refreshDealComps = async (dealId: string): Promise<CompSet> => {
  const res = await fetch('/api/actions/deal-comps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dealId }),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; comps?: CompSet; error?: string };
  if (!res.ok || !json.ok || !json.comps) throw new Error(json.error ?? `Comps request failed (${res.status})`);
  return json.comps;
};
