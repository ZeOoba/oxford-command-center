import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import {
  loadM365Tasks,
  m365TasksDegradationFlag,
  hasM365TasksFailure,
} from '../../server/sources/m365-tasks';
import { _resetGraphTokenCache } from '../../server/sources/graph-auth';

const GRAPH_KEYS = ['GRAPH_TOKEN', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_USER'] as const;

/** Run `fn` with Graph env set exactly to `env` (all other Graph keys cleared), then restore. */
async function withGraphEnv(env: Partial<Record<(typeof GRAPH_KEYS)[number], string>>, fn: () => Promise<void>) {
  const prev = Object.fromEntries(GRAPH_KEYS.map((k) => [k, process.env[k]]));
  GRAPH_KEYS.forEach((k) => delete process.env[k]);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  _resetGraphTokenCache();
  try {
    await fn();
  } finally {
    GRAPH_KEYS.forEach((k) => delete process.env[k]);
    for (const k of GRAPH_KEYS) if (prev[k] !== undefined) process.env[k] = prev[k];
    _resetGraphTokenCache();
  }
}

// Every test here stubs global fetch. vitest pools workers across test FILES, and this suite sits
// alongside fetch-dependent suites (debt-api's FRED-outage path, capital-allocation) -- so the
// original fetch is captured and restored EXPLICITLY rather than trusting unstubAllGlobals alone
// to hand back the exact reference a later file in the same worker will close over.
const REAL_FETCH = globalThis.fetch;
beforeAll(() => { /* pin the reference before any stub replaces it */ });
afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = REAL_FETCH;
  _resetGraphTokenCache();
});
afterAll(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('loadM365Tasks — degradation reporting (2026-09-05 tasks 115->59 incident)', () => {
  it('not-configured: no token returns empty tasks and a NON-flagging degradation', async () => {
    await withGraphEnv({}, async () => {
      const out = await loadM365Tasks();
      expect(out.tasks).toEqual([]);
      expect(out.degraded?.reason).toBe('not-configured');
      // A dev box without Graph must not be permanently "dirty" -- same policy as notion-deals.
      expect(m365TasksDegradationFlag(out.degraded)).toBeNull();
    });
  });

  it('fetch-failed: a configured token whose Graph call throws degrades (does NOT return a bare [])', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      throw new Error('fetch failed');
    }));
    await withGraphEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_USER: 'u@x.com' }, async () => {
      const out = await loadM365Tasks();
      expect(out.tasks).toEqual([]);
      expect(out.degraded?.reason).toBe('fetch-failed');
      const flag = m365TasksDegradationFlag(out.degraded)!;
      expect(flag.severity).toBe('error');
      expect(flag.entity).toBe('tasks');
      expect(hasM365TasksFailure([flag])).toBe(true);
    });
  });

  it('token-failed: a token-endpoint failure degrades instead of throwing out of loadM365Tasks', async () => {
    // REGRESSION: getGraphToken() throws (graph-auth.ts) and was called OUTSIDE the try, so this
    // propagated uncaught through parseWorkbook -> Exit 3 crash rather than a clean Exit 1 refusal.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await withGraphEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' }, async () => {
      const out = await loadM365Tasks(); // must NOT reject
      expect(out.tasks).toEqual([]);
      expect(out.degraded?.reason).toBe('token-failed');
      expect(m365TasksDegradationFlag(out.degraded)!.severity).toBe('error');
    });
  });

  it('empty-result: a configured token returning ZERO LISTS is anomalous and flags', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }));
    await withGraphEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_USER: 'u@x.com' }, async () => {
      const out = await loadM365Tasks();
      expect(out.degraded?.reason).toBe('empty-result');
      expect(m365TasksDegradationFlag(out.degraded)!.severity).toBe('error');
    });
  });

  it('healthy-but-empty: lists EXIST with no open tasks is legitimate, NOT a degradation', async () => {
    // Deliberate divergence from notion-deals, which treats any empty result as anomalous: a user
    // genuinely completing every To-Do is a normal state, whereas a zero-row deal pipeline is not.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      if (u.includes('/todo/lists?')) {
        return new Response(JSON.stringify({ value: [{ id: 'L1', displayName: 'Tasks' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }));
    await withGraphEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_USER: 'u@x.com' }, async () => {
      const out = await loadM365Tasks();
      expect(out.tasks).toEqual([]);
      expect(out.degraded).toBeNull();
      expect(m365TasksDegradationFlag(out.degraded)).toBeNull();
    });
  });

  it('healthy: live rows are returned with no degradation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      if (u.includes('/todo/lists?')) {
        return new Response(JSON.stringify({ value: [{ id: 'L1', displayName: 'Tasks' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: [{ id: 'A1', title: 'Call lender', status: 'notStarted' }] }), { status: 200 });
    }));
    await withGraphEnv({ GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_USER: 'u@x.com' }, async () => {
      const out = await loadM365Tasks();
      expect(out.tasks).toHaveLength(1);
      expect(out.degraded).toBeNull();
    });
  });
});

describe('hasM365TasksFailure', () => {
  it('is false for unrelated or warn-severity flags', () => {
    expect(hasM365TasksFailure([])).toBe(false);
    expect(hasM365TasksFailure([{ entity: 'tasks', field: 'm365', issue: 'x', severity: 'warn' }])).toBe(false);
    expect(hasM365TasksFailure([{ entity: 'deals', field: 'pipeline', issue: 'x', severity: 'error' }])).toBe(false);
  });
});
