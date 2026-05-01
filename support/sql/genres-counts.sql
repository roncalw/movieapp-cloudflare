SELECT
  genre_id,
  COUNT(*) AS movie_count
FROM movie_genres
GROUP BY genre_id
ORDER BY
  movie_count DESC,
  genre_id;
