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
import { crossCheckDebtService } from './debt-service-crosscheck';
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

// ── workbook dateline (provenance "As of") ──────────────────────────────────
const MONTH_INDEX: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Extract an ISO date from a sheet dateline like
 * "As of July 17, 2026   │   137 tenants   │   513,000 SF leased" (rent roll / assumptions,
 * TEXT(TODAY(),...) cached at last save) or "As of July 10, 2026" (Cash Balances,
 * data-derived MAX of the Cash Data date row). Deterministic string parse — deliberately no
 * `new Date(text)` round-trip, whose local-timezone midnight can shift the ISO day (OI-023).
 */
export function datelineToIso(text: string): string | null {
  const m = /as of\s+([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (!m) return null;
  const token = m[1]!.toLowerCase();
  const month =
    MONTH_INDEX[token] ??
    (token.length >= 3
      ? Object.entries(MONTH_INDEX).find(([name]) => name.startsWith(token))?.[1] ?? null
      : null);
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Scan the top of a sheet (column A) for its own "As of …" dateline. The real workbook stores
 * these as formulas; ExcelJS surfaces the CACHED result from the last save, which cv() unwraps.
 * Returns null when no parseable dateline exists (e.g. programmatic fixtures with no cached
 * formula results) — callers fall back LOUDLY via a DataQualityFlag, never silently (OI-023).
 */
export function sheetDataAsOf(ws: Worksheet, maxRows = 6): string | null {
  const last = Math.min(maxRows, ws.rowCount);
  for (let r = 1; r <= last; r++) {
    const text = str(row(ws, r, 1));
    if (!text) continue;
    const iso = datelineToIso(text);
    if (iso) return iso;
  }
  return null;
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

/**
 * Lease.id twin of disambiguatePropertyIds above — same collision-in-parse-order semantics,
 * described via tenant identity instead of a property `name`. Deliberately NOT a shared
 * generalization of disambiguatePropertyIds: keeping them independent means this fix cannot
 * perturb the already-shipped, already-tested property-id path.
 *
 * Suffix assignment WITHIN a collision group (2+ items sharing the same natural/pre-disambiguation
 * id) is decided by a deterministic property of the LEASE CONTENT — leaseEnd asc, then leaseStart
 * asc, then monthlyRent asc, then annualRent asc, then sf asc (nulls/undefined sort last at every
 * step) — NOT by parse/array order (Defect J, round-2 REFUTE; annualRent/sf added round-3 REFUTE).
 * Two rows that share an IDENTICAL natural id (e.g. a tenant's expiring lease plus its own
 * already-executed renewal, both listed as separate rent-roll rows for the same suite) previously
 * had the bare base id assigned to whichever happened to parse first, so a worksheet re-sort (e.g.
 * by lease-end date) silently moved any overlay data (arrears, renewal stage, market rent) attached
 * to that id from one physical lease record to the other. Groups are themselves processed in a
 * canonical (sorted-by-base-id) order so the overall outcome — including which candidate suffixes
 * are still free for one group after another group has claimed some — is independent of the
 * original items[] array order, not just independent of order WITHIN a group.
 *
 * Round-3 REFUTE (HIGH): the original 3-field chain (leaseEnd/leaseStart/monthlyRent) was not a
 * TOTAL order — two rows that tie on all three (identical dates AND monthlyRent, but a different
 * `sf` or an `annualRent` read independently from a different workbook column that can diverge from
 * `monthlyRent * 12`) had nothing left to break the tie on, so the sort's stability silently fell
 * back to array (worksheet row) order for that residual case — reintroducing the exact instability
 * this function exists to eliminate, just one level further down the tie-break chain. Extending the
 * chain with annualRent then sf closes every realistic case; if items STILL tie after all five
 * fields, that is a genuine full content duplicate — array order remains the fallback there (there
 * is nothing else to break the tie on), but the emitted flag message says so explicitly instead of
 * claiming a "deterministic order" the code didn't actually deliver for that residual group.
 *
 * leaseEnd/leaseStart/monthlyRent/annualRent/sf are all OPTIONAL on the constraint (absent →
 * treated as null/tied) so a caller that doesn't carry lease-content fields (e.g. this file's own
 * unit tests) still type-checks and falls back to array order via the sort's stability, matching
 * pre-Defect-J behavior exactly.
 */
export function disambiguateLeaseIds<
  T extends {
    id: string;
    tenantName: string;
    company: string | null;
    leaseEnd?: string | null;
    leaseStart?: string | null;
    monthlyRent?: number | null;
    annualRent?: number | null;
    sf?: number | null;
  },
>(items: T[], flags: DataQualityFlag[]): T[] {
  // Every row's NATURAL id, computed up front -- a synthetic "-N" candidate below must never
  // claim one of these, or a colliding lease early in parse order could steal a not-yet-processed
  // lease's rightful id, flipping ownership under row reordering (the exact instability this
  // function exists to eliminate, reintroduced in the collision-adjacent id space).
  const allNaturalIds = new Set(items.map((i) => i.id));

  // Group items by their natural (pre-disambiguation) id -- collisions only exist within a group.
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const g = groups.get(item.id);
    if (g) g.push(item);
    else groups.set(item.id, [item]);
  }

  // (nullRank, comparable) -- absent/null sorts after any real value, matching "nulls last".
  const rank = (v: string | number | null | undefined): [number, string | number] =>
    v === null || v === undefined ? [1, ''] : [0, v];
  const compareRanked = (a: string | number | null | undefined, b: string | number | null | undefined): number => {
    const [aNull, aVal] = rank(a);
    const [bNull, bVal] = rank(b);
    if (aNull !== bNull) return aNull - bNull;
    if (aVal === bVal) return 0;
    return aVal < bVal ? -1 : 1;
  };
  // String form of `rank()`, used only to build a full-chain equality KEY (not a comparison) for
  // clustering fully-tied items -- see the fullKey usage below.
  const compareRankedKey = (v: string | number | null | undefined): string => {
    const [nullRank, val] = rank(v);
    return `${nullRank}:${val}`;
  };

  const taken = new Set<string>();
  // Canonical (alphabetical) base-id order -- makes the WHOLE function's output independent of the
  // original items[] order, not just order within one group (required for Invariant 5-style
  // determinism: distinct collision groups never fight over each other's candidate suffixes, but
  // processing them in a fixed order removes even that theoretical dependency).
  for (const base of [...groups.keys()].sort()) {
    const group = groups.get(base)!;
    if (group.length === 1) {
      taken.add(base); // no collision -- keeps its natural id untouched, exactly as before
      continue;
    }
    // Deterministic tie-break chain. Array.prototype.sort is stable, so when every ranked field
    // ties (e.g. this file's own tests, which don't set any of the five content fields), the
    // group's original relative (array) order decides -- identical to pre-Defect-J behavior.
    const sorted = [...group].sort(
      (a, b) =>
        compareRanked(a.leaseEnd, b.leaseEnd) ||
        compareRanked(a.leaseStart, b.leaseStart) ||
        compareRanked(a.monthlyRent, b.monthlyRent) ||
        compareRanked(a.annualRent, b.annualRent) ||
        compareRanked(a.sf, b.sf),
    );
    // Round-3 REFUTE (HIGH): the prior 3-field chain wasn't a TOTAL order over lease content -- two
    // rows tying on leaseEnd/leaseStart/monthlyRent (but differing sf, or an annualRent read
    // independently from a different workbook column that can diverge from monthlyRent * 12) had
    // nothing left to break the tie on, silently falling back to array/worksheet-row order for that
    // residual case -- exactly the instability this function exists to eliminate. The chain above now
    // also covers annualRent/sf; cluster items by whether the FULL 5-field key still ties (equal-key
    // items are always contiguous after this sort, since it's a total preorder on that key) so the
    // flag text below can say honestly whether the chain actually decided this item's position, or
    // whether it's a genuine full content duplicate that fell back to array order.
    const fullKey = (v: T): string =>
      [compareRankedKey(v.leaseEnd), compareRankedKey(v.leaseStart), compareRankedKey(v.monthlyRent), compareRankedKey(v.annualRent), compareRankedKey(v.sf)].join('|');
    const fullKeyCounts = new Map<string, number>();
    for (const item of sorted) {
      const k = fullKey(item);
      fullKeyCounts.set(k, (fullKeyCounts.get(k) ?? 0) + 1);
    }
    // First in the deterministic order keeps the bare base id (already equals it -- explicit for
    // clarity, since "first" is no longer necessarily items[0] within the group).
    taken.add(base);
    for (let i = 1; i < sorted.length; i++) {
      const item = sorted[i]!;
      let n = 2;
      let candidate = `${base}-${n}`;
      while (taken.has(candidate) || allNaturalIds.has(candidate)) {
        n += 1;
        candidate = `${base}-${n}`;
      }
      const clusterSize = fullKeyCounts.get(fullKey(item)) ?? 1;
      const issue =
        clusterSize > 1
          ? `lease id collision on "${base}" (tenant "${item.company ?? item.tenantName}") — disambiguated to "${candidate}" (tie-broken by leaseEnd/leaseStart/monthlyRent/annualRent/sf; ${clusterSize} members remained fully tied and were ordered by worksheet position — a true content duplicate)`
          : `lease id collision on "${base}" (tenant "${item.company ?? item.tenantName}") — disambiguated to "${candidate}" (deterministic order: leaseEnd asc, then leaseStart, then monthlyRent, then annualRent, then sf, nulls last)`;
      flags.push({
        entity: candidate,
        field: 'id',
        issue,
        rawValue: base,
        severity: 'warn',
      });
      item.id = candidate;
      taken.add(candidate);
    }
  }
  return items;
}

// ── properties (Property NOI) ─────────────────────────────────────────────────
interface PropertiesParseResult {
  properties: Property[];
  /** The workbook's own "Portfolio Total" row (NOI col 13 / Value col 10), captured during the
   *  same pass that skips that row from the per-property list -- no second read. Null if the
   *  workbook has no such row, so reconcile-runtime can skip the cross-check rather than false-flag. */
  workbookNoiTotal: number | null;
  workbookValueTotal: number | null;
}

function parseProperties(ws: Worksheet, flags: DataQualityFlag[]): PropertiesParseResult {
  const out: Property[] = [];
  let workbookNoiTotal: number | null = null;
  let workbookValueTotal: number | null = null;
  let foundPortfolioTotalRow = false;
  for (let r = 1; r <= ws.rowCount; r++) {
    const idx = num(row(ws, r, 1));
    const name = str(row(ws, r, 2));
    if (name && /portfolio total/i.test(name)) {
      // First match wins (mirrors scripts/reconcile.ts's find(), which returns on its first hit) --
      // a second matching row (e.g. a footnote/banner row) is ignored rather than silently
      // overwriting an already-captured total.
      if (!foundPortfolioTotalRow) {
        foundPortfolioTotalRow = true;
        workbookNoiTotal = num(row(ws, r, 13));
        workbookValueTotal = num(row(ws, r, 10));
      }
      continue;
    }
    if (idx === null || !name) continue;
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
  return { properties: disambiguatePropertyIds(out, flags), workbookNoiTotal, workbookValueTotal };
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
/** Banner that opens a trailing DERIVED block on the rent roll — everything at or below it is a
 *  view of leases already parsed above, not tenancy data. See the latch in parseLeases. */
const LEASE_SECTION_TERMINATOR = /vacancy\s*&\s*upcoming availability/i;

interface LeasesParseResult {
  leases: Lease[];
  /** The workbook's own "Portfolio Total" row (Annualized Rent, col 14 -- one column right of
   *  where individual rows carry annualRent at col 13). Captured during the same pass that skips
   *  that row from the per-lease list -- no second read. Null if no such row is found. */
  workbookRentTotal: number | null;
}

function parseLeases(
  ws: Worksheet,
  properties: Property[],
  flags: DataQualityFlag[],
  referenceDateIso: string,
): LeasesParseResult {
  const out: Lease[] = [];
  const pendingRowFlags: { lease: Lease; rowFlags: DataQualityFlag[] }[] = [];
  let workbookRentTotal: number | null = null;
  let foundPortfolioTotalRow = false;
  let trailingSectionReached = false;
  // Day-count reference = the RUN date, NOT the workbook data date: a June-pinned
  // WORKBOOK_AS_OF froze every monthsToExpiry while the calendar advanced (frozen-dateline
  // defect, 2026-07). WORKBOOK_AS_OF still governs data-month selection (monthCol in
  // parseTasks below) — do not conflate the two. Data-snapshot labels (meta.asOf, cash.asOf,
  // assumptions.asOf) read the workbook's OWN dateline since OI-023 (2026-07-22), with
  // WORKBOOK_AS_OF as the flagged fallback. The caller resolves the exact day-count
  // reference (the brief passes its ET send date; other callers pass the UTC default).
  const asOf = parseISO(referenceDateIso);
  for (let r = 1; r <= ws.rowCount; r++) {
    // A property key is never a date in a valid roster row. str() STRINGIFIES a Date rather than
    // returning null ("Tue Sep 29 2026 20:00:00 GMT-0400 (...)"), so without this a dated row sails
    // through the emptiness guard below and becomes a lease. That is precisely how the trailing
    // vacancy block (see LEASE_SECTION_TERMINATOR) was ingested. Kept as a second, text-independent
    // line of defence: the banner match above stops working the moment the block is retitled.
    // Narrowed to this column deliberately -- str() is shared by every parser in this file and
    // must keep its current behaviour for genuinely date-like text elsewhere.
    const propertyKeyRaw = row(ws, r, 1);
    const propertyKeyIsDate = propertyKeyRaw instanceof Date;
    const propertyKey = propertyKeyIsDate ? null : str(propertyKeyRaw);
    const tenantName = str(row(ws, r, 2));
    if (/portfolio total/i.test(`${propertyKey ?? ''} ${tenantName ?? ''}`)) {
      // First match wins -- see the identical rationale in parseProperties above.
      if (!foundPortfolioTotalRow) {
        foundPortfolioTotalRow = true;
        workbookRentTotal = num(row(ws, r, 14));
      }
      continue;
    }
    // The rent roll ends with DERIVED summary blocks -- currently "VACANCY & UPCOMING AVAILABILITY
    // -- VACANT + NOTICE TO VACATE (sorted by Lease End)", added to the live workbook 2026-08. Every
    // row in such a block is a cross-reference formula back into the roster ABOVE it, and its
    // columns sit one to the right of the roster's (col 1 is a Move-Out Date, col 6 is SF where the
    // roster's col 6 is monthlyRent). They are views of leases already parsed, never tenancies of
    // their own. Once a block begins, no later row on the sheet is a lease -- so latch and skip the
    // remainder rather than trying to re-align columns.
    //
    // Deliberately checked AFTER the portfolio-total capture above and via a latch rather than
    // `break`, so a totals row placed BELOW a banner would still be captured. Do not "simplify"
    // this into a break: that would silently couple workbookRentTotal to sheet row ordering.
    if (LEASE_SECTION_TERMINATOR.test(`${propertyKey ?? ''} ${tenantName ?? ''}`)) {
      trailingSectionReached = true;
    }
    if (trailingSectionReached) continue;
    // Past this point a dated property key is UNEXPECTED — the row is not inside any block we
    // recognise, so it is either a derived block that has been retitled/moved (the terminator
    // above no longer matching) or a genuine roster row Excel has coerced to a date. Both need a
    // human. Dropping it is still right, but dropping it SILENTLY is not: "no lease and no flag"
    // reads identically to "there was nothing here", which is precisely how the phantom leases
    // shipped under a "Data-quality flags: 0" banner.
    //
    // Deliberately NOT raised for rows inside a recognised block above: that block is a permanent,
    // legitimate part of the sheet, and ora-cc-snapshot-refresh alerts whenever flags > 0 — so
    // flagging the expected case would mean an alert email 3x/weekday forever. Flag the anomaly,
    // stay silent on the understood. Gated on tenantName so the block's header/total rows, which
    // carry no tenant, never trip it.
    if (propertyKeyIsDate && tenantName) {
      flags.push({
        entity: `rent-roll-row-${r}`,
        field: 'propertyKey',
        issue:
          'row skipped — property key is a date, not a property name (an unrecognised derived block, or a roster row Excel coerced to a date)',
        rawValue: String(propertyKeyRaw),
        severity: 'warn',
      });
    }
    if (!propertyKey || !tenantName) continue;
    if (/tenant roster/i.test(propertyKey)) continue;
    if (tenantName.toLowerCase() === 'tenant name') continue; // header
    const monthlyRent = num(row(ws, r, 6));
    const annualRent = num(row(ws, r, 13));
    if (monthlyRent === null && annualRent === null) continue;
    const unit = str(row(ws, r, 3));
    // Tenant identity is part of the id, not just the fallback for a missing unit: a suite
    // turnover (same unit, new tenant) must produce a DIFFERENT id, or every overlay entry keyed
    // to the old id (tenantArrears, renewalStages, marketRents) silently re-attaches to the new
    // tenant's lease -- a real defect a mandatory adversarial review round found (financial data
    // silently misattributed to the wrong counterparty on the routine suite-turnover case).
    const tenantSlug = slug(str(row(ws, r, 4)) ?? tenantName);
    const id = unit
      ? `${slug(propertyKey)}-${slug(unit)}-${tenantSlug}`
      : `${slug(propertyKey)}-${tenantSlug}`;
    // Date-quality flags for this row are collected locally, not pushed to `flags` directly:
    // `id` here is pre-disambiguation and may be renamed once disambiguateLeaseIds runs over the
    // full `out` array below, which would otherwise leave a stale `entity` on any flag raised
    // before the rename -- misattributing a data-quality warning to the wrong lease on a collision.
    const rowFlags: DataQualityFlag[] = [];
    const leaseEnd = isoOrNull(row(ws, r, 9), rowFlags, id, 'leaseEnd');
    const rawStatus = (str(row(ws, r, 12)) ?? '').toLowerCase();
    let status: LeaseStatus = 'Unknown';
    if (rawStatus.includes('expiring')) status = 'Expiring Soon';
    else if (rawStatus.includes('expired')) status = 'Expired';
    else if (rawStatus.includes('active')) status = 'Active';
    else if (rawStatus.includes('vacant')) status = 'Vacant';
    const lease: Lease = {
      id,
      propertyKey,
      propertyId: resolvePropertyId(propertyKey, properties),
      tenantName,
      unit,
      company: str(row(ws, r, 4)),
      sf: num(row(ws, r, 5)) ?? 0,
      monthlyRent: monthlyRent ?? 0,
      rentPerSf: num(row(ws, r, 7)),
      leaseStart: isoOrNull(row(ws, r, 8), rowFlags, id, 'leaseStart'),
      leaseEnd,
      escalationDate: isoOrNull(row(ws, r, 10), rowFlags, id, 'escalationDate'),
      escalationPct: num(row(ws, r, 11)),
      status,
      annualRent: annualRent ?? (monthlyRent ?? 0) * 12,
      monthsToExpiry: leaseEnd ? differenceInCalendarMonths(parseISO(leaseEnd), asOf) : null,
      flags: [],
    };
    out.push(lease);
    pendingRowFlags.push({ lease, rowFlags });
  }
  const finalLeases = disambiguateLeaseIds(out, flags);
  // Now that every lease's id is final, re-home each row's locally-collected flags onto the real
  // `flags` array with the corrected (possibly disambiguated) entity -- see the rowFlags comment
  // above. Correlated by object reference (`lease`), not by id string, so it stays correct even
  // when two leases shared the same pre-dedup base id.
  for (const { lease, rowFlags } of pendingRowFlags) {
    for (const f of rowFlags) flags.push({ ...f, entity: lease.id });
  }
  return { leases: finalLeases, workbookRentTotal };
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
/**
 * @param fallbackAsOf Provenance fallback when the sheet carries no parseable "As of" dateline
 *   (the resolved workbook dateline, itself falling back to WORKBOOK_AS_OF — OI-023). The Cash
 *   Balances dateline is data-derived (MAX of the Cash Data date row) and can legitimately sit
 *   earlier than the rent roll's TODAY()-cached stamp, so it is read per-sheet, not shared.
 */
function parseCash(ws: Worksheet, flags: DataQualityFlag[], fallbackAsOf: string) {
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

  const ownAsOf = sheetDataAsOf(ws);
  if (!ownAsOf) {
    flags.push({
      entity: 'cash',
      field: 'asOf',
      issue: `no parseable "As of" dateline on the Cash Balances sheet — provenance falls back to ${fallbackAsOf}`,
      severity: 'warn',
    });
  }

  return {
    asOf: ownAsOf ?? fallbackAsOf,
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
/** @param fallbackAsOf See parseCash — same OI-023 per-sheet dateline convention. */
function parseAssumptions(ws: Worksheet, flags: DataQualityFlag[], fallbackAsOf: string) {
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
  const ownAsOf = sheetDataAsOf(ws);
  if (!ownAsOf) {
    flags.push({
      entity: 'assumptions',
      field: 'asOf',
      issue: `no parseable "As of" dateline on the Assumptions sheet — provenance falls back to ${fallbackAsOf}`,
      severity: 'warn',
    });
  }
  return {
    activeScenario,
    revenueFactor: preset.revenueFactor,
    vacancyFactor: preset.vacancyFactor,
    exitCapFactor: preset.exitCapFactor,
    thresholds: { balloonAlertMonths, concentrationYellow, concentrationRed },
    asOf: ownAsOf ?? fallbackAsOf,
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

  // Provenance "As of" (OI-023): the workbook's own rent-roll dateline is the data date the
  // snapshot advertises (TopBar / module badges / portfolio.json). The June-pinned
  // WORKBOOK_AS_OF constant is only the LOUD fallback — a missing dateline surfaces as a
  // DataQualityFlag, never a silent stale label. monthCol (parseTasks) deliberately stays on
  // WORKBOOK_AS_OF — see the comment above parseLeases.
  const rentRollWs = get('Master Tenant Rent Roll');
  const workbookDataAsOf = sheetDataAsOf(rentRollWs);
  if (!workbookDataAsOf) {
    flags.push({
      entity: 'meta',
      field: 'asOf',
      issue: `no parseable "As of" dateline on the Master Tenant Rent Roll sheet — provenance falls back to WORKBOOK_AS_OF (${WORKBOOK_AS_OF})`,
      severity: 'warn',
    });
  }
  const dataAsOf = workbookDataAsOf ?? WORKBOOK_AS_OF;

  const { properties, workbookNoiTotal, workbookValueTotal } = parseProperties(get('Property NOI'), flags);
  const { leases, workbookRentTotal } = parseLeases(rentRollWs, properties, flags, refIso);
  const loans = parseLoans(get('Loan Index'), flags);
  // OI-092: parseLoans reads only `Loan Index`, so a wrong next-12-month debt-service window in
  // `External Loans Summary` reaches monthlyPmt (and therefore DSCR) with nothing in its path
  // able to see it. This cross-checks that figure against the amortization schedules themselves.
  // warn-severity by ruling — it reports on workbook formulas this pipeline does not own, and a
  // warn-severity advisory check must never be able to take down the whole refresh. Isolated in
  // its own try/catch for exactly that reason — everything else in parseWorkbook still runs even
  // if a future workbook edit produces a shape this check cannot handle.
  try {
    flags.push(...crossCheckDebtService(wb));
  } catch (err) {
    flags.push({
      entity: 'meta',
      field: 'annualDebtService',
      issue: `debt-service cross-check threw and did not complete: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'warn',
    });
  }
  const cash = parseCash(get('Cash Balances'), flags, dataAsOf);
  const insurance = parseInsurance(get('Insurance Renewals'), flags);
  const checklistTasks = parseTasks(get('Monthly Checklist'));
  const m365Tasks = await loadM365Tasks(); // live M365 To-Do prepended when GRAPH_TOKEN set, else []
  const tasks = m365Tasks.length ? [...m365Tasks, ...checklistTasks] : checklistTasks;
  const assumptions = parseAssumptions(get('Assumptions'), flags, dataAsOf);
  const deals = await loadDeals(); // live Notion pipeline merged onto seed when configured, else seed
  const counterparties = deriveCounterparties({ properties, loans, insurance, deals });

  const snapshot = PortfolioSnapshot.parse({
    meta: {
      schemaVersion: SCHEMA_VERSION,
      asOf: dataAsOf,
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
    workbookTotals: { noi: workbookNoiTotal, value: workbookValueTotal, rent: workbookRentTotal },
    dataQuality: flags,
  });

  return { snapshot, flags };
}
