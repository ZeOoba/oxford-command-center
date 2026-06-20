// @vitest-environment node
//
// tests/unit/acq-ingest.test.ts
//
// Phase 4 — Acquisition Intelligence Engine: ingestParcelScreenBatch() unit tests.
// Spec: docs/superpowers/specs/2026-06-20-phase-4-acquisition-intelligence-engine-firm-pri.md §Step 4.
//
// Critical assertions:
//   1. 3 parcels → inserted:3, skipped:0.
//   2. Re-ingest same 3 parcels → inserted:0, skipped:3 (idempotent).
//   3. Candidate IDs follow parcel:<state>:<county-slug>:<apn-slug> format.
//   4. SPINE ISOLATION: after ingest, ledger_entries count MUST be 0 (Spine B untouched).
//
// Uses in-memory SQLite (tmpdir) — never touches data/warehouse/finance.sqlite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestParcelScreenBatch, parcelCandidateId } from '../../server/warehouse/acq-ingest';
import type { ParcelScreenImportRequest } from '@contracts/acquisition';

/** Open a fresh in-memory warehouse (all migrations applied via openWarehouse). */
function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'acq-ingest-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** A minimal 3-parcel import request for Franklin County, OH. */
function franklinBatch(): ParcelScreenImportRequest {
  return {
    batchLabel: 'Franklin County OH — 2026-06-20',
    county: 'Franklin',
    state: 'OH',
    candidates: [
      {
        apn: '010-123456',
        address: '123 Industrial Pkwy, Columbus OH 43085',
        market: 'owned-submarket',
        rentableSf: 24000,
        yearBuilt: 1998,
        ownerName: 'Smith Industrial LLC',
        parcelScreenScore: 78,
      },
      {
        apn: '010-234567',
        address: '456 Commerce Dr, Columbus OH 43204',
        market: 'established',
        rentableSf: 18500,
        yearBuilt: 2003,
        ownerName: 'Jones Properties',
        parcelScreenScore: 62,
      },
      {
        apn: '010-345678',
        address: null,
        market: null,
        rentableSf: null,
        yearBuilt: null,
        ownerName: null,
        parcelScreenScore: null,
      },
    ],
  };
}

describe('ingestParcelScreenBatch — basic insert', () => {
  it('inserts 3 parcels, skips 0 on first import', () => {
    const db = freshDb();
    const result = ingestParcelScreenBatch(db, franklinBatch());

    expect(result.inserted).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('creates exactly 3 acq_candidates rows', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(3);
  });

  it('creates exactly 1 acq_source_batches row', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_source_batches').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('ingestParcelScreenBatch — idempotency', () => {
  it('re-ingesting same 3 parcels → inserted:0, skipped:3', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch()); // first import

    const result = ingestParcelScreenBatch(db, franklinBatch()); // re-import
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it('still exactly 3 rows in acq_candidates after re-import', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());
    ingestParcelScreenBatch(db, franklinBatch());

    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(3);
  });
});

describe('ingestParcelScreenBatch — candidate ID format', () => {
  it('candidate IDs follow parcel:<state-lower>:<county-slug>:<apn-slug> format', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const rows = db.prepare('SELECT id FROM acq_candidates ORDER BY id').all() as { id: string }[];
    expect(rows).toHaveLength(3);

    for (const { id } of rows) {
      expect(id).toMatch(/^parcel:oh:franklin:/);
    }
  });

  it('slugs the APN correctly (hyphens preserved, lowercase)', () => {
    // parcel:oh:franklin:010-123456
    const expected = parcelCandidateId('OH', 'Franklin', '010-123456');
    expect(expected).toBe('parcel:oh:franklin:010-123456');

    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const row = db.prepare("SELECT id FROM acq_candidates WHERE id = ?")
      .get('parcel:oh:franklin:010-123456') as { id: string } | undefined;
    expect(row).toBeDefined();
  });

  it('parcelCandidateId slugs spaces to hyphens and lowercases', () => {
    expect(parcelCandidateId('OH', 'Franklin County', '123 456')).toBe('parcel:oh:franklin-county:123-456');
  });

  it('parcelCandidateId strips special chars (except hyphens)', () => {
    expect(parcelCandidateId('OH', 'Franklin', '010.123/456')).toBe('parcel:oh:franklin:010123456');
  });
});

describe('ingestParcelScreenBatch — SPINE ISOLATION', () => {
  it('CRITICAL: ledger_entries count is 0 after parcel batch ingest (Spine B untouched)', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const count = (db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('import_batches count is 0 after parcel batch ingest (Spine B untouched)', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const count = (db.prepare('SELECT COUNT(*) AS n FROM import_batches').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

describe('ingestParcelScreenBatch — data fidelity', () => {
  it('stores parcel_screen_score, rentable_sf, owner_name correctly', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const row = db.prepare(
      'SELECT parcel_screen_score, rentable_sf, owner_name FROM acq_candidates WHERE id = ?',
    ).get('parcel:oh:franklin:010-123456') as {
      parcel_screen_score: number;
      rentable_sf: number;
      owner_name: string;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.parcel_screen_score).toBe(78);
    expect(row!.rentable_sf).toBe(24000);
    expect(row!.owner_name).toBe('Smith Industrial LLC');
  });

  it('stores NULL fields correctly for incomplete parcel', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const row = db.prepare(
      'SELECT parcel_screen_score, owner_name, rentable_sf FROM acq_candidates WHERE id = ?',
    ).get('parcel:oh:franklin:010-345678') as {
      parcel_screen_score: number | null;
      owner_name: string | null;
      rentable_sf: number | null;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.parcel_screen_score).toBeNull();
    expect(row!.owner_name).toBeNull();
    expect(row!.rentable_sf).toBeNull();
  });

  it('defaults status to active', () => {
    const db = freshDb();
    ingestParcelScreenBatch(db, franklinBatch());

    const rows = db.prepare('SELECT status FROM acq_candidates').all() as { status: string }[];
    for (const { status } of rows) {
      expect(status).toBe('active');
    }
  });

  it('links all candidates to the batch via source_batch_id', () => {
    const db = freshDb();
    const { batchId } = ingestParcelScreenBatch(db, franklinBatch());

    const rows = db.prepare('SELECT source_batch_id FROM acq_candidates').all() as { source_batch_id: string }[];
    for (const { source_batch_id } of rows) {
      expect(source_batch_id).toBe(batchId);
    }
  });
});

describe('parcelCandidateId helper', () => {
  it('produces the expected format', () => {
    expect(parcelCandidateId('OH', 'Franklin', '123-456-789')).toBe('parcel:oh:franklin:123-456-789');
  });

  it('lowercases state and county', () => {
    expect(parcelCandidateId('IN', 'Marion', 'APN-001')).toBe('parcel:in:marion:apn-001');
  });

  it('handles APN with spaces by converting to hyphens', () => {
    expect(parcelCandidateId('OH', 'Hamilton', 'APN 001 002')).toBe('parcel:oh:hamilton:apn-001-002');
  });
});

describe('ingestParcelScreenBatch — cross-state batchId isolation', () => {
  it('OH Franklin and PA Franklin produce distinct batchIds', () => {
    const db = freshDb();

    const paFranklin: ParcelScreenImportRequest = {
      batchLabel: 'Franklin County PA — 2026-06-20',
      county: 'Franklin',
      state: 'PA',
      candidates: [{ apn: 'PA-001', address: null, market: null, rentableSf: null, yearBuilt: null, ownerName: null, parcelScreenScore: null }],
    };

    const { batchId: ohBatchId } = ingestParcelScreenBatch(db, franklinBatch()); // OH
    const { batchId: paBatchId } = ingestParcelScreenBatch(db, paFranklin);       // PA

    expect(ohBatchId).not.toBe(paBatchId);
    expect(ohBatchId).toMatch(/parcel-screen:oh:franklin:/);
    expect(paBatchId).toMatch(/parcel-screen:pa:franklin:/);
  });
});
