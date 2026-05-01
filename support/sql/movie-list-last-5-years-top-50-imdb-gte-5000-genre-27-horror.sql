-- Top 50 MovieApp final-list Horror rows by IMDb rating for the current
-- default search window, requiring at least 5,000 IMDb votes.
--
-- Default date logic:
--   start date = January 1 of the year from 5 years ago
--   end date   = today
--
-- Genre legend:
--   28    Action
--   12    Adventure
--   16    Animation
--   35    Comedy
--   80    Crime
--   99    Documentary
--   18    Drama
--   10751 Family
--   14    Fantasy
--   36    History
--   27    Horror
--   10402 Music
--   9648  Mystery
--   10749 Romance
--   878   Science Fiction
--   10770 TV Movie
--   53    Thriller
--   10752 War
--   37    Western
--
-- Current filter:
--   genre_id = 27  -- Horror
--
-- Performance notes:
--   1. Scan the IMDb sort index in rating/vote order.
--   2. Require imdb_vote_count >= 5000 to avoid tiny-sample high ratings.
--   3. Use EXISTS against movie_genres for the Horror filter. That lookup can
--      use the movie_genres primary key by tmdb_id.
--   4. Limit to 50 before reading genre/provider lists.
--   5. Force the provider primary-key index so provider lookup starts from
--      tmdb_id instead of scanning every US provider row.
--
-- Important:
--   This is the best query shape for the current normalized schema. It is not
--   as fast as popularity-only because genre lives in movie_genres while IMDb
--   rating lives in movie_list_items. To make this consistently single-digit
--   milliseconds, build a denormalized search table keyed by genre_id with
--   imdb_rating/imdb_vote_count/release_date columns, or add genre flags/list
--   columns to movie_list_items during the final rebuild.
WITH top_movies AS (
  SELECT
    movie.tmdb_id,
    movie.title,
    movie.release_date,
    movie.us_certification,
    movie.imdb_rating,
    movie.imdb_vote_count,
    movie.popularity,
    movie.last_refreshed_at
  FROM movie_list_items AS movie INDEXED BY idx_movie_list_items_imdb_sort
  WHERE movie.release_date >= date('now', '-5 years', 'start of year')
    AND movie.release_date <= date('now')
    AND movie.imdb_vote_count >= 5000
    AND movie.imdb_rating IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM movie_genres AS genre
      WHERE genre.tmdb_id = movie.tmdb_id
        AND genre.genre_id = 27
    )
  ORDER BY
    movie.imdb_rating DESC,
    movie.imdb_vote_count DESC,
    movie.tmdb_id
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
