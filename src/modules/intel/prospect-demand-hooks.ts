// src/modules/intel/prospect-demand-hooks.ts
//
// Direction 3 — TanStack Query hooks + a manual-entry mutation for the Prospect Demand
// Intelligence panel. Consumes:
//   GET  /api/warehouse/prospect-demand → ProspectDemandReport
//   POST /api/warehouse/prospect-demand → ProspectDemandEvent (201)
//
// Error policy mirrors the leasing/intel hooks: 503 / non-JSON (static mirror) →
// WarehouseUnavailableError → the module degrades gracefully.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from './hooks';
import { ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';
import {
  ProspectDemandReport,
  ProspectDemandEvent,
  type ProspectDemandEventInput,
} from '@contracts/prospect-demand';

export const PROSPECT_DEMAND_KEYS = {
  report: ['warehouse', 'prospect-demand'] as const,
};

/** Per-property demand report. Degrades gracefully on the static mirror. */
export function useProspectDemand() {
  return useQuery({
    queryKey: PROSPECT_DEMAND_KEYS.report,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/prospect-demand', ProspectDemandReport),
    ...QUERY_OPTS,
  });
}

/** Log one prospect demand event (manual entry). Returns the created, Zod-validated event. */
export async function addProspectEvent(
  input: ProspectDemandEventInput,
): Promise<ProspectDemandEvent> {
  const res = await fetch('/api/warehouse/prospect-demand', {
    method: 'POST',
    headers: ORA_JSON_MUTATION_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to log demand event (${res.status})`);
  return ProspectDemandEvent.parse(await res.json());
}
