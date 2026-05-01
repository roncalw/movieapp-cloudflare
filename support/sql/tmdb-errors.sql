SELECT
  tmdb_id,
  title,
  release_date,
  tmdb_enriched_at,
  tmdb_enrichment_error
FROM tmdb_movies_staging
WHERE tmdb_enrichment_error IS NOT NULL
ORDER BY
  tmdb_enriched_at,
  tmdb_id;
