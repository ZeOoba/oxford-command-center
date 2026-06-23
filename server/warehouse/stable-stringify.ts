/**
 * stable-stringify.ts — canonical deterministic JSON serialisation
 *
 * Shared utility extracted from calibration.ts and acquisition.ts (both had
 * identical implementations). Key-sorts object properties at every depth so
 * that two objects with the same data but different insertion order produce
 * identical strings — suitable for hashing / cache-key derivation.
 *
 * Pure and dependency-free: no imports, no side-effects.
 */

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) as string;
  if (Array.isArray(v))
    return `[${v.map((item) => stableStringify(item === undefined ? null : item)).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const pairs = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}
