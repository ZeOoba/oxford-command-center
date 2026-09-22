// tests/unit/migration-032-lm-cumulative-reduction.test.ts
//
// Weekly sweep 2026-09-21: lm_v_listing_metrics.cumulative_reduction_pct compared the first and latest
// asking_psf_yr of a listing directly, across total-vs-per-SF, basis and available-SF changes that
// ingest itself refuses to compare. 032 derives it from the recorded price-event chain instead.
// The two reproductions below are the reviewers' own.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

let seq = 0;
function landing(db: Database.Database): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, completeness, parse_status)
         VALUES ('costar_listings', 'f.xlsx', ?, 'columbus', '2026-01-01', '2026-01-02T00:00:00Z', 'complete', 'ok')`,
      )
      .run(`sha-${seq}`).lastInsertRowid,
  );
}
function listing(db: Database.Database, landingId: number): number {
  const p = Number(
    db
      .prepare(
        `INSERT INTO lm_property (identity_key, address_norm, address_display, market_id, subtype, building_status, first_seen, last_seen)
         VALUES (?, ?, 'x', 'columbus', 'warehouse', 'existing', '2026-01-01', '2026-01-01')`,
      )
      .run(`addr:${seq}`, `${seq} TEST RD`).lastInsertRowid,
  );
  return Number(
    db
      .prepare(
        `INSERT INTO lm_listing (property_id, suite_norm, first_seen, last_seen, first_landing_id, origin_tier)
         VALUES (?, '', '2026-01-01', '2026-01-01', ?, 'T1')`,
      )
      .run(p, landingId).lastInsertRowid,
  );
}
function observe(
  db: Database.Database,
  listingId: number,
  landingId: number,
  date: string,
  o: { basis: 'NNN' | 'GROSS'; total: boolean; low: number; sf: number; psfYr: number },
): void {
  db.prepare(
    `INSERT INTO lm_observation (listing_id, landing_id, observed_at, available_sf, rent_basis, is_sublease, rent_is_total, rent_low, asking_psf_yr, asking_nnn_eq, confidence)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'high')`,
  ).run(listingId, landingId, date, o.sf, o.basis, o.total ? 1 : 0, o.low, o.psfYr, o.psfYr);
}
function event(
  db: Database.Database,
  listingId: number,
  landingId: number,
  date: string,
  kind: 'price_cut' | 'price_increase' | 'sf_change',
  prev: number,
  next: number,
): void {
  db.prepare(
    `INSERT INTO lm_listing_event (listing_id, landing_id, event_date, kind, prev_value, new_value) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(listingId, landingId, date, kind, prev, next);
}
const metrics = (db: Database.Database, id: number) =>
  db.prepare('SELECT reduction_count, cumulative_reduction_pct FROM lm_v_listing_metrics WHERE listing_id = ?').get(id) as {
    reduction_count: number;
    cumulative_reduction_pct: number | null;
  };

describe('migration 032 — cumulative_reduction_pct from the price-event chain', () => {
  it('a total quote whose available SF grows reads its real -4% cut, not the -36% first/latest ratio', () => {
    const db = makeDb();
    const [l1, l2, l3] = [landing(db), landing(db), landing(db)];
    const s = listing(db, l1);
    // $2,500/mo total on 2,000 SF -> 15.0 $/SF/yr; a real cut to $2,400 (price_cut recorded on the raw
    // TOTAL, ingest R5); then the SAME $2,400 total on 3,000 SF -> 9.6 $/SF/yr (sf_change only).
    observe(db, s, l1, '2026-01-01', { basis: 'NNN', total: true, low: 2500, sf: 2000, psfYr: 15.0 });
    observe(db, s, l2, '2026-02-01', { basis: 'NNN', total: true, low: 2400, sf: 2000, psfYr: 14.4 });
    observe(db, s, l3, '2026-03-01', { basis: 'NNN', total: true, low: 2400, sf: 3000, psfYr: 9.6 });
    event(db, s, l2, '2026-02-01', 'price_cut', 2500, 2400);
    event(db, s, l3, '2026-03-01', 'sf_change', 2000, 3000);

    const m = metrics(db, s);
    expect(m.reduction_count).toBe(1);
    expect(m.cumulative_reduction_pct).toBe(-0.04); // old view: 9.6/15.0 - 1 = -0.36
  });

  it('a GROSS->NNN basis change with no event does not fold into the reduction', () => {
    const db = makeDb();
    const [l1, l2, l3] = [landing(db), landing(db), landing(db)];
    const s = listing(db, l1);
    observe(db, s, l1, '2026-01-01', { basis: 'GROSS', total: false, low: 13, sf: 10000, psfYr: 13 });
    observe(db, s, l2, '2026-02-01', { basis: 'GROSS', total: false, low: 12.5, sf: 10000, psfYr: 12.5 });
    observe(db, s, l3, '2026-03-01', { basis: 'NNN', total: false, low: 9, sf: 10000, psfYr: 9 });
    event(db, s, l2, '2026-02-01', 'price_cut', 13, 12.5);
    // GROSS -> NNN is not a comparable pair: ingest records no event for it.

    const m = metrics(db, s);
    expect(m.reduction_count).toBe(1);
    expect(m.cumulative_reduction_pct).toBeCloseTo(12.5 / 13 - 1, 10); // -0.0385; old view: 9/13 - 1 = -0.3077
  });

  it('is net: a later price_increase offsets earlier cuts', () => {
    const db = makeDb();
    const [l1, l2, l3] = [landing(db), landing(db), landing(db)];
    const s = listing(db, l1);
    observe(db, s, l1, '2026-01-01', { basis: 'NNN', total: false, low: 10, sf: 10000, psfYr: 10 });
    observe(db, s, l2, '2026-02-01', { basis: 'NNN', total: false, low: 9, sf: 10000, psfYr: 9 });
    observe(db, s, l3, '2026-03-01', { basis: 'NNN', total: false, low: 9.9, sf: 10000, psfYr: 9.9 });
    event(db, s, l2, '2026-02-01', 'price_cut', 10, 9);
    event(db, s, l3, '2026-03-01', 'price_increase', 9, 9.9);

    const m = metrics(db, s);
    expect(m.reduction_count).toBe(1);
    expect(m.cumulative_reduction_pct).toBeCloseTo(-0.01, 10); // 9.9/10 - 1, matches first/latest
  });

  it('compounds consecutive cuts and matches the old first/latest ratio when every pair was comparable', () => {
    const db = makeDb();
    const [l1, l2, l3] = [landing(db), landing(db), landing(db)];
    const s = listing(db, l1);
    observe(db, s, l1, '2026-01-01', { basis: 'NNN', total: false, low: 9.5, sf: 10000, psfYr: 9.5 });
    observe(db, s, l2, '2026-02-01', { basis: 'NNN', total: false, low: 9, sf: 10000, psfYr: 9 });
    observe(db, s, l3, '2026-03-01', { basis: 'NNN', total: false, low: 8.5, sf: 10000, psfYr: 8.5 });
    event(db, s, l2, '2026-02-01', 'price_cut', 9.5, 9);
    event(db, s, l3, '2026-03-01', 'price_cut', 9, 8.5);
    expect(metrics(db, s).cumulative_reduction_pct).toBeCloseTo(8.5 / 9.5 - 1, 10);
  });

  it('is NULL with zero recorded price_cut events, even after a price_increase', () => {
    const db = makeDb();
    const [l1, l2] = [landing(db), landing(db)];
    const s = listing(db, l1);
    observe(db, s, l1, '2026-01-01', { basis: 'NNN', total: false, low: 10, sf: 10000, psfYr: 10 });
    observe(db, s, l2, '2026-02-01', { basis: 'NNN', total: false, low: 11, sf: 10000, psfYr: 11 });
    event(db, s, l2, '2026-02-01', 'price_increase', 10, 11);
    expect(metrics(db, s)).toEqual({ reduction_count: 0, cumulative_reduction_pct: null });
  });

  it('is NULL (unknown, not zero) when the only price_cut has no usable value pair', () => {
    const db = makeDb();
    const [l1, l2] = [landing(db), landing(db)];
    const s = listing(db, l1);
    observe(db, s, l1, '2026-01-01', { basis: 'NNN', total: false, low: 10, sf: 10000, psfYr: 10 });
    observe(db, s, l2, '2026-02-01', { basis: 'NNN', total: false, low: 9, sf: 10000, psfYr: 9 });
    event(db, s, l2, '2026-02-01', 'price_cut', 10, 0); // corrupt: new_value = 0
    // The event still counts (029 semantics) but its depth is honestly unavailable, never 0 or an error.
    expect(metrics(db, s)).toEqual({ reduction_count: 1, cumulative_reduction_pct: null });
  });

  it('is a lower bound when ingest suppressed a real price event (documented trade-off)', () => {
    const db = makeDb();
    const [l1, l2, l3] = [landing(db), landing(db), landing(db)];
    const s = listing(db, l1);
    observe(db, s, l1, '2026-01-01', { basis: 'NNN', total: false, low: 10, sf: 10000, psfYr: 10 });
    observe(db, s, l2, '2026-02-01', { basis: 'NNN', total: false, low: 8, sf: 10000, psfYr: 8 }); // no event: confidence flip
    observe(db, s, l3, '2026-03-01', { basis: 'NNN', total: false, low: 7.5, sf: 10000, psfYr: 7.5 });
    event(db, s, l3, '2026-03-01', 'price_cut', 8, 7.5);
    expect(metrics(db, s).cumulative_reduction_pct).toBeCloseTo(-0.0625, 10); // under-reports; old view said -0.25
  });

  it('is unaffected by row insertion order of events (a product is commutative)', () => {
    const a = makeDb();
    const b = makeDb();
    for (const [db, order] of [
      [a, [0, 1]],
      [b, [1, 0]],
    ] as const) {
      const [l1, l2, l3] = [landing(db), landing(db), landing(db)];
      const s = listing(db, l1);
      const evs: Array<[number, string, 'price_cut', number, number]> = [
        [l2, '2026-02-01', 'price_cut', 10, 9],
        [l3, '2026-03-01', 'price_cut', 9, 8.1],
      ];
      for (const i of order) {
        const [lid, d, k, p, n] = evs[i]!;
        event(db, s, lid, d, k, p, n);
      }
    }
    expect(metrics(a, 1).cumulative_reduction_pct).toBe(metrics(b, 1).cumulative_reduction_pct);
  });

  it('keeps the dependent view working: lm_v_current_spaces still exposes the figure', () => {
    const db = makeDb();
    const [l1, l2] = [landing(db), landing(db)];
    const s = listing(db, l1);
    observe(db, s, l1, '2026-01-01', { basis: 'NNN', total: false, low: 10, sf: 10000, psfYr: 10 });
    observe(db, s, l2, '2026-02-01', { basis: 'NNN', total: false, low: 9, sf: 10000, psfYr: 9 });
    event(db, s, l2, '2026-02-01', 'price_cut', 10, 9);
    const row = db
      .prepare('SELECT reduction_count, cumulative_reduction_pct FROM lm_v_current_spaces WHERE listing_id = ?')
      .get(s) as { reduction_count: number; cumulative_reduction_pct: number };
    expect(row.reduction_count).toBe(1);
    expect(row.cumulative_reduction_pct).toBe(-0.1);
  });

  it('is recorded as applied and leaves the same three lm_v_ views in place', () => {
    const db = makeDb();
    const applied = db.prepare('SELECT filename FROM _migrations').all() as Array<{ filename: string }>;
    expect(applied.map((r) => r.filename)).toContain('032_lm_cumulative_reduction_event_chain.sql');
    const views = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'lm_v_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(views.map((v) => v.name)).toEqual(['lm_v_current_spaces', 'lm_v_listing_metrics', 'lm_v_radar']);
  });
});
