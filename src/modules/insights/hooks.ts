// src/modules/insights/hooks.ts
//
// TanStack Query hook for the Insights module. Consumes GET /api/warehouse/insights
// (server/warehouse/insights-api.ts), which returns an InsightReport envelope (candidates +
// dataReadiness + generatedAt + advisoryOnly). Follows the exact fetchParsedOrMirror +
// QUERY_OPTS pattern used by src/modules/debt/hooks.ts: Zod-parses the live route, falls back
// to the baked Fat-Mirror payload when the warehouse is unavailable (static mirror / 503), and
// degrades gracefully — never throws for "no warehouse here", only for a genuinely malformed
// response from a route that IS present.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { InsightReportSchema } from '@contracts/insights';
import type { InsightReport } from '@contracts/insights';

export type { InsightReport };

export const INSIGHTS_KEYS = {
  report: ['warehouse', 'insights'] as const,
};

/**
 * The full Insight Engine report (candidates + dataReadiness). Degrades gracefully on the
 * static mirror (WarehouseUnavailableError → module renders Spine-A-only insights).
 */
export function useWarehouseInsights() {
  return useQuery({
    queryKey: INSIGHTS_KEYS.report,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/insights', InsightReportSchema),
    ...QUERY_OPTS,
  });
}
