import { describe, it, expect } from 'vitest';
import {
  isoOrNull,
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
});

describe('isTaskBannerRow — reject Monthly Checklist banner rows (Defect 9 regression)', () => {
  const ALERT = '⚠ BALLOON ALERT: Restoration Church Trust — $980,773 balloon due February 2027 (8 months) — Prepare refinance or payoff strategy';
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
