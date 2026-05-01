SELECT
  region,
  provider_id,
  COUNT(*) AS movie_count
FROM movie_watch_providers
GROUP BY
  region,
  provider_id
ORDER BY
  movie_count DESC,
  provider_id;
