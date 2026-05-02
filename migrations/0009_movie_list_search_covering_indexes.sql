-- Search now uses movie_list_items directly instead of the abandoned expanded
-- movie_search_items table.
--
-- The app only needs these fields for the scrolling poster grid:
--   tmdb_id
--   poster_path
--   imdb_rating
--
-- Title is intentionally not included because the poster tile does not need it.
--
-- The weekly movie_list_items rebuild now excludes rows with missing poster_path,
-- so normal app search does not need predicates like:
--   poster_path <> ''
--
-- us_certification remains nullable because TMDB certification coverage is sparse.
-- The app can still default to hiding missing certifications with an indexed
-- predicate when that is desired.
CREATE INDEX IF NOT EXISTS idx_movie_list_items_search_imdb_cover
ON movie_list_items (
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id,
  poster_path
);

CREATE INDEX IF NOT EXISTS idx_movie_list_items_search_popularity_cover
ON movie_list_items (
  popularity DESC,
  tmdb_id,
  poster_path,
  imdb_rating
);

CREATE INDEX IF NOT EXISTS idx_movie_list_items_search_release_imdb_cover
ON movie_list_items (
  release_date,
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id,
  poster_path
);
