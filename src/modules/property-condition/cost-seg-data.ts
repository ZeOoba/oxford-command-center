/// <reference types="vite/client" />
// src/modules/property-condition/cost-seg-data.ts
//
// Loads the committed cost segregation dataset (data/cost-seg/cost-seg.json, 222 facts) lazily — a separate chunk that
// is only fetched when the Cost seg view opens — and validates it against the strict schema.
import { useQuery } from '@tanstack/react-query';
import { parseCostSeg, type CostSegDatasetT } from '@/analytics/cost-seg';

const loaders = import.meta.glob('../../../data/cost-seg/cost-seg.json', { import: 'default' }) as Record<string, () => Promise<unknown>>;

export async function loadCostSeg(): Promise<CostSegDatasetT> {
  const load = Object.values(loaders)[0];
  if (!load) throw new Error('cost seg: data/cost-seg/cost-seg.json is missing');
  return parseCostSeg(await load());
}

export function useCostSeg(enabled: boolean) {
  return useQuery({ queryKey: ['property-condition', 'cost-seg'], queryFn: loadCostSeg, enabled, staleTime: Infinity });
}
