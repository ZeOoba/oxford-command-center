import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Deal } from '../../src/contracts/index';
import type { Counterparty } from '../../src/contracts/counterparty';
import { redactConfidential, refuseBakeOnDegradedDeals, refuseBakeOnReconciliation } from '../../scripts/bake-mirror';

/**
 * REFUTE-PASS FINDING (MEDIUM). The 2026-08-11 seed-wipe fix threaded DealsLoad.degraded through
 * ParseResult so "each writer can apply its own policy", and gated Brain.persist — but bake-mirror
 * destructured only `{ snapshot }` and wrote public/snapshot.json regardless. That is the payload
 * served by the PUBLIC brain.oxfordra.net mirror, so a transient Notion `fetch failed` during a
 * scheduled bake published the ~6-deal seed placeholder set over the ~20-deal live pipeline to an
 * EXTERNAL surface, at exit 0 — the 2026-08-09 mode, on the worst possible surface.
 */
/**
 * CATCH-UP SWEEP M2, second half. redactConfidential swept tasks, notes, counterparties and
 * deal-keyed overlays, but SKIPPED dataQuality on the recorded ground that it is "parser-emitted" —
 * an assumption ca068c5 falsified in the same window by routing confidential rows into the
 * near-duplicate detector, whose flag text names them. Today the public mirror escapes only because
 * the bake path never runs checkSnapshot; wiring that in (H2) without this sweep would publish those
 * names. Belt AND braces: the producer stops emitting them, and the publication boundary sweeps.
 */
/**
 * CATCH-UP SWEEP H2, the fourth publication path. bake-mirror publishes the payload served by the
 * PUBLIC brain.oxfordra.net mirror and ran NO reconciliation gate at all — so an internally
 * inconsistent snapshot (a phantom-lease-class rent overstatement, i.e. NOI overstated: the
 * falsely-clearing direction) could ship publicly while both CLI writers refused the same state.
 *
 * This lands only AFTER M2 above: gating the bake on checkSnapshot is exactly what would have
 * published confidential deal names out of the near-duplicate flag text.
 */
describe('bake-mirror — H2: refuses to bake an internally inconsistent snapshot', () => {
  const reconSnap = (over: Record<string, unknown> = {}): PortfolioSnapshot => ({
    properties: [{ id: 'p1' }],
    leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }],
    loans: [], deals: [], insurance: [], counterparties: [],
    cash: { totalCash: 500, entities: [{ id: 'e1', currentBalance: 500 }] },
    dataQuality: [], tasks: [], dealComps: {}, acquisitionInputs: {}, tenantNotes: {},
    ...over,
  } as unknown as PortfolioSnapshot);

  it('returns a refusal when reconciliation reports an error', () => {
    // Cash total disagrees with Σ entities — an error-severity reconciliation finding.
    const out = refuseBakeOnReconciliation(
      reconSnap({ cash: { totalCash: 999, entities: [{ id: 'e1', currentBalance: 500 }] } }),
    );
    expect(out).not.toBeNull();
    expect(out).toMatch(/reconcil/i);
  });

  it('permits the bake for a consistent snapshot', () => {
    expect(refuseBakeOnReconciliation(reconSnap())).toBeNull();
  });

  it('permits the bake when the only findings are warnings', () => {
    // annualRent ≠ monthly×12 is warn-severity; it must not block the public bake.
    expect(refuseBakeOnReconciliation(reconSnap({ leases: [{ id: 'l1', annualRent: 1000, monthlyRent: 100 }] }))).toBeNull();
  });
});

describe('bake-mirror — M2: redaction sweeps dataQuality flag text', () => {
  const snap = (dataQuality: unknown[]): PortfolioSnapshot => ({
    deals: [deal({ id: 'secret', name: 'Wolverine Holdings', confidential: true }), deal({ id: 'pub', name: 'Public Yard' })],
    counterparties: [], tasks: [], dealComps: {}, acquisitionInputs: {}, tenantNotes: {},
    properties: [], leases: [], loans: [], insurance: [],
    dataQuality,
  } as unknown as PortfolioSnapshot);

  it('drops a flag whose text names a redacted deal', () => {
    const out = redactConfidential(snap([
      { entity: 'reconciliation', field: 'deals.name', issue: 'near-duplicate: "Wolverine Holdings" ⇄ "Public Yard"', severity: 'error' },
    ]));
    expect(out.snapshot.dataQuality).toHaveLength(0);
  });

  it('keeps a flag that names nothing redacted', () => {
    const out = redactConfidential(snap([
      { entity: 'reconciliation', field: 'cash.totalCash', issue: 'total 999 does not equal sum 500', severity: 'error' },
    ]));
    expect(out.snapshot.dataQuality).toHaveLength(1);
  });

  it('sweeps rawValue too, not just issue', () => {
    const out = redactConfidential(snap([
      { entity: 'deals', field: 'joinKey', issue: 'collision', rawValue: 'wolverine holdings', severity: 'error' },
    ]));
    expect(out.snapshot.dataQuality).toHaveLength(0);
  });
});

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

  it('drops tasks that name a removed deal with invisible characters or odd spaces (refute wf_d43de08e-49f)', () => {
    const ZWSP = String.fromCodePoint(0x200b);
    const NBSP = String.fromCodePoint(0xa0);
    const s = snap(
      [deal({ id: 'deal-x', name: 'Quiet Deal', shortName: 'QD-Short', confidential: true })],
      [],
      {
        tasks: [
          task({ id: 't1', label: `Send PSA redline - Quiet${ZWSP} Deal, 42 Elm St` }),
          task({ id: 't2', label: 'Call lender', notes: `follow up on QD${ZWSP}-Short appraisal` }),
          task({ id: 't3', label: `Quiet${NBSP}Deal closing checklist` }),
          task({ id: 't4', label: 'File quarterly CAM reconciliation' }),
        ],
      },
    );
    const { snapshot, removedTasks } = redactConfidential(s);
    expect(snapshot.tasks.map((t) => t.id)).toEqual(['t4']);
    expect(removedTasks).toBe(3);
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
