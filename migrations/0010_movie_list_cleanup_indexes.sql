-- Temporary/support indexes for chunked cleanup of rows we do not want in
-- movie_list_items search results.
--
-- The app's default poster-grid search assumes movie_list_items only contains
-- rows with poster_path and us_certification. These indexes let D1 find the
-- old rows that violate that rule without scanning the whole table repeatedly.
CREATE INDEX IF NOT EXISTS idx_movie_list_items_poster_cleanup
ON movie_list_items (poster_path, tmdb_id);

CREATE INDEX IF NOT EXISTS idx_movie_list_items_cert_cleanup
ON movie_list_items (us_certification, tmdb_id);
