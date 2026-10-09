// @vitest-environment node
//
// tests/unit/property-financials-mapping-v3.test.ts — account-mapping v3 (Gabriel ruling 2026-10-06):
// prepaid rent is treated the SAME way for every source layout — EXCLUDED from revenue and NOI, matching
// the NOI definition ("revenue excluding security-deposit receipts and unallocated prepays"). AppFolio
// `Unallocated Prepays` was already excluded (AF-INC-UNALLOCATED-PREPAYS); the Yardi cash-flow layout's
// `RENTAL REVENUE › Prepaid Rental Income` was counted as contra-revenue (CF-RENTAL-REVENUE-CONTRA). v3 is
// v2 byte-identical plus ONE exclusion rule placed ahead of the contra rule (first match wins).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRecord, normalizeRecords, parseAccountMapping, type RawRecord } from '@analytics/property-financials/normalize';
import { latestMappingVersion, loadConfig } from '../../scripts/property-financials/lib/io';

const CONFIG_DIR = resolve(process.cwd(), 'scripts', 'property-financials', 'config');
const read = (v: string) => JSON.parse(readFileSync(resolve(CONFIG_DIR, `account-mapping.${v}.json`), 'utf8')) as {
  version: string;
  categories: unknown;
  excludedEntities: unknown;
  rules: Array<{ id: string; when: Record<string, unknown>; then: Record<string, unknown> }>;
};
const V2 = read('v2');
const V3 = read('v3');
const M2 = parseAccountMapping(V2);
const M3 = parseAccountMapping(V3);

const NEW_RULE = 'CF-RENTAL-REVENUE-PREPAID';

const cf = (account: string, group = 'RENTAL REVENUE', amount = 100): RawRecord => ({
  entity: '1900 Broadway', period: '2025-03', layout: 'CF', section: null, group, account, amount, isTotal: false,
});

describe('account-mapping.v3 — prepaid rent excluded for every layout', () => {
  it('is v2 byte-identical plus exactly the one CF prepaid exclusion rule', () => {
    expect(V3.version).toBe('v3');
    expect(V3.categories).toEqual(V2.categories);
    expect(V3.excludedEntities).toEqual(V2.excludedEntities);
    const added = V3.rules.filter((r) => !V2.rules.some((x) => x.id === r.id));
    expect(added.map((r) => r.id)).toEqual([NEW_RULE]);
    // v3 minus the added rule equals v2, rule for rule and in order
    expect(V3.rules.filter((r) => r.id !== NEW_RULE)).toEqual(V2.rules);
  });

  it('places the exclusion ahead of the CF contra-revenue rule (first match wins)', () => {
    const ids = V3.rules.map((r) => r.id);
    expect(ids.indexOf(NEW_RULE)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(NEW_RULE)).toBeLessThan(ids.indexOf('CF-RENTAL-REVENUE-CONTRA'));
  });

  it('excludes RENTAL REVENUE › Prepaid Rental Income under v3; v2 counted it as contra-revenue', () => {
    expect(classifyRecord(cf('Prepaid Rental Income'), M2)).toMatchObject({ kind: 'mapped', line_type: 'rev', category: 'Vacancy / waivers / bad debt', ruleId: 'CF-RENTAL-REVENUE-CONTRA' });
    expect(classifyRecord(cf('Prepaid Rental Income'), M3)).toMatchObject({ kind: 'excluded', ruleId: NEW_RULE });
  });

  it('leaves every other contra-revenue line, base rent and the AppFolio / Yardi-adjustment prepaid treatments unchanged', () => {
    for (const a of ['Bad Debt', 'COVID Waivers', 'Commercial Rental Waiver', 'Vacancy']) {
      expect(classifyRecord(cf(a), M3), a).toEqual(classifyRecord(cf(a), M2));
      expect(classifyRecord(cf(a), M3), a).toMatchObject({ kind: 'mapped', category: 'Vacancy / waivers / bad debt' });
    }
    expect(classifyRecord(cf('Rental Revenue'), M3)).toMatchObject({ kind: 'mapped', category: 'Base rent' });
    // AppFolio unallocated prepays: already excluded in v2, still excluded by the same rule
    const af: RawRecord = { entity: 'FVC', period: '2025-03', layout: 'AF', section: 'INCOME', group: null, account: 'Unallocated Prepays', amount: 50, isTotal: false };
    expect(classifyRecord(af, M3)).toEqual(classifyRecord(af, M2));
    expect(classifyRecord(af, M3)).toMatchObject({ kind: 'excluded', ruleId: 'AF-INC-UNALLOCATED-PREPAYS' });
    // Info Lane's "ADJUSTMENTS › Prepaid Rent" balance-sheet line: already excluded by CF-ADJ-BALANCE-SHEET
    expect(classifyRecord(cf('Prepaid Rent', 'ADJUSTMENTS'), M3)).toMatchObject({ kind: 'excluded', ruleId: 'CF-ADJ-BALANCE-SHEET' });
  });

  it('normalising with v3 equals v2 minus the prepaid rows', () => {
    const recs = [cf('Rental Revenue', 'RENTAL REVENUE', 1000), cf('Prepaid Rental Income', 'RENTAL REVENUE', 250), cf('Vacancy', 'RENTAL REVENUE', -40)];
    const kinds = { '1900 Broadway': 'monthly' } as const;
    const r2 = normalizeRecords(recs, M2, kinds);
    const r3 = normalizeRecords(recs, M3, kinds);
    expect(r3.rows).toEqual(r2.rows.filter((r) => r.source_account !== 'Prepaid Rental Income'));
    expect(r3.rows).toHaveLength(2);
  });

  it('is the default mapping version', () => {
    expect(latestMappingVersion()).toBe('v3');
    expect(loadConfig().mapping.version).toBe('v3');
  });
});
