// @vitest-environment node
//
// 2026-09-14 weekly financial-code sweep, Fix B: the Format B (unit-only) review-queue write path.
// Two real defects, both visible in the committed data on 2026-09-14:
//
//   1. DUPLICATE: data/ar/review-queue.json held one row -- "C 4 (storage)", $0.38, Northwood,
//      sourceFile "2203-2207 Northwood Delinquency 8.21.2026.xlsx" -- while portfolio.json's
//      arBalances ALREADY carried that same source row, attributed to 2207-northwood-c4-anibal-
//      morales: same sourceFile, same as-of (2026-08-21), same $0.38. The queue's dedup key
//      (`tenant::sourceFile::reason`) uses the RAW unit label, so the annotated "C 4 (storage)"
//      and the roster's "C4" never matched. Before queuing, a Format B row is now keyed by
//      (sourceFile, as-of date, CANONICAL unit tokens, amount) -- reusing resolve-by-unit.ts's
//      expandUnitTokens, which already strips the '(storage)' annotation -- and skipped when this
//      run already attributed the same source row, or the queue already holds it.
//
//   2. UNREACHABLE SKIP: data/ar-mapping-cache.json holds "anibal morales": "SKIP" -- a durable
//      human ruling keyed by tenant name (mapping-cache.ts cacheKey) -- but a Format B queue row
//      carries NO tenant name, so nothing could ever consult that ruling against it. The queued
//      row now names who the roster puts at that unit (any status), and shows the cache's ruling
//      for that name, DISPLAY ONLY: the SKIP is never auto-applied to a unit-based row, because
//      that would resurrect a name-based human decision onto a row with different provenance.
//
// The helpers under test are exported from scripts/ar-import-headless.ts, whose argv[1] entry
// guard makes it safe to import (tests/unit/ar-import-headless-lease-status.test.ts already does).
import { describe, it, expect } from 'vitest';
import {
  buildBucketedReviewRow,
  dedupReviewsAgainstQueue,
  dropReviewsAlreadyAttributed,
  sourceRowKey,
  type QueuedReview,
} from '../../scripts/ar-import-headless';
import { resolveByUnit, type UnitLease } from '../../server/ar/resolve-by-unit';
import type { BucketedUnitRow } from '../../server/ar/delinquency-bucketed';

const NORTHWOOD = '2203-2207-northwood-dr-salisbury-md';
const NBC_C = 'nbc-c - 2203 Marvel Road Salisbury, MD 21801';
const SOURCE_FILE = '2203-2207 Northwood Delinquency 8.21.2026.xlsx';
const AS_OF = new Date('2026-08-21T00:00:00.000Z');
const NOW = '2026-09-02T10:43:09.439Z';

// Shaped like the real roster record (portfolio.json leases[]): Expired since 2024-09-01.
const MORALES: UnitLease = {
  id: '2207-northwood-c4-anibal-morales',
  unit: 'C4',
  propertyId: NORTHWOOD,
  status: 'Expired',
  annualRent: 4788,
  tenantName: 'Anibal Morales',
};
const ROSTER: UnitLease[] = [
  MORALES,
  { id: '2207-northwood-a4-sky-shield', unit: 'A4', propertyId: NORTHWOOD, status: 'Active', annualRent: 13992, tenantName: 'Brett Lagana' },
];

// The real Format B source row, as the export prints it.
const STORAGE_ROW: BucketedUnitRow = { unit: 'C 4 (storage)', property: NBC_C, d30: 0.38, d30plus: 0 };

function buildStorageRow(cacheEntries: Record<string, string> = {}): QueuedReview {
  return buildBucketedReviewRow({
    row: STORAGE_ROW,
    res: resolveByUnit(STORAGE_ROW, ROSTER, NORTHWOOD),
    propertyId: NORTHWOOD,
    unitLeases: ROSTER,
    cacheEntries,
    sourceFile: SOURCE_FILE,
    asOfDate: AS_OF,
    queuedAt: NOW,
  });
}

describe('sourceRowKey -- identity of ONE real-world source row across the two parse shapes', () => {
  it('keys the annotated "C 4 (storage)" and the plain "C4" to the SAME source row', () => {
    expect(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C 4 (storage)', 0.38)).toBe(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C4', 0.38));
  });

  it('accepts the as-of date as a Date, an ISO string, or a bare YYYY-MM-DD (persisted vs in-run shapes)', () => {
    const fromDate = sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C4', 0.38);
    expect(sourceRowKey(SOURCE_FILE, '2026-08-21T00:00:00.000Z', NORTHWOOD, 'C4', 0.38)).toBe(fromDate);
    expect(sourceRowKey(SOURCE_FILE, '2026-08-21', NORTHWOOD, 'C4', 0.38)).toBe(fromDate);
  });

  it('a different amount, file, date, property, or unit is a DIFFERENT source row', () => {
    const base = sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C4', 0.38);
    expect(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C4', 0.39)).not.toBe(base);
    expect(sourceRowKey('2203-2207 Northwood Delinquency 8.28.2026.xlsx', AS_OF, NORTHWOOD, 'C4', 0.38)).not.toBe(base);
    expect(sourceRowKey(SOURCE_FILE, new Date('2026-08-28T00:00:00.000Z'), NORTHWOOD, 'C4', 0.38)).not.toBe(base);
    expect(sourceRowKey(SOURCE_FILE, AS_OF, 'some-other-property', 'C4', 0.38)).not.toBe(base);
    expect(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C5', 0.38)).not.toBe(base);
  });

  it('rounds the amount to the cent so float-order noise cannot split one row into two', () => {
    expect(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C4', 0.1 + 0.2)).toBe(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C4', 0.3));
  });

  it('an undated row still keys (as "undated") -- but never matches a dated one', () => {
    expect(sourceRowKey(SOURCE_FILE, null, NORTHWOOD, 'C4', 0.38)).not.toBeNull();
    expect(sourceRowKey(SOURCE_FILE, null, NORTHWOOD, 'C4', 0.38)).not.toBe(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, 'C4', 0.38));
  });

  it('returns null when there is no unit identity to key on (missing, blank, or annotation-only label)', () => {
    expect(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, null, 0.38)).toBeNull();
    expect(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, undefined, 0.38)).toBeNull();
    expect(sourceRowKey(SOURCE_FILE, AS_OF, NORTHWOOD, '(storage)', 0.38)).toBeNull();
  });

  it('returns null for an unresolved property (refute 2026-09-22): no write ever carries one, so such a row can never be proven a duplicate', () => {
    expect(sourceRowKey(SOURCE_FILE, AS_OF, null, 'C4', 0.38)).toBeNull();
    expect(sourceRowKey(SOURCE_FILE, AS_OF, undefined, 'C4', 0.38)).toBeNull();
  });
});

describe('buildBucketedReviewRow -- a Format B review row carries its source-row identity and the roster candidate', () => {
  it('the real "C 4 (storage)" row: still queued at none confidence (Expired-only unit), never auto-attributed', () => {
    const r = buildStorageRow({ 'anibal morales': 'SKIP' });
    expect(r).toMatchObject({
      tenant: `${NBC_C} / C 4 (storage)`,
      property: NBC_C,
      d30: 0.38,
      d60: 0,
      d90: 0,
      d90plus: 0,
      proposedLeaseId: null,
      proposedCandidate: null,
      confidence: 'none',
      ambiguous: false,
      sourceFile: SOURCE_FILE,
      queuedAt: NOW,
    });
    expect(r.reason).toMatch(/no exact match at this property/);
  });

  it('carries the raw unit label, the as-of date, and the resolved property id so the queue can be keyed by source row', () => {
    const r = buildStorageRow();
    expect(r.unit).toBe('C 4 (storage)');
    expect(r.asOfDate).toBe('2026-08-21T00:00:00.000Z');
    expect(r.propertyId).toBe(NORTHWOOD);
  });

  it('names who the roster puts at that unit -- including a DEAD lease -- so a human can see who it probably is', () => {
    const r = buildStorageRow();
    expect(r.candidateTenant).toBe('Anibal Morales [Expired]');
    expect(r.candidateLeaseIds).toEqual(['2207-northwood-c4-anibal-morales']);
  });

  it('surfaces the mapping cache\'s ruling for that candidate name (the real "anibal morales": "SKIP") -- display only', () => {
    const r = buildStorageRow({ 'anibal morales': 'SKIP' });
    expect(r.candidateCacheRuling).toBe('anibal morales → SKIP');
    // NOT auto-applied: the row is still a queued review at none confidence with no proposal.
    expect(r.proposedLeaseId).toBeNull();
    expect(r.confidence).toBe('none');
  });

  it('shows a confirmed-mapping ruling too, and null when the cache has no entry for the candidate', () => {
    expect(buildStorageRow({ 'anibal morales': '2207-northwood-c4-anibal-morales' }).candidateCacheRuling).toBe(
      'anibal morales → 2207-northwood-c4-anibal-morales',
    );
    expect(buildStorageRow({}).candidateCacheRuling).toBeNull();
  });

  it('ignores inherited Object.prototype members when consulting the cache (same hygiene as partitionArRows)', () => {
    const roster: UnitLease[] = [{ id: 'L-X', unit: 'C4', propertyId: NORTHWOOD, status: 'Expired', tenantName: 'Constructor' }];
    const r = buildBucketedReviewRow({
      row: STORAGE_ROW,
      res: resolveByUnit(STORAGE_ROW, roster, NORTHWOOD),
      propertyId: NORTHWOOD,
      unitLeases: roster,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(r.candidateCacheRuling).toBeNull();
  });

  it('no lease at the unit -> null candidate fields, unchanged reason', () => {
    const row: BucketedUnitRow = { unit: 'C 9 (storage)', property: NBC_C, d30: 1, d30plus: 0 };
    const r = buildBucketedReviewRow({
      row,
      res: resolveByUnit(row, ROSTER, NORTHWOOD),
      propertyId: NORTHWOOD,
      unitLeases: ROSTER,
      cacheEntries: { 'anibal morales': 'SKIP' },
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(r.candidateTenant).toBeNull();
    expect(r.candidateLeaseIds).toEqual([]);
    expect(r.candidateCacheRuling).toBeNull();
    expect(r.reason).toMatch(/no exact match at this property/);
  });

  it('unresolved property header -> the existing "add it to BUCKETED_PROPERTY_HEADERS" reason, no candidates (never guesses across the portfolio)', () => {
    const row: BucketedUnitRow = { unit: 'C4', property: 'nbc-z - Unknown Building', d30: 1, d30plus: 0 };
    const r = buildBucketedReviewRow({
      row,
      res: resolveByUnit(row, ROSTER, null),
      propertyId: null,
      unitLeases: ROSTER,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(r.reason).toMatch(/BUCKETED_PROPERTY_HEADERS/);
    expect(r.candidateTenant).toBeNull();
    expect(r.candidateLeaseIds).toEqual([]);
  });

  it('a re-let unit (dead + live sibling) names BOTH candidates with their status, and keeps the ambiguous reason', () => {
    const roster: UnitLease[] = [
      MORALES,
      { id: 'new-tenant-c4', unit: 'C4', propertyId: NORTHWOOD, status: 'Active', annualRent: 9000, tenantName: 'New Tenant LLC' },
    ];
    const r = buildBucketedReviewRow({
      row: STORAGE_ROW,
      res: resolveByUnit(STORAGE_ROW, roster, NORTHWOOD),
      propertyId: NORTHWOOD,
      unitLeases: roster,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(r.ambiguous).toBe(true);
    expect(r.reason).toMatch(/more than one lease/);
    expect(r.candidateTenant).toBe('Anibal Morales [Expired] | New Tenant LLC [Active]');
    expect(r.candidateLeaseIds).toEqual(['2207-northwood-c4-anibal-morales', 'new-tenant-c4']);
  });
});

describe('dropReviewsAlreadyAttributed -- a source row attributed THIS RUN is not also queued', () => {
  const attributedWrite = {
    leaseId: '2207-northwood-c4-anibal-morales',
    arrears: { d30: 0.38, d60: 0, d90: 0, d90plus: 0, asOfDate: AS_OF, sourceFile: SOURCE_FILE },
    tenant: 'Anibal Morales',
  };

  it('drops the "C 4 (storage)" review row when the same file/as-of/unit/amount was attributed to the C4 lease this run', () => {
    const review = buildStorageRow();
    const { kept, dropped } = dropReviewsAlreadyAttributed([review], [attributedWrite], ROSTER);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([review]);
  });

  it('keeps it when the amount differs (a different source row, not a re-parse of the same one)', () => {
    const review = buildStorageRow();
    const other = { ...attributedWrite, arrears: { ...attributedWrite.arrears, d30: 12.5 } };
    expect(dropReviewsAlreadyAttributed([review], [other], ROSTER).kept).toEqual([review]);
  });

  it('keeps it when the source file or as-of date differs', () => {
    const review = buildStorageRow();
    const otherFile = { ...attributedWrite, arrears: { ...attributedWrite.arrears, sourceFile: 'Sepich Portfolio Delinquency 8.21.2026.xlsx' } };
    const otherDate = { ...attributedWrite, arrears: { ...attributedWrite.arrears, asOfDate: new Date('2026-08-28T00:00:00.000Z') } };
    expect(dropReviewsAlreadyAttributed([review], [otherFile], ROSTER).kept).toEqual([review]);
    expect(dropReviewsAlreadyAttributed([review], [otherDate], ROSTER).kept).toEqual([review]);
  });

  it('keeps it when the attributed lease sits on a DIFFERENT unit (same money elsewhere is not this row)', () => {
    const review = buildStorageRow();
    const a4 = { ...attributedWrite, leaseId: '2207-northwood-a4-sky-shield' };
    expect(dropReviewsAlreadyAttributed([review], [a4], ROSTER).kept).toEqual([review]);
  });

  it('matches the write\'s amount on the SUM of its buckets against the Format B row\'s d30 + d30plus', () => {
    const row: BucketedUnitRow = { unit: 'C 4 (storage)', property: NBC_C, d30: 10, d30plus: 5.5 };
    const review = buildBucketedReviewRow({
      row,
      res: resolveByUnit(row, ROSTER, NORTHWOOD),
      propertyId: NORTHWOOD,
      unitLeases: ROSTER,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    const split = { ...attributedWrite, arrears: { ...attributedWrite.arrears, d30: 10, d60: 0, d90: 2.5, d90plus: 3 } };
    expect(dropReviewsAlreadyAttributed([review], [split], ROSTER).dropped).toEqual([review]);
  });

  it('leaves name-matched review rows (no unit / as-of identity) untouched', () => {
    const nameRow: QueuedReview = {
      tenant: 'Zzz Nomatch Corp',
      property: null,
      d30: 0.38,
      d60: 0,
      d90: 0,
      d90plus: 0,
      proposedLeaseId: null,
      proposedCandidate: null,
      confidence: 'none',
      ambiguous: false,
      reason: 'no match — human must map',
      sourceFile: SOURCE_FILE,
      queuedAt: NOW,
    };
    expect(dropReviewsAlreadyAttributed([nameRow], [attributedWrite], ROSTER).kept).toEqual([nameRow]);
  });

  it('a write to a lease the roster cannot place on a unit never matches anything', () => {
    const review = buildStorageRow();
    const ghost = { ...attributedWrite, leaseId: 'lease-not-in-roster' };
    expect(dropReviewsAlreadyAttributed([review], [ghost], ROSTER).kept).toEqual([review]);
  });

  it('refute 2026-09-22: an UNMAPPED-property row is never dropped by a mapped-property write that coincides on file / as-of / unit tokens / cents', () => {
    // A Format B export lists several buildings. A fourth header not yet in BUCKETED_PROPERTY_HEADERS
    // must surface as a review row carrying the "add it to the table" reason; a recurring
    // finance-charge amount ($0.38) on the same unit label at a mapped building in the same file
    // must not make it vanish. Before the property joined the key, this row was silently dropped.
    const live: UnitLease = { id: 'nw-c4-live', unit: 'C4', propertyId: NORTHWOOD, status: 'Active', annualRent: 9000, tenantName: 'Live C4 LLC' };
    const roster: UnitLease[] = [live];
    const unmapped: BucketedUnitRow = { unit: 'C 4', property: 'nbc-d - 9999 Unknown Building', d30: 0.38, d30plus: 0 };
    const review = buildBucketedReviewRow({
      row: unmapped,
      res: resolveByUnit(unmapped, roster, null),
      propertyId: null,
      unitLeases: roster,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(review.reason).toMatch(/BUCKETED_PROPERTY_HEADERS/);
    const write = { ...attributedWrite, leaseId: 'nw-c4-live' };
    const { kept, dropped } = dropReviewsAlreadyAttributed([review], [write], roster);
    expect(kept).toEqual([review]);
    expect(dropped).toEqual([]);
  });

  it('refute 2026-09-22: a write at a DIFFERENT property with the same unit label and cents is not this row either', () => {
    const elsewhere: UnitLease = { id: 'other-c4', unit: 'C4', propertyId: 'some-other-property', status: 'Active', annualRent: 9000, tenantName: 'Other C4' };
    const review = buildStorageRow();
    const write = { ...attributedWrite, leaseId: 'other-c4' };
    expect(dropReviewsAlreadyAttributed([review], [write], [...ROSTER, elsewhere]).kept).toEqual([review]);
  });
});

describe('dedupReviewsAgainstQueue -- the pre-existing queue is checked by source-row identity too', () => {
  // The exact row sitting in data/ar/review-queue.json on 2026-09-14 (pre-Fix-B schema: no unit /
  // asOfDate / candidate fields).
  const LEGACY_QUEUED: QueuedReview = {
    tenant: `${NBC_C} / C 4 (storage)`,
    property: NBC_C,
    d30: 0.38,
    d60: 0,
    d90: 0,
    d90plus: 0,
    proposedLeaseId: null,
    proposedCandidate: null,
    confidence: 'none',
    ambiguous: false,
    reason: "unit 'C 4 (storage)' has no exact match at this property (may be part of a larger merged lease — never auto-attributed on a partial overlap)",
    sourceFile: SOURCE_FILE,
    queuedAt: NOW,
  };

  it('legacy key (tenant::sourceFile::reason) still dedups an identical re-queue of the old-schema row -- unchanged', () => {
    expect(dedupReviewsAgainstQueue([LEGACY_QUEUED], [buildStorageRow()])).toEqual([]);
  });

  it('a queued new-schema "C 4 (storage)" row dedups a later "C4" row with a different label and reason (same source row)', () => {
    const queued = buildStorageRow();
    const plainRow: BucketedUnitRow = { unit: 'C4', property: NBC_C, d30: 0.38, d30plus: 0 };
    const roster: UnitLease[] = [MORALES, { id: 'new-tenant-c4', unit: 'C4', propertyId: NORTHWOOD, status: 'Active', annualRent: 9000, tenantName: 'New Tenant LLC' }];
    const incoming = buildBucketedReviewRow({
      row: plainRow,
      res: resolveByUnit(plainRow, roster, NORTHWOOD), // ambiguous now -> a DIFFERENT reason text
      propertyId: NORTHWOOD,
      unitLeases: roster,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: '2026-09-09T10:00:00.000Z',
    });
    expect(incoming.reason).not.toBe(queued.reason);
    expect(dedupReviewsAgainstQueue([queued], [incoming])).toEqual([]);
  });

  it('does NOT dedup by source row against a legacy row that carries no unit/as-of identity when the label differs', () => {
    // It cannot be proven to be the same source row from the old schema alone; queue it rather
    // than silently drop a possibly-different delinquency.
    const plainRow: BucketedUnitRow = { unit: 'C4', property: NBC_C, d30: 0.38, d30plus: 0 };
    const incoming = buildBucketedReviewRow({
      row: plainRow,
      res: resolveByUnit(plainRow, ROSTER, NORTHWOOD),
      propertyId: NORTHWOOD,
      unitLeases: ROSTER,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(dedupReviewsAgainstQueue([LEGACY_QUEUED], [incoming])).toEqual([incoming]);
  });

  it('a genuinely different source row (other amount) is still queued', () => {
    // Label differs ('C4' vs the queued 'C 4 (storage)') so the pre-existing legacy key -- which
    // ignores amount and is untouched here -- does not fire; only the source-row key is in play.
    const row: BucketedUnitRow = { unit: 'C4', property: NBC_C, d30: 4.2, d30plus: 0 };
    const incoming = buildBucketedReviewRow({
      row,
      res: resolveByUnit(row, ROSTER, NORTHWOOD),
      propertyId: NORTHWOOD,
      unitLeases: ROSTER,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(dedupReviewsAgainstQueue([buildStorageRow()], [incoming])).toEqual([incoming]);
  });

  it('refute 2026-09-22: a queued row at one property does not dedup an unmapped-property row with the same unit label and cents', () => {
    const unmapped: BucketedUnitRow = { unit: 'C4', property: 'nbc-d - 9999 Unknown Building', d30: 0.38, d30plus: 0 };
    const incoming = buildBucketedReviewRow({
      row: unmapped,
      res: resolveByUnit(unmapped, ROSTER, null),
      propertyId: null,
      unitLeases: ROSTER,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(dedupReviewsAgainstQueue([buildStorageRow()], [incoming])).toEqual([incoming]);
  });

  it('does NOT dedup within the incoming batch -- two rows for one unit in one file are two real rows, both queued (unchanged)', () => {
    // Deliberately NOT within-batch: the legacy key ignores amount, so a within-batch legacy dedup
    // would silently drop the second of two genuine rows a single export carries for one unit.
    const a = buildStorageRow();
    const row: BucketedUnitRow = { unit: 'C 4 (storage)', property: NBC_C, d30: 4.2, d30plus: 0 };
    const b = buildBucketedReviewRow({
      row,
      res: resolveByUnit(row, ROSTER, NORTHWOOD),
      propertyId: NORTHWOOD,
      unitLeases: ROSTER,
      cacheEntries: {},
      sourceFile: SOURCE_FILE,
      asOfDate: AS_OF,
      queuedAt: NOW,
    });
    expect(dedupReviewsAgainstQueue([], [a, b])).toEqual([a, b]);
  });
});
