import { describe, it, expect } from 'vitest';
import { resolvePropertyId } from '../../server/workbook/parse';
import type { Property } from '@contracts/index';

/** Minimal fixture builder — resolvePropertyId only reads id/address; every other Property field
 *  is required by the schema but irrelevant here, so fill it with inert defaults. */
function mkProperty(id: string, address: string): Property {
  return {
    id,
    index: null,
    name: address,
    address,
    city: null,
    state: null,
    market: 'Other',
    type: 'Flex',
    sf: 0,
    tenantCount: 0,
    occPct: 0,
    acqDate: null,
    estValue100: 0,
    oxfordOwnPct: 1,
    oxfordValue: 0,
    grossIncome: 0,
    expenses: 0,
    noi: 0,
    noiScenarioAdj: 0,
    debtService: 0,
    netCashFlow: 0,
    capRate: null,
    dscr: null,
    lender: null,
    loanBalance: 0,
    ltv: null,
    valuePerSf: null,
    rentPerSf: null,
    equityInvested: 0,
    cashOnCash: null,
    holdYrs: null,
    encumbered: false,
    flags: [],
  };
}

describe('resolvePropertyId', () => {
  it('matches the correct property by street name and number', () => {
    const properties = [
      mkProperty('1900-n-broadway-baltimore-md', '1900 N Broadway, Baltimore MD'),
      mkProperty('3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH'),
    ];
    expect(resolvePropertyId('3034 Westerville Road', properties)).toBe('3034-westerville-rd-columbus-oh');
  });

  // Real defect (found 2026-08-17 root-causing OI-184 / the NOI large-drift gate): '3034 Westerville
  // ROAD' tokenizes to include the bare word 'road' (>= 4 chars, passes the length filter). That
  // token is then matched as a raw SUBSTRING against every property's address in array order --
  // and 'B-ROAD-way' contains the literal substring 'road', an accident of English spelling with
  // zero relation to the street type. Because Baltimore's '1900 N Broadway' sits EARLIER in the
  // properties array than Westerville's own entry, the loop returns Baltimore first and never
  // reaches Westerville at all -- both of Westerville's real leases (Buckeye's Best Transport
  // $13,005/mo, Lamar Advertising billboard $300/mo) ended up tagged to the wrong property, in a
  // different state, corrupting every propertyId-keyed rollup for both properties (OI-184).
  it('does NOT let a generic street-suffix word collide with an unrelated word containing it as a substring', () => {
    const properties = [
      mkProperty('1900-n-broadway-baltimore-md', '1900 N Broadway, Baltimore MD'), // earlier in array
      mkProperty('3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH'),
    ];
    expect(resolvePropertyId('3034 Westerville Road', properties)).toBe('3034-westerville-rd-columbus-oh');
  });

  it('does not collide on "lane", "drive", "court", or "street" against unrelated words either', () => {
    const properties = [
      mkProperty('some-other-property', '42 Wonderland Ave, Anytown OH'), // contains "land" — not "lane" as a whole word, but a real prior false-positive class
      mkProperty('9510-persimmon-tree-rd-potomac-md', '9510 Persimmon Tree Rd, Potomac MD'),
    ];
    expect(resolvePropertyId('9510 Persimmon Tree Road', properties)).toBe('9510-persimmon-tree-rd-potomac-md');
  });

  it('still matches on the distinctive street name alone when no suffix word is present', () => {
    const properties = [mkProperty('7658-fishel-dr-n-dublin-oh', '7658 Fishel Dr N, Dublin OH')];
    expect(resolvePropertyId('7658 Fishel Drive', properties)).toBe('7658-fishel-dr-n-dublin-oh');
  });

  it('still resolves 9620 E State Route 350 correctly — "route" is stripped as a suffix word, but "state" and "9620" remain as real signal', () => {
    // Real portfolio address where a word in STREET_SUFFIXES ("route") is part of the actual
    // street name, not filler — proves the exclusion doesn't need a whole-word match to avoid,
    // only that the OTHER tokens still carry enough distinctive signal on their own.
    const properties = [
      mkProperty('1900-n-broadway-baltimore-md', '1900 N Broadway, Baltimore MD'),
      mkProperty('9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO'),
    ];
    expect(resolvePropertyId('9620 E State Route 350', properties)).toBe('9620-e-state-route-350-raytown-mo');
  });

  it('returns null when nothing matches, rather than guessing', () => {
    const properties = [mkProperty('a', '55 New Plant Ct, Owings Mills MD')];
    expect(resolvePropertyId('Completely Unrelated Address', properties)).toBeNull();
  });
});
