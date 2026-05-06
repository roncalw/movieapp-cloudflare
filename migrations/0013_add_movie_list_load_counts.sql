-- Migration number: 0013
--
-- One row per movie-list load day.
-- CC columns are current counts from movie_list_items.
-- PL columns are potential-load counts from the same source shape used to build movie_list_items.
CREATE TABLE IF NOT EXISTS movie_list_load_counts (
  load_date TEXT PRIMARY KEY,

  cc_count INTEGER NOT NULL DEFAULT 0,
  imdb_rating_cc_count INTEGER NOT NULL DEFAULT 0,
  imdb_vote_cc_count INTEGER NOT NULL DEFAULT 0,
  release_date_cc_count INTEGER NOT NULL DEFAULT 0,
  certification_cc_count INTEGER NOT NULL DEFAULT 0,
  popularity_cc_count INTEGER NOT NULL DEFAULT 0,
  cc_counted_at TEXT,

  pl_count INTEGER NOT NULL DEFAULT 0,
  imdb_rating_pl_count INTEGER NOT NULL DEFAULT 0,
  imdb_vote_pl_count INTEGER NOT NULL DEFAULT 0,
  release_date_pl_count INTEGER NOT NULL DEFAULT 0,
  certification_pl_count INTEGER NOT NULL DEFAULT 0,
  popularity_pl_count INTEGER NOT NULL DEFAULT 0,
  pl_counted_at TEXT,

  threshold REAL NOT NULL DEFAULT 1.0,
  job_stopped_reason TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_movie_list_load_counts_cc_counted_at
ON movie_list_load_counts (cc_counted_at);

