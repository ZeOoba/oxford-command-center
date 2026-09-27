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

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strOrBlank = (v: unknown): string => (typeof v === 'string' ? v : '');
const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Validate + map one loss-run fixture row. Returns null if the row is malformed. */
function parseLossEventFixtureRow(raw: unknown): LossEventRow | null {
  if (!isRecord(raw)) return null;
  const { id, propertyId, policyRef, lossDate, cause, grossIncurred, paid, reserve } = raw;
  if (typeof id !== 'string') return null;
  if (typeof propertyId !== 'string') return null;
  if (typeof lossDate !== 'string') return null;
  // Negative gross is nonsensical loss data — skip the row (counted in droppedRows) rather than
  // let it flow into downstream sums, where the loss engine's nonnegative contract would fail-loud.
  if (typeof grossIncurred !== 'number' || grossIncurred < 0) return null;
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
    return {
      rows: rows.map((r) => {
        // Normalize the loosely-typed columns here and nowhere else (see WarehouseLossEventRow).
        // id/propertyId: '' for NULL or non-string (the engine treats '' propertyId as
        // unattributable; '' id is a repeatable display tiebreak). lossDate/source: '' for
        // non-string — calendarYear('') and isoDay('') both read "no date", so the event counts
        // toward gross totals but not observation years, and term narrowing is skipped.
        // policyRef/cause: null for non-string (nothing to match / no cause). gross: a NULL, BLOB, text, NaN or ±Infinity
        // would either string-concatenate or poison every Σ, so it becomes 0 — the event is still
        // COUNTED (eventsN, observation years) but contributes no dollars, the same semantics the
        // NULL → 0 mapping always had. The fixture parser drops such rows instead; the warehouse
        // path reports droppedRows 0 by design, so it degrades to 0 rather than dropping.
        const gross = finiteOrNull(r.gross_incurred);
        return {
          id: strOrBlank(r.id),
          propertyId: strOrBlank(r.property_id),
          policyRef: strOrNull(r.policy_ref),
          lossDate: strOrBlank(r.loss_date),
          cause: strOrNull(r.cause),
          grossIncurred: gross !== null && gross >= 0 ? gross : 0,
          paid: finiteOrNull(r.paid), // read by nothing today; kept type-honest for whoever reads it next
          reserve: finiteOrNull(r.reserve),
          source: strOrBlank(r.source),
        };
      }),
      source: 'warehouse',
      droppedRows: 0,
    };
  }

  const fixture = readFixture('loss-runs.placeholder.json');
  if (!isRecord(fixture) || !Array.isArray(fixture.events)) {
    return { rows: [], source: 'absent', droppedRows: 0 };
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
  return { rows, source: 'placeholder', droppedRows };
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

interface WarehousePolicyRow {
  id: number;
  deductible: number | null;
  coverage_limit: number | null;
}

interface DecPageFixture {
  blanketDeductible: number;
  blanketCoverageLimit: number;
}

function parseDecPageFixture(raw: unknown): DecPageFixture | null {
  if (!isRecord(raw)) return null;
  const { blanketDeductible, blanketCoverageLimit } = raw;
  if (typeof blanketDeductible !== 'number') return null;
  if (typeof blanketCoverageLimit !== 'number') return null;
  return { blanketDeductible, blanketCoverageLimit };
}

export function resolveDecPages(db: WarehouseDb): DecPagesResolved {
  const policyRows = db
    .prepare('SELECT id, deductible, coverage_limit FROM property_insurance_policies')
    .all() as WarehousePolicyRow[];
  const fixture = parseDecPageFixture(readFixture('dec-pages.placeholder.json'));

  const byPolicyId = new Map<string, DecPageEntry>();
  let anyPlaceholder = false;

  for (const row of policyRows) {
    const hasRealValues = row.deductible !== null && row.coverage_limit !== null;
    if (hasRealValues) {
      byPolicyId.set(String(row.id), {
        deductible: row.deductible,
        coverageLimit: row.coverage_limit,
        source: 'warehouse',
      });
      continue;
    }
    if (fixture !== null) {
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
