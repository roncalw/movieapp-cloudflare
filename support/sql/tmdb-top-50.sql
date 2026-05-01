SELECT
  tmdb_id,
  imdb_id,
  title,
  release_date,
  us_certification,
  popularity,
  tmdb_enriched_at,
  tmdb_enrichment_error
FROM tmdb_movies_staging
ORDER BY
  release_date,
  tmdb_id
LIMIT 50;
