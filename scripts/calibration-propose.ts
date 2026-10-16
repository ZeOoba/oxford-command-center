// scripts/calibration-propose.ts
//
// READ-ONLY candidate-pair loader for the calibration ledger. Finds PCA consultant unit costs and contractor
// quotes that cover the same property + component and writes PROPOSED rows to data/calibration/calibration_pending.json
// for human review. It never writes to the ledger (promotion is the explicit `npm run calibration:promote` step)
// and never writes to Notion — the Notion source is GET/query only.
//
// Sources: (1) the PCA extraction workbook (Components + Quotes_Actuals), (2) optionally Notion `Components` /
// `Quotes_Actuals` data sources, when NOTION_TOKEN + the data-source ids are set. With no token the Notion source
// is skipped (same graceful pattern as server/sources/notion-tenants.ts).
//
//   npm run calibration:propose -- --workbook "<path to PCA-Extraction_Register.xlsx>" [--notion]
import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { renameSyncWithRetry } from '../server/lib/rename-retry';
import { classifyUsability, parseRegister, resolveProperty, type ParsedRegister } from './import-pca-register';
import { reportStatus } from '../src/analytics/pca-intelligence';
import { bridgeCostSegQuantities, parseCostSeg } from '../src/analytics/cost-seg';
import {
  supersededMap,
  CalibrationProposal,
  classifyComponent,
  isPlaceholder,
  parseLedger,
  parsePending,
  sameQuoteDocument,
  type PropertyKeyOf,
  type CalibrationComponent,
  type CalibrationObservation,
  type CalibrationUnit,
  type ContractorStatus,
} from '../src/analytics/calibration-ledger';

const LEDGER_PATH = join(process.cwd(), 'data', 'calibration', 'observations.json');
const PENDING_PATH = join(process.cwd(), 'data', 'calibration', 'calibration_pending.json');

export interface PcaLine {
  propertyKey: string;
  component: CalibrationComponent;
  unit: CalibrationUnit;
  unitCost: number;
  qty: number | null;
  consultant: string;
  reportDate: string;
  reportId: string;
  status: 'CURRENT' | 'DRAFT' | 'STALE';
  sourceFile: string;
}

export interface QuoteLine {
  propertyKey: string;
  propertyLabel: string;
  component: CalibrationComponent;
  unit: CalibrationUnit;
  qty: number | null;
  totalUsd: number | null;
  /** true when totalUsd came from an actual (final) total rather than a quoted one. */
  isActual: boolean;
  vendor: string;
  docDate: string;
  status: ContractorStatus;
  superseded: boolean;
  title: string;
  sourceFile: string;
}

const UNITS = new Set(['SF', 'SY', 'LF']);
/** The register's titles carry cp1252-mangled dashes ("â€”"); restore them so provenance strings stay readable. */
const demojibake = (s: string): string => s.replace(/â€”/g, '—').replace(/â€“/g, '–').replace(/â€™/g, '’');
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Quote status → ledger status. Completed work → EXECUTED; awarded / contracted → SIGNED; everything else is a BID. */
export function contractorStatus(recordType: string | null, status: string | null): ContractorStatus {
  const st = (status ?? '').toLowerCase();
  const rt = (recordType ?? '').toLowerCase();
  if (st === 'completed') return 'EXECUTED';
  if (st === 'awarded' || rt === 'contract') return 'SIGNED';
  return 'BID';
}

export function linesFromRegister(parsed: ParsedRegister, workbookName: string): { pca: PcaLine[]; quotes: QuoteLine[] } {
  const reportById = new Map(parsed.reports.map((r) => [r.reportId, r]));
  const pca: PcaLine[] = [];
  for (const c of parsed.components) {
    const rep = reportById.get(c.reportId);
    const unit = (c.uom ?? '').toUpperCase();
    if (!rep || rep.reportDate === null || !UNITS.has(unit) || c.unitCost === null || c.unitCost <= 0) continue;
    const component = classifyComponent(c.system);
    if (component === 'other') continue;
    pca.push({
      propertyKey: rep.propertyKey, component, unit: unit as CalibrationUnit, unitCost: c.unitCost, qty: c.qty,
      consultant: rep.consultant ?? 'Unknown consultant', reportDate: rep.reportDate, reportId: rep.reportId,
      status: reportStatus({ usabilityClass: rep.usabilityClass, reportDate: rep.reportDate }),
      sourceFile: `${workbookName} > Components (${rep.reportId} ${c.system})`,
    });
  }
  const quotes: QuoteLine[] = [];
  for (const q of parsed.quotes) {
    const unit = (q.uom ?? '').toUpperCase();
    if (!UNITS.has(unit) || q.docDate === null) continue;
    const component = classifyComponent(`${q.title} ${q.scopeSummary ?? ''}`);
    if (component === 'other') continue;
    quotes.push({
      propertyKey: q.propertyKey, propertyLabel: q.propertyLabel, component, unit: unit as CalibrationUnit, qty: q.qty,
      totalUsd: q.actualUsd !== null && q.actualUsd > 0 ? q.actualUsd : q.quotedUsd, isActual: q.actualUsd !== null && q.actualUsd > 0, vendor: q.vendor ?? 'Unknown vendor', docDate: q.docDate,
      status: contractorStatus(q.recordType, q.status), superseded: (q.status ?? '').toLowerCase() === 'superseded',
      title: q.title, sourceFile: `${workbookName} > Quotes_Actuals (${demojibake(q.title)})`,
    });
  }
  return { pca, quotes };
}

/** Locale-independent string compare (code units): ICU / machine locale must never decide which quote or fact survives. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Best PCA line for a quote: same property + component + unit; newest report, then largest quantity. */
function pickPca(pca: PcaLine[], q: QuoteLine): PcaLine | null {
  const hits = pca.filter((p) => p.propertyKey === q.propertyKey && p.component === q.component && p.unit === q.unit);
  // Total order (register row order must never decide the unit-cost basis): newest report, largest qty, then stable keys.
  hits.sort((a, b) => byCode(b.reportDate, a.reportDate) || (b.qty ?? 0) - (a.qty ?? 0) || byCode(a.reportId, b.reportId) || byCode(a.sourceFile, b.sourceFile) || a.unitCost - b.unitCost);
  return hits[0] ?? null;
}

/** Ledger rows that stand in for an unidentified / undated quote on the same scope: a real quote may replace one (promote --supersedes). */
function placeholderNote(ledger: CalibrationObservation[], q: QuoteLine): string {
  const retired = supersededMap(ledger);
  const ids = ledger
    .filter((o) => !retired.has(o.obs_id) && registerPropertyKey(o.property) === registerPropertyKey(q.propertyLabel) && o.component === q.component && isPlaceholder(o))
    .map((o) => o.obs_id);
  return ids.length === 0 ? '' : ` Placeholder ledger rows exist for this scope (${ids.join(', ')}); if this quote replaces one, promote with --supersedes <obs_id> (repeat for each); promote refuses a counted row beside a live placeholder otherwise.`;
}

/** The register's alias rules ("3520 E. Fulton St", "E Fulton bldg") → one property key. */
export const registerPropertyKey: PropertyKeyOf = (label) => resolveProperty(label, new Set()).key;

/** Who was dropped and who was kept, so the reviewer can tell a true duplicate from a second scope on one document. */
export interface DuplicateReport {
  obsId: string;
  keptObsId: string;
  vendor: string;
  keptVendor: string;
  property: string;
  keptProperty: string;
  contractorUnitCost: number | null;
  keptContractorUnitCost: number | null;
}

type Row = CalibrationObservation | CalibrationProposal;
/** The row on file that `p` duplicates: same obs_id, or the same quote document (normalized property / vendor, date to the precision both state). */
export function findTwin(p: Row, onFile: readonly Row[]): Row | undefined {
  return onFile.find((o) => o.obs_id === p.obs_id) ?? onFile.find((o) => sameQuoteDocument(o, p, registerPropertyKey));
}
const duplicateReport = (p: Row, kept: Row): DuplicateReport => ({
  obsId: p.obs_id, keptObsId: kept.obs_id, vendor: p.contractor_source.vendor, keptVendor: kept.contractor_source.vendor,
  property: p.property, keptProperty: kept.property, contractorUnitCost: p.contractor_unit_cost, keptContractorUnitCost: kept.contractor_unit_cost,
});

export function proposePairs(
  pca: PcaLine[],
  quotes: QuoteLine[],
  existing: { ledger: CalibrationObservation[]; pending: CalibrationProposal[] },
  today: string,
  proposedFrom: string,
  onDuplicate: (skipped: DuplicateReport) => void = () => {},
): CalibrationProposal[] {
  // Seed with rows already on file so a collapse against an earlier run (or a hand-written ledger row) is caught and reported too.
  const onFile: Row[] = [...existing.ledger, ...existing.pending];
  const out: CalibrationProposal[] = [];
  // Deterministic order: when two quotes share an obs_id the live (non-superseded), newest, lowest-vendor one is kept, never input order.
  const ordered = [...quotes].sort(
    (a, b) =>
      Number(a.superseded) - Number(b.superseded) || byCode(b.docDate, a.docDate) || byCode(a.vendor, b.vendor) ||
      byCode(a.component, b.component) || byCode(a.unit, b.unit) || (a.totalUsd ?? 0) - (b.totalUsd ?? 0) ||
      (a.qty ?? Infinity) - (b.qty ?? Infinity) || byCode(a.sourceFile, b.sourceFile) || byCode(a.title, b.title) ||
      byCode(a.propertyLabel, b.propertyLabel) || byCode(a.status, b.status) || Number(a.isActual) - Number(b.isActual),
  );
  for (const q of ordered) {
    const p = pickPca(pca, q);
    if (!p) continue;
    const contractorUnit = q.totalUsd !== null && q.totalUsd > 0 && q.qty !== null && q.qty > 0 ? q.totalUsd / q.qty : null // a credit / $0 placeholder is not a price;
    const proposal = CalibrationProposal.parse({
      obs_id: `${q.propertyKey}:${q.component}:${slugify(q.vendor)}:${q.docDate}`,
      property: q.propertyLabel, component: q.component, unit: q.unit,
      qty: q.qty !== null && q.qty > 0 ? q.qty : null,
      pca_unit_cost: p.unitCost,
      pca_source: { consultant: p.consultant, report_date: p.reportDate, source_file: p.sourceFile, source_date: p.reportDate, price_basis: 'PCA_CONSULTANT_ESTIMATE', status: p.status },
      contractor_unit_cost: contractorUnit === null ? null : Math.round(contractorUnit * 1e6) / 1e6,
      contractor_source: { vendor: q.vendor, doc_date: q.docDate, status: q.status, source_file: q.sourceFile, source_date: q.docDate, price_basis: q.isActual ? 'CONTRACTOR_ACTUAL' : 'CONTRACTOR_QUOTE' },
      scope_note: `Auto-matched on property + component (${q.component}); PCA line ${p.reportId} qty ${p.qty ?? 'n/a'} ${p.unit}. Review scope equivalence before promoting.${placeholderNote(existing.ledger, q)}`,
      include_in_stats: !q.superseded,
      exclusion_reason: q.superseded ? 'quote superseded by a later version' : null,
      proposed_at: today, proposed_from: proposedFrom,
    });
    // Two identities exist (obs_id, and the quote document: resolved property + normalized vendor + date). Dedupe on both:
    // hand-written ledger obs_ids truncate the date and labels vary ("3520 E. Fulton St"), so obs_id alone never matches them.
    const twin = findTwin(proposal, onFile);
    if (twin) {
      // One quote document is one observation, but a document pricing two scopes on one date collapses here —
      // say so instead of dropping the second scope silently.
      onDuplicate(duplicateReport(proposal, twin));
      continue;
    }
    onFile.push(proposal);
    out.push(proposal);
  }
  return out;
}

// ── Notion (read-only) ──────────────────────────────────────────────────────────────────────

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
const NOTION = 'https://api.notion.com/v1';

type Props = Record<string, { type?: string; title?: Array<{ plain_text?: string }>; rich_text?: Array<{ plain_text?: string }>; select?: { name?: string } | null; number?: number | null; date?: { start?: string | null } | null; formula?: { number?: number | null; string?: string | null } } | undefined>;
const txt = (p: Props, k: string): string | null => {
  const v = p[k];
  if (!v) return null;
  const arr = v.title ?? v.rich_text;
  if (arr) return arr.map((t) => t.plain_text ?? '').join('').trim() || null;
  if (v.select) return v.select.name ?? null;
  if (v.date) return v.date.start ?? null;
  return null;
};
const numOf = (p: Props, k: string): number | null => {
  const v = p[k];
  if (!v) return null;
  if (typeof v.number === 'number') return v.number;
  if (v.formula && typeof v.formula.number === 'number') return v.formula.number;
  const s = txt(p, k)?.replace(/[$,]/g, '');
  const n = s === undefined || s === null || s === '' ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Notion page properties use the workbook's own column headers (the ledger mirrors the register's field names). */
export function notionQuote(props: Props, workbookLabel: string): QuoteLine | null {
  const title = txt(props, 'Record (title)');
  const label = txt(props, 'Property');
  const unit = (txt(props, 'UOM') ?? '').toUpperCase();
  const docDate = txt(props, 'Doc Date');
  if (!title || !label || !UNITS.has(unit) || !docDate) return null;
  const component = classifyComponent(`${title} ${txt(props, 'Scope Summary') ?? ''}`);
  if (component === 'other') return null;
  const status = txt(props, 'Status');
  return {
    propertyKey: resolveProperty(label, new Set()).key, propertyLabel: label, component, unit: unit as CalibrationUnit,
    qty: numOf(props, 'Qty'), totalUsd: (numOf(props, 'Actual Total') ?? 0) > 0 ? numOf(props, 'Actual Total') : numOf(props, 'Quoted Total'), isActual: (numOf(props, 'Actual Total') ?? 0) > 0,
    vendor: txt(props, 'Vendor') ?? 'Unknown vendor', docDate: docDate.slice(0, 10),
    status: contractorStatus(txt(props, 'Record Type'), status), superseded: (status ?? '').toLowerCase() === 'superseded',
    title, sourceFile: `Notion ${workbookLabel} > ${title}`,
  };
}

export function notionComponent(props: Props): PcaLine | null {
  const reportId = txt(props, 'Report ID');
  const label = txt(props, 'Property');
  const system = txt(props, 'System');
  const unit = (txt(props, 'UOM') ?? '').toUpperCase();
  const cost = numOf(props, 'Unit cost $/UOM');
  const reportDate = (txt(props, 'Report Date') ?? '').slice(0, 10);
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(reportDate)) return null; // no usable report date -> cannot judge vintage; skip, never default to STALE
  if (!reportId || !label || !system || !UNITS.has(unit) || cost === null || cost <= 0) return null;
  const component = classifyComponent(system);
  if (component === 'other') return null;
  return {
    propertyKey: resolveProperty(label, new Set()).key, component, unit: unit as CalibrationUnit, unitCost: cost,
    qty: numOf(props, 'Qty'), consultant: txt(props, 'Consultant') ?? 'Unknown consultant',
    reportDate, reportId, status: reportStatus({ usabilityClass: classifyUsability(txt(props, 'Usability')), reportDate }),
    sourceFile: `Notion Components > ${reportId} ${system}`,
  };
}

async function queryAll(fetchImpl: FetchLike, token: string, dataSourceId: string): Promise<Array<{ properties?: Props }>> {
  const headers = { authorization: `Bearer ${token}`, 'notion-version': process.env.NOTION_VERSION ?? '2025-09-03', 'content-type': 'application/json' };
  const pages: Array<{ properties?: Props }> = [];
  let cursor: string | undefined;
  do {
    const res = await fetchImpl(`${NOTION}/data_sources/${dataSourceId}/query`, { method: 'POST', headers, body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }) });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body = (await res.json()) as { results?: Array<{ properties?: Props }>; has_more?: boolean; next_cursor?: string | null };
    pages.push(...(body.results ?? []));
    cursor = body.has_more && body.next_cursor ? body.next_cursor : undefined;
  } while (cursor);
  return pages;
}

export async function fetchNotionLines(
  env: { token?: string; quotesDs?: string; componentsDs?: string },
  fetchImpl: FetchLike,
): Promise<{ pca: PcaLine[]; quotes: QuoteLine[]; skipped: string | null }> {
  if (!env.token || !env.quotesDs || !env.componentsDs) {
    return { pca: [], quotes: [], skipped: 'Notion source skipped: set NOTION_TOKEN, NOTION_CAPEX_QUOTES_DS and NOTION_CAPEX_COMPONENTS_DS' };
  }
  const [qp, cp] = await Promise.all([queryAll(fetchImpl, env.token, env.quotesDs), queryAll(fetchImpl, env.token, env.componentsDs)]);
  return {
    quotes: qp.map((p) => notionQuote(p.properties ?? {}, 'Quotes_Actuals')).filter((x): x is QuoteLine => x !== null),
    pca: cp.map((p) => notionComponent(p.properties ?? {})).filter((x): x is PcaLine => x !== null),
    skipped: null,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

function readJson<T>(path: string, parse: (raw: unknown) => T): T {
  return parse(existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : []);
}

async function main(argv: string[]): Promise<number> {
  const wbIdx = argv.indexOf('--workbook');
  const workbookPath = wbIdx >= 0 ? argv[wbIdx + 1] : process.env.PCA_REGISTER_XLSX;
  const useNotion = argv.includes('--notion');
  if (!workbookPath && !useNotion) {
    console.error('usage: npm run calibration:propose -- --workbook <register.xlsx> [--notion]');
    return 1;
  }
  const today = new Date().toISOString().slice(0, 10);
  const ledger = readJson(LEDGER_PATH, parseLedger);
  const pending = readJson(PENDING_PATH, parsePending);
  let pca: PcaLine[] = [];
  let quotes: QuoteLine[] = [];
  const from: string[] = [];

  if (workbookPath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(workbookPath);
    const parsed = parseRegister(wb, new Set());
    const lines = linesFromRegister(parsed, basename(workbookPath));
    pca = pca.concat(lines.pca);
    quotes = quotes.concat(lines.quotes);
    from.push(`workbook:${basename(workbookPath)}`);
  }
  if (useNotion) {
    const n = await fetchNotionLines(
      { token: process.env.NOTION_TOKEN, quotesDs: process.env.NOTION_CAPEX_QUOTES_DS, componentsDs: process.env.NOTION_CAPEX_COMPONENTS_DS },
      fetch as unknown as FetchLike,
    );
    if (n.skipped) console.warn(n.skipped);
    else { pca = pca.concat(n.pca); quotes = quotes.concat(n.quotes); from.push('notion'); }
  }

  const costSegPath = join(process.cwd(), 'data', 'cost-seg', 'cost-seg.json');
  const costSegFacts = existsSync(costSegPath) ? parseCostSeg(JSON.parse(readFileSync(costSegPath, 'utf-8'))).facts : [];
  // Cost seg quantities are only ever OFFERED as a candidate qty on a pending proposal; a human promotes (or not).
  const warnSkip = (d: DuplicateReport): void =>
    console.warn(`calibration-propose: skipped ${d.obsId} (${d.vendor} @ ${d.property}, $${d.contractorUnitCost ?? 'n/a'}/unit) — same quote document as ${d.keptObsId} (${d.keptVendor} @ ${d.keptProperty}, $${d.keptContractorUnitCost ?? 'n/a'}/unit); one quote document = one observation. Add it by hand if it is a separate scope.`);
  const proposals = bridgeCostSegQuantities(proposePairs(pca, quotes, { ledger, pending }, today, from.join('+') || 'none', warnSkip), costSegFacts);
  // Re-read both files right before writing: the loads above are async (workbook, Notion pagination) and a
  // `calibration:promote` run in that window must not be undone by writing back the stale snapshot.
  const fresh = readJson(PENDING_PATH, parsePending);
  const taken: Row[] = [...readJson(LEDGER_PATH, parseLedger), ...fresh];
  const toAdd = proposals.filter((p) => {
    const twin = findTwin(p, taken);
    if (twin) warnSkip(duplicateReport(p, twin)); // landed on file while we were loading: say so, never drop silently
    return twin === undefined;
  });
  const next = [...fresh, ...toAdd];
  const tmp = `${PENDING_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  renameSyncWithRetry(tmp, PENDING_PATH);
  console.log(`calibration-propose: ${toAdd.length} new proposal(s) -> ${PENDING_PATH} (${next.length} pending total). Ledger untouched.`);
  for (const p of toAdd) console.log(`  ${p.obs_id}`);
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/calibration-propose.ts')) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
