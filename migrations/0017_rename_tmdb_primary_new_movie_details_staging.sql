-- Migration number: 0017
--
-- Rename the primary-load support table to make its purpose explicit.
-- This is a staging handoff table: the TMDB primary job refreshes it with
-- movie IDs from the latest primary run, and the new-movie-details job reads it.

ALTER TABLE tmdb_primary_load_movies
RENAME TO tmdb_primary_new_movie_ids_for_new_movie_details_staging;

DROP INDEX IF EXISTS idx_tmdb_primary_load_movies_tmdb_id;

CREATE INDEX IF NOT EXISTS idx_tmdb_primary_new_movie_ids_for_new_movie_details_staging_tmdb_id
ON tmdb_primary_new_movie_ids_for_new_movie_details_staging (tmdb_id);
