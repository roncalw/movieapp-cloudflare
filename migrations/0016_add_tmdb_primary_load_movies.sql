-- Migration number: 0016
--
-- Keeps the set of TMDB IDs touched by each primary load. The new-movie
-- details job uses this run-specific list to enrich only movies from the
-- latest successful primary load that still need static details.
-- Migration 0017 renames this table to the clearer staging-table name used
-- by the current code.

CREATE TABLE IF NOT EXISTS tmdb_primary_load_movies (
  job_run_id TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  loaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_run_id, tmdb_id)
);

CREATE INDEX IF NOT EXISTS idx_tmdb_primary_load_movies_tmdb_id
ON tmdb_primary_load_movies (tmdb_id);
