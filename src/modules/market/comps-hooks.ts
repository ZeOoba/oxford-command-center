// src/modules/market/comps-hooks.ts
//
// IMPLEMENTATION_PLAN.md task 7.3 — Comps surface: CapRateBenchmark data for the Market
// module's Comps tab.
//
// IMPORTANT — this is NOT a second fetch. It targets the exact same endpoint, Zod contract, and
// TanStack Query key as the `useCapitalAllocationReport()` hook already declared LOCALLY inside
// src/modules/capital/CapitalModule.tsx (GET /api/warehouse/capital-allocation →
// CapitalAllocationReport, queryKey ['warehouse', 'capital-allocation', 'report'] — see
// CapitalModule.tsx and tests/unit/capital-module.test.tsx, which seeds that exact key). That
// hook is module-private (not exported), so it cannot be imported here directly, and exporting
// it is out of this agent's file scope (src/modules/capital/** belongs to a different module
// directory). Declaring an identical hook — same queryKey, same fetch, same schema — means
// TanStack Query dedupes the network call and both modules read the SAME cached response object.
// "Matches capital module figures" holds by construction, not by a parallel computation.
//
// SCOPE NOTE (read before extending): CapitalAllocationReport.marketBenchmarks only echoes
// { available, source, asOf } — the full per-(market, propertyType) CapRateBenchmark array
// (capRateP25/P50/P75) produced by server/macro/market-benchmarks.ts's getMacroMarketBenchmarks()
// is consumed purely server-side by buildCapitalAllocationReport() and is NEVER serialized to any
// HTTP route in this codebase today. There is no existing frontend hook — in the Market module,
// the Capital module, or anywhere else — that receives the raw p25/p50/p75 bands. This hook is
// the closest faithful reuse available without adding a new server route or field, which would be
// out of the UX Agent's file scope (server/** requires the Analytics/Integration/Architect roles).
// The Comps tab therefore renders the provenance badge (available/source/asOf) plus the granular
// per-property diagnostics (impliedCapRate/capRateGap/capRatePercentile) that ARE on the wire —
// see CompsView.tsx's BenchmarkSection for the rendering and the doc comment explaining why it
// stops short of a literal market×propertyType P25/P50/P75 grid.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { CapitalAllocationReport } from '@contracts/capital-allocation';
import type { CapitalAllocationEntry } from '@contracts/capital-allocation';

export type { CapitalAllocationEntry };

/** Identical to CapitalModule's local queryKey — see file header. Do not change without checking
 *  tests/unit/capital-module.test.tsx, which asserts this exact key. */
export const CAPITAL_ALLOCATION_REPORT_KEY = ['warehouse', 'capital-allocation', 'report'] as const;

/** Cap-rate benchmark provenance + per-property market positioning diagnostics. */
export function useCapitalAllocationReport() {
  return useQuery({
    queryKey: CAPITAL_ALLOCATION_REPORT_KEY,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/capital-allocation', CapitalAllocationReport),
    ...QUERY_OPTS,
  });
}
