// src/shell/filter-slice.ts
//
// The global portfolio filter bar's "N of M assets · $X.XM workbook NOI" readout. Pure so it is
// unit-tested. A matched row whose workbook NOI cell is blank (parse flag) is summed as $0, so the
// readout says the sum is incomplete — no bound direction, a blank NOI may be negative (follow-up to
// audit 2026-11-12 HIGH #2).
import type { Property } from '@contracts/index';
import { incompleteGovernorRows } from '@analytics/governor-inputs';

export interface FilterSlice {
  shown: number;
  total: number;
  noiUsd?: number;
  /** Matched rows whose blank NOI is left out of `noiUsd` (id order). */
  noiBlank?: string[];
}

export function buildFilterSlice(properties: readonly Property[], matched: readonly Property[]): FilterSlice | undefined {
  if (properties.length === 0) return undefined;
  const blank = incompleteGovernorRows(matched, ['noi']).map((r) => r.name);
  return {
    shown: matched.length,
    total: properties.length,
    noiUsd: matched.reduce((sum, p) => sum + p.noi, 0),
    ...(blank.length > 0 ? { noiBlank: blank } : {}),
  };
}

/** The bar is space-limited: name this many blank rows, count the rest (sweep review L2). */
const MAX_NAMED_BLANK = 2;

export function filterSliceText(slice: FilterSlice): string {
  const blank = slice.noiBlank ?? [];
  const named = blank.slice(0, MAX_NAMED_BLANK).join(', ') + (blank.length > MAX_NAMED_BLANK ? `, +${blank.length - MAX_NAMED_BLANK} more` : '');
  const noi =
    slice.noiUsd != null
      ? ` · $${(slice.noiUsd / 1_000_000).toFixed(1)}M workbook NOI${blank.length > 0 ? ` (incomplete: blank NOI on ${named})` : ''}`
      : '';
  return `${slice.shown} of ${slice.total} assets${noi}`;
}
