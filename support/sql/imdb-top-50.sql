SELECT
  imdb_id,
  average_rating,
  num_votes,
  imported_at
FROM imdb_ratings_staging
ORDER BY
  imdb_id
LIMIT 50;
