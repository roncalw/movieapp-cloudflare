-- Top 50 MovieApp final-list rows by TMDB popularity for the current
-- default search window.
--
-- Default date logic:
--   start date = January 1 of the year from 5 years ago
--   end date   = today
--
-- Example:
--   if today is 2026-05-01
--   date('now', '-5 years', 'start of year') = 2021-01-01
--
-- This query reads the final app-facing movie_list_items table and includes
-- the child rows used for filters:
--   movie_genres
--   movie_watch_providers
--
-- The genre and provider values are comma-separated id lists because the
-- database currently stores ids, not display labels.
--
-- Performance notes:
--   1. Pick the top 50 movies first.
--   2. Force the popularity index so D1 scans the already-sorted popularity
--      index and stops as soon as it finds 50 movies in the date window.
--   3. Use correlated child lookups for genres/providers so only those 50
--      movies touch the child tables.
--   4. Force the provider primary-key index so provider lookup starts from
--      tmdb_id instead of scanning every US provider row.
WITH top_movies AS (
  SELECT
    tmdb_id,
    title,
    release_date,
    us_certification,
    imdb_rating,
    imdb_vote_count,
    popularity,
    last_refreshed_at
  FROM movie_list_items INDEXED BY idx_movie_list_items_popularity
  WHERE release_date >= date('now', '-5 years', 'start of year')
    AND release_date <= date('now')
  ORDER BY
    popularity DESC,
    tmdb_id
  LIMIT 50
)
SELECT
  movie.tmdb_id,
  movie.title,
  movie.release_date,
  movie.us_certification,
  movie.imdb_rating,
  movie.imdb_vote_count,
  movie.popularity,
  (
    SELECT GROUP_CONCAT(genre_id)
    FROM movie_genres
    WHERE tmdb_id = movie.tmdb_id
  ) AS genre_ids,
  (
    SELECT GROUP_CONCAT(provider_id)
    FROM movie_watch_providers INDEXED BY sqlite_autoindex_movie_watch_providers_1
    WHERE tmdb_id = movie.tmdb_id
      AND region = 'US'
  ) AS us_watch_provider_ids,
  date('now', '-5 years', 'start of year') AS default_begin_date,
  date('now') AS default_end_date
FROM top_movies AS movie
ORDER BY
  movie.popularity DESC,
  movie.tmdb_id
