// server/warehouse/lease-market/feed.ts
//
// Lease Market Intelligence — read side of the market-rent feed (spec §3.7). The feed is merged UNDER the
// manual overlay at read time; it is never written into overlay.json.
import type { WarehouseDb } from '../db';

export function loadMarketRentFeed(db: WarehouseDb): Record<string, number> {
  const rows = db.prepare('SELECT ora_property_key, asking_nnn_eq FROM lm_market_rent_feed').all() as Array<{ ora_property_key: string; asking_nnn_eq: number }>;
  return Object.fromEntries(rows.map((r) => [r.ora_property_key, r.asking_nnn_eq]));
}

export function mergeMarketRents(feed: Record<string, number>, manual: Record<string, number>): Record<string, number> {
  return { ...feed, ...manual };
}
