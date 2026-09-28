// server/warehouse/placeholder-data.ts
//
// Fixture-fallback resolvers for the P4c/C2 placeholder buildout (spec:
// docs/superpowers/specs/2026-07-09-p4c-c2-placeholder-buildout-design.md).
// Placeholder data NEVER enters warehouse tables — it lives in
// server/warehouse/placeholders/*.placeholder.json and is used only when the
// corresponding warehouse source is empty. Cutover to real data is automatic.
// Every resolver is fail-soft: missing/corrupt fixture -> source 'absent',
// empty rows, never a throw. Malformed fixture rows are skipped and counted
// in droppedRows (where the interface exposes one).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WarehouseDb } from './db';

const PLACEHOLDER_DIR = join(dirname(fileURLToPath(import.meta.url)), 'placeholders');

export type DataSource = 'warehouse' | 'placeholder' | 'absent';

/** Read + JSON.parse a placeholder fixture. Missing file or malformed JSON -> null, never throws. */
function readFixture(name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(PLACEHOLDER_DIR, name), 'utf-8'));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function knownPropertyIds(db: WarehouseDb): Set<string> {
  const rows = db.prepare('SELECT id FROM property_master').all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Loss events — resolveLossEvents
// ---------------------------------------------------------------------------

export interface LossEventRow {
  id: string;
  propertyId: string;
  policyRef: string | null;
  lossDate: string;
  cause: string | null;
  grossIncurred: number;
  paid: number | null;
  reserve: number | null;
  source: string;
}

export interface LossEventsResolved {
  rows: LossEventRow[];
  source: DataSource;
  droppedRows: number;
  /** Warehouse rows KEPT but with a value coerced away (a non-ISO loss_date → '', or a present but
   *  non-numeric / non-finite / out-of-range gross_incurred → 0). Always 0 on the fixture path,
   *  which drops malformed rows into droppedRows instead. Surfaced on the report so a coercion is
   *  never silent. */
  coercedRows: number;
}

/** The raw SELECT shape. SQLite column types are affinities, not constraints: `id TEXT PRIMARY KEY`
 *  has no NOT NULL (any number of NULLs), a TEXT column — NOT NULL or not — will store a BLOB or an
 *  integer as-is, and `gross_incurred REAL CHECK (>= 0)` passes a BLOB or text (SQLite orders them
 *  above every number). The importer rejects all of these, so only raw SQL creates them — but the
 *  loader is the SINGLE place that normalizes them, so every downstream reader (engine sorts/sums,
 *  isoDay/calendarYear, the contract's z.string()/z.number()) sees exactly the LossEventRow types.
 *  No column is trusted: every one is `unknown` here. */
interface WarehouseLossEventRow {
  id: unknown;
  property_id: unknown;
  policy_ref: unknown;
  loss_date: unknown;
  cause: unknown;
  gross_incurred: unknown;
  paid: unknown;
  reserve: unknown;
  source: unknown;
}

export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const strOrBlank = (v: unknown): string => (typeof v === 'string' ? v : '');
const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Finite and ≥ 0, else null — a dec-page deductible/limit that is not a usable dollar figure. */
const nonNegFiniteOrNull = (v: unknown): number | null => {
  const n = finiteOrNull(v);
  return n !== null && n >= 0 ? n : null;
};

/** Per-event gross ceiling ($1T). Far above any plausible loss for this book; its only job is to
 *  keep Σ gross finite — two 1e308 rows would sum to Infinity, which JSON serializes as null and
 *  fails the client's parse. A value above it is coerced to 0 and counted like any other. */
export const MAX_LOSS_EVENT_USD = 1e12;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** THE loss-date validity rule: strict ISO YYYY-MM-DD that names a real calendar day. Shared with
 *  scripts/import-insurance-data.ts so the importer and this loader can never disagree on a row
 *  (refute wf_0ef2e213-4e2: a regex-only importer admitted '2023-02-29', which the loader blanked). */
export function isIsoCalendarDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** A loss_date that passes isIsoCalendarDate, else ''. TEXT affinity turns a numeric write into
 *  text ('1717200000.0', '20240601.0'), which a bare string guard admits and calendarYear's
 *  leading-4-digit read would mint as a phantom year ('1717'). */
function isoDateOrBlank(v: unknown): string {
  return typeof v === 'string' && isIsoCalendarDate(v) ? v : '';
}

/** A policy term date whose leading 10 chars pass isIsoCalendarDate (the engine's isoDay reads
 *  exactly those), else null. The same numeric-as-text write would otherwise sort as the "most
 *  recent" effective date ('1717200000' > '2025-…') and appear to cover every loss date. */
export function termDateOrNull(v: unknown): string | null {
  return typeof v === 'string' && isIsoCalendarDate(v.trim().slice(0, 10)) ? v : null;
}

/** Validate + map one loss-run fixture row. Returns null if the row is malformed. */
function parseLossEventFixtureRow(raw: unknown): LossEventRow | null {
  if (!isRecord(raw)) return null;
  const { id, propertyId, policyRef, lossDate, cause, grossIncurred, paid, reserve } = raw;
  if (typeof id !== 'string') return null;
  if (typeof propertyId !== 'string') return null;
  // Same validity rules as the warehouse path and the importer (isIsoCalendarDate, finite gross in
  // [0, MAX_LOSS_EVENT_USD]); the fixture path DROPS a failing row (droppedRows) instead of coercing.
  if (typeof lossDate !== 'string' || !isIsoCalendarDate(lossDate)) return null;
  // Negative gross is nonsensical loss data — skip the row (counted in droppedRows) rather than
  // let it flow into downstream sums, where the loss engine's nonnegative contract would fail-loud.
  if (typeof grossIncurred !== 'number' || !Number.isFinite(grossIncurred) || grossIncurred < 0 || grossIncurred > MAX_LOSS_EVENT_USD) {
    return null;
  }
  return {
    id,
    propertyId,
    policyRef: typeof policyRef === 'string' ? policyRef : null,
    lossDate,
    cause: typeof cause === 'string' ? cause : null,
    grossIncurred,
    paid: typeof paid === 'number' ? paid : null,
    reserve: typeof reserve === 'number' ? reserve : null,
    source: 'loss-runs.placeholder.json',
  };
}

export function resolveLossEvents(db: WarehouseDb): LossEventsResolved {
  const countRow = db.prepare('SELECT count(*) AS c FROM insurance_loss_events').get() as { c: number } | undefined;
  const count = countRow?.c ?? 0;

  if (count > 0) {
    const rows = db
      .prepare(
        `SELECT id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source
         FROM insurance_loss_events ORDER BY loss_date`,
      )
      .all() as WarehouseLossEventRow[];
    let coercedRows = 0;
    const mapped = rows.map((r) => {
        // Normalize the loosely-typed columns here and nowhere else (see WarehouseLossEventRow).
        // id/propertyId/source: '' for NULL or non-string (the engine treats '' propertyId as
        // unattributable; '' id is a repeatable display tiebreak). lossDate: '' unless strict ISO
        // YYYY-MM-DD (isoDateOrBlank) — calendarYear('') and isoDay('') both read "no date", so the
        // event counts toward gross totals but not observation years, and term narrowing is skipped.
        // policyRef/cause: null for non-string (nothing to match / no cause). gross: a BLOB, text,
        // ±Infinity or a value above MAX_LOSS_EVENT_USD would string-concatenate or poison every Σ,
        // so it becomes 0 — the event is still COUNTED (eventsN) but contributes no dollars. NULL
        // → 0 too (migration 022 allows NULL: "not yet valued"). The fixture parser drops malformed
        // rows instead; the warehouse path keeps them, and each row with its date or a PRESENT gross
        // coerced away is counted ONCE in coercedRows (a NULL gross is not a coercion).
        const gross = finiteOrNull(r.gross_incurred);
        const grossOk = gross !== null && gross >= 0 && gross <= MAX_LOSS_EVENT_USD;
        const lossDate = isoDateOrBlank(r.loss_date);
        if (lossDate === '' || (r.gross_incurred !== null && !grossOk)) coercedRows += 1;
        return {
          id: strOrBlank(r.id),
          propertyId: strOrBlank(r.property_id),
          policyRef: strOrNull(r.policy_ref),
          lossDate,
          cause: strOrNull(r.cause),
          grossIncurred: grossOk ? gross : 0,
          paid: finiteOrNull(r.paid), // read by nothing today; kept type-honest for whoever reads it next
          reserve: finiteOrNull(r.reserve),
          source: strOrBlank(r.source),
        };
      });
    return { rows: mapped, source: 'warehouse', droppedRows: 0, coercedRows };
  }

  const fixture = readFixture('loss-runs.placeholder.json');
  if (!isRecord(fixture) || !Array.isArray(fixture.events)) {
    return { rows: [], source: 'absent', droppedRows: 0, coercedRows: 0 };
  }

  const known = knownPropertyIds(db);
  let droppedRows = 0;
  const rows: LossEventRow[] = [];
  for (const raw of fixture.events) {
    const parsed = parseLossEventFixtureRow(raw);
    if (parsed === null || !known.has(parsed.propertyId)) {
      droppedRows += 1;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, source: 'placeholder', droppedRows, coercedRows: 0 };
}

// ---------------------------------------------------------------------------
// Dec pages — resolveDecPages
// ---------------------------------------------------------------------------

export interface DecPageEntry {
  deductible: number | null;
  coverageLimit: number | null;
  source: DataSource;
}

export interface DecPagesResolved {
  byPolicyId: ReadonlyMap<string, DecPageEntry>;
  anyPlaceholder: boolean;
}

/** `id` is INTEGER PRIMARY KEY (the rowid — always an integer). deductible/coverage_limit are REAL
 *  affinity with no CHECK: raw SQL can store a BLOB, non-numeric text, ±Infinity or a negative,
 *  which would string-concatenate or NaN the engine's retained/transferred sums. Normalized in
 *  resolveDecPages to finite ≥ 0 or null — and null is exactly "no dec data" (a NULL column's path). */
interface WarehousePolicyRow {
  id: number;
  deductible: unknown;
  coverage_limit: unknown;
}

interface DecPageFixture {
  blanketDeductible: number;
  blanketCoverageLimit: number;
}

function parseDecPageFixture(raw: unknown): DecPageFixture | null {
  if (!isRecord(raw)) return null;
  const { blanketDeductible, blanketCoverageLimit } = raw;
  // Same rule as the warehouse rows: finite ≥ 0 and deductible ≤ limit, else the fixture is unusable.
  const d = nonNegFiniteOrNull(blanketDeductible);
  const limit = nonNegFiniteOrNull(blanketCoverageLimit);
  if (d === null || limit === null || d > limit) return null;
  return { blanketDeductible: d, blanketCoverageLimit: limit };
}

export function resolveDecPages(db: WarehouseDb): DecPagesResolved {
  const policyRows = db
    .prepare('SELECT id, deductible, coverage_limit FROM property_insurance_policies')
    .all() as WarehousePolicyRow[];
  const fixture = parseDecPageFixture(readFixture('dec-pages.placeholder.json'));

  const byPolicyId = new Map<string, DecPageEntry>();
  let anyPlaceholder = false;

  for (const row of policyRows) {
    const deductible = nonNegFiniteOrNull(row.deductible);
    const coverageLimit = nonNegFiniteOrNull(row.coverage_limit);
    // deductible > limit is the importer's rejected shape (P4c refute finding 3): the engine's
    // retained/transferred/overLimit only partition gross when d ≤ limit, else they double-count
    // the (limit, d] band (refute wf_0f4094ef-6a0).
    if (deductible !== null && coverageLimit !== null && deductible <= coverageLimit) {
      byPolicyId.set(String(row.id), {
        deductible,
        coverageLimit,
        source: 'warehouse',
      });
      continue;
    }
    // A value that is PRESENT but unusable (non-numeric, non-finite, negative, or d > limit) is real
    // captured data that failed validation — not "pending dec pages". Substituting the placeholder
    // blanket would silently replace it and mis-banner it (refute wf_bb6c1332-b90), so it reads
    // absent (the engine books absent dec data as fully transferred). Only NULL columns — dec data
    // genuinely not yet captured — fall back to the fixture. The workbook writer now drops d > limit
    // with a DataQualityFlag at capture (decPairOrFlag in server/workbook/parse.ts).
    // (A valid value beside a NULL — partial dec data — still falls back exactly as before.)
    const presentButUnusable =
      (row.deductible !== null && deductible === null) ||
      (row.coverage_limit !== null && coverageLimit === null) ||
      (deductible !== null && coverageLimit !== null); // both valid yet reached here ⇒ d > limit
    if (fixture !== null && !presentButUnusable) {
      byPolicyId.set(String(row.id), {
        deductible: fixture.blanketDeductible,
        coverageLimit: fixture.blanketCoverageLimit,
        source: 'placeholder',
      });
      anyPlaceholder = true;
      continue;
    }
    byPolicyId.set(String(row.id), { deductible: null, coverageLimit: null, source: 'absent' });
  }

  return { byPolicyId, anyPlaceholder };
}

// ---------------------------------------------------------------------------
// Depreciable basis — resolveDepreciableBasis (fixture-only in v1)
// ---------------------------------------------------------------------------

export interface BasisRow {
  propertyId: string;
  depreciableBasis: number;
  landAllocationPct: number;
  placedInServiceYear: number;
  reclassifiablePct: number;
}

export interface BasisResolved {
  rows: BasisRow[];
  source: DataSource;
  bonusPctByYear: Record<string, number>;
  scheduleNote: string;
  droppedRows: number;
}

function parseBasisFixtureRow(raw: unknown): BasisRow | null {
  if (!isRecord(raw)) return null;
  const { propertyId, depreciableBasis, landAllocationPct, placedInServiceYear, reclassifiablePct } = raw;
  if (typeof propertyId !== 'string') return null;
  if (typeof depreciableBasis !== 'number') return null;
  if (typeof landAllocationPct !== 'number') return null;
  if (typeof placedInServiceYear !== 'number') return null;
  if (typeof reclassifiablePct !== 'number') return null;
  return { propertyId, depreciableBasis, landAllocationPct, placedInServiceYear, reclassifiablePct };
}

function parseBonusPctByYear(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const [year, pct] of Object.entries(raw)) {
    if (typeof pct === 'number') out[year] = pct;
  }
  return out;
}

export function resolveDepreciableBasis(db: WarehouseDb): BasisResolved {
  const fixture = readFixture('depreciable-basis.placeholder.json');
  if (!isRecord(fixture) || !Array.isArray(fixture.rows)) {
    return { rows: [], source: 'absent', bonusPctByYear: {}, scheduleNote: '', droppedRows: 0 };
  }

  const bonusPctByYear = parseBonusPctByYear(fixture.bonusPctByYear);
  const scheduleNote = typeof fixture.scheduleNote === 'string' ? fixture.scheduleNote : '';

  const known = knownPropertyIds(db);
  let droppedRows = 0;
  const rows: BasisRow[] = [];
  for (const raw of fixture.rows) {
    const parsed = parseBasisFixtureRow(raw);
    if (parsed === null || !known.has(parsed.propertyId)) {
      droppedRows += 1;
      continue;
    }
    rows.push(parsed);
  }

  return { rows, source: 'placeholder', bonusPctByYear, scheduleNote, droppedRows };
}

// ---------------------------------------------------------------------------
// Filed returns — resolveFiledReturns (fixture-only, metadata only, no db)
// ---------------------------------------------------------------------------

export interface FiledReturnRow {
  id: string;
  taxYear: number;
  entity: string;
  preparer: string | null;
  status: 'filed' | 'extended' | 'amended';
  storageNote: string;
}

const FILED_RETURN_STATUSES = new Set(['filed', 'extended', 'amended']);

function parseFiledReturnRow(raw: unknown): FiledReturnRow | null {
  if (!isRecord(raw)) return null;
  const { id, taxYear, entity, preparer, status, storageNote } = raw;
  if (typeof id !== 'string') return null;
  if (typeof taxYear !== 'number') return null;
  if (typeof entity !== 'string') return null;
  if (typeof status !== 'string' || !FILED_RETURN_STATUSES.has(status)) return null;
  if (typeof storageNote !== 'string') return null;
  return {
    id,
    taxYear,
    entity,
    preparer: typeof preparer === 'string' ? preparer : null,
    status: status as FiledReturnRow['status'],
    storageNote,
  };
}

export function resolveFiledReturns(): { rows: FiledReturnRow[]; source: DataSource } {
  const fixture = readFixture('filed-returns.placeholder.json');
  if (!isRecord(fixture) || !Array.isArray(fixture.rows)) {
    return { rows: [], source: 'absent' };
  }

  const rows: FiledReturnRow[] = [];
  for (const raw of fixture.rows) {
    const parsed = parseFiledReturnRow(raw);
    if (parsed !== null) rows.push(parsed);
  }

  return { rows, source: 'placeholder' };
}
