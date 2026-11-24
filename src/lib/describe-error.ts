// src/lib/describe-error.ts
//
// Plain-words description of a failed load (2026-11-23 review, Tier 3), shared by the QueryError
// primitive and the shell's ModuleError. Lives outside the component file so fast refresh keeps working.

export type ErrorKind = 'network' | 'unavailable' | 'failed';

export interface ErrorDescription {
  kind: ErrorKind;
  headline: string;
  detail: string | null;
}

/** Matched by NAME: several module hook files define their own WarehouseUnavailableError class. */
function isUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === 'WarehouseUnavailableError';
}

/** A fetch that never reached a server: browsers throw TypeError ("Failed to fetch", "NetworkError…"). */
function isNetwork(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) || /^no server$/i.test(error.message);
}

export function describeError(error: unknown, what: string): ErrorDescription {
  const raw = error instanceof Error ? error.message : error === undefined || error === null ? null : String(error);
  const detail = raw && raw.trim() ? raw.trim() : null;
  if (isUnavailable(error)) {
    return { kind: 'unavailable', headline: `${capitalize(what)} needs the live warehouse, which this copy does not include.`, detail };
  }
  if (isNetwork(error)) return { kind: 'network', headline: "Can't reach the command-center server.", detail };
  return { kind: 'failed', headline: `Couldn't load ${what}.`, detail };
}

/**
 * Same idea for a failed ACTION (save, grade, file, decide), review round 2 (2026-11-24). `failed` is
 * the whole plain-words headline, e.g. "The decision was not saved." The raw server text (often a
 * useful validation reason) stays available as `detail`, never as the headline.
 */
export function describeActionError(error: unknown, failed: string): ErrorDescription {
  const raw = error instanceof Error ? error.message : error === undefined || error === null ? null : String(error);
  const detail = raw && raw.trim() ? raw.trim() : null;
  if (isNetwork(error)) return { kind: 'network', headline: `Can't reach the command-center server. ${failed}`, detail };
  return { kind: 'failed', headline: failed, detail };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
