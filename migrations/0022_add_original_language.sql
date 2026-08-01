-- Store TMDB's original language on both the authoritative staging row and
-- the denormalized row used by MovieApp searches.
--
-- Existing movie data is not replaced. SQLite gives every existing row NULL
-- for each new column until the narrow backfill populates that one field.
ALTER TABLE tmdb_movies_staging
ADD COLUMN original_language TEXT;

ALTER TABLE movie_list_items
ADD COLUMN original_language TEXT;

-- This small lookup converts TMDB language codes such as "en" and "ko" into
-- customer-facing English and native-language names. Movie searches never
-- join this table; it is used only to build language filter choices.
CREATE TABLE IF NOT EXISTS tmdb_original_language_lookup (
  language_code TEXT PRIMARY KEY,
  english_name TEXT NOT NULL,
  native_name TEXT,
  is_filter_enabled INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  last_refreshed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
