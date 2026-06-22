// src/modules/market/hooks.ts
//
// Phase 5 W3 — TanStack Query hook for Market Intelligence UI.
//
// Consumes GET /api/warehouse/capital/market → MarketIntelResponse.
// Error policy mirrors debt/hooks.ts: 503/non-JSON → graceful empty state.
import { useQuery } from '@tanstack/react-query';
import { fetchParsedOrMirror, QUERY_OPTS } from '../intel/hooks';
import { MarketIntelResponse } from '@contracts/capital';
import type { MarketSignal, MarketAction } from '@contracts/capital';

export type { MarketSignal, MarketAction };

export const MARKET_INTEL_KEYS = {
  signals: ['warehouse', 'market', 'intel'] as const,
};

/** Per-cluster market intelligence signals. */
export function useMarketIntel() {
  return useQuery({
    queryKey: MARKET_INTEL_KEYS.signals,
    queryFn: () => fetchParsedOrMirror('/api/warehouse/capital/market', MarketIntelResponse).then((r) => r.signals),
    ...QUERY_OPTS,
  });
}

// ── Pure display helpers ──────────────────────────────────────────────────────

export function marketActionLabel(action: MarketAction): string {
  switch (action) {
    case 'enter':    return 'Enter';
    case 'expand':   return 'Expand';
    case 'maintain': return 'Maintain';
    case 'exit':     return 'Exit';
  }
}

export function marketActionTone(action: MarketAction): 'green' | 'neutral' | 'amber' | 'red' {
  switch (action) {
    case 'enter':    return 'green';
    case 'expand':   return 'green';
    case 'maintain': return 'neutral';
    case 'exit':     return 'red';
  }
}
