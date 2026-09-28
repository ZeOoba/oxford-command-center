// tests/unit/ai-agent-confidential-egress.test.ts
//
// OI-225 — Hard Invariant 3 on the Anthropic-API egress path.
//
// `get_deals` and `search_entities` already drop `confidential:true` rows. `get_alerts`
// (-> evaluateConditions) and `get_relationships` did not, and `runAgent` appended tool results
// verbatim into the outbound `messages` with no pre-send scan — unlike comps.ts, om-extract.ts and
// narrative.ts, which all fail closed on this same egress. These tests pin both layers:
//
//   layer 1 (primary, runtime-agnostic): drop confidential rows at the TOOL boundary, keyed on the
//           `confidential` FLAG. Works on the Cloudflare mirror, which bakes WITH confidential data.
//   layer 2 (defense-in-depth, server-only): an INJECTED term scan over every tool result before it
//           enters `messages`. Injected, not imported — agent.ts is runtime-agnostic and
//           server/briefing/confidential.ts pulls in node:fs / node:os.
//
// The filter belongs in tools.ts, NOT conditions.ts: the dashboard and the briefing legitimately
// show Gabriel his own confidential alerts. It is the AI egress that must not carry them.
import { describe, it, expect, vi } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { runTool } from '../../server/ai/tools';
import { runAgent, type AgentEvent } from '../../server/ai/agent';

/** A deal name that must never reach the API, plus the shortName the alert titles actually use. */
const SECRET_NAME = 'Zephyr Logistics Center — Walker, MI';
const SECRET_SHORT = 'Zephyr';

/** `get_alerts` evaluates against the RUN date, not the snapshot date, so the LOI/PSA deadline
 *  window has to be anchored to now or the alert never fires and the test passes vacuously. */
function daysFromNow(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function makeSnap(): PortfolioSnapshot {
  const snap = {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-01', generatedAt: new Date().toISOString(), source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-01' },
    properties: [
      { id: 'p1', index: 1, name: '29000 Information Lane, Easton MD', address: '29000 Information Lane', city: null, state: null, market: 'Mid-Atlantic', type: 'Flex', sf: 48000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 7310000, grossIncome: 0, expenses: 0, noi: 511000, noiScenarioAdj: 511000, debtService: 0, netCashFlow: 0, capRate: 0.07, dscr: 2.45, lender: 'Symetra', loanBalance: 2770000, ltv: 0.38, valuePerSf: null, rentPerSf: null, equityInvested: 1000000, cashOnCash: null, holdYrs: null, encumbered: true, flags: [] },
    ],
    leases: [],
    loans: [],
    cash: { asOf: '2026-06-01', totalCash: 1, activeEntities: 1, largestEntity: 'FVC', concentrationTopPct: 0.5, cagr: null, entities: [], history: [] },
    insurance: [],
    deals: [
      {
        id: 'd-conf', name: SECRET_NAME, shortName: SECRET_SHORT, confidential: true,
        stage: 'LOI/PSA', market: 'Midwest', sf: 60000, estPrice: 5_000_000, capRate: 0.08, irr: 0.15,
        targetCloseDate: daysFromNow(5), nextAction: 'Wire earnest money to escrow', flags: [],
      },
      {
        id: 'd-pub', name: 'Public Deal — Columbus, OH', shortName: 'Public Deal', confidential: false,
        stage: 'LOI/PSA', market: 'Columbus', sf: 30000, estPrice: 2_000_000, capRate: 0.09, irr: 0.14,
        // Free-text residue: a human cross-referenced the confidential deal from a PUBLIC deal's
        // next-action. Dropping rows by id alone leaks this. bake-mirror hit the identical case
        // (its "free-text residue sweep (refute finding, high)").
        targetCloseDate: daysFromNow(6), nextAction: `Compare pricing against ${SECRET_SHORT} before signing`, flags: [],
      },
    ],
    tasks: [],
    counterparties: [
      // Linked ONLY to the confidential deal: an orphaned counsel name + market identifies the deal.
      { id: 'cp-only', name: 'Hale & Marsh LLP', kind: 'counsel', firm: 'Hale & Marsh', role: 'Buyer counsel', email: 'partner@halemarsh.example', phone: null, market: 'Midwest', notes: null, source: 'memory', links: { properties: [], loans: [], deals: ['d-conf'], insurance: [] } },
      // Linked to the confidential deal AND a property: survives, because it is not orphaned BY the
      // redaction — the property link stands on its own.
      { id: 'cp-mixed', name: 'Symetra', kind: 'lender', firm: 'Symetra', role: 'Lender', email: null, phone: null, market: 'Mid-Atlantic', notes: null, source: 'workbook', links: { properties: ['p1'], loans: [], deals: ['d-conf'], insurance: [] } },
      // Untouched by any confidential link.
      { id: 'cp-clean', name: 'Kegler Brown', kind: 'counsel', firm: 'Kegler Brown', role: 'Counsel', email: null, phone: null, market: 'Columbus', notes: null, source: 'memory', links: { properties: [], loans: [], deals: ['d-pub'], insurance: [] } },
    ],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
  };
  return snap as unknown as PortfolioSnapshot;
}

/** Everything the tool hands the model: payload AND citation refs. A ref label leaks a name just as
 *  effectively as the payload does — refs are rendered as chips and echoed back in the answer. */
function egressText(r: { data: unknown; refs: unknown }): string {
  return JSON.stringify(r);
}

/** A PUBLIC loan whose own name coincidentally contains the confidential deal's shortName as a
 *  substring ("Zephyr Point..." vs. shortName "Zephyr") — NOT the confidential deal (its
 *  `entityId` never equals d-conf's id). Kept OUT of the shared `makeSnap()` fixture deliberately:
 *  post-fix, this loan's real name legitimately reaches the egress (see the title-collision test
 *  below), which would make every OTHER test's blanket `not.toContain(SECRET_SHORT)` assertion
 *  fail for the wrong reason. Balloon <180d on a `borrower` loan -> CRITICAL. */
function collisionLoan() {
  return { id: 'l-collide', name: `${SECRET_SHORT} Point Distribution Loan`, counterparty: 'Third-Party Borrower', direction: 'borrower', originalPrincipal: null, currentBalance: 1500000, absBalance: 1500000, rate: 0.07, monthlyPmt: 9000, annualInterest: null, annualPrincipal: null, loanType: 'Balloon', status: 'Balloon', isDemand: false, maturity: daysFromNow(60), monthsToMaturity: 2, ltv: 0.5, lender: 'Symetra', balloon: true, flags: [] };
}

describe('OI-225 layer 1 — tool boundary drops confidential rows', () => {
  it('get_alerts does not emit the confidential deal name or shortName', () => {
    const out = egressText(runTool('get_alerts', makeSnap(), {}));
    expect(out).not.toContain(SECRET_NAME);
    expect(out).not.toContain(SECRET_SHORT);
  });

  it('get_alerts still emits the non-confidential deal alert (the filter is not a blanket mute)', () => {
    const out = egressText(runTool('get_alerts', makeSnap(), {}));
    expect(out).toContain('Public Deal');
  });

  it('get_alerts redacts (not drops) the residue in a PUBLIC row and keeps the row itself', () => {
    // Distinct from the id-based drop test above: this pins the REDACTION mechanism specifically,
    // not just the absence of the term — a bug that dropped the whole row instead of scrubbing it
    // would pass the "not.toContain" checks too and this is the test that would have caught it.
    const data = runTool('get_alerts', makeSnap(), {}).data as { alerts: Array<{ title: string; detail: string }> };
    const pub = data.alerts.find((a) => a.title.includes('Public Deal'));
    expect(pub).toBeDefined();
    expect(pub!.detail).toBe('Detail withheld — references a confidential deal.');
  });

  it('get_alerts leaves a title-only coincidental collision COMPLETELY UNTOUCHED (2nd refute pass)', () => {
    // The "Easton" class of bug started as a full-row DROP (denial of signal), was "fixed" to a
    // REDACT-IN-PLACE that still blanked a provably-clean detail (2nd refute pass, Finding 1) and
    // was itself no real protection (Finding 2: the identical public loan name is already reachable
    // unfiltered via get_loans in the same conversation — redacting it here only manufactured a
    // "something withheld" tell for zero confidentiality benefit). Correct final behavior: a title
    // match alone does NOT redact anything — the row is real data about a real, unrelated loan.
    const snap = makeSnap();
    (snap as unknown as { loans: unknown[] }).loans = [collisionLoan()];
    const data = runTool('get_alerts', snap, {}).data as {
      critical: number;
      alerts: Array<{ severity: string; category: string; title: string; detail: string }>;
    };
    expect(data.critical).toBeGreaterThanOrEqual(1);
    const collision = data.alerts.find((a) => a.category === 'debt' && a.severity === 'critical');
    expect(collision).toBeDefined();
    // Real title, real detail — nothing redacted. This IS the intentional "leak" of SECRET_SHORT:
    // it is the public loan's own name, not the confidential deal, and full disclosure by design.
    expect(collision!.title).toBe('Balloon due — Zephyr Point Distribution Loan');
    expect(collision!.detail).toContain('$1,500,000 balance');
    // The one thing that must still never appear: the confidential deal's FULL name/address. A
    // shared common word (its shortName) legitimately can; the identifying string may not.
    expect(egressText({ data, refs: [] })).not.toContain(SECRET_NAME);
  });

  it('get_alerts still redacts genuine detail residue when a DIFFERENT row also has a title collision present', () => {
    // Regression guard for Finding 1: a title-only hit on one row must not suppress the (correct,
    // independent) detail redaction on another row in the same result set.
    const snap = makeSnap();
    (snap as unknown as { loans: unknown[] }).loans = [collisionLoan()];
    const data = runTool('get_alerts', snap, {}).data as { alerts: Array<{ title: string; detail: string }> };
    const pub = data.alerts.find((a) => a.title.includes('Public Deal'));
    expect(pub!.detail).toBe('Detail withheld — references a confidential deal.');
  });

  it('get_relationships drops a counterparty orphaned by the redaction', () => {
    const out = egressText(runTool('get_relationships', makeSnap(), {}));
    expect(out).not.toContain('Hale & Marsh');
    expect(out).not.toContain('partner@halemarsh.example');
  });

  it('get_relationships keeps counterparties with links that survive the redaction', () => {
    const out = egressText(runTool('get_relationships', makeSnap(), {}));
    expect(out).toContain('Symetra');
    expect(out).toContain('Kegler Brown');
  });

  it('get_alerts leaks nothing even when the confidential deal is the ONLY deal', () => {
    const snap = makeSnap();
    (snap as unknown as { deals: unknown[] }).deals = [(snap as unknown as { deals: unknown[] }).deals[0]];
    const out = egressText(runTool('get_alerts', snap, {}));
    expect(out).not.toContain(SECRET_NAME);
    expect(out).not.toContain(SECRET_SHORT);
  });

  it('get_deals redacts residue in a PUBLIC deal\'s own nextAction (refute finding, CRITICAL)', () => {
    // This is the fixture's own d-pub.nextAction — a human cross-referenced the confidential deal
    // by name. Dropping rows by `confidential` alone (the pre-fix behavior) missed this entirely.
    const data = runTool('get_deals', makeSnap(), {}).data as Array<{ name: string; nextAction: string }>;
    expect(data).toHaveLength(1); // the confidential deal itself is still dropped
    expect(data[0]!.name).toBe('Public Deal — Columbus, OH');
    expect(data[0]!.nextAction).toBe('Detail withheld — references a confidential deal.');
  });

  it('get_deals leaves a PUBLIC deal\'s nextAction untouched when it has no residue', () => {
    // Guard against over-redaction: this must not become a blanket mute on every nextAction.
    const snap = makeSnap();
    const pub = (snap as unknown as { deals: Array<{ id: string; nextAction: string }> }).deals.find((d) => d.id === 'd-pub')!;
    pub.nextAction = 'Schedule the property tour for next week.';
    const data = runTool('get_deals', snap, {}).data as Array<{ nextAction: string }>;
    expect(data[0]!.nextAction).toBe('Schedule the property tour for next week.');
  });

  it('search_entities does not return the counterparty orphaned by the redaction (refute finding, HIGH)', () => {
    // get_relationships already drops 'Hale & Marsh LLP'; search_entities must apply the identical
    // rule — a bug that filtered only get_relationships was still reachable via search.
    const r = runTool('search_entities', makeSnap(), { query: 'hale' });
    expect(egressText(r)).not.toContain('Hale & Marsh');
  });

  it('search_entities does not return a counterparty whose own free text names the confidential deal', () => {
    const snap = makeSnap();
    (snap as unknown as { counterparties: Array<Record<string, unknown>> }).counterparties.push({
      id: 'cp-seller', name: `${SECRET_SHORT} Logistics LLC`, kind: 'principal', firm: null, role: 'Seller principal',
      email: null, phone: null, market: 'Midwest', notes: null, source: 'memory',
      links: { properties: ['p1'], loans: [], deals: [], insurance: [] }, // property-linked: not orphaned
    });
    const r = runTool('search_entities', snap, { query: 'logistics' });
    expect(egressText(r)).not.toContain(SECRET_SHORT);
  });

  it('search_entities still returns a counterparty that survives the redaction', () => {
    const r = runTool('search_entities', makeSnap(), { query: 'symetra' });
    expect(egressText(r)).toContain('Symetra');
  });
});

/** One SSE frame set: the model calls `get_leases`, then (if it gets there) answers. */
function sse(...frames: object[]): string {
  return frames.map((f) => `event: x\ndata: ${JSON.stringify(f)}\n\n`).join('');
}
const TURN_TOOL = sse(
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_alerts' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
);
const TURN_TEXT = sse(
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
);

describe('OI-225 layer 2 — injected pre-send scan on the agent egress', () => {
  it('halts the turn loop and emits an error when a tool result trips the scan', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(bodies.length === 1 ? TURN_TOOL : TURN_TEXT, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: AgentEvent[] = [];
    await runAgent({
      question: 'any deadlines?', snapshot: makeSnap(), apiKey: 'test-key',
      emit: (e) => void events.push(e),
      // Stand-in for server/briefing/confidential.ts's scanForConfidential. Trips on TOOL results only
      // (the question/history input scan passes {question, history}), so this pins the tool-result path.
      confidentialScan: (v) => (v && typeof v === 'object' && 'question' in v ? null : { dealLabel: 'Confidential Deal' }),
    });
    vi.unstubAllGlobals();

    // The leaked result must never be sent: exactly ONE request (the one that asked for the tool).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(err).toBeDefined();
    // Never widen the leak: report the label, never the matched term or the payload.
    expect(err!.message).toContain('Confidential Deal');
    expect(err!.message).not.toContain(SECRET_NAME);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('refuses BEFORE any request when the user question or history trips the scan (input egress)', async () => {
    const fetchMock = vi.fn(async () => new Response(TURN_TEXT, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: unknown[] = [];
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'summarize SyntheticDeal Plaza', snapshot: makeSnap(), apiKey: 'test-key',
      history: [{ role: 'user', text: 'earlier turn' }, { role: 'assistant', text: 'SyntheticDeal answer' }],
      emit: (e) => void events.push(e),
      confidentialScan: (v) => { seen.push(v); return { dealLabel: 'Synthetic Deal' }; },
    });
    vi.unstubAllGlobals();
    expect(fetchMock).not.toHaveBeenCalled();
    // The scan saw BOTH the question and every history turn.
    expect(JSON.stringify(seen[0])).toContain('SyntheticDeal Plaza');
    expect(JSON.stringify(seen[0])).toContain('SyntheticDeal answer');
    const err = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(err!.message).toContain('Synthetic Deal');
    expect(err!.message).not.toContain('SyntheticDeal Plaza');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('fails CLOSED before any request when the input scan throws (roster unavailable)', async () => {
    const fetchMock = vi.fn(async () => new Response(TURN_TEXT, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const events: AgentEvent[] = [];
    await runAgent({
      question: 'any deadlines?', snapshot: makeSnap(), apiKey: 'test-key',
      emit: (e) => void events.push(e),
      confidentialScan: () => { throw new Error('roster missing at C:/secret/path'); },
    });
    vi.unstubAllGlobals();
    expect(fetchMock).not.toHaveBeenCalled();
    const err = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.message).not.toContain('C:/secret/path');
  });

  it('is a no-op when the scan finds nothing — the loop completes normally', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(bodies.length === 1 ? TURN_TOOL : TURN_TEXT, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: AgentEvent[] = [];
    await runAgent({
      question: 'any deadlines?', snapshot: makeSnap(), apiKey: 'test-key',
      emit: (e) => void events.push(e),
      confidentialScan: () => null,
    });
    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toContain('tool_result');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('runs unchanged with NO scan injected — the mirror surface keeps working on layer 1 alone', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(bodies.length === 1 ? TURN_TOOL : TURN_TEXT, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: AgentEvent[] = [];
    await runAgent({ question: 'any deadlines?', snapshot: makeSnap(), apiKey: 'test-key', emit: (e) => void events.push(e) });
    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    // Layer 1 must hold on its own here — this is exactly the mirror's configuration.
    expect(bodies[1]).not.toContain(SECRET_NAME);
    expect(bodies[1]).not.toContain(SECRET_SHORT);
  });
});
