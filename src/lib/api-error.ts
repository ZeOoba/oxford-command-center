// src/lib/api-error.ts
//
// One error type for a failed API call (review round 3, 2026-11-24). Before this, postAction threw
// "Action failed (400)" and dropped the server's reason, and ~15 call sites parsed error bodies by
// hand. readApiError keeps the server's `error` text (often a useful validation reason) and the
// request id the server attaches to every response (X-Request-Id header, `requestId` on 5xx bodies),
// so a failure on screen can be matched to its server log line.

export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  constructor(message: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
  }
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

function cleanId(v: unknown): string | null {
  return typeof v === 'string' && SAFE_ID.test(v) ? v : null;
}

/** Build an ApiError from a non-OK response. Never throws: an unreadable body falls back to the status. */
export async function readApiError(res: Response, fallback = `Request failed (${res.status})`): Promise<ApiError> {
  let body: unknown = null;
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) body = await res.json();
  } catch {
    body = null;
  }
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const msg = obj && typeof obj.error === 'string' && obj.error.trim() ? obj.error.trim() : fallback;
  const requestId = cleanId(obj?.requestId) ?? cleanId(res.headers.get('X-Request-Id'));
  return new ApiError(msg, res.status, requestId);
}

/** The request id carried by an error, when it has one (an ApiError, or any error with a string `requestId`). */
export function requestIdOfError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  return cleanId((error as { requestId?: unknown }).requestId);
}
