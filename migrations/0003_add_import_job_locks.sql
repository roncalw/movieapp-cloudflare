-- Migration number: 0003
--
-- Prevent overlapping scheduled/manual import jobs.
--
-- Cron can fire while a previous enrichment run is still working.
-- This table lets the Worker claim a short-lived lock before it starts.
-- If a Worker crashes, lock_expires_at lets a later run recover.
CREATE TABLE IF NOT EXISTS import_job_locks (
  job_name TEXT PRIMARY KEY,
  locked_at TEXT NOT NULL,
  lock_expires_at TEXT NOT NULL,
  owner TEXT NOT NULL
);
