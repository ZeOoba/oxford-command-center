// Refute round 3, U3: comps refused the placeholder roster, but om-extract, the agent's
// confidentialScan wrapper (server/ai/egress-guards.ts, spread by server/index.ts) and the narrative pre-send scan accepted it for the
// same external API. All four egress defaults now refuse it. Each caller keeps its own failure
// shape: om-extract blocks, the agent wrapper throws the generic guard-unavailable message, and the
// narrative degrades.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { egressRosterMatch } from '../../server/briefing/roster-match';
import { agentEgressGuards } from '../../server/ai/egress-guards';
// The agent route's layer-2 scan as production wires it (#479): agentEgressGuards().confidentialScan.
const agentConfidentialScan = (v: unknown) => agentEgressGuards().confidentialScan!(v);
import { CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE } from '../../server/ai/agent';
import { extractOmFields } from '../../server/warehouse/om-extract';
import { composeLeaseNarrative, composeNarrative } from '../../server/ai/narrative';
import { SYNTHETIC_ROSTER } from './roster-variants';

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
function placeholder() {
  process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
  process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
}
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'egress-ph-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(SYNTHETIC_ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const tracking = (text = '{}') => {
  const calls: number[] = [];
  const f = (async () => { calls.push(1); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }), text: async () => text }; }) as unknown as typeof fetch;
  return { f, calls };
};

describe('egressRosterMatch', () => {
  it('matches like rosterMatch on a real roster', () => {
    expect(egressRosterMatch('9900 Quarry')).not.toBeNull();
    expect(egressRosterMatch('clean text')).toBeNull();
  });
  it('THROWS on the placeholder roster', () => {
    placeholder();
    expect(() => egressRosterMatch('clean text')).toThrow(/placeholder/i);
  });
});

describe('om-extract default scan refuses the placeholder roster', () => {
  it('blocks before any HTTP call', async () => {
    placeholder();
    const { f, calls } = tracking();
    const r = await extractOmFields(Buffer.from('x'), { apiKey: 'sk-test', fetchImpl: f, pdfParseFn: async () => ({ text: 'Clean industrial OM' }) });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('control: real roster + clean text proceeds to the API', async () => {
    const { f, calls } = tracking('{}');
    await extractOmFields(Buffer.from('x'), { apiKey: 'sk-test', fetchImpl: f, pdfParseFn: async () => ({ text: 'Clean industrial OM' }) });
    expect(calls).toHaveLength(2); // main + other-use extraction requests (E3, 2026-11-08)
  });
});

describe('agent confidentialScan wrapper (server/ai/egress-guards.ts, spread by server/index.ts)', () => {
  it('throws the generic guard-unavailable message on the placeholder roster', () => {
    placeholder();
    expect(() => agentConfidentialScan({ q: 'clean' })).toThrow(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
  });
  it('throws the same generic message (no path leak) on an unreadable roster', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(() => agentConfidentialScan({ q: 'clean' })).toThrow(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
  });
  it('returns the hit / null on a real roster', () => {
    expect(agentConfidentialScan({ q: '9900-Quarry' })).not.toBeNull();
    expect(agentConfidentialScan({ q: 'clean' })).toBeNull();
  });
});

describe('narrative pre-send refuses the placeholder roster by degrading (documented path)', () => {
  // composeNarrative's pre-send scan (egressScan) is the ONLY placeholder refusal on the
  // /briefing/{property,manager}/:slug/narrative and ?narrative=1 PDF paths: compose.ts's own scan
  // accepts the placeholder. Reverting it to assertNoRosterMatch passed every test (refute wf_3a25ae4b-c2e).
  const MANAGER_MODEL = {
    kind: 'manager',
    subject: { name: 'Test Manager', propertyCount: 1, smallSample: false },
    scorecard: {
      avgNoiPerSf: { display: '$4.80 /SF' }, avgNoiGrowth: { display: '1.0%' }, avgExpenseGrowth: { display: '0.5%' },
    },
    managedProperties: [], attentionItems: [], actionList: [],
  } as unknown as Parameters<typeof composeNarrative>[0];
  it('composeNarrative degrades with no HTTP call on the placeholder roster', async () => {
    placeholder();
    const { f, calls } = tracking();
    const r = await composeNarrative(MANAGER_MODEL, { apiKey: 'sk-test', fetchImpl: f });
    expect(r).toEqual({ narrative: null, degraded: true });
    expect(calls).toHaveLength(0);
  });
  it('control: composeNarrative reaches the API on a real roster with clean text', async () => {
    const { f, calls } = tracking('{}');
    await composeNarrative(MANAGER_MODEL, { apiKey: 'sk-test', fetchImpl: f });
    expect(calls).toHaveLength(1);
  });
  it('degrades with no HTTP call', async () => {
    placeholder();
    const { f, calls } = tracking();
    const r = await composeLeaseNarrative({ asOf: '2026-10-01' } as unknown as Parameters<typeof composeLeaseNarrative>[0], { apiKey: 'sk-test', fetchImpl: f });
    expect(r).toEqual({ narrative: null, degraded: true });
    expect(calls).toHaveLength(0);
  });
});
