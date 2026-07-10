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

  it('throws when no file path is given', () => {
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(['--db', '/tmp/x.sqlite'])).toThrow();
  });

  it('throws when --db or --dec-pages is missing its value', () => {
    expect(() => parseArgs(['events.json', '--db'])).toThrow();
    expect(() => parseArgs(['--dec-pages'])).toThrow();
  });
});
