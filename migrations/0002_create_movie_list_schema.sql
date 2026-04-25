-- Migration number: 0002 	 2026-04-23T23:05:04.839Z
--
-- IMDb ratings staging table.
--
-- This table stores rows from IMDb's title.ratings.tsv file.
--
-- imdb_id maps to IMDb's tconst column.
-- Example:
--   tt0133093
--
-- We keep this as a staging table because IMDb ratings can be refreshed
-- without changing the final app-facing movie_list_items table shape.
CREATE TABLE IF NOT EXISTS imdb_ratings_staging (
  imdb_id TEXT PRIMARY KEY,
  average_rating REAL NOT NULL,
  num_votes INTEGER NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TMDB movie staging table.
--
-- This table stores the narrow TMDB movie data needed to build the
-- final movie list table.
--
-- tmdb_id is the TMDB movie id.
-- imdb_id is the external IMDb id that lets us join to imdb_ratings.
-- us_certification supports the current MovieApp Rating filter.
--
-- poster_path is preferred over storing the full image URL because TMDB
-- image base URLs and sizes can be selected later by the API/app.
CREATE TABLE IF NOT EXISTS tmdb_movies_staging (
  tmdb_id INTEGER PRIMARY KEY,
  imdb_id TEXT,
  title TEXT NOT NULL,
  poster_path TEXT,
  release_date TEXT,
  us_certification TEXT,
  popularity REAL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Movie-to-genre join table.
--
-- One movie can have many genres.
-- One genre can belong to many movies.
--
-- The MovieApp already has the genre labels in:
--   /Users/croncallo/repo/MovieApp/src/components/ui/movieSearchFieldUtils.ts
--
-- So this table only needs ids for filtering.
CREATE TABLE IF NOT EXISTS movie_genres (
  tmdb_id INTEGER NOT NULL,
  genre_id INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, genre_id)
);

-- Movie-to-watch-provider join table.
--
-- One movie can be on many providers.
-- One provider can have many movies.
-- TMDB calls streaming services "watch providers".
--
-- region lets us filter to the country we care about.
-- For now, this project will usually use:
--   US
--
-- This table does not store monetization_type yet.
--
-- TMDB can separate providers into:
--   flatrate
--   rent
--   buy
--   ads
--   free
--
-- For the MovieApp list page, the first useful filter is:
--   "show movies available on this streamer in this region"
--
-- So the starter implementation will only import TMDB's flatrate
-- providers for the US region.
--
-- The MovieApp already has the streamer labels and image assets in:
--   /Users/croncallo/repo/MovieApp/src/components/ui/movieSearchFieldUtils.ts
--
-- So this table only needs ids for filtering.
--
-- If the app later needs separate filters for Rent, Buy, Free, or Ads,
-- add monetization_type back as a real filter column.
CREATE TABLE IF NOT EXISTS movie_watch_providers (
  tmdb_id INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  region TEXT NOT NULL,
  PRIMARY KEY (tmdb_id, provider_id, region)
);

-- Final app-facing movie search/list table.
--
-- This is the main table the Worker endpoint should query for the
-- MovieApp search/list page.
--
-- It is intentionally narrow.
-- It is not meant to replace the full movie detail query.
CREATE TABLE IF NOT EXISTS movie_list_items (
  tmdb_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  poster_path TEXT NOT NULL,
  release_date TEXT NOT NULL,
  us_certification TEXT,
  imdb_rating REAL NOT NULL,
  imdb_vote_count INTEGER NOT NULL,
  popularity REAL NOT NULL DEFAULT 0,
  last_refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for sorting by IMDb rating.
--
-- This supports:
--   ORDER BY imdb_rating DESC
CREATE INDEX IF NOT EXISTS idx_movie_list_items_imdb_rating
ON movie_list_items (imdb_rating DESC);

-- Index for IMDb vote-count threshold filtering.
--
-- This supports:
--   WHERE imdb_vote_count >= 500
CREATE INDEX IF NOT EXISTS idx_movie_list_items_imdb_vote_count
ON movie_list_items (imdb_vote_count);

-- Index for release date sorting/filtering.
--
-- SQLite/D1 can index TEXT columns.
--
-- D1 is built on SQLite, and SQLite does not have a separate DATE column
-- type like some other databases.
--
-- The normal SQLite pattern is to store dates as ISO text:
--   YYYY-MM-DD
--
-- That format sorts correctly as text.
--
-- Example:
--   1999-03-31
--   2008-07-18
--   2024-01-01
--
-- Alphabetical order and calendar order match because the biggest date
-- part comes first:
--   year, then month, then day
CREATE INDEX IF NOT EXISTS idx_movie_list_items_release_date
ON movie_list_items (release_date DESC);

-- Index for the current MovieApp Rating filter.
--
-- This supports:
--   WHERE us_certification = 'PG-13'
CREATE INDEX IF NOT EXISTS idx_movie_list_items_us_certification
ON movie_list_items (us_certification);

-- Index for the current MovieApp Popularity sort option.
--
-- This is kept only because the existing search page has a Popularity sort.
-- If that sort option is removed from MovieApp, remove this column and index.
CREATE INDEX IF NOT EXISTS idx_movie_list_items_popularity
ON movie_list_items (popularity DESC);

-- Index for genre filtering.
--
-- The MovieApp UI can send multiple selected genre ids.
--
-- SQL still checks those ids as a set of individual genre_id values.
--
-- Example:
--   WHERE genre_id IN (28, 35, 18)
--
-- This index helps D1 quickly find movie ids for each selected genre id.
CREATE INDEX IF NOT EXISTS idx_movie_genres_genre_id
ON movie_genres (genre_id, tmdb_id);

-- Index for provider/streamer filtering.
--
-- The MovieApp UI can send multiple selected streamer/provider ids.
--
-- SQL still checks those ids as a set of individual provider_id values.
--
-- Example:
--   WHERE region = 'US'
--     AND provider_id IN (8, 15, 337)
--
-- This index helps D1 quickly find movie ids for each selected provider id
-- within the selected region.
CREATE INDEX IF NOT EXISTS idx_movie_watch_providers_filter
ON movie_watch_providers (region, provider_id, tmdb_id);

-- Index for joining IMDb ratings to TMDB movies by IMDb id.
CREATE INDEX IF NOT EXISTS idx_tmdb_movies_staging_imdb_id
ON tmdb_movies_staging (imdb_id);
