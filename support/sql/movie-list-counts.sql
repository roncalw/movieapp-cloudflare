SELECT
  COUNT(*) AS movie_list_count,
  MIN(release_date) AS min_release_date,
  MAX(release_date) AS max_release_date,
  SUM(CASE WHEN imdb_rating IS NULL THEN 1 ELSE 0 END) AS missing_imdb_rating_count,
  SUM(CASE WHEN imdb_vote_count IS NULL THEN 1 ELSE 0 END) AS missing_imdb_vote_count,
  MAX(last_refreshed_at) AS latest_refreshed_at
FROM movie_list_items;
