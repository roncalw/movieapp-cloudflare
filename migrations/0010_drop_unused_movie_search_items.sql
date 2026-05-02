-- Drop the unused movie_search_items helper-table experiment.
--
-- The live /movies/search endpoint uses movie_list_items plus the normalized
-- movie_genres and movie_watch_providers tables. It does not read
-- movie_search_items, and the rebuild queue/cron path has been removed.
DROP TABLE IF EXISTS movie_search_build_state;
DROP TABLE IF EXISTS movie_search_items;
