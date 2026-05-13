-- App-shaped Horror search sorted by IMDb score.
--
-- This mirrors the first production MovieApp list API target:
--   /movies/search?genreIds=27&minImdbVotes=5000&pageSize=20
--
-- The app list view only needs these columns:
--   tmdb_id
--   poster_path
--   imdb_rating
--
-- Current filter:
--   genre_id = 27          Horror
--   imdb_vote_count >= 5000
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
-- Performance shape:
--   1. Read movie_list_items through the covering IMDb search index.
--   2. Return only fields that live in that index plus tmdb_id.
--   3. Check horror with an EXISTS lookup into movie_genres.
--   4. Stop as soon as the first 20 matches are found.
--
-- The genre filter is separate from the IMDb sort because those facts live
-- in separate tables:
--   movie_list_items -> IMDb score/votes and poster
--   movie_genres     -> genre membership
--
-- D1 walks high-rated movies first, then checks whether each movie has
-- genre 27. In remote testing this returned in roughly 10 ms for the current
-- dataset.
SELECT
  movie.tmdb_id,
  movie.title,
  movie.poster_path,
  movie.imdb_rating
FROM movie_list_items AS movie INDEXED BY idx_movie_list_items_search_imdb_cover
WHERE movie.imdb_vote_count >= 5000
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
LIMIT 20;
