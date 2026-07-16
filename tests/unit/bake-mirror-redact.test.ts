import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Deal } from '../../src/contracts/index';
import type { Counterparty } from '../../src/contracts/counterparty';
import { redactConfidential } from '../../scripts/bake-mirror';

// I8 (bake-redact-keeps-confidential-counterparties): redaction removed confidential deals and
// filtered links.deals, but KEPT the counterparty entity — an orphaned lender name + market in the
// public bake identifies the confidential deal it financed. Hard Invariant 3.

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'LOI/PSA', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  confidential: false, estimatedFields: [], ...o,
});

const cp = (o: Partial<Counterparty>): Counterparty => ({
  id: 'c', name: 'C', kind: 'lender', firm: null, role: null, email: null, phone: null,
  market: null, notes: null, source: 'workbook',
  links: { properties: [], loans: [], deals: [], insurance: [] }, ...o,
});

const snap = (deals: Deal[], counterparties: Counterparty[]): PortfolioSnapshot =>
  ({ deals, counterparties } as unknown as PortfolioSnapshot);

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

  it('no confidential deals — snapshot passes through unchanged', () => {
    const s = snap(
      [deal({ id: 'deal-y', name: 'Public Deal' })],
      [cp({ id: 'lender-3', name: 'Plain Bank', links: { properties: [], loans: [], deals: ['deal-y'], insurance: [] } })],
    );
    const { snapshot, removed, removedCounterparties } = redactConfidential(s);
    expect(snapshot).toBe(s); // identity — the zero-confidential fast path
    expect(removed).toHaveLength(0);
    expect(removedCounterparties).toHaveLength(0);
  });
});
