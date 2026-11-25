// Review round 3 (2026-11-24): one ApiError for failed API calls, carrying the server's reason and
// request id; describe-error shows the id as "Ref"; an offline server reads as "can't reach", not
// "this copy has no warehouse"; a 503 that is not "warehouse unavailable" is a real failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, readApiError, requestIdOfError } from '../../src/lib/api-error';
import { actionErrorToast, describeActionError, describeError } from '../../src/lib/describe-error';
import { fetchJson, WarehouseUnavailableError } from '../../src/modules/intel/hooks';

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

afterEach(() => vi.unstubAllGlobals());

describe('readApiError', () => {
  it('keeps the server reason, the status and the body request id', async () => {
    const e = await readApiError(json({ ok: false, error: 'Invalid key or rentPsf', requestId: 'abc-1' }, 400));
    expect(e).toBeInstanceOf(ApiError);
    expect([e.message, e.status, e.requestId]).toEqual(['Invalid key or rentPsf', 400, 'abc-1']);
  });

  it('falls back to the X-Request-Id header and to the fallback text', async () => {
    const e = await readApiError(json({}, 500, { 'X-Request-Id': 'hdr-9' }), 'Action failed (500)');
    expect([e.message, e.requestId]).toEqual(['Action failed (500)', 'hdr-9']);
  });

  it('never throws on a non-JSON or unparseable body, and drops an unsafe id', async () => {
    const html = await readApiError(new Response('<html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect([html.message, html.requestId]).toEqual(['Request failed (502)', null]);
    const bad = await readApiError(new Response('{not json', { status: 500, headers: { 'content-type': 'application/json', 'X-Request-Id': 'a b' } }));
    expect([bad.message, bad.requestId]).toEqual(['Request failed (500)', null]);
  });

  it('requestIdOfError reads only a safe string id', () => {
    expect(requestIdOfError(new ApiError('x', 500, 'r-1'))).toBe('r-1');
    expect(requestIdOfError(new Error('x'))).toBeNull();
    expect(requestIdOfError({ requestId: 'x\ny' })).toBeNull();
  });
});

describe('describe-error with request ids', () => {
  it('carries the id on load and action descriptions, null otherwise', () => {
    expect(describeError(new ApiError('boom', 500, 'r-2'), 'the ladder').requestId).toBe('r-2');
    expect(describeActionError(new ApiError('bad', 400, 'r-3'), 'Not saved.')).toEqual({ kind: 'failed', headline: 'Not saved.', detail: 'bad', requestId: 'r-3' });
    expect(describeError(new Error('x'), 'it').requestId).toBeNull();
  });

  it('an offline brain server is "can\'t reach", not "needs the live warehouse"', () => {
    expect(describeError(new WarehouseUnavailableError('brain server offline'), 'the forecast').kind).toBe('network');
    expect(describeError(new WarehouseUnavailableError(), 'the forecast').kind).toBe('unavailable');
  });

  it('actionErrorToast puts the headline in the title and reason + Ref in the description', () => {
    expect(actionErrorToast(new ApiError('quota', 502, 'r-4'), 'The sync did not run.')).toEqual({ tone: 'error', title: 'The sync did not run.', description: 'quota · Ref: r-4' });
    expect(actionErrorToast(undefined, 'Nope.')).toEqual({ tone: 'error', title: 'Nope.' });
  });
});

describe('postAction (write-back actions)', () => {
  it('a rejected save keeps the server reason and request id instead of "Action failed (400)"', async () => {
    const { saveNoiBudget } = await import('../../src/data/actions');
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, error: 'Invalid propertyId or amount' }, 400, { 'X-Request-Id': 'r-7' })));
    await expect(saveNoiBudget('p1', 5)).rejects.toMatchObject({ name: 'ApiError', message: 'Invalid propertyId or amount', status: 400, requestId: 'r-7' });
  });
});

describe('fetchJson 503 handling', () => {
  it('a "warehouse unavailable" 503 (or a 503 with no reason) stays the unavailable sentinel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'warehouse unavailable' }, 503)));
    await expect(fetchJson('/x')).rejects.toBeInstanceOf(WarehouseUnavailableError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(fetchJson('/x')).rejects.toBeInstanceOf(WarehouseUnavailableError);
  });

  it('other "not here" 503s (snapshot not loaded, no dataset) stay the sentinel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'snapshot unavailable' }, 503)));
    await expect(fetchJson('/x')).rejects.toBeInstanceOf(WarehouseUnavailableError);
  });

  it('a busy/retry 503 is a real failure with its reason and request id', async () => {
    const msg = 'warehouse busy (another writer, e.g. a backfill, holds the write lock); nothing was written; retry';
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: msg, requestId: 'r-5' }, 503)));
    const err = await fetchJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: msg, status: 503, requestId: 'r-5' });
  });

  it('a 500 keeps the server reason and request id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'debt scoring failed', requestId: 'r-6' }, 500)));
    await expect(fetchJson('/x')).rejects.toMatchObject({ message: 'debt scoring failed', requestId: 'r-6' });
  });
});
