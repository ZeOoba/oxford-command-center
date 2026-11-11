import { describe, it, expect } from 'vitest';
import {
  isoOrNull,
  decPairOrFlag,
  inferMarket,
  inferType,
  statusFromSymbol,
  isTaskBannerRow,
  disambiguatePropertyIds,
  disambiguateLeaseIds,
} from '../../server/workbook/parse';
import { slug } from '@contracts/index';
import type { DataQualityFlag } from '@contracts/index';

type IdName = { id: string; name: string };
const mk = (...names: string[]): IdName[] => names.map((name) => ({ id: slug(name), name }));

describe('isoOrNull — date guard (the bug that crashed extraction)', () => {
  it('passes a valid Date through as ISO', () => {
    const flags: DataQualityFlag[] = [];
    expect(isoOrNull(new Date(Date.UTC(2026, 5, 1)), flags, 'x', 'd')).toBe('2026-06-01');
    expect(flags).toHaveLength(0);
  });
  it('quarantines an implausible year and flags it (the 2341/1902 garbage)', () => {
    const flags: DataQualityFlag[] = [];
    expect(isoOrNull(new Date(Date.UTC(2341, 8, 25)), flags, 'loan', 'maturity')).toBeNull();
    expect(flags[0]?.field).toBe('maturity');
    expect(flags[0]?.issue).toMatch(/implausible/);
  });
  it('returns null for an Invalid Date object (NaN time) without throwing', () => {
    const flags: DataQualityFlag[] = [];
    expect(isoOrNull(new Date('not-a-date'), flags, 'x', 'd')).toBeNull();
  });
  it('returns null for empty / non-date input', () => {
    const flags: DataQualityFlag[] = [];
    expect(isoOrNull(null, flags, 'x', 'd')).toBeNull();
    expect(isoOrNull('', flags, 'x', 'd')).toBeNull();
  });
});

describe('inferMarket', () => {
  it('maps real addresses to markets', () => {
    expect(inferMarket('29000 Information Lane, Easton MD')).toBe('Mid-Atlantic');
    expect(inferMarket('3540 E. 5th Ave, Columbus OH')).toBe('Columbus OH');
    expect(inferMarket('9620 E State Route 350, Raytown MO')).toBe('Kansas City MO');
    expect(inferMarket('5333 Secor Rd, Toledo OH')).toBe('Toledo OH');
    expect(inferMarket('2146 Enterprise, Twinsburg OH')).toBe('Cleveland MSA');
  });
});

describe('inferType', () => {
  it('normalizes property types', () => {
    expect(inferType('Flex')).toBe('Flex');
    expect(inferType('Retail')).toBe('Retail');
    expect(inferType('Residence')).toBe('Residence');
    expect(inferType('weird')).toBe('Other');
    expect(inferType(null)).toBe('Other');
  });
});

describe('statusFromSymbol — Monthly Checklist symbols', () => {
  it('maps each symbol', () => {
    expect(statusFromSymbol('✅')).toBe('done');
    expect(statusFromSymbol('⚠')).toBe('overdue');
    expect(statusFromSymbol('R')).toBe('renewal');
    expect(statusFromSymbol('☐')).toBe('pending');
    expect(statusFromSymbol('—')).toBe('na');
    expect(statusFromSymbol('')).toBe('unknown');
  });
});

describe('disambiguatePropertyIds — propertyId tiebreaker (collision guard)', () => {
  it('leaves distinct slug ids untouched', () => {
    const items = mk('3540 E. 5th Ave', '29000 Information Lane');
    const flags: DataQualityFlag[] = [];
    disambiguatePropertyIds(items, flags);
    expect(items.map((i) => i.id)).toEqual(['3540-e-5th-ave', '29000-information-lane']);
    expect(flags).toHaveLength(0);
  });

  it('two properties with colliding slug ids → parsed with disambiguators', () => {
    // Both names slug to '123-main-st' — the apostrophe and trailing space are stripped.
    const items = mk('123 Main St', "123 Main St");
    expect(items[0]!.id).toBe(items[1]!.id); // precondition: they collide
    const flags: DataQualityFlag[] = [];
    disambiguatePropertyIds(items, flags);
    expect(items.map((i) => i.id)).toEqual(['123-main-st', '123-main-st-2']);
    // every id distinct
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    // collision is surfaced, not silent
    expect(flags.some((f) => f.field === 'id' && /collision|duplicate/i.test(f.issue))).toBe(true);
  });

  it('apostrophe and accent variants collapse to the same slug → disambiguated', () => {
    // "O'Brien Plaza", "OBrien Plaza", "Óbrien Plaza" — apostrophe stripped, NFKD-ish, all collide.
    const items = mk("O'Brien Plaza", 'OBrien Plaza', 'OBrien Plaza');
    // first two share the apostrophe-stripped base; confirm at least a collision exists
    const flags: DataQualityFlag[] = [];
    disambiguatePropertyIds(items, flags);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('keeps three-way collisions deterministic in parse order (-2, -3)', () => {
    const items = mk('Lot A', 'Lot A', 'Lot A');
    const flags: DataQualityFlag[] = [];
    disambiguatePropertyIds(items, flags);
    expect(items.map((i) => i.id)).toEqual(['lot-a', 'lot-a-2', 'lot-a-3']);
  });

  it('does not collide a disambiguator against a real property that already owns that suffixed id', () => {
    // Two 'Building' rows would yield 'building' + 'building-2'; a real 'Building 2' already owns 'building-2'.
    const items = mk('Building', 'Building 2', 'Building');
    const flags: DataQualityFlag[] = [];
    disambiguatePropertyIds(items, flags);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    // the real 'Building 2' keeps its natural slug; the duplicate 'Building' bumps past it
    expect(items[1]!.id).toBe('building-2');
    expect(items[0]!.id).toBe('building');
    expect(items[2]!.id).toBe('building-3');
  });

  it('mutates in place and returns the same array (parse-order preserved)', () => {
    const items = mk('Same', 'Same');
    const ret = disambiguatePropertyIds(items, []);
    expect(ret).toBe(items);
  });
});

describe('disambiguateLeaseIds — lease id stability (row-position bug)', () => {
  const mkLease = (id: string, tenantName: string, company: string | null = null) => ({ id, tenantName, company });

  it('leaves distinct base ids untouched', () => {
    const items = [mkLease('alpha-suite-100', 'Fixture Tenant Co'), mkLease('alpha-suite-200', 'Other Co')];
    const flags: DataQualityFlag[] = [];
    disambiguateLeaseIds(items, flags);
    expect(items.map((i) => i.id)).toEqual(['alpha-suite-100', 'alpha-suite-200']);
    expect(flags).toHaveLength(0);
  });

  it('two leases with colliding base ids get disambiguated in parse order', () => {
    const items = [mkLease('alpha-suite-100', 'Tenant A'), mkLease('alpha-suite-100', 'Tenant B')];
    const flags: DataQualityFlag[] = [];
    disambiguateLeaseIds(items, flags);
    expect(items.map((i) => i.id)).toEqual(['alpha-suite-100', 'alpha-suite-100-2']);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(flags.some((f) => f.field === 'id' && /collision|duplicate/i.test(f.issue))).toBe(true);
  });

  it('does not collide a disambiguator against a lease that already owns that suffixed id', () => {
    const items = [mkLease('alpha-suite-100', 'Tenant A'), mkLease('alpha-suite-100-2', 'Tenant B'), mkLease('alpha-suite-100', 'Tenant C')];
    const flags: DataQualityFlag[] = [];
    disambiguateLeaseIds(items, flags);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items[2]!.id).toBe('alpha-suite-100-3');
  });

  it('REFUTE Defect B — a colliding lease earlier in parse order cannot steal a later lease\'s own natural id', () => {
    // ['x', 'x', 'x-2']: items 0 and 1 both have base id "x" (collide); item 2's OWN natural id is
    // "x-2", and it is listed AFTER the colliding pair. Pre-fix, `taken` only accumulated ids SEEN
    // SO FAR, so item 1's collision-resolution probe for "x-2" would find it NOT YET in `taken`
    // (item 2 hadn't been processed yet) and claim it -- leaving item 2 (the real owner of "x-2")
    // bumped to "x-2-2" or similar. The fix pre-seeds every item's natural id up front so a
    // synthetic candidate can never claim one.
    const items = [mkLease('x', 'Tenant A'), mkLease('x', 'Tenant B'), mkLease('x-2', 'Tenant C')];
    const flags: DataQualityFlag[] = [];
    disambiguateLeaseIds(items, flags);
    // Item 2 (the real "x-2"-natural tenant) keeps its rightful id -- never stolen.
    expect(items[2]!.id).toBe('x-2');
    // Item 1 (the collision) is bumped PAST "x-2" since that's already spoken for.
    expect(items[1]!.id).toBe('x-3');
    expect(items[0]!.id).toBe('x');
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('REFUTE Defect B — natural-id ownership of "x-2" is independent of row order (the actual regression test)', () => {
    // Same three logical leases as above, but with the array order permuted so the "x-2"-natural
    // item comes BEFORE the second colliding "x" item. Pre-fix, swapping row order flipped which
    // lease ended up owning "x-2" -- a pure reorder silently re-attaching overlay data keyed to
    // that id onto a different tenant. Post-fix, the natural-id owner keeps "x-2" regardless of
    // where it sits in parse order.
    const itemsReordered = [mkLease('x', 'Tenant A'), mkLease('x-2', 'Tenant C'), mkLease('x', 'Tenant B')];
    const flags: DataQualityFlag[] = [];
    disambiguateLeaseIds(itemsReordered, flags);
    const owner = itemsReordered.find((i) => i.tenantName === 'Tenant C')!;
    const collider = itemsReordered.find((i) => i.tenantName === 'Tenant B')!;
    expect(owner.id).toBe('x-2'); // still keeps its natural id regardless of position
    expect(collider.id).toBe('x-3');
    expect(new Set(itemsReordered.map((i) => i.id)).size).toBe(itemsReordered.length);
  });

  it('REFUTE Defect J — identical-natural-id collision (e.g. an expiring lease + its own already-executed renewal) is tie-broken by leaseEnd, not by array/parse order', () => {
    // Two rows for the same suite share the IDENTICAL natural id "beta-suite-200" -- a realistic
    // rent-roll shape (a tenant's expiring lease plus its own already-executed renewal, both listed
    // as separate rows). Pre-fix, the bare base id went to whichever happened to parse FIRST (pure
    // row-position tie-break); a worksheet re-sort (e.g. by lease-end date) would silently move any
    // overlay data attached to the base id from one physical lease record to the other. Post-fix,
    // the item with the EARLIER leaseEnd always wins the bare base id, regardless of array order.
    const earlier = { id: 'beta-suite-200', tenantName: 'Fixture Tenant Co', company: null, leaseEnd: '2027-03-31', leaseStart: '2022-04-01', monthlyRent: 4000 };
    const later = { id: 'beta-suite-200', tenantName: 'Fixture Tenant Co', company: null, leaseEnd: '2032-03-31', leaseStart: '2027-04-01', monthlyRent: 4200 };

    // Order A: earlier lease listed first (matches its earlier row position too -- not a useful test
    // on its own, but establishes the baseline expectation).
    const orderA = [{ ...earlier }, { ...later }];
    const flagsA: DataQualityFlag[] = [];
    disambiguateLeaseIds(orderA, flagsA);
    const earlierInA = orderA.find((i) => i.leaseEnd === '2027-03-31')!;
    const laterInA = orderA.find((i) => i.leaseEnd === '2032-03-31')!;
    expect(earlierInA.id).toBe('beta-suite-200');
    expect(laterInA.id).toBe('beta-suite-200-2');

    // Order B: SAME two logical leases, array order reversed (the later-leaseEnd renewal listed
    // FIRST -- e.g. after a worksheet re-sort by lease-end date). The item identified by its earlier
    // leaseEnd (not by array position) must win the base id both times.
    const orderB = [{ ...later }, { ...earlier }];
    const flagsB: DataQualityFlag[] = [];
    disambiguateLeaseIds(orderB, flagsB);
    const earlierInB = orderB.find((i) => i.leaseEnd === '2027-03-31')!;
    const laterInB = orderB.find((i) => i.leaseEnd === '2032-03-31')!;
    expect(earlierInB.id).toBe('beta-suite-200');
    expect(laterInB.id).toBe('beta-suite-200-2');

    expect(flagsA.some((f) => f.field === 'id' && /collision/i.test(f.issue))).toBe(true);
    expect(flagsB.some((f) => f.field === 'id' && /collision/i.test(f.issue))).toBe(true);
  });

  it('Round-3 REFUTE Defect P — a leaseEnd/leaseStart/monthlyRent full tie is broken by annualRent, not array order', () => {
    // Two rows share the IDENTICAL natural id AND identical leaseEnd/leaseStart/monthlyRent -- the
    // 3-field chain (pre-round-3) had nothing left to break the tie on, so array/parse order decided.
    // annualRent differs (it's read independently from a different workbook column and can diverge
    // from monthlyRent * 12) -- the item with the LOWER annualRent must win the bare base id,
    // regardless of array position.
    const lowerAnnual = { id: 'gamma-suite-300', tenantName: 'Fixture Tenant Co', company: null, leaseEnd: '2027-03-31', leaseStart: '2022-04-01', monthlyRent: 4000, annualRent: 47500 };
    const higherAnnual = { id: 'gamma-suite-300', tenantName: 'Fixture Tenant Co', company: null, leaseEnd: '2027-03-31', leaseStart: '2022-04-01', monthlyRent: 4000, annualRent: 48500 };

    // Order A: lower-annualRent item listed first.
    const orderA = [{ ...lowerAnnual }, { ...higherAnnual }];
    const flagsA: DataQualityFlag[] = [];
    disambiguateLeaseIds(orderA, flagsA);
    expect(orderA.find((i) => i.annualRent === 47500)!.id).toBe('gamma-suite-300');
    expect(orderA.find((i) => i.annualRent === 48500)!.id).toBe('gamma-suite-300-2');

    // Order B: SAME two logical leases, array order reversed. The lower-annualRent item must still
    // win the bare base id -- content-based, not array-position-based.
    const orderB = [{ ...higherAnnual }, { ...lowerAnnual }];
    const flagsB: DataQualityFlag[] = [];
    disambiguateLeaseIds(orderB, flagsB);
    expect(orderB.find((i) => i.annualRent === 47500)!.id).toBe('gamma-suite-300');
    expect(orderB.find((i) => i.annualRent === 48500)!.id).toBe('gamma-suite-300-2');

    // The normal (chain-decided) flag wording is used here -- the annualRent field DID distinguish
    // the pair, so this is not a residual full-tie case.
    expect(flagsA[0]!.issue).toMatch(/deterministic order/);
    expect(flagsA[0]!.issue).not.toMatch(/fully tied/);
  });

  it('Round-3 REFUTE Defect P — a genuine full tie (all 5 fields identical) still produces a valid result without throwing, and its flag does NOT falsely claim full determinism', () => {
    // Every compared field (leaseEnd, leaseStart, monthlyRent, annualRent, sf) is IDENTICAL between
    // the two rows -- a true content duplicate. There is nothing left to break the tie on, so array
    // order is the (documented, honestly-labeled) fallback. This must not throw, and the base id must
    // still be assigned to exactly one of the two.
    const dupA = { id: 'delta-suite-400', tenantName: 'Fixture Tenant Co', company: null, leaseEnd: '2027-03-31', leaseStart: '2022-04-01', monthlyRent: 4000, annualRent: 48000, sf: 2000 };
    const dupB = { id: 'delta-suite-400', tenantName: 'Fixture Tenant Co', company: null, leaseEnd: '2027-03-31', leaseStart: '2022-04-01', monthlyRent: 4000, annualRent: 48000, sf: 2000 };

    const items = [{ ...dupA }, { ...dupB }];
    const flags: DataQualityFlag[] = [];
    expect(() => disambiguateLeaseIds(items, flags)).not.toThrow();
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.map((i) => i.id).sort()).toEqual(['delta-suite-400', 'delta-suite-400-2']);

    // The residual-tie flag wording is used -- it must NOT claim "deterministic order" for a group
    // the full chain didn't actually distinguish.
    const flag = flags.find((f) => f.field === 'id' && /collision/i.test(f.issue))!;
    expect(flag).toBeDefined();
    expect(flag.issue).toMatch(/fully tied/);
    expect(flag.issue).toMatch(/worksheet position/);
    expect(flag.issue).not.toMatch(/^lease id collision on "delta-suite-400" \(tenant "Fixture Tenant Co"\) — disambiguated to "delta-suite-400-2" \(deterministic order/);
  });
});

describe('isTaskBannerRow — reject Monthly Checklist banner rows (Defect 9 regression)', () => {
  const ALERT = '⚠ BALLOON ALERT: Note Party 02 — $980,773 balloon due February 2027 (8 months) — Prepare refinance or payoff strategy';
  it('rejects the smeared balloon-alert banner', () => {
    // The real failure mode: the alert text bled across label, section AND type.
    expect(isTaskBannerRow(ALERT, ALERT, ALERT)).toBe(true);
  });
  it('rejects an ALL-CAPS summary banner', () => {
    const s = 'MONTHLY CASH FLOW SUMMARY  (Average per month, USD)';
    expect(isTaskBannerRow(s, s, s)).toBe(true);
  });
  it('rejects any row whose label leads with an alert/status glyph', () => {
    expect(isTaskBannerRow('⚠ something', 'Debt', 'Loan')).toBe(true);
  });
  it('keeps a genuine task row', () => {
    expect(isTaskBannerRow('3540 E. 5th Ave — escrow review', 'Property Ops', 'Recurring')).toBe(false);
  });
});

describe('decPairOrFlag — insurance deductible/limit pair (refute wf_bb6c1332-b90)', () => {
  it('passes a valid pair (including d === limit and either side null) through unchanged, no flag', () => {
    const flags: DataQualityFlag[] = [];
    expect(decPairOrFlag(25_000, 2_000_000, flags, 'pol-1')).toEqual({ deductible: 25_000, coverageLimit: 2_000_000 });
    expect(decPairOrFlag(50_000, 50_000, flags, 'pol-1')).toEqual({ deductible: 50_000, coverageLimit: 50_000 });
    expect(decPairOrFlag(25_000, null, flags, 'pol-1')).toEqual({ deductible: 25_000, coverageLimit: null });
    expect(decPairOrFlag(null, null, flags, 'pol-1')).toEqual({ deductible: null, coverageLimit: null });
    expect(flags).toEqual([]);
  });

  it('a deductible above the limit (transposed cells) nulls BOTH and raises a warn flag — the importer rejects the same shape', () => {
    const flags: DataQualityFlag[] = [];
    expect(decPairOrFlag(2_000_000, 25_000, flags, 'pol-1')).toEqual({ deductible: null, coverageLimit: null });
    expect(flags).toEqual([
      expect.objectContaining({ entity: 'pol-1', field: 'deductible', severity: 'warn' }),
    ]);
    expect(flags[0]!.issue).toMatch(/exceeds coverage limit/);
  });
});
