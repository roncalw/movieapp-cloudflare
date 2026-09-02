-- Migration number: 0034
--
-- The provider refresh still discovers a complete TMDB candidate set, but it
-- no longer needs to rewrite every provider relationship twice per run. These
-- tables preserve the complete-run safety check while storing only additions
-- and removals for the live relationship table.

CREATE TABLE IF NOT EXISTS tmdb_us_ads_refresh_candidates (
  tmdb_id INTEGER PRIMARY KEY,
  load_run_id TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tmdb_us_ads_refresh_candidates_load_run_id
ON tmdb_us_ads_refresh_candidates (load_run_id);

CREATE TABLE IF NOT EXISTS movie_watch_provider_changes_staging (
  load_run_id TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  region TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('add', 'remove')),
  staged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TEXT,
  PRIMARY KEY (load_run_id, tmdb_id, provider_id, region)
);
