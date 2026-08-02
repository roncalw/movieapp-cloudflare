-- MovieApp weekly production job report evidence for pipeline date 2026-08-02.
--
-- This is the SQL companion to:
--   support/jobs/2026-08-02-JobReport.md
--
-- What this file returns:
--   1. Every expected scheduled job and Movie List helper step, including a
--      row when a job never started. After recovery, this result uses the
--      newest run for each job so it describes the final production state.
--   2. The Movie List potential-load safety comparison between the current
--      production data and the data the build expected to leave in production.
--   3. Every issue recorded by the final weekly validation job.
--   4. Every original and recovery attempt for the affected downstream jobs,
--      so a successful recovery cannot hide the failed morning attempt.
--
-- Time-zone rule for this dated report:
--   D1 stores these timestamps in UTC. New York was observing EDT, which was
--   UTC minus four hours, on August 1-2, 2026. The "-4 hours" conversions below
--   are deliberately specific to this dated report. A winter report must use
--   the correct EST offset instead of copying this offset blindly.
--
-- How to run this file after Wrangler production authorization is available:
--   zsh support/run-sql-remote.sh support/sql/2026-08-02-job-report.sql

-- ============================================================================
-- Result set 1: complete job execution table
-- ============================================================================
WITH
report_parameters AS (
  SELECT '2026-08-02' AS pipeline_date
),
expected_jobs(
  sort_order,
  display_name,
  job_name,
  expected_start_utc,
  expected_start_edt,
  expected_items_override
) AS (
  VALUES
    (1,  'IMDb Ratings',                     'imdb-ratings',                      '01:00:00', 'Sat 8/1 9:00 PM EDT',  NULL),
    (2,  'TMDb Primary New Movies',           'tmdb-primary',                     '03:00:00', 'Sat 8/1 11:00 PM EDT', NULL),
    (3,  'TMDb New Movie Details',            'tmdb-new-movie-details',           '05:00:00', 'Sun 8/2 1:00 AM EDT',  NULL),
    (4,  'TMDb Watch Providers',              'tmdb-provider-refresh',            '07:00:00', 'Sun 8/2 3:00 AM EDT',  NULL),
    (5,  'TMDb Popularity',                   'tmdb-popularity-refresh',          '09:00:00', 'Sun 8/2 5:00 AM EDT',  NULL),
    (6,  'Movie List Build',                  'movie-list-build',                 '12:00:00', 'Sun 8/2 8:00 AM EDT',  NULL),
    (7,  'Movie List Potential-Load Check',   'movie-list-potential-load-check',  NULL,       'During Movie List',       NULL),
    (8,  'Movie Genres Apply Step',           'movie-genres-promote',             NULL,       'During Movie List',       NULL),
    (9,  'Movie Watch Providers Apply Step',  'movie-watch-providers-promote',    NULL,       'During Movie List',       NULL),
    (10, 'Movie List Current-Count Snapshot', 'movie-list-current-count-snapshot',NULL,       'After Movie List succeeds',NULL),
    (11, 'Search Cache Warm',                 'cache-warm-search',                '13:00:00', 'Sun 8/2 9:00 AM EDT',  3024),
    (12, 'Final Weekly Validation',           'weekly-import-validation',         '15:00:00', 'Sun 8/2 11:00 AM EDT', 7)
),
ranked_runs AS (
  SELECT
    run.*,
    ROW_NUMBER() OVER (
      PARTITION BY run.job_name
      ORDER BY run.started_at DESC, run.job_run_id DESC
    ) AS run_rank
  FROM import_job_runs AS run
  CROSS JOIN report_parameters AS parameters
  WHERE run.trigger = 'cron'
    AND run.started_at >= parameters.pipeline_date || ' 00:00:00'
    AND run.started_at < datetime(parameters.pipeline_date, '+1 day')
    AND run.job_name IN (SELECT job_name FROM expected_jobs)
),
latest_runs AS (
  SELECT *
  FROM ranked_runs
  WHERE run_rank = 1
),
potential_load AS (
  SELECT
    CAST(json_extract(result_json, '$.plCounts.count') AS INTEGER) AS expected_movie_count
  FROM latest_runs
  WHERE job_name = 'movie-list-potential-load-check'
),
job_report AS (
  SELECT
    expected.sort_order,
    expected.display_name,
    expected.job_name,
    expected.expected_start_utc,
    expected.expected_start_edt,
    expected.expected_items_override,
    run.*,
    CASE
      WHEN expected.job_name = 'movie-list-current-count-snapshot'
        THEN (SELECT expected_movie_count FROM potential_load)
      WHEN expected.expected_items_override IS NOT NULL
        THEN expected.expected_items_override
      ELSE run.selected_count
    END AS expected_items
  FROM expected_jobs AS expected
  LEFT JOIN latest_runs AS run
    ON run.job_name = expected.job_name
)
SELECT
  sort_order AS "Order",
  display_name AS "Job",
  job_name AS "Database job name",
  expected_start_edt AS "Expected start",
  CASE
    WHEN started_at IS NULL THEN 'Did not run'
    ELSE strftime('%Y-%m-%d %H:%M:%S', started_at, '-4 hours') || ' EDT'
  END AS "Actual start",
  CASE
    WHEN ended_at IS NULL THEN NULL
    ELSE strftime('%Y-%m-%d %H:%M:%S', ended_at, '-4 hours') || ' EDT'
  END AS "Actual end",
  CASE
    WHEN expected_start_utc IS NULL OR started_at IS NULL THEN NULL
    ELSE CAST(
      (julianday(started_at) - julianday('2026-08-02 ' || expected_start_utc)) * 86400
      AS INTEGER
    )
  END AS "Start delay seconds",
  COALESCE(status, 'missing') AS "Status",
  expected_items AS "Expected items",
  processed_count AS "Actual processed",
  CASE
    WHEN expected_items IS NULL THEN NULL
    ELSE COALESCE(processed_count, 0) - expected_items
  END AS "Actual minus expected",
  CASE
    WHEN expected_items IS NULL OR expected_items = 0 THEN NULL
    ELSE printf('%.2f%%', COALESCE(processed_count, 0) * 100.0 / expected_items)
  END AS "Completion",
  updated_count AS "Updated count",
  provider_rows_inserted AS "Provider rows inserted",
  error_count AS "Errors",
  CASE
    WHEN job_run_id IS NULL THEN 'Not sent - job did not run'
    WHEN notification_sent_at IS NOT NULL AND notification_error IS NULL
      THEN 'Accepted by email server'
    WHEN notification_error IS NOT NULL
      THEN 'Failed: ' || notification_error
    ELSE 'No sent-email timestamp'
  END AS "Email",
  CASE
    WHEN job_name = 'imdb-ratings' THEN
      'staged=' || json_extract(result_json, '$.stagedRows') ||
      '; previous=' || json_extract(result_json, '$.previousCompletedFullRunRows') ||
      '; validation issues=' || json_extract(result_json, '$.validationIssueCount')
    WHEN job_name = 'tmdb-primary' THEN
      'upserted=' || json_extract(result_json, '$.rowsUpserted') ||
      '; newly inserted=' || json_extract(result_json, '$.rowsInserted')
    WHEN job_name = 'tmdb-new-movie-details' THEN
      'details updated=' || updated_count
    WHEN job_name = 'tmdb-provider-refresh' THEN
      'movies=' || processed_count ||
      '; provider rows=' || provider_rows_inserted
    WHEN job_name = 'tmdb-popularity-refresh' THEN
      'staged=' || json_extract(result_json, '$.stagedRows') ||
      '; overlap=' || json_extract(result_json, '$.overlapRows') ||
      '; validation issues=' || json_extract(result_json, '$.validationIssueCount')
    WHEN job_name = 'movie-list-build' THEN
      'execution=' || COALESCE(json_extract(result_json, '$.executionMode'), 'original single invocation') ||
      '; popularity=' || COALESCE(
        json_extract(result_json, '$.popularityUpdatedRows'),
        json_extract(result_json, '$.popularitySync.updatedRows'),
        0
      ) || '/' || COALESCE(
        json_extract(result_json, '$.popularityCandidateRows'),
        json_extract(result_json, '$.popularitySync.candidateRows'),
        0
      )
    WHEN job_name = 'movie-list-potential-load-check' THEN
      'current=' || json_extract(result_json, '$.ccCounts.count') ||
      '; potential=' || json_extract(result_json, '$.plCounts.count') ||
      '; threshold failures=' || json_array_length(json_extract(result_json, '$.drops'))
    WHEN job_name = 'movie-genres-promote' THEN
      'movies=' || processed_count || '; genre rows=' || updated_count
    WHEN job_name = 'movie-watch-providers-promote' THEN
      'movies=' || processed_count || '; provider rows=' || updated_count
    WHEN job_name = 'movie-list-current-count-snapshot' THEN
      'confirmed production Movie List count=' || processed_count
    WHEN job_name = 'cache-warm-search' THEN
      'processed=' || processed_count || '/' || selected_count ||
      '; cache writes=' || updated_count ||
      CASE
        WHEN json_extract(result_json, '$.skipReason') IS NULL THEN ''
        ELSE '; skip reason=' || json_extract(result_json, '$.skipReason')
      END
    WHEN job_name = 'weekly-import-validation' THEN
      'issues=' || json_extract(result_json, '$.issueCount') ||
      '; reconciled stalled runs=' || json_extract(result_json, '$.reconciledRunCount')
  END AS "Important result",
  last_error AS "Last error",
  job_run_id AS "Job run ID"
FROM job_report
ORDER BY sort_order;

-- ============================================================================
-- Result set 2: Movie List potential-load safety comparison
--
-- "Current" is the production count recorded before the build.
-- "Potential" is the count the build calculated from its staged inputs.
-- A positive difference is an increase. A negative difference is a decrease.
-- ============================================================================
WITH
latest_check AS (
  SELECT result_json
  FROM import_job_runs
  WHERE job_name = 'movie-list-potential-load-check'
    AND trigger = 'cron'
    AND started_at >= '2026-08-02 00:00:00'
    AND started_at < '2026-08-03 00:00:00'
  ORDER BY started_at DESC, job_run_id DESC
  LIMIT 1
),
metrics(sort_order, metric, current_path, potential_path, threshold_percent) AS (
  VALUES
    (1,  'Movie count',                 '$.ccCounts.count',                      '$.plCounts.count',                      1.0),
    (2,  'IMDb rating count',           '$.ccCounts.imdbRatingCount',            '$.plCounts.imdbRatingCount',            1.0),
    (3,  'IMDb vote count',             '$.ccCounts.imdbVoteCount',              '$.plCounts.imdbVoteCount',              1.0),
    (4,  'Release date count',          '$.ccCounts.releaseDateCount',           '$.plCounts.releaseDateCount',           1.0),
    (5,  'US certification count',      '$.ccCounts.certificationCount',         '$.plCounts.certificationCount',         1.0),
    (6,  'Popularity count',            '$.ccCounts.popularityCount',            '$.plCounts.popularityCount',            1.0),
    (7,  'Genre row count',             '$.ccCounts.genreCount',                 '$.plCounts.genreCount',                 1.0),
    (8,  'Movies with genres',          '$.ccCounts.genrePerMovieCount',         '$.plCounts.genrePerMovieCount',         1.0),
    (9,  'Watch provider row count',    '$.ccCounts.watchProviderCount',         '$.plCounts.watchProviderCount',        10.0),
    (10, 'Movies with watch providers', '$.ccCounts.watchProviderPerMovieCount', '$.plCounts.watchProviderPerMovieCount',10.0)
),
comparison AS (
  SELECT
    metrics.*,
    CAST(json_extract(latest_check.result_json, metrics.current_path) AS INTEGER) AS current_count,
    CAST(json_extract(latest_check.result_json, metrics.potential_path) AS INTEGER) AS potential_count
  FROM latest_check
  CROSS JOIN metrics
)
SELECT
  metric AS "Data measurement",
  current_count AS "Current",
  potential_count AS "Potential",
  potential_count - current_count AS "Potential minus current",
  CASE
    WHEN current_count = 0 THEN 'n/a'
    ELSE printf('%+.4f%%', (potential_count - current_count) * 100.0 / current_count)
  END AS "Percent difference",
  printf('%.2f%%', threshold_percent) AS "Allowed decrease",
  CASE
    WHEN potential_count >= current_count THEN 'Passed - unchanged or increased'
    WHEN current_count = 0 THEN 'Passed - no prior baseline'
    WHEN ((current_count - potential_count) * 100.0 / current_count) <= threshold_percent
      THEN 'Passed - decrease inside threshold'
    ELSE 'Failed - decrease exceeds threshold'
  END AS "Safety result"
FROM comparison
ORDER BY sort_order;

-- ============================================================================
-- Result set 3: issues recorded by final weekly validation
--
-- Several rows can describe different symptoms of one failed job. For example,
-- status failure, an error count, and a processed-count mismatch are three
-- checks describing the same Movie List build rather than three separate jobs.
-- ============================================================================
WITH latest_validation AS (
  SELECT job_run_id, status, result_json
  FROM import_job_runs
  WHERE job_name = 'weekly-import-validation'
    AND trigger = 'cron'
    AND started_at >= '2026-08-02 00:00:00'
    AND started_at < '2026-08-03 00:00:00'
  ORDER BY started_at DESC, job_run_id DESC
  LIMIT 1
),
validation_issues AS (
  SELECT
    json_extract(issue.value, '$.jobName') AS job_name,
    json_extract(issue.value, '$.code') AS issue_code,
    json_extract(issue.value, '$.status') AS issue_status,
    json_extract(issue.value, '$.message') AS explanation,
    json_extract(issue.value, '$.jobRunId') AS affected_job_run_id
  FROM latest_validation
  CROSS JOIN json_each(latest_validation.result_json, '$.issues') AS issue
)
SELECT
  job_name AS "Job",
  issue_code AS "Issue code",
  issue_status AS "Status",
  explanation AS "Explanation",
  affected_job_run_id AS "Job run ID"
FROM validation_issues
UNION ALL
SELECT
  'All required weekly jobs' AS "Job",
  'none' AS "Issue code",
  latest_validation.status AS "Status",
  'The final validation recorded no issues.' AS "Explanation",
  latest_validation.job_run_id AS "Job run ID"
FROM latest_validation
WHERE NOT EXISTS (SELECT 1 FROM validation_issues);

-- ============================================================================
-- Result set 4: original and recovery attempts for affected downstream jobs
--
-- Result set 1 intentionally shows the newest run for each job because that is
-- the current production state. This result keeps the complete incident trail:
-- the original Movie List failure, skipped cache, failed validation, each
-- recovery attempt, the successful snapshot, and the final successful checks.
-- ============================================================================
SELECT
  CASE job_name
    WHEN 'movie-list-build' THEN 'Movie List Build'
    WHEN 'movie-list-current-count-snapshot' THEN 'Movie List Current-Count Snapshot'
    WHEN 'cache-warm-search' THEN 'Search Cache Warm'
    WHEN 'weekly-import-validation' THEN 'Final Weekly Validation'
    ELSE job_name
  END AS "Job",
  trigger AS "Trigger",
  strftime('%Y-%m-%d %H:%M:%S', started_at, '-4 hours') || ' EDT' AS "Actual start",
  CASE
    WHEN ended_at IS NULL THEN NULL
    ELSE strftime('%Y-%m-%d %H:%M:%S', ended_at, '-4 hours') || ' EDT'
  END AS "Actual end",
  status AS "Status",
  selected_count AS "Expected or selected",
  processed_count AS "Actual processed",
  processed_count - selected_count AS "Actual minus expected",
  updated_count AS "Updated or output",
  error_count AS "Errors",
  json_extract(COALESCE(result_json, '{}'), '$.phase') AS "Last phase",
  json_extract(COALESCE(result_json, '{}'), '$.issueCount') AS "Validation issues",
  CASE
    WHEN notification_sent_at IS NOT NULL AND notification_error IS NULL
      THEN 'Accepted by email server'
    WHEN notification_error IS NOT NULL
      THEN 'Failed: ' || notification_error
    ELSE 'No sent-email timestamp'
  END AS "Email",
  last_error AS "Last error",
  job_run_id AS "Job run ID"
FROM import_job_runs
WHERE started_at >= '2026-08-02 00:00:00'
  AND started_at < '2026-08-03 00:00:00'
  AND job_name IN (
    'movie-list-build',
    'movie-list-current-count-snapshot',
    'cache-warm-search',
    'weekly-import-validation'
  )
ORDER BY started_at, job_run_id;
