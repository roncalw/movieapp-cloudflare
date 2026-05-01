SELECT
  COUNT(*) AS imdb_rating_count,
  MIN(average_rating) AS min_average_rating,
  MAX(average_rating) AS max_average_rating,
  SUM(CASE WHEN average_rating IS NULL THEN 1 ELSE 0 END) AS missing_average_rating_count,
  SUM(CASE WHEN num_votes IS NULL THEN 1 ELSE 0 END) AS missing_vote_count
FROM imdb_ratings_staging;
