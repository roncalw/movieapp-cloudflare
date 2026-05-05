# MovieApp On Cloudflare

## Table Of Contents

- [Summary](#summary)
- [Current Repos](#current-repos)
- [Important Data Sources](#important-data-sources)
- [Target Database Design](#target-database-design)
- [Search Page Field Audit](#search-page-field-audit)
- [Implementation Steps](#implementation-steps)
  - Migration Strategy
    - [X] [Step 0: Migration Strategy](#step-0-migration-strategy) - <span class="diagram">DIAGRAM</span>
  - Database Setup
    - [X] [Step 1: Create The Migration File](#step-1-create-the-migration-file)
    - [X] [Step 2: Paste The Database SQL](#step-2-paste-the-database-sql)
    - [X] [Step 3: Apply The Migration](#step-3-apply-the-migration)
  - IMDb Stream Proof
    - [X] [Step 4: Prove Cloudflare Can Stream Read The IMDb File](#step-4-prove-cloudflare-can-stream-read-the-imdb-file)
  - IMDb Setup And Load Into Staging
    - [X] [Step 5: DB Workflow IMDb Queue Job](#step-5-db-workflow-imdb-queue-job) - <span class="diagram">DIAGRAM</span>
    - [X] [Step 6: Wire Up The IMDb Queue](#step-6-wire-up-the-imdb-queue)
    - [X] [Step 7: Load The IMDb Ratings Staging Table](#step-7-load-the-imdb-ratings-staging-table)
  - TMDB Setup And Load Into Staging
    - [ ] [Step 8: Add The TMDB API Key As A Secret](#step-8-add-the-tmdb-api-key-as-a-secret)
    - [ ] [Step 9: Load The TMDB Staging Tables](#step-9-load-the-tmdb-staging-tables)
  - Final Movie List Build And Filter Checks
    - [ ] [Step 10: Build The Final Movie List Table](#step-10-build-the-final-movie-list-table)
    - [ ] [Step 11: Test Genre Filtering](#step-11-test-genre-filtering)
    - [ ] [Step 12: Test Streamer Filtering](#step-12-test-streamer-filtering)
  - Future Worker API
    - [ ] [Step 13: Sketch The Future Movies Search Endpoint](#step-13-sketch-the-future-movies-search-endpoint)
    - [ ] [Step 14: Sketch The Future Movies Search Query](#step-14-sketch-the-future-movies-search-query)
  - Rollout Back Into MovieApp
    - [ ] [Step 15: Scale The Cloudflare Jobs Carefully](#step-15-scale-the-cloudflare-jobs-carefully)
    - [ ] [Step 16: Hook This Back Into MovieApp](#step-16-hook-this-back-into-movieapp)
  - Reference
    - [ ] [Step 17: Recommended Build Order](#step-17-recommended-build-order)
    - [ ] [Step 18: Useful Commands](#step-18-useful-commands)
    - [ ] [Step 19: Data Usage Notes](#step-19-data-usage-notes)
    - [ ] [Step 20: Scheduled Refresh Cron Jobs](#step-20-scheduled-refresh-cron-jobs)
      - [ ] [Step 20-4: Manual Cron Testing](#step-20-4-manual-testing)
    - [ ] [Step 21: Caching](#step-21-caching)
    - [ ] [Step 22: MyD1 SQL Client](#step-22-myd1-sql-client)

## Summary

This plan replaces the slow live join from `MoviesToIMDBJoinTest` with a prebuilt Cloudflare D1 movie list table.

The proof-of-concept screen currently does this while the user is waiting:

```text
TMDB search results
-> TMDB external_ids lookup
-> IMDb/OMDb-style rating lookup
-> render poster/title/rating
```

That proved the join idea works, but it also proved that doing the join live is too slow for a normal search page.

The better version is:

```text
TMDB movie data
+ TMDB imdb_id mapping
+ IMDb title.ratings.tsv
= prebuilt movie_list_items table in Cloudflare D1
```

Then the app can do this:

```text
MovieApp search/list page
-> Cloudflare Worker endpoint
-> D1 movie_list_items query
-> immediate poster grid with IMDb rating and vote count
```

Important architecture rule:

```text
Recurring data refreshes must run on Cloudflare.
The user's laptop must not be part of the recurring production workflow.
```

Local commands are only allowed as quick development checks.

They are not the planned production import path.

TMDB scheduling rule:

```text
Initial TMDB backfill:
  one-time manual Cloudflare run
  historical load from configurable beginDate

Recurring TMDB refresh:
  much smaller weekly Cloudflare job
  only look for movies after the latest release_date already stored
  in tmdb_movies_staging
```

IMDb can stay simpler for now:

```text
Recurring IMDb refresh:
  re-read the full IMDb ratings file on Cloudflare
```

The important join key is:

```text
TMDB external id imdb_id = IMDb title.ratings tconst
```

Example:

```text
TMDB movie:
  tmdb_id: 603
  imdb_id: tt0133093

IMDb ratings row:
  tconst: tt0133093
  averageRating: 8.7
  numVotes: 2100000
```

The final search page only needs narrow list data, not full movie details.

The final app-facing table should only store fields needed for:

```text
1. displaying the movie list
2. filtering the movie list
3. sorting the movie list
4. opening the existing movie detail flow when the user taps a movie
```

Final app-facing fields:

```text
tmdb_id              -> needed when the user taps a movie and opens details
title                -> displayed in the movie list
poster_path          -> displayed in the movie list
release_date         -> used by the Released year range filter
us_certification     -> used by the Rating filter, such as G, PG, PG-13, R
imdb_rating          -> displayed and used by IMDb rating sort/filter
imdb_vote_count      -> displayed and used by IMDb vote-count threshold filters
popularity           -> used only if we keep the current Popularity sort option
movie_genres         -> separate filter table for genre ids
movie_watch_providers -> separate filter table for streamer/provider ids
```

When the user taps a poster, the app can still run the existing movie detail query separately. This D1 table is only for fast list/search/filter/sort behavior.

## Current Repos

Main React Native repo:

```text
/Users/croncallo/repo/MovieApp
```

Cloudflare Worker repo:

```text
/Users/croncallo/repo/MovieApp-Cloudflare
```

Current Cloudflare D1 database:

```text
database_name: movieapp-db
binding: DB
```

Current Cloudflare repo scripts already include:

```json
"db:migration:create": "wrangler d1 migrations create movieapp-db",
"db:migrate:local": "wrangler d1 migrations apply movieapp-db --local",
"db:seed:local": "wrangler d1 execute movieapp-db --local --file seed/seed-test-movies.sql",
"db:query:local": "wrangler d1 execute movieapp-db --local --command \"SELECT * FROM movies ORDER BY id LIMIT 5;\"",
"db:migrate:remote": "wrangler d1 migrations apply movieapp-db --remote",
"db:seed:remote": "wrangler d1 execute movieapp-db --remote --file seed/seed-test-movies.sql",
"db:query:remote": "wrangler d1 execute movieapp-db --remote --command \"SELECT * FROM movies ORDER BY id LIMIT 5;\""
```

## Important Data Sources

### 1. IMDb ratings file

```text
https://datasets.imdbws.com/title.ratings.tsv.gz
```

Columns:

```text
tconst          -> IMDb id
averageRating   -> IMDb rating
numVotes        -> IMDb vote count
```

Example row:

```text
tt0133093  8.7  2100000
```

This source gives us the IMDb rating data only.

### 2. TMDB discover/movie API

```text
https://api.themoviedb.org/3/discover/movie
```

This is the main TMDB feed for the Cloudflare load.

Use it the same way MovieApp already uses TMDB for the list/search page:

```text
same endpoint family
same basic list-style filters
same movie result shape
```

But for the Cloudflare backfill job:

```text
use paginated discover/movie
make beginDate configurable
default beginDate to 2000-01-01
```

This source gives us the main movie-list fields we need, including:

```text
tmdb_id
title
poster_path
release_date
popularity
genre_ids
```

### 3. TMDB movie enrichment API

This is the follow-up TMDB step for fields that `discover/movie` does not return in each movie result row.

This source is where we get:

```text
us_certification
watch providers / streamers
imdb_id
```

So the three-source picture is:

```text
1. IMDb file                -> imdb_rating, imdb_vote_count
2. TMDB discover/movie      -> core movie-list fields + genre_ids
3. TMDB enrichment API      -> imdb_id, us_certification, watch providers
```

## Target Database Design

Use staging tables first, then build an app-facing movie list table.

Why staging tables:

```text
1. keep raw/imported source data separate
2. make the final app query table cleaner
3. allow rebuilding the final movie list table without reimporting everything
4. make debugging easier
```

The final app will mostly query:

```text
movie_list_items
movie_genres
movie_watch_providers
```

## Search Page Field Audit

I checked the current MovieApp search page code before defining the final table:

```text
/Users/croncallo/repo/MovieApp/src/screens/MovieSearchScreen.tsx
/Users/croncallo/repo/MovieApp/src/components/header/SubHeaderMovieSearchFields.tsx
/Users/croncallo/repo/MovieApp/src/types/movieSearchParams.ts
/Users/croncallo/repo/MovieApp/src/api/tmdb/services/movieService.ts
/Users/croncallo/repo/MovieApp/src/components/ui/movieSearchFieldUtils.ts
```

The current search page has these filters:

```text
Released year range
Rating/certification, such as G, PG, PG-13, R
Genre
Streamer/provider
Sort option
```

The current TMDB query uses filters for:

```text
release date range
US certification
genre ids
watch provider ids
minimum user vote count
sort
```

For the Cloudflare/D1 version, the old TMDB user-rating filter/sort data is being replaced by IMDb data:

```text
new IMDb filter/sort fields:
  imdb_rating
  imdb_vote_count
```

So the final app-facing table should not store:

```text
adult
video
second title column
overview
budget
revenue
runtime
credits
```

`adult` is a TMDB source flag for adult content. We should use that flag only during import to reject those records before they reach D1. We should not store it.

`video` is also a TMDB source flag on movie-list result objects, but it is not a trailer URL and it is not the same thing as the `/movie/{id}/videos` endpoint. The Cloudflare import should not store it, and it should not reject an otherwise valid movie only because `video` is true. Instead, the discover/movie request should explicitly ask TMDB not to include video-only results:

```text
include_video=false
```

TMDB's discover/movie API also defaults `include_adult` to false, and the current MovieApp and legacy MovieApp queries rely on that default. For the Cloudflare import, be explicit:

```text
include_adult=false
include_video=false
```

`popularity` is the only extra TMDB field kept in the final table for now because the current MovieApp sort control still has a Popularity option. If the MovieApp sort control later removes Popularity, remove this column too.

## Implementation Steps

Start here when you are ready to do the work.

The steps below are meant to be followed in order. Each step builds on the previous step.

Use this quick map before you start:

- Migration Strategy
  - Step 0 shows the full source-to-staging-to-final-table flow before you touch the schema.
- Database Setup
  - Steps 1-3 build the D1 tables and indexes.
- IMDb Stream Proof
  - Step 4 proves Cloudflare can read the IMDb gzip file before any D1 writes happen.
- IMDb Setup And Load Into Staging
  - Steps 5-7 plan the IMDb Queue job, wire it up, and then write small IMDb batches into D1.
- TMDB Setup And Load Into Staging
  - Steps 8-9 add the TMDB secret and then load the narrow TMDB data into the staging tables.
- Final Movie List Build And Filter Checks
  - Steps 10-12 build the final movie list table and test the same main filters the app already has.
- Future Worker API
  - Steps 13-14 sketch the future `/movies/search` endpoint and the SQL behind it.
- Rollout Back Into MovieApp
  - Steps 15-16 scale carefully and hook the Cloudflare path back into the MovieApp POC screen.
- Reference
  - Steps 17-19 are the wrap-up sections for the build order, command list, and usage notes.

<a id="phase-0-migration-strategy"></a>
## Step 0: Migration Strategy

This step is the mental model for the whole migration.

There are three external data inputs:

```text
1. IMDb ratings file
2. TMDB discover/movie API
3. TMDB movie enrichment API
```

The high-level flow is:

```text
IMDb ratings file
-> Cloudflare IMDb import
-> imdb_ratings_staging

TMDB discover/movie API
-> paginated primary TMDB load
-> tmdb_movies_staging
-> movie_genres

TMDB movie enrichment API
-> follow-up enrichment for accepted tmdb_id values
-> updates tmdb_movies_staging with imdb_id and us_certification
-> writes movie_watch_providers child rows

Then:
tmdb_movies_staging
LEFT JOIN imdb_ratings_staging on imdb_id / tconst
-> movie_list_items
```

The diagram below shows the full source-to-staging-to-final-table flow:

![Migration strategy flow](assets/movieapp-migration-strategy-flow.svg)


The TMDB side has two different execution modes:

```text
1. Initial TMDB backfill
   manual only
   starts from configurable beginDate, default 2000-01-01
   runs in date windows so the historical load stays manageable

2. Recurring TMDB refresh
   weekly Cron job
   starts from the latest release_date already stored in tmdb_movies_staging
   only pulls the newer tail of the catalog
```

Conceptually, the recurring TMDB refresh is:

```text
only movies after the highest release_date already in the table
```

Implementation note:

```text
use the current MAX(release_date) as the next discover/movie lower-bound
cursor, then let INSERT OR REPLACE refresh the boundary-date rows too
```

That is safer than trying to do a strict greater-than cut with no overlap, because multiple movies can share the same release date.

So the final real-time query surface is three end tables:

```text
1. movie_list_items
2. movie_genres
3. movie_watch_providers
```

`movie_list_items` is the parent movie row.

`movie_genres` and `movie_watch_providers` are the child filter tables that repeat `tmdb_id` when one movie has many genres or many providers.

<a id="phase-1-create-the-migration-file"></a>
## Step 1: Create The Migration File

Open a terminal in the Cloudflare repo.

```bash
cd /Users/croncallo/repo/MovieApp-Cloudflare
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Create a new migration file.</div>

```bash
npm run db:migration:create -- create_movie_list_schema
```

Wrangler should create a file under:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/migrations/
```

The file name will look similar to:

```text
0002_create_movie_list_schema.sql
```

Paste the SQL from the next section into that generated file.

<a id="phase-2-paste-the-database-sql"></a>
## Step 2: Paste The Database SQL

DDL means Data Definition Language.

In plain English:

```text
DDL is SQL that creates or changes the shape of the database.
```

Examples:

```text
CREATE TABLE
CREATE INDEX
ALTER TABLE
DROP TABLE
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Paste this SQL into the new migration file.</div>

```sql
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
  average_rating REAL,
  num_votes INTEGER,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TMDB movie staging table.
--
-- This table stores the narrow TMDB movie data needed to build the
-- final movie list table.
--
-- tmdb_id is the TMDB movie id.
-- imdb_id is the external IMDb id that lets us join to imdb_ratings_staging.
-- us_certification supports the current MovieApp Rating filter.
--
-- poster_path is preferred over storing the full image URL because TMDB
-- image base URLs and sizes can be selected later by the API/app.
--
-- imdb_id is an indexed join key here.
-- It is not a FOREIGN KEY to imdb_ratings_staging.
--
-- Why not:
--   1. some TMDB movies may not have an IMDb id
--   2. some TMDB movies may not have a matching IMDb ratings row yet
--   3. the TMDB load and IMDb load can run independently
--
-- The final movie_list_items build is made faster by indexes:
--   imdb_ratings_staging.imdb_id  -> already indexed by PRIMARY KEY
--   tmdb_movies_staging.imdb_id   -> indexed below
--
-- The foreign key constraint itself would not make the final join faster.
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
--
-- Only promote TMDB movies into this table when there is a matching row in
-- imdb_ratings_staging.
--
-- That means:
--   imdb_rating
--   imdb_vote_count
--
-- can still be nullable here.
--
-- poster_path and release_date are also nullable because TMDB can return
-- catalog rows that do not have those values yet.
CREATE TABLE IF NOT EXISTS movie_list_items (
  tmdb_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  poster_path TEXT,
  release_date TEXT,
  us_certification TEXT,
  imdb_rating REAL,
  imdb_vote_count INTEGER,
  popularity REAL NOT NULL DEFAULT 0,
  last_refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for the main IMDb sort used by the final movie list.
--
-- Most list queries sort like this:
--   ORDER BY imdb_rating DESC, imdb_vote_count DESC
--
-- A composite index matches that sort better than a rating-only index.
--
-- It also still helps with rating-first scans because imdb_rating is the
-- left-most column in the index.
CREATE INDEX IF NOT EXISTS idx_movie_list_items_imdb_sort
ON movie_list_items (imdb_rating DESC, imdb_vote_count DESC);

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

-- Index for the recurring TMDB refresh cursor.
--
-- The weekly TMDB refresh reads:
--   MAX(release_date)
--
-- on tmdb_movies_staging to decide where the next incremental load begins.
CREATE INDEX IF NOT EXISTS idx_tmdb_movies_staging_release_date
ON tmdb_movies_staging (release_date DESC);
```

<a id="phase-3-apply-the-migration"></a>
## Step 3: Apply The Migration

<span class="ooo">[</span> X <span class="ooo">]</span> Apply the migration locally first as a quick schema check.

```bash
npm run db:migrate:local
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Confirm that the local tables exist.</div>

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
```

Expected table names should include:

```text
imdb_ratings_staging
movie_genres
movie_list_items
movie_watch_providers
tmdb_movies_staging
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Apply the same migration to remote D1 before testing Cloudflare-side imports.</div>

```bash
npm run db:migrate:remote
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Confirm that the remote tables exist.</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
```

<a id="phase-4-prove-cloudflare-can-stream-read-the-imdb-file"></a>
## Step 4: Prove Cloudflare Can Stream Read The IMDb File

This is the first real feasibility gate.

The recurring refresh must run on Cloudflare, not on a laptop.

So before building import scripts, we need a Worker endpoint that proves Cloudflare can:

```text
1. fetch IMDb's gzipped TSV file
2. stream-decompress it with DecompressionStream("gzip")
3. parse it line by line
4. stop after a small limit
5. return counts and sample rows
```

This step does not write to D1 yet.

That is intentional.

The only goal of this step is:

```text
prove that Cloudflare can fetch and stream-read the IMDb gzip file
```

Do not create a queue yet.

Do not insert rows into D1 yet.

Do not download the IMDb file to your laptop for this step.

<a id="phase-4a-open-the-worker-file"></a>
### Step 4A: Open The Worker File

Open this file:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/src/index.ts
```

This is the Worker entry file.

That means this is the file Cloudflare runs when someone calls your Worker URL.

You already have code in this file for routes like:

```text
GET /movies
```

For this step, you will add a temporary test route:

```text
GET /admin/import/imdb-ratings/dry-run?limit=10000
```

The route name means:

```text
/admin
  this is not for normal MovieApp users

/import/imdb-ratings
  this is related to importing IMDb ratings

/dry-run
  this is only a test; it does not write to D1

?limit=10000
  only read 10,000 IMDb rows, then stop
```

<a id="phase-4b-add-the-helper-code"></a>
### Step 4B: Add The Helper Code

<div><span class="ooo">[</span> X  <span class="ooo">]</span> In `src/index.ts`, paste this helper code below your type definitions and above the `export default { ... }` Worker object.</div>

Do not paste this inside the `fetch(...)` function.

This helper is a reusable function. The route will call it later.

Important:

```text
This helper does not insert anything into D1.
This helper does not update any table.
This helper only reads the IMDb file and returns sample rows as JSON.
```

The table insert happens later, after the dry-run proves Cloudflare can read the file safely.

```ts
const IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";

type ImdbRatingRow = {
  imdb_id: string;
  average_rating: number | null;
  num_votes: number | null;
};

async function dryRunReadImdbRatings(limit: number) {
  const response = await fetch(IMDB_RATINGS_URL);

  if (!response.ok || !response.body) {
    throw new Error(`IMDb download failed: ${response.status} ${response.statusText}`);
  }

  /*
    DecompressionStream("gzip") tells the Worker runtime:

      "The response body is gzip-compressed.
       Decompress it as a stream."

    That is important because the IMDb file is large.

    We do not want:
      await response.arrayBuffer()
      await response.text()

    Those approaches would load the whole file into memory.
  */
  const decompressedStream = response.body.pipeThrough(
    new DecompressionStream("gzip")
  );

  const reader = decompressedStream.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let rowsRead = 0;
  let headerSkipped = false;
  const sampleRows: ImdbRatingRow[] = [];

  while (rowsRead < limit) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    /*
      decoder.decode(value, { stream: true }) turns the latest binary chunk
      into text.

      stream: true matters because a text character could theoretically be
      split across chunks.
    */
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");

    /*
      The last item may be an incomplete line.
      Keep it in buffer and join it with the next chunk.
    */
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }

      if (!line.trim()) {
        continue;
      }

      const [imdb_id, averageRating, numVotes] = line.split("\t");

      sampleRows.push({
        imdb_id,
        average_rating: averageRating === "" ? null : Number(averageRating),
        num_votes: numVotes === "" ? null : Number(numVotes),
      });

      rowsRead += 1;

      if (rowsRead >= limit) {
        break;
      }
    }
  }

  await reader.cancel();

  return {
    rowsRead,
    firstRows: sampleRows.slice(0, 5),
    lastRows: sampleRows.slice(-5),
  };
}
```

<a id="phase-4c-add-the-temporary-route"></a>
### Step 4C: Add The Temporary Route

Now find the `fetch(...)` function inside:

```text
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    ...
  }
}
```

Inside `fetch(...)`, you should already have this line:

```ts
const url = new URL(request.url);
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Add the temporary dry-run route after that `url` line and before the normal `/movies` route logic.</div>

```ts
if (url.pathname === "/admin/import/imdb-ratings/dry-run") {
  const limit = Number(url.searchParams.get("limit") ?? 10000);
  const result = await dryRunReadImdbRatings(limit);
  return Response.json(result);
}
```

This says:

```text
If the browser calls /admin/import/imdb-ratings/dry-run,
then read some IMDb rows and return the sample JSON response.
```

<a id="phase-4d-run-the-local-worker-dev-server"></a>
### Step 4D: Run The Local Worker Dev Server

Open a VS Code terminal in the Cloudflare repo:

```text
/Users/croncallo/repo/MovieApp-Cloudflare
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Run the local Worker dev server.</div>

```bash
npm run dev
```

This starts the Worker on your machine, usually at:

```text
http://localhost:8787
```

Important:

```text
Even though the Worker dev server is running locally,
the Worker code still fetches the IMDb file from IMDb's remote URL.
You are not downloading or preparing the file by hand.
```

Open this URL in the browser:

```text
http://localhost:8787/admin/import/imdb-ratings/dry-run?limit=10000
```

Expected response shape:

```json
{
  "rowsRead": 10000,
  "firstRows": [
    {
      "imdb_id": "tt0000001",
      "average_rating": 5.7,
      "num_votes": 2000
    }
  ],
  "lastRows": [
    {
      "imdb_id": "tt0009999",
      "average_rating": 6.4,
      "num_votes": 300
    }
  ]
}
```

The exact IMDb ids, ratings, and vote counts can be different.

The important part is:

```text
rowsRead should equal the limit you asked for.
```

<a id="phase-4e-deploy-and-test-on-cloudflare"></a>
### Step 4E: Deploy And Test On Cloudflare

<div><span class="ooo">[</span> X  <span class="ooo">]</span> After the local dev-server test works, deploy the Worker.</div>

```bash
npm run deploy
```

Open the deployed Worker dry-run URL:

```text
https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/dry-run?limit=10000
```

This is the real Cloudflare test.

This proves Cloudflare's deployed Worker runtime can fetch, stream-decompress, and parse the IMDb gzip file.

<a id="phase-4f-try-a-larger-limit"></a>
### Step 4F: Try A Larger Limit

<div><span class="ooo">[</span> X  <span class="ooo">]</span> If `limit=10000` works, try:</div>

```text
https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/dry-run?limit=100000
```

<div><span class="ooo">[</span>  X <span class="ooo">]</span> Then try:</div>

```text
https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/dry-run?limit=500000
```

This still does not write to D1.

It only proves whether Cloudflare can keep streaming and parsing larger parts of the file.

<a id="phase-4g-pass-or-fail-decision"></a>
### Step 4G: Pass Or Fail Decision

<div><span class="ooo">[</span> X <span class="ooo">]</span> Decide whether this step passed before continuing.</div>

Pass condition:

```text
Cloudflare returns sample IMDb rows without a memory error or CPU error.
```

Fail condition:

```text
Cloudflare cannot stream/decompress/parse even a limited row count reliably.
```

If this fails, do not continue to D1 import work until the Cloudflare-side file processing problem is solved.

<a id="step-5-db-workflow-imdb-queue-job"></a>
## Step 5: DB Workflow IMDb Queue Job

This is a planning step only. There is no implementation work in this step and nothing to check off. Its purpose is to explain why the IMDb load uses Cloudflare's advanced
features before you start wiring them up in Step 6.

This step is still IMDb-only ... We are not on the TMDB side yet.

Step 4 only proved this:

```text
Cloudflare can read the IMDb gzip file and parse rows from it.
```

Step 4 did not save those rows ... Step 5 answers the next question:

```text
Now that Cloudflare can read the file, how should Cloudflare save about 1.6M rows into D1 safely?
```
Recommended plan:

```text
Manual initial route to Cron Job
-> producer reads the IMDb file
-> producer groups rows into small batches
-> producer sends row batches to a Cloudflare Queue
-> queue(...) consumer writes each batch into imdb_ratings_staging
```

This should NOT be the plan:

```text
one Worker run
-> read 1.6M IMDb rows
-> insert one row at a time
-> hope one invocation survives
```

That approach puts too much work on one invocation.



Cloudflare terms flow diagram:

![Cloudflare IMDb queue flow](assets/cloudflare-imdb-queue-flow.svg)

Cloudflare terms used in this step:

```text
Execution trigger:
  Cron Trigger
    Cloudflare's scheduled timer.
    It wakes up the Worker on a schedule and starts the recurring IMDb refresh.

Task buffer:
  Queue
    Cloudflare's temporary task storage.
    The producer sends small IMDb row batches into the Queue.
    The consumer later receives those batches and writes them to D1.

Handler names Cloudflare expects:
  fetch(...)
    Cloudflare calls this when an HTTP request reaches the Worker.
    In this plan, fetch(...) is the manual entry point.

  scheduled(...)
    Cloudflare calls this when a Cron Trigger fires.
    In this plan, scheduled(...) is the recurring IMDb entry point.

  queue(...)
    Cloudflare calls this when Queue messages are ready.
    In this plan, queue(...) is the consumer that writes IMDb batches into D1.

Producer role:
  enqueueImdbRatingRows(...)
    This helper lives in:
      /Users/croncallo/repo/MovieApp-Cloudflare/src/index.ts

    Cloudflare does not call a special producer(...) handler.
    One of our real handlers calls this helper instead:

    during manual kickoff:
      if fetch(...) sees the manual IMDb enqueue path
      /admin/import/imdb-ratings/enqueue-manual
      then that matching route block calls enqueueImdbRatingRows(...)

    during the recurring job:
      when the Cron Trigger fires, Cloudflare calls scheduled(...)
      and the scheduled(...) job block calls enqueueImdbRatingRows(...)

    Step 4 proved Cloudflare can:
      fetch the IMDb file
      decompress it
      split it into lines
      parse each line into values

    The producer reuses that file-reading/parsing logic, but changes what
    happens after each row is parsed.

    Step 4 dry-run:
      parse row
      keep sample rows in memory
      return JSON to the browser

    Real producer:
      parse row
      group rows into row batches
      send each row batch to the Queue

Consumer role:
  queue(...)
    This handler also lives in:
      /Users/croncallo/repo/MovieApp-Cloudflare/src/index.ts

    "consumer" is the role.
    queue(...) is the actual Worker handler name that Cloudflare expects.

    Flow from Queue to D1:
      1. producer sends row-batch messages to the Queue
      2. Cloudflare sees messages waiting in the Queue
      3. Cloudflare calls this Worker's queue(...) handler
      4. queue(...) reads the message body
      5. queue(...) runs INSERT statements against env.DB

Batch shape:
  row batch
    A small group of parsed IMDb rows sent together.

    Example row batch:
      [
        { imdb_id: "tt0133093", average_rating: 8.7, num_votes: 2100000 },
        { imdb_id: "tt0234215", average_rating: 7.2, num_votes: 650000 }
      ]

    We batch rows because one-row-at-a-time writes would create too many tiny
    operations. But we also keep the batch small enough to stay under
    Cloudflare and D1 limits.

SQL safety:
  bound parameters
    These are the real values passed safely into a SQL statement.

    Example:
      INSERT INTO imdb_ratings_staging (imdb_id, average_rating, num_votes)
      VALUES (?, ?, ?)

    The question marks are placeholders.
    The real values are bound separately.

    One-row example with the real values shown conceptually:

      SQL text:
        INSERT INTO imdb_ratings_staging (imdb_id, average_rating, num_votes)
        VALUES (?, ?, ?)

      bound parameter 1:
        "tt0133093"

      bound parameter 2:
        8.7

      bound parameter 3:
        2100000

    So this one-row insert uses 3 bound parameters.

Batch-size limit:
  D1 max bound parameters per query
    D1 allows 100 bound parameters per query.

    One IMDb row uses 3 values:
      imdb_id
      average_rating
      num_votes

    Two-row example:

      SQL text:
        INSERT INTO imdb_ratings_staging (imdb_id, average_rating, num_votes)
        VALUES (?, ?, ?), (?, ?, ?)

      row 1 uses:
        parameter 1: imdb_id
        parameter 2: average_rating
        parameter 3: num_votes

      row 2 uses:
        parameter 4: imdb_id
        parameter 5: average_rating
        parameter 6: num_votes

      So 2 rows use 6 bound parameters.

    Starting batch-size decision:
      33 rows * 3 values = 99 bound parameters

    That is why this plan starts with 33 IMDb rows per INSERT.

Invocation limits:
  wall-clock limit
    The total real elapsed time one Worker invocation is allowed to run.
    Even if the Worker is waiting on network or D1, that clock is still moving.

  Cron/Queue invocation
    One run of the Worker caused by a Cron Trigger or Queue batch.
```

Plain-English version:

```text
Do not make one Worker carry the full IMDb import alone.
Have one Worker split the file into retryable row batches.
Put those batches into a Cloudflare Queue.
Let the queue(...) handler write one batch at a time into D1.
```

Target architecture:

```text
Cloudflare Cron Trigger
-> Worker fetches https://datasets.imdbws.com/title.ratings.tsv.gz
-> Worker stream-decompresses gzip
-> Worker parses rows line by line
-> Worker sends row batches to a Cloudflare Queue
-> Queue consumer writes batches into D1
```

Why this job is chunked:

```text
1. the IMDb file has about 1.6M data rows
2. D1 has query/subrequest limits per Worker invocation
3. D1 has a maximum number of bound parameters per query
4. Cron/Queue invocations have wall-clock limits
5. Queue consumers are better for retrying failed chunks
```

Execution summary:

```text
Producer path:
  reads the big file
  groups rows into small batches
  sends those batches to a Queue

Consumer path:
  receives one batch
  writes that batch into D1
  succeeds or retries independently
```

Important Cloudflare limits - Free subscription:

```text
Workers plan:
  Free
  $0
  For personal use and simple applications

MovieApp calls to Cloudflare Worker:
  Plain meaning:
    Each MovieApp search, page change, or detail request calls a Worker endpoint.
    Example: GET /movies/search?page=3&pageSize=20 is 1 Workers request.

  Workers & Pages Functions requests:
    Up to 100,000 per day (UTC+0)

  Workers & Pages Functions CPU time:
    10 ms per invocation

  Worker memory:
    128 MB

D1 queries the Worker is allowed to run while answering one app request:
  D1 queries per Worker invocation:
    50
    One MovieApp request can cause the Worker to ask D1 for data.
    On the Free plan, that one Worker run can ask D1 up to 50 times.

  D1 bound parameters per query:
    100

  D1 daily usage included:
    Up to 5 million rows read per day
    Up to 100,000 rows written per day
    5 GB total storage

Background import jobs:
  Cron Trigger wall time:
    15 minutes

  Queue consumer wall time:
    15 minutes

  Cloudflare Queue message size:
    128 KB

  Cloudflare Queue operations:
    Up to 10,000 operations per day

  Cloudflare Queue message retention:
    24 hours, non-configurable
```

Important Cloudflare limits - Paid subscription:

```text
Workers plan:
  Paid
  $5 per month plus additional usage
  For business use and scaling applications

MovieApp calls to Cloudflare Worker:
  Plain meaning:
    Each MovieApp search, page change, or detail request calls a Worker endpoint.
    Example: GET /movies/search?page=3&pageSize=20 is 1 Workers request.

  Workers & Pages Functions requests:
    10 million included per month
    + $0.30 per additional million requests
    No hard request cap like Free; overage becomes billable usage

  Workers & Pages Functions CPU time:
    30 million CPU milliseconds included per month
    + $0.02 per additional million CPU milliseconds
    HTTP requests: default 30 seconds, configurable up to 5 minutes

  Worker memory:
    128 MB

D1 queries the Worker is allowed to run while answering one app request:
  D1 queries per Worker invocation:
    1000
    One MovieApp request can cause the Worker to ask D1 for data.
    On the Paid plan, that one Worker run can ask D1 up to 1000 times.

  D1 bound parameters per query:
    100

  MovieApp search example:
    User opens page 3 of search results in MovieApp.
    App request:
      GET /movies/search?page=3&pageSize=20

    Best shape:
      1 Workers request from the app
      1 D1 query to fetch the 20 movie rows
      optional 1 extra D1 query to fetch total count / total pages

    Expected D1 query count:
      usually 1 or 2 D1 queries

    Bad shape:
      1 Workers request from the app
      20 D1 queries, one query for each movie row

    What 1000 is not:
      not 1000 users
      not 1000 movies
      not 1000 app searches per day
      not 1000 monthly requests

  D1 monthly usage included:
    First 25 billion rows read per month included
    + $0.001 per additional million rows read
    First 50 million rows written per month included
    + $1.00 per additional million rows written
    First 5 GB storage included
    + $0.75 per GB-month

Background import jobs:
  Cron Trigger wall time:
    15 minutes

  Queue consumer wall time:
    15 minutes

  Cron Triggers and Queue Consumers CPU time:
    Up to 15 minutes CPU per invocation

  Cloudflare Queue message size:
    128 KB

  Cloudflare Queue operations:
    1 million operations included per month
    + $0.40 per additional million operations
    Operations are counted per 64 KB written, read, or deleted

  Cloudflare Queue message retention:
    4 days by default, configurable up to 14 days
```

Row shape:

```text
imdb_id
average_rating
num_votes
```

Because D1 allows 100 bound parameters per query, a single multi-row insert can safely hold up to 33 rows:

```text
33 rows * 3 values = 99 bound parameters
```

Starting batch size:

```text
33 IMDb rating rows per INSERT
```

Tune this later only after you have real D1 timing.

The paid Workers plan is the realistic starting point for this recurring import design.

If Cloudflare requires upgrading before Queues can be enabled on this account, treat that as an architecture decision point.

Do not continue building a laptop-driven workaround.

<a id="phase-6-wire-up-the-imdb-queue"></a>
## Step 6: Wire Up The IMDb Queue

Step 5 explained why the import needs a Queue.

Step 6 is where you actually create that Queue in Cloudflare and connect it to this Worker.

A Queue is not a D1 table.

A Queue is temporary task storage managed by Cloudflare.

In this plan, each Queue message will contain a small batch of IMDb rating rows.

Example message concept:

```json
{
  "rows": [
    {
      "imdb_id": "tt0133093",
      "average_rating": 8.7,
      "num_votes": 2100000
    },
    {
      "imdb_id": "tt0234215",
      "average_rating": 7.2,
      "num_votes": 650000
    }
  ]
}
```

Why we want the Queue:

```text
1. the IMDb file is too large to treat as one big insert job
2. queue messages let us split the import into retryable chunks
3. if one chunk fails, Cloudflare can retry that chunk
4. the Worker does not need to keep all 1.6M rows in memory
5. D1 writes happen in smaller controlled batches
```

The Queue has two sides:

```text
Producer side:
  the Worker reads the IMDb file and sends row batches to the Queue

Consumer side:
  the Worker receives those row batches from the Queue and writes them to D1
```

Create the Cloudflare Queue resource.

This command creates the real Queue resource in your Cloudflare account.

Run it from the Cloudflare repo terminal:

```text
/Users/croncallo/repo/MovieApp-Cloudflare
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Create the Queue - Run:

```bash
npx wrangler queues create movieapp-imdb-rating-import-queue
```

This creates the Queue itself (only in the remote, not locally), but it does not automatically edit your Worker project.

That is intentional.

Cloudflare can have:

```text
many Queues
many Workers
many environments
```

Creating a Queue only says:

```text
this Queue exists in the Cloudflare account, to see the Queue, run the following command:
```
<div><span class="ooo">[</span> X  <span class="ooo">]</span> Validate the Queue - Run:

```bash
npx wrangler queues list
```


It does not tell Cloudflare:

```text
which Worker is allowed to send messages to it
which Worker should receive messages from it
what env property name the Worker code should use
what batch size or retry behavior this Worker wants
```

Those Worker-specific decisions belong in this repo's `wrangler.jsonc`.

Now that the queue exists in Cloudflare, we will connect it to this Worker by editing the wrangler.jsonc file in the next section, but 1st some context:

For this Queue, `wrangler.jsonc` must say two things:

```text
1. Producer binding:
   let this Worker send messages to movieapp-imdb-rating-import-queue

2. Consumer binding:
   deliver messages from movieapp-imdb-rating-import-queue back to this Worker
```

<a id="phase-6a-what-the-imdb-queue-binding-does"></a>
### Step 6A: What The IMDb Queue Binding Does

Creating the Queue in Cloudflare is not enough by itself.

The Worker code also needs a way to access that Queue.

In this repo, "the Worker" means the Cloudflare Worker program whose entry file is:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/src/index.ts
```

The whole `MovieApp-Cloudflare` folder is the Worker project.

The main code Cloudflare runs is `src/index.ts`.

Other files support that Worker:

```text
wrangler.jsonc
  tells Cloudflare which resources this Worker connects to

package.json
  gives local commands such as npm run dev and npm test

migrations/
  contains D1 database schema changes
```

That connection is called a Queue binding.

In plain English:

```text
Queue resource:
  the real Cloudflare Queue named movieapp-imdb-rating-import-queue

Queue binding:
  the name your Worker code uses to talk to that Queue
```

The Queue resource name and the Worker code name are different on purpose:

```text
Cloudflare Queue resource name:
  movieapp-imdb-rating-import-queue

Worker code binding name:
  IMDB_RATING_QUEUE
```

The resource name is the actual Queue in Cloudflare.

The binding name is the property that appears inside Worker code:

```ts
env.IMDB_RATING_QUEUE
```

So when Worker code calls:

```ts
await env.IMDB_RATING_QUEUE.sendBatch(...);
```

Cloudflare knows that `IMDB_RATING_QUEUE` means:

```text
send these messages to the Queue named movieapp-imdb-rating-import-queue
```

The producer binding gives Worker code a property on `env`:

```text
env.IMDB_RATING_QUEUE
```

That means the producer code can do this later:

```ts
await env.IMDB_RATING_QUEUE.sendBatch(...);
```

The consumer section tells Cloudflare:

```text
when this Queue has messages, deliver them to this Worker in batches
```

That delivery is what causes Cloudflare to call the `queue(...)` handler in `src/index.ts`.

<a id="phase-6b-where-to-put-this-in-wrangler-jsonc"></a>
### Step 6B: Where To Put This In wrangler.jsonc

Open:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/wrangler.jsonc
```

Find the existing `d1_databases` section.

Right now it looks like this:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "movieapp-db",
    "database_id": "bfd8c900-38f6-41e2-afcf-37772b5249a2"
  }
]
```

That section connects the Worker to D1.

Now add a second top-level section named `queues`.

This new `queues` section connects the same Worker to the Cloudflare Queue.

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Change the end of the `d1_databases` section from this:</div>

```jsonc
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "movieapp-db",
      "database_id": "bfd8c900-38f6-41e2-afcf-37772b5249a2"
    }
  ]
```

To this:

```jsonc
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "movieapp-db",
      "database_id": "bfd8c900-38f6-41e2-afcf-37772b5249a2"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "IMDB_RATING_QUEUE",
        "queue": "movieapp-imdb-rating-import-queue"
      }
    ],
    "consumers": [
      {
        "queue": "movieapp-imdb-rating-import-queue",
        "max_batch_size": 100,
        "max_batch_timeout": 10,
        "max_retries": 5
      }
    ]
  }
```

The important punctuation change is the comma after the `d1_databases` closing bracket:

```text
],
"queues": {
  ...
}
```

Why that comma matters:

```text
d1_databases and queues are sibling top-level settings.

JSON/JSONC needs a comma between sibling settings.
Without that comma, wrangler.jsonc will not parse.
```

The relevant part of the final file should look like this:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "movieapp-cloudflare",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-20",
  "observability": {
    "enabled": true
  },
  "upload_source_maps": true,
  "compatibility_flags": [
    "nodejs_compat"
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "movieapp-db",
      "database_id": "bfd8c900-38f6-41e2-afcf-37772b5249a2"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "IMDB_RATING_QUEUE",
        "queue": "movieapp-imdb-rating-import-queue"
      }
    ],
    "consumers": [
      {
        "queue": "movieapp-imdb-rating-import-queue",
        "max_batch_size": 100,
        "max_batch_timeout": 10,
        "max_retries": 5
      }
    ]
  }
}
```
Do not remove the existing `d1_databases` section.

You are adding `queues` as another top-level config section next to `d1_databases`.

<a id="phase-6c-what-each-imdb-queue-config-part-means"></a>
### Step 6C: What Each IMDb Queue Config Part Means

Important current-code note:

```text
src/index.ts currently has the IMDb dry-run helper:
  dryRunReadImdbRatings(...)

src/index.ts does not yet have the real Queue producer helper:
  enqueueImdbRatingRows(...)

src/index.ts does not yet have the Queue consumer handler:
  queue(batch, env)

This Step 6 config prepares the Worker for those next code additions.
```

There are two jobs involved in the Queue flow:

```text
Producer job:
  reads IMDb rows
  packages rows into Queue messages
  sends those messages into the Queue

Consumer job:
  receives Queue messages later
  writes the rows from those messages into D1
```

In this project, both jobs live in the same Worker codebase.

That is why the same `wrangler.jsonc` file needs both `producers` and `consumers`.

#### Producers

```jsonc
"producers": [
  {
    "binding": "IMDB_RATING_QUEUE",
    "queue": "movieapp-imdb-rating-import-queue"
  }
]
```

Plain meaning:

```text
Connect this Worker to the Queue named:

  movieapp-imdb-rating-import-queue

Inside Worker code, expose that Queue as:

  env.IMDB_RATING_QUEUE
```

That is not a normal variable we create with `const`.

Cloudflare creates `env.IMDB_RATING_QUEUE` at runtime because `wrangler.jsonc` contains this producer binding.

Why the Worker needs this:

```text
The future IMDb producer helper will live in src/index.ts.
It will probably be named enqueueImdbRatingRows(...).

That helper will read rows from the IMDb file.
Every 33 rows, it will create a Queue message.
Then it will call env.IMDB_RATING_QUEUE.sendBatch(...).
```

Plain flow:

```text
src/index.ts receives an admin request
-> fetch(...) route matches /admin/import/imdb-ratings/enqueue-manual
-> fetch(...) calls enqueueImdbRatingRows(env, limit)
-> enqueueImdbRatingRows(...) reads IMDb rows
-> enqueueImdbRatingRows(...) sends row batches to env.IMDB_RATING_QUEUE
-> Cloudflare stores those messages in movieapp-imdb-rating-import-queue
```

Without this producer binding:

```text
env.IMDB_RATING_QUEUE would not exist in Worker code,
so the Worker would have no way to send IMDb row batches into the Queue.
```

#### Consumers

```jsonc
"consumers": [
  {
    "queue": "movieapp-imdb-rating-import-queue",
    "max_batch_size": 100,
    "max_batch_timeout": 10,
    "max_retries": 5
  }
]
```

Plain meaning:

```text
When the Queue named movieapp-imdb-rating-import-queue has messages,
Cloudflare should deliver those messages back to this Worker.
```

Why the Worker needs this:

```text
The Queue is only temporary task storage.
It does not write to D1 by itself.

The consumer config tells Cloudflare:
  "When messages are waiting in this Queue, call this Worker's queue(...) handler."
```

That future Worker handler will look conceptually like this:

```ts
async queue(batch, env) {
  // read row batches from batch.messages
  // insert those rows into env.DB
}
```

Without this consumer config:

```text
messages could be sent into the Queue,
but this Worker would not be registered as the code that processes them.
```

`max_batch_size: 100` means:

```text
Cloudflare can deliver up to 100 Queue messages to queue(...) at once.
```

`max_batch_timeout: 10` means:

```text
Cloudflare can wait up to 10 seconds to collect messages before delivering a batch.
```

`max_retries: 5` means:

```text
If processing fails, Cloudflare can retry the failed message up to 5 times.
```

Why `max_batch_size` is `100`:

```text
Each Queue message contains 33 IMDb rows.
Each message becomes one D1 INSERT.
100 Queue messages means up to 100 D1 INSERT statements in one consumer run.
That is intended for the paid-plan D1 invocation limit.
```

If testing on the free plan, use a smaller consumer batch size first.

The recurring IMDb Cron Trigger is now part of the full production schedule in Step 20.

Current IMDb schedule:

```text
0 22 * * 1
```

Meaning:

```text
Sunday 6:00 PM Eastern while on Eastern Daylight Time
Sunday 22:00 UTC in Cloudflare's cron expression
```

Cloudflare's cron day-of-week value in this dashboard/API is:

```text
1 = Sunday
2 = Monday
3 = Tuesday
...
7 = Saturday
```

The cron should only be enabled after the manual Queue import path is working:

```text
1. the manual enqueue endpoint sends IMDb row batches to the Queue
2. the Queue consumer writes those batches into D1
```

<a id="phase-7-write-imdb-rating-batches-into-d1"></a>
<a id="step-7-write-imdb-rating-batches-into-d1"></a>
## Step 7: Load The IMDb Ratings Staging Table

This is still the IMDb side of the pipeline.

Do not switch to TMDB yet.

After the manual Queue import path is working and the Queue wiring is in place, add the real queue producer and queue consumer.

The producer reads the IMDb file and sends small row batches to the Queue.

The consumer receives those row batches and writes them to D1.

Step 7A
<div><span class="ooo">[</span> X <span class="ooo">]</span> Add these types:</div>

```ts
type ImdbRatingQueueMessage = {
  rows: ImdbRatingRow[];
};

export interface Env extends Cloudflare.Env {
  DB: D1Database;
  IMDB_RATING_QUEUE: Queue<ImdbRatingQueueMessage>;
}
```

Step 7B

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Add the producer helper:</div>

```ts
const IMDB_QUEUE_ROWS_PER_MESSAGE = 33;
const IMDB_QUEUE_MESSAGES_PER_SEND_BATCH = 100;

async function enqueueImdbRatingRows(env: Env, limit?: number) {
  const response = await fetch(IMDB_RATINGS_URL);

  if (!response.ok || !response.body) {
    throw new Error(`IMDb download failed: ${response.status} ${response.statusText}`);
  }

  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let rowsSeen = 0;
  let rowsQueued = 0;
  let headerSkipped = false;
  let batch: ImdbRatingRow[] = [];
  let queueMessages: ImdbRatingQueueMessage[] = [];

  async function flushQueueMessages() {
    if (queueMessages.length === 0) {
      return;
    }

    /*
      sendBatch(...) sends multiple Queue messages in one Queue call.

      That matters for the full IMDb file.

      If we called env.IMDB_RATING_QUEUE.send(...) once for every 33 rows,
      the full file would create too many individual Queue send calls.
    */
    await env.IMDB_RATING_QUEUE.sendBatch(
      queueMessages.map((message) => ({ body: message }))
    );

    queueMessages = [];
  }

  async function flushBatch() {
    if (batch.length === 0) {
      return;
    }

    queueMessages.push({ rows: batch });
    rowsQueued += batch.length;
    batch = [];

    if (queueMessages.length >= IMDB_QUEUE_MESSAGES_PER_SEND_BATCH) {
      await flushQueueMessages();
    }
  }

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }

      if (!line.trim()) {
        continue;
      }

      const [imdb_id, averageRating, numVotes] = line.split("\t");

      batch.push({
        imdb_id,
        average_rating: averageRating === "" ? null : Number(averageRating),
        num_votes: numVotes === "" ? null : Number(numVotes),
      });

      rowsSeen += 1;

      if (batch.length >= IMDB_QUEUE_ROWS_PER_MESSAGE) {
        await flushBatch();
      }

      if (limit && rowsSeen >= limit) {
        await flushBatch();
        await flushQueueMessages();
        await reader.cancel();
        return { rowsSeen, rowsQueued };
      }
    }
  }

  await flushBatch();
  await flushQueueMessages();

  return { rowsSeen, rowsQueued };
}
```

Step 7C

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Add the temporary endpoint to enqueue a small manual kickoff:</div>

```ts
if (url.pathname === "/admin/import/imdb-ratings/enqueue-manual") {
  const limit = Number(url.searchParams.get("limit") ?? 330);
  const result = await enqueueImdbRatingRows(env, limit);
  return Response.json(result);
}
```

Step 7D

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Add the queue consumer:</div>

```ts
export default {
  /*
    Keep the existing fetch(...) routes in this same object.

    Do not create a second export default.

    The Worker has one default export object, and that one object can have:

      fetch(...)
      scheduled(...)
      queue(...)
  */

  async queue(batch: MessageBatch<ImdbRatingQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const rows = message.body.rows;

      if (rows.length === 0) {
        message.ack();
        continue;
      }

      /*
        Each row has 3 bound values:

          imdb_id
          average_rating
          num_votes

        33 rows * 3 values = 99 bound values.

        That stays under D1's 100 bound-parameter limit.
      */
      const placeholders = rows.map(() => "(?, ?, ?)").join(", ");
      const values = rows.flatMap((row) => [
        row.imdb_id,
        row.average_rating,
        row.num_votes,
      ]);

      await env.DB
        .prepare(
          `INSERT OR REPLACE INTO imdb_ratings_staging
             (imdb_id, average_rating, num_votes)
           VALUES ${placeholders}`
        )
        .bind(...values)
        .run();

      message.ack();
    }
  },
};
```

Important:

```text
Do not start by importing all 1.6M IMDb rows.
```

Step 7E

This is the first step that actually runs the Queue import path.

Do it in two stages:

```text
1. local first
2. remote after local works
```

Why:

```text
Local first proves the code path works without touching the real remote D1 data.
Remote second proves the deployed Cloudflare path can write to the real D1 database.
```

Start with small limits.

Do not start by importing the full IMDb file.

Test sizes:

```text
330 rows
3,300 rows
33,000 rows
then decide whether to run the full job
```

Important:

```text
The import uses INSERT OR REPLACE by imdb_id.

That means you do not need to delete rows between these test sizes.

If you run limit=330 first, then limit=3300 later:
  the first 330 rows are replaced/updated
  the next 2,970 rows are added
```

### Step 7E-1: Test Locally First

Open terminal 1 in the Cloudflare repo:

```bash
cd /Users/croncallo/repo/MovieApp-Cloudflare
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Start the local Worker:

```bash
npm run dev
```

Leave that terminal running.

Open terminal 2 in the same repo:

```bash
cd /Users/croncallo/repo/MovieApp-Cloudflare
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Call the local manual enqueue endpoint:

```bash
curl "http://localhost:8787/admin/import/imdb-ratings/enqueue-manual?limit=330"
```

Expected response shape:

```json
{
  "rowsSeen": 330,
  "rowsQueued": 330
}
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Confirm local D1 received rows:

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

Expected count:

```text
330
```

Preview the first 50 local IMDb staging rows to make sure the data shape looks normal:

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT imdb_id, average_rating, num_votes FROM imdb_ratings_staging ORDER BY imdb_id LIMIT 50;"
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Then try the next local size:

```bash
curl "http://localhost:8787/admin/import/imdb-ratings/enqueue-manual?limit=3300"
```

<div><span class="ooo">[</span> X  <span class="ooo">]</span> Confirm local D1 count again:

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

Expected count:

```text
3300
```

Preview the first 50 local IMDb staging rows again:

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT imdb_id, average_rating, num_votes FROM imdb_ratings_staging ORDER BY imdb_id LIMIT 50;"
```

If local fails:

```text
Stop here.
Fix local before deploying or touching remote D1.
```

### Step 7E-2: Test Remote After Local Works

<div><span class="ooo">[</span> X <span class="ooo">]</span> Deploy the Worker:

```bash
npm run deploy
```

Call the deployed manual enqueue endpoint.

<div><span class="ooo">[</span> X <span class="ooo">]</span> Use your deployed Worker URL:

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/enqueue-manual?limit=330"
```

Expected response shape:

```json
{
  "rowsSeen": 330,
  "rowsQueued": 330
}
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Confirm remote D1 received rows:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

Expected count:

```text
330
```

Preview the first 50 remote IMDb staging rows to make sure the data shape looks normal:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT imdb_id, average_rating, num_votes FROM imdb_ratings_staging ORDER BY imdb_id LIMIT 50;"
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Then try the next remote size:

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/enqueue-manual?limit=3300"
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Confirm remote D1 count again:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

*Expected count:

```text
3300
```

Preview the first 50 remote IMDb staging rows again:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT imdb_id, average_rating, num_votes FROM imdb_ratings_staging ORDER BY imdb_id LIMIT 50;"
```


*Important Queue timing note:

```text
rowsQueued means the producer Worker successfully placed rows into Cloudflare Queue messages.
It does not mean the Queue consumer has already inserted every row into D1.

The Queue consumer keeps running after the enqueue request returns.
So the D1 count can be lower at first, then climb as Cloudflare delivers Queue messages to the consumer.

This importer puts 33 IMDb rows in each Queue message.
If D1 shows 2904 rows, that means 88 Queue messages have already been inserted:

88 messages x 33 rows = 2904 D1 rows
```
Important Queue timing note:


<div><span class="ooo">[</span> X <span class="ooo">]</span> Only after the small remote tests pass, consider:

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/enqueue-manual?limit=33000"
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Then check:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

Expected count:

```text
33000
```

Stop before the full IMDb file unless:

```text
local 330 works
local 3300 works
remote 330 works
remote 3300 works
remote 33000 works
Cloudflare Worker logs show no Queue retry or D1 write errors
```

### Step 7F: Monitor The Queue Load

After running a large enqueue command, there are two separate things happening:

```text
1. Producer:
   the HTTP endpoint reads the IMDb file and places row batches into the Queue

2. Consumer:
   Cloudflare later calls the Worker's queue(...) handler to insert those batches into D1
```

The curl response only proves the producer finished.

Example:

```json
{
  "rowsSeen": 1665567,
  "rowsQueued": 1665567
}
```

That means the rows were placed into Queue messages.

It does not mean D1 has already inserted every row.

Watch live Worker events from the terminal:

```bash
npx wrangler tail
```

Expected healthy Queue consumer lines look like this:

```text
Queue movieapp-imdb-rating-import-queue (100 messages) - Ok
```

Plain meaning:

```text
Cloudflare delivered a batch of 100 Queue messages to this Worker's queue(...) handler.
The handler finished successfully for that batch.
```

Because this importer puts 33 IMDb rows in each Queue message:

```text
100 Queue messages x 33 rows = about 3300 D1 rows per successful consumer batch
```

Also keep checking the remote D1 count:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

For the full IMDb ratings file, the expected final count is the `rowsSeen` value from the full enqueue response.

Dashboard places to watch:

```text
Queue backlog:
  Cloudflare Dashboard
  -> Build
  -> Compute
  -> Queues
  -> movieapp-imdb-rating-import-queue

  Watch:
    Messages queued
    Average backlog
    Average lag time

Worker logs:
  Cloudflare Dashboard
  -> Build
  -> Compute
  -> Workers & Pages
  -> movieapp-cloudflare
  -> Observability
  -> Logs / Real-time logs
```

Use the dashboard Queue metrics for backlog and lag.

Use `npx wrangler tail` or the Worker dashboard logs to see whether the Queue consumer batches are succeeding or throwing errors.

At this point, the IMDb side has a real Cloudflare path into D1.

Only after that do we switch over to the TMDB side.

<a id="phase-8-add-the-tmdb-api-key-as-a-secret"></a>
## Step 8: Add The TMDB API Key As A Secret

This is the handoff from IMDb work to TMDB work.

TMDB starts here.

Do not hard-code the TMDB API key in source code.

Use the same TMDB authentication style the current MovieApp and legacy MovieApp already use:

```text
api_key=your_key_goes_here
```

Do not use `Authorization: Bearer ...` for this Worker code.

That is a different TMDB credential style. This guide is using the existing MovieApp API-key style so the Cloudflare importer matches the app we already have.

There are two places to store the same TMDB API key:

```text
local development:
  .dev.vars file on your Mac

deployed Worker:
  Cloudflare secret stored in your Cloudflare account
```

They both use the same key name:

```text
TMDB_API_KEY
```

That name is not a Cloudflare default.

We choose that name because the Worker code will read:

```ts
env.TMDB_API_KEY
```

So the local `.dev.vars` key, the deployed Cloudflare secret name, and the Worker `Env` type all need to match.

<div><span class="ooo">[</span> X <span class="ooo">]</span> For local development, create this file:</div>

```text
/Users/croncallo/repo/MovieApp-Cloudflare/.dev.vars
```

Important:

```text
.dev.vars is a hidden file, not a folder.

The leading dot makes it look less obvious in file explorers.
Wrangler automatically reads this exact file name during local development.
```

If the file does not exist yet, create it in the root of the Cloudflare repo:

```text
/Users/croncallo/repo/MovieApp-Cloudflare
```

So the final local file path is:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/.dev.vars
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Inside that `.dev.vars` file, add this key/value line:</div>

```text
TMDB_API_KEY=your_tmdb_api_key_here
```

Do not put quotes around the API key unless the API key itself actually contains quotes.

Do not commit `.dev.vars`.

This repo already ignores it:

```text
.dev.vars*
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> For the deployed Worker, add the same value as a Cloudflare secret:</div>

```bash
npx wrangler secret put TMDB_API_KEY
```

Wrangler will ask you to paste the value.

This command does not read from `.dev.vars`.

Plain meaning:

```text
.dev.vars:
  local-only file used by npm run dev / wrangler dev

wrangler secret put TMDB_API_KEY:
  uploads a remote secret named TMDB_API_KEY to Cloudflare
  used by the deployed Worker
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Also add the API key secret to the Worker `Env` type.</div>

Open:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/src/index.ts
```

Near the top of the file, find:

```text
export interface Env extends Cloudflare.Env
```

In the current file, that interface starts around line 57.

Add this one line inside the existing `Env` interface:

```ts
TMDB_API_KEY: string;
```

The final interface should look like this:

```ts
export interface Env extends Cloudflare.Env {
  DB: D1Database;
  IMDB_RATING_QUEUE: Queue<ImdbRatingQueueMessage>;
  TMDB_API_KEY: string;
}
```

Why this is needed:

```text
Wrangler makes the runtime value available as env.TMDB_API_KEY.
TypeScript still needs the Env type updated so the code is allowed to read env.TMDB_API_KEY.
```

You need this in place before adding the TMDB loading code in Step 9.

<a id="phase-9-load-the-tmdb-movie-list-data-into-d1"></a>
<a id="step-9-load-the-tmdb-movie-list-data-into-d1"></a>
## Step 9: Load The TMDB Staging Tables

Now the guide is on the TMDB side.

The TMDB side must also run on Cloudflare, not on a laptop.

This step loads the TMDB fields needed by the MovieApp list page.

The data comes from TMDB's remote API/data sources:

```text
TMDB discover/movie API
TMDB movie enrichment API
```

Why TMDB does not have separate Queue-planning steps here:

```text
IMDb needed explicit Queue setup because the recurring IMDb job still re-reads
the full ratings file and writes a very large number of rows.

TMDB is different in the current plan:
  1. initial TMDB backfill is manual and date-windowed
  2. recurring TMDB refresh is weekly and much smaller

So the guide starts TMDB with direct Worker orchestration first.
If the weekly TMDB refresh later proves too heavy, add a TMDB Queue as a
follow-up design step.
```

Target architecture:

```text
Manual Load for One Time Initial Load
  entry point:
    admin endpoint
  source:
    call paginated TMDB discover/movie
  filter:
    request include_adult=false and include_video=false
    reject adult rows before D1 if TMDB still returns one
  staging row:
    insert base movie fields into tmdb_movies_staging
  genre child rows:
    insert genre ids into movie_genres
  enrichment:
    call TMDB movie enrichment only for accepted tmdb_id values
  staging update:
    update imdb_id and us_certification in tmdb_movies_staging
  provider child rows:
    insert flatrate US provider ids into movie_watch_providers

Weekly Cron Job to Add New Movies
  entry point:
    weekly Cron trigger
  start point:
    read MAX(release_date) from tmdb_movies_staging
  source:
    call paginated TMDB discover/movie starting from that lower bound
  filter:
    request include_adult=false and include_video=false
    reject adult rows before D1 if TMDB still returns one
  staging row:
    insert or update base movie fields in tmdb_movies_staging
  genre child rows:
    insert or refresh genre ids in movie_genres
  enrichment:
    call TMDB movie enrichment only for accepted tmdb_id values
  staging update:
    update imdb_id and us_certification in tmdb_movies_staging
  provider child rows:
    insert or refresh flatrate US provider ids in movie_watch_providers

Staging Tables
  tmdb_movies_staging:
    base movie row first
  movie_genres:
    repeated (tmdb_id, genre_id) rows
  movie_watch_providers:
    repeated (tmdb_id, provider_id, region) rows
```

The TMDB load is still non-trivial, even though it is not a queue-first design in the current plan.

Reason:

```text
discover/movie is paginated
then enrichment still has to run per accepted movie id
```

That is why the TMDB side still needs:

```text
1. date windows for the one-time historical backfill
2. a smaller weekly incremental refresh later
```

Step 9 is easier to understand if you picture it as two TMDB passes:

```text
Step 9A:
  primary discover/movie load
  writes the base tmdb_movies_staging row
  writes movie_genres

Step 9B:
  TMDB enrichment pass
  updates tmdb_movies_staging with imdb_id and us_certification
  writes movie_watch_providers
```

Both passes are used in:

```text
1. the one-time manual historical backfill
2. the later smaller weekly TMDB refresh
```

### Step 9A: Primary TMDB Load Into Staging

This pass happens first.

It is the discover/movie side of the TMDB load.

This pass is responsible for:

```text
1. reading discover/movie pages
2. rejecting adult rows
3. inserting the base tmdb_movies_staging row
4. inserting movie_genres rows from genre_ids
```

For the initial historical load:

```text
run it manually
start from configurable beginDate, default 2000-01-01
split the historical load into date windows
do not put the historical backfill on Cron
```

Example windows:

```text
one year at a time
one quarter at a time
one month at a time
```

The exact window size can be tuned after real TMDB testing.

For the later recurring TMDB refresh:

```text
run it weekly on Cloudflare
read MAX(release_date) from tmdb_movies_staging
use that value as the next discover/movie lower bound
```

If the table is still empty, fall back to:

```text
2000-01-01
```

Safer implementation detail:

```text
reuse the current max date as the next gte boundary, then let the upserts
refresh that same-date boundary again
```

That protects the refresh from missing movies that share the same release date.

For example:

```text
Current latest release_date in D1:
  2024-06-15

Next refresh should start at:
  primary_release_date.gte=2024-06-15

Do not start at:
  2024-06-16

Reason:
  TMDB may have more movies with release_date 2024-06-15 that were not loaded last time.
  Re-reading 2024-06-15 is safe because the import uses upserts.
```

Start with an admin manual endpoint.

This will be another route inside the existing `fetch(...)` handler in:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/src/index.ts
```

It is not a new file.

The route path should be:

```text
/admin/import/tmdb/load-manual?limit=100&beginDate=2000-01-01&endDate=2000-12-31
```

The first Cloudflare primary-load version should do all of this:

```text
1. call TMDB discover/movie
2. page through results
3. start from configurable beginDate, default 2000-01-01
4. end at a matching window endDate
5. explicitly request include_adult=false and include_video=false
6. skip adult rows if TMDB still returns one
7. insert tmdb_movies_staging base rows
8. insert movie_genres rows from genre_ids
9. return summary counts only, not every accepted tmdb_id
```

The Worker preflights each date window before loading it:

```text
1. request page 1 for that beginDate/endDate window
2. read total_pages
3. if total_pages <= 500, load that window
4. if total_pages > 500, split the window into two smaller date windows
5. repeat until each loaded window is under the TMDB page cap
```

What the code had to do because of TMDB's 500-page cap:

```text
The old version tried to load the caller's date range directly.

That worked for small windows, but a large window like 2000-01-01 through
2002-12-31 can have more than 500 Discover pages.

TMDB may report that larger total_pages value, but it will not allow the Worker
to request page 501. Page 501 returns a 400 Bad Request.

So the Worker no longer waits until page 501 fails.
It checks page 1 first, reads total_pages, and splits oversized date windows
before loading them.
```

Plain example:

```text
Requested:
  2000-01-01..2002-12-31

If page 1 says this window has too many pages:
  split into two smaller windows

Then each smaller window is checked the same way.

Only windows with 500 pages or fewer are actually paged through and inserted.
```

Why this does not miss part of the date range:

```text
When a window splits, the code creates two adjacent windows:

left:
  beginDate through midDate

right:
  dayAfter(midDate) through endDate

There is no gap between the two windows and no overlapping date.
```

TMDB Discover page cap:

```text
TMDB Discover returns up to 20 rows per page.
TMDB Discover cannot be read past page 500.
That means one Discover query window can expose at most about 10,000 rows.
```

If a broad request has to be split, the logs show:

```text
tmdb-window-split
```

The response includes `windowsSplit`, so you can see how many splits happened.

If one single day is still over 500 pages, the Worker stops and returns:

```text
stopReason: "single_day_page_cap_reached"
```

That gives a precise resume/debug point in `stoppedWindow`.

TMDB rate-limit rule:

```text
TMDB disabled the old hard limit of 40 requests per 10 seconds.
TMDB still says there are upper limits somewhere around 40 requests per second.
TMDB also says to respect 429 responses.
```

Engineering rule for this Worker:

```text
Do not fire TMDB requests as fast as JavaScript can schedule them.
Do not use unbounded Promise.all(...) across TMDB movie ids.

Use a small request gate:
  target no more than 35 TMDB requests per rolling 1-second window
  pause before sending the next request if the gate is full
  if TMDB returns 429, wait and retry with backoff
```

This is not meant to be alarming.

Our current plan does not run multiple TMDB load jobs at the same time:

```text
1. one manual initial TMDB load
2. one weekly Cron refresh later
```

So a simple in-memory request gate is acceptable for this first version.

Plain meaning:

```text
The limiter keeps one running TMDB job from sending requests too fast.
That matches the current plan because we only intend to run one TMDB job at a time.
```

Only revisit this if the plan changes to allow overlapping TMDB jobs.

Step 9A-1
<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, add these new TMDB request helper functions before the discover/enrichment helpers.</div>

Open:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/src/index.ts
```

Place these helper functions above the `export default { ... }` Worker object, near the other helper functions.

```ts
const TMDB_MAX_REQUESTS_PER_SECOND = 35;
const TMDB_MAX_RETRIES = 3;
const tmdbRequestTimestamps: number[] = [];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTmdbRequestSlot() {
  while (true) {
    const now = Date.now();
    const oneSecondAgo = now - 1000;

    while (
      tmdbRequestTimestamps.length > 0 &&
      tmdbRequestTimestamps[0] <= oneSecondAgo
    ) {
      tmdbRequestTimestamps.shift();
    }

    if (tmdbRequestTimestamps.length < TMDB_MAX_REQUESTS_PER_SECOND) {
      tmdbRequestTimestamps.push(now);
      return;
    }

    const oldestRequest = tmdbRequestTimestamps[0];
    const waitMs = Math.max(1000 - (now - oldestRequest), 50);
    await sleep(waitMs);
  }
}

async function fetchTmdbJson(url: URL, env: Env) {
  for (let attempt = 0; attempt <= TMDB_MAX_RETRIES; attempt += 1) {
    await waitForTmdbRequestSlot();

    if (!env.TMDB_API_KEY) {
      throw new Error("TMDB_API_KEY is missing.");
    }

    url.searchParams.set("api_key", env.TMDB_API_KEY);

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
      },
    });

    if (response.status !== 429 && response.status < 500) {
      if (!response.ok) {
        throw new Error(`TMDB request failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    }

    if (attempt === TMDB_MAX_RETRIES) {
      throw new Error(`TMDB request failed after retries: ${response.status} ${response.statusText}`);
    }

    const retryAfterSeconds = Number(response.headers.get("Retry-After"));
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : 1000 * (attempt + 1);

    await sleep(retryAfterMs);
  }

  throw new Error("TMDB request failed unexpectedly.");
}

```
Step 9A-2
<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, add this new Worker-side TMDB discover helper after `fetchTmdbJson(...)`.</div>

```ts
async function getTmdbDiscoverPage(
  page: number,
  beginDate: string,
  env: Env,
  endDate?: string
) {
  const url = new URL("https://api.themoviedb.org/3/discover/movie");
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort_by", "popularity.desc");
  url.searchParams.set("primary_release_date.gte", beginDate);
  url.searchParams.set("watch_region", "US");
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("include_video", "false");

  if (endDate) {
    url.searchParams.set("primary_release_date.lte", endDate);
  }

  return fetchTmdbJson(url, env);
}
```

For the one-time historical backfill:

```text
call getTmdbDiscoverPage(...) inside repeated date windows
```

For the recurring weekly TMDB refresh:

```text
call getTmdbDiscoverPage(...) with the current max release date as beginDate
and no endDate
```

Step 9A-3
<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, add this new helper that reads the current TMDB release-date cursor from D1.</div>

Place it near `getTmdbDiscoverPage(...)`, before the route handler that will call it.

```ts
async function getTmdbRefreshStartDate(env: Env, fallbackBeginDate = "2000-01-01") {
  const result = await env.DB
    .prepare(
      `SELECT MAX(release_date) AS max_release_date
       FROM tmdb_movies_staging`
    )
    .first<{ max_release_date: string | null }>();

  return result?.max_release_date ?? fallbackBeginDate;
}
```

Step 9A-4
<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, use this import-time adult gatekeeper inside the loop that processes each `discover/movie` result.</div>

This is not a standalone helper. It belongs inside the future `/admin/import/tmdb/load-manual` route logic, before adding that row's statements to the current page batch.

```ts
if (discoverResult.adult) {
  continue;
}
```

That means adult records are rejected before D1.

Do not reject a row only because `discoverResult.video` is true.

Plain meaning:

```text
include_video=false asks TMDB not to include video-only results.
If a normal movie row still has video=true, keep the movie.
The MovieApp does not need the video flag, so we do not store it.
```

They are not stored as columns.

Step 9A-5
<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, add this new helper for the primary TMDB-side D1 write statements.</div>

### Special Section: Why TMDB D1 Writes Use Batching

This section is important in the same way the IMDb Queue section was important.

The first TMDB version worked locally, but remote Cloudflare was much slower.

Why:

```text
Local D1:
  Worker -> local Miniflare/Wrangler D1 -> SQLite file on your Mac

Remote D1:
  Worker -> Cloudflare D1 service -> remote database work -> Worker
```

The code was doing the same logical SQL either way, but remote D1 made the repeated Worker-to-D1 trips expensive.

Old non-batched mental model:

```text
for each TMDB page:
  for each movie on that page:
    await insert movie into tmdb_movies_staging
    await delete old genres for that movie

    for each genre for that movie:
      await insert genre into movie_genres
```

Plain meaning:

```text
The Worker called D1 separately for every movie insert,
every genre delete,
and every genre insert.
```

New batched mental model:

```text
for each TMDB page:
  pageStatements = []

  for each movie on that page:
    add movie insert statement to pageStatements
    add genre delete statement to pageStatements

    for each genre for that movie:
      add genre insert statement to pageStatements

  await env.DB.batch(pageStatements)
```

Plain meaning:

```text
The SQL statements still run in order.
But the Worker sends the page's whole stack of statements to D1 together.
```

SQL-side mental model for one TMDB page:

```sql
BEGIN;

INSERT OR REPLACE INTO tmdb_movies_staging (...)
VALUES (...movie 1...);

DELETE FROM movie_genres
WHERE tmdb_id = movie_1_tmdb_id;

INSERT INTO movie_genres (tmdb_id, genre_id)
VALUES (movie_1_tmdb_id, genre_1);

INSERT INTO movie_genres (tmdb_id, genre_id)
VALUES (movie_1_tmdb_id, genre_2);

INSERT OR REPLACE INTO tmdb_movies_staging (...)
VALUES (...movie 2...);

DELETE FROM movie_genres
WHERE tmdb_id = movie_2_tmdb_id;

INSERT INTO movie_genres (tmdb_id, genre_id)
VALUES (movie_2_tmdb_id, genre_1);

COMMIT;
```

That is not one giant SQL string.

It is a stack of ordered prepared statements handed to Cloudflare D1 with:

```ts
await env.DB.batch(pageStatements);
```

Why it became faster:

```text
Slow:
  Worker calls D1 thousands of times and waits after each call.

Fast:
  Worker calls D1 once per TMDB page and D1 runs that page's statements internally.
```

Restaurant analogy:

```text
Slow:
  call the restaurant 80 times and order one item each call

Fast:
  call once and order 80 items

The kitchen may still cook items in order,
but you avoided 79 extra phone calls.
```

Place it near the TMDB discover helper. The manual TMDB route will call this helper once for each accepted `discover/movie` result, collect the returned statements for the current TMDB page, then write that page with `env.DB.batch(...)`.

```ts
function buildTmdbPrimaryStatements(discoverResult: any, env: Env) {
  const tmdbId = discoverResult.id;
  const genreIds = Array.isArray(discoverResult.genre_ids)
    ? [...new Set(discoverResult.genre_ids.filter((genreId) => typeof genreId === "number"))]
    : [];
  const statements = [
    env.DB.prepare(
      `INSERT OR REPLACE INTO tmdb_movies_staging (
        tmdb_id,
        imdb_id,
        title,
        poster_path,
        release_date,
        us_certification,
        popularity,
        imported_at
      )
      VALUES (?, NULL, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)`
    ).bind(
      tmdbId,
      discoverResult.title ?? "",
      discoverResult.poster_path ?? null,
      discoverResult.release_date ?? null,
      discoverResult.popularity ?? 0
    ),
    env.DB.prepare("DELETE FROM movie_genres WHERE tmdb_id = ?").bind(tmdbId),
  ];

  for (const genreId of genreIds) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO movie_genres (tmdb_id, genre_id)
         VALUES (?, ?)`
      ).bind(tmdbId, genreId)
    );
  }

  return statements;
}
```

Why this helper returns statements instead of running them immediately:

```text
Local D1 is fast even when every statement runs one by one.
Remote D1 is much slower when every statement is awaited separately.

So the Worker collects all D1 statements for one TMDB page, then sends them
with env.DB.batch(...).
```

Why `genreIds` is de-duplicated before inserting:

```text
movie_genres has a primary key on (tmdb_id, genre_id).
Each different genre for the same movie is still inserted.
Only exact repeated genre ids from the same TMDB result are removed before D1.
The INSERT stays strict so an unexpected database conflict still fails loudly.
```

Step 9A-6: Test The Primary TMDB Load Locally

Do not deploy first.

Local first proves the route, TMDB request code, adult gate, and D1 upserts work against the local D1 database before touching remote D1.

<div><span class="ooo">[</span>X<span class="ooo">]</span> Open terminal 1 in the Cloudflare repo and run the app locally:

```bash
cd /Users/croncallo/repo/MovieApp-Cloudflare
npm run dev
```

Leave that terminal running.

Open terminal 2 in the same repo:

```bash
cd /Users/croncallo/repo/MovieApp-Cloudflare
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Call the local TMDB primary-load endpoint with a small limit:</div>

```bash
curl "http://localhost:8787/admin/import/tmdb/load-manual?limit=100&beginDate=2000-01-01&endDate=2000-12-31"
```

Expected response shape:

```json
{
  "beginDate": "2000-01-01",
  "endDate": "2000-12-31",
  "pagesRead": 1,
  "rowsSeen": 100,
  "rowsInserted": 100,
  "totalPagesSeen": 422,
  "tmdbDiscoverMaxPage": 500,
  "windowsLoaded": 1,
  "windowsSplit": 0,
  "pendingWindows": 0,
  "stoppedWindow": null,
  "stopReason": "limit_reached",
  "startedAt": "2026-04-28T00:00:00.000Z",
  "endedAt": "2026-04-28T00:00:01.000Z",
  "durationMs": 1000
}
```

The response intentionally does not return every inserted `tmdb_id`.

Plain meaning:

```text
For small tests, returning every id is convenient.
For real loads, returning thousands or hundreds of thousands of ids makes the HTTP response huge and slow.
Use D1 count/preview queries to inspect the inserted rows instead.
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Confirm local TMDB staging rows were inserted:</div>

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT COUNT(*) AS tmdb_count FROM tmdb_movies_staging;"
```

Expected count:

```text
100
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Preview the first 50 local TMDB staging rows to make sure the data shape looks normal:</div>

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT tmdb_id, title, release_date, popularity FROM tmdb_movies_staging ORDER BY release_date, tmdb_id LIMIT 50;"
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Confirm local genre child rows were inserted:</div>

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT COUNT(*) AS genre_count FROM movie_genres;"
```

Expected result:

```text
greater than 0
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Preview the first 50 local TMDB staging rows again if you want a wider sample:</div>

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT tmdb_id, title, release_date, popularity FROM tmdb_movies_staging ORDER BY release_date, tmdb_id LIMIT 50;"
```

If local fails:

```text
Stop here.
Fix local before deploying or touching remote D1.
```

Step 9A-7: Deploy Before Remote Testing

<div><span class="ooo">[</span>X<span class="ooo">]</span> Only after the local test works, deploy the Worker.

```bash
npm run deploy
```

Plain meaning:

```text
Local wrangler dev runs the code on your Mac.
Remote testing calls the deployed Worker on Cloudflare.

The remote Worker will not have the Step 9A code until you deploy.
```

Step 9A-8: Test The Primary TMDB Load Remotely

<div><span class="ooo">[</span>X<span class="ooo">]</span> Call the deployed TMDB primary-load endpoint with the same small limit:</div>

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/tmdb/load-manual?limit=100&beginDate=2000-01-01&endDate=2000-12-31"
```

Expected response shape:

```json
{
  "beginDate": "2000-01-01",
  "endDate": "2000-12-31",
  "pagesRead": 1,
  "rowsSeen": 100,
  "rowsInserted": 100,
  "totalPagesSeen": 422,
  "tmdbDiscoverMaxPage": 500,
  "windowsLoaded": 1,
  "windowsSplit": 0,
  "pendingWindows": 0,
  "stoppedWindow": null,
  "stopReason": "limit_reached",
  "startedAt": "2026-04-28T00:00:00.000Z",
  "endedAt": "2026-04-28T00:00:01.000Z",
  "durationMs": 1000
}
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> While testing remotely, keep a separate terminal open:

```bash
npx wrangler tail
```

The Worker logs should show one start line and one end line:

```text
tmdb-load-manual-start
tmdb-load-manual-end
```

The end log includes `durationMs`, `pagesRead`, `rowsSeen`, and `rowsInserted`.

<div><span class="ooo">[</span> X<span class="ooo">]</span> Confirm remote TMDB staging rows were inserted:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS tmdb_count FROM tmdb_movies_staging;"
```

Expected count after the first remote `limit=100` test:

```text
100
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Preview the first 50 remote TMDB staging rows to make sure the data shape looks normal:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT tmdb_id, title, release_date, popularity FROM tmdb_movies_staging ORDER BY release_date, tmdb_id LIMIT 50;"
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Confirm remote genre child rows were inserted:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS genre_count FROM movie_genres;"
```

Expected result:

```text
greater than 0
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Preview the first 50 remote TMDB staging rows again if you want a wider sample:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT tmdb_id, title, release_date, popularity FROM tmdb_movies_staging ORDER BY release_date, tmdb_id LIMIT 50;"
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> If the remote test works, try a slightly larger same-window run:

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/tmdb/load-manual?limit=1000&beginDate=2000-01-01&endDate=2000-12-31"
```

Important:

```text
beginDate and endDate must be real YYYY-MM-DD dates.
beginDate must be less than or equal to endDate.

Example valid window:
  beginDate=2000-01-01&endDate=2000-12-31

Example invalid window:
  beginDate=10000-01-01&endDate=2000-12-31
```

<div><span class="ooo">[</span>X<span class="ooo">]</span> Then re-check:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS tmdb_count FROM tmdb_movies_staging;"
```

Stop before a historical backfill until:

```text
local limit=100 works
remote limit=100 works
remote limit=1000 works
Cloudflare Worker logs show no TMDB 429 or D1 write errors
```

<div><span class="ooo">[</span>X<span class="ooo">]</span>  Complete the historical backfills for 2000 and greater by three years at a time; then by decade prior to 2000


### Step 9B: TMDB Enrichment Pass

Step 9B happens after Step 9A.

Step 9A loaded the base TMDB rows from `discover/movie` into `tmdb_movies_staging`.

Step 9B enriches those already-loaded `tmdb_id` values through TMDB movie details:

```text
/movie/{tmdb_id}?append_to_response=external_ids,release_dates,watch/providers
```

That one TMDB detail request refreshes the fields MovieApp needs but `discover/movie` did not give us:

```text
imdb_id                -> joins TMDB rows to IMDb ratings
us_certification       -> supports PG, PG-13, R, etc.
US flatrate providers  -> supports the app's streamer filters
```

Important design decision:

```text
Do not use TMDB /movie/changes as the main refresh driver.

Reason:
  provider/streamer freshness is just as critical as ratings/certifications,
  and the changes endpoint does not give us the watch-provider payload we need.

Instead:
  select rows from our own D1 table based on tmdb_enriched_at.
  refresh the full detail payload for those rows.
```

That means initial backfill and recurring refresh use the same selection idea:

```sql
SELECT tmdb_id
FROM tmdb_movies_staging
WHERE (tmdb_enriched_at IS NULL
   OR tmdb_enriched_at < datetime('now', '-' || ? || ' days'))
  AND tmdb_enrichment_error IS NULL
ORDER BY
  tmdb_enriched_at IS NOT NULL,
  tmdb_enriched_at,
  tmdb_id
LIMIT ?
```

Plain meaning:

```text
1. first pick movies that have never been enriched
2. then pick the oldest enriched movies whose enrichment is stale
3. do not pick terminal-error rows again
4. stop at the limit for this run
```

The important testing behavior:

```text
Each test run updates only rows that still qualify.

If you enrich 1000 rows, those rows get tmdb_enriched_at.
The next run moves on to the next qualifying rows.
It does not redo fresh rows unless they become older than refreshOlderThanDays.
```

### Step 9B-1: Why TMDB Enrichment Moved To A Queue

The first enrichment version processed the selected TMDB rows directly inside the manual endpoint or cron invocation.

That worked for small tests, but it was the wrong production shape.

What we learned:

```text
1000 rows direct:
  worked, but still took about a minute remotely

20000 rows direct:
  too close to Worker CPU/time limits

cron direct:
  could hit exceededCpu before the chunk finished

browser/manual direct:
  keeps the HTTP request open for the whole job
```

The queue-based design fixes that:

```text
manual endpoint or cron:
  selects tmdb_id rows
  creates an import_job_runs progress row
  sends small TMDB enrichment messages to the queue
  returns quickly

queue consumer:
  receives one small message
  calls TMDB details for those IDs
  writes D1 updates in batches
  updates import_job_runs progress
```

This is the same reason we used a queue for the IMDb file load: large import work is safer when it is broken into retryable pieces instead of one giant Worker invocation.

### Step 9B-2: Add The Enrichment Tracking Columns

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add migration `migrations/0002_add_tmdb_enriched_at.sql`.</div>

Why:

```text
tmdb_enriched_at is the single field that says:
  this movie has gone through the full TMDB detail enrichment refresh.

Do not use imdb_id IS NULL, us_certification IS NULL, or provider rows missing
to decide whether a movie still needs enrichment.

Those nulls can be valid:
  some movies genuinely have no IMDb id
  some movies genuinely have no US certification
  some movies genuinely have no US flatrate providers
```

Migration:

```sql
ALTER TABLE tmdb_movies_staging
ADD COLUMN tmdb_enriched_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tmdb_movies_staging_enriched_at
ON tmdb_movies_staging (tmdb_enriched_at, tmdb_id);
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add migration `migrations/0005_add_tmdb_enrichment_error.sql`.</div>

Why:

```text
Some TMDB IDs can appear in discover/movie but later return 404 from
/movie/{tmdb_id}.

Those are terminal enrichment errors for our use case.

If we do not record that, the same bad IDs get selected forever.
```

Migration:

```sql
ALTER TABLE tmdb_movies_staging
ADD COLUMN tmdb_enrichment_error TEXT;

CREATE INDEX IF NOT EXISTS idx_tmdb_movies_staging_enrichment_error
ON tmdb_movies_staging (tmdb_enrichment_error, tmdb_id);
```

Apply locally before local tests:

```bash
npm run db:migrate:local
```

Apply remotely before remote tests:

```bash
npm run db:migrate:remote
```

### Step 9B-3: Add The Queue Binding

<div><span class="ooo">[</span> X <span class="ooo">]</span> In `wrangler.jsonc`, add a TMDB enrichment queue producer and consumer.</div>

Current queue config:

```jsonc
"queues": {
  "producers": [
    {
      "binding": "IMDB_RATING_QUEUE",
      "queue": "movieapp-imdb-rating-import-queue"
    },
    {
      "binding": "TMDB_ENRICHMENT_QUEUE",
      "queue": "movieapp-tmdb-enrichment-queue"
    }
  ],
  "consumers": [
    {
      "queue": "movieapp-imdb-rating-import-queue",
      "max_batch_size": 100,
      "max_batch_timeout": 10,
      "max_retries": 5
    },
    {
      "queue": "movieapp-tmdb-enrichment-queue",
      "max_batch_size": 1,
      "max_batch_timeout": 10,
      "max_retries": 5,
      "max_concurrency": 1
    }
  ]
}
```

Plain meaning:

```text
producer binding:
  lets Worker code call env.TMDB_ENRICHMENT_QUEUE.sendBatch(...)

consumer config:
  tells Cloudflare that this same Worker should receive messages from
  movieapp-tmdb-enrichment-queue

max_concurrency: 1:
  intentionally starts conservative so multiple queue consumers do not multiply
  the TMDB request rate at the same time
```

Current cron config is listed in Step 20.

The current recurring schedule has four cron entries:

```jsonc
"triggers": {
  "crons": [
    "0 22 * * 1",
    "0 4 * * 2",
    "0 10 * * 2",
    "0 1 * * 3"
  ]
}
```

Cloudflare cron expressions are UTC. See Step 20 for the Eastern-time meaning and the reason the enrichment/final-table jobs use fixed fallback times.

### Step 9B-4: Add The Queue Message Types And Constants

<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, add the TMDB queue binding to `Env`.</div>

```ts
export interface Env extends Cloudflare.Env {
  DB: D1Database;
  IMDB_RATING_QUEUE: Queue<ImdbRatingQueueMessage>;
  TMDB_ENRICHMENT_QUEUE: Queue<TmdbEnrichmentQueueMessage>;
  TMDB_API_KEY: string;
}
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add the TMDB queue message type.</div>

```ts
type TmdbEnrichmentQueueMessage = {
  kind: "tmdb-enrichment";
  jobRunId: string;
  tmdbIds: number[];
};

type WorkerQueueMessage = ImdbRatingQueueMessage | TmdbEnrichmentQueueMessage;
```

Why the message has `kind`:

```text
The Worker now consumes two different queue message shapes:
  IMDb rating rows
  TMDB enrichment IDs

kind: "tmdb-enrichment" lets queue(...) tell which message type it received.
```

Current constants:

```ts
const TMDB_MAX_REQUESTS_PER_SECOND = 35;
const TMDB_MAX_RETRIES = 3;
const TMDB_ENRICH_D1_BATCH_MOVIES = 100;
const TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE = 100;
const TMDB_ENRICH_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_ENRICH_TMDB_CONCURRENCY = 25;
const TMDB_ENRICH_JOB_NAME = "tmdb-enrich";
const TMDB_ENRICH_LOCK_MINUTES = 30;
```

Plain meaning:

```text
TMDB_MAX_REQUESTS_PER_SECOND:
  our request-start governor stays below TMDB's rough 40-per-second upper range

TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE:
  each queue message handles about 100 movies

TMDB_ENRICH_D1_BATCH_MOVIES:
  D1 writes flush after about 100 movies worth of prepared statements

TMDB_ENRICH_TMDB_CONCURRENCY:
  up to 25 TMDB detail requests can be in flight inside one queue message
```

Important:

```text
Concurrency does not remove the rate governor.

fetchTmdbJson(...)
-> waitForTmdbRequestSlot()
-> no more than 35 TMDB request starts per rolling second
```

### Step 9B-5: Add TMDB Detail And Parsing Helpers

<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, add `getTmdbMovieDetails(...)` after the Step 9A TMDB helpers.</div>

```ts
async function getTmdbMovieDetails(tmdbId: number, env: Env) {
  const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
  url.searchParams.set(
    "append_to_response",
    "external_ids,release_dates,watch/providers",
  );

  return fetchTmdbJson<TmdbMovieDetails>(url, env);
}
```

Why:

```text
This is the one TMDB request per movie.
append_to_response keeps IMDb id, certifications, and watch providers together.
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add parsing helpers for US certification and US flatrate providers.</div>

```text
getUsCertification(details)
getUsFlatrateProviderIds(details)
```

The provider helper dedupes provider IDs before writing them.

### Step 9B-6: Add The D1 Statement Builders

<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, add `buildTmdbEnrichmentStatements(...)`.</div>

For one successful movie, the SQL intent is:

```sql
UPDATE tmdb_movies_staging
SET imdb_id = ?,
    us_certification = ?,
    tmdb_enriched_at = CURRENT_TIMESTAMP,
    tmdb_enrichment_error = NULL
WHERE tmdb_id = ?;

DELETE FROM movie_watch_providers
WHERE tmdb_id = ?
  AND region = 'US';

INSERT INTO movie_watch_providers (tmdb_id, provider_id, region)
VALUES (?, ?, 'US');
```

Why the provider table starts with `DELETE`:

```text
Watch providers can change.

If a movie used to be on provider A and is now only on provider B,
we must remove the old provider A row before inserting the fresh provider rows.
```

Why `env.DB.batch(...)` matters:

```text
The SQL statements are still separate prepared statements.
batch does not turn them into one giant SQL statement.

But it does send a group of statements to D1 in one round trip.
That is why it was much faster remotely than one D1 call per statement.
```

Pseudo-code:

```text
for each movie:
  build UPDATE statement
  build DELETE-old-providers statement
  build INSERT-new-provider statements
  add statements to pending list

when pending list reaches about 100 movies:
  env.DB.batch(pendingStatements)
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add terminal-error statement handling.</div>

For a TMDB detail `404 Not Found`, the SQL intent is:

```sql
UPDATE tmdb_movies_staging
SET imdb_id = NULL,
    us_certification = NULL,
    tmdb_enriched_at = CURRENT_TIMESTAMP,
    tmdb_enrichment_error = ?
WHERE tmdb_id = ?;

DELETE FROM movie_watch_providers
WHERE tmdb_id = ?
  AND region = 'US';
```

Plain meaning:

```text
This TMDB id came from discover/movie,
but the detail endpoint no longer has the movie.

Mark it as checked with an error so:
  it does not get selected forever
  Step 10 will not copy it into movie_list_items
```

### Step 9B-7: Add The Progress Tables

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add `migrations/0003_add_import_job_locks.sql`.</div>

Why:

```text
The lock prevents a new enqueue job from starting while another one is already active.
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add `migrations/0004_add_import_job_runs.sql`.</div>

Why:

```text
Cloudflare Observability events can arrive late or appear in groups.
import_job_runs gives us D1-backed progress that SQL tasks can query.
```

Important fields:

```text
job_run_id
status
selected_count
queued_count
processed_count
updated_count
error_count
provider_rows_inserted
started_at
last_progress_at
ended_at
last_error
```

### Step 9B-8: Add The Enqueue Function

<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, add `enqueueTmdbEnrichmentJob(...)`.</div>

What it does:

```text
1. optionally gets the import-job lock
2. checks import_job_runs for an already queued/running TMDB enrichment job
3. selects qualifying tmdb_id rows
4. creates an import_job_runs row
5. groups IDs into queue messages
6. sends messages with env.TMDB_ENRICHMENT_QUEUE.sendBatch(...)
7. returns a small summary immediately
```

The manual endpoint does not enrich the rows itself anymore.

It enqueues the job.

That is why you can kick off the work and shut down your computer: the remote queue consumers keep running inside Cloudflare.

### Step 9B-9: Add The Queue Consumer

<div><span class="ooo">[</span> X <span class="ooo">]</span> In `src/index.ts`, update `queue(...)` so it can handle both IMDb and TMDB messages.</div>

Pseudo-code:

```text
for each message in batch.messages:
  if message.body.kind === "tmdb-enrichment":
    read tmdbIds from the message
    process those TMDB IDs
    update import_job_runs
    ack the message
  else:
    process the IMDb rating rows
    ack the message
```

Queue events to expect:

```text
tmdb-enrich-queue-message-start
tmdb-enrich-row-error
tmdb-enrich-queue-message-end
```

The queue consumer uses `processTmdbEnrichmentRows(...)`.

That function:

```text
1. calls TMDB details for the message's IDs
2. builds success or terminal-error SQL statements
3. writes D1 batches
4. updates import_job_runs
5. logs a queue-message summary
```

### Step 9B-10: Add The Manual And Progress Endpoints

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add the manual enqueue endpoint.</div>

Route:

```text
/admin/import/tmdb/enrich-manual
```

Remote example:

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/tmdb/enrich-manual?limit=300000&refreshOlderThanDays=7"
```

Parameters:

```text
limit:
  how many qualifying tmdb_id rows to enqueue

refreshOlderThanDays:
  rows older than this can be selected again
  null tmdb_enriched_at rows always qualify
```

<div><span class="ooo">[</span> X <span class="ooo">]</span> Add the progress endpoint.</div>

Route:

```text
/admin/import/tmdb/enrich-progress
```

Remote example:

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/tmdb/enrich-progress"
```

This returns recent rows from `import_job_runs`.

Use this endpoint or the VS Code SQL task when Observability is delayed.

### Step 9B-11: Queue Operation Cost Check

The queue message size is intentionally around 100 TMDB IDs per message.

Approximate queue billing math:

```text
1 queue write
1 queue read
1 queue delete
= about 3 billable queue operations per message
```

For the full TMDB staging table:

```text
1,011,396 movies / 100 IDs per message
= about 10,114 queue messages

10,114 messages * about 3 operations
= about 30,342 queue operations per full TMDB enrichment pass
```

That is small compared with the paid Queues included monthly usage.

The bigger queue cost is the IMDb file import because it uses 33 IMDb rows per message:

```text
1,665,567 IMDb rows / 33 rows per message
= about 50,472 queue messages

50,472 messages * about 3 operations
= about 151,416 queue operations per IMDb import
```

Four IMDb imports per month:

```text
151,416 * 4 = about 605,664 queue operations
```

Add one weekly TMDB enrichment pass:

```text
30,342 * 4 = about 121,368 queue operations
```

Together:

```text
about 727,032 queue operations per month
```

That is still under the paid plan's 1 million included Queues operations.

### Step 9B-12: Test And Monitor TMDB Enrichment

<div><span class="ooo">[</span>   <span class="ooo">]</span> Deploy after local code and migration checks look good.</div>

```bash
npm run deploy
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Enqueue a small remote test first.</div>

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/tmdb/enrich-manual?limit=1000&refreshOlderThanDays=7"
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Check D1-backed progress.</div>

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/tmdb/enrich-progress"
```

Or run this VS Code task:

```text
remote-tmdb-progress
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Check TMDB staging counts.</div>

```text
remote-tmdb-counts
```

That task shows:

```text
total TMDB staging rows
enriched rows
terminal-error rows
rows with IMDb id
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Check terminal errors.</div>

```text
remote-tmdb-errors
```

Most terminal errors we saw were TMDB detail `404 Not Found` rows.

Those rows are not selected again and are excluded from the final `movie_list_items` build in Step 10.

Dashboard path for logs:

```text
Workers & Pages
movieapp-cloudflare
Observability
Events
Live
Last 1 hour
```

Useful note:

```text
Cloudflare Observability may show logs late or in groups.
The import_job_runs table is the steadier progress source.
```

### Step 9B-13: Saved SQL And VS Code Tasks

Support SQL lives here:

```text
support/sql/
```

Task wrappers:

```text
support/run-sql-local.sh
support/run-sql-remote.sh
```

Why the wrapper scripts use `--command` instead of `--file`:

```text
Wrangler remote --file is shaped like an import flow and can return an
execution summary instead of SELECT result rows.

The wrappers read the SQL file and pass it through --command so SELECT tasks
print the actual rows in the VS Code terminal.
```

Useful task names:

```text
remote-tmdb-progress
remote-tmdb-counts
remote-tmdb-errors
remote-staging-to-movie-list-ready
remote-staging-to-movie-list-top-50
remote-staging-to-movie-list-insert
remote-movie-list-counts
remote-movie-list-top-50
remote-movie-search-by-year
remote-sys-objects
remote-sys-migrations
```

Each remote task has a matching local task with `local-` at the front.

VS Code task picker:

```text
Command Palette
Tasks: Run Task
pick the task name
```

Workspace setting used to keep recently used tasks from jumping to the top:

```json
"task.quickOpen.history": 0
```

<a id="phase-10-build-the-final-movie-list-table"></a>
## Step 10: Build The Final Movie List Table

This is the first step where the IMDb side and the TMDB side finally meet.

After the TMDB-side tables and the IMDb staging table have data, populate `movie_list_items`.

`movie_list_items` is a real D1 table.

It is not a SQLite/D1 index.

The name means:

```text
one row = one movie item that can appear in the MovieApp list/search results
```

Use a `LEFT JOIN` to IMDb ratings here on purpose.

That means the final table keeps enriched TMDB rows even when the IMDb ratings
file does not have a matching rating row.

```text
tmdb movie has matching imdb_id / tconst row:
  keep it with imdb_rating and imdb_vote_count

tmdb movie has no matching imdb_id / tconst row:
  keep it with imdb_rating = NULL and imdb_vote_count = NULL
```

Important:

```text
matching IMDb row not required
rating value not required
vote-count value not required
```

Also important:

```text
Do not copy TMDB rows with terminal enrichment errors into movie_list_items.

Those are rows where:
  tmdb_enrichment_error IS NOT NULL

Example:
  discover/movie returned the TMDB id,
  but /movie/{tmdb_id} later returned 404 Not Found.

Those rows are useful to keep in staging for audit/debugging,
but they should not appear in the public app table.
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Preview the rows that are ready to become final `movie_list_items` rows:</div>

VS Code task:

```text
remote-staging-to-movie-list-top-50
```

That task runs:

```text
support/sql/staging-to-movie-list-preview-50.sql
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Build the final `movie_list_items` table from the remote staging tables:</div>

VS Code task:

```text
remote-staging-to-movie-list-insert
```

That task runs:

```text
support/sql/staging-to-movie-list-insert.sql
```

Why this saved SQL file exists:

```text
This is mainly a manual support/debugging script.

The final long-term plan should not be:
  remember to run this by hand forever

The long-term plan should be an ordered automation:
  1. IMDb ratings staging refresh finishes
  2. TMDB primary staging refresh finishes
  3. TMDB enrichment refresh finishes
  4. movie_list_items rebuild runs last

The saved SQL stays useful because it gives us a known-good runnable version
of the final Step 10 insert while we are testing, checking counts, or doing a
manual recovery before the scheduled orchestration exists.
```

Big warning before using the saved SQL file:

```text
The saved SQL file deletes and rebuilds movie_list_items.

Do not use the saved SQL file as the preferred production rebuild path.
It exists for manual support/debugging.

The safer production path is:
  GET /admin/import/movie-list/rebuild-manual

or:
  the scheduled Final Table cron job

Why:
  the Worker code uses env.DB.batch([...]) for the DELETE and INSERT.
  D1 batch statements are documented as transactional, so a failed INSERT
  should roll back the DELETE.

The saved SQL file goes through Wrangler as a multi-statement --command.
Do not assume it has the same rollback safety as the Worker batch path
unless that has been explicitly verified.
```

The Worker rebuild has a readiness guard before it runs the destructive
delete/reinsert batch.

The guard checks:

```text
1. no TMDB enrichment job is still queued/running
2. tmdb_movies_staging has rows
3. imdb_ratings_staging has rows
4. no non-terminal TMDB rows still need enrichment under the 7-day freshness rule
5. the final TMDB rows would produce at least one movie_list_items row
```

The key readiness condition is:

```sql
WHERE (tmdb_enriched_at IS NULL
   OR tmdb_enriched_at < datetime('now', '-7 days'))
  AND tmdb_enrichment_error IS NULL
```

Plain meaning:

```text
Do not rebuild movie_list_items while there are still usable TMDB rows that
have never been enriched, or whose enrichment is older than the same 7-day
freshness rule used by the enrichment job.

Terminal TMDB errors are allowed because those rows are intentionally excluded
from the final public table.
```

The saved SQL is:

```bash
npx wrangler d1 execute movieapp-db --remote --command "
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
  t.tmdb_id,
  t.title,
  t.poster_path,
  t.release_date,
  t.us_certification,
  i.average_rating AS imdb_rating,
  i.num_votes AS imdb_vote_count,
  COALESCE(t.popularity, 0),
  CURRENT_TIMESTAMP
FROM tmdb_movies_staging t
LEFT JOIN imdb_ratings_staging i
  ON i.imdb_id = t.imdb_id
WHERE t.tmdb_enriched_at IS NOT NULL
  AND t.tmdb_enrichment_error IS NULL
;
"
```

Why these two `WHERE` lines are there:

```text
t.tmdb_enriched_at IS NOT NULL:
  the TMDB detail enrichment has actually run for this row

t.tmdb_enrichment_error IS NULL:
  the row did not hit a terminal TMDB detail error like 404 Not Found
```

Why the IMDb join is a `LEFT JOIN`:

```text
IMDb ratings improve sorting/filtering when they exist,
but missing IMDb rating data should not make an otherwise valid TMDB movie
disappear from MovieApp.
```

The Worker rebuild does not run one giant `INSERT ... SELECT`.

Why:

```text
The final LEFT JOIN build can write about 1 million rows.
A single D1 storage operation for that many rows can exceed D1's operation
timeout.
```

So the Worker rebuild:

```text
1. scans eligible TMDB rows by tmdb_id
2. upserts movie_list_items in 10,000-row chunks
3. logs movie-list-build-progress every 100,000 rows
4. deletes any no-longer-valid final rows in cleanup chunks
```

This makes the rebuild rerunnable. If a later chunk fails, rerunning the same
endpoint continues to upsert the same final rows instead of depending on one
giant all-or-nothing insert.

For the full production refresh, do not assume one giant `INSERT INTO ... SELECT ...` will always be safe.

The final production version should build `movie_list_items` in chunks.

Example chunk idea:

```text
1. choose a tmdb_id range
2. insert movie_list_items rows for that range
3. record progress
4. continue with the next range
```

That chunking can be handled by:

```text
admin endpoint for testing
Cron Trigger for scheduled rebuilds
Queue messages for retryable chunks
Workflow steps if we choose Cloudflare Workflows later
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Confirm the final row count:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS movie_list_count FROM movie_list_items;"
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Preview the best IMDb-rated rows:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT tmdb_id, title, imdb_rating, imdb_vote_count, release_date, us_certification FROM movie_list_items ORDER BY imdb_rating DESC, imdb_vote_count DESC LIMIT 20;"
```

<a id="phase-11-test-genre-filtering"></a>
## Step 11: Test Genre Filtering

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use the same TMDB genre ids that MovieApp already uses in:</div>

```text
/Users/croncallo/repo/MovieApp/src/components/ui/movieSearchFieldUtils.ts
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Run this example query for one genre:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "
SELECT
  m.tmdb_id,
  m.title,
  m.imdb_rating,
  m.poster_path
FROM movie_list_items m
JOIN movie_genres g
  ON g.tmdb_id = m.tmdb_id
WHERE g.genre_id = 28
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT 20;
"
```

`28` is usually TMDB's Action genre id.

<a id="phase-12-test-streamer-filtering"></a>
## Step 12: Test Streamer Filtering

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use the same TMDB provider ids that MovieApp already uses in:</div>

```text
/Users/croncallo/repo/MovieApp/src/components/ui/movieSearchFieldUtils.ts
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Run this example query for one provider:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "
SELECT
  m.tmdb_id,
  m.title,
  m.imdb_rating,
  m.poster_path,
  mwp.provider_id
FROM movie_list_items m
JOIN movie_watch_providers mwp
  ON mwp.tmdb_id = m.tmdb_id
WHERE mwp.region = 'US'
  AND mwp.provider_id = 8
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT 20;
"
```

`8` is currently Netflix in MovieApp's streamer list.

<a id="phase-13-sketch-the-future-movies-search-endpoint"></a>
## Step 13: Sketch The Future Movies Search Endpoint

This is a design step, not a build-it-right-now step.

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this as the target endpoint shape:</div>

```text
GET /movies/search
```

Example URLs:

```text
/movies/search?page=1&pageSize=20&sort=popular
/movies/search?beginDate=2020-01-01&endDate=2024-12-31&page=1&pageSize=20&sort=imdb_desc
/movies/search?certification=PG-13&page=1&pageSize=20&sort=imdb_desc
/movies/search?genreId=28&page=1&pageSize=20&sort=imdb_desc
/movies/search?providerId=8&region=US&page=1&pageSize=20&sort=imdb_desc
/movies/search?minImdbRating=7&page=1&pageSize=20&sort=imdb_desc
/movies/search?minImdbVotes=500&page=1&pageSize=20&sort=imdb_desc
/movies/search?genreId=28&providerId=8&region=US&certification=PG-13&minImdbRating=7&minImdbVotes=500&page=1&pageSize=20&sort=imdb_desc
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this as the target response shape:</div>

```json
{
  "movies": [
    {
      "tmdbId": 603,
      "title": "The Matrix",
      "posterPath": "/example.jpg",
      "posterUrl": "https://image.tmdb.org/t/p/w342/example.jpg",
      "imdbRating": 8.7,
      "imdbVoteCount": 2100000,
      "releaseDate": "1999-03-31"
    }
  ],
  "page": 1,
  "pageSize": 20
}
```

This endpoint reads `movie_list_items`, so it can return enriched TMDB movies
even when IMDb rating data is missing.

If IMDb rating data is missing, the response can return:

```json
{
  "imdbRating": null,
  "imdbVoteCount": null
}
```

The Worker can build `posterUrl` from `posterPath`.

Example:

```text
posterPath:
  /abc123.jpg

posterUrl:
  https://image.tmdb.org/t/p/w342/abc123.jpg
```

<a id="phase-14-sketch-the-future-movies-search-query"></a>
## Step 14: Sketch The Future Movies Search Query

This is the SQL shape the Worker will eventually grow into.

This is the basic SQL shape the Worker endpoint will eventually use.

<div><span class="ooo">[</span>   <span class="ooo">]</span> Start from this no-filter query shape:</div>

```sql
SELECT
  m.tmdb_id,
  m.title,
  m.poster_path,
  m.imdb_rating,
  m.imdb_vote_count,
  m.release_date
FROM movie_list_items m
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT ? OFFSET ?;
```

Current MovieApp search-page filters map to D1 like this:

```text
beginDate/endDate   -> m.release_date
movieRatings        -> m.us_certification
movieGenres         -> movie_genres.genre_id
movieStreamers      -> movie_watch_providers.provider_id
minImdbRating       -> m.imdb_rating
movieVoteCount      -> m.imdb_vote_count
movieSortBy         -> m.imdb_rating or m.popularity
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this shape for the release-date and certification filter:</div>

```sql
SELECT
  m.tmdb_id,
  m.title,
  m.poster_path,
  m.imdb_rating,
  m.imdb_vote_count,
  m.release_date
FROM movie_list_items m
WHERE m.release_date >= ?
  AND m.release_date <= ?
  AND m.us_certification = ?
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT ? OFFSET ?;
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this shape for the IMDb vote-count threshold:</div>

```sql
SELECT
  m.tmdb_id,
  m.title,
  m.poster_path,
  m.imdb_rating,
  m.imdb_vote_count,
  m.release_date
FROM movie_list_items m
WHERE m.imdb_vote_count >= ?
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT ? OFFSET ?;
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this shape for the IMDb rating plus vote-count threshold:</div>

```sql
SELECT
  m.tmdb_id,
  m.title,
  m.poster_path,
  m.imdb_rating,
  m.imdb_vote_count,
  m.release_date
FROM movie_list_items m
WHERE m.imdb_rating >= ?
  AND m.imdb_vote_count >= ?
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT ? OFFSET ?;
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this shape for the popularity sort:</div>

```sql
SELECT
  m.tmdb_id,
  m.title,
  m.poster_path,
  m.imdb_rating,
  m.imdb_vote_count,
  m.release_date
FROM movie_list_items m
ORDER BY m.popularity DESC
LIMIT ? OFFSET ?;
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this shape for the genre filter:</div>

```sql
SELECT
  m.tmdb_id,
  m.title,
  m.poster_path,
  m.imdb_rating,
  m.imdb_vote_count,
  m.release_date
FROM movie_list_items m
JOIN movie_genres g
  ON g.tmdb_id = m.tmdb_id
WHERE g.genre_id = ?
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT ? OFFSET ?;
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this shape for the streamer/provider filter:</div>

```sql
SELECT
  m.tmdb_id,
  m.title,
  m.poster_path,
  m.imdb_rating,
  m.imdb_vote_count,
  m.release_date
FROM movie_list_items m
JOIN movie_watch_providers mwp
  ON mwp.tmdb_id = m.tmdb_id
WHERE mwp.region = ?
  AND mwp.provider_id = ?
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT ? OFFSET ?;
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this shape for the combined genre plus streamer/provider filter:</div>

```sql
SELECT
  m.tmdb_id,
  m.title,
  m.poster_path,
  m.imdb_rating,
  m.imdb_vote_count,
  m.release_date
FROM movie_list_items m
JOIN movie_genres g
  ON g.tmdb_id = m.tmdb_id
JOIN movie_watch_providers mwp
  ON mwp.tmdb_id = m.tmdb_id
WHERE g.genre_id = ?
  AND mwp.region = ?
  AND mwp.provider_id = ?
ORDER BY m.imdb_rating DESC, m.imdb_vote_count DESC
LIMIT ? OFFSET ?;
```

<a id="phase-15-scale-the-cloudflare-jobs-carefully"></a>
## Step 15: Scale The Cloudflare Jobs Carefully

Both recurring import paths should run on Cloudflare, not from a laptop.

Do not jump from a 100-row test to the full dataset.

TMDB now has two separate operating modes:

```text
1. one-time manual historical backfill
2. later weekly incremental refresh
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use this scale-up order:</div>

```text
IMDb staging load:
  330 rows
  3,300 rows
  33,000 rows
  330,000 rows
  full file only after timing and limits look safe

TMDB one-time manual backfill:
  100 movies
  1,000 movies
  10,000 movies
  larger windows only after timing and TMDB API behavior look safe

TMDB weekly recurring refresh:
  start only after the initial TMDB backfill is complete
  read MAX(release_date) from tmdb_movies_staging
  use that as the next discover/movie lower bound
  weekly job should only process the new tail of the catalog
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Do not schedule the historical TMDB backfill on Cron.</div>

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use the recurring production schedule in Step 20 after the historical backfill is finished.</div>

Recurring job scope:

```text
IMDb recurring job:
  still re-read the full IMDb file for now

TMDB recurring job:
  weekly incremental refresh from the latest release_date already stored
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Cron scheduling details now live on their own page in Step 20.</div>

Current recurring-job split:

```text
IMDb Cron:
  whole-file refresh path

TMDB Primary Cron:
  weekly discover/movie staging refresh from the latest release_date already stored

TMDB Enrichment Cron:
  queue-based enrichment refresh for rows that are new or stale

Final Table Cron:
  rebuilds movie_list_items after the staging refreshes have had time to finish
```

Verification:

<div><span class="ooo">[</span>   <span class="ooo">]</span> After each scale step, check the IMDb rating count:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> After each scale step, check the TMDB staging count:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS tmdb_count FROM tmdb_movies_staging;"
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> After each scale step, check the final movie list count:</div>

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT COUNT(*) AS movie_list_count FROM movie_list_items;"
```

Cloudflare monitoring:

<div><span class="ooo">[</span>   <span class="ooo">]</span> Also watch the Cloudflare dashboard metrics:</div>

```text
Worker errors
CPU time
Wall time
D1 query count
D1 rows written
Queue backlog
Queue retries
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> If queue retries or Worker limit errors appear, reduce batch size before continuing.</div>

<a id="phase-16-hook-this-back-into-movieapp"></a>
## Step 16: Hook This Back Into MovieApp

This is the handoff back into the app.

Current POC screen:

```text
/Users/croncallo/repo/MovieApp/src/screens/MoviesToIMDBJoinTest.tsx
```

Current POC behavior:

```text
fetch TMDB search results
lookup TMDB external_ids
lookup IMDb rating
render joined result
time the request
```

Future behavior:

```text
fetch Cloudflare /movies/search
render results immediately
show IMDb rating badge on poster
sort by IMDb rating
filter by genre/provider
tap poster to load details using existing MovieApp detail flow
```

This means `MoviesToIMDBJoinTest` can become the bridge screen:

```text
old mode:
  prove live join timing

new mode:
  prove Cloudflare D1 response timing
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use `MoviesToIMDBJoinTest` as the bridge screen when the Cloudflare path is ready.</div>

<div><span class="ooo">[</span>   <span class="ooo">]</span> Do not change the old `MovieResults` / search architecture yet.</div>

<a id="phase-17-recommended-build-order"></a>
## Step 17: Recommended Build Order

Build order:

Use this order so each dependency exists before the next step begins.

Foundation:

<div><span class="ooo">[</span>   <span class="ooo">]</span> Create the migration file.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Paste the database SQL.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Apply the migration locally as a quick schema check.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Apply the migration to remote D1.</div>

IMDb path:

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add `/admin/import/imdb-ratings/dry-run`.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Prove Cloudflare can stream-decompress and parse IMDb rows.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Create and wire up the IMDb Queue in `wrangler.jsonc`.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Enqueue a small IMDb ratings batch from Cloudflare.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Prove the Queue consumer writes IMDb ratings to remote D1.</div>

TMDB path:

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the TMDB API key locally and in Cloudflare.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Build the Cloudflare TMDB movie-list load endpoint for manual kickoff.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Load a small TMDB sample into remote D1.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Run the one-time manual TMDB historical backfill in date windows.</div>

Final query path:

<div><span class="ooo">[</span>   <span class="ooo">]</span> Build `movie_list_items` from the remote staging tables.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the future `/movies/search` Worker endpoint.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Test `/movies/search` from the browser.</div>

MovieApp handoff:

<div><span class="ooo">[</span>   <span class="ooo">]</span> Update `MoviesToIMDBJoinTest` to call `/movies/search`.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Compare timing against the old live join.</div>

Recurring jobs:

<div><span class="ooo">[</span>   <span class="ooo">]</span> Enable the smaller weekly TMDB recurring refresh after the historical backfill is finished.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Scale the Cloudflare jobs slowly.</div>

<a id="phase-18-useful-commands"></a>
## Step 18: Useful Commands

Run local Worker:

```bash
npm run dev
```

Run remote-backed Worker locally:

```bash
npm run dev:remote
```

Run tests:

```bash
npm test
```

Query local current test table:

```bash
npm run db:query:local
```

Query remote current test table:

```bash
npm run db:query:remote
```

List local tables:

```bash
npx wrangler d1 execute movieapp-db --local --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
```

List remote tables:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
```

Get the current TMDB release-date cursor:

```bash
npx wrangler d1 execute movieapp-db --remote --command "SELECT MAX(release_date) AS max_release_date FROM tmdb_movies_staging;"
```

<a id="phase-19-data-usage-notes"></a>
## Step 19: Data Usage Notes

IMDb datasets are provided under IMDb's non-commercial dataset terms.

TMDB data also has API terms and attribution requirements.

Before making this public or commercial, verify that the planned use is allowed by both data providers.

Useful links:

```text
https://developer.imdb.com/non-commercial-datasets/
https://developer.themoviedb.org/reference/discover-movie
https://developer.themoviedb.org/reference/movie-details
https://developer.themoviedb.org/reference/movie-watch-providers
https://developer.themoviedb.org/reference/movie-release-dates
https://developer.themoviedb.org/docs/getting-started
https://developers.cloudflare.com/workers/runtime-apis/web-standards/
https://developers.cloudflare.com/workers/platform/limits/
https://developers.cloudflare.com/d1/platform/limits/
https://developers.cloudflare.com/workers/configuration/cron-triggers/
https://developers.cloudflare.com/queues/platform/limits/
```

<a id="phase-20-scheduled-refresh-cron-jobs"></a>
## Step 20: Scheduled Refresh Cron Jobs

This page is the recurring production refresh schedule.

Cloudflare Cron Triggers use UTC cron expressions.

The schedule below maps your requested Eastern-time schedule to UTC while the account is on Eastern Daylight Time:

```text
Sunday 6:00 PM Eastern  -> Sunday 22:00 UTC
Monday 12:00 AM Eastern -> Monday 04:00 UTC
Monday 6:00 AM Eastern  -> Monday 10:00 UTC
Monday 9:00 PM Eastern  -> Tuesday 01:00 UTC
```

Important daylight-saving note:

```text
Cloudflare stores cron schedules in UTC.

If you want the jobs to stay pinned to the exact same Eastern wall-clock time
after daylight saving time changes, review these expressions when Eastern time
switches between EDT and EST.
```

### Step 20-1: Current `wrangler.jsonc` Schedule

The current cron list is:

```jsonc
"triggers": {
  "crons": [
    // IMDb ratings refresh: Sunday 6:00 PM ET while on EDT; Sunday 22:00 UTC.
    "0 22 * * 1",
    // TMDB primary refresh: Monday 12:00 AM ET while on EDT; Monday 04:00 UTC.
    "0 4 * * 2",
    // TMDB enrichment refresh: Monday 6:00 AM ET while on EDT; Monday 10:00 UTC.
    "0 10 * * 2",
    // Final movie_list_items rebuild: Monday 9:00 PM ET while on EDT; Tuesday 01:00 UTC.
    "0 1 * * 3"
  ]
}
```

Meaning:

```text
0 22 * * 1
  IMDb ratings refresh
  Sunday 6:00 PM Eastern while on EDT

0 4 * * 2
  TMDB primary staging refresh
  Monday 12:00 AM Eastern while on EDT

0 10 * * 2
  TMDB enrichment refresh
  Monday 6:00 AM Eastern while on EDT

0 1 * * 3
  Final movie_list_items rebuild
  Monday 9:00 PM Eastern while on EDT
```

Cloudflare's cron day-of-week values here are:

```text
1 = Sunday
2 = Monday
3 = Tuesday
...
7 = Saturday
```

That is why the Monday jobs use `2`, and the Tuesday UTC final-table job uses `3`.

### Step 20-2: Why Enrichment And Final Build Use Fixed Times

Preferred ideal:

```text
TMDB primary completes
-> wait 30 minutes
-> TMDB enrichment starts

TMDB enrichment completes
-> wait 30 minutes
-> movie_list_items rebuild starts
```

Current implementation:

```text
Cloudflare Cron Triggers are time-based.
They do not directly express "run 30 minutes after another cron job completes".
```

So we use the fixed fallback times:

```text
TMDB enrichment:
  Monday 6:00 AM Eastern

Final movie_list_items rebuild:
  Monday 9:00 PM Eastern
```

That gives the upstream work a wide buffer:

```text
TMDB primary starts at midnight Eastern.
TMDB enrichment starts 6 hours later.
Final movie_list_items rebuild starts 15 hours after enrichment starts.
```

Later, if we want true completion-based chaining, use an orchestrator pattern:

```text
job progress table says prior job completed
-> enqueue next job
-> final build runs after enrichment progress is complete
```

Cloudflare Workflows could also be evaluated later if we want a first-class workflow engine.

### Step 20-3: What `scheduled(...)` Does

The Worker branches on `controller.cron`.

Current mapping:

```text
controller.cron === "0 22 * * 1"
  -> runScheduledImdbRatingsRefresh(env)
  -> reads IMDb title.ratings.tsv.gz
  -> enqueues IMDb rating rows into IMDB_RATING_QUEUE

controller.cron === "0 4 * * 2"
  -> runScheduledTmdbPrimaryRefresh(env)
  -> reads MAX(release_date) from tmdb_movies_staging
  -> loads TMDB discover/movie rows through today

controller.cron === "0 10 * * 2"
  -> enqueueTmdbEnrichmentJob(env, ...)
  -> selects rows where tmdb_enriched_at is null or stale
  -> enqueues TMDB enrichment messages into TMDB_ENRICHMENT_QUEUE

controller.cron === "0 1 * * 3"
  -> rebuildMovieListItems(env, "cron")
  -> clears movie_list_items
  -> inserts final rows that have:
       tmdb_enriched_at IS NOT NULL
       tmdb_enrichment_error IS NULL
     with IMDb rating/vote fields populated only when a matching IMDb rating row exists
```

### Step 20-4: Manual Testing

Do not assume the Cloudflare dashboard can manually fire a Cron Trigger.

Earlier notes assumed there was a dashboard "run now" control. At the time this
guide was updated, the documented test path for scheduled events is Wrangler's
`--test-scheduled` flow, not a dashboard button.

The local scheduled-event test path is:

```bash
npx wrangler dev --test-scheduled
```

Then call the special local scheduled URL with the cron expression:

```bash
curl "http://localhost:8787/__scheduled?cron=0+22+*+*+1"
```

Use this map:

```text
0 22 * * 1 -> IMDb ratings
0 4 * * 2  -> TMDB primary
0 10 * * 2 -> TMDB enrichment
0 1 * * 3  -> Final movie_list_items build
```

What this proves:

```text
Cloudflare-style ScheduledController event
-> Worker scheduled(...) handler
-> controller.cron string matching
-> correct scheduled job branch
```

If the goal is to confirm that the local code being tested is the same code
that was just deployed, use this sequence:

```bash
npm run deploy
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+22+*+*+1"
```

The reason this works is:

```text
npm run deploy
  -> Wrangler bundles the files currently on disk
  -> Cloudflare receives that Worker version

npx wrangler dev --test-scheduled
  -> Wrangler runs the same files currently on disk
  -> /__scheduled calls the local scheduled(...) handler
```

This does not depend on Git staging or commits. Wrangler deploys the files on
disk, even if the repo is dirty.

The rule for this test is:

```text
Do not edit files between deploy and the local scheduled test.
Do not switch branches.
Do not pull.
Do not run codegen.
Do not change .dev.vars or wrangler.jsonc.
```

Under those conditions, the local scheduled test gives strong proof that the
code path being tested is the same code path that was just deployed.

What this does not fully prove:

```text
Cloudflare's deployed scheduler will fire at the real weekend time.
Cloudflare's deployed runtime will behave exactly the same as local Wrangler dev.
```

That final part is only proven after the real deployed cron event appears in
Cloudflare Observability / Past Cron Events.

If immediate remote proof is ever required, add a temporary protected admin
endpoint that calls the same scheduled handler, test it, and remove or keep it
locked behind an admin token. Do not expose a public endpoint that can trigger
scheduled jobs.

Dashboard path:

```text
Workers & Pages
movieapp-cloudflare
Settings
Triggers
Cron Triggers
```

If the dashboard only shows the UTC expression, use the same map:

```text
0 22 * * 1 -> IMDb ratings
0 4 * * 2  -> TMDB primary
0 10 * * 2 -> TMDB enrichment
0 1 * * 3  -> Final movie_list_items build
```

Manual HTTP fallbacks also exist for testing:

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/enqueue-manual"
```

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/tmdb/load-manual?limit=100000&beginDate=YYYY-MM-DD&endDate=YYYY-MM-DD"
```

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/tmdb/enrich-manual?limit=300000&refreshOlderThanDays=7"
```

```bash
curl "https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/movie-list/rebuild-manual"
```

### Step 20-5: Monitoring Order

Use this order after the weekly refresh begins:

```text
1. Check IMDb queue / IMDb staging counts.
2. Check TMDB primary staging counts.
3. Check TMDB enrichment progress.
4. Check final movie_list_items counts.
```

Useful VS Code tasks:

```text
remote-imdb-counts
remote-tmdb-counts
remote-tmdb-progress
remote-tmdb-errors
remote-staging-to-movie-list-ready
remote-movie-list-counts
remote-movie-list-top-50
```

Cloudflare Observability path:

```text
Workers & Pages
movieapp-cloudflare
Observability
Events
Live
Last 1 hour
```

Expected scheduled-job event names:

```text
imdb-ratings-cron-start
imdb-ratings-cron-end
tmdb-primary-cron-start
tmdb-primary-cron-end
tmdb-enrich-enqueue-start
tmdb-enrich-enqueue-end
tmdb-enrich-queue-message-start
tmdb-enrich-queue-message-end
movie-list-build-start
movie-list-build-end
```

## Step 21: Caching

This page explains how `/movies/search` caching works.

The most important idea:

```text
One exact request URL becomes one saved cache entry.
```

In plain English, a cache entry is one saved answer.

Nobody manually types an entry into Cloudflare. The Worker creates the entry
automatically after the first request for an exact URL.

The code lives here:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/src/httpRouting/movieSearch.ts
```

### Step 21-1: Where The Cache Time Is Configured

The cache timing is configured in Worker code, not in `wrangler.jsonc`.

`wrangler.jsonc` configures deployment things:

```text
D1 bindings
queues
cron schedules
Worker limits
```

The movie-search route configures its own cache behavior in:

```text
src/httpRouting/movieSearch.ts
```

Current constants:

```ts
const MOVIE_SEARCH_CACHE_SECONDS = 60 * 60 * 24 * 7;
const MOVIE_SEARCH_STALE_SECONDS = 60 * 60 * 24;
```

Read that as:

```text
60 seconds
* 60 minutes
* 24 hours
* 7 days
= 604800 seconds
```

So the Cloudflare CDN cache target is 7 days.

The stale window is:

```text
60 * 60 * 24 = 86400 seconds = 1 day
```

That lets Cloudflare serve an older cached response briefly while refreshing it.

### Step 21-2: Which Headers Tell Cloudflare To Cache

The Worker creates cache headers in `movieSearchCacheHeaders(...)`:

```ts
function movieSearchCacheHeaders(cacheStatus: "HIT" | "MISS") {
	return {
		"Cache-Control": `public, max-age=60, s-maxage=${MOVIE_SEARCH_CACHE_SECONDS}, stale-while-revalidate=${MOVIE_SEARCH_STALE_SECONDS}`,
		"CDN-Cache-Control": `public, max-age=${MOVIE_SEARCH_CACHE_SECONDS}`,
		"Cloudflare-CDN-Cache-Control": `public, max-age=${MOVIE_SEARCH_CACHE_SECONDS}`,
		"X-MovieApp-Cache": cacheStatus,
	};
}
```

Read those as:

```text
Cache-Control max-age=60
  Browser may keep it briefly.

s-maxage=604800
  Shared caches like Cloudflare may keep it for 7 days.

stale-while-revalidate=86400
  Cloudflare may serve stale data for up to 1 day while refreshing.

CDN-Cache-Control / Cloudflare-CDN-Cache-Control
  Direct CDN-specific cache instructions.

X-MovieApp-Cache
  Our own debug header. It says HIT or MISS.
```

`X-MovieApp-Cache` is not a Cloudflare feature. It is a label we add so we can
read responses more easily.

### Step 21-3: How A Cache Entry Gets Entered

This is the exact flow.

First, the Worker turns the incoming URL into a cache key:

```ts
const cacheKey = new Request(url.toString(), request);
const cache = caches.default;
const cachedResponse = await cache.match(cacheKey).catch(() => undefined);
```

Read that as:

```text
Use this exact URL as the lookup key.
Ask Cloudflare cache:
  "Do you already have a saved answer for this exact URL?"
```

If Cloudflare already has a saved answer, that is a cache hit:

```ts
if (cachedResponse) {
	const headers = new Headers(cachedResponse.headers);
	headers.set("X-MovieApp-Cache", "HIT");

	return new Response(cachedResponse.body, {
		status: cachedResponse.status,
		statusText: cachedResponse.statusText,
		headers,
	});
}
```

Read that as:

```text
If saved answer exists:
  return it immediately
  mark it as HIT
  do not run the D1 query again
```

If Cloudflare does not have a saved answer, that is a cache miss.

The Worker then runs the real database search:

```ts
const result = await searchMovieListItems(env, url);
```

Then the Worker builds a JSON response:

```ts
const response = Response.json(result, {
	headers: movieSearchCacheHeaders("MISS"),
});
```

Then this line enters the response into Cloudflare's cache:

```ts
const cachePut = cache.put(cacheKey, response.clone()).catch(() => undefined);
```

That is the key line.

Read it as:

```text
Cloudflare, save this response under this exact URL.
```

The response is cloned because the Worker needs two copies:

```text
one copy to return to the app now
one copy to store in Cloudflare cache
```

The Worker then lets the cache save finish in the background when possible:

```ts
if (ctx) {
	ctx.waitUntil(cachePut);
} else {
	await cachePut;
}
```

Read that as:

```text
If this is a normal Worker request:
  return the response to the app without waiting for cache save to block the user.

If there is no ctx:
  wait for the cache save.
```

### Step 21-4: Why Exact URLs Matter

Cloudflare's cache key is:

```ts
url.toString()
```

That means the exact URL text matters.

This URL:

```text
/movies/search?pageSize=20&datePreset=last5years&genreIds=27&watchMonetizationTypes=flatrate&minImdbVotes=25000&sort=imdb
```

is not the same cache entry as this URL:

```text
/movies/search?pageSize=20&datePreset=last5years&genreIds=27&providerIds=8,9&minImdbVotes=25000&sort=imdb
```

They are different because they ask different questions.

This means:

```text
watchMonetizationTypes=flatrate
```

Plain English:

```text
Any US streaming provider we have data for.
```

In the MovieApp UI, this is the path used when all streamers are selected and
the app sends the broad "flatrate" search.

This means:

```text
providerIds=8,9
```

Plain English:

```text
Only provider 8 and provider 9.
```

Those are not the same search, so Cloudflare saves them separately:

```text
Cache entry A:
  horror + last 5 years + all streamers/flatrate + 25,000+ IMDb votes

Cache entry B:
  horror + last 5 years + provider 8/provider 9 only + 25,000+ IMDb votes
```

Warming entry A does not warm entry B.

Warming entry B does not warm entry A.

### Step 21-5: HIT Versus MISS

When a request is a `MISS`, the flow is:

```text
App asks URL
-> Cloudflare does not have saved response
-> Worker runs D1 SQL query
-> Worker returns JSON
-> Worker enters JSON into cache with cache.put(...)
```

When the next request for the same exact URL is a `HIT`, the flow is:

```text
App asks same exact URL
-> Cloudflare has saved response
-> Worker returns saved response
-> D1 SQL query does not run
```

That is why the first request can take longer and the next matching request can
be much faster.

### Step 21-6: Query Parameter Order Can Matter

Because the cache key uses the exact URL string, these may become different
cache entries even if they mean the same thing to a person:

```text
/movies/search?pageSize=20&datePreset=last5years&genreIds=27&minImdbVotes=25000&sort=imdb
```

```text
/movies/search?genreIds=27&minImdbVotes=25000&pageSize=20&datePreset=last5years&sort=imdb
```

Same values, different URL order.

The app should keep building common shortcut URLs in a stable order so cache
warming is useful.

The current app service builds the URL in this order:

```text
pageSize
datePreset or beginDate/endDate
certifications
genreIds
watchMonetizationTypes or providerIds
minImdbVotes
sort
cursor
```

That code lives here:

```text
/Users/croncallo/repo/MovieApp/src/api/tmdb/services/movieService.ts
```

### Step 21-7: How To Test Cache Behavior

Use `curl` with response headers:

```bash
curl -s -D - -o /dev/null -w 'time_total=%{time_total}\n' 'https://movieapp-cloudflare.carlo-roncallo.workers.dev/movies/search?pageSize=20&datePreset=last5years&genreIds=27&watchMonetizationTypes=flatrate&minImdbVotes=25000&sort=imdb'
```

Look for:

```text
cf-cache-status: HIT
x-movieapp-cache: HIT
```

or:

```text
x-movieapp-cache: MISS
```

The first request for a new exact URL may be `MISS`.

The second request for the same exact URL should usually become `HIT`.

If the same exact URL repeatedly stays `MISS`, investigate:

```text
different query parameter order
different providerIds/order
datePreset versus beginDate/endDate
response error status
headers that prevent caching
Cloudflare cache behavior by edge location
```

### Step 21-8: Why Add Package Shortcuts

Package shortcuts are just saved commands that request important URLs on purpose.

They are useful because they warm common searches before a user waits on them.

For example, a shortcut can warm:

```text
horror + last 5 years + all streamers/flatrate + 25,000+ IMDb votes + IMDb sort
```

That exact shortcut should use the same URL shape the app uses:

```text
/movies/search?pageSize=20&datePreset=last5years&genreIds=27&watchMonetizationTypes=flatrate&minImdbVotes=25000&sort=imdb
```

If the shortcut uses `providerIds=...` but the app uses
`watchMonetizationTypes=flatrate`, then the shortcut warms the wrong cache entry
for the Add All streamers case.

## Step 22: MyD1 SQL Client

MyD1 is a desktop SQL client that can connect to Cloudflare D1.

Use it as a visual query tool for checking tables, running `SELECT` statements,
reviewing query history, and saving useful queries as bookmarks.

### Step 22-1: Install MyD1

Download MyD1 from:

```text
https://myd1.app/
```

On macOS, the downloaded file may be a `.dmg`.

The `.dmg` is the installer container. It is not the app itself.

Install it like this:

```text
1. Double-click the .dmg file.
2. In the Finder window that opens, find MyD1.app.
3. Drag MyD1.app into Applications.
4. Open MyD1 from Applications.
5. Eject the mounted MyD1 disk image.
6. Delete the downloaded .dmg when the app works.
```

If macOS blocks the app:

```text
System Settings
-> Privacy & Security
-> Open Anyway
```

### Step 22-2: Connect MyD1 To Cloudflare D1

Choose the `Cloudflare D1` connection type.

Use:

```text
Account ID: your Cloudflare account ID
API Token: your Cloudflare API token
Database ID: leave blank first
```

Leaving `Database ID` blank lets MyD1 list the databases in the account.

After the database list loads, choose:

```text
movieapp-db
```

Safe starter query:

```sql
SELECT COUNT(*) AS movie_count
FROM movie_list_items;
```

Sample row query:

```sql
SELECT *
FROM movie_list_items
LIMIT 25;
```

### Step 22-3: About The `Not Secure` Badge

MyD1 may show a `Not secure` badge for the Cloudflare D1 connection.

For this D1 connection, that badge appears to be a generic MyD1 UI warning.

Why:

```text
Cloudflare D1 access goes through the Cloudflare HTTPS API.
The MyD1 logs show HTTPS requests to api.cloudflare.com.
The saved connection also uses port 443.
```

So do not treat the badge as proof that the D1 API traffic is plain text.

Still, keep the Cloudflare API token limited to the smallest permission that works.

For read-only investigation, prefer a restricted token first.

Only use broader D1 edit permission when the tool requires it for the operation.

### Step 22-4: Query History

Important MyD1 behavior:

```text
Manual SQL typed directly into the SQL editor may run successfully but not show up in History.
History is created reliably when the query starts from MyD1's built-in table flow.
```

In plain English:

```text
If you type a brand-new query yourself and click Execute, it may not be saved to History.
If you double-click a table and let MyD1 create the table query, that query is saved to History.
After that, you can load that history row, edit it, run it again, and bookmark it.
```

Use this workflow when you want a query to become bookmarkable:

```text
1. Select movieapp-db.
2. Double-click a table, such as movie_list_items.
3. Let MyD1 create or run its built-in table query.
4. Open History from the left Quick Actions area.
5. Click that history row to expand it.
6. Click Load if you want to edit the SQL.
7. Run the edited SQL.
8. Use the expanded History row's Bookmark button when you want to save it.
```

If history looks empty:

```text
1. Do not test history with a manually typed SQL query first.
2. Reconnect to movieapp-db.
3. Double-click a table so MyD1 creates a built-in table query.
4. Run that built-in query.
5. Open the History view from the left Quick Actions area.
6. If needed, close and reopen MyD1.
```

Useful history behavior:

```text
Click a history row to expand it.
The expanded row shows action buttons.
```

The action buttons can include:

```text
Load
Execute
Explain
Bookmark
Copy
Delete
```

`Load` puts the query back in the SQL editor.

`Execute` runs it again.

`Copy` copies the SQL text.

### Step 22-5: Bookmarks

The important MyD1 bookmark detail:

```text
Do not look for the bookmark button only in the side Bookmarks panel.
First click a row in Query History.
That expands the row.
Then click the Bookmark button shown inside that expanded history row.
```

Bookmark flow:

```text
1. Start with a query that exists in History.
   The reliable way is to double-click a table and run MyD1's built-in table query first.
2. Open History.
3. Click the history row for that query.
4. Click Bookmark in the expanded row.
5. Choose or create a bookmark folder.
6. Save the bookmark.
7. Open the Bookmarks tab in the side panel to confirm it is there.
```

Example bookmark folder name:

```text
MyD1Bookmarks
```

### Step 22-6: Do Not Manually Edit Bookmarks In The Plist

MyD1 stores preferences under:

```text
~/Library/Preferences/com.myd1.app.plist
```

The app settings may also mention an older path:

```text
~/Library/Preferences/com.rageagainstthedb.app.plist
```

Do not rely on manually editing either plist for bookmarks.

Manual plist bookmark edits are fragile because MyD1 can rewrite or ignore the
bookmark keys when it starts.

Use the app's History row `Bookmark` button instead.

### Step 22-7: Keep Important SQL In Repo Files Too

Even if MyD1 bookmarks work, keep important SQL scripts in repo files so they
are searchable, reviewable, and not tied to one desktop app.

Recommended folder:

```text
/Users/croncallo/repo/MovieApp-Cloudflare/sql/
```

Good file names:

```text
movie-list-count.sql
movie-list-sample.sql
top-imdb-movies.sql
horror-last-5-years-25k-votes.sql
```
