import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Lease } from '../../src/contracts/index';
import { evaluateConditions } from '../../src/analytics/conditions';
import { annualRentGapIsExplainedByAbatement, checkSnapshot, checkStaleLeaseRows, checkDebtBasis, withRuntimeFlags } from '../../server/reconcile-runtime';
import { isDebtBasisFlag } from '../../src/analytics/debt-basis';

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
    // 1,235 on $100/mo is 12.35 months: it is above monthly x 12 (more than 12 months) (1,000 would be a legitimate
    // two-month abatement since 2026-10-06 -- see the 'abated months' block below).
    const flags = checkSnapshot(base({ leases: [{ id: 'l1', annualRent: 1235, monthlyRent: 100 }] }));
    expect(flags.some((f) => f.field === 'leases.annualRent' && f.severity === 'warn')).toBe(true);
  });

  // Abated months (2026-10-06): the workbook's Annual Rent is monthly × (12 − Abated Months), so Σ
  // annual rent is legitimately below Σ(monthly × 12). The gap is excused ONLY when every lease on its
  // own is consistent with an abatement. The workbook's Portfolio Total is a SUM of the same cells, so
  // it must NOT be treated as the authority: it ties to any bad cell by construction.
  describe('abated months', () => {
    const lease1 = (annualRent: number, monthlyRent = 100) => [{ id: 'l1', annualRent, monthlyRent }];
    const annualFlags = (s: PortfolioSnapshot) => checkSnapshot(s).filter((f) => f.field === 'leases.annualRent');
    const totalOf = (rent: number) => ({ noi: null, value: null, rent });

    it('accepts Σ annual < Σ(monthly×12) when the lease is a whole-month abatement', () => {
      expect(annualFlags(base({ leases: lease1(1100), workbookTotals: totalOf(1100) }))).toEqual([]);
    });

    it('accepts a half-month abatement and a fully abated year', () => {
      expect(annualFlags(base({ leases: lease1(1150), workbookTotals: totalOf(1150) }))).toEqual([]);
      expect(annualFlags(base({ leases: lease1(0), workbookTotals: totalOf(0) }))).toEqual([]);
    });

    it('accepts a quarter-month / day-prorated abatement (no false critical alarm on valid data)', () => {
      // $4,000/mo with 0.25 abated months: annual 47,000 = 4,000 x 11.75.
      expect(annualFlags(base({ leases: lease1(47000, 4000), workbookTotals: totalOf(47000) }))).toEqual([]);
      // 10 days ~ 0.33 months: 4,000 x 11.67 = 46,667.
      expect(annualFlags(base({ leases: lease1(46667, 4000), workbookTotals: totalOf(46667) }))).toEqual([]);
    });

    it('STILL warns on a typo even when the workbook total (a SUM of the same cells) contains it', () => {
      // 1,260 on a $100/mo lease is 12.6 months: it is above monthly x 12 (more than 12 months).
      const flags = annualFlags(base({ leases: lease1(1260), workbookTotals: totalOf(1260) }));
      expect(flags.some((f) => f.severity === 'warn')).toBe(true);
      expect(flags.some((f) => f.severity === 'error')).toBe(false); // total ties, so only the per-lease warn fires
    });

    it('STILL warns on an overstatement above 12 months even when the workbook total contains it', () => {
      const flags = annualFlags(base({ leases: lease1(2400), workbookTotals: totalOf(2400) }));
      expect(flags.some((f) => f.severity === 'warn')).toBe(true);
    });

    it('one bad lease keeps the warn even when another lease is a legitimate abatement', () => {
      const leases = [
        { id: 'a', annualRent: 1100, monthlyRent: 100 }, // legitimate
        { id: 'b', annualRent: 1260, monthlyRent: 100 }, // typo
      ];
      expect(annualFlags(base({ leases, workbookTotals: totalOf(2360) })).some((f) => f.severity === 'warn')).toBe(true);
    });

    it('flags the error when Σ annual rent does not tie to the workbook total, regardless of the per-lease check', () => {
      const flags = annualFlags(base({ leases: lease1(1100), workbookTotals: totalOf(1200) }));
      expect(flags.some((f) => f.severity === 'error')).toBe(true);
    });
  });

  describe('annualRentGapIsExplainedByAbatement', () => {
    const ok = (annualRent: number, monthlyRent = 100) => annualRentGapIsExplainedByAbatement([{ annualRent, monthlyRent }]);
    it('explains any annual rent from 0 up to monthly x 12: whole, half, quarter and day-prorated abatements', () => {
      expect(ok(1200)).toBe(true);
      expect(ok(1100)).toBe(true);
      expect(ok(1150)).toBe(true);
      expect(ok(0)).toBe(true);
      expect(ok(1100.5)).toBe(true); // within $1
      expect(annualRentGapIsExplainedByAbatement([{ annualRent: 47000, monthlyRent: 4000 }])).toBe(true); // 0.25 mo
      expect(ok(1033)).toBe(true); // in range: the per-lease parse check, not this aggregate guard, catches an in-range typo
    });
    it('rejects overstatements above 12 months and negative annual rent', () => {
      expect(ok(1260)).toBe(false);
      expect(ok(1235)).toBe(false);
      expect(ok(2400)).toBe(false);
      expect(ok(-100)).toBe(false);
    });
    it('rejects a lease with no monthly rent but annual rent, and accepts an empty list', () => {
      expect(ok(500, 0)).toBe(false);
      expect(annualRentGapIsExplainedByAbatement([])).toBe(true);
    });
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

  // Added 2026-09-30: Task.id had no uniqueness backstop, which let 56 M365 rows share one id
  // unnoticed in the committed snapshot. Same shape as properties.id.
  // Severity is 'warn' until the committed snapshot is re-baked with hashed ids (see the comment in
  // checkSnapshot). When it flips to 'error', change this expectation in the same commit.
  it('flags duplicate task ids (warn, pending re-bake) — the same backstop properties get', () => {
    const flags = checkSnapshot(base({ tasks: [{ id: 'm365-dup' }, { id: 'm365-dup' }, { id: 'm365-ok' }] }));
    expect(flags.some((f) => f.entity === 'tasks' && f.field === 'id' && f.severity === 'warn' && /m365-dup/.test(f.issue))).toBe(true);
  });

  // Independent review 2026-10-01: a reconciliation-entity flag fires the CRITICAL reconcile-fail alert
  // email whatever its severity. A duplicate task id is a warn and must not page anyone.
  it('the duplicate task id flag is not a reconciliation-entity flag and does not fire reconcile-fail', () => {
    const snap = base({ tasks: [{ id: 'm365-dup' }, { id: 'm365-dup' }] });
    const flags = checkSnapshot(snap);
    const f = flags.find((x) => x.entity === 'tasks' && x.field === 'id');
    expect(f).toBeDefined();
    expect(f!.entity).not.toBe('reconciliation');
    const asOf = '2026-10-01';
    const full = {
      meta: { schemaVersion: '1.0.0', asOf, generatedAt: '2026-10-01T00:00:00.000Z', source: 't', scenario: 'Base' },
      assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf },
      properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
      renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null,
      cash: { asOf, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
      dataQuality: flags,
    } as unknown as PortfolioSnapshot;
    const insights = evaluateConditions(full, { now: Date.parse('2026-10-01T12:00:00.000Z') });
    expect(insights.some((i) => i.id === 'reconcile-fail')).toBe(false);
    expect(insights.some((i) => i.severity === 'critical')).toBe(false);
  });

  it('passes when all task ids are distinct', () => {
    const flags = checkSnapshot(base({ tasks: [{ id: 'a' }, { id: 'b' }] }));
    expect(flags.some((f) => f.entity === 'tasks' && f.field === 'id')).toBe(false);
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
          { id: 'a', name: '100 Example Blvd — Columbus, OH', notionDealId: 'DEAL-1' },
          { id: 'b', name: '100 Example Blvd — Louisville, KY', notionDealId: 'DEAL-2' },
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
  // 138 leases, a large share of rent, on the largest-NOI property).
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
        // 41 leases, all unresolved — matches the reproduced incident.
        ...Array.from({ length: 41 }, (_, i) => ({
          id: `unresolved-${i}`,
          propertyId: null,
          annualRent: 1_385_000 / 41,
          monthlyRent: 1_385_000 / 41 / 12,
        })),
        // 97 resolved leases making up the rest of a $5M portfolio.
        { id: 'resolved-1', propertyId: 'p1', annualRent: 5_000_000 - 1_385_000, monthlyRent: (5_000_000 - 1_385_000) / 12 },
      ];
      const flags = checkSnapshot(
        base({ leases, workbookTotals: { noi: null, value: null, rent: 5_000_000 } }),
      );
      const f = flags.find((x) => x.field === 'leases.propertyId');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
    });
  });

  // 2026-09-14 financial-code sweep: the committed snapshot carried cash.asOf = 2026-09-10 over a
  // history array whose last row was 2026-07-10, with the July slot's total bit-identical to the
  // September headline -- a clobbered slot, and the ONLY cash-history check here ("latest point =
  // current total") read that as a pass. Date-aware invariants close it. Detection only: the missing
  // 08-10 / 09-10 rows are a workbook problem for a human, never backfilled here.
  describe('cash — date-aware history invariants', () => {
    const cashWith = (over: Record<string, unknown>) => ({
      asOf: '2026-07-10',
      totalCash: 500,
      entities: [{ id: 'e1', currentBalance: 500 }],
      history: [
        { date: '2026-06-10', total: 400 },
        { date: '2026-07-10', total: 500 },
      ],
      ...over,
    });

    it('is silent for a history that ends on cash.asOf with distinct consecutive totals', () => {
      const flags = checkSnapshot(base({ meta: { generatedAt: '2026-07-14T14:23:48.819Z' }, cash: cashWith({}) }));
      expect(flags.filter((f) => f.field.startsWith('cash.'))).toEqual([]);
    });

    it('flags cash.asOf later than meta.generatedAt (error) — a structural impossibility, not a business event', () => {
      const flags = checkSnapshot(base({ meta: { generatedAt: '2026-09-14T14:23:48.819Z' }, cash: cashWith({ asOf: '2026-09-15', history: [{ date: '2026-09-15', total: 500 }] }) }));
      const f = flags.find((x) => x.field === 'cash.asOf');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('error');
      expect(f!.issue).toContain('2026-09-15');
      expect(f!.issue).toContain('2026-09-14');
    });

    it('compares asOf to generatedAt on the DATE portion — a bare date on the same day as a later-in-the-day timestamp is fine', () => {
      const flags = checkSnapshot(base({ meta: { generatedAt: '2026-09-14T00:00:01.000Z' }, cash: cashWith({ asOf: '2026-09-14', history: [{ date: '2026-09-14', total: 500 }] }) }));
      expect(flags.some((f) => f.field === 'cash.asOf')).toBe(false);
    });

    it('flags (warn) a history whose latest date is not cash.asOf — the September asOf over a July-ending history', () => {
      const flags = checkSnapshot(base({ meta: { generatedAt: '2026-09-14T14:23:48.819Z' }, cash: cashWith({ asOf: '2026-09-10' }) }));
      const f = flags.find((x) => x.field === 'cash.history.date');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
      expect(f!.issue).toContain('2026-07-10');
      expect(f!.issue).toContain('2026-09-10');
    });

    it('flags (warn) two consecutive history entries with identical totals — the clobbered-slot signature', () => {
      const flags = checkSnapshot(base({
        meta: { generatedAt: '2026-07-14T14:23:48.819Z' },
        cash: cashWith({ history: [{ date: '2026-05-10', total: 300 }, { date: '2026-06-10', total: 500 }, { date: '2026-07-10', total: 500 }] }),
      }));
      const f = flags.find((x) => x.field === 'cash.history.total');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
      expect(f!.issue).toContain('2026-06-10');
      expect(f!.issue).toContain('2026-07-10');
    });

    // 2026-09-25: a 2026-07-10 row was keyed from estimates. The value-only gate check caught it only
    // because the current balances were not rolled forward; had they been, it would have passed.
    describe('estimated-row signature (round-number balances)', () => {
      const june = { A: 123456.78, B: 4400017, C: 34567.89, D: 1234567.89, E: 222222.333, F: 11111.1 };
      const row = (date: string, balances: Record<string, number>) => ({
        date,
        total: Object.values(balances).reduce((a, b) => a + b, 0),
        balances,
      });
      const flagsFor = (latest: Record<string, number>) =>
        checkSnapshot(base({ cash: cashWith({ history: [row('2026-06-10', june), row('2026-07-10', latest)] }) }))
          .filter((f) => f.field === 'cash.history.estimated');

      it('flags (warn) the live 2026-07-10 shape: most changed balances are whole multiples of $500', () => {
        const f = flagsFor({ ...june, A: 220000, B: 4500000, C: 55000, D: 1500000, E: 212000 });
        expect(f).toHaveLength(1);
        expect(f[0]!.severity).toBe('warn');
        expect(f[0]!.issue).toContain('2026-07-10');
        expect(f[0]!.issue).toContain('5 of 5');
      });

      it('is silent for statement-style balances (cents, odd dollars), even when some entities are unchanged', () => {
        expect(flagsFor({ ...june, A: 145678.91, B: 4400123, D: 1300456.12, E: 222333.5 })).toEqual([]);
      });

      it('is silent when only one or two changed balances happen to be round', () => {
        expect(flagsFor({ ...june, A: 150000, B: 4400123.5, C: 40000, D: 1300456.12 })).toEqual([]);
      });

      it('is silent for history rows that carry no per-entity balances', () => {
        expect(checkSnapshot(base({ cash: cashWith({}) })).some((f) => f.field === 'cash.history.estimated')).toBe(false);
      });
    });

    it('does not run the date checks when the snapshot carries no history / asOf / meta (legacy fixture)', () => {
      expect(checkSnapshot(base()).filter((f) => f.field.startsWith('cash.'))).toEqual([]);
    });
  });

  // 2026-09-14 sweep: two live entities carried a percent whose sign contradicted its own dollar
  // figure (a negative deltaDollar with a positive deltaPct; a positive growth12Dollar with a large negative growth12Pct)
  // because the workbook's own percent cell divides by a NEGATIVE prior balance. parse.ts now
  // recomputes both and emits null over a wrong-signed number; this is the self-consistency
  // backstop over whatever is actually on the snapshot (committed file, legacy bake, hand-edit).
  describe('cash — entity self-consistency (dollar vs percent sign, all-time min/max vs current)', () => {
    const entity = (over: Record<string, unknown>) => ({
      id: 'e1', currentBalance: 500, priorBalance: null, deltaDollar: null, deltaPct: null,
      minAllTime: null, maxAllTime: null, bal12moAgo: null, growth12Dollar: null, growth12Pct: null,
      ...over,
    });
    const snapWith = (e: Record<string, unknown>) => base({ cash: { totalCash: 500, entities: [entity(e)] } });

    it('flags (warn) an entity whose deltaDollar and deltaPct disagree in sign', () => {
      const flags = checkSnapshot(snapWith({ deltaDollar: -1234.5, deltaPct: 0.0413 }));
      const f = flags.find((x) => x.field === 'cash.entities.deltaPct');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
      expect(f!.issue).toContain('e1');
    });

    it('flags (warn) an entity whose growth12Dollar and growth12Pct disagree in sign', () => {
      const flags = checkSnapshot(snapWith({ growth12Dollar: 2345.678, growth12Pct: -11.863 }));
      const f = flags.find((x) => x.field === 'cash.entities.growth12Pct');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
    });

    it('is silent when the signs agree, when either side is null, or when the dollar move is exactly zero', () => {
      expect(checkSnapshot(snapWith({ deltaDollar: 321.9, deltaPct: 0.0503 })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
      expect(checkSnapshot(snapWith({ deltaDollar: -321.9, deltaPct: null })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
      expect(checkSnapshot(snapWith({ deltaDollar: 0, deltaPct: 0 })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
    });

    it('flags (warn) maxAllTime below the current balance — a stale workbook cell, found live', () => {
      const flags = checkSnapshot(snapWith({ currentBalance: 500, maxAllTime: 450 }));
      const f = flags.find((x) => x.field === 'cash.entities.maxAllTime');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warn');
      expect(f!.issue).toContain('450');
      expect(f!.issue).toContain('500');
    });

    it('flags (warn) minAllTime above the current balance', () => {
      const flags = checkSnapshot(snapWith({ currentBalance: 500, minAllTime: 600 }));
      expect(flags.some((f) => f.field === 'cash.entities.minAllTime' && f.severity === 'warn')).toBe(true);
    });

    it('is silent when min ≤ current ≤ max, and within the $2 rounding tolerance the other cash checks use', () => {
      expect(checkSnapshot(snapWith({ currentBalance: 500, minAllTime: 100, maxAllTime: 500 })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
      expect(checkSnapshot(snapWith({ currentBalance: 500.9, minAllTime: 100, maxAllTime: 500 })).filter((f) => f.field.startsWith('cash.entities'))).toEqual([]);
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

describe('checkStaleLeaseRows', () => {
  const meta = { asOf: '2026-09-23' } as PortfolioSnapshot['meta'];
  const l = (o: Partial<Lease>) => ({ id: 'x', tenantName: 'T', status: 'Active', leaseEnd: null, ...o }) as Lease;
  it('flags a non-Expired row whose leaseEnd passed > 365d ago (workbook row whose status was never updated)', () => {
    const flags = checkStaleLeaseRows({ meta, leases: [l({ id: 'st1', tenantName: 'Stale Co', leaseEnd: '2024-09-01' })] });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'lease', field: 'lease.st1.leaseEnd', severity: 'warn' });
    expect(flags[0]!.issue).toContain('Stale Co');
  });
  it('is NOT a reconciliation-entity flag (would otherwise fire the CRITICAL "Reconciliation failure" insight)', () => {
    const flags = checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: '2024-09-01' })] });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.entity).not.toBe('reconciliation');
  });
  it('ignores recent holdovers and rows already marked Expired', () => {
    expect(checkStaleLeaseRows({ meta, leases: [
      l({ leaseEnd: '2026-06-30' }),
      l({ status: 'Expired', leaseEnd: '2023-01-01' }),
    ] })).toEqual([]);
  });
  it('ignores rows with no leaseEnd', () => {
    expect(checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: null })] })).toEqual([]);
  });
  it('threshold is strictly > 365 days: exactly 365 → no flag, 366 → flag', () => {
    expect(checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: '2025-09-23' })] })).toEqual([]);
    expect(checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: '2025-09-22' })] })).toHaveLength(1);
  });
  it('normalizes a leaseEnd carrying a time component to its date before comparing (matches asOf)', () => {
    // 366 calendar days before asOf. Without the slice(0, 10) a local-time-of-day component shifts
    // the parsed instant by up to a day relative to the date-only (UTC) asOf and can round to 365.
    expect(checkStaleLeaseRows({ meta, leases: [l({ leaseEnd: '2025-09-22T12:00:00' })] })).toHaveLength(1);
  });
  it('returns [] when meta.asOf is missing (no reference date to measure from)', () => {
    expect(checkStaleLeaseRows({ meta: {} as PortfolioSnapshot['meta'], leases: [l({ leaseEnd: '2020-01-01' })] })).toEqual([]);
    expect(checkStaleLeaseRows({ meta: undefined as unknown as PortfolioSnapshot['meta'], leases: [l({ leaseEnd: '2020-01-01' })] })).toEqual([]);
  });
});

// 2026-09-23 review: Overview "Total Debt" (property loan balances) and Capital › Debt "External Debt"
// (loan schedule) disagreed by the affiliate notes. Round 2 (2026-09-24): affiliate notes are excluded on BOTH
// sides (src/analytics/debt-basis.ts) and the check lists each unmatched row instead of one net gap.
// Warn-only, entity 'debt': never picks a winner, never alters a total, never fires reconcile-fail.
type P = { id: string; name: string; type?: string; lender?: string | null; loanBalance: number };
type L = { id: string; name: string; direction: string; absBalance: number; lender?: string | null; counterparty?: string | null; collateralProperty?: string | null };
const debtSnap = (properties: P[], loans: L[]) => ({ properties, loans }) as never;

// Live shape (data/snapshots/portfolio.json, asOf 2026-09-13), trimmed to the rows that matter.
// Balances are synthetic stand-ins; the row structure (lenders, directions, collateral) is the live one.
const EASTON: P = { id: 'p-easton', name: '29000 Information Lane, Easton MD', type: 'Flex', lender: 'Firm 03', loanBalance: 2_456_789.12 };
const RARIG: P = { id: 'p-rarig', name: '1100 Rarig Ave, Columbus OH', type: 'Flex', lender: 'Oxford Capital', loanBalance: 1_111_111 };
const LIVINGSTON: P = { id: 'p-liv', name: '3875-3883 E Livingston Ave, Columbus OH', type: 'Flex', lender: null, loanBalance: 0 };
const RESIDENCE: P = { id: 'p-res', name: '9510 Persimmon Tree Rd, Potomac MD', type: 'Residence', lender: null, loanBalance: 0 };
const EASTON_LOAN: L = { id: 'b-easton', name: '29000 Information Lane', direction: 'borrower', absBalance: 2_456_789.12, lender: 'Oxford / Lender 03', counterparty: 'Oxford / Lender 03', collateralProperty: '29000 Information Lane, Easton MD' };
const LOAN_3883: L = { id: 'b-3883', name: '3883 from Oxford (50%)', direction: 'borrower', absBalance: 333_333, lender: 'Lender 05 / Oxford Capital — Oxford 50% share', counterparty: 'Lender 05 / Oxford Capital — Oxford 50% share', collateralProperty: '3875-3883 E Livingston Ave, Columbus OH' };
const RARIG_NOTE: L = { id: 'n-rarig', name: 'Note Party 01', direction: 'lender', absBalance: 555_555, lender: null, counterparty: 'Firm 04 (Oxford Capital) — Oxford 50% share', collateralProperty: null };

describe('checkDebtBasis — per-row, affiliate notes excluded on both sides (2026-09-24)', () => {
  it('the live shape reconciles per row: Rarig (affiliate property row) and 3883 (affiliate borrower loan) drop out of the third-party comparison; only the affiliate-total flag remains', () => {
    // Ratified 2026-09-26: the two affiliate totals come from different spines (Rarig owes Oxford
    // Capital $1,111,111 on the property row; the loan schedule carries "3883 from Oxford (50%)"
    // $333,333) and legitimately differ — disclosed as ONE warn flag, never an error.
    const flags = checkDebtBasis(debtSnap([EASTON, RARIG, LIVINGSTON, RESIDENCE], [EASTON_LOAN, LOAN_3883, RARIG_NOTE]));
    expect(flags.map((f) => f.field)).toEqual(['debt.basis.affiliate']);
    expect(flags[0]).toMatchObject({ entity: 'debt', severity: 'warn' });
    expect(flags[0]!.issue).toContain('$1,111,111');
    expect(flags[0]!.issue).toContain('$333,333');
    expect(flags[0]!.issue).toContain('gap $777,778');
  });

  it('a property row that disagrees with its attributed loan is listed by name with both figures and the gap', () => {
    const flags = checkDebtBasis(debtSnap([{ ...EASTON, loanBalance: 2_800_000 }], [EASTON_LOAN]));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'debt', field: 'debt.basis.property.p-easton', severity: 'warn' });
    expect(flags[0]!.issue).toBe(
      '29000 Information Lane, Easton MD: Property NOI sheet loan balance $2,800,000 vs loan schedule $2,456,789 (29000 Information Lane) — gap $343,211',
    );
  });

  it('a property row with a balance but no attributed loan is listed', () => {
    const flags = checkDebtBasis(debtSnap([{ id: 'p-a', name: 'Alpha Flex', type: 'Flex', lender: 'Lender 08', loanBalance: 1_000_000 }], []));
    expect(flags.map((f) => f.field)).toEqual(['debt.basis.property.p-a']);
    expect(flags[0]!.issue).toContain('(no third-party loan attributed)');
    expect(flags[0]!.issue).toContain('gap $1,000,000');
  });

  it('a third-party loan whose collateral resolves to no property row is listed as unattributed', () => {
    const flags = checkDebtBasis(debtSnap([], [{ id: 'b-x', name: 'Mystery Note', direction: 'borrower', absBalance: 500_000, lender: 'Bank X', counterparty: 'Bank X', collateralProperty: null }]));
    expect(flags).toEqual([{
      entity: 'debt', field: 'debt.basis.loan.b-x', severity: 'warn',
      issue: 'Mystery Note: $500,000 on the loan schedule is not attributed to any property row (collateral blank)',
    }]);
  });

  it('two loans on one property are summed and named together', () => {
    const second: L = { ...EASTON_LOAN, id: 'b-easton-2', name: 'Easton Second', absBalance: 100_000 };
    const flags = checkDebtBasis(debtSnap([EASTON], [EASTON_LOAN, second]));
    expect(flags[0]!.issue).toContain('(29000 Information Lane, Easton Second)');
    expect(flags[0]!.issue).toContain('gap $100,000');
  });

  it('per-row tolerance is strictly > $1,000 (either sign)', () => {
    const at = (bal: number) => checkDebtBasis(debtSnap([{ ...EASTON, loanBalance: bal }], [{ ...EASTON_LOAN, absBalance: 100_000 }]));
    expect(at(101_000)).toEqual([]);
    expect(at(101_001)).toHaveLength(1);
    expect(at(98_999)).toHaveLength(1);
  });

  it('is order-independent at the exact $1,000.00 boundary (integer cents per loan; refute wf_fb49dbb9-c91)', () => {
    const a: L = { ...EASTON_LOAN, id: 'a', name: 'A', absBalance: 0.1 };
    const b: L = { ...EASTON_LOAN, id: 'b', name: 'B', absBalance: 0.2 };
    const prop = { ...EASTON, loanBalance: 1000.3 };
    expect(checkDebtBasis(debtSnap([prop], [a, b]))).toEqual([]);
    expect(checkDebtBasis(debtSnap([prop], [b, a]))).toEqual([]);
  });

  it('a loan collateralised by the residence is counted in Capital › Debt External Debt but outside Overview Total Debt — disclosed, not silently dropped (refute wf_2b574580-61b)', () => {
    const resLoan: L = { id: 'b-res', name: 'Persimmon mortgage', direction: 'borrower', absBalance: 900_000, lender: 'Wells', counterparty: 'Wells', collateralProperty: '9510 Persimmon Tree Rd, Potomac MD' };
    expect(checkDebtBasis(debtSnap([{ ...RESIDENCE, loanBalance: 900_000 }], [resLoan]))).toEqual([{
      entity: 'debt', field: 'debt.basis.loan.b-res', severity: 'warn',
      issue: 'Persimmon mortgage: $900,000 on the loan schedule is counted in Capital › Debt External Debt but outside Overview Total Debt (other holding: 9510 Persimmon Tree Rd, Potomac MD)',
    }]);
  });

  it('aggregate guard: rows each within tolerance but summing past it → no per-row flag, one root flag (refute wf_2b574580-61b)', () => {
    const beta: P = { id: 'p-beta', name: 'Beta Flex', type: 'Flex', lender: 'Bank B', loanBalance: 200_999 };
    const betaLoan: L = { id: 'b-beta', name: 'Beta Loan', direction: 'borrower', absBalance: 200_000, lender: 'Bank B', counterparty: 'Bank B', collateralProperty: 'Beta Flex' };
    const flags = checkDebtBasis(debtSnap([{ ...EASTON, loanBalance: 2_457_788.12 }, beta], [EASTON_LOAN, betaLoan]));
    expect(flags.map((f) => f.field)).toEqual(['debt.basis']);
    expect(flags[0]).toMatchObject({ entity: 'debt', severity: 'warn' });
    expect(flags[0]!.issue).toContain('$2,658,787');
    expect(flags[0]!.issue).toContain('$2,656,789');
    expect(flags[0]!.issue).toContain('residual gap across rows within tolerance $1,998');
  });

  it('residual guard: a flagged row does not hide the sub-tolerance residue of the other rows (reviewer, Important)', () => {
    const row = (i: number, extra: number): [P, L] => [
      { id: `p-${i}`, name: `Row ${i}`, type: 'Flex', lender: 'Bank', loanBalance: 100_000 + extra },
      { id: `b-${i}`, name: `Loan ${i}`, direction: 'borrower', absBalance: 100_000, lender: 'Bank', counterparty: 'Bank', collateralProperty: `Row ${i}` },
    ];
    const rows = [row(0, 5_000), row(1, 999), row(2, 999), row(3, 999)];
    const flags = checkDebtBasis(debtSnap(rows.map((r) => r[0]), rows.map((r) => r[1])));
    expect(flags.map((f) => f.field).sort()).toEqual(['debt.basis', 'debt.basis.property.p-0']);
    const root = flags.find((f) => f.field === 'debt.basis')!;
    expect(root.severity).toBe('warn');
    expect(root.issue).toContain('residual gap across rows within tolerance $2,997');
  });

  it('aggregate guard is silent when the aggregate is within tolerance', () => {
    const flags = checkDebtBasis(debtSnap([{ ...EASTON, loanBalance: 2_457_000 }], [EASTON_LOAN]));
    expect(flags).toEqual([]);
  });

  it('duplicate loan ids among third-party loans are flagged once and excluded from the comparison, in either row order (refute wf_2b574580-61b)', () => {
    const dupA: L = { ...EASTON_LOAN, id: 'dup', name: 'Dup A', absBalance: 2_000_000 };
    const dupB: L = { ...EASTON_LOAN, id: 'dup', name: 'Dup B', absBalance: 456_789.12 };
    const ab = checkDebtBasis(debtSnap([EASTON], [dupA, dupB]));
    const ba = checkDebtBasis(debtSnap([EASTON], [dupB, dupA]));
    expect(ab).toEqual(ba);
    expect(ab.map((f) => f.field).sort()).toEqual(['debt.basis.loan.dup', 'debt.basis.property.p-easton']);
    const dup = ab.find((f) => f.field === 'debt.basis.loan.dup')!;
    expect(dup.issue).toBe('2 third-party loan-schedule rows share id dup — not compared');
    expect(dup.severity).toBe('warn');
    const prop = ab.find((f) => f.field === 'debt.basis.property.p-easton')!;
    expect(prop.issue).toContain('(no third-party loan attributed)');
  });

  it('lender and internal directions never count on the loan side', () => {
    const internal: L = { id: 'i', name: 'Internal', direction: 'internal', absBalance: 2_900_000, counterparty: 'Firm 08' };
    expect(checkDebtBasis(debtSnap([EASTON], [EASTON_LOAN, RARIG_NOTE, internal]))).toEqual([]);
  });

  it('tolerates missing arrays (legacy fixture)', () => {
    expect(checkDebtBasis({ properties: undefined, loans: undefined } as never)).toEqual([]);
  });

  it('is NOT a reconciliation-entity flag and does NOT fire the CRITICAL "reconcile-fail" insight (PR-1 lesson)', () => {
    const flags = checkDebtBasis(debtSnap([{ ...EASTON, loanBalance: 2_800_000 }], [EASTON_LOAN]));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.entity).toBe('debt');
    const asOf = '2026-09-24';
    const snap = {
      meta: { schemaVersion: '1.0.0', asOf, generatedAt: '2026-09-24T00:00:00.000Z', source: 't', scenario: 'Base' },
      assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf },
      properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
      renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null,
      cash: { asOf, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
      dataQuality: flags,
    } as unknown as PortfolioSnapshot;
    const insights = evaluateConditions(snap, { now: Date.parse('2026-09-24T12:00:00.000Z') });
    expect(insights.some((i) => i.id === 'reconcile-fail')).toBe(false);
    expect(insights.some((i) => i.severity === 'critical')).toBe(false);
  });

  it('is wired into checkSnapshot and stays warn there', () => {
    const flags = checkSnapshot(base({
      properties: [{ id: 'p1', name: 'Alpha Flex', type: 'Flex', lender: 'Lender 08', loanBalance: 11_300_000 }],
      loans: [{ id: 'n1', name: 'Alpha Loan', direction: 'borrower', absBalance: 10_600_000, lender: 'Lender 08', counterparty: 'Lender 08', collateralProperty: 'Alpha Flex' }],
    }));
    const f = flags.find((x) => x.field === 'debt.basis.property.p1');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warn');
    expect(f!.issue).toContain('gap $700,000');
    expect(flags.some((x) => x.severity === 'error')).toBe(false);
  });
});

// Ratified 2026-09-26 (Gabriel): the property-row affiliate total (PortfolioKpis.affiliateDebt) and
// the loan-schedule affiliate total (DebtSummary.affiliateDebt) come from different spines and may
// legitimately differ. Both disclosures stay as built; the check discloses the gap as ONE warn flag.
describe('checkDebtBasis — affiliate totals cross-spine disclosure (2026-09-26)', () => {
  it('property-row affiliate total ≠ loan-schedule affiliate total by > $1,000 → one warn flag naming both totals and the gap', () => {
    const flags = checkDebtBasis(debtSnap([RARIG], [LOAN_3883]));
    expect(flags).toEqual([{
      entity: 'debt', field: 'debt.basis.affiliate', severity: 'warn',
      issue: 'Affiliate notes: Property NOI sheet $1,111,111 (rows with an Oxford-affiliate lender) vs loan schedule $333,333 (affiliate borrower loans) — gap $777,778',
    }]);
  });

  it('equal affiliate totals → no flag (and neither affiliate row enters the third-party comparison)', () => {
    const matched: L = { ...LOAN_3883, absBalance: 1_111_111, collateralProperty: '1100 Rarig Ave, Columbus OH' };
    expect(checkDebtBasis(debtSnap([RARIG], [matched]))).toEqual([]);
  });

  it('both affiliate totals zero → no flag', () => {
    expect(checkDebtBasis(debtSnap([EASTON, LIVINGSTON], [EASTON_LOAN]))).toEqual([]);
  });

  it('tolerance is the same $1,000 rule: exactly $1,000 → silent, $1,001 → flag (either sign)', () => {
    const at = (loanBal: number) => checkDebtBasis(debtSnap([{ ...RARIG, loanBalance: 100_000 }], [{ ...LOAN_3883, absBalance: loanBal }]));
    expect(at(101_000)).toEqual([]);
    expect(at(99_000)).toEqual([]);
    expect(at(101_001)).toHaveLength(1);
    expect(at(98_999)).toHaveLength(1);
  });

  it('is never an error and is matched by isDebtBasisFlag', () => {
    const [f] = checkDebtBasis(debtSnap([RARIG], [LOAN_3883]));
    expect(f!.severity).toBe('warn');
    expect(isDebtBasisFlag(f!)).toBe(true);
  });
});

describe('withRuntimeFlags (roadmap 2026-10-30, item 1.6)', () => {
  it('appends the runtime flags after the parse flags, so CLI writers persist what Brain.persist does', () => {
    const parseFlag = { entity: 'meta', field: 'asOf', issue: 'parse flag', severity: 'warn' as const };
    const s = base({ dataQuality: [parseFlag], cash: { totalCash: 999, entities: [{ id: 'e1', currentBalance: 500 }] } });
    const rt = checkSnapshot(s);
    expect(rt.length).toBeGreaterThan(0);
    expect(withRuntimeFlags(s).dataQuality).toEqual([parseFlag, ...rt]);
  });
  it('returns the same object when there is nothing to add', () => {
    const s = base();
    expect(withRuntimeFlags(s)).toBe(s);
  });
});
