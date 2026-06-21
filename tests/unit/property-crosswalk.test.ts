// @vitest-environment node
//
// tests/unit/property-crosswalk.test.ts
//
// Phase 2 — loan-to-property binding crosswalk.
// Tests for resolvePropertyMasterId() and buildLoanPropertyMap().
//
// Verifies:
//   - Aligned address name (slug === id) → identity resolution
//   - Entity name via alias → curated id (Sepich Portfolio)
//   - Blank / null collateralProperty → null
//   - Unknown name → slug fallback (unattributed, not dropped)
//   - buildLoanPropertyMap: two loans from one lender on two properties → two distinct property ids
//   - buildLoanPropertyMap: unresolvable collateralProperty → in unresolved list, not in map
import { describe, expect, it } from 'vitest';
import {
  resolvePropertyMasterId,
  buildLoanPropertyMap,
  PROPERTY_ALIASES,
} from '../../server/warehouse/property-crosswalk';
import type { Loan } from '../../src/contracts/index';

// ── Fixture properties (subset of CANON_PROPERTIES for crosswalk tests) ───────────────────

const PROPS = [
  { id: '3540-e-5th-ave-columbus-oh', name: '3540 E. 5th Ave, Columbus OH' },
  { id: 'sepich-portfolio-columbus-oh-8-props', name: 'FVC — Fairground Village Center / Sepich Portfolio (8 props)' },
  { id: '1100-rarig-ave-columbus-oh', name: '1100 Rarig Ave, Columbus OH' },
  { id: '29000-information-lane-easton-md', name: '29000 Information Lane, Easton MD' },
  { id: '1851-s-club-solar', name: '1851 S Club — Solar (25% roof project)' },
];

// ── Helper: minimal borrower loan fixture ─────────────────────────────────────────────────

function makeLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-001',
    name: 'Test Mortgage',
    counterparty: 'Test Bank',
    direction: 'borrower',
    originalPrincipal: 1_000_000,
    currentBalance: 850_000,
    absBalance: 850_000,
    rate: 0.06,
    monthlyPmt: 5_000,
    annualInterest: 51_000,
    annualPrincipal: 9_000,
    loanType: 'Amortizing',
    status: 'Active',
    isDemand: false,
    maturity: '2031-01-01',
    monthsToMaturity: 54,
    ltv: 0.35,
    lender: 'Test Bank',
    balloon: false,
    flags: [],
    collateralProperty: null,
    ...overrides,
  };
}

// ── resolvePropertyMasterId ───────────────────────────────────────────────────────────────

describe('resolvePropertyMasterId — aligned address name (slug === id)', () => {
  it('3540 E. 5th Ave, Columbus OH → identity id', () => {
    const result = resolvePropertyMasterId('3540 E. 5th Ave, Columbus OH', PROPS);
    expect(result).toBe('3540-e-5th-ave-columbus-oh');
  });

  it('1100 Rarig Ave, Columbus OH → identity id', () => {
    const result = resolvePropertyMasterId('1100 Rarig Ave, Columbus OH', PROPS);
    expect(result).toBe('1100-rarig-ave-columbus-oh');
  });

  it('matching is case-insensitive and trims whitespace', () => {
    const result = resolvePropertyMasterId('  3540 E. 5th Ave, Columbus OH  ', PROPS);
    expect(result).toBe('3540-e-5th-ave-columbus-oh');
  });
});

describe('resolvePropertyMasterId — entity name via alias (slug !== id)', () => {
  it('FVC entity name → curated sepich-portfolio id', () => {
    const result = resolvePropertyMasterId(
      'FVC — Fairground Village Center / Sepich Portfolio (8 props)',
      PROPS,
    );
    expect(result).toBe('sepich-portfolio-columbus-oh-8-props');
  });

  it('1851 S Club Solar → curated 1851-s-club-solar id via alias', () => {
    const result = resolvePropertyMasterId('1851 S Club — Solar (25% roof project)', PROPS);
    expect(result).toBe('1851-s-club-solar');
  });
});

describe('resolvePropertyMasterId — blank / null', () => {
  it('null → null', () => {
    expect(resolvePropertyMasterId(null, PROPS)).toBeNull();
  });

  it('empty string → null', () => {
    expect(resolvePropertyMasterId('', PROPS)).toBeNull();
  });

  it('whitespace-only → null', () => {
    expect(resolvePropertyMasterId('   ', PROPS)).toBeNull();
  });
});

describe('resolvePropertyMasterId — unknown name → slug fallback', () => {
  it('unknown name returns slug (not null, not dropped)', () => {
    const result = resolvePropertyMasterId('Some Unknown Industrial Park', PROPS);
    // Slug fallback — not null, write path will then flag if not in property_master
    expect(result).toBe('some-unknown-industrial-park');
  });
});

describe('PROPERTY_ALIASES map', () => {
  it('contains the FVC Sepich alias', () => {
    expect(PROPERTY_ALIASES['fvc-fairground-village-center-sepich-portfolio-8-props']).toBe('sepich-portfolio-columbus-oh-8-props');
  });

  it('contains the Solar alias', () => {
    expect(PROPERTY_ALIASES['1851-s-club-solar-25-roof-project']).toBe('1851-s-club-solar');
  });
});

// ── buildLoanPropertyMap helpers ─────────────────────────────────────────────────────────

// The valid id set for crosswalk tests mirrors the PROPS fixture above.
const VALID_IDS = new Set(PROPS.map((p) => p.id));

// ── buildLoanPropertyMap — the original defect ───────────────────────────────────────────

describe('buildLoanPropertyMap — two loans from ONE lender on TWO different properties', () => {
  it('each loan maps to its OWN property_master id (not cross-product, not shared)', () => {
    const loans: Loan[] = [
      makeLoan({
        id: 'borrower-loan-a',
        lender: 'Acme Lending LLC',
        collateralProperty: '3540 E. 5th Ave, Columbus OH',
      }),
      makeLoan({
        id: 'borrower-loan-b',
        lender: 'Acme Lending LLC', // SAME lender
        collateralProperty: '29000 Information Lane, Easton MD',
      }),
    ];

    const { map, unresolved } = buildLoanPropertyMap(loans, PROPS, VALID_IDS);

    // Both loans have distinct collateral properties — no cross-product
    expect(map.get('borrower-loan-a')).toBe('3540-e-5th-ave-columbus-oh');
    expect(map.get('borrower-loan-b')).toBe('29000-information-lane-easton-md');
    // Properties are different — the original defect assigned same property to both
    expect(map.get('borrower-loan-a')).not.toBe(map.get('borrower-loan-b'));
    expect(unresolved).toHaveLength(0);
  });
});

describe('buildLoanPropertyMap — unresolvable collateralProperty', () => {
  it('loan with null collateralProperty → in unresolved list, not in map', () => {
    const loans: Loan[] = [
      makeLoan({ id: 'loan-flagged', collateralProperty: null }),
    ];
    const { map, unresolved } = buildLoanPropertyMap(loans, PROPS, VALID_IDS);
    expect(map.has('loan-flagged')).toBe(false);
    expect(unresolved).toContain('loan-flagged');
  });

  it('loan with non-blank collateralProperty that resolves to an id NOT in validPropertyIds → unresolved (not in map)', () => {
    // This is the typo/unrecognised-name case: resolvePropertyMasterId returns a non-null slug,
    // but that slug is not a real property_master id — must land in unresolved, not in the map.
    const loans: Loan[] = [
      makeLoan({ id: 'loan-typo-prop', collateralProperty: 'Mystery Park Building X' }),
    ];
    // Pass an EMPTY validPropertyIds set so the resolved slug fails the guard
    const emptyValidIds = new Set<string>();
    const { map, unresolved } = buildLoanPropertyMap(loans, PROPS, emptyValidIds);
    expect(map.has('loan-typo-prop')).toBe(false);
    expect(unresolved).toContain('loan-typo-prop');
  });

  it('lender-direction loans are excluded from the map', () => {
    const loans: Loan[] = [
      makeLoan({ id: 'lender-loan', direction: 'lender', collateralProperty: '3540 E. 5th Ave, Columbus OH' }),
    ];
    const { map, unresolved } = buildLoanPropertyMap(loans, PROPS, VALID_IDS);
    expect(map.has('lender-loan')).toBe(false);
    expect(unresolved).toHaveLength(0); // lender loans are not counted as unresolved
  });
});
