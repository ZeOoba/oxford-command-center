-- 032_lm_cumulative_reduction_event_chain.sql
--
-- Weekly financial-code sweep 2026-09-21 (edges lens, MEDIUM): lm_v_listing_metrics.cumulative_reduction_pct
-- compared the FIRST and LATEST asking_psf_yr of a listing directly. Ingest (ingest.ts ~L619-667) refuses to
-- compare two observations that differ in rent_basis, confidence, rent_is_total or rent period -- it records
-- no price event for such a pair, precisely because the raw figures are not on one basis. The view took the
-- first/latest pair anyway, so a change of GROUNDS read as a price move:
--   * total-vs-per-SF: obs1 $2,500/mo total on 2,000 SF -> asking_psf_yr 15.0; obs2 $2,400/mo (real -4% cut,
--     price_cut event recorded); obs3 the SAME $2,400 total but available SF grew to 3,000 -> asking_psf_yr 9.6
--     (sf_change event only). View: 9.6/15.0 - 1 = -0.36. True reduction: -0.04.
--   * basis change: GROSS 13.00 -> GROSS 12.50 (price_cut, -3.8%) -> NNN 9.00 (basis change, no event).
--     View: 9.0/13.0 - 1 = -0.3077. True reduction: -0.0385.
-- The inflated figure feeds the radar's reductions component and the rent_cut signal evidence
-- (compute.ts SpaceRow.cumulative_reduction_pct), so it pushed radar scores up on data that only looked cut.
--
-- Fix: derive the figure from the RECORDED price-event chain -- the product of new_value/prev_value over the
-- price_cut and price_increase events, minus 1. Each event was written by ingest only for a pair it had already
-- proven comparable (same basis/confidence/totalness/period), so the chain is on one basis BY CONSTRUCTION and
-- can never fold an sf_change or a basis switch into a "reduction". It reduces to the old first/latest ratio
-- whenever every consecutive pair was comparable, so ordinary listings do not move.
--
-- Semantics kept from 029: NULL whenever reduction_count = 0 (a listing with no recorded price_cut carries no
-- cumulative reduction, e.g. from opex drift); a net figure -- a later price_increase offsets earlier cuts.
--
-- Views only, no data touched. 029 is deliberately NOT edited: runMigrations records applied files by NAME with
-- no checksum, so an edited 029 would never reach a database that already applied it. lm_v_current_spaces selects
-- from lm_v_listing_metrics, so it is dropped first and recreated verbatim after.
--
-- LN/EXP are used because SQLite has no PRODUCT aggregate (better-sqlite3's bundled SQLite ships the math
-- functions). ROUND(..., 12) strips the ~1e-16 log/exp round-trip noise so a 4% cut reads -0.04, not
-- -0.04000000000000004. Events with a non-positive value cannot enter a log (rent floor is $1/SF/yr, totals are
-- positive) and are excluded rather than allowed to raise.

DROP VIEW IF EXISTS lm_v_current_spaces;
DROP VIEW IF EXISTS lm_v_listing_metrics;

CREATE VIEW lm_v_listing_metrics AS
SELECT
  l.id AS listing_id,
  (SELECT o.asking_nnn_eq FROM lm_observation o WHERE o.listing_id = l.id AND o.asking_nnn_eq IS NOT NULL ORDER BY o.observed_at ASC, o.id ASC LIMIT 1) AS original_asking,
  (SELECT o.asking_nnn_eq FROM lm_observation o WHERE o.listing_id = l.id ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) AS current_asking,
  (SELECT MIN(o.asking_nnn_eq) FROM lm_observation o WHERE o.listing_id = l.id) AS min_asking,
  (SELECT COUNT(*) FROM lm_listing_event e WHERE e.listing_id = l.id AND e.kind = 'price_cut') AS reduction_count,
  (SELECT MIN(o.observed_at) FROM lm_observation o WHERE o.listing_id = l.id) AS first_observed,
  (SELECT MAX(o.observed_at) FROM lm_observation o WHERE o.listing_id = l.id) AS last_observed,
  CASE
    WHEN (SELECT COUNT(*) FROM lm_listing_event e WHERE e.listing_id = l.id AND e.kind = 'price_cut') = 0 THEN NULL
    ELSE (
      SELECT ROUND(EXP(SUM(LN(e.new_value / e.prev_value))) - 1.0, 12)
        FROM lm_listing_event e
       WHERE e.listing_id = l.id
         AND e.kind IN ('price_cut', 'price_increase')
         AND e.prev_value > 0
         AND e.new_value > 0
    )
  END AS cumulative_reduction_pct
FROM lm_listing l;

CREATE VIEW lm_v_current_spaces AS
SELECT
  l.id AS listing_id, p.id AS property_id, p.market_id, p.submarket, p.subtype, p.address_display, l.suite_norm,
  p.building_sf, p.year_built, p.clear_height_ft, p.docks, p.drive_ins, p.owner_name, p.owner_type, p.ora_property_key,
  l.status, l.first_seen, l.costar_date_on_market, l.broker_name, l.broker_company, l.listing_url,
  o.observed_at, o.available_sf, o.rent_basis, o.asking_nnn_eq, o.confidence, o.is_sublease,
  m.original_asking, m.reduction_count, m.cumulative_reduction_pct
FROM lm_listing l
JOIN lm_property p ON p.id = l.property_id
JOIN lm_observation o ON o.id = (SELECT o2.id FROM lm_observation o2 WHERE o2.listing_id = l.id ORDER BY o2.observed_at DESC, o2.id DESC LIMIT 1)
JOIN lm_v_listing_metrics m ON m.listing_id = l.id
WHERE l.status IN ('active', 'missing_once');
