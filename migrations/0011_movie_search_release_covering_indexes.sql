-- Cover the real MovieApp search endpoint shapes.
--
-- Default app search:
--   last five years
--   no genre/provider/certification filters
--   ORDER BY popularity DESC
--
-- IMDb-quality search:
--   minImdbVotes is present
--   ORDER BY imdb_rating DESC, imdb_vote_count DESC
--
-- The earlier covering indexes did not include release_date, so D1 had to
-- look back into movie_list_items while walking the sort index. These indexes
-- keep the date filter and returned app fields available inside the index.
CREATE INDEX IF NOT EXISTS idx_movie_list_items_search_popularity_date_cover
ON movie_list_items (
  popularity DESC,
  release_date,
  tmdb_id,
  poster_path,
  imdb_rating
);

CREATE INDEX IF NOT EXISTS idx_movie_list_items_search_imdb_date_cover
ON movie_list_items (
  imdb_rating DESC,
  imdb_vote_count DESC,
  release_date,
  tmdb_id,
  poster_path
);
