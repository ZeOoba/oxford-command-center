// @vitest-environment node
//
// scripts/import-market-series.ts: parser (one test per reject reason), importer (idempotency,
// unknown cluster, per-row isolation), the cutover proof (buildMarketIntel scores an imported
// census row), the Census ACS fetch against an injected fetch, the xlsx reader, and parseArgs.
// Fresh tmpdir warehouses only; clusters and figures are synthetic.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';

vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn() }));
import { buildMarketIntel } from '../../server/warehouse/market-intel';
import {
  DEFAULT_GEOGRAPHIES,
  fetchCensusVacancy,
  importMarketSeries,
  importMarketSeriesRows,
  loadGeographies,
  parseArgs,
  parseMarketSeriesPayload,
  readMarketSeriesXlsx,
} from '../../scripts/import-market-series';
import type { FetchFn, MarketSeriesRow } from '../../scripts/import-market-series';

const TODAY = '2026-11-23';
const opened: WarehouseDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function freshDb(markets: string[] = ['Alpha Metro']): WarehouseDb {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'import-market-series-')), 'w.sqlite'));
  opened.push(db);
  markets.forEach((m, i) => {
    db.prepare(`INSERT INTO property_master (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
      VALUES (?, ?, ?, 'pnl', 10000, '2020-01-01', 1, 'active')`).run(`prop-${i}`, `Prop ${i}`, m);
  });
  return db;
}

const census = (over: Record<string, unknown> = {}) => ({
  cluster: 'Alpha Metro', as_of: '2026-06-30', source: 'census-acs', metric: 'vacancy_rate', value: 6.5, confidence: 1, ...over,
});
const comps = (over: Record<string, unknown> = {}) => ({
  cluster: 'Alpha Metro', as_of: '2026-10-01', source: 'comps-ai', metric: 'cap_rate', value: 7.25, confidence: 0.6, source_detail: 'n=4 sales', ...over,
});

describe('parseMarketSeriesPayload', () => {
  it('accepts a valid census row and a valid comps row; blank detail becomes null', () => {
    const { rows, rejected } = parseMarketSeriesPayload([census({ source_detail: '  ' }), comps()], TODAY);
    expect(rejected).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ cluster: 'Alpha Metro', source: 'census-acs', metric: 'vacancy_rate', value: 6.5, sourceDetail: null });
    expect(rows[1]).toMatchObject({ source: 'comps-ai', metric: 'cap_rate', value: 7.25, sourceDetail: 'n=4 sales' });
  });

  it('collapses an identical duplicate tuple; rejects every copy of a conflicting one', () => {
    const same = parseMarketSeriesPayload([census(), census()], TODAY);
    expect(same.rows).toHaveLength(1);
    expect(same.rejected[0]!.reason).toMatch(/same value; kept once/);
    const clash = parseMarketSeriesPayload([census(), census({ value: 8 }), comps()], TODAY);
    expect(clash.rows.map((r) => r.source)).toEqual(['comps-ai']);
    expect(clash.rejected).toHaveLength(2);
    expect(clash.rejected[0]!.reason).toMatch(/conflicting duplicate/);
  });

  it('--file mode (allowCensus false) refuses census-acs rows but keeps comps-ai rows', () => {
    const { rows, rejected } = parseMarketSeriesPayload([census(), comps()], TODAY, { allowCensus: false });
    expect(rows.map((r) => r.source)).toEqual(['comps-ai']);
    expect(rejected[0]!.reason).toMatch(/census-acs rows come only from --census/);
  });

  it('accepts the { rows: [...] } wrapper and rejects a non-array payload', () => {
    expect(parseMarketSeriesPayload({ rows: [census()] }, TODAY).rows).toHaveLength(1);
    expect(parseMarketSeriesPayload({ nope: 1 }, TODAY).rejected[0]!.reason).toMatch(/not an array/);
  });

  it.each([
    ['non-object row', 7, /not an object/],
    ['missing cluster', census({ cluster: '  ' }), /cluster is missing/],
    ['US date', census({ as_of: '06/30/2026' }), /not an ISO/],
    ['impossible day', census({ as_of: '2026-02-30' }), /not an ISO/],
    ['future as_of', census({ as_of: '2026-12-01' }), /in the future/],
    ['unknown source', census({ source: 'fred' }), /not one of/],
    ['metric not scored for the source', census({ metric: 'population' }), /would shadow/],
    ['census source with the comps metric', census({ metric: 'cap_rate' }), /expected vacancy_rate/],
    ['non-numeric value', census({ value: '6.5' }), /not a finite number/],
    ['NaN value', census({ value: Number.NaN }), /not a finite number/],
    ['decimal-fraction vacancy', census({ value: 0.065 }), /decimal fraction/],
    ['vacancy above ceiling', census({ value: 75 }), /outside \[1, 50\]/],
    ['decimal-fraction cap rate', comps({ value: 0.07 }), /decimal fraction/],
    ['cap rate above ceiling', comps({ value: 25 }), /outside \[2, 20\]/],
    ['confidence above 1', census({ confidence: 1.5 }), /confidence/],
    ['missing confidence', census({ confidence: undefined }), /confidence/],
    ['non-text detail', census({ source_detail: 5 }), /source_detail/],
  ])('rejects %s', (_label, row, reason) => {
    const { rows, rejected } = parseMarketSeriesPayload([row], TODAY);
    expect(rows).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatch(reason);
  });
});

describe('importMarketSeriesRows', () => {
  it('inserts once; a re-run reports every row ignored and leaves the first value in place', () => {
    const db = freshDb();
    expect(importMarketSeries(db, [census(), comps()], TODAY)).toEqual({ inserted: 2, ignored: 0, rejected: 0 });
    expect(importMarketSeries(db, [census({ value: 9.9 }), comps()], TODAY)).toEqual({ inserted: 0, ignored: 2, rejected: 0 });
    const v = db.prepare("SELECT value FROM market_series WHERE source = 'census-acs'").get() as { value: number };
    expect(v.value).toBe(6.5);
    const dq = db.prepare("SELECT detail FROM data_quality_issues WHERE kind = 'market-series-conflict'").all() as { detail: string }[];
    expect(dq).toHaveLength(1); // the comps re-run matched exactly: no conflict row
    expect(dq[0]!.detail).toMatch(/stored 6.5, incoming 9.9/);
  });

  it('skips a cluster that is not a property_master.market and logs a DQ row', () => {
    const db = freshDb();
    importMarketSeries(db, [census({ cluster: 'Beta Metro' })], TODAY); // a re-run does not re-file the issue
    const res = importMarketSeries(db, [census({ cluster: 'Beta Metro' }), census()], TODAY);
    expect(res).toEqual({ inserted: 1, ignored: 0, rejected: 1 });
    const dq = db.prepare("SELECT detail FROM data_quality_issues WHERE kind = 'market-series-unknown-cluster'").all() as { detail: string }[];
    expect(dq).toHaveLength(1);
    expect(dq[0]!.detail).toContain('Beta Metro');
  });

  it('isolates a DB constraint failure to its own row', () => {
    const db = freshDb();
    const good = parseMarketSeriesPayload([census()], TODAY).rows[0]!;
    const bad: MarketSeriesRow = { ...good, asOf: '2026-05-31', confidence: 2 }; // CHECK (confidence BETWEEN 0 AND 1)
    expect(importMarketSeriesRows(db, [bad, good])).toEqual({ inserted: 1, ignored: 0, rejected: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind = 'market-series-check-violation'").get()).toEqual({ n: 1 });
  });
});

describe('cutover: buildMarketIntel reads the imported rows', () => {
  const macro = {
    asOf: TODAY, source: 'live' as const, tenYearHistory: [],
    indicators: [
      { id: 'DGS5', label: '5Y', value: 4.0, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI', value: 3.0, unit: '%', change: null },
    ],
  };

  it('a fresh imported census row joins the composite; FRED alone before it', async () => {
    const db = freshDb();
    const before = await buildMarketIntel(db, 'Alpha Metro', TODAY, macro as never);
    expect(before.confidence01).toBe(0.5); // FRED only
    importMarketSeries(db, [census({ value: 5 }), comps({ value: 6 })], TODAY);
    const after = await buildMarketIntel(db, 'Alpha Metro', TODAY, macro as never);
    const src = Object.fromEntries(after.sources.map((s) => [s.source, s]));
    expect(src['census-acs']!.stale).toBe(false);
    expect(src['census-acs']!.value).toBe(5);
    expect(src['comps-ai']!.stale).toBe(false);
    expect(after.confidence01).toBe(1);
    expect(after.marketScore).not.toBe(before.marketScore);
  });

  it('a census row older than the 400-day budget is shown but not scored', async () => {
    const db = freshDb();
    importMarketSeries(db, [census({ as_of: '2024-12-31' })], TODAY);
    const s = await buildMarketIntel(db, 'Alpha Metro', TODAY, macro as never);
    const c = s.sources.find((x) => x.source === 'census-acs')!;
    expect(c.stale).toBe(true);
    expect(c.value).toBe(6.5);
    expect(s.confidence01).toBe(0.5);
    expect(s.reasons.join(' ')).toMatch(/Census ACS data stale/);
  });
});

describe('fetchCensusVacancy', () => {
  const geos = {
    clusters: { 'Alpha Metro': ['11111'], 'Pooled Metro': ['22222', '33333'], 'Gap Metro': ['44444'] },
    acs5Releases: { '2024': { released: '2026-01-29', source: 'test release note' } },
  };
  const body = JSON.stringify([
    ['NAME', 'B25002_001E', 'B25002_003E', 'B25004_006E', 'metropolitan statistical area/micropolitan statistical area'],
    ['Alpha, ZZ Metro Area', '1000', '70', '0', '11111'],
    ['Beta, ZZ Metro Area', '3000', '150', '0', '22222'],
    ['Gamma, ZZ Micro Area', '1100', '250', '100', '33333'], // 100 seasonal: 150 of 1000 once removed
  ]);
  const ok = (text: string) => ({ ok: true, status: 200, text: async () => text });
  const redirect = { ok: false, status: 302, text: async () => '' };

  it('pools vacant/total across a cluster\'s CBSAs, stamps the public release date, skips a partial cluster', async () => {
    const urls: string[] = [];
    const fetchFn: FetchFn = async (u) => { urls.push(u); return ok(body); };
    const res = await fetchCensusVacancy(geos, 'k', fetchFn, 2024);
    expect(res.vintage).toBe(2024);
    expect(urls[0]).toContain('/data/2024/acs/acs5?get=NAME,B25002_001E,B25002_003E,B25004_006E');
    const byCluster = Object.fromEntries(res.payload.map((p) => [p.cluster, p]));
    expect(byCluster['Alpha Metro']).toMatchObject({ as_of: '2026-01-29', source: 'census-acs', metric: 'vacancy_rate', value: 7 });
    expect(byCluster['Alpha Metro']!.source_detail).toMatch(/period end 2024-12-31; as_of = public release 2026-01-29: test release note/);
    // (150 + (250-100)) / (3000 + (1100-100)): seasonal off both sides, pooled, not the mean of 5% and 15%
    expect(byCluster['Pooled Metro']!.value).toBe(7.5);
    expect(byCluster['Gap Metro']).toBeUndefined();
    expect(res.problems.join(' ')).toMatch(/Gap Metro: CBSA 44444/);
    expect(parseMarketSeriesPayload(res.payload, TODAY).rejected).toEqual([]);
  });

  it('falls back to an older vintage when the newest is not served', async () => {
    const fetchFn: FetchFn = async (u) => (u.includes('/data/2025/') ? redirect : ok(body));
    const res = await fetchCensusVacancy(geos, 'k', fetchFn, undefined, new Date('2026-11-23T00:00:00Z'));
    expect(res.vintage).toBe(2024);
  });

  it('refuses a vintage with no recorded release date; --released supplies one', async () => {
    const fetchFn: FetchFn = async () => ok(body);
    await expect(fetchCensusVacancy(geos, 'k', fetchFn, 2023)).rejects.toThrow(/no public release date recorded for ACS 5-year vintage 2023/);
    const res = await fetchCensusVacancy(geos, 'k', fetchFn, 2023, undefined, '2024-12-12');
    expect(res.payload[0]).toMatchObject({ as_of: '2024-12-12' });
    await expect(fetchCensusVacancy(geos, 'k', fetchFn, 2024, undefined, '2024-06-01')).rejects.toThrow(/not after the 2024 period end/);
  });

  it('the release-date row is fresh against the 400-day census budget, so census joins the composite', async () => {
    const db = freshDb(['Alpha Metro']);
    const res = await fetchCensusVacancy(geos, 'k', async () => ok(body), 2024);
    importMarketSeries(db, res.payload, TODAY);
    const macro = { asOf: TODAY, source: 'live' as const, tenYearHistory: [], indicators: [{ id: 'DGS5', label: '5Y', value: 4.0, unit: '%', change: null }] };
    const s = await buildMarketIntel(db, 'Alpha Metro', TODAY, macro as never);
    expect(s.sources.find((x) => x.source === 'census-acs')).toMatchObject({ stale: false, value: 7, asOf: '2026-01-29' });
  });

  it('throws when no vintage answers (bad key reads as a redirect)', async () => {
    await expect(fetchCensusVacancy(geos, 'k', async () => redirect, undefined, new Date('2026-11-23T00:00:00Z')))
      .rejects.toThrow(/not available.*CENSUS_API_KEY/);
  });

  it('the committed geography config is well-formed and dates the 2024 vintage at its 2026-01-29 release', () => {
    const g = loadGeographies(DEFAULT_GEOGRAPHIES);
    expect(Object.keys(g.clusters).length).toBeGreaterThan(0);
    expect(g.acs5Releases?.['2024']?.released).toBe('2026-01-29');
  });

  it('rejects a release entry without a source or dated inside its own period', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-market-series-geo-'));
    for (const rel of [{ released: '2026-01-29', source: '' }, { released: '2024-06-01', source: 'x' }, { released: '01/29/2026', source: 'x' }]) {
      const p = join(dir, 'g.json');
      writeFileSync(p, JSON.stringify({ clusters: { A: ['11111'] }, acs5Releases: { '2024': rel } }));
      expect(() => loadGeographies(p)).toThrow(/acs5Releases\['2024'\]/);
    }
  });
});

describe('readMarketSeriesXlsx', () => {
  it('maps the header row, converts Date and Excel-serial as_of cells, skips blank rows, coerces numeric text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-market-series-xlsx-'));
    const path = join(dir, 'rows.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Series');
    ws.addRow(['Cluster', 'As_Of', 'Source', 'Metric', 'Value', 'Confidence', 'Source_Detail']);
    ws.addRow(['Alpha Metro', new Date(Date.UTC(2026, 9, 1)), 'comps-ai', 'cap_rate', 7.1, 0.5, 'broker survey']);
    ws.addRow([null, null, null, null, null, null, null]);
    ws.addRow(['Alpha Metro', 46022, 'census-acs', 'vacancy_rate', '6.4', '1', null]); // 46022 = 2025-12-31
    await wb.xlsx.writeFile(path);

    const payload = await readMarketSeriesXlsx(path);
    expect(payload).toHaveLength(2);
    const { rows, rejected } = parseMarketSeriesPayload(payload, TODAY);
    expect(rejected).toEqual([]);
    expect(rows.map((r) => [r.asOf, r.value, r.confidence])).toEqual([['2026-10-01', 7.1, 0.5], ['2025-12-31', 6.4, 1]]);
  });
});

describe('parseArgs', () => {
  it('file mode, census mode, defaults', () => {
    expect(parseArgs(['--file', 'a.json', '--db', 'x.sqlite'])).toEqual({ mode: 'file', filePath: 'a.json', db: 'x.sqlite', dryRun: false });
    expect(parseArgs(['--census', '--vintage', '2024', '--dry-run'])).toEqual({
      mode: 'census', geographies: DEFAULT_GEOGRAPHIES, vintage: 2024, released: undefined, db: undefined, dryRun: true,
    });
    expect(parseArgs(['--census', '--vintage', '2024', '--released', '2026-01-29'])).toMatchObject({ released: '2026-01-29' });
  });

  it.each([
    [['--file'], /missing value for --file/],
    [['--file', 'a.json', '--census'], /mutually exclusive/],
    [[], /Usage/],
    [['--file', 'a.json', '--vintage', '2024'], /only apply with --census/],
    [['--census', '--vintage', '24'], /4-digit year/],
    [['--census', '--released', '2026-01-29'], /--released needs --vintage/],
    [['--census', '--vintage', '2024', '--released', '01/29/2026'], /not an ISO/],
    [['--census', '--vintage', '2024', '--released', '2999-01-01'], /in the future/],
    [['--file', 'a.json', '--released', '2026-01-29'], /only apply with --census/],
    [['--census', '--dry-run', '--db', 'x'], /mutually exclusive/],
    [['--bogus'], /unknown argument/],
  ])('rejects %j', (argv, msg) => {
    expect(() => parseArgs(argv)).toThrow(msg);
  });
});
