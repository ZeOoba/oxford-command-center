// server/warehouse/lease-market/feed.ts
//
// Lease Market Intelligence — read side of the market-rent feed (spec §3.7; fix round 1). Consumed
// only by marketRentGaps' informational gap display (GET /forecast, GET /narrative) — NEVER by the
// NOI-affecting rentForecast projection (POST /rent-forecast passes manual overlay marketRents only;
// "never present an asking-rent × SF figure as NOI" wins over any convenience of merging it in here).
import type { WarehouseDb } from '../db';

// `WHERE confidence <> 'LOW'` is defense in depth: compute (Task 10) already never persists
// LOW-confidence rows, but this read-side guard means the query is correct even if that invariant
// is ever violated upstream.
export function loadMarketRentFeed(db: WarehouseDb): Record<string, number> {
  const rows = db
    .prepare(`SELECT ora_property_key, asking_nnn_eq FROM lm_market_rent_feed WHERE confidence <> 'LOW'`)
    .all() as Array<{ ora_property_key: string; asking_nnn_eq: number }>;
  return Object.fromEntries(rows.map((r) => [r.ora_property_key, r.asking_nnn_eq]));
}
