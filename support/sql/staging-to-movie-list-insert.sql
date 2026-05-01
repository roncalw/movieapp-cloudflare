-- Build the final MovieApp list table from the TMDB and IMDb staging tables.
--
-- BIG WARNING:
--   This file starts with:
--
--     DELETE FROM movie_list_items;
--
--   Do not use this saved SQL file as the preferred production rebuild path
--   unless you are intentionally doing a manual support operation and are
--   comfortable with the risk.
--
--   The safer production path is the Worker endpoint / cron path:
--
--     GET /admin/import/movie-list/rebuild-manual
--
--   or the scheduled Final Table cron job.
--
--   Why that is safer:
--     The Worker code runs the DELETE and INSERT together through:
--
--       env.DB.batch([
--         DELETE statement,
--         INSERT statement
--       ])
--
--     Cloudflare documents D1 batch statements as transactional: if one
--     statement fails, the batch aborts/rolls back the sequence.
--
--   This SQL file is run through Wrangler as a multi-statement --command.
--   Do not assume that has the same rollback safety as the Worker batch path
--   unless you have explicitly verified that behavior.
--
-- Why this saved SQL file exists:
--   This is mostly a manual support / debugging script, not the final long-term
--   automation plan.
--
--   Down the road, the real refresh should be automated after the upstream
--   staging jobs finish in this order:
--
--     1. IMDb ratings staging refresh
--     2. TMDB primary staging refresh
--     3. TMDB enrichment refresh
--     4. movie_list_items rebuild from the completed staging tables
--
--   This file is still useful because it gives us a known-good, runnable version
--   of step 4 while we are testing the join rules, checking row counts, or
--   recovering manually before the final scheduled orchestration exists.
--
-- This is the production-facing rebuild.
--
-- It clears movie_list_items first, then inserts the rows that currently
-- qualify. That matters for recurring refreshes. If a row used to qualify but
-- later gets a terminal TMDB enrichment error, a plain INSERT OR REPLACE would
-- not remove the old final-table row. Rebuilding from staging keeps the final
-- table aligned with the current rules.
--
-- It intentionally excludes TMDB rows with terminal enrichment errors.
-- Example: TMDB discover/movie can return an ID, but /movie/{id} can later
-- return 404 Not Found. Those rows are marked in tmdb_enrichment_error and
-- should not appear in the app's final movie list.
--
-- It also requires tmdb_enriched_at to be populated so the final movie row
-- only comes from TMDB rows that have gone through Step 9B enrichment.
--
-- The IMDb join is intentionally a LEFT JOIN.
-- That keeps enriched TMDB movies even when the IMDb ratings file has no
-- matching rating row. In that case imdb_rating and imdb_vote_count are NULL,
-- but the movie can still appear in MovieApp results.
DELETE FROM movie_list_items;

INSERT OR REPLACE INTO movie_list_items (
  tmdb_id,
  title,
  poster_path,
  release_date,
  us_certification,
  imdb_rating,
  imdb_vote_count,
  popularity,
  last_refreshed_at
)
SELECT
  tmdb.tmdb_id,
  tmdb.title,
  tmdb.poster_path,
  tmdb.release_date,
  tmdb.us_certification,
  imdb.average_rating AS imdb_rating,
  imdb.num_votes AS imdb_vote_count,
  COALESCE(tmdb.popularity, 0) AS popularity,
  CURRENT_TIMESTAMP AS last_refreshed_at
FROM tmdb_movies_staging AS tmdb
LEFT JOIN imdb_ratings_staging AS imdb
  ON imdb.imdb_id = tmdb.imdb_id
WHERE tmdb.tmdb_enriched_at IS NOT NULL
  AND tmdb.tmdb_enrichment_error IS NULL;
