-- Migration number: 0005
--
-- Some TMDB IDs can appear in discover results but later return 404 from
-- the movie detail endpoint. Track those terminal enrichment errors so they
-- do not get selected again on every enrichment job.
ALTER TABLE tmdb_movies_staging
ADD COLUMN tmdb_enrichment_error TEXT;

CREATE INDEX IF NOT EXISTS idx_tmdb_movies_staging_enrichment_error
ON tmdb_movies_staging (tmdb_enrichment_error, tmdb_id);
