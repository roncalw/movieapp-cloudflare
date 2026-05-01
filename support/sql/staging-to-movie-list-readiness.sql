SELECT
  COUNT(*) AS tmdb_rows,
  SUM(CASE WHEN tmdb_enriched_at IS NOT NULL THEN 1 ELSE 0 END) AS tmdb_checked_rows,
  SUM(
    CASE
      WHEN (
        tmdb_enriched_at IS NULL
        OR tmdb_enriched_at < datetime('now', '-7 days')
      )
      AND tmdb_enrichment_error IS NULL
      THEN 1
      ELSE 0
    END
  ) AS tmdb_rows_needing_enrichment,
  SUM(CASE WHEN tmdb_enrichment_error IS NOT NULL THEN 1 ELSE 0 END) AS tmdb_terminal_error_rows,
  SUM(CASE WHEN imdb_id IS NOT NULL THEN 1 ELSE 0 END) AS tmdb_rows_with_imdb_id,
  SUM(CASE WHEN imdb.imdb_id IS NOT NULL THEN 1 ELSE 0 END) AS rows_with_matching_imdb_rating,
  SUM(
    CASE
      WHEN tmdb.tmdb_enriched_at IS NOT NULL
       AND tmdb.tmdb_enrichment_error IS NULL
       AND imdb.imdb_id IS NULL
      THEN 1
      ELSE 0
    END
  ) AS movie_list_rows_without_imdb_rating,
  SUM(
    CASE
      WHEN tmdb.tmdb_enriched_at IS NOT NULL
       AND tmdb.tmdb_enrichment_error IS NULL
      THEN 1
      ELSE 0
    END
  ) AS movie_list_candidate_rows,
  (
    SELECT COUNT(*)
    FROM movie_list_items
  ) AS current_movie_list_rows
FROM tmdb_movies_staging AS tmdb
LEFT JOIN imdb_ratings_staging AS imdb
  ON imdb.imdb_id = tmdb.imdb_id;
