# Weekly TMDb Popularity and IMDb Freshness Plan

## Introduction

The MovieApp homepage and Advanced Search currently disagree about which
movies are popular because they read popularity from different places:

- The homepage asks TMDb for current popular movies.
- Advanced Search reads the `popularity` value previously copied into
  Cloudflare D1's `movie_list_items` table.

The D1 value is not being refreshed for the existing catalog. The current
TMDb primary job searches forward for new releases and therefore stops
revisiting an older movie after the import window passes its release date.
This is why a movie such as *The Death of Robin Hood* can appear near the top
of TMDb's live Popular list but much farther down in Advanced Search.

The same investigation found a second freshness problem. The weekly IMDb job
successfully downloads and stores current ratings and vote counts, but the
movie-list build does not recognize an IMDb-only change as a reason to update
`movie_list_items`. As a result, hundreds of thousands of Advanced Search
rows currently contain older IMDb values.

This plan corrects both problems without rebuilding or replacing the existing
movie catalog. The major parts are:

1. Add one weekly `tmdb-popularity-refresh` bulk-file job.
2. Add one run-separated TMDb popularity staging table.
3. Keep `movie_list_items.popularity` as the live, indexed search value.
4. Make every Movie List run bring copied IMDb rating and vote values up to date.
5. Permanently make IMDb-only and popularity-only changes eligible for the
   weekly movie-list update.
6. Preserve all current covering indexes for searches with and without an
   original-language filter.
7. Invalidate and warm search caches only after all database updates succeed.
8. Add job dependencies, final validation, and clearly labeled email results.

The complete steady-state path will be:

```text
IMDb title.ratings.tsv.gz                TMDb movie ID export
             |                                     |
             v                                     v
  imdb_ratings_staging              tmdb_movie_popularity_staging
             |                                     |
             +----------- validated runs ----------+
                                   |
                                   v
                         movie_list_items
                    imdb_rating | imdb_vote_count
                              popularity
                                   |
                                   v
                    existing covering indexes
                                   |
                                   v
                         /movies/search cache
                                   |
                                   v
                            MovieApp results
```

This is a Cloudflare Worker and D1 change. It does not require a new mobile
filter, a new public search parameter, or a daily scheduled job.

## 1. Decisions made by this plan

| Question | Decision |
| --- | --- |
| Should popularity have its own job? | Yes: `tmdb-popularity-refresh`. |
| How often should it run? | Once a week, immediately before the movie-list build. |
| Is popularity imported from a file? | Yes. It becomes the second external bulk-file import after IMDb ratings. |
| Does popularity need separate staging and `_current` tables? | No. It needs one run-separated staging table. The existing `movie_list_items.popularity` column is the approved live copy. |
| Should Advanced Search join the staging table on every request? | No. Search continues to read only `movie_list_items` and its covering indexes. |
| Should popularity be removed from `movie_list_items`? | No. Removing it would make search slower and would undermine the current covering indexes. |
| Should the job run daily because TMDb publishes daily files? | No. TMDb may publish daily, but MovieApp will consume the newest acceptable file once per week. |
| Should all 817,478 movie rows be rewritten every week? | No. Existing rows are updated only when their IMDb values or popularity actually differ. |
| What happens when copied IMDb values are out of date? | Every corrected `movie-list-build` run compares the selected completed IMDb delivery with the Movie List and updates only differences. |
| Is there a separate IMDb cleanup job or endpoint? | No. The first manual execution and every scheduled execution use the same ordinary Movie List job path. |
| Are the existing language and all-language search indexes removed? | No. All four current `v2` covering indexes remain. |

## 2. Technical terms used in this document

### Bulk-file import

A **bulk-file import** downloads one file containing many records and reads
those records gradually. It is different from calling an API endpoint once
for every movie.

IMDb ratings are currently MovieApp's only bulk-file import. The new TMDb
popularity job will become the second.

### Staging table

A **staging table** is a protected holding area for a new delivery of data.
Customers do not query it directly. MovieApp first proves that the complete
weekly delivery arrived and passed validation.

### Load run

A **load run** is one attempt to process one weekly file. Every row from that
attempt receives the same `load_run_id`.

For example:

```text
tmdb-popularity-refresh-cron-2026-08-04-...
```

Rows from an interrupted run can therefore be distinguished from the last
successful run.

### Promotion or application

**Promotion** means copying validated staging values into the table used by
customers. In this design, the destination is the existing
`movie_list_items` table.

### Live search copy

The **live search copy** is the deliberately duplicated value stored inside
`movie_list_items`. Popularity and IMDb values remain there so D1 can answer
Advanced Search from its covering indexes without joining another table.

### Difference-based update

A **difference-based update** compares the new weekly value with the value
already used by MovieApp and updates only rows whose values differ. In this
design, that comparison is an internal phase of the existing
`movie-list-build` job. It is not a separate scheduled job, manual endpoint,
or operator-run SQL update.

### Covering index

A **covering index** contains every `movie_list_items` value required by the
search. D1 can often return the result directly from the index instead of
looking up the corresponding main-table row.

### Cache invalidation and cache warming

**Cache invalidation** makes MovieApp stop reusing search results created from
older database values. **Cache warming** then runs common searches so their
new results are ready before customers request them.

## 3. Confirmed current state

### 3.1 IMDb is currently the only external file import

The Worker currently downloads:

```text
https://datasets.imdbws.com/title.ratings.tsv.gz
```

The Worker decompresses that file and reads its tab-separated rows. IMDb
documents that the file contains:

- `tconst`, the IMDb title identifier.
- `averageRating`, the weighted rating.
- `numVotes`, the number of votes.

IMDb refreshes the source file daily, while MovieApp intentionally consumes
it weekly. See [IMDb's non-commercial dataset documentation](https://developer.imdb.com/non-commercial-datasets/).

Every existing TMDb movie, details, provider, genre, and language import uses
JSON returned from a TMDb API endpoint. Those are API imports, not bulk-file
imports. The JSON files under `src/cache/data` are source-code assets used to
warm searches; they are not downloaded movie data.

### 3.2 Current popularity is not a catalog-wide refresh

The existing TMDb primary job requests `/discover/movie` pages for its active
release-date window. It writes the popularity included with those newly
discovered results. Once the window moves beyond a movie's release date, the
job no longer revisits that movie merely because its popularity changed.

That behavior is correct for discovering new movies but cannot maintain a
changing popularity score across the existing catalog.

The July 31 investigation of *The Death of Robin Hood* (`tmdb_id = 1284465`)
found:

- TMDb's current popularity was `309.2191` and the movie was number 8 in the
  live `/movie/popular` response at the time of the check.
- `tmdb_movies_staging` and `movie_list_items` both still contained `20.07`.
- Advanced Search therefore placed it around number 165 rather than near
  TMDb's current first page.

This was not caused by the date, language, genre, provider, or certification
filters. It was stale popularity.

### 3.3 Production IMDb freshness audit

The following figures were read from production D1 on July 31, 2026. They are
a point-in-time audit and will naturally change as imports continue.

| Measurement | Production count |
| --- | ---: |
| `imdb_ratings_staging` rows | 1,703,567 |
| `tmdb_movies_staging` rows | 1,019,622 |
| `movie_list_items` rows | 817,478 |
| Movie-list rows currently containing a non-null IMDb rating | 406,689 |
| Rows refreshed during the latest clean IMDb run | 1,698,989 |
| Movie-list rows that can join to that latest clean run | 409,022 |
| Rating and/or vote count differs from that latest clean run | **260,940** |

The originally mentioned figure of approximately 231,000 was an estimate. A
first comparison against every row still present in staging found 261,038
differences. A stricter follow-up found that 98 of those differences came from
IMDb staging rows that were not refreshed during the latest completed file
import.

The safe first-run update target at the time of this audit was therefore
**260,940**, not 231,000 and not the broader unqualified 261,038 count.

This distinction matters because the current IMDb importer never deletes a
title that disappears from a later file. The staging table contains 1,703,567
total rows, while the latest clean July 27 run refreshed 1,698,989 of them.
The update must not treat the remaining 4,578 older rows as current merely
because they still exist in the table.

The mismatches divide into mutually exclusive groups:

| Difference | Rows |
| --- | ---: |
| Rating differs, vote count already matches | 5,187 |
| Vote count differs, rating already matches | 193,139 |
| Both rating and vote count differ | 62,614 |
| **Total safe first-run update target** | **260,940** |

The audit uses SQLite's null-safe `IS NOT` comparison. This detects ordinary
numeric differences and cases where one copy is `NULL` while the other has a
value.

Conceptually:

```sql
WHERE movie.imdb_rating IS NOT imdb.average_rating
   OR movie.imdb_vote_count IS NOT imdb.num_votes
```

### 3.4 Why a successful IMDb import did not fix Advanced Search

The current IMDb job performs `INSERT OR REPLACE` for every row in the file.
The latest complete scheduled import processed approximately 1.7 million
records. That operation refreshes `imdb_ratings_staging`.

The weekly movie-list build does not then rewrite all 817,478 movies. It
selects a much smaller set of rows. That incremental approach is correct, but
the selection condition is incomplete.

Today the build considers a row changed only when one of these TMDb timestamps
is newer than the previous successful movie-list build:

- `tmdb_movies_staging.imported_at`
- `tmdb_movies_staging.tmdb_enriched_at`

It does not consider an IMDb rating or vote difference. A movie whose only
change is an increased IMDb vote count is therefore omitted.

The July 31 manual movie-list build illustrates the problem:

- The movie list contained 817,478 rows.
- The build selected and updated only 2,233 TMDb-changed rows.
- More than 260,000 safe, current-run IMDb differences remained untouched.

## 4. Tables involved

### 4.1 Existing `movie_list_items`

This remains the only movie table queried by `/movies/search`.

The existing columns remain:

```text
imdb_rating
imdb_vote_count
popularity
```

They are not removed and are not replaced by runtime joins.

The values have these responsibilities:

- `imdb_rating` is the approved IMDb rating used for filtering, display, and
  IMDb sorting.
- `imdb_vote_count` is the approved vote total and IMDb-sort tie breaker.
- `popularity` is the approved TMDb popularity used for popularity sorting.

### 4.2 New `tmdb_movie_popularity_staging`

Only one new popularity data table is required:

```sql
CREATE TABLE tmdb_movie_popularity_staging (
    load_run_id TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    popularity REAL NOT NULL,
    source_export_date TEXT NOT NULL,
    staged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (load_run_id, tmdb_id)
);
```

There will not be a permanent `tmdb_movie_popularity_current` table.

The composite primary key allows two weekly snapshots to exist temporarily
inside this one table:

1. The last completed run that produced the current live movie-list values.
2. The new run being downloaded and validated.

If the new run fails halfway through, its `load_run_id` identifies every
partial row. The movie list continues using its previous values.

After a successful movie-list application, cleanup retains the newly applied
run for audit and removes older runs in run-scoped chunks. Cleanup is one
operation per old run, divided into safe database batches; it is not one
separate cleanup query per movie.

The `import_job_runs` record stores the source URL, HTTP metadata, source date,
counts, validation outcome, and the movie-list build that applied the run.

### 4.3 Existing `tmdb_movies_staging.popularity`

This existing column will not be dropped during this change.

It remains useful as the discovery-time value for a brand-new movie. However,
after the popularity feature is deployed, it is no longer the authoritative
weekly popularity source for existing movies.

The rule becomes:

```text
Existing movie in latest validated popularity run
    → use tmdb_movie_popularity_staging.popularity

Brand-new movie not yet present in that run
    → temporarily fall back to tmdb_movies_staging.popularity

No usable value from either source
    → use 0
```

The next successful weekly popularity file should normally replace that
temporary fallback.

### 4.4 Existing `imdb_ratings_staging`

The first corrected Movie List run will use the existing table to update the
approximately 260,940 safely eligible rows. No destructive IMDb-table
migration is required before correcting the customer-facing data.

The current table is not fully protected against an interrupted file import.
Its primary key is only `imdb_id`, so each arriving batch overwrites the prior
value immediately. An interrupted import can leave staging containing a
mixture of two file dates. Customers remain protected only because the
movie-list build is required to wait for a complete IMDb parent job.

### 4.5 Permanent IMDb run separation

After the first corrected Movie List execution is verified, IMDb staging will be brought to the
same run-separated model as popularity. The final shape will be equivalent to:

```sql
CREATE TABLE imdb_ratings_staging_by_run (
    load_run_id TEXT NOT NULL,
    imdb_id TEXT NOT NULL,
    average_rating REAL,
    num_votes INTEGER,
    source_retrieved_at TEXT NOT NULL,
    staged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (load_run_id, imdb_id)
);
```

There is still no IMDb `_current` table. `movie_list_items` remains the live
search copy.

The existing `imdb_ratings_staging` table will remain untouched while the new
run-separated table receives and validates its first complete file. The
Worker will switch only after the new table proves that it can produce the
same or better coverage. The old table will be retained through a rollback
window and removed only after production verification.

That temporary side-by-side migration is a safety technique, not the final
two-table architecture.

## 5. New TMDb popularity file import

### 5.1 Source file

TMDb publishes daily ID export files at:

```text
https://files.tmdb.org/p/exports/movie_ids_MM_DD_YYYY.json.gz
```

TMDb explains that:

- The file contains valid movie IDs and high-level fields including
  `popularity`, `adult`, and `video`.
- Each line is an independent JSON object; the complete file is not one JSON
  array.
- The export process starts around 07:00 UTC.
- All daily files are normally available by 08:00 UTC.

See [TMDb Daily ID Exports](https://developer.themoviedb.org/docs/daily-id-exports)
and [TMDb's popularity documentation](https://developer.themoviedb.org/docs/popularity-and-trending).

The July 31 file was verified directly during this investigation:

- HTTP status: `200`.
- Compressed size: 27,376,683 bytes, approximately 26.1 MiB.
- `Last-Modified`: July 31, 2026 at 07:19:28 UTC.
- Sample line shape:

```json
{"adult":false,"id":3924,"original_title":"Blondie","popularity":1.2659,"video":false}
```

### 5.2 Weekly, not daily

MovieApp will download the newest acceptable export once per weekly pipeline.
TMDb's daily publication frequency does not require MovieApp to run every day.

The scheduled job will start at approximately 09:00 UTC on the same UTC
pipeline date as the other weekly jobs. This is:

- After TMDb's documented 08:00 UTC availability time.
- After the existing 07:00 provider refresh begins.
- Before the 12:00 movie-list build.

### 5.3 File-date selection

The job will first request the export expected for its UTC pipeline date.

If the expected file is temporarily unavailable:

1. Retry ordinary network and server failures with bounded delays.
2. Do not treat a missing expected export as a successful empty load.
3. Permit a one-day fallback only when the fallback is explicitly recorded
   and is within the configured maximum age.
4. Fail rather than silently accepting an older file beyond that maximum.

The source URL, selected source date, response `Last-Modified`, compressed
bytes, and retrieval time are stored in the job result.

### 5.4 Streaming and queueing

The Worker will reuse the proven IMDb file-reading pattern:

1. Fetch the gzip file.
2. Pass the response body through `DecompressionStream("gzip")`.
3. Decode text incrementally.
4. Preserve a partial final line between stream chunks.
5. Parse one JSON line at a time.
6. Place manageable row groups on a Cloudflare queue.
7. Insert each group into the run-separated staging table.

The complete file is never held in Worker memory.

Cloudflare D1 currently permits at most 100 bound parameters per query. The
row count per SQL statement will be calculated from the exact number of bound
columns rather than copied blindly from IMDb's current 33-row batches. See
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

### 5.5 Row acceptance rules

A staged row must have:

- A positive integer `id`.
- A finite, nonnegative numeric `popularity`.
- `adult = false`.
- `video = false`.

Duplicate `(load_run_id, tmdb_id)` rows are rejected or counted explicitly;
they are never allowed to inflate the completion count silently.

Every malformed or rejected line contributes to validation statistics. A
parse error cannot be converted into a popularity value of zero.

## 6. `tmdb-popularity-refresh` job behavior

The dedicated job name will be:

```text
tmdb-popularity-refresh
```

One parent job represents the complete file. Its job record progresses through
these logical phases while retaining the existing supported job statuses:

1. Create the parent `import_job_runs` row and acquire the popularity lock.
2. Select and fetch the expected export.
3. Stream and queue every valid row with the parent's `load_run_id`.
4. Record how many file lines were seen and how many rows were queued.
5. Process all queue messages into staging.
6. Confirm that processed rows equal queued rows.
7. Run completeness and coverage validation.
8. Mark the parent `complete` only when validation succeeds with zero errors.
9. Send a clearly labeled success or failure email.

An individual queue message can be retried without double-counting. The
existing `import_job_queue_messages` table records whether that exact message
already finished, and the popularity table permits only one row for a given
weekly run and movie. Repeating the same work therefore replaces the same
value instead of creating a duplicate.

If the message still cannot finish after every automatic retry, Cloudflare
moves it to MovieApp's **failed-work queue**. That queue is simply a holding
place for work that could not be completed. MovieApp uses its arrival there to
change the complete parent import to `failed` instead of leaving the parent
incorrectly marked `running` forever.

The popularity job stages and validates the file. The later movie-list build
applies the newest complete popularity run. Keeping those two moments separate
ensures a complete file never becomes customer-visible before the rest of the
weekly search data is ready.

## 7. Popularity validation before application

The popularity parent job must pass all of the following checks:

1. The selected source date is within the accepted freshness window.
2. The download completed and gzip decompression reached the end of the file.
3. At least one valid row was parsed.
4. Seen, queued, processed, and staged counts match as expected.
5. No queue message remains missing, active, or permanently failed.
6. The number of unique staged IDs equals the accepted row count.
7. The row count does not fall outside an approved percentage of the previous
   successful run without explicit operator approval.
8. The overlap with `movie_list_items` remains within an approved percentage
   of the previous run.
9. Invalid ID, popularity, adult, video, duplicate, and parse counts are
   recorded separately.
10. A sample of known TMDb IDs matches the parsed file values.
11. The top popularity values are plausible and nonempty.
12. The job has an ending time and its completion email was accepted by the
    configured SMTP server.

The first production load establishes the initial count and overlap baseline.
The thresholds will be derived from measured data rather than guessed before
the first file is staged.

## 8. The first corrected Movie List run brings the IMDb backlog current

There will not be a separate IMDb cleanup job. The existing
`movie-list-build` job will gain an internal IMDb-difference phase. Its first
production run brings the accumulated backlog current; every later weekly run uses
the same phase for newly changed ratings and vote counts.

The Movie List job reads only IMDb rows whose `imported_at` falls within the
start and end times of the latest clean, completed IMDb parent job for the
requested pipeline date. It will not begin its IMDb phase while that pipeline's
IMDb import is `queued` or `running`.

That time boundary is the only reliable current way to exclude older staging
rows that were not present in the latest file. After IMDb receives true
`load_run_id` separation, the update will select the completed run ID directly
instead of inferring membership from timestamps.

### 8.1 Exact update scope

For existing rows, the Movie List job's IMDb phase changes only:

```text
movie_list_items.imdb_rating
movie_list_items.imdb_vote_count
movie_list_items.last_refreshed_at
```

It does not change:

- `tmdb_id`
- Title
- Poster
- Release date
- Certification
- Popularity
- Original language
- Genres
- Providers
- Any TMDb staging value

The existing `tmdb_id` and `imdb_id` relationship locates the correct row.

### 8.2 Internal chunked processing

Cloudflare recommends breaking an update that affects hundreds of thousands
of rows into small batches rather than attempting one enormous statement.
The initial production batch target will be approximately 1,000 changed movie
rows per transaction, subject to local rehearsal and production timing.

The Movie List job will:

1. Read changed candidates in ascending `tmdb_id` order.
2. Keep the last completed `tmdb_id` in its in-memory/current-run progress and
   job result.
3. Update no more than the configured batch ceiling.
4. Record selected, processed, updated, and error counts after every batch.
5. Resume safely after a temporary interruption because already corrected
   rows no longer satisfy the difference predicate.
6. Retain the difference predicate so a repeated batch is harmless.

Each partial batch writes newer correct IMDb values. A temporary interruption
does not corrupt unrelated movie information. Rerunning the same Movie List
job path naturally skips corrected rows and continues until the remaining
mismatch count reaches zero.

### 8.3 Movie List verification

Before the first manual execution of the corrected Movie List job:

1. Capture a D1 Time Travel bookmark.
2. Record all table row counts.
3. Record non-null counts for every `movie_list_items` column.
4. Record the mismatch groups shown in Section 3.3.
5. Record sample values for old, recent, highly rated, low-vote, and null-rated
   movies.

After the corrected Movie List job:

1. The null-safe IMDb mismatch count must be zero.
2. `movie_list_items` row count must remain unchanged.
3. Title, poster, release date, certification, popularity, language, genre,
   and provider counts must remain unchanged.
4. The number of rows updated must match the pre-update candidate
   count, allowing for any explicitly documented source changes that occurred
   between the two measurements.
5. IMDb-sorted searches must show the corrected values and order.
6. The completed Movie List job must invalidate and warm search caches through
   the existing cache-generation workflow.

## 9. Permanent weekly IMDb synchronization

The first corrected execution is not sufficient by itself. Every later weekly movie-list build must
recognize future IMDb changes.

### 9.1 Do not use only `imdb.imported_at`

The complete IMDb file is loaded weekly, so every imported staging row receives
a new import time. Selecting solely on `imdb.imported_at` would unnecessarily
rewrite every matching movie even when its rating and vote count remained
unchanged.

The correct eligibility rule compares values:

```sql
movie.imdb_rating IS NOT imdb.average_rating
OR movie.imdb_vote_count IS NOT imdb.num_votes
```

### 9.2 Expected weekly write volume

MovieApp does not copy all 1.7 million IMDb records into the movie list.

- The IMDb staging table contains ratings for movies, television, episodes,
  video games, and other IMDb title types.
- Only IMDb IDs connected to MovieApp's TMDb movies can affect
  `movie_list_items`.
- Only connected rows whose value actually differs are updated.

At the July 31 snapshot, 409,022 movie-list rows matched the latest clean IMDb
run and 260,940 safely eligible rows differed because multiple weekly copies
had been missed. After the backlog is current, the normal weekly changed
count should be measured and reported rather than assumed. Vote totals change
frequently, so the count may still be substantial, but it is not a blind
rewrite of all 817,478 movies.

### 9.3 Run-separated IMDb staging

The run-separated IMDb migration described in Section 4.5 will occur only
after the first corrected Movie List execution.

Its safe sequence is:

1. Create the new table without changing the existing table.
2. Import one complete IMDb file into a unique `load_run_id`.
3. Compare file count, join coverage, ratings, votes, and samples against the
   existing table.
4. Deploy code capable of reading the new table only after it exists.
5. Use one explicitly selected completed IMDb run for comparison and the
   movie-list build.
6. Keep the old table through the rollback window.
7. Remove the old table only after production verification.
8. Keep one last applied IMDb run plus any in-progress run in the final staging
   table; remove older runs in run-scoped chunks.

No IMDb `_current` table is introduced.

## 10. Movie-list build changes

The movie-list build currently has one broad TMDb-timestamp candidate path.
It will be expanded into three understandable candidate reasons:

1. **TMDb movie change**: a new movie or ordinary TMDb metadata refresh.
2. **IMDb change**: rating or vote count differs from the selected completed
   IMDb run.
3. **Popularity change**: popularity differs from the selected completed TMDb
   popularity run.

The build records a count for each reason and a deduplicated total. A movie
that changed in more than one category is processed once.

### 10.1 Narrow updates for changing scalar values

An existing movie with only an IMDb change receives a narrow IMDb update.
An existing movie with only a popularity change receives a narrow popularity
update.

The build must not use full-row `INSERT OR REPLACE` merely to change one
number. That avoids rewriting unrelated fields and makes the safety boundary
easy to audit.

Conceptually:

```sql
UPDATE movie_list_items
SET popularity = ?
WHERE tmdb_id = ?
  AND popularity IS NOT ?;
```

and:

```sql
UPDATE movie_list_items
SET imdb_rating = ?,
    imdb_vote_count = ?
WHERE tmdb_id = ?
  AND (
      imdb_rating IS NOT ?
      OR imdb_vote_count IS NOT ?
  );
```

The final implementation may use set-based chunk statements rather than one
statement per row, but the columns permitted to change remain this narrow.

### 10.2 New movies

A genuinely new movie continues through the existing complete-row insert.
Its initial popularity uses:

1. The selected completed popularity run when available.
2. Otherwise its TMDb Discover popularity as a temporary fallback.
3. Otherwise zero.

Its IMDb rating and vote count use the selected completed IMDb run when a
matching IMDb ID exists.

### 10.3 Selected source runs

The movie-list result records:

- The exact IMDb `load_run_id` used.
- The exact TMDb popularity `load_run_id` used.
- Both source dates.
- Each candidate-reason count.
- Each updated-row count.
- Remaining mismatch counts.

The selected runs must belong to the requested UTC pipeline date and must have
status `complete`, zero errors, and an ending time.

## 11. Index plan

### 11.1 Existing search indexes remain

The four deployed `movie_list_items` covering indexes remain:

```text
idx_movie_list_items_search_popularity_v2_cover
idx_movie_list_items_search_imdb_v2_cover
idx_movie_list_items_language_popularity_v2_cover
idx_movie_list_items_language_imdb_v2_cover
```

They support:

- All languages sorted by popularity.
- All languages sorted by IMDb rating.
- One or more selected languages sorted by popularity.
- One or more selected languages sorted by IMDb rating.

Each already contains `popularity`, `imdb_rating`, and the other response
fields needed by Advanced Search. No search query needs to retrieve popularity
from the staging table.

### 11.2 Popularity staging index

The popularity primary key:

```sql
PRIMARY KEY (load_run_id, tmdb_id)
```

supports the important access path:

```text
one completed load run → movies in ascending TMDb ID order
```

That is the order used for validation, joining, chunked application, and
cleanup. A redundant index on only `load_run_id` is not needed because
`load_run_id` is already the first primary-key column.

No popularity-descending index is initially required on the staging table.
The customer-facing popularity sort already belongs to the movie-list
covering index.

### 11.3 IMDb indexes

The existing `imdb_ratings_staging.imdb_id` primary key and
`tmdb_movies_staging.imdb_id` index support the first corrected Movie List execution.

The future run-separated IMDb primary key:

```sql
PRIMARY KEY (load_run_id, imdb_id)
```

supports selecting one validated run and joining its rows by IMDb ID.

### 11.4 Index write cost

Updating popularity or IMDb values necessarily updates the covering indexes
that contain those values. This is expected and is another reason to update
only changed rows in small chunks.

Before finalizing a chunk size, local rehearsal and production canary batches
will measure:

- Rows read.
- Rows written.
- SQL duration.
- Total Worker duration.
- Database-size growth.
- Search query plans after the update.

## 12. Worker endpoints and code areas

### 12.1 New protected manual endpoint

Add:

```http
POST /admin/import/tmdb/popularity-refresh-manual
```

It starts the same job used by the weekly schedule. The endpoint requires the
existing administrator authorization.

### 12.2 Existing monitoring endpoints

The existing endpoint remains the monitor:

```http
GET /admin/import/job-runs?jobName=tmdb-popularity-refresh&limit=1
GET /admin/import/job-runs?jobName=movie-list-build&limit=1
```

There is no separate IMDb freshness-update monitor because there is no separate update
job. IMDb candidate and update counts appear in the Movie List job result.

### 12.3 No new public endpoint

`GET /movies/search` keeps its existing public contract. Popularity is a
changing sort value, not a new customer-submitted filter.

### 12.4 Expected code areas

Implementation will involve:

- A new migration for popularity staging.
- A new `src/imports/tmdbPopularity.ts` importer.
- `src/imports/imdbRatings.ts` for eventual run separation.
- `src/imports/movieListBuild.ts` for IMDb and popularity differences.
- `src/shared/types.ts` for queue messages and pause flags.
- `src/jobs/importJobRuns.ts` for job names.
- `src/jobs/queueHandler.ts` for queue and permanent-failure handling.
- `src/jobs/importJobDependencies.ts` for the date-scoped prerequisite.
- `src/jobs/scheduled.ts`, `src/jobs/scheduledCronConfig.ts`,
  `scripts/syncScheduledCrons.mjs`, and `wrangler.jsonc` for scheduling.
- `src/jobs/weeklyImportValidation.ts` for final validation.
- `src/notifications/jobNotifications.ts` for readable job names and email
  outcomes.
- `src/httpRouting/httpRoutes.ts` for protected manual routes.
- Worker tests covering files, queues, dependencies, promotion, and failures.

## 13. Search cache behavior

Popularity changes the ordering returned for the same search URL. IMDb values
change both displayed ratings and IMDb-sorted ordering. Therefore, database
success without cache invalidation is incomplete.

The cache rules are:

1. Do not change the search cache generation when a file merely starts
   staging.
2. Do not change it when an incomplete or failed load is present.
3. Apply all selected movie-list chunks successfully.
4. Verify zero remaining applicable mismatches.
5. Complete the movie-list build.
6. Advance the search-data/cache generation.
7. Run the existing cache warm against the new generation.

Popularity does not become a query-cache parameter because the customer does
not submit a popularity value. The refreshed data generation distinguishes
old and new results.

The cache warm continues to include the default English search variants and
the currently supported all-language and filter combinations.

## 14. Sunday weekly schedule and dependencies

The intended Sunday UTC sequence becomes:

| UTC time | Weekly operation | Required before it |
| --- | --- | --- |
| 01:00 | IMDb ratings file import | Nothing |
| 03:00 | TMDb primary new-movie import | Current pipeline policy |
| 05:00 | TMDb details for newly discovered movies | TMDb primary |
| 07:00 | TMDb provider refresh | Applicable TMDb prerequisites |
| **09:00** | **TMDb popularity file refresh** | TMDb export availability |
| 12:00 | Movie-list build and difference-based value updates | Clean IMDb, TMDb, provider, and popularity runs for the same pipeline date |
| 13:00 | Search-cache warm | Successful current movie-list build |
| 15:00 | Final weekly validation | All scheduled jobs have had time to finish |

The exact raw cron expression will be generated through the repository's
existing cron synchronization script rather than edited inconsistently in
multiple files.

### 14.1 Pipeline date

Every parent job is associated with the UTC date on which that weekly pipeline
started. Queue messages retain the parent's job ID even if an individual
message finishes after midnight.

The movie-list dependency checker receives an explicit pipeline date and
examines only that date's newest applicable job record. An obsolete historical
`running` record cannot block a newer successful pipeline.

If the schedule is later moved across multiple UTC dates, an explicit durable
`pipeline_date` column should be added rather than inferring independent dates
for each job.

### 14.2 Failure behavior

If the popularity or IMDb job is missing, active, failed, incomplete, or has
errors:

- The movie-list build records a precise dependency blocker.
- It ends `skipped` with an `ACTION REQUIRED` email.
- It does not apply partial file data.
- It does not advance the cache generation.
- The final validator reports the missing production step.

## 15. Job reporting, validation, and email

### 15.1 Popularity job result

The `result_json` for `tmdb-popularity-refresh` will include at least:

- Job and load-run IDs.
- Pipeline date.
- Source URL and export date.
- Response `Last-Modified` and compressed bytes when available.
- Lines seen.
- Adult/video rows excluded.
- Invalid and duplicate rows.
- Rows accepted, queued, processed, and staged.
- Queue-message totals.
- Previous-run and current-run row counts.
- Movie-list overlap.
- Validation thresholds and outcomes.
- Start, end, and duration.
- Notification delivery result.

### 15.2 Movie-list result

The movie-list result will add:

- Selected IMDb run ID.
- Selected popularity run ID.
- TMDb metadata candidate count.
- IMDb-difference candidate count.
- Popularity-difference candidate count.
- Deduplicated candidates.
- IMDb rows updated.
- Popularity rows updated.
- Remaining IMDb mismatches.
- Remaining popularity mismatches.
- Cache generation activated.

### 15.3 Email subjects

The existing outcome-first convention will apply:

```text
[MovieApp] SUCCESS: TMDb Popularity Refresh Job (...)
[MovieApp] FAILED: TMDb Popularity Refresh Job (...)
[MovieApp] SUCCESS: Movie List Build Job (...)
[MovieApp] FAILED: Movie List Build Job (...)
[MovieApp] ACTION REQUIRED: Movie List Build Job (...)
```

### 15.4 Final weekly validation

Add `tmdb-popularity-refresh` to the required weekly job list. The final
validator must confirm:

- A run exists for the requested pipeline date.
- It is `complete` with zero errors.
- Selected, queued, processed, and updated counts match as expected.
- It has an ending time.
- Its email was accepted or a notification error is recorded.
- The movie-list build used its exact run ID.
- The movie-list build reports zero remaining popularity differences for the
  applied scope.
- The movie-list build reports zero remaining IMDb differences for the
  selected IMDb run.
- The cache warm used the successful movie-list generation.

At the validation deadline, any applicable scheduled job still marked
`queued` or `running` is changed to `failed` and reported.

## 16. Database safety and recovery

### 16.1 Existing movie data is not replaced

The popularity migration adds a new table. It does not alter or delete
existing movie rows.

The corrected Movie List IMDb phase uses narrow `UPDATE` statements. It does not run a full-table
`INSERT OR REPLACE` against `movie_list_items`.

### 16.2 Pre-change recovery point

Before the first corrected production Movie List run or popularity application:

1. Record a D1 Time Travel bookmark.
2. Record current database size and available D1 headroom.
3. Record row counts and important non-null counts.
4. Retain the existing dated production export through verification.
5. Rehearse migrations and update jobs against a local production-derived
   database where practical.

Cloudflare documents a 10 GB maximum database size for Workers Paid D1 and
recommends batching changes that affect hundreds of thousands of rows. The
production database reported 1,775,509,504 bytes during the July 31 audit, but
headroom will be checked again immediately before migration rather than
assuming that snapshot remains current. See [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

### 16.3 Expected-update ceilings

Every database-changing message receives an expected maximum number of rows.
If D1 reports more changes than the message's approved ceiling, the parent job
fails and no later cache generation is activated.

### 16.4 Failure and resumption

- Failed file runs never become eligible sources.
- Failed run rows are identified by `load_run_id`.
- Correctly completed Movie List IMDb-update batches remain valid.
- Rerunning a batch is harmless because it still requires a value difference.
- Cleanup happens only after a successful application.
- Cleanup removes old run partitions in bounded chunks.
- The last applied run remains available for audit and rollback comparison.

### 16.5 Storage during run-separated imports

A run-separated table temporarily contains the last applied snapshot plus the
new in-progress snapshot. This increases storage while a file is loading.

Before enabling the run-separated IMDb migration, measure the actual size of
one complete new snapshot, including its primary-key index. Do not drop the
old IMDb table merely to create space. If measured headroom is insufficient,
pause the migration and choose a separately reviewed storage design.

## 17. Test plan

### 17.1 Popularity file parser tests

Test:

- A valid file with multiple JSON lines.
- A JSON line split between stream chunks.
- A final line without a newline.
- Invalid JSON.
- Missing, negative, infinite, and string popularity values.
- Invalid IDs.
- Adult and video rows.
- Duplicate IDs.
- Empty gzip content.
- Truncated gzip content.
- Expected-file `404` and server errors.
- One-day approved fallback and stale fallback rejection.

### 17.2 Queue and parent-job tests

Test:

- Duplicate queue delivery is counted once.
- A transient failure retries successfully.
- Exhausted retries make the parent `failed`.
- Late messages cannot revive a failed job.
- A partial run cannot be selected by the movie-list build.
- An older complete run remains safe while a new run is active.

### 17.3 Movie List IMDb-phase tests

Test:

- Rating-only difference.
- Vote-only difference.
- Both differ.
- `NULL` becomes a real rating and vote count.
- Real values become `NULL` only when the selected clean source actually says
  so.
- Identical rows are not written.
- A stopped job resumes from its saved TMDb ID.
- No non-IMDb movie column changes.
- A second complete run updates zero rows.

### 17.4 Movie-list build tests

Test each candidate reason alone and in combination:

- TMDb metadata only.
- IMDb only.
- Popularity only.
- IMDb and popularity together.
- New movie present in the popularity run.
- New movie using Discover fallback.
- Movie absent from IMDb.
- Movie absent from the latest popularity run.
- Dependency missing, active, failed, or from the wrong pipeline date.

### 17.5 Index and endpoint tests

Use `EXPLAIN QUERY PLAN` for:

- All languages sorted by popularity.
- English sorted by popularity.
- Korean sorted by popularity.
- All languages sorted by IMDb.
- English sorted by IMDb.
- Date, certification, genre, and provider combinations.
- Cursor pages after the first page.

The intended `v2` covering index must still be used, and no search should join
the popularity or IMDb staging tables.

### 17.6 Production verification

Verify:

- The IMDb mismatch count reaches zero.
- The popularity mismatch count against the applied run reaches zero for
  movies present in that run.
- Movie-list row count remains unchanged except for legitimate new movies
  from the ordinary TMDb pipeline.
- The Death of Robin Hood receives the popularity value from the applied file
  and moves to the corresponding Advanced Search neighborhood.
- TMDb's live homepage order may differ slightly from the weekly snapshot, but
  the large stale-data discrepancy is gone.
- IMDb and popularity values displayed by the API match D1.
- Fresh and warmed cache responses use the new movie-list generation.
- Success and failure test emails have the correct outcome at the beginning of
  the subject.

## 18. Deployment and execution order

### Phase A: Correct and execute the ordinary Movie List job

1. Add and test the null-safe IMDb-difference phase inside
   `movie-list-build`.
2. Keep its updates narrow: IMDb rating, vote count, and refresh time only.
3. Capture the production recovery point and before-counts.
4. Deploy the corrected Movie List job without adding a separate freshness-update job or
   endpoint.
5. Run the corrected Movie List job manually for the approved pipeline date.
6. The job itself finds and updates the approximately 260,940 confirmed IMDb
   differences in bounded internal batches.
7. Confirm that only the two IMDb value columns and refresh time changed.
8. Confirm zero remaining IMDb differences against the selected clean IMDb
   run.
9. Allow the successful Movie List result to create the new search-cache
   generation, then run the cache warm.
10. Verify live IMDb-sorted searches and the Movie List completion email.

### Phase B: Add popularity staging and manual import

11. Create the popularity staging migration.
12. Apply the migration before deploying code that references the new table.
13. Deploy the parser, queue message, job tracking, pause flag, notifications,
    failed-work handling, and protected manual endpoint.
14. Keep the popularity cron and movie-list dependency disabled initially.
15. Run a dry parser check against the current TMDb export.
16. Run one complete production staging load without applying it.
17. Validate counts, overlap, source date, sample IDs, storage, and timings.

### Phase C: Apply popularity to the movie list

18. Implement narrow popularity updates and combined candidate reporting in
    the movie-list build.
19. Test against a production-derived local database.
20. Capture a new production recovery point.
21. Apply the validated popularity run in bounded chunks.
22. Confirm zero remaining differences for its eligible movie-list rows.
23. Verify The Death of Robin Hood and a broad top-movie sample.
24. Activate the new cache generation and warm it.
25. Verify homepage-to-Advanced-Search behavior, query plans, and email.

### Phase D: Enable the permanent weekly pipeline

26. Add the 09:00 UTC popularity schedule through `wrangler.jsonc` and the
    cron synchronization script.
27. Make the movie-list build require the popularity run for the same pipeline
    date.
28. Add popularity to final weekly validation.
29. Deploy configuration and Worker code in the required order.
30. Observe the first complete scheduled pipeline through final validation.

### Phase E: Harden IMDb staging

31. Create the side-by-side run-separated IMDb staging table.
32. Load and validate one complete IMDb run.
33. Compare it with the existing staging table and movie-list coverage.
34. Switch the Movie List IMDb phase to one explicit completed IMDb run.
35. Retain the former IMDb table through the rollback window.
36. Remove the former table only after production verification and storage
    review.

## 19. Acceptance criteria

The work is complete only when all of the following are true:

1. `tmdb-popularity-refresh` successfully consumes a real TMDb gzip export.
2. The job runs weekly, not daily.
3. Only one permanent TMDb popularity staging table exists.
4. No popularity `_current` table exists.
5. `movie_list_items.popularity` remains the live indexed value.
6. An interrupted popularity load cannot alter customer-visible values.
7. The July 31 IMDb backlog is current and the safely applicable mismatch count is
   zero.
8. Future weekly IMDb differences are selected by value, not merely by TMDb
   timestamps.
9. Existing rows receive narrow IMDb and popularity updates rather than
   unrelated full-row replacement.
10. All four language-aware and all-language covering indexes remain in use.
11. Search does not join staging tables at request time.
12. Cache generation changes only after a complete successful movie-list
    update.
13. The final weekly validator includes popularity and verifies exact source
    run IDs.
14. Failures and skips produce conspicuous `FAILED` or `ACTION REQUIRED`
    emails.
15. Existing titles, posters, release dates, certifications, languages,
    genres, providers, and movie-list row counts survive unchanged except for
    separately verified ordinary new-movie imports.
16. Production Advanced Search popularity is aligned with the applied weekly
    TMDb file closely enough that homepage discrepancies reflect only normal
    snapshot timing, not months-old database values.

## 20. Implemented changes and measured live results

The architecture in this document has now been implemented and deployed. The
following figures are recorded here so a future maintainer can distinguish the
approved design from what actually happened when it first ran against the live
database.

### 20.1 Recovery points and narrow updates

D1 Time Travel recovery bookmarks were recorded before the first Movie List
update, before the first popularity application, and before the first
run-separated IMDb import. These are database recovery positions maintained by
Cloudflare; they are not evidence that data was damaged or restored.

The corrected ordinary Movie List job was then executed manually instead of
waiting for the next scheduled run. It changed the IMDb rating and/or vote
count for exactly 260,940 eligible movies and left zero confirmed differences
against the selected July 27 IMDb
delivery. The searchable movie count remained exactly 817,478. Titles, movie
IDs, posters, release dates, certifications, popularity, original languages,
genres, and providers were not replaced by this operation.

### 20.2 First TMDb popularity-file import

The first complete popularity job processed TMDb's
`movie_ids_07_31_2026.json.gz` delivery:

- 1,226,949 file lines were read.
- 1,166,309 movie rows were accepted and staged.
- 60,640 video rows were intentionally excluded.
- 813,849 of the staged IDs already existed in the 817,478-row Movie List.
- Validation completed with zero issues.
- The configured success email was accepted by the mail server.

The following Movie List build found 811,946 existing movies whose popularity
differed from that delivery, updated all 811,946 in bounded batches, and left
zero remaining differences for eligible rows. The Movie List row count did not
change during that application.

The Death of Robin Hood, TMDb ID `1284465`, changed from the outdated popularity
value `20.07` to the selected file value `309.2191`. An English-language search
for 2021 through 2026 then returned The Odyssey, Supergirl, Masters of the
Universe, Disclosure Day, Obsession, Moana, The Death of Robin Hood, Avatar
Aang, Toy Story 5, and Backrooms as its first ten results. The exact order will
change with future weekly files.

### 20.3 First protected, run-separated IMDb import

Migration `0027_add_imdb_ratings_staging_by_run.sql` added the new table beside
the existing table. The first full import placed 1,701,193 IMDb rows in one
isolated July 31 run. Its parent job processed the 1,701,193 data rows plus one
final validation step, reported zero errors and zero validation issues, found
409,157 rows connected to MovieApp movies, and recorded an accepted success
email.

The former IMDb table was not overwritten. Its before-and-after measurements
remain identical:

- 1,703,567 rows.
- Rating total `11,839,672.8`.
- Vote total `1,755,643,615`.
- Latest import timestamp `2026-07-27 01:29:02`.

This preserved table is the rollback copy during the verification window. The
new Movie List logic reads the explicitly selected, complete run from the new
table; it does not combine rows from different weekly deliveries.

### 20.4 New-movie and provider pass

The ordinary TMDb new-movie pipeline was run through August 1 so the Movie
List build would not merely refresh changing values while missing current
movies. It discovered 342 new movie IDs and enriched all 342 with zero errors.
That is how Spider-Man: Brand New Day, TMDb ID `969681`, entered staging with
its IMDb ID, original language, poster, and release information.

The matching weekly provider refresh selected and processed 83,573 current
U.S. streaming candidate movies. It completed with zero errors, staged 194,211
provider relationships, and recorded an accepted success email. The existing
live provider table remained unchanged until the complete run was promoted by
the Movie List job.

A TMDb `404` in this job means that the movie no longer has a provider
resource. MovieApp records that as an accepted no-provider result, inserts no
provider rows for that movie, and does not increment the warning or error
count. This first run encountered no such missing candidate; automated tests
verify the accepted behavior.

### 20.5 Final Movie List publication

The final ordinary Movie List job explicitly selected the complete July 31
IMDb and popularity runs. It completed with:

- 81,178 selected and processed movie rows.
- 80,837 IMDb rating and/or vote differences updated.
- Zero remaining IMDb differences against the selected run.
- Zero remaining popularity differences against the selected run.
- 341 ordinary movie records inserted or refreshed.
- 817,785 total searchable movies, an increase of 307 legitimate new rows.
- 83,573 provider movies and 194,211 provider relationships promoted.
- Zero errors and an accepted success email.

Spider-Man: Brand New Day is now the first result in the live English-language
2021-through-2026 popularity search with the selected file value `1519.851`.
The Death of Robin Hood is eighth with `309.2191`. The API returns the same
TMDb IDs as a direct D1 query, and the language-first popularity covering index
serves the query without a separate sorting step.

### 20.6 Sunday schedule correction

Cloudflare Cron Triggers use `1` for Sunday and `2` for Monday. The old source
comment described Sunday, but its executable expressions ended in `2`, so the
jobs actually ran Monday. All eight expressions have been corrected to end in
`1`:

```text
01:00 UTC Sunday  IMDb file import
03:00 UTC Sunday  TMDb primary import
05:00 UTC Sunday  New-movie details
07:00 UTC Sunday  Provider refresh
09:00 UTC Sunday  Popularity-file import
12:00 UTC Sunday  Movie List build (8:00 AM Eastern during daylight time)
13:00 UTC Sunday  Search-cache warm
15:00 UTC Sunday  Final weekly validation
```

All jobs still begin on the same UTC pipeline date. The date-scoped dependency
checks therefore remain correct even though the weekday has changed.

The corrected expressions and matching Worker constants were deployed as
Worker version:

```text
f51d5758-2bc2-4643-8709-05215bcac082
```

Cloudflare's deployment response listed all eight live triggers with weekday
`1`, confirming that the source configuration and deployed trigger set match.

### 20.7 Cache, notifications, and final health checks

The final cache warm completed with:

- 3,024 of 3,024 configured search combinations processed.
- 5,881 result pages warmed.
- 5,881 confirmed cache hits.
- Zero errors.
- An accepted success email.

The final database and job-state audit found:

- Zero jobs left `queued` or `running`.
- Zero recent terminal jobs missing a recorded accepted email.
- All 22 jobs in the final execution window marked `complete`.
- 817,785 searchable movies.
- 409,464 movies with an IMDb rating and vote count.
- 814,627 movies with an original-language code.
- Every searchable movie with a popularity value.
- Database size `2,382,811,136` bytes, well below the documented 10 GB D1
  limit.

The final D1 Time Travel bookmark is:

```text
000004bc-000471fb-000050ba-05e491f7ddbcea90a104525799d03568
```

That bookmark is an additional recovery position after successful completion;
it does not mean the database was damaged or restored.
