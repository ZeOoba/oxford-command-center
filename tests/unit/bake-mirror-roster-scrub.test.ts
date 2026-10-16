// Refute round 5, F1: scripts/bake-mirror.ts wrote public/snapshot.json with no roster scan.
// redactConfidential only checks the NAMES of flagged deals by raw lowercase substring, so a
// tenantNote 'Kestrel<NBSP>Ridge expansion' or a task 'Send PSA redline — Kestrel-Ridge' survived,
// and an `always` ADDRESS term in a task / note / flag was never checked at all. rosterScrubSnapshot
// now runs the normalised egress roster match over every leaf of the redacted snapshot: free-text
// records that hit are dropped (or their free-text field nulled), and any residual hit, or an
// unreadable / placeholder roster, refuses the bake. Synthetic names and addresses only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot, Deal } from '../../src/contracts/index';
import { redactConfidential, rosterScrubSnapshot } from '../../scripts/bake-mirror';

const cp = (...n: number[]) => String.fromCodePoint(...n);
const ROSTER = {
  syn: { label: 'Synthetic', active: true, always: ['Kestrel Ridge', '9900 Quarry Rd'] },
};

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

const snap = (over: Record<string, unknown> = {}): PortfolioSnapshot => ({
  meta: { asOf: '2026-10-01', scenario: 'base' },
  properties: [{ id: 'p1', name: 'Public Flex Center' }],
  leases: [{ id: 'l1', tenant: 'Acme Tooling' }],
  loans: [], insurance: [],
  deals: [
    deal({ id: 'kestrel-ridge', name: 'Kestrel Ridge', confidential: true }),
    deal({ id: 'pub', name: 'Public Yard', nextAction: 'tour Friday', status: 'LOI out' }),
  ],
  counterparties: [{ id: 'c1', name: 'Plain Bank', notes: 'met at conference', links: { deals: [], properties: ['p1'], loans: [], insurance: [] } }],
  tasks: [{ id: 't1', label: 'Renew insurance', notes: null }],
  tenantNotes: { 'acme-tooling': 'pays on time' },
  dealComps: {}, acquisitionInputs: {}, renewalStages: {}, tenantArrears: {}, marketRents: {}, noiBudgets: {},
  dataQuality: [],
  ...over,
} as unknown as PortfolioSnapshot);

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'bake-scrub-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
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

/** The production order: name-based redaction first, then the roster scrub. */
const bake = (s: PortfolioSnapshot) => rosterScrubSnapshot(redactConfidential(s).snapshot);

describe('the reviewer triggers survive name redaction but not the roster scrub', () => {
  // CHANGED by the merge with origin/main (c04bf53b): main's redactConfidential matches flagged deal
  // names with the NORMALISED mentionsAnyTerm, so an NBSP variant ('Kestrel<NBSP>Ridge') is now
  // removed by the name sweep itself and no longer proves the scrub's value. These two tests used
  // that NBSP variant (precondition: `Kestrel${cp(0xa0)}Ridge expansion` survived redaction; the
  // drop test baked it). They now use variants main's normaliser genuinely MISSES and only the
  // roster-core matcher (via the egress roster scrub) catches: a private-use character inside the
  // word (main's invisible table has no \p{Co}) and a PDF line-end hyphen (main does not rejoin
  // 'Kes-<LF>trel'). The task keeps its hyphen variant, which main's name sweep also misses.
  const PUA_VARIANT = `Kest${cp(0xe000)}rel Ridge expansion`;
  const LINE_END_HYPHEN_VARIANT = `Kes-${cp(10)}trel Ridge expansion`;
  it('precondition: name-based redaction alone lets the variants through', () => {
    const s = snap({
      tenantNotes: { 'acme-tooling': PUA_VARIANT, beta: LINE_END_HYPHEN_VARIANT },
      tasks: [{ id: 't1', label: 'Send PSA redline — Kestrel-Ridge', notes: null }],
    });
    const r = redactConfidential(s).snapshot;
    expect(Object.keys(r.tenantNotes)).toHaveLength(2);
    expect(r.tasks).toHaveLength(1);
  });
  it('the NBSP variant is now removed by the normalised name sweep itself (main c04bf53b)', () => {
    const r = redactConfidential(snap({ tenantNotes: { 'acme-tooling': `Kestrel${cp(0xa0)}Ridge expansion`, other: 'fine' } })).snapshot;
    expect(r.tenantNotes).toEqual({ other: 'fine' });
  });
  it.each([
    ['private-use character inside the word', PUA_VARIANT],
    ['PDF line-end hyphen', LINE_END_HYPHEN_VARIANT],
  ])('%s variant in a tenantNote is dropped by the roster scrub', (_n, note) => {
    const out = bake(snap({ tenantNotes: { 'acme-tooling': note, other: 'fine' } }));
    expect(out.snapshot.tenantNotes).toEqual({ other: 'fine' });
    expect(out.dropped).toBeGreaterThan(0);
  });
  it('hyphen variant in a task is dropped', () => {
    const out = bake(snap({ tasks: [{ id: 't1', label: 'Send PSA redline — Kestrel-Ridge', notes: null }, { id: 't2', label: 'Renew insurance', notes: null }] }));
    expect(out.snapshot.tasks.map((t) => t.id)).toEqual(['t2']);
  });
  it.each<[string, Record<string, unknown>, (s: PortfolioSnapshot) => unknown]>([
    ['task notes', { tasks: [{ id: 't1', label: 'Call', notes: 're 9900 Quarry Rd' }] }, (s) => s.tasks],
    ['tenantNote', { tenantNotes: { a: 'Visited 9900 Quarry Rd' } }, (s) => s.tenantNotes],
    ['counterparty note', { counterparties: [{ id: 'c1', name: 'Plain Bank', notes: 'lender on 9900 Quarry Rd', links: { deals: [], properties: ['p1'], loans: [], insurance: [] } }] }, (s) => s.counterparties[0]?.notes ?? null],
    ['dataQuality flag', { dataQuality: [{ entity: 'deals', field: 'location', issue: 'geocode failed for 9900 Quarry Rd', severity: 'warn' }] }, (s) => s.dataQuality],
    ['public deal nextAction', { deals: [deal({ id: 'pub', name: 'Public Yard', nextAction: 'compare with 9900 Quarry Rd' })] }, (s) => s.deals[0]?.nextAction ?? null],
    ['public deal status', { deals: [deal({ id: 'pub', name: 'Public Yard', status: `near 9900${cp(0x200b)} Quarry Rd` })] }, (s) => s.deals[0]?.status ?? null],
  ])('an always ADDRESS term in a %s is removed', (_n, over, pick) => {
    const out = bake(snap(over));
    const left = pick(out.snapshot);
    expect(left === null || (Array.isArray(left) && left.length === 0) || (typeof left === 'object' && Object.keys(left as object).length === 0)).toBe(true);
    expect(JSON.stringify(out.snapshot).toLowerCase()).not.toContain('quarry');
  });
  it('a roster term in a record KEY is dropped (tenantNotes / dealComps / renewalStages)', () => {
    const out = bake(snap({
      tenantNotes: { 'kestrel-ridge-llc': 'ok' },
      dealComps: { 'kestrel-ridge': { summary: 'x' } },
      renewalStages: { 'kestrel ridge lease': { stage: 'renewal' } },
    }));
    expect(out.snapshot.tenantNotes).toEqual({});
    expect(out.snapshot.dealComps).toEqual({});
    expect(out.snapshot.renewalStages).toEqual({});
  });
  it('a public deal the roster still claims is dropped whole', () => {
    const out = bake(snap({ deals: [deal({ id: 'x', name: 'Yard', location: '9900 Quarry Rd' })] }));
    expect(out.snapshot.deals).toEqual([]);
  });
  it('a clean snapshot passes through with nothing dropped', () => {
    const s = snap();
    const out = bake(s);
    expect(out.dropped).toBe(0);
    expect(out.snapshot.tasks).toEqual(s.tasks);
    expect(out.snapshot.tenantNotes).toEqual(s.tenantNotes);
  });
});

describe('residual hits and an unverifiable roster refuse the bake', () => {
  it('a hit in a field with no droppable record (a property name) refuses', () => {
    expect(() => bake(snap({ properties: [{ id: 'p1', name: `Kestrel${cp(0xa0)}Ridge Flex` }] }))).toThrow(/refusing to bake/i);
  });
  it('a hit in a lease refuses', () => {
    expect(() => bake(snap({ leases: [{ id: 'l1', tenant: 'Tenant at 9900 Quarry Rd' }] }))).toThrow(/refusing to bake/i);
  });
  it('the refusal names no term and no label', () => {
    let msg = '';
    try { bake(snap({ properties: [{ id: 'p1', name: 'Kestrel Ridge Flex' }] })); } catch (e) { msg = (e as Error).message; }
    expect(msg.toLowerCase()).not.toMatch(/kestrel|quarry|synthetic/);
  });
  it('placeholder roster refuses', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    expect(() => bake(snap())).toThrow(/refusing to bake/i);
  });
  it('unreadable roster refuses', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(() => bake(snap())).toThrow(/refusing to bake/i);
  });
});
