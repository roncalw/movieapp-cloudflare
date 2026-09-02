-- Migration number: 0033
--
-- The full-snapshot provider design does not use this candidate table. It was
-- created while an incremental provider approach was being evaluated and has
-- remained empty. Remove it so the production schema reflects the design that
-- is actually deployed.
DROP TABLE IF EXISTS tmdb_us_ads_movies_staging;
