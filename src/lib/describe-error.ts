// src/lib/describe-error.ts
//
// Plain-words description of a failed load (2026-11-23 review, Tier 3), shared by the QueryError
// primitive and the shell's ModuleError. Lives outside the component file so fast refresh keeps working.
import { requestIdOfError } from './api-error';

export type ErrorKind = 'network' | 'unavailable' | 'failed';

export interface ErrorDescription {
  kind: ErrorKind;
  headline: string;
  detail: string | null;
  /** Server request id (review round 3): shown as "Ref" under Details so a failure matches its log line. */
  requestId: string | null;
}

/** Matched by NAME: several module hook files define their own WarehouseUnavailableError class. */
function isUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === 'WarehouseUnavailableError';
}

/**
 * A fetch that never reached a server: browsers throw TypeError ("Failed to fetch", "NetworkError…").
 * The warehouse hooks wrap that case in WarehouseUnavailableError('brain server offline'); it is still
 * "can't reach the server", not "this copy has no warehouse" (review round 3).
 */
function isNetwork(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) || /^(no server|brain server offline)$/i.test(error.message);
}

export function describeError(error: unknown, what: string): ErrorDescription {
  const raw = error instanceof Error ? error.message : error === undefined || error === null ? null : String(error);
  const detail = raw && raw.trim() ? raw.trim() : null;
  const requestId = requestIdOfError(error);
  if (isNetwork(error)) return { kind: 'network', headline: "Can't reach the command-center server.", detail, requestId };
  if (isUnavailable(error)) {
    return { kind: 'unavailable', headline: `${capitalize(what)} needs the live warehouse, which this copy does not include.`, detail, requestId };
  }
  return { kind: 'failed', headline: `Couldn't load ${what}.`, detail, requestId };
}

/**
 * Same idea for a failed ACTION (save, grade, file, decide), review round 2 (2026-11-24). `failed` is
 * the whole plain-words headline, e.g. "The decision was not saved." The raw server text (often a
 * useful validation reason) stays available as `detail`, never as the headline.
 */
export function describeActionError(error: unknown, failed: string): ErrorDescription {
  const raw = error instanceof Error ? error.message : error === undefined || error === null ? null : String(error);
  const detail = raw && raw.trim() ? raw.trim() : null;
  const requestId = requestIdOfError(error);
  if (isNetwork(error)) return { kind: 'network', headline: `Can't reach the command-center server. ${failed}`, detail, requestId };
  return { kind: 'failed', headline: failed, detail, requestId };
}

/** Toast fields for a failed action: plain headline as the title, server reason (and Ref) as the description. */
export function actionErrorToast(error: unknown, failed: string): { tone: 'error'; title: string; description?: string } {
  const d = describeActionError(error, failed);
  const parts = [d.detail, d.requestId ? `Ref: ${d.requestId}` : null].filter((x): x is string => !!x);
  return parts.length ? { tone: 'error', title: d.headline, description: parts.join(' · ') } : { tone: 'error', title: d.headline };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
