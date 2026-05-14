-- Speed up "any US flatrate provider" search.
--
-- The app sends watchMonetizationTypes=flatrate when the user chooses
-- all streamers. The search then only needs to know whether a movie has
-- at least one US watch-provider row.
CREATE INDEX IF NOT EXISTS idx_movie_watch_providers_tmdb_region
ON movie_watch_providers (tmdb_id, region);
