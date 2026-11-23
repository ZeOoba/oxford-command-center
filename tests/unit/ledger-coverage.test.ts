// @vitest-environment node
// Tier 1 data honesty (2026-11-23 review): "Latest Period 2026" hid that the 2026 ledger is a YTD
// cut that stops at mid-year. The label must say how far the ledger actually runs.
import { describe, expect, it } from 'vitest';
import { ledgerCoverage } from '../../src/modules/data/latestPeriod';

type Row = { status: string; grain: string | null; propertyId: string | null; periodStart: string | null; periodEnd: string | null };
const row = (over: Partial<Row>): Row => ({ status: 'committed', grain: 'year', propertyId: 'p1', periodStart: '2025-01-01', periodEnd: '2025-12-31', ...over });

describe('ledgerCoverage', () => {
  it('nothing committed is null', () => {
    expect(ledgerCoverage([])).toBeNull();
    expect(ledgerCoverage([row({ status: 'pending-review' })])).toBeNull();
  });

  it('a full year reads as the bare year', () => {
    expect(ledgerCoverage([row({})])).toEqual({ label: '2025', detail: null });
  });

  it('a YTD year names the EARLIEST per-property cut-off and counts undated properties', () => {
    const c = ledgerCoverage([
      row({ propertyId: 'z', grain: 'year', periodStart: '2026-01-01', periodEnd: '2026-12-31' }),
      row({ propertyId: 'a', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-12-31' }), // header claims a full year
      row({ propertyId: 'b', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
      row({ propertyId: 'c', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-06-12' }),
      row({ propertyId: 'd', grain: 'ytd', periodStart: '2026-01-01', periodEnd: null }),
      row({ propertyId: 'c', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-03-31', status: 'superseded' }),
    ]);
    expect(c).toEqual({ label: 'Jun 12', detail: '2026 YTD · earliest property cut-off · 1 of 5 undated' });
  });

  // Refute round 1 (2026-11-23): a stale earlier YTD cut stays committed beside the later one.
  it("uses each property's LATEST YTD cut, not a stale earlier one", () => {
    const c = ledgerCoverage([
      row({ propertyId: 'a', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-03-31' }),
      row({ propertyId: 'a', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
      row({ propertyId: 'b', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
    ]);
    expect(c?.label).toBe('Jun 30');
  });

  it('a full-year batch beside a YTD cut means that property is complete', () => {
    expect(ledgerCoverage([
      row({ grain: 'ytd', periodStart: '2025-01-01', periodEnd: '2025-06-30' }),
      row({}),
    ])).toEqual({ label: '2025', detail: null });
  });

  it('a malformed period end makes that property undated instead of throwing', () => {
    expect(ledgerCoverage([
      row({ propertyId: 'a', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-6-30' }),
      row({ propertyId: 'b', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-05-31' }),
    ])).toEqual({ label: 'May 31', detail: '2026 YTD · earliest property cut-off · 1 of 2 undated' });
  });

  // Refute round 2 (2026-11-23): the property that has not loaded the new year is the lag to show.
  it('a property with no batch in the latest year sets the cut-off and is counted behind', () => {
    expect(ledgerCoverage([
      row({ propertyId: 'a' }),
      row({ propertyId: 'b', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
    ])).toEqual({ label: 'Dec 31, 2025', detail: 'earliest property cut-off · 1 of 2 not loaded for 2026' });
  });

  it('an undated YTD restatement beside a dated cut makes the property undated (metrics serves it)', () => {
    expect(ledgerCoverage([
      row({ propertyId: 'a', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
      row({ propertyId: 'a', grain: 'ytd', periodStart: '2026-01-01', periodEnd: null }),
      row({ propertyId: 'b', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-05-31' }),
    ])).toEqual({ label: 'May 31', detail: '2026 YTD · earliest property cut-off · 1 of 2 undated' });
  });

  it('YTD with no dated batch says so', () => {
    expect(ledgerCoverage([row({ grain: 'ytd', periodStart: '2026-01-01', periodEnd: null })]))
      .toEqual({ label: 'YTD', detail: 'cut-off not dated for 1 of 1' });
  });

  // The value renders in the large KPI font; a long label wrapped to four lines in a narrow tile
  // (2026-11-23 live check). The year/basis context belongs in `detail`.
  it('keeps the KPI value short enough for the tile', () => {
    const c = ledgerCoverage([
      row({ propertyId: 'a' }),
      row({ propertyId: 'b', grain: 'ytd', periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
    ]);
    expect(c!.label.length).toBeLessThanOrEqual(12);
  });
});
