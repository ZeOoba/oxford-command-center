import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { checkSnapshot } from '../../server/reconcile-runtime';

const base = (over: Partial<Record<string, unknown>> = {}): PortfolioSnapshot =>
  ({
    properties: [{ id: 'p1' }],
    leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }],
    loans: [],
    deals: [],
    insurance: [],
    cash: { totalCash: 500, entities: [{ id: 'e1', currentBalance: 500 }] },
    counterparties: [],
    dataQuality: [],
    ...over,
  }) as unknown as PortfolioSnapshot;

describe('checkSnapshot — runtime reconciliation', () => {
  it('returns no flags for a consistent snapshot', () => {
    expect(checkSnapshot(base())).toEqual([]);
  });

  it('flags a cash total that does not equal Σ entities (error)', () => {
    const flags = checkSnapshot(base({ cash: { totalCash: 999, entities: [{ id: 'e1', currentBalance: 500 }] } }));
    expect(flags.some((f) => f.field === 'cash.totalCash' && f.severity === 'error')).toBe(true);
  });

  it('flags annual rent ≠ Σ(monthly×12) (warn)', () => {
    const flags = checkSnapshot(base({ leases: [{ id: 'l1', annualRent: 1000, monthlyRent: 100 }] }));
    expect(flags.some((f) => f.field === 'leases.annualRent' && f.severity === 'warn')).toBe(true);
  });

  it('flags dangling relationship edges (warn)', () => {
    const flags = checkSnapshot(base({ counterparties: [{ links: { properties: ['nope'], loans: [], deals: [], insurance: [] } }] }));
    expect(flags.some((f) => f.field === 'counterparties.links')).toBe(true);
  });

  it('flags empty core entity sets (error)', () => {
    const flags = checkSnapshot(base({ properties: [] }));
    expect(flags.some((f) => f.field === 'properties' && f.severity === 'error')).toBe(true);
  });

  // The three near-duplicate deal-name cases that stood here were RETIRED 2026-08-12 with the check
  // they covered. checkSnapshot ran findNearDuplicateNames over the MERGED deal set, which was the
  // wrong layer: a wrong merge leaves exactly ONE row, so the failure the check most needed to
  // catch was structurally invisible to it, and the duplicates it did catch were reported without
  // the fact that explains them — which rows failed to join. mergeDeals now raises that itself
  // (its migration tripwire), and deals join on an opaque Deal ID, so a naming variance can no
  // longer produce two rows for one deal at all. Coverage lives in
  // tests/unit/deal-id-join.test.ts and tests/unit/deal-id-join-invariants.test.ts.
  //
  // The property-id collision backstop below is UNRELATED and stays: property ids are a different
  // join key with a different producer (parse.ts), and nothing about the deal join touches it.

  it('flags duplicate property ids (error) — the join-key collision backstop', () => {
    const flags = checkSnapshot(base({ properties: [{ id: 'dup' }, { id: 'dup' }, { id: 'ok' }] }));
    expect(flags.some((f) => f.field === 'properties.id' && f.severity === 'error' && /dup/.test(f.issue))).toBe(true);
  });

  it('passes when all property ids are distinct', () => {
    const flags = checkSnapshot(base({ properties: [{ id: 'a' }, { id: 'b' }] }));
    expect(flags.some((f) => f.field === 'properties.id')).toBe(false);
  });

  // Restored 2026-08-13 (code review): this check stood here as findNearDuplicateNames until
  // 2026-08-12, when it was retired on the argument that mergeDeals' migration tripwire replaced
  // it. That missed that checkSnapshot is ALSO invoked by scripts/reconcile-snapshot.ts's
  // `npm run gate:ci` — zero Notion I/O, zero call into mergeDeals — which exists precisely to
  // catch corruption in the COMMITTED snapshot independent of how it was generated.
  describe('deal duplicate/collision backstop — reachable independent of a live Notion fetch', () => {
    it('flags duplicate deal Deal IDs (error) — same shape as properties.id', () => {
      const flags = checkSnapshot(base({
        deals: [
          { id: 'a', name: 'Alpha', notionDealId: 'DEAL-1' },
          { id: 'b', name: 'Beta', notionDealId: 'DEAL-1' },
        ],
      }));
      expect(flags.some((f) => f.field === 'deals.notionDealId' && f.severity === 'error' && /DEAL-1/.test(f.issue))).toBe(true);
    });

    it('flags two rows sharing a normalized name and DIFFERENT Deal IDs, naming both ids', () => {
      const flags = checkSnapshot(base({
        deals: [
          { id: 'a', name: 'Quorravale Depot', notionDealId: 'DEAL-1' },
          { id: 'b', name: 'Quorravale Depot', notionDealId: 'DEAL-2' },
        ],
      }));
      const f = flags.find((x) => x.field === 'deals.name')!;
      expect(f.severity).toBe('error');
      expect(f.issue).toContain('different Deal IDs');
      expect(f.issue).toContain('DEAL-1');
      expect(f.issue).toContain('DEAL-2');
    });

    it('says "SAME Deal ID" — not "different" — for a verbatim-duplicated row (the CI path’s primary target)', () => {
      // The exact scenario reconcile-snapshot.ts's gate:ci call exists to catch: a merge conflict
      // or hand-edit duplicating one row. Asserting "different Deal IDs" here would be false and
      // would misdirect the operator toward Notion for a defect that lives in the committed file.
      const flags = checkSnapshot(base({
        deals: [
          { id: 'a', name: 'Quorravale Depot', notionDealId: 'DEAL-1' },
          { id: 'a', name: 'Quorravale Depot', notionDealId: 'DEAL-1' },
        ],
      }));
      const f = flags.find((x) => x.field === 'deals.name')!;
      expect(f.issue).toContain('SAME Deal ID');
      expect(f.issue).not.toContain('different Deal IDs');
      expect(f.issue.toLowerCase()).toContain('merge conflict');
    });

    it('names no deal in either the notionDealId or the name duplicate flag — both reach the public mirror', () => {
      const flags = checkSnapshot(base({
        deals: [
          { id: 'a', name: 'Zephyrine Yard', notionDealId: 'DEAL-9' },
          { id: 'b', name: 'Zephyrine Yard', notionDealId: 'DEAL-9' },
        ],
      }));
      const published = JSON.stringify(flags);
      expect(published).not.toContain('Zephyrine');
    });

    it('suppresses a genuine cross-metro namesake, but only when the states actually differ', () => {
      const suppressed = checkSnapshot(base({
        deals: [
          { id: 'a', name: '470 McCormick Blvd — Columbus, OH', notionDealId: 'DEAL-1' },
          { id: 'b', name: '470 McCormick Blvd — Louisville, KY', notionDealId: 'DEAL-2' },
        ],
      }));
      expect(suppressed.some((f) => f.field === 'deals.name')).toBe(false);

      // Same-STATE namesakes are realistic for ORA's own Columbus/Cincinnati OH cluster and must
      // NOT be waved through by a bare locality tail — the remedy text says so explicitly.
      const notSuppressed = checkSnapshot(base({
        deals: [
          { id: 'a', name: '1200 Main St — Columbus, OH', notionDealId: 'DEAL-1' },
          { id: 'b', name: '1200 Main St — Cincinnati, OH', notionDealId: 'DEAL-2' },
        ],
      }));
      const f = notSuppressed.find((x) => x.field === 'deals.name')!;
      expect(f).toBeDefined();
      expect(f.issue).toContain('DIFFERENT STATE');
    });
  });

  it('flags a cash-history latest point that disagrees with the current total (error)', () => {
    const flags = checkSnapshot(
      base({ cash: { totalCash: 500, entities: [{ id: 'e1', currentBalance: 500 }], history: [{ total: 100 }] } }),
    );
    expect(flags.some((f) => f.field === 'cash.history' && f.severity === 'error')).toBe(true);
  });

  it('does not flag cash history when there is none (no history array supplied)', () => {
    const flags = checkSnapshot(base());
    expect(flags.some((f) => f.field === 'cash.history')).toBe(false);
  });

  it('flags a property NOI sum that disagrees with the workbook\'s own Portfolio Total', () => {
    const flags = checkSnapshot(
      base({ properties: [{ id: 'p1', noi: 100 }], workbookTotals: { noi: 999, value: null, rent: null } }),
    );
    expect(flags.some((f) => f.field === 'properties.noi' && f.severity === 'error')).toBe(true);
  });

  it('flags an Oxford value sum that disagrees with the workbook\'s own Portfolio Total', () => {
    const flags = checkSnapshot(
      base({ properties: [{ id: 'p1', oxfordValue: 100 }], workbookTotals: { noi: null, value: 999, rent: null } }),
    );
    expect(flags.some((f) => f.field === 'properties.oxfordValue' && f.severity === 'error')).toBe(true);
  });

  it('flags an annual rent sum that disagrees with the workbook\'s own Portfolio Total', () => {
    const flags = checkSnapshot(
      base({ leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }], workbookTotals: { noi: null, value: null, rent: 5000 } }),
    );
    expect(flags.some((f) => f.field === 'leases.annualRent' && f.severity === 'error')).toBe(true);
  });

  it('does not cross-check against the workbook Portfolio Total when workbookTotals is absent (legacy payload)', () => {
    const flags = checkSnapshot(base({ properties: [{ id: 'p1', noi: 100 }] }));
    expect(flags.some((f) => f.field === 'properties.noi')).toBe(false);
  });

  // cc-audit-army finding unresolved-lease-propertyid-silent: a lease that never resolved to a
  // property (parse.ts's rowFlags handles the per-row 'warn') must ALSO fail the snapshot at the
  // aggregate level once the unresolved share is material — mirrors the reproduced incident (41 of
  // 138 leases, $1.14M, ~30% of rent, on the largest-NOI property).
  describe('unresolved lease propertyId — aggregate backstop', () => {
    it('flags when unresolved-propertyId rent exceeds 1% of the workbook total (error)', () => {
      const flags = checkSnapshot(
        base({
          leases: [
            { id: 'l1', propertyId: 'p1', annualRent: 9_700, monthlyRent: 9_700 / 12 },
            { id: 'l2', propertyId: null, annualRent: 300, monthlyRent: 25 },
          ],
          workbookTotals: { noi: null, value: null, rent: 10_000 },
        }),
      );
      const f = flags.find((x) => x.field === 'leases.propertyId');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
      expect(f!.issue).toContain('3.0%');
      expect(f!.issue).toContain('300');
    });

    it('does not flag a negligible unresolved share (below 1%)', () => {
      const flags = checkSnapshot(
        base({
          leases: [
            { id: 'l1', propertyId: 'p1', annualRent: 9_950, monthlyRent: 9_950 / 12 },
            { id: 'l2', propertyId: null, annualRent: 50, monthlyRent: 50 / 12 },
          ],
          workbookTotals: { noi: null, value: null, rent: 10_000 },
        }),
      );
      expect(flags.some((f) => f.field === 'leases.propertyId')).toBe(false);
    });

    it('does not flag when workbookTotals is absent (nothing to compare against)', () => {
      const flags = checkSnapshot(
        base({ leases: [{ id: 'l1', propertyId: null, annualRent: 1_000_000, monthlyRent: 1_000_000 / 12 }] }),
      );
      expect(flags.some((f) => f.field === 'leases.propertyId')).toBe(false);
    });

    it('reproduces the incident shape: the largest-NOI property resolving zero leases fails the snapshot', () => {
      const leases = [
        // 41 leases, $1.14M/yr, all unresolved — matches the reproduced incident.
        ...Array.from({ length: 41 }, (_, i) => ({
          id: `unresolved-${i}`,
          propertyId: null,
          annualRent: 1_140_000 / 41,
          monthlyRent: 1_140_000 / 41 / 12,
        })),
        // 97 resolved leases making up the rest of a $5M portfolio.
        { id: 'resolved-1', propertyId: 'p1', annualRent: 5_000_000 - 1_140_000, monthlyRent: (5_000_000 - 1_140_000) / 12 },
      ];
      const flags = checkSnapshot(
        base({ leases, workbookTotals: { noi: null, value: null, rent: 5_000_000 } }),
      );
      const f = flags.find((x) => x.field === 'leases.propertyId');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
    });
  });

  it('passes when property NOI/value and annual rent all agree with the workbook Portfolio Total', () => {
    const flags = checkSnapshot(
      base({
        properties: [{ id: 'p1', noi: 400, oxfordValue: 5000000 }],
        leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }],
        workbookTotals: { noi: 400, value: 5000000, rent: 1200 },
      }),
    );
    expect(flags).toEqual([]);
  });
});
