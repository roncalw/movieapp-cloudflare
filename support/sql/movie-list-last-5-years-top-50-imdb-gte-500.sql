-- Top 50 MovieApp final-list rows by IMDb rating for the current default
-- search window, requiring at least 500 IMDb votes.
--
-- Default date logic:
--   start date = January 1 of the year from 5 years ago
--   end date   = today
--
-- Example:
--   if today is 2026-05-01
--   date('now', '-5 years', 'start of year') = 2021-01-01
--
-- Why imdb_vote_count >= 500:
--   IMDb rating alone can surface obscure movies with tiny vote counts and
--   suspicious 10.0 ratings. Requiring 500 votes keeps the list closer to
--   movies with enough audience signal to be useful.
--
-- Performance notes:
--   1. Pick the top 50 movies first.
--   2. Force the IMDb sort index so D1 can scan rating/vote order and stop
--      once it finds 50 rows that pass the date and vote-count filters.
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
  FROM movie_list_items INDEXED BY idx_movie_list_items_imdb_sort
  WHERE release_date >= date('now', '-5 years', 'start of year')
    AND release_date <= date('now')
    AND imdb_vote_count >= 500
    AND imdb_rating IS NOT NULL
  ORDER BY
    imdb_rating DESC,
    imdb_vote_count DESC,
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
  movie.imdb_rating DESC,
  movie.imdb_vote_count DESC,
  movie.tmdb_id
