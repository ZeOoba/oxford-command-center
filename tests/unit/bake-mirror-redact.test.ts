import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Deal } from '../../src/contracts/index';
import type { Counterparty } from '../../src/contracts/counterparty';
import { redactConfidential, refuseBakeOnDegradedDeals } from '../../scripts/bake-mirror';

/**
 * REFUTE-PASS FINDING (MEDIUM). The 2026-08-11 seed-wipe fix threaded DealsLoad.degraded through
 * ParseResult so "each writer can apply its own policy", and gated Brain.persist — but bake-mirror
 * destructured only `{ snapshot }` and wrote public/snapshot.json regardless. That is the payload
 * served by the PUBLIC brain.oxfordra.net mirror, so a transient Notion `fetch failed` during a
 * scheduled bake published the ~6-deal seed placeholder set over the ~20-deal live pipeline to an
 * EXTERNAL surface, at exit 0 — the 2026-08-09 mode, on the worst possible surface.
 */
describe('bake-mirror — refuses to bake a degraded deals source to the public mirror', () => {
  it('returns a refusal reason for every data-losing degradation', () => {
    for (const reason of ['fetch-failed', 'empty-result', 'not-configured'] as const) {
      const out = refuseBakeOnDegradedDeals({ reason, detail: 'x' });
      expect(out, `reason ${reason} must refuse`).not.toBeNull();
      expect(out).toContain(reason);
    }
  });

  it('permits the bake when the deals source is live', () => {
    expect(refuseBakeOnDegradedDeals(null)).toBeNull();
  });
});

// I8 (bake-redact-keeps-confidential-counterparties): redaction removed confidential deals and
// filtered links.deals, but KEPT the counterparty entity — an orphaned lender name + market in the
// public bake identifies the confidential deal it financed. Hard Invariant 3.

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'LOI/PSA', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

const cp = (o: Partial<Counterparty>): Counterparty => ({
  id: 'c', name: 'C', kind: 'lender', firm: null, role: null, email: null, phone: null,
  market: null, notes: null, source: 'workbook',
  links: { properties: [], loans: [], deals: [], insurance: [] }, ...o,
});

const task = (o: Record<string, unknown>) => ({
  id: 't', label: 'Ordinary ops task', section: 'Ops', role: null, type: null,
  dueDay: null, notes: null, status: 'pending', monthlyPmt: null, ...o,
});

const snap = (
  deals: Deal[],
  counterparties: Counterparty[],
  extra: Record<string, unknown> = {},
): PortfolioSnapshot =>
  ({ deals, counterparties, tasks: [], dealComps: {}, acquisitionInputs: {}, tenantNotes: {}, ...extra } as unknown as PortfolioSnapshot);

describe('redactConfidential — orphaned-counterparty residue (I8)', () => {
  it('drops a counterparty orphaned by deal redaction — no lender name/kind/market residue', () => {
    const s = snap(
      [deal({ id: 'deal-x', name: 'Quiet Deal', confidential: true })],
      [cp({
        id: 'lender-1', name: 'Heartland Bank', market: 'Columbus OH',
        links: { properties: [], loans: [], deals: ['deal-x'], insurance: [] },
      })],
    );
    const { snapshot, removed, removedCounterparties } = redactConfidential(s);
    expect(snapshot.deals).toHaveLength(0);
    expect(snapshot.counterparties).toHaveLength(0);
    expect(JSON.stringify(snapshot)).not.toContain('Heartland');
    expect(removed).toContain('Quiet Deal');
    expect(removedCounterparties).toContain('Heartland Bank');
  });

  it('keeps a counterparty that retains links elsewhere — only the confidential deal link is filtered', () => {
    const s = snap(
      [deal({ id: 'deal-x', name: 'Quiet Deal', confidential: true }), deal({ id: 'deal-y', name: 'Public Deal' })],
      [cp({
        id: 'lender-2', name: 'Busy Bank',
        links: { properties: ['prop-1'], loans: [], deals: ['deal-x', 'deal-y'], insurance: [] },
      })],
    );
    const { snapshot } = redactConfidential(s);
    const kept = snapshot.counterparties.find((c) => c.id === 'lender-2')!;
    expect(kept).toBeDefined();
    expect(kept.links.deals).toEqual(['deal-y']);
    expect(kept.links.properties).toEqual(['prop-1']);
  });

  it('keeps linkless memory-seeded nodes — they were not orphaned BY the redaction', () => {
    const s = snap(
      [deal({ id: 'deal-x', name: 'Quiet Deal', confidential: true })],
      [cp({
        id: 'counsel-1', name: 'Philip Collins', kind: 'counsel', source: 'memory',
        links: { properties: [], loans: [], deals: [], insurance: [] },
      })],
    );
    const { snapshot, removedCounterparties } = redactConfidential(s);
    expect(snapshot.counterparties).toHaveLength(1);
    expect(removedCounterparties).toHaveLength(0);
  });

  it('drops tasks whose label or notes mention a removed deal name (M365 To-Do residue)', () => {
    const s = snap(
      [deal({ id: 'deal-x', name: 'Quiet Deal', shortName: 'QD-Short', confidential: true })],
      [],
      {
        tasks: [
          task({ id: 't1', label: 'Send PSA redline — Quiet Deal, 42 Elm St' }),
          task({ id: 't2', label: 'Call lender', notes: 'follow up on qd-short appraisal' }),
          task({ id: 't3', label: 'File quarterly CAM reconciliation' }),
        ],
      },
    );
    const { snapshot, removedTasks } = redactConfidential(s);
    expect(snapshot.tasks.map((t) => t.id)).toEqual(['t3']); // t1 by name, t2 by shortName (case-insensitive, in notes)
    expect(removedTasks).toBe(2);
  });

  it('scrubs a KEPT counterparty note that mentions a removed deal by name (refute finding)', () => {
    const s = snap(
      [deal({ id: 'deal-x', name: 'Quiet Deal', confidential: true }), deal({ id: 'deal-y', name: 'Public Deal' })],
      [cp({
        id: 'lender-3', name: 'Busy Bank', notes: 'Sent term sheet for Quiet Deal at 6.85% IO',
        links: { properties: [], loans: [], deals: ['deal-x', 'deal-y'], insurance: [] },
      })],
    );
    const { snapshot } = redactConfidential(s);
    const kept = snapshot.counterparties.find((c) => c.id === 'lender-3')!;
    expect(kept).toBeDefined();
    expect(kept.notes).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('Quiet Deal');
  });

  it('scrubs a surviving public deal\'s nextAction/status text that mentions a removed deal by name', () => {
    const s = snap(
      [
        deal({ id: 'deal-x', name: 'Quiet Deal', confidential: true }),
        deal({ id: 'deal-y', name: 'Public Deal', nextAction: 'Hold until Quiet Deal closes', status: 'Waiting on Quiet Deal' }),
      ],
      [],
    );
    const { snapshot } = redactConfidential(s);
    const kept = snapshot.deals.find((d) => d.id === 'deal-y')!;
    expect(kept.nextAction).toBeNull();
    expect(kept.status).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('Quiet Deal');
  });

  it('drops a tenantNotes entry whose VALUE mentions a removed deal by name (refute finding — key-only audit missed values)', () => {
    // tenantNotes values are non-nullable strings (contract), so a mentioning entry is DROPPED
    // (like a task) rather than nulled (like the nullable counterparty/deal fields above).
    const s = snap([deal({ id: 'deal-x', name: 'Quiet Deal', confidential: true })], [], {
      tenantNotes: {
        'tenant-a': 'Tenant may relocate to Quiet Deal after closing',
        'tenant-b': 'Standard renewal in progress',
      },
    });
    const { snapshot } = redactConfidential(s);
    expect(snapshot.tenantNotes['tenant-a']).toBeUndefined();
    expect(snapshot.tenantNotes['tenant-b']).toBe('Standard renewal in progress');
    expect(JSON.stringify(snapshot)).not.toContain('Quiet Deal');
  });

  it('strips deal-keyed overlay records (dealComps / acquisitionInputs) for removed deals', () => {
    const s = snap(
      [deal({ id: 'deal-x', name: 'Quiet Deal', confidential: true }), deal({ id: 'deal-y', name: 'Public Deal' })],
      [],
      {
        dealComps: { 'deal-x': { comps: [] }, 'deal-y': { comps: [] } },
        acquisitionInputs: { 'deal-x': { dealId: 'deal-x' }, 'deal-y': { dealId: 'deal-y' } },
      },
    );
    const { snapshot } = redactConfidential(s);
    expect(Object.keys(snapshot.dealComps)).toEqual(['deal-y']);
    expect(Object.keys(snapshot.acquisitionInputs)).toEqual(['deal-y']);
  });

  it('no confidential deals — snapshot passes through unchanged', () => {
    const s = snap(
      [deal({ id: 'deal-y', name: 'Public Deal' })],
      [cp({ id: 'lender-3', name: 'Plain Bank', links: { properties: [], loans: [], deals: ['deal-y'], insurance: [] } })],
    );
    const { snapshot, removed, removedCounterparties, removedTasks } = redactConfidential(s);
    expect(snapshot).toBe(s); // identity — the zero-confidential fast path
    expect(removed).toHaveLength(0);
    expect(removedCounterparties).toHaveLength(0);
    expect(removedTasks).toBe(0);
  });
});
