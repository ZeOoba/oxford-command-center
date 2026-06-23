// src/modules/capital/hooks.ts
//
// Phase 5 W2 — TanStack Query hooks for the Capital Allocation UI.
//
// Consumes:
//   GET /api/warehouse/capital/allocate → CapitalAllocationResponse
//
// Error policy mirrors debt/hooks.ts:
//   - 503 / non-JSON (mirror) → WarehouseUnavailableError → graceful empty state.
//   - Real API errors surface as thrown Error.
//   - Zod validates the full response at the client boundary.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { CapitalAllocationResponse } from '@contracts/capital';
import type { AllocationVerdict, PortfolioAllocation, HurdleRateConfig } from '@contracts/capital';

export type { AllocationVerdict, PortfolioAllocation, HurdleRateConfig };

export const CAPITAL_KEYS = {
  allocation: ['warehouse', 'capital', 'allocation'] as const,
};

/** Per-property capital allocation verdicts + portfolio summary. */
export function useCapitalAllocation() {
  return useQuery({
    queryKey: CAPITAL_KEYS.allocation,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/capital/allocate', CapitalAllocationResponse),
    ...QUERY_OPTS,
  });
}

// ── Pure display helpers ──────────────────────────────────────────────────────

import type { AllocationAction } from '@contracts/capital';

export function actionLabel(action: AllocationAction): string {
  switch (action) {
    case 'buy':       return 'Buy';
    case 'hold':      return 'Hold';
    case 'sell':      return 'Sell';
    case 'refinance': return 'Refi';
    case 'improve':   return 'Improve';
  }
}

export function actionColor(action: AllocationAction): string {
  switch (action) {
    case 'buy':       return 'var(--color-emerald, #10b981)';
    case 'hold':      return 'var(--text-secondary)';
    case 'sell':      return 'var(--color-neg, #ef4444)';
    case 'refinance': return 'var(--color-warn, #f59e0b)';
    case 'improve':   return 'var(--color-info, #6366f1)';
  }
}

import type { RiskBand } from '@contracts/capital';

export function riskBandTone(band: RiskBand): 'green' | 'amber' | 'red' | 'neutral' {
  switch (band) {
    case 'low':      return 'green';
    case 'moderate': return 'neutral';
    case 'elevated': return 'amber';
    case 'high':     return 'red';
  }
}
