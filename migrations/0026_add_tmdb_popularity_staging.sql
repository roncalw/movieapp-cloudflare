-- Store complete TMDb popularity file loads separately by job run.
--
-- The MovieApp never queries this table during customer searches. A completed
-- movie-list build copies changed values into movie_list_items.popularity,
-- where the existing covering indexes can serve Advanced Search directly.
--
-- Keeping load_run_id in the primary key allows the previous validated file
-- and a new in-progress file to coexist. An interrupted import therefore
-- cannot overwrite the source rows used by the last successful movie-list
-- build.
CREATE TABLE IF NOT EXISTS tmdb_movie_popularity_staging (
  load_run_id TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  popularity REAL NOT NULL CHECK (popularity >= 0),
  source_export_date TEXT NOT NULL,
  staged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (load_run_id, tmdb_id)
);
