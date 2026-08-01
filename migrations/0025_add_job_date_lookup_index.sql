-- Dependency checks now read only the newest run for one job on one pipeline
-- date. This index lets D1 find that small date-bounded set without examining
-- older runs for the same job.
CREATE INDEX IF NOT EXISTS idx_import_job_runs_job_started_at
ON import_job_runs (job_name, started_at DESC);
