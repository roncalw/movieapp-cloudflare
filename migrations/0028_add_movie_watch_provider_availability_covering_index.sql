-- The shopping-bag availability checks begin with one movie and one region.
-- provider_id at the end lets D1 decide whether the relationship is a real
-- subscription provider or the internal streams-with-ads marker directly from
-- the index, without returning to the relationship table for that column.
--
-- Keep the existing provider indexes. Their different left-most column orders
-- support selected-streamer filtering and movie-first existence checks.
CREATE INDEX IF NOT EXISTS idx_movie_watch_providers_tmdb_region_provider
ON movie_watch_providers (tmdb_id, region, provider_id);
