-- Helps the movie_search_items rebuild clean up rows that were not refreshed
-- by the current successful build.
CREATE INDEX IF NOT EXISTS idx_movie_search_items_last_refreshed_at
ON movie_search_items (last_refreshed_at);
