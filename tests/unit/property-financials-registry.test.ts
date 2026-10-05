// @vitest-environment node
//
// tests/unit/property-financials-registry.test.ts — T9a step 3. The module's entity constants live in
// the architect-owned contract (src/contracts/property-financials.ts); the refresh pipeline's identity
// source is scripts/property-financials/config/entities.json. Neither may drift from the other, and a
// new entity must flow through the dataset BUILDER on data alone (registry row + CSV rows + sf entry)
// — the contract is then the only gate, by design.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEASE_UP_EXCLUDED,
  OPEX_CATEGORIES,
  PF_ANNUAL_ENTITY_IDS,
  PF_ENTITY_IDS,
  PF_MONTHLY_ENTITY_IDS,
  REVENUE_CATEGORIES,
  BELOW_LINE_KEYS,
  SAME_STORE,
  parsePropertyFinancialsDataset,
} from '@contracts/property-financials';
import { parseMonthlyLong, type MonthlyLongRow } from '@analytics/property-financials/aggregate';
import { buildDataset, parseCuratedInputs, parseDerivationConfig, parseEntityRegistry } from '@analytics/property-financials/build-dataset';
import { parseAccountMapping } from '@analytics/property-financials/normalize';
import { pyRound } from '@analytics/property-financials/pyfloat';
import { loadCsvText, loadDataset } from './property-financials-helpers';

const root = process.cwd();
const CONFIG_DIR = resolve(root, 'scripts', 'property-financials', 'config');
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const REGISTRY = parseEntityRegistry(readJson(resolve(CONFIG_DIR, 'entities.json')));
const MAPPING = parseAccountMapping(readJson(resolve(CONFIG_DIR, 'account-mapping.v1.json')));
const DERIVATION = parseDerivationConfig(readJson(resolve(CONFIG_DIR, 'derivation.v1.json')));
const CURATED = parseCuratedInputs({
  meta: readJson(resolve(CONFIG_DIR, 'curated', 'meta.json')),
  insights: readJson(resolve(CONFIG_DIR, 'curated', 'insights.json')),
  leases: readJson(resolve(CONFIG_DIR, 'curated', 'leases.json')),
  data_quality: readJson(resolve(CONFIG_DIR, 'curated', 'data_quality.json')),
  sf: readJson(resolve(CONFIG_DIR, 'curated', 'sf.json')),
});

describe('entities.json agrees with the contract constants', () => {
  it('lists exactly the contract entity ids, in dataset order, with the contract kinds', () => {
    expect(REGISTRY.entities.map((e) => e.id)).toEqual([...PF_ENTITY_IDS]);
    expect(REGISTRY.entities.filter((e) => e.kind === 'monthly').map((e) => e.id)).toEqual([...PF_MONTHLY_ENTITY_IDS]);
    expect(REGISTRY.entities.filter((e) => e.kind === 'annual').map((e) => e.id)).toEqual([...PF_ANNUAL_ENTITY_IDS]);
  });

  it('same-store and lease-up flags reproduce SAME_STORE and LEASE_UP_EXCLUDED', () => {
    expect(REGISTRY.entities.filter((e) => e.sameStore).map((e) => e.id)).toEqual([...SAME_STORE]);
    // The contract lists the lease-up set in its own (non-dataset) order; membership is what must agree.
    expect(REGISTRY.entities.filter((e) => e.leaseUp).map((e) => e.id).sort()).toEqual([...LEASE_UP_EXCLUDED].sort());
    // FY same-store = same-store PM exports + both annual entities (data dictionary "Same-store set").
    expect(REGISTRY.entities.filter((e) => e.sameStoreFy).map((e) => e.id)).toEqual([...SAME_STORE, ...PF_ANNUAL_ENTITY_IDS]);
    for (const e of REGISTRY.entities) expect(e.sameStore && e.leaseUp, `${e.id} cannot be both same-store and lease-up`).toBe(false);
  });

  it('labels and sources match the committed dataset, and every canonicalId is a warehouse property-master id', () => {
    const D = loadDataset();
    for (const e of REGISTRY.entities) {
      expect(D.properties[e.id as keyof typeof D.properties].label, e.id).toBe(e.label);
      expect(D.properties[e.id as keyof typeof D.properties].source, e.id).toBe(e.source);
    }
    const master = readFileSync(resolve(root, 'server', 'warehouse', 'property-master.ts'), 'utf8');
    for (const e of REGISTRY.entities) expect(master, `${e.id} -> ${e.canonicalId}`).toContain(`id: '${e.canonicalId}'`);
    expect(new Set(REGISTRY.entities.map((e) => e.canonicalId)).size).toBe(REGISTRY.entities.length);
  });

  it('the mapping categories equal the contract category constants (order included)', () => {
    expect(MAPPING.categories.revenue).toEqual([...REVENUE_CATEGORIES]);
    expect(MAPPING.categories.opex).toEqual([...OPEX_CATEGORIES]);
    expect(Object.keys(MAPPING.categories.below_line)).toEqual([...BELOW_LINE_KEYS]);
  });
});

describe('a 12th entity added to the registry + CSV only flows through the builder with no code change', () => {
  const ROWS = parseMonthlyLong(loadCsvText());
  const NEW_ID = 'Zeta Flex Park';
  // Synthetic rows: 1100 Rarig's rows re-labelled and scaled, so every layout path (periods, cube,
  // movers, history, run-rate) is exercised with plausible shapes. Not real data.
  const synthetic: MonthlyLongRow[] = ROWS.filter((r) => r.entity === '1100 Rarig').map((r) => ({ ...r, entity: NEW_ID, amount_usd: pyRound(r.amount_usd * 1.1, 2) }));
  const registry = {
    ...REGISTRY,
    entities: [
      ...REGISTRY.entities,
      { id: NEW_ID, label: 'Zeta Flex Park (synthetic)', kind: 'monthly' as const, layout: 'AF', source: 'synthetic test fixture', sameStore: false, sameStoreFy: false, leaseUp: true, canonicalId: 'zeta-flex-park-synthetic' },
    ],
  };
  const curated = { ...CURATED, sf: { ...CURATED.sf, [NEW_ID]: { sf: 12000, leased_sf: 11000, occ: 0.9167, note: 'synthetic' } } };
  const built = buildDataset({ rows: [...ROWS, ...synthetic], registry, curated, derivation: DERIVATION, categories: MAPPING.categories }) as Record<string, Record<string, unknown>>;

  it('appears in properties, monthly, account_movers, history and sf with the full derived shape', () => {
    const p = built.properties![NEW_ID] as Record<string, unknown>;
    expect(p).toMatchObject({ id: NEW_ID, kind: 'monthly', label: 'Zeta Flex Park (synthetic)', first_month: '2023-10', last_month: '2026-09', sf: 12000, leased_sf: 11000, occupancy: 0.9167 });
    expect(Object.keys(p.periods as object)).toEqual(['FY2024', 'FY2025', 'YTD25', 'YTD26', 'TTM25', 'TTM26']);
    expect(Object.keys(p.yoy as object)).toEqual(['FY2025_vs_FY2024', 'TTM26_vs_TTM25', 'YTD26_vs_YTD25']);
    expect(Object.keys(built.monthly![NEW_ID] as object)).toHaveLength(33);
    expect(Object.keys(built.account_movers![NEW_ID] as object).sort()).toEqual(['FY2025_vs_FY2024', 'YTD26_vs_YTD25']);
    const h = built.history![NEW_ID] as { monthly: boolean; yr: Record<string, unknown>; drv: Record<string, unknown[]>; ev: unknown[]; months: { g: string[] } };
    expect(h.monthly).toBe(true);
    expect(Object.keys(h.yr)).toEqual(['2023', '2024', '2025', '2026']);
    expect(Object.keys(h.drv)).toEqual(['2025', 'YTD26']);
    expect(h.months.g).toHaveLength(36);
    expect(h.ev.length).toBeGreaterThan(0);
    expect(built.sf![NEW_ID]).toEqual({ sf: 12000, leased_sf: 11000, occ: 0.9167, note: 'synthetic' });
    // Scaled figures scale: FY2024 base rent is 1.1x Rarig's, to the cent of the row-level rounding.
    const rarig = (built.properties!['1100 Rarig'] as { periods: { FY2024: { base_rent: number } } }).periods.FY2024.base_rent;
    const zeta = (p.periods as { FY2024: { base_rent: number } }).FY2024.base_rent;
    expect(Math.abs(zeta - rarig * 1.1)).toBeLessThan(0.5);
  });

  it('the existing 11 entities are untouched by the addition (lease-up entity: no portfolio membership)', () => {
    const baseline = buildDataset({ rows: ROWS, registry: REGISTRY, curated: CURATED, derivation: DERIVATION, categories: MAPPING.categories }) as Record<string, unknown>;
    for (const id of PF_ENTITY_IDS) {
      expect((built.properties as Record<string, unknown>)[id]).toEqual((baseline.properties as Record<string, unknown>)[id]);
      expect((built.history as Record<string, unknown>)[id]).toEqual((baseline.history as Record<string, unknown>)[id]);
    }
    expect(built.portfolio).toEqual(baseline.portfolio);
  });

  it('is then refused by the strict contract until the architect-owned constants admit it — the contract is the gate, not the builder', () => {
    expect(() => parsePropertyFinancialsDataset(JSON.parse(JSON.stringify(built)))).toThrow(/unrecognized_keys \[Zeta Flex Park\]/);
  });
});
