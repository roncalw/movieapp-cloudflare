-- Search helper table for fast MovieApp list searches.
--
-- movie_list_items remains the app-facing final movie table.
-- movie_search_items is an indexable search map built from:
--   movie_list_items
--   movie_genres
--   movie_watch_providers
--
-- The API should return only:
--   tmdb_id, title, poster_path, imdb_rating
--
-- The other columns exist so D1 can filter and sort without joining the
-- normalized genre/provider tables for every user search.
--
-- Sentinel values:
--   genre_id = 0
--     "no specific genre filter"
--
--   provider_id = 0, region = 'US'
--     "no specific provider filter"
--
-- Those sentinel rows let one search table support:
--   no genre + no provider
--   genre + no provider
--   no genre + provider
--   genre + provider
CREATE TABLE IF NOT EXISTS movie_search_items (
  genre_id INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  region TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  poster_path TEXT,
  release_date TEXT,
  us_certification TEXT,
  has_us_certification INTEGER NOT NULL,
  has_us_watch_provider INTEGER NOT NULL,
  has_poster INTEGER NOT NULL,
  imdb_rating REAL,
  imdb_vote_count INTEGER,
  popularity REAL NOT NULL DEFAULT 0,
  last_refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (genre_id, provider_id, region, tmdb_id)
);

-- IMDb-rating searches.
--
-- This supports the default app shape:
--   selected genre/provider/cert filters
--   hide missing poster/cert/provider by default
--   sort by IMDb rating, then IMDb vote count
--   cursor page by the same ordered fields
CREATE INDEX IF NOT EXISTS idx_movie_search_items_imdb
ON movie_search_items (
  genre_id,
  region,
  provider_id,
  has_poster,
  has_us_certification,
  has_us_watch_provider,
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id
);

-- IMDb-rating searches when the user selected exact certifications such as
-- PG-13 or R.
CREATE INDEX IF NOT EXISTS idx_movie_search_items_cert_imdb
ON movie_search_items (
  genre_id,
  region,
  provider_id,
  us_certification,
  has_poster,
  has_us_certification,
  has_us_watch_provider,
  imdb_rating DESC,
  imdb_vote_count DESC,
  tmdb_id
);

-- IMDb vote-count threshold filtering.
CREATE INDEX IF NOT EXISTS idx_movie_search_items_imdb_vote_count
ON movie_search_items (
  genre_id,
  region,
  provider_id,
  imdb_vote_count
);

-- Popularity searches.
CREATE INDEX IF NOT EXISTS idx_movie_search_items_popularity
ON movie_search_items (
  genre_id,
  region,
  provider_id,
  has_poster,
  has_us_certification,
  has_us_watch_provider,
  popularity DESC,
  tmdb_id
);

-- Popularity searches when the user selected exact certifications.
CREATE INDEX IF NOT EXISTS idx_movie_search_items_cert_popularity
ON movie_search_items (
  genre_id,
  region,
  provider_id,
  us_certification,
  has_poster,
  has_us_certification,
  has_us_watch_provider,
  popularity DESC,
  tmdb_id
);

-- Cleanup by movie id during rebuilds.
CREATE INDEX IF NOT EXISTS idx_movie_search_items_tmdb_id
ON movie_search_items (tmdb_id);
