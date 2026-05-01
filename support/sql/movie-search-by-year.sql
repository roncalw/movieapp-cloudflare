-- Movie search by year range.
--
-- This query is meant to act like a small read-only search test against the
-- app-facing movie list table:
--
--   movie_list_items
--
-- It also joins to:
--
--   movie_genres
--   movie_watch_providers
--
-- The VS Code tasks named:
--
--   remote-movie-search-by-year
--   local-movie-search-by-year
--
-- prompt you for these two date parameters:
--
--   START_DATE
--   END_DATE
--
-- Enter dates in ISO format:
--
--   YYYY-MM-DD
--
-- Example:
--
--   START_DATE = 2020-01-01
--   END_DATE   = 2020-12-31
--
-- The helper script replaces the tokens below before sending this SQL to
-- Wrangler:
--
--   __START_DATE__
--   __END_DATE__
--
-- Keep the single quotes around the tokens. They make the replacement values
-- behave like SQL text/date strings after the helper inserts the dates.
SELECT
  movie.tmdb_id,
  movie.title,
  movie.release_date,
  movie.us_certification,
  movie.imdb_rating,
  movie.imdb_vote_count,
  movie.popularity,
  GROUP_CONCAT(DISTINCT genre.genre_id) AS genre_ids,
  GROUP_CONCAT(DISTINCT provider.provider_id) AS us_watch_provider_ids
FROM movie_list_items AS movie
LEFT JOIN movie_genres AS genre
  ON genre.tmdb_id = movie.tmdb_id
LEFT JOIN movie_watch_providers AS provider
  ON provider.tmdb_id = movie.tmdb_id
 AND provider.region = 'US'
WHERE movie.release_date >= '__START_DATE__'
  AND movie.release_date <= '__END_DATE__'
GROUP BY
  movie.tmdb_id,
  movie.title,
  movie.release_date,
  movie.us_certification,
  movie.imdb_rating,
  movie.imdb_vote_count,
  movie.popularity
ORDER BY
  movie.imdb_rating DESC,
  movie.imdb_vote_count DESC,
  movie.popularity DESC,
  movie.tmdb_id
LIMIT 50;
