// tests/unit/egress-live-roster.test.ts
//
// PR #470 follow-up (post-merge refute wf_e6ffdd97-245, two MEDIUMs, then round-2 refute
// wf_fb398b02-494 on the first fix): Anthropic-API egress gates trusted a CACHED
// `Deal.confidential` flag instead of asking the LIVE roster at the moment of egress. That flag only
// moves when Brain's roster watcher fires recheckRoster() (a restartable 250 ms trailing debounce;
// never if watch() failed to arm), so inside that window a deal the roster now claims still reads
// `confidential:false`.
//
//   OM extract: the route passed `deal?.confidential`; the verdict is now live AND re-taken right
//               before the network call (a claim can land during the PDF parse).
//   AI agent:   tools saw a snapshot captured at request start, and the layer-2 text scan only sees
//               emitted fields, so a claim anchored on an unemitted field (owner, lender) slipped
//               through. Now: each tool turn runs its awaited tools first, then computes every spine
//               tool from ONE snapshot tightened after the last await, AND a gate immediately before
//               EVERY request re-asks the roster and halts if the outbound payload names a claimed
//               deal (search_documents passages, question/history, a claim landing during an await,
//               an earlier tool result re-sent after the claim).
//   Placeholder roster: the layer-2 scan fails CLOSED on both routes.
//
// The route wiring lives in server/ai/egress-guards.ts so these tests drive the REAL guards; the
// server/index.ts pins only prove the routes spread them in unmodified.
//
// Synthetic rosters and sentinel names only — never real deal terms.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataQualityFlag, Deal, PortfolioSnapshot } from '../../src/contracts/index';
import { dealConfidentialForEgress, rosterClaimsDeal, egressScan } from '../../server/sources/deal-declassification';
import { extractOmFields } from '../../server/warehouse/om-extract';
import { runAgent, CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE, type AgentEvent } from '../../server/ai/agent';
import { agentEgressGuards, omExtractEgressGuards, resolveOmExtractEgress, type OmExtractSnapshot } from '../../server/ai/egress-guards';

const TARGET_NAME = 'Quillfeather Flex Park';
const TARGET_SHORT = 'Quillfeather';
const TARGET_OWNER = 'Vantablack Holdings LLC';

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

const EMPTY_ROSTER = { other: { label: 'Other', active: true, always: ['nonexistent-sentinel-term'] } };
// Anchored on the OWNER only — get_deals never emits owner, so a text scan of tool output cannot see it.
const CLAIMING_ROSTER = { claimed: { label: 'Claimed', active: true, always: ['vantablack holdings'] } };

let dir: string;
let rosterPath: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
const writeRoster = (r: object) => writeFileSync(rosterPath, JSON.stringify(r), 'utf8');
const usePlaceholderRoster = () => {
  process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
  process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
};

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-egress-live-'));
  rosterPath = join(dir, 'terms.json');
  writeRoster(EMPTY_ROSTER);
  process.env.CONFIDENTIAL_TERMS_PATH = rosterPath;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  if (originalPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = originalPlaceholder;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Source of one route in server/index.ts with comments stripped, so a commented-out line can't satisfy a pin. */
function routeSource(marker: string): string {
  const src = readFileSync(join(__dirname, '../../server/index.ts'), 'utf8');
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const route = src.slice(start, src.indexOf('\napp.', start + 1));
  return route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────

describe('dealConfidentialForEgress / egressScan', () => {
  it('dealConfidentialForEgress: undefined in, undefined out; flag true wins', () => {
    expect(dealConfidentialForEgress(undefined)).toBeUndefined();
    expect(dealConfidentialForEgress(deal({ confidential: true }))).toBe(true);
  });

  it('dealConfidentialForEgress is true once the roster FILE claims the deal, with no watcher tick and the flag still false', () => {
    const d = deal({ name: TARGET_NAME, owner: TARGET_OWNER });
    expect(dealConfidentialForEgress(d)).toBe(false);
    writeRoster(CLAIMING_ROSTER);
    expect(d.confidential).toBe(false);
    expect(dealConfidentialForEgress(d)).toBe(true);
  });

  it('dealConfidentialForEgress fails CLOSED on an unreadable or placeholder roster', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(dealConfidentialForEgress(deal({ name: TARGET_NAME }))).toBe(true);
    usePlaceholderRoster();
    expect(dealConfidentialForEgress(deal({ name: TARGET_NAME }))).toBe(true);
  });

  it('egressScan hits an active term, passes clean text, and THROWS on the placeholder roster (raw scanForConfidential fails open there)', () => {
    writeRoster(CLAIMING_ROSTER);
    expect(egressScan('seller is Vantablack Holdings')).not.toBeNull();
    expect(egressScan('nothing to see')).toBeNull();
    usePlaceholderRoster();
    expect(() => egressScan('nothing to see')).toThrow();
  });
});

// ── OM extract ───────────────────────────────────────────────────────────────────────────────────

describe('OM extract — omExtractEgressGuards + extractOmFields', () => {
  const run = (d: Deal | undefined, hasDealId: boolean, parse: () => Promise<{ text: string }>) => {
    const fetchImpl = vi.fn();
    const p = extractOmFields(Buffer.from('fake-pdf'), {
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pdfParseFn: parse,
      ...omExtractEgressGuards(d, hasDealId, { deals: d ? [d] : [] }),
    });
    return { p, fetchImpl };
  };

  it('a stale-flag deal the roster now claims is refused 403 with no network call', async () => {
    writeRoster(CLAIMING_ROSTER);
    const { p, fetchImpl } = run(deal({ name: TARGET_NAME, owner: TARGET_OWNER }), true, async () => ({ text: 'clean OM body' }));
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a claim that lands DURING the PDF parse (anchor not in the OM text) still blocks the fetch', async () => {
    const { p, fetchImpl } = run(deal({ name: TARGET_NAME, owner: TARGET_OWNER }), true, async () => {
      writeRoster(CLAIMING_ROSTER);
      return { text: 'An offering memorandum for a 40,000 SF flex building' };
    });
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a blank-deal upload fails CLOSED on the placeholder roster (the text scan no longer fails open)', async () => {
    usePlaceholderRoster();
    const { p, fetchImpl } = run(undefined, false, async () => ({ text: 'clean OM body' }));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an unresolved dealId still fails closed (dealLookupFailed)', async () => {
    const { p, fetchImpl } = run(undefined, true, async () => ({ text: 'clean OM body' }));
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('server/index.ts om-extract route resolves via resolveOmExtractEgress and spreads its guards LAST, unmodified', () => {
    const route = routeSource("app.post('/api/actions/om-extract'");
    expect(route).toContain("const { deal, guards } = resolveOmExtractEgress(form.get('dealId'), brain.getSnapshot());");
    expect(route).toMatch(/\.\.\.guards,?\s*\}\);/);
    expect(route.match(/\bguards\b/g)).toHaveLength(2);
    expect(route).not.toMatch(/dealConfidential|dealLookupFailed|confidentialScan|hasDealId/);
  });

  it('server/index.ts binds the guard builders only via one plain import — no alias, wrapper or shadow', () => {
    const src = readFileSync(join(__dirname, '../../server/index.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    expect(src).toContain("import { agentEgressGuards, resolveOmExtractEgress } from './ai/egress-guards';");
    expect(src.match(/\bagentEgressGuards\b/g)).toHaveLength(2); // import + the one spread
    expect(src.match(/\bresolveOmExtractEgress\b/g)).toHaveLength(2);
    expect(src).not.toMatch(/egress-guards['"][^\n]*\bas\b|\bas\s+(agentEgressGuards|resolveOmExtractEgress)\b/);
  });

  describe('resolveOmExtractEgress — the route\'s real deal resolution', () => {
    const snapWith = (d: Deal) => ({ deals: [d] });
    const target = deal({ id: 'd-target', name: TARGET_NAME, owner: TARGET_OWNER });

    it('resolves the named deal from the snapshot and live-checks it on its FULL record (owner anchor)', () => {
      writeRoster(CLAIMING_ROSTER);
      const { deal: d, guards } = resolveOmExtractEgress('d-target', snapWith(target));
      expect(d).toBe(target);
      expect(typeof guards.dealConfidential).toBe('function');
      expect((guards.dealConfidential as () => boolean)()).toBe(true);
      expect(guards.dealLookupFailed).toBe(false);
    });

    it('an unknown id or a missing snapshot is a lookup failure (fail closed)', () => {
      expect(resolveOmExtractEgress('nope', snapWith(target)).guards.dealLookupFailed).toBe(true);
      expect(resolveOmExtractEgress('d-target', null).guards.dealLookupFailed).toBe(true);
    });

    it('a blank or absent dealId is a blank-deal upload (no deal predicate, not a lookup failure)', () => {
      for (const raw of ['', null, undefined]) {
        const r = resolveOmExtractEgress(raw, snapWith(target));
        expect(r.deal).toBeUndefined();
        expect(r.guards.dealConfidential).toBeUndefined();
        expect(r.guards.dealLookupFailed).toBe(false);
      }
    });
  });

  it('an unclaimed resolved deal still reaches the network (the live predicate does not over-block)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: '{"price":"1000000"}' }] }),
      text: async () => '',
    }));
    const r = await extractOmFields(Buffer.from('fake-pdf'), {
      apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch,
      pdfParseFn: async () => ({ text: 'clean OM body' }),
      ...omExtractEgressGuards(deal({ name: 'Public Sentinel Deal' }), true, { deals: [deal({ name: 'Public Sentinel Deal' })] }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // main + other-use extraction requests (E3, 2026-11-08)
    expect(r.ok).toBe(true);
  });

  it.each([
    ['at entry', 1],
    ['at the pre-fetch re-check', 2],
  ])('a dealConfidential predicate that throws %s counts as confidential (403, no fetch)', async (_when, throwOnCall) => {
    let n = 0;
    const fetchImpl = vi.fn();
    const r = await extractOmFields(Buffer.from('fake-pdf'), {
      apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch,
      pdfParseFn: async () => ({ text: 'clean OM body' }),
      confidentialScan: () => null,
      dealConfidential: () => { n++; if (n === throwOnCall) throw new Error('boom'); return false; },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ── #478 item 1: an OM naming a DIFFERENT confidential deal than the one the upload is tied to ──

  describe('deal-name gate on the OM body (blank-deal / other-dealId uploads)', () => {
    const okFetch = () => vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: '{"price":"1000000"}' }] }),
      text: async () => '',
    }));
    const target = (o: Partial<Deal> = {}) => deal({ id: 'd-target', name: TARGET_NAME, shortName: TARGET_SHORT, owner: TARGET_OWNER, ...o });
    const pub = deal({ id: 'd-pub', name: 'Public Sentinel Deal' });
    const extract = async (rawDealId: unknown, snap: OmExtractSnapshot | null, parse: () => Promise<{ text: string }>) => {
      const fetchImpl = okFetch();
      const { guards } = resolveOmExtractEgress(rawDealId, snap);
      const r = await extractOmFields(Buffer.from('fake-pdf'), {
        apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch, pdfParseFn: parse, ...guards,
      });
      return { r, fetchImpl };
    };
    const refused = ({ r, fetchImpl }: Awaited<ReturnType<typeof extract>>) => {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(403);
      expect(fetchImpl).not.toHaveBeenCalled();
    };

    it.each([
      ['blank-deal upload', ''],
      ['upload tied to a PUBLIC deal id', 'd-pub'],
    ])('%s whose OM names a deal confidential by FLAG only (roster has no term for it) is refused', async (_l, id) => {
      refused(await extract(id, { deals: [target({ confidential: true }), pub] }, async () => ({ text: `${TARGET_NAME} — 40,000 SF flex, asking $4.2M` })));
    });

    it('a blank-deal upload whose OM names a deal the roster claims only through an OWNER anchor the OM does not carry is refused', async () => {
      writeRoster(CLAIMING_ROSTER);
      refused(await extract('', { deals: [target(), pub] }, async () => ({ text: `Offering: ${TARGET_NAME}, 40,000 SF` })));
    });

    it('a live-claimed (flag still false) deal named only by its shortName is refused', async () => {
      writeRoster(CLAIMING_ROSTER);
      refused(await extract('d-pub', { deals: [target(), pub] }, async () => ({ text: `Comps: ${TARGET_SHORT} trades at a 7.9 cap` })));
    });

    it('the shared separator/percent folds apply to the OM body too', async () => {
      refused(await extract('', { deals: [target({ confidential: true }), pub] }, async () => ({ text: 'See Acq/Quillfeather%20Flex%20Park/OM_Quillfeather-Flex-Park.pdf' })));
    });

    it('a claim that lands DURING the PDF parse is seen by the gate (evaluated right before the fetch)', async () => {
      refused(await extract('', { deals: [target(), pub] }, async () => {
        writeRoster(CLAIMING_ROSTER);
        return { text: `Offering: ${TARGET_NAME}, 40,000 SF` };
      }));
    });

    it('a blank-deal upload with the brain snapshot unavailable is refused (names cannot be checked)', async () => {
      refused(await extract('', null, async () => ({ text: 'clean OM body' })));
    });

    // Independent refute wf_7e107bc5-f6c (MEDIUM): during a Notion outage Brain serves a seed-only
    // snapshot carrying the deals/pipeline error flag, so a Notion-only confidential deal is simply
    // absent from snapshot.deals and the name gate could not see it.
    const PIPELINE_FAILURE: DataQualityFlag = { entity: 'deals', field: 'pipeline', issue: 'Notion deals pipeline unavailable (fetch-failed)', severity: 'error' };

    it.each([
      ['blank-deal upload', ''],
      ['upload tied to a PUBLIC (seed) deal id', 'd-pub'],
    ])('%s is refused while the snapshot carries the deals/pipeline failure flag (its deal list is incomplete)', async (_l, id) => {
      refused(await extract(id, { deals: [pub], dataQuality: [PIPELINE_FAILURE] }, async () => ({ text: `Offering: ${TARGET_NAME}, 40,000 SF` })));
    });

    it('a warn-severity deals flag or an unrelated error flag does not refuse (no over-block)', async () => {
      const snap: OmExtractSnapshot = {
        deals: [target(), pub],
        dataQuality: [
          { ...PIPELINE_FAILURE, severity: 'warn' },
          { entity: 'deals', field: 'stage', issue: 'stage drift', severity: 'warn' },
          { entity: 'tasks', field: 'm365', issue: 'x', severity: 'error' },
        ],
      };
      const { fetchImpl } = await extract('', snap, async () => ({ text: 'clean OM body' }));
      expect(fetchImpl).toHaveBeenCalledTimes(2); // main + other-use extraction requests (E3, 2026-11-08)
    });

    it('a clean OM with only public deals still reaches the network (no over-block), and a public deal named in it is fine', async () => {
      const { r, fetchImpl } = await extract('', { deals: [target(), pub] }, async () => ({ text: 'Public Sentinel Deal, 40,000 SF flex' }));
      expect(fetchImpl).toHaveBeenCalledTimes(2); // main + other-use extraction requests (E3, 2026-11-08)
      expect(r.ok).toBe(true);
    });

    it('Easton rule holds for OM text too: a FLAGGED deal\'s shortName inside unrelated text does not refuse', async () => {
      const { fetchImpl } = await extract('', { deals: [target({ confidential: true }), pub] }, async () => ({ text: `Suite 4, 12 ${TARGET_SHORT} Road, Dayton OH` }));
      expect(fetchImpl).toHaveBeenCalledTimes(2); // main + other-use extraction requests (E3, 2026-11-08)
    });

    it('a name gate that throws counts as a hit (403, no fetch)', async () => {
      const fetchImpl = okFetch();
      const r = await extractOmFields(Buffer.from('fake-pdf'), {
        apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch,
        pdfParseFn: async () => ({ text: 'clean OM body' }), confidentialScan: () => null,
        mentionsConfidentialDeal: () => { throw new Error('boom'); },
      });
      refused({ r, fetchImpl });
    });

    it('the gate is evaluated on exactly the text that egresses (the truncated body)', async () => {
      const seen: string[] = [];
      const long = 'x'.repeat(30_000) + TARGET_NAME;
      await extractOmFields(Buffer.from('fake-pdf'), {
        apiKey: 'sk-test', fetchImpl: okFetch() as unknown as typeof fetch,
        pdfParseFn: async () => ({ text: long }), confidentialScan: () => null,
        mentionsConfidentialDeal: (t) => { seen.push(t); return false; },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('[truncated]');
      expect(seen[0]).not.toContain(TARGET_NAME);
    });
  });
});

// ── AI agent ─────────────────────────────────────────────────────────────────────────────────────

/** A counsel linked ONLY to the target deal: tools.ts withholds it once the deal is confidential
 *  (an orphaned counsel name + market identifies the deal) — and its payload never names the deal. */
const COUNTERPARTIES = [
  {
    id: 'cp-only', name: 'Marisol Vantreese', kind: 'counsel', firm: 'Vantreese Law', role: 'Seller counsel',
    email: 'mv@vantreese.example', phone: null, market: 'Columbus OH', notes: null, source: 'memory',
    links: { properties: [], loans: [], deals: ['d-target'], insurance: [] },
  },
];

function makeSnap(target: Partial<Deal> = {}): PortfolioSnapshot {
  const snap = {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-01', generatedAt: new Date().toISOString(), source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-01' },
    properties: [], leases: [], loans: [],
    cash: { asOf: '2026-06-01', totalCash: 1, activeEntities: 1, largestEntity: 'X', concentrationTopPct: 0.5, cagr: null, entities: [], history: [] },
    insurance: [],
    deals: [
      { ...deal({ id: 'd-target', name: TARGET_NAME, shortName: TARGET_SHORT, owner: TARGET_OWNER, stage: 'LOI/PSA', market: 'Columbus OH', ...target }), flags: [] },
      { ...deal({ id: 'd-pub', name: 'Public Sentinel Deal', stage: 'Candidate', market: 'Cincinnati OH', nextAction: `Compare pricing against ${TARGET_SHORT}` }), flags: [] },
    ],
    tasks: [], counterparties: COUNTERPARTIES,
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
  };
  return snap as unknown as PortfolioSnapshot;
}

function sse(...frames: object[]): string {
  return frames.map((f) => `event: x\ndata: ${JSON.stringify(f)}\n\n`).join('');
}
const toolUse = (index: number, id: string, name: string, input = '{}') => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input } },
  { type: 'content_block_stop', index },
];
const toolTurn = (...uses: Array<[string, string, string?]>) =>
  sse(...uses.flatMap(([id, name, input], i) => toolUse(i, id, name, input)), { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' });
const TEXT_TURN = sse(
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
);

/** Scripted model: responses[i] answers request i (TEXT_TURN after the script runs out). `onRequest`
 *  runs as request i arrives, before its response. Every request body is captured. */
function scriptedModel(responses: string[], onRequest: (i: number) => void = () => {}) {
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const i = bodies.length;
    bodies.push(init.body);
    onRequest(i);
    return new Response(responses[i] ?? TEXT_TURN, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies, fetchMock };
}

function toolResultFor(body: string, id: string): string {
  const msgs = (JSON.parse(body) as { messages: Array<{ content: unknown }> }).messages;
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; tool_use_id?: string; content?: string }>) {
      if (b.type === 'tool_result' && b.tool_use_id === id) return b.content ?? '';
    }
  }
  throw new Error(`no tool_result for ${id}`);
}

const firstError = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');

describe('runAgent with the REAL agentEgressGuards (live roster file, synthetic)', () => {
  it('a deal the roster claims (owner anchor) is withheld from get_deals and its residue redacted; the run completes', async () => {
    writeRoster(CLAIMING_ROSTER);
    const { bodies } = scriptedModel([toolTurn(['toolu_1', 'get_deals'])]);
    const events: AgentEvent[] = [];
    const snapshot = makeSnap();
    await runAgent({ question: 'what deals are live?', snapshot, apiKey: 'k', emit: (e) => void events.push(e), ...agentEgressGuards() });
    expect(bodies).toHaveLength(2);
    const r = toolResultFor(bodies[1]!, 'toolu_1');
    expect(r).not.toContain(TARGET_NAME);
    expect(r).not.toContain(TARGET_SHORT);
    expect(r).toContain('Public Sentinel Deal');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(snapshot.deals.find((d) => d.id === 'd-target')!.confidential).toBe(false); // captured snapshot untouched
  });

  it('a claim added after an earlier tool result carried the deal HALTS before that result is re-sent', async () => {
    const { bodies, fetchMock } = scriptedModel(
      [toolTurn(['toolu_1', 'get_deals']), toolTurn(['toolu_2', 'get_deals'])],
      (i) => { if (i === 1) writeRoster(CLAIMING_ROSTER); },
    );
    const events: AgentEvent[] = [];
    await runAgent({ question: 'what deals are live?', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e), ...agentEgressGuards() });
    expect(toolResultFor(bodies[1]!, 'toolu_1')).toContain(TARGET_NAME); // pre-claim: legitimately visible
    expect(fetchMock).toHaveBeenCalledTimes(2); // the request that would re-send it never goes out
    expect(firstError(events)!.message).not.toContain(TARGET_NAME);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('a claim landing DURING a same-turn await (get_macro) reaches get_deals even though get_deals came first', async () => {
    const { bodies } = scriptedModel([toolTurn(['toolu_1', 'get_deals'], ['toolu_2', 'get_macro'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'deals and rates?', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      macroProvider: async () => { writeRoster(CLAIMING_ROSTER); return null; },
      ...agentEgressGuards(),
    });
    // Awaited tools run first (wf_63d61f49-653), so get_deals is computed under the claim: withheld,
    // not halted after the fact.
    expect(bodies.slice(1).join('\n')).not.toContain(TARGET_NAME);
    expect(toolResultFor(bodies[1]!, 'toolu_1')).toContain('Public Sentinel Deal');
  });

  it('search_documents passages naming a claimed deal never reach the API (no tool-layer filter covers them)', async () => {
    writeRoster(CLAIMING_ROSTER);
    const { bodies } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"pipeline"}'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'what is in the pipeline docs?', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: 'Acquisitions/OM.pdf', snippet: `${TARGET_NAME} offering memorandum, asking $4.2M` }],
      ...agentEgressGuards(),
    });
    expect(bodies.some((b, i) => i > 0 && b.includes(TARGET_NAME))).toBe(false);
    expect(firstError(events)).toBeDefined();
  });

  it('a question or history naming a claimed deal is refused before ANY request', async () => {
    writeRoster(CLAIMING_ROSTER);
    const { fetchMock } = scriptedModel([]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'any update?', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      history: [{ role: 'assistant', text: `${TARGET_NAME} is at LOI/PSA, asking $4.2M.` }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstError(events)!.message).not.toContain(TARGET_NAME);
  });

  it('the placeholder roster refuses the run before any request (layer 2 no longer fails open)', async () => {
    usePlaceholderRoster();
    const { fetchMock } = scriptedModel([]);
    const events: AgentEvent[] = [];
    await runAgent({ question: 'hello', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e), ...agentEgressGuards() });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstError(events)).toBeDefined();
  });

  it('a clean run with an unclaiming roster is unaffected (no false halt)', async () => {
    const { bodies } = scriptedModel([toolTurn(['toolu_1', 'get_deals'])]);
    const events: AgentEvent[] = [];
    await runAgent({ question: 'what deals are live?', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e), ...agentEgressGuards() });
    expect(toolResultFor(bodies[1]!, 'toolu_1')).toContain(TARGET_NAME);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('server/index.ts POST /api/ai spreads agentEgressGuards and overrides none of its keys', () => {
    const route = routeSource("app.post('/api/ai'");
    // The spread is the last guard-bearing property (only `emit` may follow), it is spread bare (no
    // `&& {}`), and neither guard key appears anywhere else in the route — quoted, computed or shorthand.
    // Nothing may follow `emit` either: the object ends right after it.
    expect(route).toMatch(/\.\.\.agentEgressGuards\(\),\s*emit: async \(e\) => \{\s*await stream\.writeSSE\(\{ event: e\.type, data: JSON\.stringify\(e\) \}\);\s*\},\s*\}\);/);
    expect(route.match(/agentEgressGuards/g)).toHaveLength(1);
    expect(route).not.toMatch(/dealClaimed|confidentialScan|Claimed|Scan'|Scan"|\.\.\.(?!agentEgressGuards\(\)|snapshot\b)/);
    // The deals the live roster judges must be the FULL served rows (owner/lender anchors intact).
    expect(route).toContain('const snapshot = brain.getSnapshot();');
    expect(route).toContain('snapshot: { ...snapshot, governors: liveGovernors() },');
    expect(route.match(/\bsnapshot\b/g)).toHaveLength(4); // const, !snapshot guard, spread source, the key
  });

  // ── round 3 (wf_9509d62d-325) ──

  it('a newline INSIDE a claimed deal name in a search_documents passage does not evade the gate (scan sees the raw payload, not JSON escapes)', async () => {
    writeRoster(CLAIMING_ROSTER);
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap({ shortName: null }), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: 'OM.pdf', snippet: 'Offering: the Quillfeather\nFlex Park, 42,000 SF, asking $4.2M' }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstError(events)).toBeDefined();
  });

  it('the layer-2 re-scan HITS on a roster term that lands mid-turn, even split by a newline, and names only the label', async () => {
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'], ['toolu_2', 'get_macro'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: 'OM.pdf', snippet: 'Seller: Vantablack\nHoldings, asking $4.2M' }],
      macroProvider: async () => { writeRoster(CLAIMING_ROSTER); return null; },
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = firstError(events)!;
    expect(err.message).toContain('Claimed');
    expect(err.message).not.toMatch(/vantablack/i);
  });

  it('a passage naming a live-claimed (not yet flagged) deal only by its shortName halts', async () => {
    writeRoster(CLAIMING_ROSTER);
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: 'OM.pdf', snippet: `Comps memo: ${TARGET_SHORT} trades at a 7.9 cap` }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstError(events)).toBeDefined();
  });

  it('Easton rule: a FLAGGED deal\'s shortName inside unrelated text does not halt; its full name does', async () => {
    const flagged = makeSnap({ confidential: true });
    const run = async (snippet: string) => {
      const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'])]);
      const events: AgentEvent[] = [];
      await runAgent({
        question: 'q', snapshot: flagged, apiKey: 'k', emit: (e) => void events.push(e),
        docSearch: async () => [{ doc: 'Lease.pdf', snippet }],
        ...agentEgressGuards(),
      });
      vi.unstubAllGlobals();
      return { calls: fetchMock.mock.calls.length, events };
    };
    const coincidental = await run(`Suite 4, 12 ${TARGET_SHORT} Road, Dayton OH`);
    expect(coincidental.calls).toBe(2);
    expect(coincidental.events.at(-1)).toMatchObject({ type: 'done' });
    const named = await run(`${TARGET_NAME} rent roll`);
    expect(named.calls).toBe(1);
    expect(firstError(named.events)).toBeDefined();
  });

  // ── round 4 (wf_2e3ce239-ef6) ──

  it.each([
    ['underscore file name (ORA schema)', 'OM_Quillfeather_Flex_Park_10152026.pdf'],
    ['hyphenated slug folder', 'Acq/Quillfeather-Flex-Park/OM.pdf'],
    ['dotted name', 'Quillfeather.Flex.Park.OM.pdf'],
    ['name split across folders', 'Acq/Quillfeather/Flex Park/OM.pdf'],
  ])('a FLAGGED deal\'s full name joined by separators in a doc path halts (%s)', async (_label, docPath) => {
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap({ confidential: true }), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: docPath, snippet: 'offering memorandum' }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstError(events)).toBeDefined();
  });

  // ── round 5 (wf_b777d74a-3c4) ──

  it.each([
    ['lowercase slug', 'acq/quillfeather-flex-park/om.pdf', TARGET_NAME],
    ['uppercase file name', 'QUILLFEATHER_FLEX_PARK.pdf', TARGET_NAME],
    ['percent-encoded SharePoint link', 'https://oxfordra.sharepoint.com/sites/Acq/Shared%20Documents/Quillfeather%20Flex%20Park/OM.pdf', TARGET_NAME],
    ['%20 download file name', 'Downloads/Quillfeather%20Flex%20Park%20OM.pdf', TARGET_NAME],
    ['other separators (+ ~ : ;)', 'Quillfeather+Flex~Park:OM;pdf', TARGET_NAME],
    ['accented name vs ASCII path', 'OM_Quillfeather_Flex_Park.pdf', 'Quillféather Flex Park'],
    ['short CamelCase full name', 'LOI_ElmPark_10012026.pdf', 'Elm Park'],
    // round 6 (wf_0ac4e51b-97a)
    ['Safe Links double-encoded (%2520)', 'https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fora.sharepoint.com%2FShared%2520Documents%2FQuillfeather%2520Flex%2520Park%2520OM.pdf&data=05', TARGET_NAME],
    ['short name double-encoded', 'url=%2FDeals%2FElm%2520Park%2Fom.pdf', 'Elm Park'],
    ['invalid byte inside a valid run', 'Quillfeather%FF%20Flex%20Park.pdf', TARGET_NAME],
    ['short name split by a hyphenated wrap', 'premises known as Zor-\nvane, Suite 4', 'Zorvane'],
  ])('a FLAGGED deal\'s full name in a doc path halts (%s)', async (_label, docPath, name) => {
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap({ confidential: true, name, shortName: null }), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: docPath, snippet: 'offering memorandum' }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstError(events)).toBeDefined();
  });

  it('the turn>0 layer-2 re-scan reads only user-role content: model prose containing a flagged term does not false-halt (mirror shape)', async () => {
    const proseTurn = sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'climate risk in kentucky' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'checking kentucky' } },
      { type: 'content_block_stop', index: 1 },
      ...toolUse(2, 'toolu_1', 'get_macro'),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    );
    const { fetchMock } = scriptedModel([proseTurn]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      // A mirror-style substring scan on a short flagged shortName.
      confidentialScan: (v) => (JSON.stringify(v).toLowerCase().includes('kent') ? { dealLabel: 'x' } : null),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  // ── independent refute wf_63d61f49-653 ──

  it.each([
    ['spine tool first', [['toolu_1', 'get_relationships'], ['toolu_2', 'search_documents', '{"query":"om"}']]],
    ['awaited tool first', [['toolu_1', 'search_documents', '{"query":"om"}'], ['toolu_2', 'get_relationships']]],
  ] as const)('a claim landing during a same-turn await withholds the orphaned counterparty regardless of tool order (%s)', async (_label, uses) => {
    const { bodies } = scriptedModel([toolTurn(...(uses as unknown as Array<[string, string, string?]>))]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'who is counsel?', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => { writeRoster(CLAIMING_ROSTER); return [{ doc: 'notes.pdf', snippet: 'nothing relevant' }]; },
      ...agentEgressGuards(),
    });
    // Not vacuous (wf_02ab6da5-26c): the run must NOT halt early — the follow-up request goes out and
    // carries the get_relationships result, present but without the withheld counterparty.
    expect(bodies).toHaveLength(2);
    const rel = toolResultFor(bodies[1]!, uses.find((u) => u[1] === 'get_relationships')![0]);
    expect(rel.length).toBeGreaterThan(0);
    expect(rel).not.toContain('Vantreese');
    expect(rel).not.toContain('Marisol');
    const sentAfterClaim = bodies.slice(1).join('\n');
    expect(sentAfterClaim).not.toContain('Vantreese');
    expect(sentAfterClaim).not.toContain('Marisol');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('tool results are sent in the model\'s block order even though awaited tools run first', async () => {
    const { bodies } = scriptedModel([toolTurn(['toolu_1', 'get_deals'], ['toolu_2', 'get_macro'], ['toolu_3', 'search_documents', '{"query":"om"}'], ['toolu_4', 'get_portfolio_summary'])]);
    await runAgent({
      question: 'q', snapshot: makeSnap(), apiKey: 'k', emit: () => {},
      macroProvider: async () => null,
      docSearch: async () => [{ doc: 'notes.pdf', snippet: 'nothing relevant' }],
      ...agentEgressGuards(),
    });
    const msgs = (JSON.parse(bodies[1]!) as { messages: Array<{ role: string; content: unknown }> }).messages;
    const ids = (msgs.at(-1)!.content as Array<{ tool_use_id: string }>).map((b) => b.tool_use_id);
    expect(ids).toEqual(['toolu_1', 'toolu_2', 'toolu_3', 'toolu_4']);
  });

  // Invented sentinel (not a real road): "McZob Rd" folds to 7 alnum chars, under the compact-pass
  // minimum, so only the token-boundary pass with the right camel-split variant can match it.
  it.each([
    ['all-caps hyphen path', 'summarize MCZOB-RD_OM.pdf', 'McZob Rd'],
    ['lowercase folder', 'see mczob_rd folder', 'McZob Rd'],
    // Pins the NAME-side split variant: only "mc zob rd" (split name) meets this haystack.
    ['split haystack vs camel name', 'see Mc Zob-Rd folder', 'McZob Rd'],
    // Pins the HAYSTACK no-split variant: a camel haystack against a name with no camel boundary.
    ['camel haystack vs plain name', 'see McZob-Rd folder', 'Mczob Rd'],
  ])('a camelCase name is matched with and without the camel split (%s)', async (_label, question, name) => {
    const { fetchMock } = scriptedModel([]);
    const events: AgentEvent[] = [];
    await runAgent({
      question, snapshot: makeSnap({ confidential: true, name, shortName: null }), apiKey: 'k', emit: (e) => void events.push(e),
      ...agentEgressGuards(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstError(events)).toBeDefined();
  });

  it('a Latin-1 / escape() single-byte escape (%E9) in a doc path does not evade the gate (#478)', async () => {
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap({ confidential: true, name: 'Quillféather Flex Park', shortName: null }), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: 'Acq/Quillf%E9ather%20Flex%20Park/OM.pdf', snippet: 'offering memorandum' }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstError(events)).toBeDefined();
  });

  it('a Safe Links URL pasted in the QUESTION naming a flagged deal is refused before any request', async () => {
    const { fetchMock } = scriptedModel([]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'summarize https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fora.sharepoint.com%2FShared%2520Documents%2FQuillfeather%2520Flex%2520Park%2520OM.pdf',
      snapshot: makeSnap({ confidential: true }), apiKey: 'k', emit: (e) => void events.push(e),
      ...agentEgressGuards(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstError(events)).toBeDefined();
  });

  it('the turn>0 layer-2 re-scan still covers client-supplied ASSISTANT-role history', async () => {
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'get_macro'])], (i) => { if (i === 0) writeRoster(CLAIMING_ROSTER); });
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      history: [{ role: 'assistant', text: 'the seller is Vantablack Holdings' }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstError(events)!.message).toContain('Claimed');
  });

  it('a full name broken by a hyphenated line wrap halts', async () => {
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap({ confidential: true }), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: 'OM.pdf', snippet: 'Quillfeather Flex Pa-\nrk offering memorandum' }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opaque API tokens (thinking signature, redacted_thinking data, tool ids) never false-halt a clean run', async () => {
    const opaque = 'QuillfeatherFlexPark' + 'x'.repeat(8); // base64-ish blob that happens to contain the name
    const thinkingTurn = sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me look' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: opaque } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: opaque } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: `toolu_${opaque}`, name: 'get_macro' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    );
    const { fetchMock } = scriptedModel([thinkingTurn]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap({ confidential: true }), apiKey: 'k', emit: (e) => void events.push(e),
      ...agentEgressGuards(),
      // The mirror's shape: a name-based scan. It must not see the opaque fields either.
      confidentialScan: (v) => (JSON.stringify(v).toLowerCase().includes('quillfeatherflexpark') ? { dealLabel: 'x' } : null),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('a roster that becomes unreadable mid-run surfaces the sanitized guard message, never the roster path', async () => {
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'search_documents', '{"query":"om"}'])], (i) => {
      if (i === 0) rmSync(rosterPath, { force: true });
    });
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      docSearch: async () => [{ doc: 'OM.pdf', snippet: 'clean passage' }],
      ...agentEgressGuards(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = firstError(events)!;
    expect(err.message).toBe(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
    expect(err.message).not.toContain(dir);
  });
});

describe('runAgent with an injected dealClaimed predicate (unit level)', () => {
  it('fails CLOSED per deal when the live check throws: nothing about any deal is sent, the run still completes', async () => {
    const { bodies } = scriptedModel([toolTurn(['toolu_1', 'get_deals'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'what deals are live?', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      confidentialScan: () => null,
      dealClaimed: () => { throw new Error('roster unreadable'); },
    });
    // Every deal is withheld from the tool, so the egress gate has nothing to halt on.
    const r = toolResultFor(bodies[1]!, 'toolu_1');
    expect(r).not.toContain(TARGET_NAME);
    expect(r).not.toContain('Public Sentinel Deal');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('a gate re-scan that throws on a later turn surfaces the guard-unavailable refusal and sends nothing further', async () => {
    let calls = 0;
    const { fetchMock } = scriptedModel([toolTurn(['toolu_1', 'get_deals'])]);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'q', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e),
      dealClaimed: () => false,
      // input scan + tool-result scan succeed; the pre-request re-scan of `messages` throws.
      confidentialScan: () => { calls++; if (calls > 2) throw new Error(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE); return null; },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstError(events)!.message).toBe(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
  });

  it('without dealClaimed injected (the mirror), the egress gate is off: flag-only behavior unchanged', async () => {
    const { bodies } = scriptedModel([toolTurn(['toolu_1', 'get_deals'])]);
    const events: AgentEvent[] = [];
    await runAgent({ question: 'what deals are live?', snapshot: makeSnap(), apiKey: 'k', emit: (e) => void events.push(e) });
    expect(toolResultFor(bodies[1]!, 'toolu_1')).toContain(TARGET_NAME);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('rosterClaimsDeal sanity: the synthetic owner anchor is what claims the deal', () => {
    writeRoster(CLAIMING_ROSTER);
    expect(rosterClaimsDeal(deal({ name: TARGET_NAME, owner: TARGET_OWNER }))).toBe(true);
    expect(rosterClaimsDeal(deal({ name: TARGET_NAME }))).toBe(false);
  });
});
