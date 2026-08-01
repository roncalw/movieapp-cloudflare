-- Production verification has proved that the deployed Worker serves both
-- language-filtered and unfiltered searches from the four v2 covering indexes.
--
-- Drop only the two pre-language indexes that the former Worker forced with
-- INDEXED BY. The v2 all-language indexes remain permanently available for
-- requests that omit originalLanguages, and the two language-first indexes
-- remain available for requests that supply it.
--
-- This migration intentionally leaves every older general-purpose and
-- maintenance index alone.
DROP INDEX IF EXISTS idx_movie_list_items_search_popularity_date_cover;
DROP INDEX IF EXISTS idx_movie_list_items_search_imdb_date_cover;
