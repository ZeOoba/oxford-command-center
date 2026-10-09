// @vitest-environment node
//
// tests/unit/property-financials-normalize.test.ts — T9a step 2: raw P&L records -> monthly-long rows.
// The mapping lives in scripts/property-financials/config/account-mapping.v1.json (data, not code); this
// file proves the normalizer applies it faithfully, fails loud on anything unmapped, never lets a
// Northwood-labelled entity through, and — when PF_RAW_RECORDS points at the real raw export — rebuilds
// the committed monthly-long.csv row for row.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyRecord,
  normalizeRecords,
  parseAccountMapping,
  parseRawRecords,
  renderMonthlyLongCsv,
  sortMonthlyLongRows,
  UnmappedAccountsError,
  type RawRecord,
} from '@analytics/property-financials/normalize';
import { parseMonthlyLong, type MonthlyLongRow } from '@analytics/property-financials/aggregate';
import { HAVE_AUDIT_CSV, auditCsvSkipMarker, loadCsvText } from './property-financials-helpers';

const root = process.cwd();
const CONFIG_DIR = resolve(root, 'scripts', 'property-financials', 'config');
const MAPPING = parseAccountMapping(JSON.parse(readFileSync(resolve(CONFIG_DIR, 'account-mapping.v1.json'), 'utf8')));
const FIXTURE = parseRawRecords(JSON.parse(readFileSync(resolve(root, 'tests', 'fixtures', 'property-financials', 'raw-records.synthetic.json'), 'utf8')));

const KIND_BY_ENTITY = { 'Alpha Flex': 'monthly', 'Beta Court': 'monthly' } as const;

function rowKey(r: MonthlyLongRow): string {
  return [r.entity, r.period, r.line_type, r.category, r.source_account, r.amount_usd].join('\u0001');
}

describe('account mapping config', () => {
  it('is versioned, lists the contract categories, and every rule has an id and a complete `then`', () => {
    expect(MAPPING.version).toBe('v1');
    expect(MAPPING.categories.revenue).toHaveLength(6);
    expect(MAPPING.categories.opex).toHaveLength(8);
    expect(Object.keys(MAPPING.categories.below_line).sort()).toEqual(['capex', 'debt', 'dist', 'inctax', 'noncash', 'nonop']);
    const ids = MAPPING.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(80);
    expect(MAPPING.excludedEntities.map((e) => e.pattern)).toEqual(['2203', 'northwood']);
  });

  it('rejects a rule whose category is not one of the declared categories, and a rule without an id', () => {
    const bad = JSON.parse(JSON.stringify(MAPPING)) as Record<string, unknown>;
    (bad.rules as Array<Record<string, unknown>>).push({ id: 'X', when: {}, then: { line_type: 'opex', category: 'Nope' } });
    expect(() => parseAccountMapping(bad)).toThrow(/category/i);
    const bad2 = JSON.parse(JSON.stringify(MAPPING)) as Record<string, unknown>;
    (bad2.rules as Array<Record<string, unknown>>).push({ when: {}, then: { exclude: 'x' } });
    expect(() => parseAccountMapping(bad2)).toThrow(/id/i);
  });
});

describe('classifyRecord', () => {
  const rec = (section: string | null, group: string | null, account: string, layout = 'AF'): RawRecord => ({
    entity: 'Alpha Flex', period: '2024-01', layout, section, group, account, amount: 1, isTotal: false,
  });

  it('applies the first matching rule and reports its id', () => {
    expect(classifyRecord(rec('INCOME', '5002 RENTAL INCOME', 'Rent'), MAPPING)).toEqual({ kind: 'mapped', line_type: 'rev', category: 'Base rent', ruleId: 'AF-INC-RENT', sign: 1 });
    expect(classifyRecord(rec('INCOME', '5002 RENTAL INCOME', 'Last Month Rent'), MAPPING)).toMatchObject({ line_type: 'rev', category: 'Other income', ruleId: 'AF-INC-RENTAL-OTHER' });
    expect(classifyRecord(rec('EXPENSE', '6999 REPLACEMENT', 'Electrical Update'), MAPPING)).toMatchObject({ line_type: 'opex', ruleId: 'AF-EXP-REPLACEMENT-ELECTRICAL-UPDATE' });
    expect(classifyRecord(rec('EXPENSE', '6999 REPLACEMENT', 'New HVAC'), MAPPING)).toMatchObject({ line_type: 'capex', category: 'Capex / leasing / non-recurring' });
    expect(classifyRecord(rec(null, 'ADJUSTMENTS', 'Owner Distributions', 'CF'), MAPPING)).toMatchObject({ line_type: 'dist', sign: -1, ruleId: 'CF-ADJ-OWNER-DIST' });
  });

  it('returns an exclusion (with the rule id and reason) for deposit activity, prepays and balance-sheet adjustments', () => {
    expect(classifyRecord(rec('INCOME', '5019 SECURITY DEPOSIT ACTIVITY', 'Security Deposit'), MAPPING)).toMatchObject({ kind: 'excluded', ruleId: 'AF-INC-SECDEP-ACTIVITY' });
    expect(classifyRecord(rec('INCOME', '5019 SECURITY DEPOSIT ACTIVITY', 'Sec. Dep. Forfeit Damages'), MAPPING)).toMatchObject({ kind: 'mapped', category: 'Other income' });
    expect(classifyRecord(rec('INCOME', null, 'Unallocated Prepays'), MAPPING)).toMatchObject({ kind: 'excluded' });
    expect(classifyRecord(rec(null, 'ADJUSTMENTS', 'Prepaid Rent', 'CF'), MAPPING)).toMatchObject({ kind: 'excluded', ruleId: 'CF-ADJ-BALANCE-SHEET' });
  });

  it('matches a null section only with an explicit null clause (A12 no-section recap) and returns unmapped otherwise', () => {
    expect(classifyRecord(rec(null, '5500 CAM EXPENSES', 'CAM - Trash', 'A12'), MAPPING)).toMatchObject({ kind: 'mapped', ruleId: 'A12-NOSECTION-CAM' });
    expect(classifyRecord(rec('EXPENSE', '5500 CAM EXPENSES', 'CAM - Trash', 'A12'), MAPPING)).toMatchObject({ kind: 'mapped', ruleId: 'A12-EXP-CAM-UTILITIES', category: 'Utilities' });
    expect(classifyRecord(rec('INCOME', '5002 RENTAL INCOME', 'Rent', 'ZZ'), MAPPING)).toEqual({ kind: 'unmapped' });
    expect(classifyRecord(rec('INCOME', '9999 UNKNOWN GROUP', 'Mystery', 'AF'), MAPPING)).toEqual({ kind: 'unmapped' });
  });
});

describe('normalizeRecords (synthetic fixture — always runs)', () => {
  const result = normalizeRecords(FIXTURE, MAPPING, KIND_BY_ENTITY);

  it('skips total/subtotal rows and excluded accounts, keeps zero-amount rows, flips signed rules, and never emits -0', () => {
    const alphaJan = result.rows.filter((r) => r.entity === 'Alpha Flex' && r.period === '2024-01');
    expect(alphaJan.map((r) => r.source_account)).not.toContain('INCOME');
    expect(alphaJan.map((r) => r.source_account)).not.toContain('NET INCOME');
    expect(alphaJan.map((r) => r.source_account)).not.toContain('Security Deposit');
    expect(alphaJan.map((r) => r.source_account)).not.toContain('Unallocated Prepays');
    expect(alphaJan).toHaveLength(11);
    const beta = result.rows.filter((r) => r.entity === 'Beta Court');
    expect(beta.find((r) => r.source_account === 'Owner Distributions')).toMatchObject({ line_type: 'dist', amount_usd: 15000 });
    expect(beta.find((r) => r.source_account === 'Prepaid Rental Income')).toMatchObject({ line_type: 'rev', category: 'Vacancy / waivers / bad debt', amount_usd: 0 });
    const draw = beta.find((r) => r.source_account === 'Owners Draw');
    expect(draw?.amount_usd).toBe(0);
    expect(Object.is(draw?.amount_usd, -0)).toBe(false);
    expect(beta.some((r) => r.source_account === 'Bad Debt-Prior Year')).toBe(false);
    expect(beta.some((r) => r.source_account === 'Security Deposits Payable')).toBe(false);
    expect(beta.find((r) => r.source_account === 'Interest Income')).toMatchObject({ line_type: 'nonop', category: 'Interest income' });
    expect(result.skippedTotals).toBe(4);
  });

  it('sums rows that share (entity, period, line_type, category, source_account) into one row — the same label under two statement groups', () => {
    const misc = result.rows.filter((r) => r.entity === 'Beta Court' && r.source_account === 'Miscellaneous Admin Expense');
    expect(misc).toHaveLength(1);
    expect(misc[0]).toMatchObject({ line_type: 'opex', category: 'Professional / admin', amount_usd: 80.78 });
    expect(result.mergedDuplicates).toBe(1);
    expect(result.ruleCounts['CF-OWNERS-EXPENSES-NONREC']).toBe(1);
  });

  it('reports every row by rule id for audit', () => {
    expect(result.ruleCounts['AF-INC-RENT']).toBe(2); // Alpha Jan + Feb; the Northwood Rent row is dropped before classification
    expect(result.ruleCounts['CF-ADJ-OWNER-DIST']).toBe(1);
    expect(result.excludedByRule['AF-INC-SECDEP-ACTIVITY']).toBe(1);
    expect(result.excludedByRule['CF-ADJ-BALANCE-SHEET']).toBe(2);
    expect(result.excludedByRule['CF-OWNER-BAD-DEBT-PY']).toBe(1);
  });

  it('Northwood-labelled raw rows never reach the rows and are reported as EXCLUDED ENTITY rows, not unmapped', () => {
    expect(result.rows.some((r) => /northwood|2203/i.test(r.entity))).toBe(false);
    expect(result.excludedEntities).toEqual([
      { entity: '2203 Northwood', pattern: '2203', reason: expect.stringMatching(/Northwood/), rows: 3 },
    ]);
    // The unmapped-looking account on the Northwood row was never classified: exclusion runs first.
    expect(Object.keys(result.unmapped)).toHaveLength(0);
  });

  it('sorts rows by kind block (monthly, then annual), then entity, period, line_type, category, source_account (code-point order)', () => {
    const rows: MonthlyLongRow[] = [
      { entity: 'Zed Annual', period: '2024-FY', line_type: 'rev', category: 'Base rent', source_account: 'Rents', amount_usd: 1 },
      { entity: 'B', period: '2024-02', line_type: 'rev', category: 'Base rent', source_account: 'Rent', amount_usd: 1 },
      { entity: 'B', period: '2024-01', line_type: 'rev', category: 'Other income', source_account: 'b', amount_usd: 1 },
      { entity: 'B', period: '2024-01', line_type: 'rev', category: 'Other income', source_account: 'B', amount_usd: 1 },
      { entity: 'B', period: '2024-01', line_type: 'opex', category: 'Utilities', source_account: 'Gas', amount_usd: 1 },
      { entity: 'B', period: '2024-01', line_type: 'capex', category: 'Capex / leasing / non-recurring', source_account: 'x', amount_usd: 1 },
      { entity: 'A', period: '2024-01', line_type: 'rev', category: 'Base rent', source_account: 'Rent', amount_usd: 1 },
      { entity: 'A annual', period: '2024-FY', line_type: 'rev', category: 'Base rent', source_account: 'Rents', amount_usd: 1 },
    ];
    const sorted = sortMonthlyLongRows(rows, { A: 'monthly', B: 'monthly', 'Zed Annual': 'annual', 'A annual': 'annual' });
    expect(sorted.map((r) => `${r.entity}|${r.period}|${r.line_type}|${r.category}|${r.source_account}`)).toEqual([
      'A|2024-01|rev|Base rent|Rent',
      'B|2024-01|capex|Capex / leasing / non-recurring|x',
      'B|2024-01|opex|Utilities|Gas',
      'B|2024-01|rev|Other income|B',
      'B|2024-01|rev|Other income|b',
      'B|2024-02|rev|Base rent|Rent',
      'A annual|2024-FY|rev|Base rent|Rents',
      'Zed Annual|2024-FY|rev|Base rent|Rents',
    ]);
  });

  it('renders the documented header, CRLF line endings, Python float repr amounts, and round-trips through parseMonthlyLong', () => {
    const csv = renderMonthlyLongCsv(result.rows);
    expect(csv.startsWith('entity,period,line_type,category,source_account,amount_usd\r\n')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv).toContain('Alpha Flex,2024-01,opex,Repairs & maintenance,Door Repair,141.0\r\n');
    expect(csv).toContain('Alpha Flex,2024-01,rev,Utility reimbursements,Water,120.5\r\n');
    expect(csv).toContain('Beta Court,2024-01,dist,Owner distributions (net),Owner Distributions,15000.0\r\n');
    const back = parseMonthlyLong(csv);
    expect(back).toEqual(result.rows);
  });

  it('quotes a field holding a comma or quote (RFC 4180) so it still round-trips', () => {
    const rows: MonthlyLongRow[] = [{ entity: 'A', period: '2024-01', line_type: 'rev', category: 'Base rent', source_account: 'Rent, "net"', amount_usd: 1 }];
    const csv = renderMonthlyLongCsv(rows);
    expect(csv).toContain('"Rent, ""net"""');
    expect(parseMonthlyLong(csv)).toEqual(rows);
  });
});

describe('normalizeRecords fails the run on an unmapped account', () => {
  it('throws UnmappedAccountsError carrying entity, period, section, account, amount and count — never defaults', () => {
    const records: RawRecord[] = [
      { entity: 'Alpha Flex', period: '2024-01', layout: 'AF', section: 'INCOME', group: '5002 RENTAL INCOME', account: 'Rent', amount: 10, isTotal: false },
      { entity: 'Alpha Flex', period: '2024-01', layout: 'AF', section: 'EXPENSE', group: '9999 NEW GROUP', account: 'Drone Survey', amount: 250, isTotal: false },
      { entity: 'Alpha Flex', period: '2024-02', layout: 'AF', section: 'EXPENSE', group: '9999 NEW GROUP', account: 'Drone Survey', amount: 300, isTotal: false },
    ];
    let caught: unknown;
    try {
      normalizeRecords(records, MAPPING, KIND_BY_ENTITY);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnmappedAccountsError);
    const err = caught as UnmappedAccountsError;
    expect(err.report).toEqual([
      { entity: 'Alpha Flex', layout: 'AF', section: 'EXPENSE', group: '9999 NEW GROUP', account: 'Drone Survey', count: 2, amount: 550, periods: ['2024-01', '2024-02'] },
    ]);
    expect(err.message).toMatch(/1 unmapped account/);
    expect(err.message).toMatch(/Drone Survey/);
  });

  it('fails when a raw entity is missing from the kind registry (an entity must be declared before its rows can be placed)', () => {
    expect(() => normalizeRecords(FIXTURE, MAPPING, { 'Alpha Flex': 'monthly' })).toThrow(/Beta Court.*registry/);
  });
});

describe('parseRawRecords', () => {
  it('accepts the OneDrive shape { records: [[entity, period, layout, section, group, account, amount, isTotal]] } and rejects anything else', () => {
    expect(FIXTURE[0]).toEqual({ entity: 'Alpha Flex', period: '2024-01', layout: 'AF', section: 'INCOME', group: '5002 RENTAL INCOME', account: 'Rent', amount: 10000, isTotal: false });
    expect(() => parseRawRecords({ rows: [] })).toThrow(/records/);
    expect(() => parseRawRecords({ records: [['e', '2024-01', 'AF', null, null, 'a', 'x', 0]] })).toThrow(/amount/);
    expect(() => parseRawRecords({ records: [['e', '2024-01', 'AF', null, null, 'a', 1, 2]] })).toThrow(/isTotal/);
    expect(() => parseRawRecords({ records: [['e', '2024-01', 'AF', null, null, 'a', 1]] })).toThrow(/8 fields/);
  });
});

// -------------------------------------------------------------------------------------------------
// Real raw export (gated): PF_RAW_RECORDS=<path to _raw_monthly_records.json>
// -------------------------------------------------------------------------------------------------

const RAW_PATH = process.env.PF_RAW_RECORDS;
const rawAvailable = typeof RAW_PATH === 'string' && RAW_PATH.length > 0 && existsSync(RAW_PATH);

// Also needs the local-only monthly-long.csv (Gabriel ruling 2026-10-06) to compare against.
describe.skipIf(!rawAvailable || !HAVE_AUDIT_CSV)('real raw records -> local monthly-long.csv (PF_RAW_RECORDS)', () => {
  // v03.1 (Gabriel ruling 2026-10-05): the committed 9620 State 350 2025-09 rows were re-parsed from the
  // statement (README "Known difference", now promoted). The reference raw export carries that recap with
  // no sections, so it reproduces every OTHER row; for 2025-09 the same lines are only reclassified.
  const CORRECTED_PERIOD = (r: MonthlyLongRow) => r.entity === '9620 State 350' && r.period === '2025-09';
  // v03.2 (Gabriel ruling 2026-10-06): the committed CSV is normalised with mapping v3, which excludes the Yardi
  // "Prepaid Rental Income" rows that v1/v2 counted as contra-revenue. The reproduction therefore uses v3 (v3 =
  // v2 + that one exclusion; v2 = v1 for every AF / CF / A12 rule), not the v1 file pinned above.
  const MAPPING_V3 = parseAccountMapping(JSON.parse(readFileSync(resolve(CONFIG_DIR, 'account-mapping.v3.json'), 'utf8')));
  it('reproduces every monthly-entity row of data/property-financials/monthly-long.csv exactly, in file order, except the corrected 9620 2025-09 period', () => {
    const raw = parseRawRecords(JSON.parse(readFileSync(RAW_PATH as string, 'utf8')));
    const registry = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'entities.json'), 'utf8')) as { entities: Array<{ id: string; kind: 'monthly' | 'annual' }> };
    const kinds = Object.fromEntries(registry.entities.map((e) => [e.id, e.kind]));
    const result = normalizeRecords(raw, MAPPING_V3, kinds);
    const builtAll = sortMonthlyLongRows(result.rows, kinds);

    const committed = parseMonthlyLong(loadCsvText());
    const monthlyIds = new Set(registry.entities.filter((e) => e.kind === 'monthly').map((e) => e.id));
    const expectedAll = committed.filter((r) => monthlyIds.has(r.entity));

    // The corrected period holds the same statement lines and amounts, only reclassified (11 rows each side;
    // 9 of the committed ones are opex now, all of the reference's were revenue).
    const lines = (rows: readonly MonthlyLongRow[]) => rows.filter(CORRECTED_PERIOD).map((r) => `${r.source_account}|${r.amount_usd}`).sort();
    expect(lines(builtAll)).toHaveLength(11);
    expect(lines(expectedAll)).toEqual(lines(builtAll));
    expect(builtAll.filter((r) => CORRECTED_PERIOD(r) && r.line_type !== 'rev')).toHaveLength(0);
    expect(expectedAll.filter((r) => CORRECTED_PERIOD(r) && r.line_type === 'opex')).toHaveLength(9);

    const built = builtAll.filter((r) => !CORRECTED_PERIOD(r));
    const expected = expectedAll.filter((r) => !CORRECTED_PERIOD(r));

    // Diff classes first, so a miss is diagnosable without reading 15k rows.
    const missing = new Map<string, number>();
    const extra = new Map<string, number>();
    const expKeys = new Map<string, number>();
    for (const r of expected) expKeys.set(rowKey(r), (expKeys.get(rowKey(r)) ?? 0) + 1);
    for (const r of built) {
      const k = rowKey(r);
      const n = expKeys.get(k) ?? 0;
      if (n > 0) expKeys.set(k, n - 1);
      else extra.set(`${r.entity}|${r.line_type}|${r.category}|${r.source_account}`, (extra.get(`${r.entity}|${r.line_type}|${r.category}|${r.source_account}`) ?? 0) + 1);
    }
    for (const [k, n] of expKeys) if (n > 0) { const [e, , lt, c, a] = k.split('\u0001'); missing.set(`${e}|${lt}|${c}|${a}`, (missing.get(`${e}|${lt}|${c}|${a}`) ?? 0) + n); }
    expect({ missingClasses: Object.fromEntries(missing), extraClasses: Object.fromEntries(extra) }).toEqual({ missingClasses: {}, extraClasses: {} });

    expect(built.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      if (rowKey(built[i]!) !== rowKey(expected[i]!)) {
        throw new Error(`row ${i + 2}: built ${JSON.stringify(built[i])} vs committed ${JSON.stringify(expected[i])}`);
      }
    }
    expect(renderMonthlyLongCsv(built).split('\r\n').slice(1, -1)).toEqual(
      loadCsvText().split('\r\n').slice(1, 1 + expectedAll.length).filter((l) => !l.startsWith('9620 State 350,2025-09,')),
    );
  });
});

// Only when the raw export is opted in: otherwise the placeholder below already explains the skip.
if (rawAvailable) auditCsvSkipMarker();

if (!rawAvailable) {
  it('real raw export test SKIPPED: set PF_RAW_RECORDS to the path of _raw_monthly_records.json (OneDrive Business/Property Financials/outputs) to run it', () => {
    expect(rawAvailable).toBe(false);
  });
}
