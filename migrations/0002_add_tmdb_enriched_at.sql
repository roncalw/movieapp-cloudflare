-- Migration number: 0002
--
-- Step 9B tracks whether a TMDB movie has gone through the full
-- enrichment refresh:
--   external_ids      -> imdb_id
--   release_dates     -> us_certification
--   watch/providers   -> movie_watch_providers
--
-- A null value means the movie still needs its first enrichment pass.
-- A non-null value means the movie was enriched at that time.
ALTER TABLE tmdb_movies_staging
ADD COLUMN tmdb_enriched_at TEXT;

-- Supports the Step 9B selector:
--   never enriched rows first, then oldest enriched rows.
CREATE INDEX IF NOT EXISTS idx_tmdb_movies_staging_enriched_at
ON tmdb_movies_staging (tmdb_enriched_at, tmdb_id);
