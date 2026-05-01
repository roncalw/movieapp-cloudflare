SELECT
  job_run_id,
  status,
  selected_count,
  queued_count,
  processed_count,
  updated_count,
  error_count,
  provider_rows_inserted,
  started_at,
  last_progress_at,
  ended_at,
  ROUND((julianday(last_progress_at) - julianday(started_at)) * 86400.0, 1) AS elapsed_seconds,
  last_error
FROM import_job_runs
ORDER BY started_at DESC
LIMIT 5;
