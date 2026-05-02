-- Quick count/check for the final app-facing movie_list_items table.
--
-- Use this when you only want to confirm the final table still has the
-- expected row count after a rebuild or accidental rerun.
SELECT
  COUNT(*) AS movie_list_count,
  COUNT(DISTINCT tmdb_id) AS distinct_tmdb_count,
  MIN(release_date) AS min_release_date,
  MAX(release_date) AS max_release_date,
  SUM(CASE WHEN title IS NULL OR title = '' THEN 1 ELSE 0 END)
    AS missing_title_count,
  SUM(CASE WHEN imdb_rating IS NULL THEN 1 ELSE 0 END)
    AS missing_imdb_rating_count,
  MAX(last_refreshed_at) AS latest_refreshed_at
FROM movie_list_items;
