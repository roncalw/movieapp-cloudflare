-- Keep each IMDb file delivery separate until that exact delivery has finished
-- and passed validation. The existing imdb_ratings_staging table remains in
-- place during the transition so the current production Movie List build can
-- continue to operate while this table receives its first complete load.
CREATE TABLE IF NOT EXISTS imdb_ratings_staging_by_run (
  load_run_id TEXT NOT NULL,
  imdb_id TEXT NOT NULL,
  average_rating REAL,
  num_votes INTEGER,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (load_run_id, imdb_id)
) WITHOUT ROWID;
