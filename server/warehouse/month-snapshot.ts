// server/warehouse/month-snapshot.ts
//
// Portfolio Trends Wave 2 — recorded per-property monthly snapshots (table portfolio_month_snapshot,
// migration 033). The CURRENT ET month is upserted on every workbook refresh; once a later month's
// capture arrives, the earlier month's rows are frozen and never overwritten again.
//
// Source discipline: leased_sf / in_place_rent / lease_count come from the same engine as the client
// reconstruction (buildPortfolioTrend, month 0 only — nothing is back-cast); total_sf is Property.sf;
// occ_pct is the workbook's own occupancy, stored separately and never blended with the lease basis.
import type { Lease, Property } from '@contracts/index';
import type { WarehouseDb } from './db';
import { easternCalendarDay } from './occupancy';
import { buildPortfolioTrend } from '../../src/analytics/portfolio-trends';
import { isInvestmentProperty } from '../../src/analytics/property-basis';

/** Structural view of the workbook snapshot — only the fields captureMonthSnapshot reads. */
export interface MonthSnapshotView {
  properties: ReadonlyArray<{ id: string; sf: number; occPct: number; type?: string }>;
  leases: ReadonlyArray<Lease>;
  meta: { generatedAt: string };
}

export interface MonthSnapshotRow {
  propertyId: string;
  month: string;
  capturedThrough: string;
  totalSf: number;
  leasedSf: number;
  inPlaceRent: number;
  leaseCount: number;
  occPct: number | null;
  frozen: boolean;
}

const UPSERT = `
  INSERT INTO portfolio_month_snapshot
    (property_id, month, captured_through, total_sf, leased_sf, in_place_rent, lease_count, occ_pct)
  VALUES (@propertyId, @month, @day, @totalSf, @leasedSf, @inPlaceRent, @leaseCount, @occPct)
  ON CONFLICT (property_id, month) DO UPDATE SET
    captured_through = excluded.captured_through, total_sf = excluded.total_sf,
    leased_sf = excluded.leased_sf, in_place_rent = excluded.in_place_rent,
    lease_count = excluded.lease_count, occ_pct = excluded.occ_pct,
    recorded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE portfolio_month_snapshot.frozen = 0`;
const HAS_LATER = `SELECT 1 FROM portfolio_month_snapshot WHERE property_id = ? AND month > ? LIMIT 1`;
const FREEZE = `UPDATE portfolio_month_snapshot SET frozen = 1 WHERE property_id = ? AND month < ? AND frozen = 0`;

/**
 * Record the current ET month's per-property snapshot and freeze each property's earlier months.
 * Safe no-op ({0,0,0}) for a null snapshot or unparseable generatedAt. Throws when property_master is
 * empty while there are properties to record (never a silent {recorded:0}). Skips (does not abort on):
 * ids absent from property_master (one console.warn listing them), duplicate ids in one batch (first
 * wins), non-finite sf/occPct, and rows already frozen (an older-month recapture). occPct outside
 * [0,1] stores NULL but still records the lease-derived columns.
 */
export function captureMonthSnapshot(
  db: WarehouseDb,
  snapshot: MonthSnapshotView | null,
): { recorded: number; skipped: number; frozen: number } {
  if (!snapshot) return { recorded: 0, skipped: 0, frozen: 0 };
  const day = easternCalendarDay(snapshot.meta.generatedAt);
  if (!day) return { recorded: 0, skipped: 0, frozen: 0 };
  const month = day.slice(0, 7);

  const relevant = snapshot.properties.filter(isInvestmentProperty);
  const validIds = new Set(
    (db.prepare('SELECT id FROM property_master').all() as Array<{ id: string }>).map((r) => r.id),
  );
  if (validIds.size === 0 && relevant.length > 0) {
    throw new Error(
      'month snapshot capture: property_master is empty — run `npm run warehouse:backfill` before capturing',
    );
  }

  let skipped = 0;
  const orphanIds: string[] = [];
  const seen = new Set<string>();
  const accepted: Array<{ id: string; sf: number; occPct: number }> = [];
  for (const p of relevant) {
    if (!validIds.has(p.id)) { skipped++; orphanIds.push(p.id); continue; }
    if (seen.has(p.id)) { skipped++; continue; } // duplicate id — first occurrence wins
    seen.add(p.id); // claim the id even if this occurrence is unusable, so a later duplicate cannot sneak in
    if (!Number.isFinite(p.sf) || !Number.isFinite(p.occPct)) { skipped++; continue; }
    accepted.push(p);
  }

  const trend = buildPortfolioTrend(
    [...snapshot.leases],
    accepted.map((p) => ({ id: p.id, sf: p.sf, type: 'Flex' }) as unknown as Property),
    { asOf: day, monthsBack: 0, monthsForward: 0 },
  );

  const upsert = db.prepare(UPSERT);
  const freeze = db.prepare(FREEZE);
  const hasLater = db.prepare(HAS_LATER);
  let recorded = 0;
  let frozen = 0;
  db.transaction(() => {
    for (const p of accepted) {
      const point = trend.byProperty[p.id]?.[0];
      if (!point) { skipped++; continue; }
      // Never write a back-dated month: that would be reconstructed history, which this table never holds.
      if (hasLater.get(p.id, month)) { skipped++; continue; }
      const res = upsert.run({
        propertyId: p.id,
        month,
        day,
        totalSf: point.totalSf,
        leasedSf: point.leasedSf,
        inPlaceRent: point.inPlaceRent,
        leaseCount: point.leaseCount,
        occPct: p.occPct >= 0 && p.occPct <= 1 ? p.occPct : null,
      });
      if (res.changes === 0) { skipped++; continue; } // frozen row — never overwritten
      recorded++;
      frozen += freeze.run(p.id, month).changes;
    }
  })();

  if (orphanIds.length > 0) {
    console.warn(
      `month snapshot capture: ${orphanIds.length} property id(s) not in property_master — skipped (possible roster/slug drift): ${orphanIds.join(', ')}`,
    );
  }
  return { recorded, skipped, frozen };
}

/** Recorded monthly snapshots, ordered by property then month ascending; optional single-property filter. */
export function monthSnapshotSeries(db: WarehouseDb, propertyId?: string): MonthSnapshotRow[] {
  const rows = db
    .prepare(
      `SELECT property_id AS propertyId, month, captured_through AS capturedThrough, total_sf AS totalSf,
              leased_sf AS leasedSf, in_place_rent AS inPlaceRent, lease_count AS leaseCount,
              occ_pct AS occPct, frozen
       FROM portfolio_month_snapshot
       ${propertyId === undefined ? '' : 'WHERE property_id = ?'}
       ORDER BY property_id ASC, month ASC`,
    )
    .all(...(propertyId === undefined ? [] : [propertyId])) as Array<Omit<MonthSnapshotRow, 'frozen'> & { frozen: number }>;
  return rows.map((r) => ({ ...r, frozen: r.frozen === 1 }));
}
