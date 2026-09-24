// src/modules/market/comps-display.ts
//
// Pure display helpers for CompsView.tsx. Split out of the component module because exporting
// non-component helpers from a .tsx file trips react-refresh/only-export-components.

const UPPER = new Set(['oh', 'md', 'in', 'wi', 'mo', 'ks', 'tn', 'ia', 'mi', 'ky', 'de']);

/** Title for a comp set whose deal record is missing — never the raw 'notion-…' slug. */
export function humanizeDealId(id: string): string {
  return id
    .replace(/^notion-/i, '')
    .split('-')
    .filter(Boolean)
    .map((w) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : /^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Set-level sources can be empty while every comp row carries its own source. */
export function compSourceCount(set: { sources: unknown[]; saleComps: { source: string }[]; rentComps: { source: string }[] }): number {
  if (set.sources.length > 0) return set.sources.length;
  return new Set([...set.saleComps, ...set.rentComps].map((c) => c.source)).size;
}
