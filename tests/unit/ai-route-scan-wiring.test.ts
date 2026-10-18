// Refute round 6, G5: nothing pinned that server/index.ts's POST /api/ai handler passes the
// per-tool-result roster scan to runAgent: deleting the `...agentEgressGuards()` spread left
// every test green (the agent tests inject their own scan). This boots the real Hono app from
// server/index.ts (listen and the brain mocked; nothing binds a port), drives POST /api/ai through
// the real request boundary, and asserts the options the handler gives runAgent carry a scan that
// catches a synthetic roster term (via the real normalised egress matcher against a synthetic
// roster) and clears clean text. runAgent is mocked so no model is called.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Fetch = (req: Request) => Response | Promise<Response>;
const h = vi.hoisted(() => ({ fetch: null as Fetch | null, agentOpts: [] as Array<Record<string, unknown>> }));

vi.mock('@hono/node-server', () => ({ serve: (o: { fetch: Fetch }) => { h.fetch = o.fetch; } }));
vi.mock('../../server/startup', () => ({ startServer: (d: { listen: (cb: (p: number) => void) => void }) => d.listen(() => {}) }));
vi.mock('../../server/brain', () => ({
  brain: {
    getSnapshot: vi.fn(() => ({ properties: [], leases: [], deals: [] })),
    getState: vi.fn(() => ({})),
    on: vi.fn(), off: vi.fn(),
    refresh: vi.fn(async () => {}), startWatching: vi.fn(),
  },
}));
vi.mock('../../server/ai/agent', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runAgent: vi.fn(async (opts: Record<string, unknown> & { emit: (e: unknown) => Promise<void> }) => {
      h.agentOpts.push(opts);
      await opts.emit({ type: 'done' });
    }),
  };
});

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, wh: process.env.WAREHOUSE_DB, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
beforeAll(async () => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ai-route-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify({ syn: { label: 'Synthetic', active: true, always: ['Kestrel Ridge'] } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  process.env.WAREHOUSE_DB = join(dir, 'no-such.sqlite');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../../server/index');
});
afterAll(() => {
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.wh === undefined) delete process.env.WAREHOUSE_DB;
  else process.env.WAREHOUSE_DB = saved.wh;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** POST /api/ai through the real app; returns the confidentialScan the handler gave runAgent. */
async function postAndCaptureScan(): Promise<(v: unknown) => unknown> {
  const { serverPort } = await import('../../server/config');
  expect(h.fetch).toBeTypeOf('function');
  const host = `127.0.0.1:${serverPort()}`;
  const before = h.agentOpts.length;
  const res = await h.fetch!(new Request(`http://${host}/api/ai`, {
    method: 'POST',
    headers: { host, 'content-type': 'application/json', 'x-ora-client': '1' },
    body: JSON.stringify({ question: 'How is the portfolio doing?' }),
  }));
  expect(res.status).toBe(200);
  await res.text();
  expect(h.agentOpts).toHaveLength(before + 1);
  const scan = h.agentOpts[before]!.confidentialScan as ((v: unknown) => unknown) | undefined;
  expect(scan).toBeTypeOf('function');
  return scan!;
}

describe('POST /api/ai wires the roster scan into runAgent', () => {
  // Refute round 7, H4: the test below passes with the PLAIN rosterMatch wired in too, so it did not
  // pin the egress placeholder refusal. Under CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 with the roster
  // absent (the placeholder stand-in), the wired scan must THROW the generic guard-unavailable
  // message even on clean text: tool results go to an external API.
  it('under the placeholder opt-out the wired scan refuses (throws), even on clean text', async () => {
    const { CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE } = await import('../../server/ai/agent');
    const real = process.env.CONFIDENTIAL_TERMS_PATH;
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'absent.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    try {
      const scan = await postAndCaptureScan();
      expect(() => scan({ rows: [{ note: 'Public Flex Center' }] })).toThrow(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
    } finally {
      process.env.CONFIDENTIAL_TERMS_PATH = real;
      delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    }
  });

  it('the handler passes a confidentialScan that catches a roster-term variant and clears clean text', async () => {
    const scan = await postAndCaptureScan();
    expect(scan({ rows: [{ note: `Kestrel${String.fromCodePoint(0xa0)}Ridge` }] })).not.toBeNull();
    expect(scan({ rows: [{ note: 'Public Flex Center' }] })).toBeNull();
  });
});
