-- MovieApp production job-report evidence for pipeline date 2026-08-03.
--
-- Companion report:
--   support/jobs/2026-08-03-JobReport.md
--
-- This file is deliberately read-only. It does not insert, update, or delete
-- any production data. Run it from the Cloudflare project root with:
--
--   zsh support/run-sql-remote.sh support/sql/2026-08-03-job-report.sql
--
-- Time-zone rule for this dated report:
--   D1 stores UTC timestamps. New York observes EDT (UTC-4) on August 3,
--   2026, so the report converts UTC to EDT with SQLite's "-4 hours" modifier.
--   A winter report must use the correct EST offset rather than copying this
--   dated conversion blindly.

-- ============================================================================
-- Result set 1: every job in the scheduled August 3 verification pipeline
--
-- Only cron-triggered rows appear here. A later operational cache warm is
-- intentionally outside this dated report, so it cannot be mistaken for part
-- of the scheduled verification pipeline.
-- Helper steps do not have independent clock times; they run inside or at the
-- end of the Movie List build.
-- ============================================================================
WITH
expected_jobs(
  sort_order,
  display_name,
  job_name,
  expected_start_utc,
  expected_start_edt,
  expected_items_override
) AS (
  VALUES
    (1,  'IMDb Ratings',                     'imdb-ratings',                       '2026-08-03 05:00:00', 'Mon 8/3 1:00 AM EDT',  NULL),
    (2,  'TMDb Primary New Movies',          'tmdb-primary',                      '2026-08-03 07:00:00', 'Mon 8/3 3:00 AM EDT',  NULL),
    (3,  'TMDb New Movie Details',           'tmdb-new-movie-details',            '2026-08-03 09:00:00', 'Mon 8/3 5:00 AM EDT',  NULL),
    (4,  'TMDb Watch Providers',             'tmdb-provider-refresh',             '2026-08-03 11:00:00', 'Mon 8/3 7:00 AM EDT',  NULL),
    (5,  'TMDb Popularity',                  'tmdb-popularity-refresh',           '2026-08-03 13:00:00', 'Mon 8/3 9:00 AM EDT',  NULL),
    (6,  'Movie List Build',                 'movie-list-build',                  '2026-08-03 16:00:00', 'Mon 8/3 12:00 PM EDT', NULL),
    (7,  'Movie List Potential-Load Check',  'movie-list-potential-load-check',   NULL,                  'During Movie List',    NULL),
    (8,  'Movie Genres Apply Step',          'movie-genres-promote',              NULL,                  'During Movie List',    NULL),
    (9,  'Movie Providers Apply Step',       'movie-watch-providers-promote',     NULL,                  'During Movie List',    NULL),
    (10, 'Movie List Current-Count Snapshot','movie-list-current-count-snapshot', NULL,                  'After Movie List',     NULL),
    (11, 'Search Cache Warm',                'cache-warm-search',                 '2026-08-03 17:00:00', 'Mon 8/3 1:00 PM EDT', 3024),
    (12, 'Final Weekly Validation',          'weekly-import-validation',          '2026-08-03 19:00:00', 'Mon 8/3 3:00 PM EDT', 11)
),
ranked_runs AS (
  SELECT
    run.*,
    ROW_NUMBER() OVER (
      PARTITION BY run.job_name
      ORDER BY run.started_at DESC, run.job_run_id DESC
    ) AS run_rank
  FROM import_job_runs AS run
  WHERE run.trigger = 'cron'
    AND run.started_at >= '2026-08-03 00:00:00'
    AND run.started_at < '2026-08-04 00:00:00'
    AND run.job_name IN (SELECT job_name FROM expected_jobs)
),
latest_runs AS (
  SELECT *
  FROM ranked_runs
  WHERE run_rank = 1
),
potential_load AS (
  SELECT CAST(json_extract(result_json, '$.plCounts.count') AS INTEGER) AS expected_movie_count
  FROM latest_runs
  WHERE job_name = 'movie-list-potential-load-check'
),
job_report AS (
  SELECT
    expected.*,
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
    ELSE CAST((julianday(started_at) - julianday(expected_start_utc)) * 86400 AS INTEGER)
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
      '; provider relationships=' || provider_rows_inserted ||
      '; ad-supported movies=' || json_extract(result_json, '$.adsSupportedMovieCount')
    WHEN job_name = 'tmdb-popularity-refresh' THEN
      'staged=' || json_extract(result_json, '$.stagedRows') ||
      '; overlap=' || json_extract(result_json, '$.overlapRows') ||
      '; validation issues=' || json_extract(result_json, '$.validationIssueCount')
    WHEN job_name = 'movie-list-build' THEN
      'execution=' || COALESCE(json_extract(result_json, '$.executionMode'), 'unknown') ||
      '; popularity=' || COALESCE(json_extract(result_json, '$.popularitySync.updatedRows'), 0) ||
      '/' || COALESCE(json_extract(result_json, '$.popularitySync.candidateRows'), 0)
    WHEN job_name = 'movie-list-potential-load-check' THEN
      'current=' || json_extract(result_json, '$.ccCounts.count') ||
      '; potential=' || json_extract(result_json, '$.plCounts.count') ||
      '; threshold failures=' || json_array_length(json_extract(result_json, '$.drops'))
    WHEN job_name = 'movie-genres-promote' THEN
      'movies=' || processed_count || '; genre rows=' || updated_count
    WHEN job_name = 'movie-watch-providers-promote' THEN
      'movies=' || processed_count ||
      '; all availability relationships=' || updated_count ||
      '; ad-supported movies=' || json_extract(result_json, '$.adsSupportedMovieCount')
    WHEN job_name = 'movie-list-current-count-snapshot' THEN
      'production movies=' || processed_count ||
      '; subscription relationships=' || json_extract(result_json, '$.counts.watchProviderCount') ||
      '; ad-supported movies=' || json_extract(result_json, '$.counts.adsSupportedMovieCount')
    WHEN job_name = 'cache-warm-search' THEN
      'entries=' || processed_count || '/' || selected_count ||
      '; cached pages=' || updated_count
    WHEN job_name = 'weekly-import-validation' THEN
      'issues=' || json_extract(result_json, '$.issueCount') ||
      '; reconciled stalled runs=' || json_extract(result_json, '$.reconciledRunCount')
  END AS "Important result",
  last_error AS "Last error",
  job_run_id AS "Job run ID"
FROM job_report
ORDER BY sort_order;

-- ============================================================================
-- Result set 2: Movie List pre-build safety comparison
--
-- "Current" means the production count immediately before the build.
-- "Potential" means the count calculated from the staged inputs. The final
-- columns explain whether any decrease stayed inside its safety threshold.
-- ============================================================================
WITH
latest_check AS (
  SELECT result_json
  FROM import_job_runs
  WHERE job_name = 'movie-list-potential-load-check'
    AND trigger = 'cron'
    AND started_at >= '2026-08-03 00:00:00'
    AND started_at < '2026-08-04 00:00:00'
  ORDER BY started_at DESC, job_run_id DESC
  LIMIT 1
),
metrics(sort_order, metric, current_path, potential_path, threshold_percent) AS (
  VALUES
    (1,  'Movie count',                         '$.ccCounts.count',                              '$.plCounts.count',                              1.0),
    (2,  'IMDb rating count',                   '$.ccCounts.imdbRatingCount',                    '$.plCounts.imdbRatingCount',                    1.0),
    (3,  'IMDb vote count',                     '$.ccCounts.imdbVoteCount',                      '$.plCounts.imdbVoteCount',                      1.0),
    (4,  'Release date count',                  '$.ccCounts.releaseDateCount',                   '$.plCounts.releaseDateCount',                   1.0),
    (5,  'US certification count',              '$.ccCounts.certificationCount',                 '$.plCounts.certificationCount',                 1.0),
    (6,  'Popularity count',                    '$.ccCounts.popularityCount',                    '$.plCounts.popularityCount',                    1.0),
    (7,  'Genre row count',                     '$.ccCounts.genreCount',                         '$.plCounts.genreCount',                         1.0),
    (8,  'Movies with genres',                  '$.ccCounts.genrePerMovieCount',                 '$.plCounts.genrePerMovieCount',                 1.0),
    (9,  'Subscription-provider relationships','$.ccCounts.watchProviderCount',                 '$.plCounts.watchProviderCount',                10.0),
    (10, 'Movies with subscription providers', '$.ccCounts.watchProviderPerMovieCount',         '$.plCounts.watchProviderPerMovieCount',        10.0),
    (11, 'Movies with ad-supported streams',   '$.ccCounts.adsSupportedMovieCount',             '$.plCounts.adsSupportedMovieCount',            10.0),
    (12, 'All availability relationships',     '$.ccCounts.totalAvailabilityRelationshipCount', '$.plCounts.totalAvailabilityRelationshipCount',10.0),
    (13, 'Movies with any recorded availability','$.ccCounts.availabilityPerMovieCount',        '$.plCounts.availabilityPerMovieCount',         10.0)
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
-- Result set 3: issues recorded by the scheduled final validator
--
-- When there are no issue objects, the final UNION row explicitly says so.
-- ============================================================================
WITH
latest_validation AS (
  SELECT job_run_id, status, result_json
  FROM import_job_runs
  WHERE job_name = 'weekly-import-validation'
    AND trigger = 'cron'
    AND started_at >= '2026-08-03 00:00:00'
    AND started_at < '2026-08-04 00:00:00'
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
  'All required August 3 jobs',
  'none',
  latest_validation.status,
  'The scheduled final validation recorded no issues.',
  latest_validation.job_run_id
FROM latest_validation
WHERE NOT EXISTS (SELECT 1 FROM validation_issues);

-- ============================================================================
-- Result set 4: corrected provider safety-check verification
--
-- The scheduled safety check initially counted historical provider-staging
-- rows in addition to the August 3 provider refresh. Production promotion was
-- already correct because it used only the exact completed provider run. The
-- safety-count query was narrowed to that same run and verified manually. This
-- result set records that verification without treating it as another
-- scheduled pipeline job.
-- ============================================================================
SELECT
  'Corrected provider safety-count verification' AS "Verification",
  strftime('%Y-%m-%d %H:%M:%S', started_at, '-4 hours') || ' EDT' AS "Actual start",
  CASE
    WHEN ended_at IS NULL THEN NULL
    ELSE strftime('%Y-%m-%d %H:%M:%S', ended_at, '-4 hours') || ' EDT'
  END AS "Actual end",
  status AS "Status",
  selected_count AS "Selected",
  processed_count AS "Actual processed",
  processed_count - selected_count AS "Actual minus expected",
  json_extract(result_json, '$.ccCounts.watchProviderCount') AS "Live subscription relationships",
  json_extract(result_json, '$.plCounts.watchProviderCount') AS "Staged subscription relationships",
  json_extract(result_json, '$.ccCounts.adsSupportedMovieCount') AS "Live ad markers",
  json_extract(result_json, '$.plCounts.adsSupportedMovieCount') AS "Staged ad markers",
  json_array_length(json_extract(result_json, '$.drops')) AS "Safety failures",
  error_count AS "Errors",
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
WHERE trigger = 'manual'
  AND started_at >= '2026-08-03 16:00:00'
  AND started_at < '2026-08-04 00:00:00'
  AND job_name = 'movie-list-potential-load-check'
ORDER BY started_at DESC, job_run_id DESC
LIMIT 1;

-- ============================================================================
-- Result set 5: complete August 3 attempt history
--
-- If a job required a correction or retry, every attempt remains visible here.
-- A later success therefore cannot conceal an earlier failure.
-- ============================================================================
SELECT
  job_name AS "Database job name",
  trigger AS "Trigger",
  strftime('%Y-%m-%d %H:%M:%S', started_at, '-4 hours') || ' EDT' AS "Actual start",
  CASE
    WHEN ended_at IS NULL THEN NULL
    ELSE strftime('%Y-%m-%d %H:%M:%S', ended_at, '-4 hours') || ' EDT'
  END AS "Actual end",
  status AS "Status",
  selected_count AS "Selected",
  processed_count AS "Processed",
  updated_count AS "Updated",
  provider_rows_inserted AS "Provider rows inserted",
  error_count AS "Errors",
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
WHERE started_at >= '2026-08-03 05:00:00'
  AND started_at < '2026-08-04 00:00:00'
  AND job_name IN (
    'imdb-ratings',
    'tmdb-primary',
    'tmdb-new-movie-details',
    'tmdb-provider-refresh',
    'tmdb-popularity-refresh',
    'movie-list-build',
    'movie-list-potential-load-check',
    'movie-genres-promote',
    'movie-watch-providers-promote',
    'movie-list-current-count-snapshot',
    'cache-warm-search',
    'weekly-import-validation'
  )
ORDER BY started_at, job_run_id;

-- ============================================================================
-- Result set 6: final production data and active-job safeguards
--
-- The first row counts the live Movie List and provider relationships. The
-- second count confirms no applicable job was left queued or running.
-- ============================================================================
SELECT
  (SELECT COUNT(*) FROM movie_list_items) AS "Production movies",
  (SELECT COUNT(*)
   FROM movie_watch_providers
   WHERE region = 'US' AND provider_id <> -1) AS "Subscription relationships",
  (SELECT COUNT(DISTINCT tmdb_id)
   FROM movie_watch_providers
   WHERE region = 'US' AND provider_id <> -1) AS "Movies with subscriptions",
  (SELECT COUNT(*)
   FROM movie_watch_providers
   WHERE region = 'US' AND provider_id = -1) AS "Movies with ad-supported streams",
  (SELECT COUNT(*)
   FROM movie_watch_providers
   WHERE region = 'US') AS "All availability relationships",
  (SELECT COUNT(*)
   FROM tmdb_watch_provider_lookup
   WHERE provider_id = -1) AS "Internal marker incorrectly exposed in lookup",
  (SELECT COUNT(*)
   FROM import_job_runs
   WHERE status IN ('queued', 'running')) AS "Jobs still active";
