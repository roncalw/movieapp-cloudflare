# MovieApp On Cloudflare

## Table Of Contents

- [Summary](#summary)
- [Current Repos](#current-repos)
- [Important Data Sources](#important-data-sources)
- [Target Database Design](#target-database-design)
- [Search Page Field Audit](#search-page-field-audit)
- [Implementation Steps](#implementation-steps)
  - Migration Strategy
    - [ ] [Step 0: Migration Strategy](#step-0-migration-strategy)
  - Database Setup
    - [ ] [Step 1: Create The Migration File](#step-1-create-the-migration-file)
    - [ ] [Step 2: Paste The Database SQL](#step-2-paste-the-database-sql)
    - [ ] [Step 3: Apply The Migration](#step-3-apply-the-migration)
  - IMDb Stream Proof
    - [ ] [Step 4: Prove Cloudflare Can Stream Read The IMDb File](#step-4-prove-cloudflare-can-stream-read-the-imdb-file)
  - IMDb Setup And Load Into Staging
    - [ ] [Step 5: Plan The IMDb Queue Job](#step-5-plan-the-imdb-queue-job)
    - [ ] [Step 6: Wire Up The IMDb Queue](#step-6-wire-up-the-imdb-queue)
    - [ ] [Step 7: Load The IMDb Ratings Staging Table](#step-7-load-the-imdb-ratings-staging-table)
  - TMDB Setup And Load Into Staging
    - [ ] [Step 8: Add The TMDB API Token As A Secret](#step-8-add-the-tmdb-api-token-as-a-secret)
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
database_name: movieapp-test-db
binding: DB
```

Current Cloudflare repo scripts already include:

```json
"db:migration:create": "wrangler d1 migrations create movieapp-test-db",
"db:migrate:local": "wrangler d1 migrations apply movieapp-test-db --local",
"db:seed:local": "wrangler d1 execute movieapp-test-db --local --file seed/seed-test-movies.sql",
"db:query:local": "wrangler d1 execute movieapp-test-db --local --command \"SELECT * FROM movies ORDER BY id LIMIT 5;\"",
"db:migrate:remote": "wrangler d1 migrations apply movieapp-test-db --remote",
"db:seed:remote": "wrangler d1 execute movieapp-test-db --remote --file seed/seed-test-movies.sql",
"db:query:remote": "wrangler d1 execute movieapp-test-db --remote --command \"SELECT * FROM movies ORDER BY id LIMIT 5;\""
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

`video` is also a TMDB source flag. We should use it only during import to reject records that are not useful for the MovieApp movie list. We should not store it.

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
tmdb_movies_staging + imdb_ratings_staging -> movie_list_items
```

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

The diagram below shows the full source-to-staging-to-final-table flow:

![Migration strategy flow](/Users/croncallo/repo/MovieApp-Cloudflare/.codex/assets/movieapp-migration-strategy-flow.svg)

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
-- Keep all accepted TMDB movies in this table, even when IMDb data is
-- missing for some rows.
--
-- That means:
--   imdb_rating
--   imdb_vote_count
--
-- are nullable here.
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Confirm that the local tables exist.</div>

```bash
npx wrangler d1 execute movieapp-test-db --local --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
```

Expected table names should include:

```text
imdb_ratings_staging
movie_genres
movie_list_items
movie_watch_providers
tmdb_movies_staging
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Apply the same migration to remote D1 before testing Cloudflare-side imports.</div>

```bash
npm run db:migrate:remote
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Confirm that the remote tables exist.</div>

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> In `src/index.ts`, paste this helper code below your type definitions and above the `export default { ... }` Worker object.</div>

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
  average_rating: number;
  num_votes: number;
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
        average_rating: Number(averageRating),
        num_votes: Number(numVotes),
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the temporary dry-run route after that `url` line and before the normal `/movies` route logic.</div>

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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Run the local Worker dev server.</div>

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

<div><span class="ooo">[</span>   <span class="ooo">]</span> After the local dev-server test works, deploy the Worker.</div>

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

<div><span class="ooo">[</span>   <span class="ooo">]</span> If `limit=10000` works, try:</div>

```text
https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/dry-run?limit=100000
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Then try:</div>

```text
https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/imdb-ratings/dry-run?limit=500000
```

This still does not write to D1.

It only proves whether Cloudflare can keep streaming and parsing larger parts of the file.

<a id="phase-4g-pass-or-fail-decision"></a>
### Step 4G: Pass Or Fail Decision

<div><span class="ooo">[</span>   <span class="ooo">]</span> Decide whether this step passed before continuing.</div>

Pass condition:

```text
Cloudflare returns sample IMDb rows without a memory error or CPU error.
```

Fail condition:

```text
Cloudflare cannot stream/decompress/parse even a limited row count reliably.
```

If this fails, do not continue to D1 import work until the Cloudflare-side file processing problem is solved.

<a id="phase-5-plan-the-imdb-queue-job"></a>
## Step 5: Plan The IMDb Queue Job

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
Cron Trigger or manual test route
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
    In this plan, fetch(...) is the manual test entry point.

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

    during testing:
      fetch(...) calls enqueueImdbRatingRows(...)

    during the recurring job:
      scheduled(...) calls enqueueImdbRatingRows(...)

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

Important Cloudflare limits:

```text
Worker memory:
  128 MB

Cron Trigger wall time:
  15 minutes

Queue consumer wall time:
  15 minutes

D1 queries per Worker invocation:
  Free: 50
  Paid: 1000

D1 bound parameters per query:
  100

Cloudflare Queue message size:
  128 KB
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

Plan decision:

```text
Workers Free is probably too small for the full recurring IMDb job because:
  1. Workers Free has much smaller CPU limits
  2. D1 Free has 100,000 rows written per day
  3. the IMDb ratings file has about 1.6M rows
```

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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Create the Cloudflare Queue resource.</div>

Run it from the Cloudflare repo terminal:

```text
/Users/croncallo/repo/MovieApp-Cloudflare
```

Run:

```bash
npx wrangler queues create movieapp-imdb-rating-import
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> After the Queue exists in Cloudflare, connect it to this Worker by editing:</div>

```text
/Users/croncallo/repo/MovieApp-Cloudflare/wrangler.jsonc
```

<a id="phase-6a-what-the-imdb-queue-binding-does"></a>
### Step 6A: What The IMDb Queue Binding Does

Creating the Queue in Cloudflare is not enough by itself.

The Worker code also needs a way to access that Queue.

That connection is called a Queue binding.

In plain English:

```text
Queue resource:
  the real Cloudflare Queue named movieapp-imdb-rating-import

Queue binding:
  the name your Worker code uses to talk to that Queue
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Find the existing `d1_databases` section.</div>

Right now it looks like this:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "movieapp-test-db",
    "database_id": "b888696a-acaf-4925-8c52-243146559175"
  }
]
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add a comma after the closing `]`, then add the `queues` section after it.</div>

The important punctuation is:

```text
],
"queues": {
  ...
}
```

The result should look like this:

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
      "database_name": "movieapp-test-db",
      "database_id": "b888696a-acaf-4925-8c52-243146559175"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "IMDB_RATING_QUEUE",
        "queue": "movieapp-imdb-rating-import"
      }
    ],
    "consumers": [
      {
        "queue": "movieapp-imdb-rating-import",
        "max_batch_size": 100,
        "max_batch_timeout": 10,
        "max_retries": 5
      }
    ]
  }
}
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Do not remove the existing `d1_databases` section.</div>

You are adding `queues` as another top-level config section next to `d1_databases`.

<a id="phase-6c-what-each-imdb-queue-config-part-means"></a>
### Step 6C: What Each IMDb Queue Config Part Means

```jsonc
"producers": [
  {
    "binding": "IMDB_RATING_QUEUE",
    "queue": "movieapp-imdb-rating-import"
  }
]
```

Means:

```text
Inside Worker code, env.IMDB_RATING_QUEUE points to the Cloudflare Queue named movieapp-imdb-rating-import.
```

```jsonc
"consumers": [
  {
    "queue": "movieapp-imdb-rating-import",
    "max_batch_size": 100,
    "max_batch_timeout": 10,
    "max_retries": 5
  }
]
```

Means:

```text
When movieapp-imdb-rating-import has messages, Cloudflare should send them to this Worker.
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> If testing on the free plan, use a smaller consumer batch size first.</div>

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add a Cron Trigger later, after the dry-run and queue consumer both work:</div>

```jsonc
{
  "triggers": {
    "crons": [
      "0 9 */3 * *"
    ]
  }
}
```

That example means:

```text
run at 09:00 UTC every 3 days
```

The exact schedule can change.

Do not enable the full Cron Trigger until the dry-run endpoint and small queue import test both pass.

<a id="phase-7-write-imdb-rating-batches-into-d1"></a>
<a id="step-7-write-imdb-rating-batches-into-d1"></a>
## Step 7: Load The IMDb Ratings Staging Table

This is still the IMDb side of the pipeline.

Do not switch to TMDB yet.

After the dry-run endpoint works and the Queue wiring is in place, add the real queue producer and queue consumer.

The producer reads the IMDb file and sends small row batches to the Queue.

The consumer receives those row batches and writes them to D1.

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add these types:</div>

```ts
type ImdbRatingQueueMessage = {
  rows: ImdbRatingRow[];
};

export interface Env extends Cloudflare.Env {
  DB: D1Database;
  IMDB_RATING_QUEUE: Queue<ImdbRatingQueueMessage>;
}
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the producer helper:</div>

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
        average_rating: Number(averageRating),
        num_votes: Number(numVotes),
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the temporary endpoint to enqueue a small test:</div>

```ts
if (url.pathname === "/admin/import/imdb-ratings/enqueue-test") {
  const limit = Number(url.searchParams.get("limit") ?? 330);
  const result = await enqueueImdbRatingRows(env, limit);
  return Response.json(result);
}
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the queue consumer:</div>

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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Start with these test sizes:</div>

```text
330 rows
3,300 rows
33,000 rows
then decide whether to run the full job
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Call this test endpoint:</div>

```text
/admin/import/imdb-ratings/enqueue-test?limit=330
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Confirm that remote D1 received rows:</div>

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

At this point, the IMDb side has a real Cloudflare path into D1.

Only after that do we switch over to the TMDB side.

<a id="phase-8-add-the-tmdb-api-token-as-a-secret"></a>
## Step 8: Add The TMDB API Token As A Secret

This is the handoff from IMDb work to TMDB work.

TMDB starts here.

Do not hard-code the TMDB token in source code.

<div><span class="ooo">[</span>   <span class="ooo">]</span> For local development, create:</div>

```text
/Users/croncallo/repo/MovieApp-Cloudflare/.dev.vars
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add:</div>

```text
TMDB_API_TOKEN=your_tmdb_read_access_token_here
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> For the deployed Worker, add it as a Cloudflare secret later:</div>

```bash
npx wrangler secret put TMDB_API_TOKEN
```

Wrangler will ask you to paste the value.

<div><span class="ooo">[</span>   <span class="ooo">]</span> Also add the secret to the Worker `Env` type when the TMDB job is implemented:</div>

```ts
export interface Env extends Cloudflare.Env {
  DB: D1Database;
  IMDB_RATING_QUEUE: Queue<ImdbRatingQueueMessage>;
  TMDB_API_TOKEN: string;
}
```

You need this in place before the TMDB load step in Step 9.

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
    reject adult/video rows before D1
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
    reject adult/video rows before D1
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
2. rejecting adult/video rows
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Start with an admin test endpoint:</div>

```text
/admin/import/tmdb/load-test?limit=100&beginDate=2000-01-01&endDate=2000-12-31
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> The first Cloudflare primary-load version should do all of this:</div>

```text
1. call TMDB discover/movie
2. page through results
3. start from configurable beginDate, default 2000-01-01
4. end at a matching window endDate
5. skip adult/video rows
6. insert tmdb_movies_staging base rows
7. insert movie_genres rows from genre_ids
8. collect the accepted tmdb_id values for Step 9B
```

If one date window still returns too many discover/movie pages, shrink the window and retry.

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add a Worker-side TMDB discover helper like this:</div>

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

  if (endDate) {
    url.searchParams.set("primary_release_date.lte", endDate);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.TMDB_API_TOKEN}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`TMDB discover page ${page} failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add a helper that reads the current TMDB release-date cursor from D1:</div>

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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use the same import-time gatekeeper rule during the primary load:</div>

```ts
if (discoverResult.adult || discoverResult.video) {
  continue;
}
```

That means adult/video records are rejected before D1.

They are not stored as columns.

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the primary TMDB-side D1 writes like this:</div>

```ts
async function insertTmdbPrimaryRows(discoverResult: any, env: Env) {
  const tmdbId = discoverResult.id;
  const genreIds = Array.isArray(discoverResult.genre_ids)
    ? discoverResult.genre_ids
    : [];

  await env.DB.prepare(
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
  )
    .bind(
      tmdbId,
      discoverResult.title,
      discoverResult.poster_path,
      discoverResult.release_date,
      discoverResult.popularity ?? 0
    )
    .run();

  await env.DB.prepare(`DELETE FROM movie_genres WHERE tmdb_id = ?`)
    .bind(tmdbId)
    .run();

  for (const genreId of genreIds) {
    await env.DB.prepare(
      `INSERT INTO movie_genres (tmdb_id, genre_id)
       VALUES (?, ?)`
    )
      .bind(tmdbId, genreId)
      .run();
  }
}
```

### Step 9B: TMDB Enrichment Pass

This pass happens after Step 9A.

This is the point where the TMDB movie ids accepted by the primary load are enriched with the fields discover/movie does not return.

This pass is responsible for:

```text
1. loading imdb_id
2. loading us_certification
3. loading watch providers
4. updating tmdb_movies_staging
5. writing movie_watch_providers
```

The TMDB movie-details API response gives us:

```text
details.external_ids.imdb_id
details.release_dates
details["watch/providers"]
```

So this pass should:

```text
1. read imdb_id from the enrichment response and update tmdb_movies_staging
2. read certification from the enrichment response and update tmdb_movies_staging
3. read watch providers from the enrichment response and write movie_watch_providers
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add a Worker-side TMDB enrichment helper like this:</div>

```ts
async function getTmdbMovieDetails(tmdbId: number, env: Env) {
  const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
  url.searchParams.set("append_to_response", "external_ids,watch/providers,release_dates");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.TMDB_API_TOKEN}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`TMDB ${tmdbId} failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
```

One TMDB movie still ends up as:

```text
1 base row in tmdb_movies_staging from Step 9A
plus 0-to-many rows in movie_genres from Step 9A
plus 0-to-many rows in movie_watch_providers from Step 9B
```

That is why `tmdb_id` repeats in the child tables.

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the TMDB enrichment writes like this:</div>

```ts
async function enrichTmdbMovieSideTables(tmdbId: number, details: any, env: Env) {
  const imdbId = details.external_ids?.imdb_id ?? null;
  const usFlatrateProviders =
    details["watch/providers"]?.results?.US?.flatrate ?? [];

  const usReleaseDates = details.release_dates?.results ?? [];
  const usReleaseBlock = usReleaseDates.find(
    (entry: any) => entry.iso_3166_1 === "US"
  );
  const usCertification =
    usReleaseBlock?.release_dates?.find(
      (entry: any) => typeof entry.certification === "string" && entry.certification.length > 0
    )?.certification ?? null;

  await env.DB.prepare(
    `UPDATE tmdb_movies_staging
     SET imdb_id = ?,
         us_certification = ?,
         imported_at = CURRENT_TIMESTAMP
     WHERE tmdb_id = ?`
  )
    .bind(
      imdbId,
      usCertification,
      tmdbId
    )
    .run();

  await env.DB.prepare(
      `DELETE FROM movie_watch_providers
     WHERE tmdb_id = ?
       AND region = ?`
  )
    .bind(tmdbId, "US")
    .run();

  for (const provider of usFlatrateProviders) {
    await env.DB.prepare(
      `INSERT INTO movie_watch_providers (tmdb_id, provider_id, region)
       VALUES (?, ?, ?)`
    )
      .bind(tmdbId, provider.provider_id, "US")
      .run();
  }
}
```

Why the provider-child-table logic starts with `DELETE`:

```text
Watch providers can change over time.
If we only INSERT new rows, old rows could be left behind.
Deleting the old provider rows for that tmdb_id first keeps the child table exact.
```

So the practical Step 9 load pattern for one TMDB movie is:

```text
Step 9A:
  1. INSERT OR REPLACE the base tmdb_movies_staging row
  2. DELETE old movie_genres rows for that tmdb_id
  3. INSERT the current genre_ids from discover/movie

Step 9B:
  4. UPDATE that same tmdb_movies_staging row with imdb_id and certification
  5. DELETE old movie_watch_providers rows for that tmdb_id and region
  6. INSERT the current provider rows from the enrichment response
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

Use a `LEFT JOIN` here on purpose.

That keeps the TMDB movie row even when `imdb_ratings_staging` does not have a
matching IMDb row yet.

When there is no IMDb match yet:

```text
imdb_rating      -> NULL
imdb_vote_count  -> NULL
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> For a small proof, run this manually against remote D1:</div>

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "
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
;
"
```

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
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT COUNT(*) AS movie_list_count FROM movie_list_items;"
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Preview the best IMDb-rated rows:</div>

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT tmdb_id, title, imdb_rating, imdb_vote_count, release_date, us_certification FROM movie_list_items ORDER BY imdb_rating DESC, imdb_vote_count DESC LIMIT 20;"
```

<a id="phase-11-test-genre-filtering"></a>
## Step 11: Test Genre Filtering

<div><span class="ooo">[</span>   <span class="ooo">]</span> Use the same TMDB genre ids that MovieApp already uses in:</div>

```text
/Users/croncallo/repo/MovieApp/src/components/ui/movieSearchFieldUtils.ts
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> Run this example query for one genre:</div>

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "
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
npx wrangler d1 execute movieapp-test-db --remote --command "
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

If a TMDB movie does not have an IMDb match yet, the response can still return
that movie with:

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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Schedule only the smaller weekly TMDB refresh after the historical TMDB backfill is finished.</div>

Recurring job scope:

```text
IMDb recurring job:
  still re-read the full IMDb file for now

TMDB recurring job:
  weekly incremental refresh from the latest release_date already stored
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> When you are ready to schedule both recurring jobs, add separate Cron expressions in `wrangler.jsonc`.</div>

Example:

```jsonc
{
  "triggers": {
    "crons": [
      "0 9 */3 * *",
      "0 10 * * 1"
    ]
  }
}
```

Meaning:

```text
0 9 */3 * *   -> IMDb full-file refresh every 3 days at 09:00 UTC
0 10 * * 1    -> TMDB weekly incremental refresh every Monday at 10:00 UTC
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> In `src/index.ts`, branch inside `scheduled(...)` based on which Cron expression fired.</div>

Example shape:

```ts
export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "0 9 */3 * *") {
      await enqueueImdbRatingRows(env);
      return;
    }

    if (controller.cron === "0 10 * * 1") {
      const beginDate = await getTmdbRefreshStartDate(env);
      await runTmdbIncrementalRefresh(env, beginDate);
      return;
    }
  },
};
```

TMDB recurring helper shape:

```text
1. reads MAX(release_date) from tmdb_movies_staging
2. calls getTmdbDiscoverPage(...)
3. calls insertTmdbPrimaryRows(...)
4. calls getTmdbMovieDetails(...) for accepted tmdb_id values
5. calls enrichTmdbMovieSideTables(...)
```

Recurring-job split:

```text
IMDb Cron:
  whole-file refresh path

TMDB Cron:
  weekly incremental refresh path
```

Verification:

<div><span class="ooo">[</span>   <span class="ooo">]</span> After each scale step, check the IMDb rating count:</div>

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT COUNT(*) AS rating_count FROM imdb_ratings_staging;"
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> After each scale step, check the TMDB staging count:</div>

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT COUNT(*) AS tmdb_count FROM tmdb_movies_staging;"
```

<div><span class="ooo">[</span>   <span class="ooo">]</span> After each scale step, check the final movie list count:</div>

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT COUNT(*) AS movie_list_count FROM movie_list_items;"
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

<div><span class="ooo">[</span>   <span class="ooo">]</span> Add the TMDB API token locally and in Cloudflare.</div>
<div><span class="ooo">[</span>   <span class="ooo">]</span> Build the Cloudflare TMDB movie-list load test endpoint.</div>
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
npx wrangler d1 execute movieapp-test-db --local --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
```

List remote tables:

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
```

Get the current TMDB release-date cursor:

```bash
npx wrangler d1 execute movieapp-test-db --remote --command "SELECT MAX(release_date) AS max_release_date FROM tmdb_movies_staging;"
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
