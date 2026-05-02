-- App-shaped Horror search from the search helper table.
--
-- Returns only the list-card fields the React Native app needs:
--   tmdb_id, title, poster_path, imdb_rating
--
-- Current filter:
--   genre_id = 27      -- Horror
--   provider_id = 0    -- no specific provider selected
--
-- Default app filters:
--   has_poster = 1
--   has_us_certification = 1
--   has_us_watch_provider = 1
--
-- This is page 1 of cursor paging. The endpoint should return the final row's
-- sort values as nextCursor:
--   imdb_rating, imdb_vote_count, tmdb_id
SELECT
  tmdb_id,
  title,
  poster_path,
  imdb_rating
FROM movie_search_items INDEXED BY idx_movie_search_items_imdb
WHERE genre_id = 27
  AND provider_id = 0
  AND region = 'US'
  AND has_poster = 1
  AND has_us_certification = 1
  AND has_us_watch_provider = 1
  AND imdb_vote_count >= 5000
  AND imdb_rating IS NOT NULL
ORDER BY
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id
LIMIT 20;
