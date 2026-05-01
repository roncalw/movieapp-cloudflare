-- Migration number: 0004
--
-- Track long import/enrichment jobs outside the transient Worker logs.
-- Cloudflare Observability can batch console logs, so this table gives us
-- a D1-backed progress view while queue consumers are still running.
CREATE TABLE IF NOT EXISTS import_job_runs (
  job_run_id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  selected_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  provider_rows_inserted INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  last_progress_at TEXT NOT NULL,
  ended_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_job_runs_job_status
ON import_job_runs (job_name, status, started_at);
