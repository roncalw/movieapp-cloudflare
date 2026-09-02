-- Migration number: 0031
--
-- The weekly popularity and IMDb refreshes update different columns. The old
-- covering indexes repeated both changing measurements in all four indexes,
-- so one logical movie update rewrote the table row plus four index rows.
-- These replacements keep each changing measurement only in the two indexes
-- that sort by it. Search results remain covered because the omitted value can
-- be read from the table after SQLite has selected the requested page.

DROP INDEX IF EXISTS idx_movie_list_items_search_popularity_v2_cover;
DROP INDEX IF EXISTS idx_movie_list_items_search_imdb_v2_cover;
DROP INDEX IF EXISTS idx_movie_list_items_language_popularity_v2_cover;
DROP INDEX IF EXISTS idx_movie_list_items_language_imdb_v2_cover;

CREATE INDEX idx_movie_list_items_search_popularity_v2_cover
ON movie_list_items (
  popularity DESC,
  tmdb_id,
  release_date,
  poster_path,
  us_certification,
  original_language
);

CREATE INDEX idx_movie_list_items_search_imdb_v2_cover
ON movie_list_items (
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id,
  release_date,
  poster_path,
  us_certification,
  original_language
);

CREATE INDEX idx_movie_list_items_language_popularity_v2_cover
ON movie_list_items (
  original_language,
  popularity DESC,
  tmdb_id,
  release_date,
  poster_path,
  us_certification
);

CREATE INDEX idx_movie_list_items_language_imdb_v2_cover
ON movie_list_items (
  original_language,
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id,
  release_date,
  poster_path,
  us_certification
);
