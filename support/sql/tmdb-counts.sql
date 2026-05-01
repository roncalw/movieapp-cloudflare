SELECT
  datetime('now') AS checked_at_utc,
  COUNT(*) AS tmdb_count,
  SUM(CASE WHEN tmdb_enriched_at IS NOT NULL THEN 1 ELSE 0 END) AS checked_count,
  SUM(CASE WHEN tmdb_enrichment_error IS NOT NULL THEN 1 ELSE 0 END) AS terminal_error_count,
  COUNT(*) - SUM(CASE WHEN tmdb_enriched_at IS NOT NULL THEN 1 ELSE 0 END) AS remaining_unchecked_count
FROM tmdb_movies_staging;
