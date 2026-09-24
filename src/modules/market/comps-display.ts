// src/modules/market/comps-display.ts
//
// Pure display helpers for CompsView.tsx. Split out of the component module because exporting
// non-component helpers from a .tsx file trips react-refresh/only-export-components.

const STATE_CODES = new Set(['oh', 'md', 'in', 'wi', 'mo', 'ks', 'tn', 'ia', 'mi', 'ky', 'de']);
/** State codes that are also English words — lowercase in mid-title positions ("Flex Space in Columbus"). */
const ENGLISH_WORDS = new Set(['in', 'de']);
const ZIP = /^\d{5}$/;

/** Title for a comp set whose deal record is missing — never the raw 'notion-…' slug.
 *  A token is a state code only when it is the LAST token or sits directly before a 5-digit ZIP. */
export function humanizeDealId(id: string): string {
  const words = id.replace(/^notion-/i, '').split('-').filter(Boolean);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      const next = words[i + 1];
      const statePosition = next === undefined || ZIP.test(next);
      if (STATE_CODES.has(lower) && statePosition) return w.toUpperCase();
      if (/^\d/.test(w)) return w;
      if (ENGLISH_WORDS.has(lower) && i > 0) return lower;
      return w[0]!.toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/** Set-level sources can be empty while every comp row carries its own source. */
export function compSourceCount(set: { sources: unknown[]; saleComps: { source: string }[]; rentComps: { source: string }[] }): number {
  if (set.sources.length > 0) return set.sources.length;
  return new Set([...set.saleComps, ...set.rentComps].map((c) => c.source)).size;
}
