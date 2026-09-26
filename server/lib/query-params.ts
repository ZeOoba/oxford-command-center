/**
 * Parse a `?limit=` query value: absent/empty/non-integer → the route default (never NaN → 1-row
 * truncation, never a fractional LIMIT bind); integers clamp to [1, max]. Shared by the warehouse
 * routers and server/index.ts. (Audit 2026-09-25: `Number('')` is 0, which a naive clamp turned
 * into a silent 1-row list; `limit=2.5` reached SQLite as a fractional bind.)
 */
export function parseLimitParam(raw: string | undefined, def: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) return def;
  return Math.min(Math.max(1, n), max);
}
