// @vitest-environment node
//
// tests/unit/import-insurance-data.test.ts
//
// The real-data-swap importer for the P4c insurance placeholder buildout. Uses in-memory SQLite
// (tmpdir) with full migrations — never touches the live warehouse. parseLossEventsPayload /
// parseDecPagesPayload are pure (no DB); importLossEventRows / importDecPageRows are tested against
// a fresh warehouse. The single most important test here is the CUTOVER PROOF: after importing loss
// events, resolveLossEvents (the placeholder-data.ts resolver used by the whole insurance-loss
// engine) must report source 'warehouse' — proving the fixture is ignored and the "import once,
// everything flips automatically" promise actually holds.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { resolveLossEvents } from '../../server/warehouse/placeholder-data';
import {
  parseLossEventsPayload,
  importLossEventRows,
  importLossRuns,
  parseDecPagesPayload,
  importDecPageRows,
  importDecPages,
  parsePoliciesPayload,
  importPolicyRows,
  importPolicies,
  parseArgs,
} from '../../scripts/import-insurance-data';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'import-insurance-data-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function insertProperty(db: WarehouseDb, id: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')
  `).run(id, id);
}

function insertPolicy(db: WarehouseDb, propertyId: string): number {
  const result = db.prepare(`
    INSERT INTO property_insurance_policies
      (property_id, insurer, policy_type, source, source_date, ingested_by)
    VALUES (?, 'Test Insurer', 'property', 'test-suite', '2026-01-01', 'test-suite')
  `).run(propertyId);
  return Number(result.lastInsertRowid);
}

// ── parseLossEventsPayload (pure) ────────────────────────────────────────────────────────────

describe('parseLossEventsPayload', () => {
  it('parses valid rows and defaults a missing per-row source to the given default', () => {
    const payload = {
      events: [
        { id: 'EVT-1', propertyId: 'prop-a', policyRef: 'POL-1', lossDate: '2025-01-01', cause: 'fire', grossIncurred: 10000, paid: 9000, reserve: 1000 },
        { id: 'EVT-2', propertyId: 'prop-b', lossDate: '2025-02-01', grossIncurred: 500 },
      ],
    };
    const { rows, rejected } = parseLossEventsPayload(payload, 'events.json');
    expect(rejected).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'EVT-1', propertyId: 'prop-a', policyRef: 'POL-1', cause: 'fire', grossIncurred: 10000, paid: 9000, reserve: 1000, source: 'events.json' });
    expect(rows[1]).toMatchObject({ id: 'EVT-2', propertyId: 'prop-b', policyRef: null, cause: null, paid: null, reserve: null, source: 'events.json' });
  });

  it('prefers a top-level payload.source over the CLI-filename default when present', () => {
    const payload = {
      source: 'broker-loss-run-2026.json',
      events: [{ id: 'EVT-1', propertyId: 'prop-a', lossDate: '2025-01-01', grossIncurred: 1000 }],
    };
    const { rows } = parseLossEventsPayload(payload, 'events.json');
    expect(rows[0]!.source).toBe('broker-loss-run-2026.json');
  });

  it('a per-row source always wins over both the top-level and CLI-filename defaults', () => {
    const payload = {
      source: 'broker-loss-run-2026.json',
      events: [{ id: 'EVT-1', propertyId: 'prop-a', lossDate: '2025-01-01', grossIncurred: 1000, source: 'row-specific-source' }],
    };
    const { rows } = parseLossEventsPayload(payload, 'events.json');
    expect(rows[0]!.source).toBe('row-specific-source');
  });

  it('rejects a row missing a required field (id) and a row with negative grossIncurred, keeping valid rows', () => {
    const payload = {
      events: [
        { id: 'EVT-OK', propertyId: 'prop-a', lossDate: '2025-01-01', cause: 'fire', grossIncurred: 1000 },
        { propertyId: 'prop-a', lossDate: '2025-01-02', cause: 'wind', grossIncurred: 2000 }, // missing id
        { id: 'EVT-NEG', propertyId: 'prop-a', lossDate: '2025-01-03', cause: 'water', grossIncurred: -500 }, // negative
      ],
    };
    const { rows, rejected } = parseLossEventsPayload(payload, 'events.json');
    expect(rows.map((r) => r.id)).toEqual(['EVT-OK']);
    expect(rejected).toHaveLength(2);
    expect(rejected.some((r) => r.reason.match(/"id"/))).toBe(true);
    expect(rejected.some((r) => r.reason.match(/grossIncurred/))).toBe(true);
  });

  it('rejects a payload that is not an object with an events array', () => {
    const { rows, rejected } = parseLossEventsPayload([1, 2, 3], 'events.json');
    expect(rows).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatch(/events/);
  });
});

// ── P4c refute finding 1: loss_date MUST be strict ISO YYYY-MM-DD ──────────────────────────────
// A non-ISO date (US MM/DD/YYYY, or an Excel serial miscoerced to text) silently corrupts EAL:
// calendarYear() in insurance-loss-analysis.ts returns null for MM/DD/YYYY (→ observationYears 0 →
// every EAL null while dollar totals still populate), and matches \d{4} on a serial like "45413"
// (→ a fabricated "year" that inflates observationYears past MIN_LOSS_YEARS and understates EAL).
// The boundary must reject these — a human fixes the source file (no auto-format-detection).
describe('parseLossEventsPayload — loss_date ISO enforcement (P4c refute finding 1)', () => {
  it('rejects a US MM/DD/YYYY lossDate, naming the bad format, keeping nothing', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-US', propertyId: 'prop-a', lossDate: '05/01/2024', grossIncurred: 100000 }] },
      'events.json',
    );
    expect(rows).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.id).toBe('EVT-US');
    expect(rejected[0]!.reason).toMatch(/lossDate/);
    expect(rejected[0]!.reason).toContain('05/01/2024');
  });

  it('rejects an Excel-serial lossDate like "45413" (matches \\d{4}, would fabricate a bogus year)', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-SERIAL', propertyId: 'prop-a', lossDate: '45413', grossIncurred: 100000 }] },
      'events.json',
    );
    expect(rows).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain('45413');
  });

  it('rejects a slash-separated single-digit date while keeping valid ISO rows in the same file', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [
        { id: 'EVT-OK', propertyId: 'prop-a', lossDate: '2024-05-01', grossIncurred: 1000 },
        { id: 'EVT-BAD', propertyId: 'prop-a', lossDate: '5/1/2024', grossIncurred: 2000 },
      ] },
      'events.json',
    );
    expect(rows.map((r) => r.id)).toEqual(['EVT-OK']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.id).toBe('EVT-BAD');
  });

  it('rejects an ISO datetime with a time component (must be date-only YYYY-MM-DD)', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-DT', propertyId: 'prop-a', lossDate: '2024-05-01T00:00:00Z', grossIncurred: 1000 }] },
      'events.json',
    );
    expect(rows).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it('still accepts a well-formed ISO YYYY-MM-DD date', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-OK', propertyId: 'prop-a', lossDate: '2024-05-01', grossIncurred: 1000 }] },
      'events.json',
    );
    expect(rejected).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });
});

// ── P4c refute finding 2: a blank/missing propertyId is a valid portfolio/umbrella loss ────────
// docs/templates/insurance-loss-runs.template.csv documents blank property_id as "a portfolio-level
// or umbrella-policy loss that isn't attributable to a single property". The engine already handles
// these (insurance-loss-analysis.ts: `if (e.propertyId === '') continue;`). The importer must ACCEPT
// them (mapping to ''), not reject them — only a PRESENT, non-blank, unknown property is rejected.
describe('parseLossEventsPayload — blank/missing propertyId = portfolio loss (P4c refute finding 2)', () => {
  it('accepts a MISSING propertyId, mapping it to "" (portfolio/umbrella loss)', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-PORT', lossDate: '2024-05-01', grossIncurred: 50000 }] },
      'events.json',
    );
    expect(rejected).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.propertyId).toBe('');
  });

  it('accepts an explicitly BLANK propertyId, mapping it to ""', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-PORT', propertyId: '', lossDate: '2024-05-01', grossIncurred: 50000 }] },
      'events.json',
    );
    expect(rejected).toHaveLength(0);
    expect(rows[0]!.propertyId).toBe('');
  });

  it('still rejects a PRESENT propertyId of the wrong type (a number, not a portfolio loss)', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-NUM', propertyId: 123, lossDate: '2024-05-01', grossIncurred: 50000 }] },
      'events.json',
    );
    expect(rows).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatch(/propertyId/);
  });
});

// ── importLossEventRows / importLossRuns (DB) ────────────────────────────────────────────────

describe('importLossEventRows / importLossRuns', () => {
  it('lands valid rows into insurance_loss_events', () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    const { rows } = parseLossEventsPayload(
      { events: [{ id: 'EVT-1', propertyId: 'prop-a', lossDate: '2025-01-01', cause: 'fire', grossIncurred: 10000, paid: 9000, reserve: 1000, source: 'test' }] },
      'events.json',
    );
    const { inserted, ignored, rejected } = importLossEventRows(db, rows);
    expect({ inserted, ignored, rejected }).toEqual({ inserted: 1, ignored: 0, rejected: 0 });

    const row = db.prepare('SELECT * FROM insurance_loss_events WHERE id = ?').get('EVT-1') as { property_id: string; gross_incurred: number };
    expect(row.property_id).toBe('prop-a');
    expect(row.gross_incurred).toBe(10000);
  });

  it('skips an unknown property_id and records a data_quality_issues row instead of inserting', () => {
    const db = freshDb();
    // 'prop-a' deliberately NOT seeded into property_master.
    const { rows } = parseLossEventsPayload(
      { events: [{ id: 'EVT-1', propertyId: 'prop-a', lossDate: '2025-01-01', grossIncurred: 1000, source: 'test' }] },
      'events.json',
    );
    const { rejected } = importLossEventRows(db, rows);
    expect(rejected).toBe(1);

    const eventRow = db.prepare('SELECT * FROM insurance_loss_events WHERE id = ?').get('EVT-1');
    expect(eventRow).toBeUndefined();

    const dq = db.prepare(`SELECT property_id FROM data_quality_issues WHERE kind = 'insurance-loss-event-unknown-property'`)
      .get() as { property_id: string };
    expect(dq.property_id).toBe('prop-a');
  });

  // TDD (a) — THE CRITICAL IDEMPOTENCY PROPERTY: a double-run of the same events file must insert
  // once, then insert zero more on the rerun (all reported as `ignored`, not duplicated rows).
  it('idempotency: double-running the same events file inserts once then zero more on rerun', () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    insertProperty(db, 'prop-b');
    const payload = {
      events: [
        { id: 'EVT-1', propertyId: 'prop-a', lossDate: '2025-01-01', cause: 'fire', grossIncurred: 10000, source: 'test' },
        { id: 'EVT-2', propertyId: 'prop-b', lossDate: '2025-02-01', cause: 'water', grossIncurred: 5000, source: 'test' },
      ],
    };

    const first = importLossRuns(db, payload, 'events.json');
    expect(first).toEqual({ inserted: 2, ignored: 0, rejected: 0 });

    const second = importLossRuns(db, payload, 'events.json');
    expect(second).toEqual({ inserted: 0, ignored: 2, rejected: 0 });

    const count = db.prepare('SELECT COUNT(*) AS n FROM insurance_loss_events').get() as { n: number };
    expect(count.n).toBe(2);
  });

  // TDD (b) — a malformed row is rejected and counted; valid rows in the same file still land.
  it('rejects a malformed row (missing id, negative grossIncurred) while still landing valid rows in the same file', () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    const payload = {
      events: [
        { id: 'EVT-OK', propertyId: 'prop-a', lossDate: '2025-01-01', cause: 'fire', grossIncurred: 1000, source: 'test' },
        { propertyId: 'prop-a', lossDate: '2025-01-02', cause: 'wind', grossIncurred: 2000 }, // missing id
        { id: 'EVT-NEG', propertyId: 'prop-a', lossDate: '2025-01-03', cause: 'water', grossIncurred: -500, source: 'test' }, // negative
      ],
    };
    const result = importLossRuns(db, payload, 'events.json');
    expect(result.inserted).toBe(1);
    expect(result.rejected).toBe(2);

    const landed = db.prepare('SELECT id FROM insurance_loss_events').all() as { id: string }[];
    expect(landed.map((r) => r.id)).toEqual(['EVT-OK']);
  });

  // TDD (d) — THE CUTOVER PROOF. The single most important test in this whole plan: after
  // importing loss events into a fresh warehouse (property_master seeded, insurance_loss_events
  // empty beforehand), resolveLossEvents must report source 'warehouse' — proving the fixture is
  // now ignored and the placeholder architecture's "import once, everything flips automatically"
  // promise actually holds.
  it('CUTOVER PROOF: after importing loss events, resolveLossEvents reports source "warehouse" (the fixture is ignored)', () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    insertProperty(db, 'prop-b');

    const preCount = db.prepare('SELECT COUNT(*) AS n FROM insurance_loss_events').get() as { n: number };
    expect(preCount.n).toBe(0);

    const payload = {
      events: [
        { id: 'EVT-1', propertyId: 'prop-a', policyRef: 'POL-1', lossDate: '2025-01-01', cause: 'fire', grossIncurred: 10000, paid: 10000, reserve: 0, source: 'test-broker-loss-run' },
        { id: 'EVT-2', propertyId: 'prop-b', policyRef: 'POL-2', lossDate: '2025-02-01', cause: 'water', grossIncurred: 5000, paid: 4000, reserve: 1000, source: 'test-broker-loss-run' },
      ],
    };
    const importResult = importLossRuns(db, payload, 'test-broker-loss-run.json');
    expect(importResult).toEqual({ inserted: 2, ignored: 0, rejected: 0 });

    const resolved = resolveLossEvents(db);
    expect(resolved.source).toBe('warehouse');
    expect(resolved.droppedRows).toBe(0);
    expect(resolved.rows).toHaveLength(2);
    expect(resolved.rows.map((r) => r.id).sort()).toEqual(['EVT-1', 'EVT-2']);
  });

  // P4c refute finding 1 (DB path): a non-ISO loss_date row is rejected and never lands, while the
  // valid ISO row in the same file still imports.
  it('rejects a non-ISO loss_date row via importLossRuns; it never lands in insurance_loss_events', () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    const result = importLossRuns(db, {
      events: [
        { id: 'EVT-OK', propertyId: 'prop-a', lossDate: '2024-05-01', grossIncurred: 1000, source: 'test' },
        { id: 'EVT-BAD', propertyId: 'prop-a', lossDate: '05/01/2024', grossIncurred: 100000, source: 'test' },
      ],
    }, 'events.json');
    expect(result.inserted).toBe(1);
    expect(result.rejected).toBe(1);

    const landed = db.prepare('SELECT id FROM insurance_loss_events').all() as { id: string }[];
    expect(landed.map((r) => r.id)).toEqual(['EVT-OK']);
  });

  // P4c refute finding 2 (DB path): a blank-propertyId portfolio loss lands with property_id NULL
  // (FK-exempt), is NOT recorded as an unknown-property DQ, and resolveLossEvents coerces it back to
  // '' for the engine's blank-check. A PRESENT-but-unknown propertyId is still DQ-rejected.
  it('imports a blank-propertyId portfolio loss as NULL property_id (not an unknown-property DQ)', () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    const result = importLossRuns(db, {
      events: [
        { id: 'EVT-PROP', propertyId: 'prop-a', lossDate: '2024-01-01', grossIncurred: 1000, source: 'test' },
        { id: 'EVT-PORT', propertyId: '', lossDate: '2024-02-01', grossIncurred: 500000, source: 'test' },
      ],
    }, 'events.json');
    expect(result).toEqual({ inserted: 2, ignored: 0, rejected: 0 });

    const portfolioRow = db.prepare('SELECT property_id FROM insurance_loss_events WHERE id = ?')
      .get('EVT-PORT') as { property_id: string | null };
    expect(portfolioRow.property_id).toBeNull();

    const dq = db.prepare(`SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind = 'insurance-loss-event-unknown-property'`)
      .get() as { n: number };
    expect(dq.n).toBe(0);

    const resolved = resolveLossEvents(db);
    const port = resolved.rows.find((r) => r.id === 'EVT-PORT')!;
    expect(port.propertyId).toBe('');
  });
});

// ── parseDecPagesPayload (pure) ───────────────────────────────────────────────────────────────

describe('parseDecPagesPayload', () => {
  it('parses valid rows, accepting policyId as either a number or a numeric string', () => {
    const { rows, rejected } = parseDecPagesPayload([
      { policyId: 3, deductible: 25000, coverageLimit: 5000000 },
      { policyId: '4', deductible: 10000, coverageLimit: 2000000 },
    ]);
    expect(rejected).toHaveLength(0);
    expect(rows).toEqual([
      { policyId: 3, deductible: 25000, coverageLimit: 5000000 },
      { policyId: 4, deductible: 10000, coverageLimit: 2000000 },
    ]);
  });

  it('rejects a row missing policyId and a row with a negative deductible', () => {
    const { rows, rejected } = parseDecPagesPayload([
      { deductible: 25000, coverageLimit: 5000000 }, // missing policyId
      { policyId: 3, deductible: -1, coverageLimit: 5000000 }, // negative deductible
      { policyId: 5, deductible: 10000, coverageLimit: 2000000 }, // valid
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.policyId).toBe(5);
    expect(rejected).toHaveLength(2);
  });

  it('rejects a non-array payload', () => {
    const { rows, rejected } = parseDecPagesPayload({ not: 'an array' });
    expect(rows).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatch(/array/);
  });
});

// ── P4c refute finding 3: deductible must not exceed coverageLimit ─────────────────────────────
// The engine's per-event split (retained=Σmin(gross,d); transferred=Σmax(0,min(gross,limit)−d);
// overLimit=Σmax(0,gross−limit)) only partitions gross when d ≤ limit. A transposed row with
// deductible > coverageLimit double-counts the (limit, deductible) band into BOTH retained and
// overLimit, so the three buckets no longer sum to gross — silently inflating self-insure exposure.
// Reject at the source (do NOT band-fix in the engine — that masks bad data at the wrong layer).
describe('parseDecPagesPayload — deductible must not exceed coverageLimit (P4c refute finding 3)', () => {
  it('rejects a transposed row where deductible > coverageLimit, naming the fields', () => {
    const { rows, rejected } = parseDecPagesPayload([
      { policyId: 3, deductible: 5000000, coverageLimit: 25000 },
    ]);
    expect(rows).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.id).toBe('3');
    expect(rejected[0]!.reason).toMatch(/deductible/);
  });

  it('accepts deductible == coverageLimit (boundary; the partition still holds)', () => {
    const { rows, rejected } = parseDecPagesPayload([
      { policyId: 3, deductible: 25000, coverageLimit: 25000 },
    ]);
    expect(rejected).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  it('keeps a valid row while rejecting a transposed one in the same batch', () => {
    const { rows, rejected } = parseDecPagesPayload([
      { policyId: 3, deductible: 25000, coverageLimit: 5000000 },
      { policyId: 4, deductible: 5000000, coverageLimit: 25000 },
    ]);
    expect(rows.map((r) => r.policyId)).toEqual([3]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.id).toBe('4');
  });
});

// ── parsePoliciesPayload (pure) ──────────────────────────────────────────────────────────────

describe('parsePoliciesPayload', () => {
  const base = {
    propertyId: 'ins-3540fifth-pckg',
    insurer: 'REDACTED-494',
    policyNumber: 'REDACTED-614',
    effectiveDate: '2024-01-20',
    expirationDate: '2025-01-20',
    premiumAnnual: REDACTED-AMT,
    coverageTiv: REDACTED-AMT,
    policyType: 'Package (PCKG)',
    sourceDate: '2026-08-17',
  };

  it('parses a well-formed policy row', () => {
    const { rows, rejected } = parsePoliciesPayload({ policies: [base] }, 'default-source.json');
    expect(rejected).toEqual([]);
    expect(rows).toEqual([{ ...base, source: 'default-source.json' }]);
  });

  it('uses a per-row source over the top-level default', () => {
    const { rows } = parsePoliciesPayload(
      { policies: [{ ...base, source: 'row-specific.pdf' }] }, 'default-source.json',
    );
    expect(rows[0]!.source).toBe('row-specific.pdf');
  });

  it('rejects a row missing propertyId', () => {
    const { propertyId: _propertyId, ...rest } = base;
    const { rows, rejected } = parsePoliciesPayload({ policies: [rest] }, 'd');
    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ index: 0, id: null, reason: 'missing or invalid "propertyId"' }]);
  });

  it('rejects a non-ISO effectiveDate', () => {
    const { rows, rejected } = parsePoliciesPayload(
      { policies: [{ ...base, effectiveDate: '01/20/2024' }] }, 'd',
    );
    expect(rows).toEqual([]);
    expect(rejected[0]!.reason).toMatch(/effectiveDate must be ISO YYYY-MM-DD/);
  });

  it('rejects a non-ISO expirationDate when present', () => {
    const { rejected } = parsePoliciesPayload({ policies: [{ ...base, expirationDate: '1/20/2025' }] }, 'd');
    expect(rejected[0]!.reason).toMatch(/expirationDate must be ISO YYYY-MM-DD/);
  });

  it('accepts a null expirationDate', () => {
    const { rows, rejected } = parsePoliciesPayload({ policies: [{ ...base, expirationDate: null }] }, 'd');
    expect(rejected).toEqual([]);
    expect(rows[0]!.expirationDate).toBeNull();
  });

  it('rejects a negative premiumAnnual', () => {
    const { rejected } = parsePoliciesPayload({ policies: [{ ...base, premiumAnnual: -1 }] }, 'd');
    expect(rejected[0]!.reason).toMatch(/premiumAnnual must be a nonnegative number/);
  });

  it('accepts a null coverageTiv (bcl/umbrella lines carry no TIV)', () => {
    const { rows, rejected } = parsePoliciesPayload({ policies: [{ ...base, coverageTiv: null }] }, 'd');
    expect(rejected).toEqual([]);
    expect(rows[0]!.coverageTiv).toBeNull();
  });

  it('rejects a negative coverageTiv when present', () => {
    const { rejected } = parsePoliciesPayload({ policies: [{ ...base, coverageTiv: -1 }] }, 'd');
    expect(rejected[0]!.reason).toMatch(/coverageTiv must be a nonnegative number/);
  });

  it('rejects a payload with no "policies" array', () => {
    const { rows, rejected } = parsePoliciesPayload({ notPolicies: [] }, 'd');
    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ index: -1, id: null, reason: 'payload must be an object with a "policies" array' }]);
  });

  // Qodo review finding, PR #287: whitespace-only identifiers passed the old `=== ''` check,
  // which could cause a false "unrecognized line" skip or a duplicate logical key (DB matching is
  // exact-string).
  it('rejects a whitespace-only propertyId', () => {
    const { rows, rejected } = parsePoliciesPayload({ policies: [{ ...base, propertyId: '   ' }] }, 'd');
    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ index: 0, id: null, reason: 'missing or invalid "propertyId"' }]);
  });

  it('rejects a whitespace-only insurer, policyNumber, or policyType', () => {
    expect(parsePoliciesPayload({ policies: [{ ...base, insurer: ' ' }] }, 'd').rejected[0]!.reason)
      .toBe('missing or invalid "insurer"');
    expect(parsePoliciesPayload({ policies: [{ ...base, policyNumber: '\t' }] }, 'd').rejected[0]!.reason)
      .toBe('missing or invalid "policyNumber"');
    expect(parsePoliciesPayload({ policies: [{ ...base, policyType: '  ' }] }, 'd').rejected[0]!.reason)
      .toBe('missing or invalid "policyType"');
  });

  // Qodo review finding, PR #287: sourceDate had no format check at all (only non-empty), unlike
  // effectiveDate/expirationDate — a malformed value would corrupt insurance-analysis.ts's
  // source_date-based current-term ranking (string comparison assumes ISO YYYY-MM-DD).
  it('rejects a non-ISO sourceDate', () => {
    const { rejected } = parsePoliciesPayload({ policies: [{ ...base, sourceDate: '08/17/2026' }] }, 'd');
    expect(rejected[0]!.reason).toMatch(/sourceDate must be ISO YYYY-MM-DD/);
  });
});

// ── importDecPageRows / importDecPages (DB) ──────────────────────────────────────────────────

describe('importDecPageRows / importDecPages', () => {
  // TDD (c) — dec-pages mode updates an existing policy's deductible/coverage_limit.
  it("updates an existing policy's deductible and coverage_limit", () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    const policyId = insertPolicy(db, 'prop-a');

    const result = importDecPages(db, [{ policyId, deductible: 25000, coverageLimit: 5000000 }]);
    expect(result).toEqual({ updated: 1, missing: 0, rejected: 0 });

    const row = db.prepare('SELECT deductible, coverage_limit FROM property_insurance_policies WHERE id = ?')
      .get(policyId) as { deductible: number; coverage_limit: number };
    expect(row.deductible).toBe(25000);
    expect(row.coverage_limit).toBe(5000000);
  });

  // TDD (c) — a missing policy id is counted, not thrown.
  it('counts a missing policy id rather than throwing', () => {
    const db = freshDb();
    const result = importDecPages(db, [{ policyId: 999999, deductible: 10000, coverageLimit: 1000000 }]);
    expect(result).toEqual({ updated: 0, missing: 1, rejected: 0 });

    const dq = db.prepare(`SELECT detail FROM data_quality_issues WHERE kind = 'insurance-dec-page-unknown-policy'`)
      .get() as { detail: string };
    expect(dq.detail).toMatch(/999999/);
  });

  it('handles a mixed batch: one update, one missing, in a single call via importDecPageRows', () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    const policyId = insertPolicy(db, 'prop-a');

    const { updated, missing, rejected } = importDecPageRows(db, [
      { policyId, deductible: 15000, coverageLimit: 3000000 },
      { policyId: 424242, deductible: 5000, coverageLimit: 500000 },
    ]);
    expect({ updated, missing, rejected }).toEqual({ updated: 1, missing: 1, rejected: 0 });
  });

  // P4c refute finding 3 (combined path): a transposed deductible>coverageLimit row is rejected at
  // parse and never written to property_insurance_policies (deductible/coverage_limit stay NULL).
  it('rejects a transposed deductible>coverageLimit row via importDecPages; nothing is written', () => {
    const db = freshDb();
    insertProperty(db, 'prop-a');
    const policyId = insertPolicy(db, 'prop-a');

    const result = importDecPages(db, [{ policyId, deductible: 5000000, coverageLimit: 25000 }]);
    expect(result).toEqual({ updated: 0, missing: 0, rejected: 1 });

    const row = db.prepare('SELECT deductible, coverage_limit FROM property_insurance_policies WHERE id = ?')
      .get(policyId) as { deductible: number | null; coverage_limit: number | null };
    expect(row.deductible).toBeNull();
    expect(row.coverage_limit).toBeNull();
  });
});

// ── importPolicyRows (DB) ───────────────────────────────────────────────────────────────────

describe('importPolicyRows', () => {
  const rowFor = (propertyId: string, overrides: Partial<Parameters<typeof parsePoliciesPayload>[0]> = {}) => ({
    propertyId,
    insurer: 'REDACTED-494',
    policyNumber: 'REDACTED-614',
    effectiveDate: '2024-01-20',
    expirationDate: '2025-01-20',
    premiumAnnual: REDACTED-AMT,
    coverageTiv: REDACTED-AMT,
    policyType: 'Package (PCKG)',
    source: 'test-source.pdf',
    sourceDate: '2026-08-17',
    ...overrides,
  });

  it('inserts a new row for a recognized existing property line', () => {
    const db = freshDb();
    insertPolicy(db, 'ins-3540fifth-pckg'); // establishes the line as "known" (no FK — presence is the signal)

    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-3540fifth-pckg')] }, 'd');
    const result = importPolicyRows(db, rows, 'test-suite');
    expect(result).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 0 });

    const inserted = db.prepare(
      `SELECT premium_annual, coverage_tiv FROM property_insurance_policies
       WHERE property_id = ? AND policy_number = ? AND effective_date = ?`,
    ).get('ins-3540fifth-pckg', 'REDACTED-614', '2024-01-20') as { premium_annual: number; coverage_tiv: number };
    expect(inserted.premium_annual).toBe(REDACTED-AMT);
    expect(inserted.coverage_tiv).toBe(REDACTED-AMT);
  });

  // Undocumented-but-real behavior flagged by the final whole-branch review: two rows sharing the
  // same (property_id, policy_number, effective_date) key WITHIN one batch aren't rejected as
  // duplicates — findExisting re-queries per row inside the transaction, so the first lands as an
  // insert and the second immediately resolves to that just-inserted row's id and updates it.
  // Last-in-batch wins. Pinning this so a future refactor can't silently change it unnoticed.
  it('resolves two same-key rows in one batch as insert-then-update, last one winning', () => {
    const db = freshDb();
    insertPolicy(db, 'ins-3540fifth-pckg');

    const { rows } = parsePoliciesPayload(
      { policies: [rowFor('ins-3540fifth-pckg', { premiumAnnual: 1111 }), rowFor('ins-3540fifth-pckg', { premiumAnnual: 2222 })] },
      'd',
    );
    const result = importPolicyRows(db, rows, 'test-suite');
    expect(result).toEqual({ inserted: 1, updated: 1, unrecognized: 0, rejected: 0 });

    const landed = db.prepare(
      `SELECT premium_annual FROM property_insurance_policies WHERE property_id = ? AND policy_number = ? AND effective_date = ?`,
    ).get('ins-3540fifth-pckg', 'REDACTED-614', '2024-01-20') as { premium_annual: number };
    expect(landed.premium_annual).toBe(2222); // last row in the batch wins, not the first
  });

  it('inserts a new line id when explicitly allowlisted via newLines', () => {
    const db = freshDb();
    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-9620state350-umb')] }, 'd');
    const result = importPolicyRows(db, rows, 'test-suite', ['ins-9620state350-umb']);
    expect(result).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 0 });
  });

  it('records an unrecognized, non-allowlisted propertyId as a data_quality_issues row and skips it', () => {
    const db = freshDb();
    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-typo-pckg')] }, 'd');
    const result = importPolicyRows(db, rows, 'test-suite');
    expect(result).toEqual({ inserted: 0, updated: 0, unrecognized: 1, rejected: 0 });

    const dq = db.prepare(`SELECT detail FROM data_quality_issues WHERE kind = 'insurance-policy-unrecognized-line'`)
      .get() as { detail: string };
    expect(dq.detail).toMatch(/ins-typo-pckg/);

    const written = db.prepare('SELECT COUNT(*) c FROM property_insurance_policies WHERE property_id = ?')
      .get('ins-typo-pckg') as { c: number };
    expect(written.c).toBe(0);
  });

  // The core design decision (spec §5): a re-run for the SAME (property_id, policy_number,
  // effective_date) key must UPDATE the existing row's id, never delete-and-reinsert — otherwise
  // any deductible/coverage_limit already applied by --dec-pages is silently wiped.
  it('updates an existing row on a matching key WITHOUT touching a previously-set deductible', () => {
    const db = freshDb();
    const policyId = insertPolicy(db, 'ins-3540fifth-pckg');
    db.prepare(`
      UPDATE property_insurance_policies
      SET policy_number = 'REDACTED-614', effective_date = '2024-01-20', premium_annual = 1, deductible = 25000, coverage_limit = 5000000
      WHERE id = ?
    `).run(policyId);

    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-3540fifth-pckg')] }, 'd'); // premiumAnnual: REDACTED-AMT
    const result = importPolicyRows(db, rows, 'test-suite');
    expect(result).toEqual({ inserted: 0, updated: 1, unrecognized: 0, rejected: 0 });

    const row = db.prepare('SELECT id, premium_annual, deductible, coverage_limit FROM property_insurance_policies WHERE id = ?')
      .get(policyId) as { id: number; premium_annual: number; deductible: number; coverage_limit: number };
    expect(row.id).toBe(policyId); // same row, not delete-and-reinsert
    expect(row.premium_annual).toBe(REDACTED-AMT); // updated
    expect(row.deductible).toBe(25000); // preserved
    expect(row.coverage_limit).toBe(5000000); // preserved
  });

  it('is idempotent: importing the same file twice reports the second run as all-updated, zero duplicates', () => {
    const db = freshDb();
    insertPolicy(db, 'ins-3540fifth-pckg');
    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-3540fifth-pckg')] }, 'd');

    const first = importPolicyRows(db, rows, 'test-suite');
    expect(first).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 0 });

    const second = importPolicyRows(db, rows, 'test-suite');
    expect(second).toEqual({ inserted: 0, updated: 1, unrecognized: 0, rejected: 0 });

    const count = db.prepare(
      `SELECT COUNT(*) c FROM property_insurance_policies WHERE property_id = ? AND policy_number = ? AND effective_date = ?`,
    ).get('ins-3540fifth-pckg', 'REDACTED-614', '2024-01-20') as { c: number };
    expect(count.c).toBe(1); // the one row this test wrote (fixture row has null policy_number/effective_date and doesn't match this specific key)
  });

  // Qodo review finding, PR #287: an unexpected DB error only went to console.warn, unlike
  // importLossEventRows' insertDqInvalid — this importer runs against a live warehouse, so a
  // silently-dropped row with no persisted trail is a real audit gap. Forces a genuine NOT NULL
  // violation (insurer, migration 008) by constructing a row outside the type system, the same way
  // a caller bypassing parsePoliciesPayload could.
  it('records a data_quality_issues row when a write violates a DB constraint, without blocking other rows', () => {
    const db = freshDb();
    insertPolicy(db, 'ins-3540fifth-pckg');
    insertPolicy(db, 'ins-fvc-pckg');
    const badRow = { ...rowFor('ins-3540fifth-pckg'), insurer: null as unknown as string };
    const goodRow = rowFor('ins-fvc-pckg', { policyNumber: 'REDACTED-613', effectiveDate: '2024-02-03' });

    const result = importPolicyRows(db, [badRow, goodRow], 'test-suite');
    expect(result).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 1 });

    const dq = db.prepare(`SELECT property_id, detail FROM data_quality_issues WHERE kind = 'insurance-policy-check-violation'`)
      .get() as { property_id: string; detail: string };
    expect(dq.property_id).toBe('ins-3540fifth-pckg');
    expect(dq.detail).toMatch(/REDACTED-614/);
    expect(dq.detail).toMatch(/2024-01-20/);

    const goodInserted = db.prepare(
      `SELECT premium_annual FROM property_insurance_policies WHERE property_id = ? AND policy_number = ? AND effective_date = ?`,
    ).get('ins-fvc-pckg', 'REDACTED-613', '2024-02-03') as { premium_annual: number } | undefined;
    expect(goodInserted?.premium_annual).toBe(REDACTED-AMT); // the good row still landed despite the bad row's failure
  });
});

describe('importPolicies', () => {
  const policyRow = {
    propertyId: 'ins-3540fifth-pckg',
    insurer: 'REDACTED-494',
    policyNumber: 'REDACTED-614',
    effectiveDate: '2024-01-20',
    expirationDate: '2025-01-20',
    premiumAnnual: REDACTED-AMT,
    coverageTiv: REDACTED-AMT,
    policyType: 'Package (PCKG)',
    sourceDate: '2026-08-17',
  };

  it('combines parse+import and defaults ingestedBy when the payload omits it', () => {
    const db = freshDb();
    insertPolicy(db, 'ins-3540fifth-pckg');

    const result = importPolicies(db, { policies: [policyRow] }, 'payload-file.json');
    expect(result).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 0 });

    const row = db.prepare(
      `SELECT ingested_by, source FROM property_insurance_policies WHERE property_id = ? AND policy_number = ? AND effective_date = ?`,
    ).get('ins-3540fifth-pckg', 'REDACTED-614', '2024-01-20') as { ingested_by: string; source: string };
    expect(row.ingested_by).toBe('import-insurance-data.ts --policies');
    expect(row.source).toBe('payload-file.json'); // parsePoliciesPayload's own defaultSource fallback
  });

  it('uses a payload-level ingestedBy when present', () => {
    const db = freshDb();
    insertPolicy(db, 'ins-3540fifth-pckg');

    importPolicies(db, { ingestedBy: 'import-insurance-data.ts --policies (Track A, 2026-08-22)', policies: [policyRow] }, 'payload-file.json');

    const row = db.prepare(
      `SELECT ingested_by FROM property_insurance_policies WHERE property_id = ? AND policy_number = ? AND effective_date = ?`,
    ).get('ins-3540fifth-pckg', 'REDACTED-614', '2024-01-20') as { ingested_by: string };
    expect(row.ingested_by).toBe('import-insurance-data.ts --policies (Track A, 2026-08-22)');
  });

  it('reads the payload-level newLines allowlist so an unrecognized propertyId is inserted, not flagged', () => {
    const db = freshDb();
    const result = importPolicies(
      db,
      { newLines: ['ins-9620state350-umb'], policies: [{ ...policyRow, propertyId: 'ins-9620state350-umb' }] },
      'payload-file.json',
    );
    expect(result).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 0 });
  });

  it('sums parse-time rejects and DB-time unrecognized/rejected into the combined result', () => {
    const db = freshDb();
    const { propertyId: _propertyId, ...missingPropertyId } = policyRow;
    const result = importPolicies(
      db,
      { policies: [missingPropertyId, { ...policyRow, propertyId: 'ins-not-a-real-line' }] },
      'payload-file.json',
    );
    // row 1: parse-time reject (missing propertyId); row 2: recognized as unrecognized (no existing line, not allowlisted)
    expect(result).toEqual({ inserted: 0, updated: 0, unrecognized: 1, rejected: 1 });
  });
});

// ── parseArgs (CLI) ───────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses a bare events-file path as loss-events mode with no --db override', () => {
    expect(parseArgs(['events.json'])).toEqual({ mode: 'loss-events', filePath: 'events.json', db: undefined });
  });

  it('parses --db alongside the events path regardless of order', () => {
    expect(parseArgs(['events.json', '--db', '/tmp/x.sqlite'])).toEqual({ mode: 'loss-events', filePath: 'events.json', db: '/tmp/x.sqlite' });
    expect(parseArgs(['--db', '/tmp/x.sqlite', 'events.json'])).toEqual({ mode: 'loss-events', filePath: 'events.json', db: '/tmp/x.sqlite' });
  });

  it('parses --dec-pages as dec-pages mode, with --db in either order', () => {
    expect(parseArgs(['--dec-pages', 'policies.json'])).toEqual({ mode: 'dec-pages', filePath: 'policies.json', db: undefined });
    expect(parseArgs(['--dec-pages', 'policies.json', '--db', '/tmp/x.sqlite'])).toEqual({ mode: 'dec-pages', filePath: 'policies.json', db: '/tmp/x.sqlite' });
    expect(parseArgs(['--db', '/tmp/x.sqlite', '--dec-pages', 'policies.json'])).toEqual({ mode: 'dec-pages', filePath: 'policies.json', db: '/tmp/x.sqlite' });
  });

  it('parses --policies <path> as policies mode', () => {
    const args = parseArgs(['--policies', 'policies.json']);
    expect(args).toEqual({ mode: 'policies', filePath: 'policies.json', db: undefined });
  });

  it('combines --policies with --db', () => {
    const args = parseArgs(['--policies', 'policies.json', '--db', '/tmp/test.sqlite']);
    expect(args).toEqual({ mode: 'policies', filePath: 'policies.json', db: '/tmp/test.sqlite' });
  });

  it('rejects combining --dec-pages and --policies in one invocation', () => {
    expect(() => parseArgs(['--dec-pages', 'dec.json', '--policies', 'policies.json']))
      .toThrow('--dec-pages and --policies are mutually exclusive');
  });

  it('throws when no file path is given', () => {
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(['--db', '/tmp/x.sqlite'])).toThrow();
  });

  it('throws when --db or --dec-pages is missing its value', () => {
    expect(() => parseArgs(['events.json', '--db'])).toThrow();
    expect(() => parseArgs(['--dec-pages'])).toThrow();
  });
});

describe('parseLossEventsPayload — one validity rule shared with the loader (refute wf_0ef2e213-4e2)', () => {
  it.each(['2023-02-29', '2024-13-01', '2024-06-00'])('rejects the regex-valid but impossible calendar date %s (the loader would blank it)', (lossDate) => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-CAL', propertyId: 'prop-a', lossDate, grossIncurred: 1000 }] },
      'test',
    );
    expect(rows).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/lossDate/);
  });

  it('accepts a real leap day', () => {
    const { rows } = parseLossEventsPayload(
      { events: [{ id: 'EVT-LEAP', propertyId: 'prop-a', lossDate: '2024-02-29', grossIncurred: 1000 }] },
      'test',
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a grossIncurred above the loader ceiling (the loader would coerce it to $0)', () => {
    const { rows, rejected } = parseLossEventsPayload(
      { events: [{ id: 'EVT-HUGE', propertyId: 'prop-a', lossDate: '2024-05-01', grossIncurred: 2e12 }] },
      'test',
    );
    expect(rows).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/grossIncurred/);
  });
});

describe('parsePoliciesPayload — policy dates share the loader rule (refute wf_873d0a1e-5a6)', () => {
  const base = {
    propertyId: 'ins-3540fifth-pckg',
    insurer: 'REDACTED-494',
    policyNumber: 'REDACTED-614',
    effectiveDate: '2024-01-20',
    expirationDate: '2025-01-20',
    premiumAnnual: REDACTED-AMT,
    coverageTiv: REDACTED-AMT,
    policyType: 'Package (PCKG)',
    sourceDate: '2026-08-17',
  };

  it.each([
    ['effectiveDate', '2025-02-30'],
    ['expirationDate', '2025-04-31'],
    ['sourceDate', '2025-13-01'],
  ])('rejects a regex-valid but impossible %s %s (loadPolicyTerms would null it and re-attach losses silently)', (field, value) => {
    const { rows, rejected } = parsePoliciesPayload({ policies: [{ ...base, [field]: value }] }, 'd');
    expect(rows).toEqual([]);
    expect(rejected[0]!.reason).toMatch(new RegExp(field));
  });
});
