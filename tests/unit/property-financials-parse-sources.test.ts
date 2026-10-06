// @vitest-environment node
//
// tests/unit/property-financials-parse-sources.test.ts — T9b part 1: the source walk (config, Northwood
// exclusion, converted-twin lookup, duplicate handling) on a synthetic tree, then — only when the real
// OneDrive exports are present — the ground-truth run: every statement file is parsed, normalised with
// the current mapping and compared to the committed monthly-long.csv row for row (0.005 tolerance),
// with the coverage printed. Opt-in only (PF_GROUND_TRUTH=1 or PF_SOURCE_DIR): a visible SKIPPED
// placeholder names the switch otherwise, so the gate never parses the OneDrive tree by accident.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMonthlyLong, type MonthlyLongRow } from '@analytics/property-financials/aggregate';
import { normalizeRecords, parseAccountMapping, parseRawRecords, type RawRecord } from '@analytics/property-financials/normalize';
import type { CellValue, SheetSource } from '@analytics/property-financials/parse-statements';
import { parseEntityRegistry } from '@analytics/property-financials/build-dataset';
import { latestMappingVersion, loadConfig } from '../../scripts/property-financials/lib/io';
import { collectSourceRecords, convertedName, parseSourcesConfig, resolveSourceDir, type SourcesConfig } from '../../scripts/property-financials/lib/sources';
import { loadCsvText } from './property-financials-helpers';

const root = process.cwd();
const CONFIG_DIR = resolve(root, 'scripts', 'property-financials', 'config');
const SOURCES = parseSourcesConfig(JSON.parse(readFileSync(resolve(CONFIG_DIR, 'sources.json'), 'utf8')));
const REGISTRY = parseEntityRegistry(JSON.parse(readFileSync(resolve(CONFIG_DIR, 'entities.json'), 'utf8')));
const MAPPING = parseAccountMapping(JSON.parse(readFileSync(resolve(CONFIG_DIR, `account-mapping.${latestMappingVersion()}.json`), 'utf8')));
const KINDS = Object.fromEntries(REGISTRY.entities.map((e) => [e.id, e.kind]));

// -------------------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------------------

describe('sources.json', () => {
  it('names only registry entities or excluded (Northwood) ones, one layout per folder, and the patterns compile', () => {
    expect(SOURCES.version).toBe('v1');
    const ids = new Set(REGISTRY.entities.map((e) => e.id));
    const excluded = MAPPING.excludedEntities.map((e) => new RegExp(e.pattern, 'i'));
    for (const f of SOURCES.pmFolders) {
      const known = ids.has(f.entity) || excluded.some((re) => re.test(f.entity));
      expect(known, `${f.folder} -> ${f.entity}`).toBe(true);
    }
    // Every registry entity with a PM folder has the layout the registry declares.
    for (const e of REGISTRY.entities.filter((e) => e.kind === 'monthly')) {
      const f = SOURCES.pmFolders.find((x) => x.entity === e.id);
      expect(f, `no PM folder for ${e.id}`).toBeDefined();
      expect(f!.layout).toBe(e.layout);
    }
    expect(SOURCES.pmFolders.some((f) => /northwood/i.test(f.entity))).toBe(true);
    expect(new RegExp(SOURCES.entityStatements.pattern).exec('P&L 2026 YTD -- 55 New Plant (EGFLLC).xlsx')?.[SOURCES.entityStatements.entityGroup]).toBe('55 New Plant (EGFLLC)');
    expect(new RegExp(SOURCES.entityStatements.pattern).exec('P&L 2024 -- 1851 South Club Solar.xlsm')?.[SOURCES.entityStatements.entityGroup]).toBe('1851 South Club Solar');
    expect(new RegExp(SOURCES.entityStatements.pattern).test('2025 P&L -- 2203-2207 Northwood.pdf')).toBe(false);
  });

  it('rejects a malformed config', () => {
    expect(() => parseSourcesConfig({})).toThrow(/pmFolders/);
    expect(() => parseSourcesConfig({ ...JSON.parse(JSON.stringify(SOURCES)), pmFolders: [{ folder: 'x', entity: 'y', layout: 'ZZ' }] })).toThrow(/layout/);
  });

  it('convertedName is "<folder leaf>__<basename>.xlsx"', () => {
    expect(convertedName('C:/x/Property Management P&Ls/1100 Rarig/ProfitLoss_1.xls')).toBe('1100 Rarig__ProfitLoss_1.xlsx');
    expect(convertedName('/a/9620 State 350/ProfitLoss12MonthRecap_2.xls')).toBe('9620 State 350__ProfitLoss12MonthRecap_2.xlsx');
  });

  it('account-mapping.v2 keeps every v1 rule byte-identical and only adds QB rules + the cross-check cash-balance exclusion', () => {
    const v1 = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'account-mapping.v1.json'), 'utf8')) as { rules: Array<{ id: string }> };
    const v2 = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'account-mapping.v2.json'), 'utf8')) as { rules: Array<{ id: string; when: { layout?: string } }> };
    const v2ById = new Map(v2.rules.map((r) => [r.id, r]));
    for (const r of v1.rules) expect(v2ById.get(r.id), r.id).toEqual(r);
    const added = v2.rules.filter((r) => !v1.rules.some((x) => x.id === r.id));
    expect(added.length).toBeGreaterThan(0);
    for (const r of added) expect(r.when.layout === 'QB' || r.id === 'CF-OWNER-CASH-BALANCE', r.id).toBe(true);
    expect(latestMappingVersion()).toBe('v2');
    expect(loadConfig().mapping.version).toBe('v2');
  });
});

// -------------------------------------------------------------------------------------------------
// Synthetic source tree
// -------------------------------------------------------------------------------------------------

type Row = Record<string, CellValue>;
function sheetOf(file: string, rows: readonly Row[]): SheetSource {
  const col = (k: string) => k.charCodeAt(0) - 64;
  const width = Math.max(1, ...rows.flatMap((r) => Object.keys(r).map(col)));
  return { file, sheet: 'Report1', rows: rows.map((r) => Array.from({ length: width }, (_, i) => r[String.fromCharCode(65 + i)] ?? null)) };
}

const CF_SINGLE = (month: string, rent: number): Row[] => [
  { A: '1900 North Broadway (eastgate)' },
  { A: 'Statement (12 months)' },
  { A: `Period = ${month}` },
  { A: 'Book = Cash ; Tree = 8807cole' },
  {},
  {},
  { A: ' RENTAL REVENUE' },
  { A: '    Rental Revenue', B: rent, C: rent },
  { A: ' TOTAL RENTAL REVENUE', B: rent, C: rent },
];

function tree(): { sourceDir: string; convertedDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'pf-sources-'));
  const sourceDir = join(base, 'src');
  const convertedDir = join(base, 'converted');
  for (const f of SOURCES.pmFolders) mkdirSync(join(sourceDir, f.folder), { recursive: true });
  mkdirSync(convertedDir);
  // Northwood: files exist but must never be opened
  writeFileSync(join(sourceDir, 'Property Management P&Ls', '2203 Northwood', 'ProfitLoss_nw.xls'), 'OLE2');
  writeFileSync(join(sourceDir, 'P&L 2025 -- 2203 -2207 Northwood.xlsx'), 'zip');
  // Broadway: two readable single-month statements + one binary .xls with a converted twin + one without
  const bw = join(sourceDir, 'Property Management P&Ls', '1900 N Broadway');
  writeFileSync(join(bw, 'a.xlsx'), 'zip');
  writeFileSync(join(bw, 'b.xlsx'), 'zip');
  writeFileSync(join(bw, 'c.xls'), 'OLE2');
  writeFileSync(join(bw, 'd.xls'), 'OLE2');
  writeFileSync(join(convertedDir, convertedName(join(bw, 'c.xls'))), 'zip');
  // an unsupported extension
  writeFileSync(join(bw, 'notes.html'), '<html>');
  return { sourceDir, convertedDir };
}

const FAKE_SHEETS: Record<string, Row[]> = {
  'a.xlsx': CF_SINGLE('Sep 2025', 100),
  'b.xlsx': CF_SINGLE('Oct 2025', 110),
  '1900 N Broadway__c.xlsx': CF_SINGLE('Nov 2025', 120),
};

function fakeReader(opened: string[]) {
  return async (path: string): Promise<SheetSource> => {
    opened.push(path);
    if (/northwood/i.test(path)) throw new Error(`Northwood file was opened: ${path}`);
    const name = path.split(/[\\/]/).pop()!;
    const rows = FAKE_SHEETS[name];
    if (!rows) throw new Error(`no fake sheet for ${name}`);
    return sheetOf(path, rows);
  };
}

function minimalConfig(): SourcesConfig {
  // Same folders/pattern as the real config so the Northwood entry is exercised; nothing else differs.
  return SOURCES;
}

describe('collectSourceRecords on a synthetic tree', () => {
  it('skips Northwood before opening it (excludedEntities), reads converted twins, reports unreadable / unsupported files', async () => {
    const { sourceDir, convertedDir } = tree();
    const opened: string[] = [];
    const got = await collectSourceRecords(minimalConfig(), { sourceDir, convertedDir, mapping: MAPPING, registry: REGISTRY, readSheets: fakeReader(opened) });
    expect(opened.some((p) => /northwood/i.test(p))).toBe(false);
    expect(got.report.excluded.map((x) => x.file).sort()).toEqual(['P&L 2025 -- 2203 -2207 Northwood.xlsx', 'Property Management P&Ls/2203 Northwood/ProfitLoss_nw.xls']);
    expect(got.report.excluded.every((x) => x.pattern === '2203' && /Northwood/.test(x.reason))).toBe(true);
    expect(got.report.unreadable).toEqual([expect.objectContaining({ file: 'Property Management P&Ls/1900 N Broadway/d.xls' })]);
    expect(got.report.unreadable[0]!.reason).toMatch(/1900 N Broadway__d\.xlsx/);
    expect(got.report.unsupported.map((x) => x.file)).toEqual(['Property Management P&Ls/1900 N Broadway/notes.html']);
    expect(got.report.files.map((f) => [f.file.split('/').pop(), f.readFrom, f.periods[0]])).toEqual([
      ['a.xlsx', 'source', '2025-09'],
      ['b.xlsx', 'source', '2025-10'],
      ['c.xls', 'converted:1900 N Broadway__c.xlsx', '2025-11'],
    ]);
    expect(got.dataset.filter((r) => !r.isTotal).map((r) => [r.period, r.amount])).toEqual([
      ['2025-09', 100],
      ['2025-10', 110],
      ['2025-11', 120],
    ]);
    expect(got.report.coverage).toEqual([{ entity: '1900 Broadway', role: 'dataset', files: 3, periods: ['2025-09', '2025-10', '2025-11'] }]);
    expect(got.crosscheck).toEqual([]);
  });

  it('without a converted directory every binary .xls is unreadable, and nothing else changes', async () => {
    const { sourceDir } = tree();
    const got = await collectSourceRecords(minimalConfig(), { sourceDir, convertedDir: null, mapping: MAPPING, registry: REGISTRY, readSheets: fakeReader([]) });
    expect(got.report.unreadable.map((x) => x.file.split('/').pop())).toEqual(['c.xls', 'd.xls']);
    expect(got.report.coverage[0]!.periods).toEqual(['2025-09', '2025-10']);
  });

  it('two files carrying the same (entity, period) must agree: identical -> kept once and reported; different -> the run fails naming both', async () => {
    const { sourceDir, convertedDir } = tree();
    FAKE_SHEETS['b.xlsx'] = CF_SINGLE('Sep 2025', 100); // duplicate of a.xlsx, identical
    try {
      const got = await collectSourceRecords(minimalConfig(), { sourceDir, convertedDir, mapping: MAPPING, registry: REGISTRY, readSheets: fakeReader([]) });
      expect(got.report.duplicatePeriods).toEqual(['1900 Broadway 2025-09 (Property Management P&Ls/1900 N Broadway/a.xlsx = Property Management P&Ls/1900 N Broadway/b.xlsx)']);
      expect(got.dataset.filter((r) => !r.isTotal)).toHaveLength(2);
      FAKE_SHEETS['b.xlsx'] = CF_SINGLE('Sep 2025', 999); // conflicting
      await expect(collectSourceRecords(minimalConfig(), { sourceDir, convertedDir, mapping: MAPPING, registry: REGISTRY, readSheets: fakeReader([]) })).rejects.toThrow(
        /1900 Broadway 2025-09 appears in both .*a\.xlsx and .*b\.xlsx with different records/,
      );
    } finally {
      FAKE_SHEETS['b.xlsx'] = CF_SINGLE('Oct 2025', 110);
    }
  });

  it('a folder whose entity is unknown (neither registry nor excluded) fails the run', async () => {
    const { sourceDir, convertedDir } = tree();
    const cfg: SourcesConfig = { ...SOURCES, pmFolders: [{ folder: 'Property Management P&Ls/1900 N Broadway', entity: 'Nowhere Plaza', layout: 'CF' }] };
    await expect(collectSourceRecords(cfg, { sourceDir, convertedDir, mapping: MAPPING, registry: REGISTRY, readSheets: fakeReader([]) })).rejects.toThrow(/Nowhere Plaza/);
  });
});

// -------------------------------------------------------------------------------------------------
// Ground truth — real exports (EXPLICIT opt-in only)
// -------------------------------------------------------------------------------------------------
//
// Runs only when PF_GROUND_TRUTH=1 or PF_SOURCE_DIR is set explicitly. The default OneDrive folder
// existing on a laptop is NOT enough: that would make every gate / CI run parse 60+ workbooks (180 s
// budget, cold-exceljs / EPERM flake class) and turn the gate red the moment a new P&L lands in the
// folder. A visible SKIPPED placeholder below says how to run it (same pattern as the normalize test).

const GROUND_TRUTH_OPT_IN = process.env.PF_GROUND_TRUTH?.trim() === '1' || Boolean(process.env[SOURCES.sourceDirEnv]?.trim());
const SOURCE_DIR = resolveSourceDir(SOURCES);
const HAVE_SOURCES = GROUND_TRUTH_OPT_IN && existsSync(SOURCE_DIR);
const CONVERTED_DIR = process.env.PF_CONVERTED_DIR?.trim() || null;

if (!HAVE_SOURCES) {
  it(`ground-truth parse of the real exports SKIPPED: set PF_GROUND_TRUTH=1 (or ${SOURCES.sourceDirEnv}=<statement folder>) to run it${
    GROUND_TRUTH_OPT_IN ? ` — opted in, but ${SOURCE_DIR} does not exist` : ''
  }`, () => {
    expect(HAVE_SOURCES).toBe(false);
  });
}

/**
 * Entity/periods where the parsers deliberately differ from the committed CSV. The committed file
 * reproduces the reference (Python) export, which read the single-month 2025-09 recap of 9620 with no
 * section headers (it only looked in column A; that export prints everything in column C) and so
 * mapped every row as revenue (README "Findings worth a ruling" #1). The parser reads the sections
 * correctly, so CAM / R&M / management fee / legal / bank / vacant-utility lines become opex.
 */
const KNOWN_DIFFERENCES: Readonly<Record<string, string>> = {
  '9620 State 350\u00012025-09': 'reference parser mis-sectioned the single-month recap (README finding 1); parser reads INCOME / EXPENSE / N/O EXPENSE correctly',
};

const rowKey = (r: MonthlyLongRow) => [r.line_type, r.category, r.source_account].join('\u0001');

function byEntityPeriod(rows: readonly MonthlyLongRow[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const k = `${r.entity}\u0001${r.period}`;
    const m = out.get(k) ?? new Map<string, number>();
    m.set(rowKey(r), (m.get(rowKey(r)) ?? 0) + r.amount_usd);
    out.set(k, m);
  }
  return out;
}

describe.skipIf(!HAVE_SOURCES)(`ground truth against ${SOURCE_DIR}`, () => {
  it(
    'every readable statement normalises to the committed monthly-long.csv rows (0.005 tolerance), except the documented known difference; coverage is printed',
    async () => {
      const got = await collectSourceRecords(SOURCES, { sourceDir: SOURCE_DIR, convertedDir: CONVERTED_DIR, mapping: MAPPING, registry: REGISTRY });
      const rep = got.report;
      // Northwood never enters
      expect(got.dataset.some((r) => /northwood|2203/i.test(r.entity))).toBe(false);
      expect(rep.excluded.length).toBeGreaterThan(0);
      expect(rep.excluded.every((x) => /northwood/i.test(x.entity))).toBe(true);
      // the Sepich HTML and the AppFolio "Cash Flow" annual variant are named, never silently dropped
      expect(rep.unsupported.map((x) => x.file)).toEqual(
        expect.arrayContaining(['Property Management P&Ls/Sepich Portfolio/ProfitLoss_202610051056450930.html', 'P&L 2025 -- 9620 State 350.xlsx', 'P&L 2026 YTD -- 9620 State 350.xlsx']),
      );

      const mine = byEntityPeriod(normalizeRecords(got.dataset, MAPPING, KINDS).rows);
      const committed = byEntityPeriod(parseMonthlyLong(loadCsvText()));
      const verified: string[] = [];
      const mismatched: string[] = [];
      const notCovered: string[] = [];
      for (const [key, want] of committed) {
        const have = mine.get(key);
        if (!have) {
          notCovered.push(key.replace('\u0001', ' '));
          continue;
        }
        const keys = new Set([...want.keys(), ...have.keys()]);
        const bad = [...keys].filter((k) => Math.abs((want.get(k) ?? 0) - (have.get(k) ?? 0)) > 0.005);
        if (bad.length === 0) verified.push(key);
        else if (key in KNOWN_DIFFERENCES) verified.push(`${key} (known difference)`);
        else mismatched.push(`${key.replace('\u0001', ' ')}: ${bad.slice(0, 4).join(' ; ')}`);
      }
      const extra = [...mine.keys()].filter((k) => !committed.has(k)).map((k) => k.replace('\u0001', ' '));

      const perEntity = new Map<string, { verified: number; total: number }>();
      for (const [key] of committed) {
        const e = key.split('\u0001')[0]!;
        const s = perEntity.get(e) ?? { verified: 0, total: 0 };
        s.total++;
        if (verified.some((v) => v.startsWith(key))) s.verified++;
        perEntity.set(e, s);
      }
      const lines = [...perEntity].map(([e, s]) => `  ${e.padEnd(24)} ${s.verified}/${s.total} period(s) verified`);
      console.log(
        [
          `parse-sources ground truth: ${rep.files.length} file(s) parsed from ${SOURCE_DIR}${CONVERTED_DIR ? ` + converted .xls from ${CONVERTED_DIR}` : ' (no PF_CONVERTED_DIR: binary .xls not covered)'}`,
          ...lines,
          `  known differences: ${Object.keys(KNOWN_DIFFERENCES).map((k) => k.replace('\u0001', ' ')).join(', ')}`,
          `  not covered (unreadable here): ${notCovered.length} period(s)${rep.unreadable.length ? ` — ${rep.unreadable.length} binary .xls without a converted twin` : ''}`,
          `  excluded: ${rep.excluded.map((x) => x.file).join(', ')}`,
          `  unsupported: ${rep.unsupported.map((x) => x.file).join(', ')}`,
        ].join('\n'),
      );

      expect(mismatched, 'entity/periods that do not tie to the committed CSV').toEqual([]);
      expect(extra, 'entity/periods parsed that the committed CSV lacks').toEqual([]);
      // Whatever was readable must be covered: a period missing here means a readable file went unparsed.
      const coveredEntities = new Set(rep.coverage.filter((c) => c.role === 'dataset').map((c) => c.entity));
      for (const k of notCovered) expect(rep.unreadable.length > 0 || !coveredEntities.has(k.split(' ')[0]!), `${k} not covered although its files were readable`).toBe(true);
      // The QuickBooks statements reproduce the hand-normalised annual rows exactly.
      const annualCsv = byEntityPeriod(parseMonthlyLong(readFileSync(resolve(CONFIG_DIR, 'annual-statements.csv'), 'utf8')));
      for (const [key, want] of annualCsv) {
        const have = mine.get(key);
        expect(have, `QuickBooks ${key.replace('\u0001', ' ')} parsed`).toBeDefined();
        for (const [k, v] of want) expect(Math.abs((have!.get(k) ?? 0) - v), `${key.replace('\u0001', ' ')} ${k.split('\u0001')[2]}`).toBeLessThanOrEqual(0.005);
      }
    },
    180_000,
  );

  // Needs the converted .xls tree (PF_CONVERTED_DIR): without it every binary .xls is unreadable by design.
  it.skipIf(!CONVERTED_DIR || !existsSync(resolve(SOURCE_DIR, 'outputs', '_raw_monthly_records.json')))(
    'non-total raw records equal the reference Python export, except the stale-group quirk on 9620 Commissions Expense',
    async () => {
      const got = await collectSourceRecords(SOURCES, { sourceDir: SOURCE_DIR, convertedDir: CONVERTED_DIR, mapping: MAPPING, registry: REGISTRY });
      const py = parseRawRecords(JSON.parse(readFileSync(resolve(SOURCE_DIR, 'outputs', '_raw_monthly_records.json'), 'utf8')));
      const key = (r: RawRecord) => [r.entity, r.period, r.section ?? '', r.account, Math.round(r.amount * 100) / 100].join('\u0001');
      const groupKey = (r: RawRecord) => `${key(r)}\u0001${r.group ?? ''}`;
      const mineKeys = new Set(got.dataset.filter((r) => !r.isTotal && KINDS[r.entity] === 'monthly').map(key));
      const pyKeys = new Set(py.filter((r) => !r.isTotal).map(key));
      const pyPeriods = new Set(py.map((r) => `${r.entity}\u0001${r.period}`));
      // Compared where the reference has the period, except the documented known difference (its 11
      // rows carry null sections in the reference and real sections here).
      const covered = (k: string) => {
        const ep = k.split('\u0001').slice(0, 2).join('\u0001');
        return pyPeriods.has(ep) && !(ep in KNOWN_DIFFERENCES);
      };
      expect([...pyKeys].filter((k) => covered(k) && !mineKeys.has(k)), 'reference records the parser did not produce').toEqual([]);
      expect([...mineKeys].filter((k) => covered(k) && !pyKeys.has(k)), 'parser records absent from the reference').toEqual([]);
      // Group differs only where the reference carried the EXPENSE section's last group into the first
      // N/O EXPENSE account (9620 "Commissions Expense"); the parser resets the group at a section header.
      const pyGroups = new Set(py.filter((r) => !r.isTotal).map(groupKey));
      const groupDiffs = got.dataset.filter((r) => !r.isTotal && KINDS[r.entity] === 'monthly' && covered(key(r)) && !pyGroups.has(groupKey(r)));
      expect(new Set(groupDiffs.map((r) => `${r.entity} | ${r.section} | ${r.account}`))).toEqual(new Set(['9620 State 350 | NON OPERATING EXPENSE | Commissions Expense']));
    },
    180_000,
  );
});
