-- Migration number: 0015
--
-- Stores the TMDB Discover US-flatrate candidate set separately from the
-- final provider rows. The scheduled provider refresh rebuilds this table
-- before it queues per-movie provider lookups.

CREATE TABLE IF NOT EXISTS tmdb_us_flatrate_movies_staging (
  tmdb_id INTEGER PRIMARY KEY,
  load_run_id TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tmdb_us_flatrate_movies_staging_load_run_id
ON tmdb_us_flatrate_movies_staging (load_run_id);

ALTER TABLE movie_watch_providers_staging
ADD COLUMN is_full_refresh INTEGER NOT NULL DEFAULT 0;
