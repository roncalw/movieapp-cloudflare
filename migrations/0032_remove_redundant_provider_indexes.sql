-- Migration number: 0032
--
-- Keep the existing full-snapshot provider refresh while removing two index
-- writes that do not help the production queries.
--
-- The newer tmdb/region/provider index has the same first two columns as the
-- older tmdb/region index, so it already supports every lookup that the older
-- index handled. The provider-filter index remains in place for searches that
-- begin with region and provider_id.
DROP INDEX IF EXISTS idx_movie_watch_providers_tmdb_region;

-- Provider staging is accessed either by load_run_id or by one tmdb_id. The
-- load-run index handles promotion and validation. For one-movie cleanup, the
-- table's primary-key index begins with tmdb_id and reads only that movie's
-- small set of provider rows. The removed region-first index made SQLite scan
-- the much larger set of every U.S. staging row instead.
DROP INDEX IF EXISTS idx_movie_watch_providers_staging_filter;
