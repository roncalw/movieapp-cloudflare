-- Lightweight watch query for movie_search_items rebuild progress while the
-- manual endpoint or scheduled cron is running.
--
-- This intentionally reads import_job_runs and import_job_locks only.
-- Do not count movie_search_items repeatedly while the rebuild is inserting;
-- that can contend with the large D1 write and contribute to timeout/1102
-- errors.
--
-- How to read it:
--   selected_count
--     Source movie_list_items rows selected for the build.
--
--   processed_count
--     Source movie_list_items rows already processed into search rows.
--
--   source_progress_pct
--     processed_count / selected_count as a percent.
--
-- After the build completes, use:
--   remote-watch-movie-search-counts
-- for full movie_search_items row counts.
--
--   lock_owner / lock_expires_at
--     Shows whether the movie-search-build lock is currently held.
SELECT
  run.job_run_id,
  run.status,
  run.trigger,
  state.status AS build_status,
  state.pass_name,
  state.last_tmdb_id,
  state.processed_count AS build_processed_count,
  state.selected_count AS build_selected_count,
  run.selected_count,
  run.processed_count,
  run.updated_count,
  ROUND(
    CASE
      WHEN state.selected_count IS NULL OR state.selected_count = 0 THEN 0
      ELSE 100.0 * state.processed_count / state.selected_count
    END,
    2
  ) AS source_progress_pct,
  run.started_at,
  run.last_progress_at,
  run.ended_at,
  run.last_error,
  lock.owner AS lock_owner,
  lock.locked_at,
  lock.lock_expires_at
FROM (
  SELECT
    job_run_id,
    status,
    trigger,
    selected_count,
    processed_count,
    updated_count,
    started_at,
    last_progress_at,
    ended_at,
    last_error
  FROM import_job_runs
  WHERE job_name = 'movie-search-build'
  ORDER BY started_at DESC
  LIMIT 1
) AS run
LEFT JOIN import_job_locks AS lock
  ON lock.job_name = 'movie-search-build'
LEFT JOIN movie_search_build_state AS state
  ON state.job_name = 'movie-search-build';
