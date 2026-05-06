-- Migration number: 0012
--
-- Keep job-specific summary fields without adding a new column for every job.
-- Examples:
--   tmdb-primary: pagesRead, windowsSplit, stopReason
--   movie-list-build: movieListCount, deletedRows, chunk sizes
ALTER TABLE import_job_runs ADD COLUMN result_json TEXT;
