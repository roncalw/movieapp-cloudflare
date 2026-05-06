-- Migration number: 0014
--
-- Relationship staging tables let TMDB jobs update genre/provider data without
-- touching the live search tables. The movie-list build promotes approved
-- staging rows into the live tables only after the safety counts pass.

CREATE TABLE IF NOT EXISTS movie_genres_staging (
  tmdb_id INTEGER NOT NULL,
  genre_id INTEGER NOT NULL,
  load_run_id TEXT NOT NULL,
  staged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_at TEXT,
  PRIMARY KEY (tmdb_id, genre_id)
);

CREATE INDEX IF NOT EXISTS idx_movie_genres_staging_genre_id
ON movie_genres_staging (genre_id, tmdb_id);

CREATE INDEX IF NOT EXISTS idx_movie_genres_staging_load_run_id
ON movie_genres_staging (load_run_id);

CREATE TABLE IF NOT EXISTS movie_watch_providers_staging (
  tmdb_id INTEGER NOT NULL,
  -- NULL provider_id is a staging-only sentinel. It means TMDB checked this
  -- movie/region and returned no current flatrate providers.
  provider_id INTEGER,
  region TEXT NOT NULL,
  load_run_id TEXT NOT NULL,
  staged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_at TEXT,
  PRIMARY KEY (tmdb_id, provider_id, region)
);

CREATE INDEX IF NOT EXISTS idx_movie_watch_providers_staging_filter
ON movie_watch_providers_staging (region, provider_id, tmdb_id);

CREATE INDEX IF NOT EXISTS idx_movie_watch_providers_staging_load_run_id
ON movie_watch_providers_staging (load_run_id);

ALTER TABLE movie_genres
ADD COLUMN promotion_run_id TEXT;

ALTER TABLE movie_genres
ADD COLUMN promoted_at TEXT;

ALTER TABLE movie_watch_providers
ADD COLUMN promotion_run_id TEXT;

ALTER TABLE movie_watch_providers
ADD COLUMN promoted_at TEXT;

UPDATE movie_genres
SET promotion_run_id = COALESCE(promotion_run_id, 'legacy-live-seed'),
    promoted_at = COALESCE(promoted_at, CURRENT_TIMESTAMP);

UPDATE movie_watch_providers
SET promotion_run_id = COALESCE(promotion_run_id, 'legacy-live-seed'),
    promoted_at = COALESCE(promoted_at, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO movie_genres_staging (
  tmdb_id,
  genre_id,
  load_run_id,
  staged_at,
  promoted_at
)
SELECT
  tmdb_id,
  genre_id,
  'legacy-staging-seed',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM movie_genres;

INSERT OR IGNORE INTO movie_watch_providers_staging (
  tmdb_id,
  provider_id,
  region,
  load_run_id,
  staged_at,
  promoted_at
)
SELECT
  tmdb_id,
  provider_id,
  region,
  'legacy-staging-seed',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM movie_watch_providers;

ALTER TABLE movie_list_load_counts
ADD COLUMN genre_cc_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE movie_list_load_counts
ADD COLUMN genre_per_movie_cc_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE movie_list_load_counts
ADD COLUMN watch_provider_cc_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE movie_list_load_counts
ADD COLUMN watch_provider_per_movie_cc_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE movie_list_load_counts
ADD COLUMN genre_pl_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE movie_list_load_counts
ADD COLUMN genre_per_movie_pl_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE movie_list_load_counts
ADD COLUMN watch_provider_pl_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE movie_list_load_counts
ADD COLUMN watch_provider_per_movie_pl_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE movie_list_load_counts
ADD COLUMN watch_provider_threshold REAL NOT NULL DEFAULT 10.0;
