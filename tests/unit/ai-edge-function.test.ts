// tests/unit/ai-edge-function.test.ts
//
// The mirror's AI Pages Function (functions/api/ai.ts): request-body validation, the per-identity
// rate limit and the roster-free edge confidentiality scan. Runs in Node (vitest) — proves the
// LOGIC, not the workerd runtime (see acquisition-edge-function.test.ts for the same caveat).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT_MAX, admit, edgeConfidentialScan, onRequestPost, resetRateLimit } from '../../functions/api/ai';
import type { PortfolioSnapshot } from '../../src/contracts/index';

vi.mock('../../server/ai/agent', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, runAgent: vi.fn(async (opts: { emit: (e: unknown) => unknown }) => { await opts.emit({ type: 'done', model: 'stub', refs: [] }); }) };
});

function ctx(body: unknown, headers: Record<string, string> = {}, snapshotOk = false) {
  const request = new Request('https://mirror.test/api/ai', { method: 'POST', body: JSON.stringify(body), headers });
  const env = {
    ASSETS: { fetch: async () => (snapshotOk ? new Response('{}', { status: 200 }) : new Response('nope', { status: 404 })) },
  };
  return { request, env } as unknown as Parameters<typeof onRequestPost>[0];
}

beforeEach(() => resetRateLimit());

describe('functions/api/ai — request validation', () => {
  it('400s a blank or oversized question before any snapshot read or model call', async () => {
    expect((await onRequestPost(ctx({ question: '' }))).status).toBe(400);
    expect((await onRequestPost(ctx({ question: 'x'.repeat(5_000) }))).status).toBe(400);
    expect((await onRequestPost(ctx('garbage'))).status).toBe(400);
  });

  it('a valid body streams SSE (snapshot missing → error frame, still 200 event-stream)', async () => {
    const res = await onRequestPost(ctx({ question: 'hello' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).toContain('snapshot is unavailable');
  });
});

describe('functions/api/ai — per-identity rate limit', () => {
  it('admits RATE_LIMIT_MAX requests per identity in the window, then refuses; identities are independent', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) expect(admit('a@x', 1_000 + i)).toBe(true);
    expect(admit('a@x', 2_000)).toBe(false);
    expect(admit('b@x', 2_000)).toBe(true);
  });

  it('the window slides — an identity is admitted again once its oldest hits expire', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) expect(admit('c@x', 1_000)).toBe(true);
    expect(admit('c@x', 1_001)).toBe(false);
    expect(admit('c@x', 1_000 + 5 * 60 * 1000 + 1)).toBe(true);
  });

  it('returns 429 with retry-after once the Access identity is over budget', async () => {
    const h = { 'cf-access-authenticated-user-email': 'g@oxfordra.net' };
    for (let i = 0; i < RATE_LIMIT_MAX; i++) expect((await onRequestPost(ctx({ question: 'q' }, h))).status).toBe(200);
    const res = await onRequestPost(ctx({ question: 'q' }, h));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    // a different identity is unaffected
    expect((await onRequestPost(ctx({ question: 'q' }, { 'cf-access-authenticated-user-email': 'other@x' }))).status).toBe(200);
  });
});

describe('functions/api/ai — edge confidentiality scan', () => {
  const snap = (deals: Array<{ name: string; confidential: boolean; shortName?: string | null }>) =>
    ({ deals: deals.map((d, i) => ({ id: `d${i}`, shortName: null, ...d })) }) as unknown as PortfolioSnapshot;

  it('is undefined when the baked snapshot carries no confidential deals (redacted bake)', () => {
    expect(edgeConfidentialScan(snap([{ name: 'Public Deal', confidential: false }]))).toBeUndefined();
  });

  it('flags any tool result whose free text names a confidential deal (case-insensitive, nested), and passes clean results', () => {
    const scan = edgeConfidentialScan(snap([{ name: 'Public Deal', confidential: false }, { name: 'Project Orchard', confidential: true }]))!;
    expect(scan({ rows: [{ note: 'follow up on PROJECT ORCHARD next week' }] })).toEqual({ dealLabel: 'Project Orchard' });
    expect(scan({ rows: [{ note: 'Public Deal LOI countersigned' }] })).toBeNull();
    expect(scan(null)).toBeNull();
  });

  it('also matches the deal shortName (bake-mirror residue-sweep parity)', () => {
    const scan = edgeConfidentialScan(snap([{ name: 'Project Orchard', shortName: 'Orchard', confidential: true }]))!;
    expect(scan('call re: orchard tomorrow')).toEqual({ dealLabel: 'Project Orchard' });
  });
});
