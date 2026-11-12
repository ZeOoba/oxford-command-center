// scripts/import-pca-register.ts
//
// Loads the PCA Extraction Register workbook (2026-10-06_PCA-Extraction_Register_v01_2.xlsx — sheets
// PCA_Register, Components, Quotes_Actuals, Asset_Facts, Flags_Open_Items) into the Property
// Condition ledger tables (migration 035). Plan: docs/capital/2026-10-07-pca-capex-ledger-integration-plan.md.
//
//   npx tsx scripts/import-pca-register.ts <register.xlsx> [--db <path>]
//   npm run warehouse:import-pca -- <register.xlsx>
//
// Header-driven (columns are found by name, not position). Est_vs_Actual, Consultant_Fees and
// File_Index are NOT imported: the first is computed downstream from components + quotes, the other
// two are reference-only.
//
// Row handling: a row failing validation is rejected and reported in the printed summary — nothing is
// written for it. The load is a wholesale refresh inside ONE transaction (the register is the only
// writer of these tables), so a re-run is idempotent and a corrected register replaces the prior load.
// property_master_id is filled ONLY when the id exists in property_master; otherwise NULL ("unmapped").
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { slug } from '../src/contracts/common';
import {
  PcaAssetFact,
  PcaCalibrationPair,
  PcaComponent,
  PcaOpenItem,
  PcaQuote,
  PcaReport,
  type PcaUsabilityClass,
} from '../src/contracts/property-condition';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { refuseIfSynthetic } from '../server/real-data-status';

// ── property resolution ───────────────────────────────────────────────────────────────────────

const SEPICH = 'sepich-portfolio-columbus-oh-8-props';

interface PropertyRule {
  test: RegExp;
  key: string;
  masterId: string | null;
}

// Order matters: the R17 Sepich narrative names Banwick/Morrison in its label, so it must match first.
const PROPERTY_RULES: readonly PropertyRule[] = [
  { test: /sepich portfolio/i, key: 'sepich-portfolio', masterId: SEPICH },
  { test: /banwick/i, key: 'banwick', masterId: SEPICH },
  { test: /morrison/i, key: 'old-morrison', masterId: SEPICH },
  { test: /fairground/i, key: 'fairground-village', masterId: SEPICH },
  { test: /fulton/i, key: 'e-fulton', masterId: null },
  { test: /livingston/i, key: 'e-livingston', masterId: '3875-3883-e-livingston-ave-columbus-oh' },
  { test: /northwood/i, key: 'northwood', masterId: '2203-2207-northwood-dr-salisbury-md' },
  { test: /raytown|route 350|\bsr 350/i, key: 'raytown', masterId: '9620-e-state-route-350-raytown-mo' },
  { test: /sunburst/i, key: 'sunburst', masterId: '401-sunburst-hwy-cambridge-md' },
  { test: /information l|info l/i, key: 'info-lane', masterId: '29000-information-lane-easton-md' },
  { test: /st\.? michaels/i, key: 'st-michaels', masterId: null },
  { test: /broadway/i, key: 'n-broadway', masterId: '1900-n-broadway-baltimore-md' },
  { test: /red branch/i, key: 'red-branch', masterId: '9050-red-branch-rd-columbia-md' },
  { test: /new plant/i, key: 'new-plant', masterId: '55-new-plant-ct-owings-mills-md' },
  { test: /muirkirk/i, key: 'muirkirk', masterId: null },
  { test: /sheriff|sherriff/i, key: 'sheriff-rd', masterId: null },
  { test: /3540 e\.? (fifth|5th)/i, key: 'e-fifth', masterId: '3540-e-5th-ave-columbus-oh' },
  { test: /secor|mcgregor|toledo/i, key: 'toledo', masterId: null },
  { test: /14th|fourteenth/i, key: 'e-14th', masterId: null },
];

export interface ResolvedProperty {
  key: string;
  masterId: string | null;
}

/** Register property text → ledger key + property_master id (only when that id is in `known`). */
export function resolveProperty(label: string, known: ReadonlySet<string>): ResolvedProperty {
  const rule = PROPERTY_RULES.find((r) => r.test.test(label));
  if (!rule) return { key: slug(label), masterId: null };
  return { key: rule.key, masterId: rule.masterId !== null && known.has(rule.masterId) ? rule.masterId : null };
}

// ── cell helpers ──────────────────────────────────────────────────────────────────────────────

function cellValue(v: ExcelJS.CellValue | undefined): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    return null;
  }
  return v as string | number | boolean | Date;
}

function str(v: ExcelJS.CellValue | undefined): string | null {
  const c = cellValue(v);
  if (c === null) return null;
  const s = c instanceof Date ? c.toISOString().slice(0, 10) : String(c).trim();
  return s === '' ? null : s;
}

/** Number cell; '', '–', '-' → null; '$1,200' → 1200; anything else non-numeric → undefined (invalid). */
function num(v: ExcelJS.CellValue | undefined): number | null | undefined {
  const c = cellValue(v);
  if (c === null) return null;
  if (typeof c === 'number') return Number.isFinite(c) ? c : undefined;
  if (typeof c !== 'string') return undefined;
  const s = c.trim().replace(/[$,]/g, '');
  if (s === '' || s === '–' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function int(v: ExcelJS.CellValue | undefined): number | null | undefined {
  const n = num(v);
  if (n === null || n === undefined) return n;
  return Number.isInteger(n) ? n : undefined;
}

function yesNo(v: ExcelJS.CellValue | undefined): boolean | null {
  const s = str(v)?.toLowerCase();
  if (s === 'yes') return true;
  if (s === 'no') return false;
  return null;
}

/** First 4-digit 19xx/20xx year in a cell, or null. */
function yearOf(v: ExcelJS.CellValue | undefined): number | null {
  const c = cellValue(v);
  if (typeof c === 'number' && Number.isInteger(c) && c >= 1900 && c <= 2100) return c;
  const m = /\b(19|20)\d{2}\b/.exec(str(v) ?? '');
  return m ? Number(m[0]) : null;
}

/** Warranty end year ONLY when stated explicitly ("... to 12-2037", "... to 2028"); never derived. */
export function warrantyEndYear(warranty: string | null): number | null {
  if (warranty === null) return null;
  const m = /\bto\b[^0-9]*(?:\d{1,2}[-/])?((?:19|20)\d{2})\b/i.exec(warranty);
  return m?.[1] ? Number(m[1]) : null;
}

/** '2020-12-24 (PDF metadata)' → date '2020-12-24' + qualifier '(PDF metadata)'. Non-matching text passes through for validation to reject. */
export function splitDateQualifier(raw: string | null): { date: string | null; qualifier: string | null } {
  if (raw === null) return { date: null, qualifier: null };
  const m = /^(\d{4}(?:-\d{2}(?:-\d{2})?)?)\s*(\S.*)?$/.exec(raw);
  return m ? { date: m[1] ?? null, qualifier: m[2] ?? null } : { date: raw, qualifier: null };
}

export function classifyUsability(raw: string | null): PcaUsabilityClass {
  if (raw === null) return 'unknown';
  if (/draft/i.test(raw)) return 'draft';
  if (/stale|expired/i.test(raw)) return 'stale';
  if (/limited|caution|narrative/i.test(raw)) return 'limited';
  if (/current/i.test(raw)) return 'current';
  return 'unknown';
}

// ── parse ─────────────────────────────────────────────────────────────────────────────────────

export interface Reject {
  sheet: string;
  row: number;
  reason: string;
}

export interface ParsedRegister {
  reports: PcaReport[];
  components: PcaComponent[];
  quotes: PcaQuote[];
  assets: PcaAssetFact[];
  pairs: PcaCalibrationPair[];
  openItems: PcaOpenItem[];
  rejects: Reject[];
}

type Row = ExcelJS.Row;

function headerIndex(ws: ExcelJS.Worksheet): Map<string, number> {
  const idx = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => {
    const h = str(cell.value);
    if (h) idx.set(h, col);
  });
  return idx;
}

function reader(row: Row, idx: Map<string, number>) {
  return (name: string): ExcelJS.CellValue | undefined => {
    const col = idx.get(name);
    return col === undefined ? undefined : row.getCell(col).value;
  };
}

function requireSheet(wb: ExcelJS.Workbook, name: string, headers: readonly string[]): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`register is missing sheet '${name}'`);
  const idx = headerIndex(ws);
  const missing = headers.filter((h) => !idx.has(h));
  if (missing.length > 0) throw new Error(`sheet '${name}' is missing column(s): ${missing.join(', ')}`);
  return ws;
}

function firstIssue(e: { issues: Array<{ message: string; path: PropertyKey[] }> }): string {
  const i = e.issues[0];
  return i ? `${i.message} (${i.path.join('.')})` : 'invalid';
}

/** Pure: workbook → validated rows + rejects. `known` = property_master ids that exist. */
export function parseRegister(wb: ExcelJS.Workbook, known: ReadonlySet<string>): ParsedRegister {
  const out: ParsedRegister = { reports: [], components: [], quotes: [], assets: [], pairs: [], openItems: [], rejects: [] };
  const reject = (sheet: string, row: number, reason: string): void => {
    out.rejects.push({ sheet, row, reason });
  };

  // PCA_Register
  const regWs = requireSheet(wb, 'PCA_Register', ['Report ID', 'Property', 'Report date', 'Usability for forecasting']);
  const regIdx = headerIndex(regWs);
  const seenReports = new Set<string>();
  regWs.eachRow((row, n) => {
    if (n === 1) return;
    const get = reader(row, regIdx);
    const reportId = str(get('Report ID'));
    const label = str(get('Property'));
    if (!reportId || !label) return reject('PCA_Register', n, 'missing Report ID or Property');
    if (seenReports.has(reportId)) return reject('PCA_Register', n, `duplicate Report ID ${reportId}`);
    const nums = {
      sf: num(get('SF')),
      buildings: int(get('Bldgs')),
      immediateUsd: num(get('Immediate $')),
      shortTermUsd: num(get('Short-term (Yr1-2) $')),
      reservesUninflUsd: num(get('Reserves uninflated $')),
      reservesInflUsd: num(get('Reserves inflated $')),
      termYears: int(get('Term (yrs)')),
      psfYrStated: num(get('$/SF/yr (as stated)')),
    };
    const bad = Object.entries(nums).find(([, v]) => v === undefined);
    if (bad) return reject('PCA_Register', n, `${reportId}: ${bad[0]} is not a valid number`);
    const usabilityRaw = str(get('Usability for forecasting'));
    const p = resolveProperty(label, known);
    const reportDate = splitDateQualifier(str(get('Report date')));
    const inspectionDate = splitDateQualifier(str(get('Inspection date')));
    const qualifiers = [reportDate.qualifier && `report date ${reportDate.qualifier}`, inspectionDate.qualifier && `inspection date ${inspectionDate.qualifier}`].filter(Boolean);
    const notes = [str(get('Notes')), ...qualifiers].filter(Boolean).join(' | ') || null;
    const parsed = PcaReport.safeParse({
      reportId,
      propertyKey: p.key,
      propertyMasterId: p.masterId,
      propertyLabel: label,
      location: str(get('Location')),
      consultant: str(get('Consultant / report no.')),
      client: str(get('Client (per report)')),
      oraCommissioned: yesNo(get('ORA-commissioned?')),
      purpose: str(get('Purpose')),
      inspectionDate: inspectionDate.date,
      reportDate: reportDate.date,
      ...nums,
      yearBuilt: str(get('Year built')),
      usabilityRaw,
      usabilityClass: classifyUsability(usabilityRaw),
      sourceFiles: str(get('Source file(s)')),
      notes,
    });
    if (!parsed.success) return reject('PCA_Register', n, `${reportId}: ${firstIssue(parsed.error)}`);
    seenReports.add(reportId);
    out.reports.push(parsed.data);
  });

  // Components
  const compWs = requireSheet(wb, 'Components', ['Report ID', 'System', 'Basis']);
  const compIdx = headerIndex(compWs);
  const seqByReport = new Map<string, number>();
  compWs.eachRow((row, n) => {
    if (n === 1) return;
    const get = reader(row, compIdx);
    const reportId = str(get('Report ID'));
    const system = str(get('System'));
    if (!reportId || !system) return reject('Components', n, 'missing Report ID or System');
    if (!seenReports.has(reportId)) return reject('Components', n, `${reportId}: no matching PCA_Register row`);
    const basis = str(get('Basis'));
    if (basis?.toLowerCase() !== 'estimate') {
      return reject('Components', n, `${reportId}/${system}: Basis must be 'Estimate', got '${basis ?? ''}'`);
    }
    const nums = {
      qty: num(get('Qty')),
      unitCost: num(get('Unit cost $/UOM')),
      eul: int(get('EUL')),
      age: int(get('Age')),
      totalUsd: num(get('Total / scheduled $')),
    };
    const bad = Object.entries(nums).find(([, v]) => v === undefined);
    if (bad) return reject('Components', n, `${reportId}/${system}: ${bad[0]} is not a valid number`);
    // RUL is sometimes a range ('1-2'): keep the printed text, and only an integer RUL is numeric.
    const rulRaw = str(get('RUL'));
    const rulNum = rulRaw === null ? null : /^-?\d+$/.test(rulRaw) ? Number(rulRaw) : null;
    const rowSeq = (seqByReport.get(reportId) ?? 0) + 1;
    seqByReport.set(reportId, rowSeq);
    const parsed = PcaComponent.safeParse({
      reportId, rowSeq, system, ...nums, rul: rulNum, rulRaw,
      uom: str(get('UOM')),
      factor: str(get('% / factor')),
      timing: str(get('Timing')),
      basis: 'estimate',
      note: str(get('Note')),
    });
    if (!parsed.success) return reject('Components', n, `${reportId}/${system}: ${firstIssue(parsed.error)}`);
    out.components.push(parsed.data);
  });

  // Quotes_Actuals
  const quoteWs = requireSheet(wb, 'Quotes_Actuals', ['Record (title)', 'Property']);
  const quoteIdx = headerIndex(quoteWs);
  const seenQuotes = new Set<string>();
  quoteWs.eachRow((row, n) => {
    if (n === 1) return;
    const get = reader(row, quoteIdx);
    const title = str(get('Record (title)'));
    const label = str(get('Property'));
    if (!title || !label) return reject('Quotes_Actuals', n, 'missing Record (title) or Property');
    const nums = { quotedUsd: num(get('Quoted Total')), actualUsd: num(get('Actual Total')), qty: num(get('Qty')) };
    const bad = Object.entries(nums).find(([, v]) => v === undefined);
    if (bad) return reject('Quotes_Actuals', n, `${title}: ${bad[0]} is not a valid number`);
    const quoteKey = createHash('sha256').update(`${slug(label)}|${title}`).digest('hex').slice(0, 16);
    if (seenQuotes.has(quoteKey)) return reject('Quotes_Actuals', n, `${title}: duplicate record for this property`);
    const p = resolveProperty(label, known);
    const parsed = PcaQuote.safeParse({
      quoteKey, title,
      propertyKey: p.key, propertyMasterId: p.masterId, propertyLabel: label,
      vendor: str(get('Vendor')), recordType: str(get('Record Type')), status: str(get('Status')),
      trade: str(get('Trade')), docDate: str(get('Doc Date')),
      ...nums,
      uom: str(get('UOM')), scopeSummary: str(get('Scope Summary')), sourceRef: str(get('Source Ref')),
      confidence: str(get('Confidence')), verified: yesNo(get('Verified')) === true,
      fundingClass: str(get('Funding Class')), leaseRecovery: str(get('Lease Recovery')), notes: str(get('Notes')),
    });
    if (!parsed.success) return reject('Quotes_Actuals', n, `${title}: ${firstIssue(parsed.error)}`);
    seenQuotes.add(quoteKey);
    out.quotes.push(parsed.data);
  });

  // Asset_Facts
  const assetWs = requireSheet(wb, 'Asset_Facts', ['Property', 'Component']);
  const assetIdx = headerIndex(assetWs);
  const seqByProperty = new Map<string, number>();
  assetWs.eachRow((row, n) => {
    if (n === 1) return;
    const get = reader(row, assetIdx);
    const label = str(get('Property'));
    const component = str(get('Component'));
    if (!label || !component) return reject('Asset_Facts', n, 'missing Property or Component');
    const p = resolveProperty(label, known);
    const rowSeq = (seqByProperty.get(p.key) ?? 0) + 1;
    seqByProperty.set(p.key, rowSeq);
    const warranty = str(get('Warranty'));
    const parsed = PcaAssetFact.safeParse({
      propertyKey: p.key, propertyMasterId: p.masterId, propertyLabel: label, component,
      installFact: str(get('Install / age fact')),
      installYear: yearOf(get('Derived install yr')),
      warranty, warrantyEndYear: warrantyEndYear(warranty),
      source: str(get('Source / as-of')), flag: str(get('Flag')), rowSeq,
    });
    if (!parsed.success) return reject('Asset_Facts', n, `${label}/${component}: ${firstIssue(parsed.error)}`);
    out.assets.push(parsed.data);
  });

  // Est_vs_Actual (curated estimate-vs-executed pairs; delta is computed at read time, not trusted from the sheet)
  const pairWs = requireSheet(wb, 'Est_vs_Actual', ['Property', 'Scope']);
  const pairIdx = headerIndex(pairWs);
  let pairSeq = 0;
  pairWs.eachRow((row, n) => {
    if (n === 1) return;
    const get = reader(row, pairIdx);
    const label = str(get('Property'));
    const scope = str(get('Scope'));
    if (!label || !scope) return reject('Est_vs_Actual', n, 'missing Property or Scope');
    const nums = {
      estimateUsd: num(get('Estimate $')),
      estimatePsf: num(get('Estimate $/SF')),
      contractorUsd: num(get('Contractor $')),
      contractorPsf: num(get('Contractor $/SF')),
    };
    const bad = Object.entries(nums).find(([, v]) => v === undefined);
    if (bad) return reject('Est_vs_Actual', n, `${label}: ${bad[0]} is not a valid number`);
    const p = resolveProperty(label, known);
    pairSeq += 1;
    const parsed = PcaCalibrationPair.safeParse({
      rowSeq: pairSeq, propertyKey: p.key, propertyMasterId: p.masterId, propertyLabel: label, scope, ...nums,
      estimateSource: str(get('PCA / budget estimate')), contractorSource: str(get('Contractor price')), comment: str(get('Comment')),
    });
    if (!parsed.success) return reject('Est_vs_Actual', n, `${label}: ${firstIssue(parsed.error)}`);
    out.pairs.push(parsed.data);
  });

  // Flags_Open_Items
  const flagWs = requireSheet(wb, 'Flags_Open_Items', ['#', 'Severity', 'Issue']);
  const flagIdx = headerIndex(flagWs);
  flagWs.eachRow((row, n) => {
    if (n === 1) return;
    const get = reader(row, flagIdx);
    const parsed = PcaOpenItem.safeParse({
      itemNo: int(get('#')),
      severity: str(get('Severity')),
      propertyText: str(get('Property')),
      issue: str(get('Issue')),
      actionNeeded: str(get('Action / decision needed')),
    });
    if (!parsed.success) return reject('Flags_Open_Items', n, firstIssue(parsed.error));
    out.openItems.push(parsed.data);
  });

  return out;
}

// ── write ─────────────────────────────────────────────────────────────────────────────────────

export interface ImportCounts {
  reports: number;
  components: number;
  quotes: number;
  assets: number;
  pairs: number;
  openItems: number;
}

/** Wholesale refresh of the five ledger tables in ONE transaction. Throws (and rolls back) on any DB error. */
export function writeRegister(db: WarehouseDb, p: ParsedRegister): ImportCounts {
  const insReport = db.prepare(`
    INSERT INTO pca_reports (report_id, property_key, property_master_id, property_label, location, consultant, client,
      ora_commissioned, purpose, inspection_date, report_date, sf, buildings, year_built, immediate_usd, short_term_usd,
      reserves_uninfl_usd, reserves_infl_usd, term_years, psf_yr_stated, usability_raw, usability_class, source_files, notes)
    VALUES (@reportId, @propertyKey, @propertyMasterId, @propertyLabel, @location, @consultant, @client,
      @oraCommissioned, @purpose, @inspectionDate, @reportDate, @sf, @buildings, @yearBuilt, @immediateUsd, @shortTermUsd,
      @reservesUninflUsd, @reservesInflUsd, @termYears, @psfYrStated, @usabilityRaw, @usabilityClass, @sourceFiles, @notes)`);
  const insComponent = db.prepare(`
    INSERT INTO pca_components (report_id, row_seq, system, qty, uom, unit_cost, factor, eul, age, rul, rul_raw, total_usd, timing, basis, note)
    VALUES (@reportId, @rowSeq, @system, @qty, @uom, @unitCost, @factor, @eul, @age, @rul, @rulRaw, @totalUsd, @timing, @basis, @note)`);
  const insQuote = db.prepare(`
    INSERT INTO capex_quotes (quote_key, title, property_key, property_master_id, property_label, vendor, record_type, status,
      trade, doc_date, quoted_usd, actual_usd, qty, uom, scope_summary, source_ref, confidence, verified, funding_class, lease_recovery, notes)
    VALUES (@quoteKey, @title, @propertyKey, @propertyMasterId, @propertyLabel, @vendor, @recordType, @status,
      @trade, @docDate, @quotedUsd, @actualUsd, @qty, @uom, @scopeSummary, @sourceRef, @confidence, @verified, @fundingClass, @leaseRecovery, @notes)`);
  const insAsset = db.prepare(`
    INSERT INTO asset_facts (property_key, property_master_id, property_label, component, install_fact, install_year, warranty,
      warranty_end_year, source, flag, row_seq)
    VALUES (@propertyKey, @propertyMasterId, @propertyLabel, @component, @installFact, @installYear, @warranty,
      @warrantyEndYear, @source, @flag, @rowSeq)`);
  const insPair = db.prepare(`
    INSERT INTO capex_calibration_pairs (row_seq, property_key, property_master_id, property_label, scope, estimate_source,
      estimate_usd, estimate_psf, contractor_source, contractor_usd, contractor_psf, comment)
    VALUES (@rowSeq, @propertyKey, @propertyMasterId, @propertyLabel, @scope, @estimateSource,
      @estimateUsd, @estimatePsf, @contractorSource, @contractorUsd, @contractorPsf, @comment)`);
  const insItem = db.prepare(`
    INSERT INTO pca_open_items (item_no, severity, property_text, issue, action_needed)
    VALUES (@itemNo, @severity, @propertyText, @issue, @actionNeeded)`);

  const bool = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0);

  db.transaction(() => {
    // Children first (pca_components FKs pca_reports).
    for (const t of ['pca_components', 'pca_reports', 'capex_quotes', 'asset_facts', 'capex_calibration_pairs', 'pca_open_items']) {
      db.exec(`DELETE FROM ${t}`);
    }
    for (const r of p.reports) insReport.run({ ...r, oraCommissioned: bool(r.oraCommissioned) });
    for (const c of p.components) insComponent.run(c);
    for (const q of p.quotes) insQuote.run({ ...q, verified: q.verified ? 1 : 0 });
    for (const a of p.assets) insAsset.run(a);
    for (const x of p.pairs) insPair.run(x);
    for (const i of p.openItems) insItem.run(i);
  })();

  return {
    reports: p.reports.length,
    components: p.components.length,
    quotes: p.quotes.length,
    assets: p.assets.length,
    pairs: p.pairs.length,
    openItems: p.openItems.length,
  };
}

export function knownMasterIds(db: WarehouseDb): Set<string> {
  return new Set((db.prepare('SELECT id FROM property_master').all() as Array<{ id: string }>).map((r) => r.id));
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { xlsxPath: string; db?: string } {
  const positional: string[] = [];
  let db: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--db') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --db');
      db = next;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  const xlsxPath = positional[0];
  if (xlsxPath === undefined) throw new Error('Usage: npx tsx scripts/import-pca-register.ts <register.xlsx> [--db <path>]');
  return { xlsxPath, db };
}

async function main(argv: string[]): Promise<number> {
  // Writes the warehouse from inputs that may be synthetic stand-ins: never on synthetic data outside
  // CI / tests (refute round 4 F8).
  refuseIfSynthetic('import-pca-register');
  let args: { xlsxPath: string; db?: string };
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(args.xlsxPath);
  } catch (e) {
    console.error(`cannot read ${args.xlsxPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const dbPath = args.db ?? process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
  let db: WarehouseDb;
  try {
    db = openWarehouse(dbPath);
  } catch (e) {
    console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    const parsed = parseRegister(wb, knownMasterIds(db));
    const counts = writeRegister(db, parsed);
    console.log(
      `import-pca-register: ${counts.reports} report(s), ${counts.components} component(s), ${counts.quotes} quote(s), `
      + `${counts.assets} asset fact(s), ${counts.pairs} calibration pair(s), ${counts.openItems} open item(s) loaded from ${args.xlsxPath}`,
    );
    const unmapped = [...new Set(parsed.reports.filter((r) => r.propertyMasterId === null).map((r) => r.propertyKey))];
    if (unmapped.length > 0) console.log(`  unmapped to property_master (kept by property_key): ${unmapped.join(', ')}`);
    for (const r of parsed.rejects) console.warn(`  rejected ${r.sheet} row ${r.row}: ${r.reason}`);
    return parsed.rejects.length > 0 ? 2 : 0;
  } catch (e) {
    console.error(`import-pca-register: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
}

// Run the CLI only when invoked directly — importing for tests must never open a db or write.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/import-pca-register.ts')) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
