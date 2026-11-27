-- 038_census_housing_vacancy_rate.sql
-- 2026-11-27 review (Gabriel): census-acs rows hold ACS B25002/B25004 HOUSING vacancy, which the
-- importer stored as metric 'vacancy_rate' and market-intel scored as if it were industrial vacancy.
-- Rename the metric so no reader can take it for industrial vacancy; market-intel now reads only
-- 'housing_vacancy_rate' for census-acs, displays it as residential, and never scores it.
--
-- Idempotent: a second run matches no row. A (cluster, as_of, census-acs) tuple that already has a
-- 'housing_vacancy_rate' row is skipped (renaming it would violate ux_market_series_tuple, migration
-- 017) and keeps its legacy row untouched -- never deleted; the reader ignores the legacy metric.
UPDATE market_series
   SET metric = 'housing_vacancy_rate'
 WHERE source = 'census-acs'
   AND metric = 'vacancy_rate'
   AND NOT EXISTS (
     SELECT 1 FROM market_series AS m2
      WHERE m2.cluster = market_series.cluster
        AND m2.as_of = market_series.as_of
        AND m2.source = 'census-acs'
        AND m2.metric = 'housing_vacancy_rate'
   );
