import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getGraphToken, _resetGraphTokenCache } from '../../server/sources/graph-auth';

const CRED_KEYS = ['GRAPH_TOKEN', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'] as const;

function clearCreds() {
  for (const k of CRED_KEYS) delete process.env[k];
}

function tokenResponse(token: string, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('graph-auth — token resolution', () => {
  beforeEach(() => {
    _resetGraphTokenCache();
    clearCreds();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCreds();
  });

  it('returns the manual GRAPH_TOKEN verbatim (no network)', async () => {
    process.env.GRAPH_TOKEN = 'manual-bearer';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await getGraphToken()).toBe('manual-bearer');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when nothing is configured (graceful)', async () => {
    expect(await getGraphToken()).toBeNull();
  });

  it('fetches an app-only token via client-credentials and caches it', async () => {
    process.env.GRAPH_TENANT_ID = 'tenant';
    process.env.GRAPH_CLIENT_ID = 'client';
    process.env.GRAPH_CLIENT_SECRET = 'secret';
    const fetchMock = vi.fn(async () => tokenResponse('app-token-1'));
    vi.stubGlobal('fetch', fetchMock);

    const t0 = 1_000_000;
    expect(await getGraphToken(t0)).toBe('app-token-1');
    // Second call well within the lifetime → served from cache, no second network call.
    expect(await getGraphToken(t0 + 60_000)).toBe('app-token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The token endpoint + client-credentials grant must be used.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain('login.microsoftonline.com/tenant/oauth2/v2.0/token');
    expect(init.body).toContain('grant_type=client_credentials');
    expect(init.body).toContain('scope=https');
  });

  it('refreshes after the cached token expires', async () => {
    process.env.GRAPH_TENANT_ID = 'tenant';
    process.env.GRAPH_CLIENT_ID = 'client';
    process.env.GRAPH_CLIENT_SECRET = 'secret';
    let n = 0;
    const fetchMock = vi.fn(async () => tokenResponse(`app-token-${++n}`, 3600));
    vi.stubGlobal('fetch', fetchMock);

    const t0 = 1_000_000;
    expect(await getGraphToken(t0)).toBe('app-token-1');
    // Past expiry (3600s) → a fresh fetch.
    expect(await getGraphToken(t0 + 3_600_001)).toBe('app-token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-OK token response (caller treats as graceful skip)', async () => {
    process.env.GRAPH_TENANT_ID = 'tenant';
    process.env.GRAPH_CLIENT_ID = 'client';
    process.env.GRAPH_CLIENT_SECRET = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(getGraphToken()).rejects.toThrow(/401/);
  });
});
