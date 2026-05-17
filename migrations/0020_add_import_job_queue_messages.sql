-- Migration number: 0020
--
-- Track completed queue messages once per job run so replayed Cloudflare
-- queue deliveries cannot double-count import progress.
CREATE TABLE IF NOT EXISTS import_job_queue_messages (
  job_run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  provider_rows_inserted INTEGER NOT NULL DEFAULT 0,
  tmdb_id_not_found_skipped_count INTEGER NOT NULL DEFAULT 0,
  cache_page_count INTEGER NOT NULL DEFAULT 0,
  cache_first_request_count INTEGER NOT NULL DEFAULT 0,
  cache_retry_request_count INTEGER NOT NULL DEFAULT 0,
  cache_hit_count INTEGER NOT NULL DEFAULT 0,
  cache_miss_count INTEGER NOT NULL DEFAULT 0,
  cache_retry_hit_count INTEGER NOT NULL DEFAULT 0,
  cache_error_count INTEGER NOT NULL DEFAULT 0,
  genre_key TEXT,
  entry_name TEXT,
  last_error TEXT,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_run_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_import_job_queue_messages_job_run
ON import_job_queue_messages (job_run_id, completed_at);
