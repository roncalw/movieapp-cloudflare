-- Count the generated search helper rows.
--
-- movie_rows:
--   The final movie_list_items source row count.
--
-- search_rows:
--   Total rows in movie_search_items. This will be larger than movie_rows
--   because search rows are expanded by genre/provider combinations.
--
-- no_filter_rows:
--   Sentinel rows where genre_id = 0 and provider_id = 0.
--   This should match movie_rows after a successful full rebuild.
--
-- default_usable_no_filter_rows:
--   Movies that pass the default app search behavior when no genre/provider
--   is selected:
--     has poster
--     has US certification
--     has at least one US watch provider
SELECT
  (SELECT COUNT(*) FROM movie_list_items) AS movie_rows,
  (SELECT COUNT(*) FROM movie_search_items) AS search_rows,
  (
    SELECT COUNT(*)
    FROM movie_search_items
    WHERE genre_id = 0
      AND provider_id = 0
      AND region = 'US'
  ) AS no_filter_rows,
  (
    SELECT COUNT(*)
    FROM movie_search_items
    WHERE genre_id = 0
      AND provider_id = 0
      AND region = 'US'
      AND has_poster = 1
      AND has_us_certification = 1
      AND has_us_watch_provider = 1
  ) AS default_usable_no_filter_rows;
