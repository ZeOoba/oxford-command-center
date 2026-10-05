// @vitest-environment node
//
// tests/unit/property-financials-contract.test.ts — T1 of docs/superpowers/plans/2026-10-05-property-financials-module.md.
// The committed dataset must parse through the strict contract, and every class of silent drift
// (missing key, wrong type, unknown key, NaN) must fail loudly with a sanitized error.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANNUAL_PARTIAL_PERIOD,
  LEASE_UP_EXCLUDED,
  OPEX_CATEGORIES,
  PF_ANNUAL_ENTITY_IDS,
  PF_ENTITY_IDS,
  PF_MONTHLY_ENTITY_IDS,
  PfDataset,
  REVENUE_CATEGORIES,
  SAME_STORE,
  STANDARD_PERIODS,
  parsePropertyFinancialsDataset,
} from '@contracts/property-financials';
import * as contracts from '@contracts/index';

const DATASET_PATH = fileURLToPath(new URL('../../data/property-financials/dataset.json', import.meta.url));
const RAW_TEXT = readFileSync(DATASET_PATH, 'utf8');

/** A fresh deep copy per test so mutations never leak between cases. */
function freshRaw(): Record<string, unknown> {
  return JSON.parse(RAW_TEXT) as Record<string, unknown>;
}

function expectThrowsSanitized(raw: unknown, pathFragment: string): void {
  let caught: unknown;
  try {
    parsePropertyFinancialsDataset(raw);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  const msg = (caught as Error).message;
  expect(msg).toContain('property-financials dataset failed validation');
  expect(msg).toContain(pathFragment);
}

describe('property-financials contract: constants', () => {
  it('declares the 11 entity ids (9 monthly + 2 annual) with no Northwood', () => {
    expect(PF_ENTITY_IDS).toHaveLength(11);
    expect(PF_MONTHLY_ENTITY_IDS).toHaveLength(9);
    expect(PF_ANNUAL_ENTITY_IDS).toEqual(['55 New Plant (EGFLLC)', '1851 South Club Solar']);
    expect([...PF_MONTHLY_ENTITY_IDS, ...PF_ANNUAL_ENTITY_IDS]).toEqual([...PF_ENTITY_IDS]);
    for (const id of PF_ENTITY_IDS) expect(id).not.toMatch(/northwood/i);
  });

  it('pins the opex categories in their fixed display order and the revenue categories', () => {
    expect(OPEX_CATEGORIES).toEqual([
      'Real estate & property tax',
      'Insurance',
      'Management fees',
      'Utilities',
      'Grounds / snow / lot',
      'Repairs & maintenance',
      'Turnover / make-ready',
      'Professional / admin',
    ]);
    expect(REVENUE_CATEGORIES).toEqual([
      'Base rent',
      'Vacancy / waivers / bad debt',
      'Recoveries (CAM/tax/ins)',
      'Utility reimbursements',
      'Other income',
      'Solar / energy income',
    ]);
  });

  it('pins the same-store set and the lease-up exclusions as disjoint subsets of the monthly ids', () => {
    expect(SAME_STORE).toEqual(['1100 Rarig', '1900 Broadway', '29000 Info Lane', '3540 E 5th', '9050 Red Branch', 'FVC']);
    expect(LEASE_UP_EXCLUDED).toEqual(['9620 State 350', '3034 Westerville', '3883 Livingston']);
    const monthly = new Set<string>(PF_MONTHLY_ENTITY_IDS);
    for (const id of [...SAME_STORE, ...LEASE_UP_EXCLUDED]) expect(monthly.has(id)).toBe(true);
    expect(SAME_STORE.some((id) => (LEASE_UP_EXCLUDED as readonly string[]).includes(id))).toBe(false);
    expect([...SAME_STORE, ...LEASE_UP_EXCLUDED].sort()).toEqual([...PF_MONTHLY_ENTITY_IDS].sort());
  });

  it('pins the period ids', () => {
    expect(STANDARD_PERIODS).toEqual(['FY2024', 'FY2025', 'YTD25', 'YTD26', 'TTM25', 'TTM26']);
    expect(ANNUAL_PARTIAL_PERIOD).toBe('YTD26_partial_thru_2026-06-12');
  });

  it('is re-exported from the contracts index like its siblings', () => {
    expect(contracts.PF_ENTITY_IDS).toBe(PF_ENTITY_IDS);
    expect(contracts.parsePropertyFinancialsDataset).toBe(parsePropertyFinancialsDataset);
  });
});

describe('property-financials contract: the committed dataset', () => {
  const parsed = parsePropertyFinancialsDataset(freshRaw());

  it('parses the real dataset.json through the strict schema', () => {
    expect(PfDataset.safeParse(freshRaw()).success).toBe(true);
    expect(Object.keys(parsed.properties).sort()).toEqual([...PF_ENTITY_IDS].sort());
    expect(Object.keys(parsed.monthly).sort()).toEqual([...PF_MONTHLY_ENTITY_IDS].sort());
    expect(Object.keys(parsed.account_movers).sort()).toEqual([...PF_MONTHLY_ENTITY_IDS].sort());
    expect(Object.keys(parsed.history).sort()).toEqual([...PF_ENTITY_IDS].sort());
    expect(Object.keys(parsed.sf).sort()).toEqual([...PF_ENTITY_IDS].sort());
    expect(parsed.meta.version).toBe('v03');
    expect(parsed.insights.length).toBeGreaterThan(0);
    expect(parsed.leases.length).toBeGreaterThan(0);
    expect(parsed.data_quality.length).toBeGreaterThan(0);
  });

  it('types the two entity kinds: monthly carry a run-rate + cube; annual carry nonop and the partial period', () => {
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const p = parsed.properties[id];
      expect(p.kind).toBe('monthly');
      if (p.kind !== 'monthly') throw new Error('unreachable');
      expect(Object.keys(p.periods).sort()).toEqual([...STANDARD_PERIODS].sort());
      expect(p.base_rent_runrate_q3).toBeDefined();
      expect(p.id).toBe(id);
    }
    for (const id of PF_ANNUAL_ENTITY_IDS) {
      const p = parsed.properties[id];
      expect(p.kind).toBe('annual');
      if (p.kind !== 'annual') throw new Error('unreachable');
      expect(Object.keys(p.periods).sort()).toEqual(['FY2024', 'FY2025', ANNUAL_PARTIAL_PERIOD].sort());
      expect(p.nonop).toBeDefined();
      expect(p.id).toBe(id);
    }
  });

  it('contains no Northwood entity anywhere in the keyed blocks (meta.excluded may name it)', () => {
    const keyed = [
      ...Object.keys(parsed.properties),
      ...Object.keys(parsed.monthly),
      ...Object.keys(parsed.account_movers),
      ...Object.keys(parsed.history),
      ...Object.keys(parsed.sf),
      ...Object.values(parsed.properties).map((p) => p.id),
      ...Object.values(parsed.properties).map((p) => p.label),
    ];
    for (const k of keyed) expect(k).not.toMatch(/northwood/i);
    expect(parsed.meta.excluded.join(' ')).toMatch(/Northwood/);
  });

  it('history months series are parallel arrays and rent-step events are well-formed', () => {
    for (const id of PF_ENTITY_IDS) {
      const h = parsed.history[id];
      if (h.monthly) {
        expect(h.months).not.toBeNull();
        if (!h.months) throw new Error('unreachable');
        expect(h.months.br).toHaveLength(h.months.g.length);
        expect(h.months.rv).toHaveLength(h.months.g.length);
        expect(h.months.ox).toHaveLength(h.months.g.length);
        expect(h.months.tx).toHaveLength(h.months.g.length);
      } else {
        expect(h.months).toBeNull();
        expect(h.ev).toEqual([]);
      }
    }
  });
});

describe('property-financials contract: fails loudly', () => {
  it('rejects a missing top-level key', () => {
    const raw = freshRaw();
    delete raw.history;
    expectThrowsSanitized(raw, 'history');
  });

  it('rejects a wrong type on a period figure', () => {
    const raw = freshRaw();
    const props = raw.properties as Record<string, { periods: Record<string, Record<string, unknown>> }>;
    const fy = props['1100 Rarig']?.periods.FY2024;
    if (!fy) throw new Error('fixture shape changed');
    fy.noi = '129655.5';
    expectThrowsSanitized(raw, 'properties.1100 Rarig.periods.FY2024.noi');
  });

  it('rejects an unknown key at the top level and inside a strict record', () => {
    const top = freshRaw();
    top.extra_block = {};
    expectThrowsSanitized(top, 'extra_block');

    const nested = freshRaw();
    const props = nested.properties as Record<string, { periods: Record<string, Record<string, unknown>> }>;
    const fy = props['1900 Broadway']?.periods.FY2025;
    if (!fy) throw new Error('fixture shape changed');
    fy.noi_pm_reported = 1;
    expectThrowsSanitized(nested, 'properties.1900 Broadway.periods.FY2025');
  });

  it('rejects an unknown entity key in properties (a stray Northwood block would fail here)', () => {
    const raw = freshRaw();
    const props = raw.properties as Record<string, unknown>;
    props['2203-2207 Northwood'] = props['1100 Rarig'];
    expectThrowsSanitized(raw, '2203-2207 Northwood');
  });

  it('rejects a period figure holding NaN or Infinity', () => {
    const raw = freshRaw();
    const props = raw.properties as Record<string, { periods: Record<string, Record<string, unknown>> }>;
    const ttm = props['FVC']?.periods.TTM26;
    if (!ttm) throw new Error('fixture shape changed');
    ttm.revenue = Number.NaN;
    expectThrowsSanitized(raw, 'properties.FVC.periods.TTM26.revenue');

    const raw2 = freshRaw();
    const props2 = raw2.properties as Record<string, { periods: Record<string, Record<string, unknown>> }>;
    const fy = props2['FVC']?.periods.FY2024;
    if (!fy) throw new Error('fixture shape changed');
    fy.opex = Number.POSITIVE_INFINITY;
    expectThrowsSanitized(raw2, 'properties.FVC.periods.FY2024.opex');
  });

  it('rejects a malformed month key in the monthly cube', () => {
    const raw = freshRaw();
    const cube = raw.monthly as Record<string, Record<string, unknown>>;
    const rarig = cube['1100 Rarig'];
    if (!rarig) throw new Error('fixture shape changed');
    rarig['2026-13'] = rarig['2026-09'];
    expectThrowsSanitized(raw, 'monthly.1100 Rarig');
  });

  it('never echoes input values in the error (path + code only)', () => {
    const raw = freshRaw();
    const props = raw.properties as Record<string, { periods: Record<string, Record<string, unknown>> }>;
    const fy = props['1100 Rarig']?.periods.FY2024;
    if (!fy) throw new Error('fixture shape changed');
    fy.noi = 'SECRET-SENTINEL-VALUE';
    let msg = '';
    try {
      parsePropertyFinancialsDataset(raw);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('SECRET-SENTINEL-VALUE');
    expect(msg).toContain('invalid_type');
  });

  it('rejects non-object input', () => {
    expectThrowsSanitized(null, '<root>');
    expectThrowsSanitized('[]', '<root>');
  });
});
