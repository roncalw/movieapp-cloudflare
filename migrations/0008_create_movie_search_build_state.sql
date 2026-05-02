-- Stores resumable progress for the movie_search_items rebuild.
--
-- The search table is too expensive to rebuild in one Worker request on D1.
-- This state row lets each manual/cron invocation build one bounded range,
-- then the next invocation continues from the saved pass and tmdb_id.
CREATE TABLE IF NOT EXISTS movie_search_build_state (
  job_name TEXT PRIMARY KEY,
  build_marker TEXT NOT NULL,
  status TEXT NOT NULL,
  pass_name TEXT NOT NULL,
  last_tmdb_id INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
