import ExcelJS from 'exceljs';
import { differenceInCalendarMonths, parseISO } from 'date-fns';
import {
  PortfolioSnapshot,
  SCHEMA_VERSION,
  slug,
  type Property,
  type Lease,
  type Loan,
  type CashEntity,
  type CashHistoryPoint,
  type InsurancePolicy,
  type Task,
  type TaskStatus,
  type DataQualityFlag,
  type Market,
  type PropertyType,
  type LeaseStatus,
  type InsuranceStatus,
  type ScenarioName,
} from '../../src/contracts/index';
import { SCENARIO_PRESETS } from '../../src/contracts/scenario';
import { loadDeals } from '../sources/notion-deals';
import { loadM365Tasks } from '../sources/m365-tasks';
import { deriveCounterparties } from './counterparties';
import { WORKBOOK_AS_OF, referenceDate } from '../config';

type Worksheet = ExcelJS.Worksheet;
type CellValue = ExcelJS.CellValue;

// ── cell helpers ────────────────────────────────────────────────────────────
function cv(v: CellValue | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) return (v as { result?: unknown }).result ?? null;
    if ('richText' in v)
      return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
    if ('text' in v) return (v as { text: unknown }).text;
    return null;
  }
  return v;
}
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === '—' || s === '-' ? null : s;
}
export function isoOrNull(
  v: unknown,
  flags: DataQualityFlag[],
  entity: string,
  field: string,
): string | null {
  let d: Date | null = null;
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) d = v;
  } else if (typeof v === 'string') {
    const p = new Date(v);
    if (!Number.isNaN(p.getTime())) d = p;
  }
  if (!d) return null;
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2100) {
    flags.push({
      entity,
      field,
      issue: `implausible date (${y})`,
      rawValue: String(v),
      severity: 'warn',
    });
    return null;
  }
  return d.toISOString().slice(0, 10);
}
function row(ws: Worksheet, r: number, c: number): unknown {
  return cv(ws.getRow(r).getCell(c).value);
}

export function inferMarket(text: string): Market {
  const t = text.toLowerCase();
  if (/raytown|kansas city|\bmo\b|missouri/.test(t)) return 'Kansas City MO';
  if (/toledo|secor|mcgregor/.test(t)) return 'Toledo OH';
  if (/twinsburg|cleveland/.test(t)) return 'Cleveland MSA';
  if (/indianapolis|richardt/.test(t)) return 'Indianapolis IN';
  if (
    /columbus|dublin|westerville|livingston|rarig|banwick|morrison|zettler|fishel|5th ave|fifth ave|state route 350|\boh\b|ohio/.test(
      t,
    )
  )
    return 'Columbus OH';
  if (
    /owings mills|columbia|baltimore|easton|salisbury|cambridge|potomac|broadway|owings|\bmd\b|maryland/.test(
      t,
    )
  )
    return 'Mid-Atlantic';
  return 'Other';
}
export function inferType(raw: string | null): PropertyType {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('flex')) return 'Flex';
  if (t.includes('retail')) return 'Retail';
  if (t.includes('indust')) return 'Industrial';
  if (t.includes('residen')) return 'Residence';
  return 'Other';
}

/**
 * Property.id is `slug(name)` (parse.ts), and it is the join key for every downstream
 * consumer — capital-allocation, debt-scoring, the warehouse crosswalk, overlay note keys.
 * Two property rows whose names slug to the same string (apostrophe/accent/whitespace
 * variants, or a genuine repeat address) would otherwise emit duplicate ids, silently
 * shadowing one property in any Map/Set keyed by id. This disambiguates in parse order:
 * the first occurrence keeps the base id; each later collision gets the next free
 * `<base>-N` (N starts at 2), skipping any suffix a real property already legitimately owns.
 * Mutates `items` in place (parse order preserved) and returns it. Each rename is surfaced
 * as a DataQualityFlag rather than applied silently.
 */
export function disambiguatePropertyIds<T extends { id: string; name: string }>(
  items: T[],
  flags: DataQualityFlag[],
): T[] {
  const taken = new Set<string>();
  for (const item of items) {
    if (!taken.has(item.id)) {
      taken.add(item.id);
      continue;
    }
    const base = item.id;
    let n = 2;
    let candidate = `${base}-${n}`;
    while (taken.has(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    flags.push({
      entity: candidate,
      field: 'id',
      issue: `property id collision on "${base}" (name "${item.name}") — disambiguated to "${candidate}"`,
      rawValue: base,
      severity: 'warn',
    });
    item.id = candidate;
    taken.add(candidate);
  }
  return items;
}

// ── properties (Property NOI) ─────────────────────────────────────────────────
function parseProperties(ws: Worksheet, flags: DataQualityFlag[]): Property[] {
  const out: Property[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const idx = num(row(ws, r, 1));
    const name = str(row(ws, r, 2));
    if (idx === null || !name || /portfolio total/i.test(name)) continue;
    const id = slug(name);
    const loanBalance = num(row(ws, r, 20)) ?? 0;
    const occ = num(row(ws, r, 6)) ?? 0;
    if (occ > 1.0001)
      flags.push({ entity: id, field: 'occPct', issue: `occupancy > 100% (${occ})`, severity: 'warn' });
    out.push({
      id,
      index: Math.round(idx),
      name,
      address: name,
      city: null,
      state: null,
      market: inferMarket(name),
      type: inferType(str(row(ws, r, 3))),
      sf: num(row(ws, r, 4)) ?? 0,
      tenantCount: Math.round(num(row(ws, r, 5)) ?? 0),
      occPct: Math.min(occ, 1),
      acqDate: isoOrNull(row(ws, r, 7), flags, id, 'acqDate'),
      estValue100: num(row(ws, r, 8)) ?? 0,
      oxfordOwnPct: num(row(ws, r, 9)) ?? 1,
      oxfordValue: num(row(ws, r, 10)) ?? 0,
      grossIncome: num(row(ws, r, 11)) ?? 0,
      expenses: num(row(ws, r, 12)) ?? 0,
      noi: num(row(ws, r, 13)) ?? 0,
      noiScenarioAdj: num(row(ws, r, 14)) ?? num(row(ws, r, 13)) ?? 0,
      debtService: num(row(ws, r, 15)) ?? 0,
      netCashFlow: num(row(ws, r, 16)) ?? 0,
      capRate: num(row(ws, r, 17)),
      dscr: num(row(ws, r, 18)),
      lender: str(row(ws, r, 19)),
      loanBalance,
      ltv: num(row(ws, r, 21)),
      valuePerSf: num(row(ws, r, 22)),
      rentPerSf: num(row(ws, r, 23)),
      equityInvested: num(row(ws, r, 24)) ?? 0,
      cashOnCash: num(row(ws, r, 25)),
      holdYrs: num(row(ws, r, 26)),
      encumbered: loanBalance > 0,
      flags: [],
    });
  }
  // Guarantee distinct property ids before leases/counterparties resolve against them.
  return disambiguatePropertyIds(out, flags);
}

function resolvePropertyId(key: string, properties: Property[]): string | null {
  const token = key
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  for (const p of properties) {
    const a = p.address.toLowerCase();
    if (token.some((t) => a.includes(t))) return p.id;
  }
  return null;
}

// ── leases (Master Tenant Rent Roll) ──────────────────────────────────────────
function parseLeases(
  ws: Worksheet,
  properties: Property[],
  flags: DataQualityFlag[],
  referenceDateIso: string,
): Lease[] {
  const out: Lease[] = [];
  // Day-count reference = the RUN date, NOT the workbook data date: a June-pinned
  // WORKBOOK_AS_OF froze every monthsToExpiry while the calendar advanced (frozen-dateline
  // defect, 2026-07). WORKBOOK_AS_OF still governs data-month selection (monthCol in
  // parseTasks below) and data-snapshot labels — do not conflate the two. The caller resolves
  // the exact reference (the brief passes its ET send date; other callers pass the UTC default).
  const asOf = parseISO(referenceDateIso);
  for (let r = 1; r <= ws.rowCount; r++) {
    const propertyKey = str(row(ws, r, 1));
    const tenantName = str(row(ws, r, 2));
    if (!propertyKey || !tenantName) continue;
    if (/portfolio total|tenant roster/i.test(propertyKey)) continue;
    if (tenantName.toLowerCase() === 'tenant name') continue; // header
    const monthlyRent = num(row(ws, r, 6));
    const annualRent = num(row(ws, r, 13));
    if (monthlyRent === null && annualRent === null) continue;
    const id = `${slug(propertyKey)}-${slug(str(row(ws, r, 3)) ?? tenantName)}-${r}`;
    const leaseEnd = isoOrNull(row(ws, r, 9), flags, id, 'leaseEnd');
    const rawStatus = (str(row(ws, r, 12)) ?? '').toLowerCase();
    let status: LeaseStatus = 'Unknown';
    if (rawStatus.includes('expiring')) status = 'Expiring Soon';
    else if (rawStatus.includes('expired')) status = 'Expired';
    else if (rawStatus.includes('active')) status = 'Active';
    else if (rawStatus.includes('vacant')) status = 'Vacant';
    out.push({
      id,
      propertyKey,
      propertyId: resolvePropertyId(propertyKey, properties),
      tenantName,
      unit: str(row(ws, r, 3)),
      company: str(row(ws, r, 4)),
      sf: num(row(ws, r, 5)) ?? 0,
      monthlyRent: monthlyRent ?? 0,
      rentPerSf: num(row(ws, r, 7)),
      leaseStart: isoOrNull(row(ws, r, 8), flags, id, 'leaseStart'),
      leaseEnd,
      escalationDate: isoOrNull(row(ws, r, 10), flags, id, 'escalationDate'),
      escalationPct: num(row(ws, r, 11)),
      status,
      annualRent: annualRent ?? (monthlyRent ?? 0) * 12,
      monthsToExpiry: leaseEnd ? differenceInCalendarMonths(parseISO(leaseEnd), asOf) : null,
      flags: [],
    });
  }
  return out;
}

// ── loans (Loan Index — section-aware) ────────────────────────────────────────
function parseLoans(ws: Worksheet, flags: DataQualityFlag[]): Loan[] {
  const out: Loan[] = [];
  let section: Loan['direction'] | null = null;
  for (let r = 1; r <= ws.rowCount; r++) {
    const c1 = String(cv(ws.getRow(r).getCell(1).value) ?? '');
    const c2 = str(row(ws, r, 2));
    const banner = `${c1} ${c2 ?? ''}`.toUpperCase();
    if (/WE PAY|IS BORROWER/.test(banner)) { section = 'borrower'; continue; }
    if (/WE RECEIVE|IS LENDER/.test(banner)) { section = 'lender'; continue; }
    if (/INTERNAL LOAN JOURNAL/.test(banner)) { section = 'internal'; continue; }
    if (/PORTFOLIO SNAPSHOT|BALLOON ALERT|HOW TO USE/.test(banner)) { section = null; continue; }
    if (!section) continue;
    const idx = num(row(ws, r, 1));
    const rawName = c2;
    if (idx === null || !rawName) continue;
    const name = rawName.replace(/\s*→\s*$/, '').trim();
    const id = slug(`${section}-${name}`);
    const balance = num(row(ws, r, 4)) ?? 0;
    const maturityStr = section === 'internal' ? null : str(row(ws, r, 7));
    const isDemand = (maturityStr ?? '').toLowerCase() === 'demand' || section === 'internal';
    const status = section === 'internal' ? str(row(ws, r, 8)) : str(row(ws, r, 10));
    out.push({
      id,
      name,
      counterparty: str(row(ws, r, 3)),
      direction: section,
      originalPrincipal: null,
      currentBalance: balance,
      absBalance: Math.abs(balance),
      rate: num(row(ws, r, 5)),
      monthlyPmt: num(row(ws, r, 6)),
      annualInterest: null,
      annualPrincipal: null,
      loanType: status,
      status,
      isDemand,
      maturity: isDemand ? null : isoOrNull(row(ws, r, 7), flags, id, 'maturity'),
      monthsToMaturity: section === 'internal' ? null : num(row(ws, r, 8)),
      ltv: num(row(ws, r, 9)),
      lender: section === 'borrower' ? str(row(ws, r, 3)) : null,
      balloon: /balloon/i.test(`${name} ${status ?? ''}`),
      flags: [],
      // Col 11 = Property display name (Gabriel adds this column); borrower only.
      // null for lender/internal rows — never misattributed.
      collateralProperty: section === 'borrower' ? (str(row(ws, r, 11)) ?? null) : null,
    });
  }
  return out;
}

// ── cash (Cash Balances) ──────────────────────────────────────────────────────
function parseCash(ws: Worksheet, flags: DataQualityFlag[]) {
  const entities: CashEntity[] = [];
  let totalCash: number | null = null;

  // Locate the entity-summary header ("Entity / LLC").
  let ehdr = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (/entity \/ llc/i.test(String(cv(ws.getRow(r).getCell(1).value) ?? ''))) {
      ehdr = r;
      break;
    }
  }
  if (ehdr > 0) {
    for (let r = ehdr + 1; r <= ws.rowCount; r++) {
      const entity = str(row(ws, r, 1));
      if (!entity) break;
      if (/total portfolio/i.test(entity)) {
        totalCash = num(row(ws, r, 2));
        break;
      }
      const arrow = String(row(ws, r, 13) ?? '');
      const trend = arrow.includes('↑') ? 'up' : arrow.includes('↓') ? 'down' : 'flat';
      entities.push({
        entity,
        id: slug(entity),
        currentBalance: num(row(ws, r, 2)) ?? 0,
        priorBalance: num(row(ws, r, 3)),
        deltaDollar: num(row(ws, r, 4)),
        deltaPct: num(row(ws, r, 5)),
        avg3: num(row(ws, r, 6)),
        minAllTime: num(row(ws, r, 7)),
        maxAllTime: num(row(ws, r, 8)),
        bal12moAgo: num(row(ws, r, 9)),
        growth12Dollar: num(row(ws, r, 10)),
        growth12Pct: num(row(ws, r, 11)),
        pctOfPortfolio: num(row(ws, r, 12)),
        trend,
        flags: [],
      });
    }
  }

  // Historical matrix — first row whose col1 === "Date".
  let mhdr = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (String(cv(ws.getRow(r).getCell(1).value) ?? '').trim() === 'Date') {
      mhdr = r;
      break;
    }
  }
  const cols: { col: number; name: string }[] = [];
  let totalCol = -1;
  if (mhdr > 0) {
    for (let c = 2; c <= 40; c++) {
      const n = str(row(ws, mhdr, c));
      if (!n) break;
      if (/^total/i.test(n)) {
        totalCol = c;
        break;
      }
      cols.push({ col: c, name: n });
    }
  }
  const history: CashHistoryPoint[] = [];
  if (mhdr > 0) {
    for (let r = mhdr + 1; r <= ws.rowCount; r++) {
      const dateIso = isoOrNull(row(ws, r, 1), flags, 'cash-history', `row${r}`);
      if (!dateIso) break;
      const balances: Record<string, number> = {};
      for (const { col, name } of cols) {
        const b = num(row(ws, r, col));
        if (b !== null) balances[name] = b;
      }
      history.push({
        date: dateIso,
        total: totalCol > 0 ? (num(row(ws, r, totalCol)) ?? 0) : 0,
        balances,
      });
    }
  }

  const computedTotal = entities.reduce((s, e) => s + e.currentBalance, 0);
  const total = totalCash ?? computedTotal;
  const sorted = [...entities].sort((a, b) => b.currentBalance - a.currentBalance);
  const largest = sorted[0] ?? null;

  return {
    asOf: WORKBOOK_AS_OF,
    totalCash: total,
    activeEntities: entities.length,
    largestEntity: largest?.entity ?? null,
    concentrationTopPct: largest && total ? largest.currentBalance / total : null,
    cagr: null as number | null,
    entities,
    history,
  };
}

// ── insurance (Insurance Renewals) ────────────────────────────────────────────
function parseInsurance(ws: Worksheet, flags: DataQualityFlag[]): InsurancePolicy[] {
  const out: InsurancePolicy[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const rowId = str(row(ws, r, 1));
    if (!rowId || !/^ins-/i.test(rowId)) continue; // RowID pattern anchors data rows
    const property = str(row(ws, r, 2)) ?? '—';
    const override = (str(row(ws, r, 12)) ?? '').toLowerCase();
    const rawStatus = (str(row(ws, r, 11)) ?? '').toLowerCase();
    let status: InsuranceStatus = 'Unknown';
    if (override.includes('cancel') || rawStatus.includes('cancel')) status = 'Cancelled';
    else if (rawStatus.includes('expired')) status = 'Expired';
    else if (rawStatus.includes('renew now')) status = 'Renew Now';
    else if (rawStatus.includes('renewing')) status = 'Renewing Soon';
    else if (rawStatus.includes('current')) status = 'Current';
    out.push({
      id: slug(rowId),
      property,
      entity: str(row(ws, r, 3)),
      coverage: str(row(ws, r, 4)),
      effective: isoOrNull(row(ws, r, 5), flags, slug(rowId), 'effective'),
      expires: isoOrNull(row(ws, r, 6), flags, slug(rowId), 'expires'),
      policyNo: str(row(ws, r, 7)),
      carrier: str(row(ws, r, 8)),
      premium: num(row(ws, r, 9)) ?? 0,
      daysToExpiry: num(row(ws, r, 10)),
      status,
      notes: str(row(ws, r, 13)),
      // Optional economics columns (D3 framework): absent columns → null, never invented.
      tiv: num(row(ws, r, 14)),
      deductible: num(row(ws, r, 15)),
      coverageLimit: num(row(ws, r, 16)),
      flags: [],
    });
  }
  return out;
}

// ── tasks (Monthly Checklist) ─────────────────────────────────────────────────
export function statusFromSymbol(v: unknown): TaskStatus {
  const s = String(v ?? '').trim();
  if (s.includes('✅')) return 'done';
  if (s.includes('⚠')) return 'overdue';
  if (/^r$/i.test(s) || s.includes('R')) return 'renewal';
  if (s.includes('☐')) return 'pending';
  if (s === '—' || s === '-') return 'na';
  return 'unknown';
}
/**
 * The Monthly Checklist sheet carries decorative banner/summary rows (alerts, section
 * headers) whose text bleeds across many columns. Some carry a RowID and label, so they
 * slip past the header guard and were being ingested as Tasks — surfacing as junk section
 * cards with the same string smeared across title/type/notes (Defect 9). Reject them.
 */
export function isTaskBannerRow(
  label: string,
  section: string | null,
  type: string | null,
): boolean {
  if (/^\s*[⚠✅☐]/.test(label)) return true; // leading status/alert glyph = banner, not a task
  if (/balloon alert|cash flow summary|how to use|portfolio snapshot|^\s*notes?\b/i.test(label)) return true;
  // The smear pattern: the same text bled into label + section + type.
  if (section !== null && type !== null && label === section && section === type) return true;
  return false;
}

function parseTasks(ws: Worksheet): Task[] {
  // JAN is column 7; current month column = 7 + month index (0-based).
  const monthCol = 7 + new Date(WORKBOOK_AS_OF).getUTCMonth();
  const out: Task[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const rowId = str(row(ws, r, 20));
    const label = str(row(ws, r, 1));
    if (!rowId || !label) continue;
    if (rowId === 'RowID' || /^loan \/ property$/i.test(label)) continue; // header row
    const section = str(row(ws, r, 19)) ?? 'Other';
    const type = str(row(ws, r, 4));
    if (isTaskBannerRow(label, section, type)) continue; // skip decorative banner/summary rows
    out.push({
      id: rowId,
      label,
      section,
      role: str(row(ws, r, 3)),
      type,
      dueDay: str(row(ws, r, 5)),
      notes: str(row(ws, r, 6)),
      status: statusFromSymbol(row(ws, r, monthCol)),
      monthlyPmt: num(row(ws, r, 21)),
    });
  }
  return out;
}

// ── assumptions (Assumptions) — label-scanned ─────────────────────────────────
function parseAssumptions(ws: Worksheet) {
  let activeScenario: ScenarioName = 'Base';
  let balloonAlertMonths = 18;
  let concentrationYellow = 0.25;
  let concentrationRed = 0.5;
  for (let r = 1; r <= ws.rowCount; r++) {
    const label = str(row(ws, r, 2));
    const val = row(ws, r, 3);
    if (!label) continue;
    if (/active scenario/i.test(label)) {
      const s = str(val);
      if (s === 'Base' || s === 'Upside' || s === 'Downside') activeScenario = s;
    } else if (/balloon alert.*month/i.test(label)) balloonAlertMonths = num(val) ?? 18;
    else if (/concentration.*yellow/i.test(label)) concentrationYellow = num(val) ?? 0.25;
    else if (/concentration.*red/i.test(label)) concentrationRed = num(val) ?? 0.5;
  }
  const preset = SCENARIO_PRESETS[activeScenario];
  return {
    activeScenario,
    revenueFactor: preset.revenueFactor,
    vacancyFactor: preset.vacancyFactor,
    exitCapFactor: preset.exitCapFactor,
    thresholds: { balloonAlertMonths, concentrationYellow, concentrationRed },
    asOf: WORKBOOK_AS_OF,
  };
}

// ── orchestrator ──────────────────────────────────────────────────────────────
export interface ParseResult {
  snapshot: PortfolioSnapshot;
  flags: DataQualityFlag[];
}

/**
 * @param referenceDateIso Optional day-count reference (YYYY-MM-DD) for lease monthsToExpiry.
 *   The brief pipeline passes its ET send date so day-counts track the firm's timezone
 *   consistently; other callers (live server, reconcile, extract) default to referenceDate()
 *   (the UTC run date). Never governs data-month selection (monthCol) or data-snapshot labels.
 */
export async function parseWorkbook(path: string, referenceDateIso?: string): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const flags: DataQualityFlag[] = [];
  const refIso = referenceDateIso ?? referenceDate();

  const get = (name: string): Worksheet => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`Worksheet not found: "${name}"`);
    return ws;
  };

  const properties = parseProperties(get('Property NOI'), flags);
  const leases = parseLeases(get('Master Tenant Rent Roll'), properties, flags, refIso);
  const loans = parseLoans(get('Loan Index'), flags);
  const cash = parseCash(get('Cash Balances'), flags);
  const insurance = parseInsurance(get('Insurance Renewals'), flags);
  const checklistTasks = parseTasks(get('Monthly Checklist'));
  const m365Tasks = await loadM365Tasks(); // live M365 To-Do prepended when GRAPH_TOKEN set, else []
  const tasks = m365Tasks.length ? [...m365Tasks, ...checklistTasks] : checklistTasks;
  const assumptions = parseAssumptions(get('Assumptions'));
  const deals = await loadDeals(); // live Notion pipeline merged onto seed when configured, else seed
  const counterparties = deriveCounterparties({ properties, loans, insurance, deals });

  const snapshot = PortfolioSnapshot.parse({
    meta: {
      schemaVersion: SCHEMA_VERSION,
      asOf: WORKBOOK_AS_OF,
      generatedAt: new Date().toISOString(),
      source: 'Master Excel Template Company Wide -- Oxford.xlsx',
      scenario: assumptions.activeScenario,
    },
    assumptions,
    properties,
    leases,
    loans,
    cash,
    insurance,
    deals,
    tasks,
    counterparties,
    dataQuality: flags,
  });

  return { snapshot, flags };
}
