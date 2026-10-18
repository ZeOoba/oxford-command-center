// Refute round 5, F2: the mirror's AI Pages Function (functions/api/ai.ts). On the REDACTED mirror
// the snapshot carries no confidential:true deal, so edgeConfidentialScan returned undefined and
// runAgent skipped BOTH the question/history scan and the tool-result scan: POST /api/ai
// {"question":"<confidential deal> status"} reached Anthropic unscanned. On a FULL bake the scan was
// a raw substring check, so an NBSP / hyphen variant passed. Now:
//  - no scan available + an API key configured => the request is REFUSED before runAgent;
//  - the scan, when available, is the normalised roster matcher (server/briefing/roster-core.ts,
//    runtime-agnostic) over terms built from the snapshot's own flagged deals.
// The deterministic responder (no API key) never egresses, so it is still served. Synthetic only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const runAgentMock = vi.fn(async (opts: { emit: (e: unknown) => unknown }) => {
  await opts.emit({ type: 'done', model: 'stub', refs: [] });
});
vi.mock('../../server/ai/agent', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, runAgent: (opts: { emit: (e: unknown) => unknown }) => runAgentMock(opts) };
});
// The function validates the baked snapshot with Zod; this suite is about the guard, so the
// snapshot parse is a pass-through here (only functions/api/ai.ts's runtime use is affected).
vi.mock('../../src/contracts/index', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, PortfolioSnapshot: { parse: (x: unknown) => x } };
});

import { edgeConfidentialScan, onRequestPost, resetRateLimit } from '../../functions/api/ai';
import type { PortfolioSnapshot } from '../../src/contracts/index';

const cp = (...n: number[]) => String.fromCodePoint(...n);
const snapOf = (deals: Array<{ name: string; confidential: boolean; shortName?: string | null }>) =>
  ({ meta: { asOf: '2026-10-01', scenario: 'base' }, deals: deals.map((d, i) => ({ id: `d${i}`, shortName: null, ...d })) }) as unknown as PortfolioSnapshot;

function ctx(question: string, snapshot: unknown, apiKey?: string) {
  const request = new Request('https://mirror.test/api/ai', { method: 'POST', body: JSON.stringify({ question }) });
  const env = {
    ANTHROPIC_API_KEY: apiKey,
    ASSETS: { fetch: async () => new Response(JSON.stringify(snapshot), { status: 200 }) },
  };
  return { request, env } as unknown as Parameters<typeof onRequestPost>[0];
}

beforeEach(() => {
  resetRateLimit();
  runAgentMock.mockClear();
});

describe('F2: no scan available => refuse when the request would egress', () => {
  it('redacted mirror (no flagged deal) + API key: refused before runAgent, label-free', async () => {
    const res = await onRequestPost(ctx('Kestrel Ridge status', snapOf([{ name: 'Public Yard', confidential: false }]), 'sk-test'));
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).toMatch(/confidential/i);
    expect(text.toLowerCase()).not.toContain('kestrel');
    expect(runAgentMock).not.toHaveBeenCalled();
  });
  it('redacted mirror with NO API key: the deterministic responder still runs (no egress)', async () => {
    await (await onRequestPost(ctx('portfolio NOI?', snapOf([]), undefined))).text();
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
  it('full mirror (a flagged deal) + API key: runAgent runs WITH a scan', async () => {
    await (await onRequestPost(ctx('portfolio NOI?', snapOf([{ name: 'Kestrel Ridge', confidential: true }]), 'sk-test'))).text();
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const opts = runAgentMock.mock.calls[0]![0] as unknown as { confidentialScan?: unknown };
    expect(typeof opts.confidentialScan).toBe('function');
  });
});

describe('F2: the edge scan is the normalised roster matcher', () => {
  const scan = edgeConfidentialScan(snapOf([{ name: 'Kestrel Ridge', shortName: 'Kestrel R', confidential: true }, { name: 'Public Yard', confidential: false }]))!;
  it.each<[string, unknown]>([
    ['NBSP', `Kestrel${cp(0xa0)}Ridge status`],
    ['hyphen', 'Kestrel-Ridge status'],
    ['zero-width split', `Kes${cp(0x200b)}trel Ridge`],
    ['full-width', `${cp(0xff2b)}estrel Ridge`],
    ['object key', { 'Kestrel Ridge': 1 }],
    ['split across history turns', { question: 'q', history: ['Kest', 'rel Ridge'] }],
  ])('catches a %s variant', (_n, v) => {
    expect(scan(v)).toEqual({ dealLabel: 'Kestrel Ridge' });
  });
  it('passes clean text and the public deal', () => {
    expect(scan('Public Yard LOI countersigned')).toBeNull();
    expect(scan(null)).toBeNull();
  });
});

describe('F2: the shared matcher core stays runtime-agnostic (it runs in the Pages Function)', () => {
  it('roster-core.ts has no runtime import (node:fs / node:os / confidential.ts are loader-side only)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../../server/briefing/roster-core.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
    for (const l of imports) expect(l).toMatch(/^\s*import\s+type\s/);
    expect(src).not.toMatch(/from\s+['"]node:/);
  });
});
