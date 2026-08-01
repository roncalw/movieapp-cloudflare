-- These four indexes support both kinds of MovieApp search:
--
--   1. A search with no language filter.
--   2. A search limited to one or more original languages.
--
-- The two all-language indexes keep original_language at the end. That makes
-- the column available directly from the index without changing which rows
-- can efficiently participate in an ordinary search.
--
-- The two language-first indexes begin with original_language. The Worker uses
-- them only when a language filter is present, so SQLite can narrow the index
-- scan before applying the remaining movie filters.
--
-- tmdb_id immediately follows each sort key because it is the final ORDER BY
-- and cursor-paging tie breaker. The remaining columns cover the response and
-- common filters so D1 normally does not have to fetch the main table row.
CREATE INDEX IF NOT EXISTS idx_movie_list_items_search_popularity_v2_cover
ON movie_list_items (
  popularity DESC,
  tmdb_id,
  release_date,
  poster_path,
  imdb_rating,
  imdb_vote_count,
  us_certification,
  original_language
);

CREATE INDEX IF NOT EXISTS idx_movie_list_items_search_imdb_v2_cover
ON movie_list_items (
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id,
  release_date,
  poster_path,
  popularity,
  us_certification,
  original_language
);

CREATE INDEX IF NOT EXISTS idx_movie_list_items_language_popularity_v2_cover
ON movie_list_items (
  original_language,
  popularity DESC,
  tmdb_id,
  release_date,
  poster_path,
  imdb_rating,
  imdb_vote_count,
  us_certification
);

CREATE INDEX IF NOT EXISTS idx_movie_list_items_language_imdb_v2_cover
ON movie_list_items (
  original_language,
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id,
  release_date,
  poster_path,
  popularity,
  us_certification
);
