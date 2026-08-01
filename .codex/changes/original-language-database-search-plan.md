# Original Language Database and Search Plan

## Introduction

This feature will be built as a general original-language system, not an English-only flag. Every movie will retain TMDb’s actual `original_language` code, such as `en`, `ko`, `zh`, `ja`, `hi`, or `pt`.

English will eventually be the mobile app’s default selection, but the database, indexes, endpoints, and caches will support any single language or combination of languages.

The complete data path will be:

```text
TMDb Discover
    → staging table
    → searchable movie table
    → covering indexes
    → Worker search endpoint
    → mobile query cache and filter
```

The Worker/database work will be completed and verified before the mobile app is changed.

## 1. Tables involved

### 1.1 `tmdb_movies_staging`

This is the authoritative TMDb movie-import table.

Add:

```sql
ALTER TABLE tmdb_movies_staging
ADD COLUMN original_language TEXT;
```

Example:

```text
tmdb_id: 1526650
original_language: zh
```

The column remains nullable because existing rows initially lack the value and TMDb may occasionally return missing data.

### 1.2 `movie_list_items`

This is the denormalized table queried by `/movies/search`.

Add:

```sql
ALTER TABLE movie_list_items
ADD COLUMN original_language TEXT;
```

The movie-list build will copy the value from staging:

```sql
tmdb.original_language
```

Searches will operate exclusively against this column, not against staging.

### 1.3 New `tmdb_original_language_lookup`

This table converts TMDb codes into customer-facing names:

```sql
CREATE TABLE tmdb_original_language_lookup (
    language_code TEXT PRIMARY KEY,
    english_name TEXT NOT NULL,
    native_name TEXT,
    is_filter_enabled INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    last_refreshed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Example rows:

| Code | English name | Native name |
|---|---|---|
| `en` | English | English |
| `ko` | Korean | 한국어/조선말 |
| `zh` | Mandarin | 普通话 |
| `cn` | Cantonese | 广州话 / 廣州話 |
| `ja` | Japanese | 日本語 |
| `pt` | Portuguese | Português |
| `hi` | Hindi | हिन्दी |

Names come directly from TMDb’s [`/configuration/languages`](https://developer.themoviedb.org/reference/configuration-languages) endpoint.

The search query will not join this table. It is only for filter choices and display labels.

### 1.4 Existing operational tables

The new jobs will use the existing infrastructure:

- `import_job_runs` records progress, counts, completion, and errors.
- `import_job_locks` prevents overlapping copies of the same job.
- Existing queue tables may be used if the backfill is large enough to require queued chunks.

No language data belongs in those operational tables.

## 2. Database storage rules

`original_language` will store the normalized TMDb value:

```ts
const originalLanguage =
    value?.trim().toLowerCase() || null;
```

Rules:

- Store the real TMDb code.
- Never default missing database values to `en`.
- Never store a boolean such as `is_english`.
- Preserve `xx`, which TMDb uses for “No Language.”
- Store unrecognized but syntactically valid TMDb codes rather than discarding them.
- Use `NULL` only when TMDb provides no usable value.

This keeps the database adaptable if TMDb adds codes later.

## 3. TMDb ingestion changes

The existing TMDb Discover response already contains `original_language`. The Worker currently discards it.

The Worker will be updated to:

1. Add `original_language` to the Discover result type.
2. Normalize it.
3. Add it to the staging `INSERT`.
4. Add it to the `ON CONFLICT ... DO UPDATE`.
5. Include it in every future incremental import.

Conceptually:

```sql
INSERT INTO tmdb_movies_staging (
    tmdb_id,
    title,
    original_language,
    ...
)
VALUES (?, ?, ?, ...)
ON CONFLICT(tmdb_id) DO UPDATE SET
    title = excluded.title,
    original_language = excluded.original_language,
    ...;
```

No extra TMDb request is necessary for newly imported movies.

## 4. Language-name lookup refresh

Add a new TMDb client method:

```http
GET https://api.themoviedb.org/3/configuration/languages
```

Add a refresh job alongside the existing genre and provider lookup refreshers.

The job will:

1. Fetch the complete language list.
2. Normalize every code.
3. Require a nonempty `english_name`.
4. Convert an empty native `name` to `NULL`.
5. Upsert by `language_code`.
6. Record the run in `import_job_runs`.

This is one small configuration request per refresh, not one request per movie.

A monthly refresh is sufficient, with a protected manual endpoint available when needed.

## 5. Existing-catalog backfill

Adding the columns does not populate existing rows, so a dedicated original-language backfill is required.

The backfill will:

1. Use the existing TMDb Discover date-window splitting.
2. Respect TMDb’s maximum discover-page limit.
3. Extract `tmdb_id` and `original_language`.
4. Update matching `tmdb_movies_staging` rows in batches.
5. Save job progress so it can resume safely.
6. Avoid modifying unrelated movie, genre, provider, or enrichment data.
7. Be idempotent, so rerunning it is safe.
8. Leave genuinely unresolved movies as `NULL`.

After staging is backfilled, run the existing chunked movie-list rebuild. That copies the values into `movie_list_items`.

We should not independently backfill both tables from TMDb. Staging is the source of truth; `movie_list_items` is rebuilt from staging.

After the main pass, audit remaining null rows. If only a small residual remains, a controlled TMDb movie-details fallback can populate those IDs without making a detail request for the entire catalog.

## 6. Composite covering indexes

We need two kinds of search path:

1. “All languages,” with no language restriction.
2. Language-filtered searches, usually English.

Adding `original_language` only to the end of an index would make it available inside the index, but would still scan movies from every language. Therefore, language-filtered searches need language-first indexes.

### 6.1 All-language popularity index

```sql
CREATE INDEX idx_movie_search_all_popularity_v2
ON movie_list_items (
    popularity DESC,
    tmdb_id,
    release_date,
    poster_path,
    imdb_rating,
    imdb_vote_count,
    us_certification,
    original_language
);
```

### 6.2 All-language IMDb index

```sql
CREATE INDEX idx_movie_search_all_imdb_v2
ON movie_list_items (
    imdb_rating DESC,
    imdb_vote_count DESC,
    tmdb_id,
    release_date,
    poster_path,
    popularity,
    us_certification,
    original_language
);
```

### 6.3 Language-filtered popularity index

```sql
CREATE INDEX idx_movie_search_language_popularity_v2
ON movie_list_items (
    original_language,
    popularity DESC,
    tmdb_id,
    release_date,
    poster_path,
    imdb_rating,
    imdb_vote_count,
    us_certification
);
```

### 6.4 Language-filtered IMDb index

```sql
CREATE INDEX idx_movie_search_language_imdb_v2
ON movie_list_items (
    original_language,
    imdb_rating DESC,
    imdb_vote_count DESC,
    tmdb_id,
    release_date,
    poster_path,
    popularity,
    us_certification
);
```

These proposed indexes contain every `movie_list_items` field currently referenced by the search query. The goal is for D1 to satisfy the core movie search from the index without returning to the main table for language, date, poster, rating, certification, cursor, or sort values.

Genre and provider filters will continue using their separate relationship indexes.

No separate index on only `original_language` is initially necessary because the two language-first indexes already use it as their leading column.

## 7. Search-index selection

The Worker will choose the index according to the submitted search:

| Languages | Sort | Index |
|---|---|---|
| None/All | Popularity | `idx_movie_search_all_popularity_v2` |
| None/All | IMDb | `idx_movie_search_all_imdb_v2` |
| One language | Popularity | `idx_movie_search_language_popularity_v2` |
| One language | IMDb | `idx_movie_search_language_imdb_v2` |

For example:

```sql
AND movie.original_language = 'en'
```

or:

```sql
AND movie.original_language = 'ko'
```

For multiple languages:

```sql
AND movie.original_language IN ('ko', 'ja')
```

SQLite may perform multiple index seeks and merge/sort the results for an `IN` query. We will benchmark whether the language-first or all-language index performs better for multiple selections.

## 8. Worker endpoints

### 8.1 Existing search endpoint

Extend:

```http
GET /movies/search
```

Recommended query parameter:

```text
originalLanguages=en
```

Multiple languages:

```text
originalLanguages=en,ko,ja
```

Rules:

- Missing parameter means all languages.
- One code produces `= ?`.
- Multiple codes produce `IN (?, ?, ...)`.
- Codes are lowercased, deduplicated, and sorted.
- Null movies do not match a selected language.
- The response returns the real `original_language`.

Examples:

```http
GET /movies/search?originalLanguages=en&sort=popularity
GET /movies/search?originalLanguages=ko&sort=imdb
GET /movies/search?originalLanguages=ko,ja&sort=popularity
```

### 8.2 New language-options endpoint

Add:

```http
GET /movies/languages
```

It returns the enabled lookup rows:

```json
[
  {
    "languageCode": "en",
    "englishName": "English",
    "nativeName": "English"
  },
  {
    "languageCode": "ko",
    "englishName": "Korean",
    "nativeName": "한국어/조선말"
  }
]
```

This endpoint will be heavily cached because the list changes infrequently.

### 8.3 New protected language-refresh endpoint

Add:

```http
POST /admin/import/tmdb/language-lookup-refresh-manual
```

This refreshes the language-name lookup table from TMDb.

### 8.4 New protected backfill endpoint

Add:

```http
POST /admin/import/tmdb/original-language-backfill-manual
```

This starts or resumes the existing-catalog backfill.

Progress will be visible through the existing job-run endpoint using a job name such as:

```text
tmdb-original-language-backfill
```

### 8.5 Existing endpoints that change internally

These retain their current public contracts but gain language persistence:

- TMDb primary import endpoints.
- Movie-list rebuild endpoint.
- Search cache-warming endpoint.

## 9. Query and HTTP caching

Although the mobile implementation comes later, the Worker cache contract must be correct immediately.

The selected languages must be included in the cache identity:

```text
originalLanguages=en
originalLanguages=ko
originalLanguages=en,ko
```

Codes will be sorted before constructing the canonical cache key:

```text
ko,en → en,ko
```

That prevents duplicate cache entries for the same selection.

English can be the default and the primary prewarmed cache variant. However, other languages cannot share the English cache entry; that would return incorrect results.

Later, the React Query key in the mobile app must also include the normalized language selection.

## 10. Index creation and deployment safety

The Worker currently forces specific indexes with `INDEXED BY`. Therefore, indexes and code must be deployed in the correct order.

Recommended staged migrations:

### Migration 0022

- Add both `original_language` columns.
- Create `tmdb_original_language_lookup`.

### Worker deployment A

- Persist new TMDb values.
- Add lookup refresh.
- Add backfill.
- Update movie-list promotion.
- Do not yet make search depend on new index names.

### Data operation

- Refresh language lookup.
- Backfill staging.
- Rebuild `movie_list_items`.
- Verify coverage.

### Migration 0023

- Create the four new `v2` covering indexes.
- Do not drop the old forced indexes yet.

### Worker deployment B

- Add language query parsing.
- Switch search queries to the appropriate new index.
- Add `/movies/languages`.
- Update cache identity and warming.

### Migration 0024

- Drop superseded search indexes only after live verification.

This avoids a period in which deployed Worker code references an index that does not exist.

## 11. Database and endpoint validation

### 11.1 Data checks

Run:

```sql
SELECT original_language, COUNT(*)
FROM tmdb_movies_staging
GROUP BY original_language
ORDER BY COUNT(*) DESC;
```

And:

```sql
SELECT original_language, COUNT(*)
FROM movie_list_items
GROUP BY original_language
ORDER BY COUNT(*) DESC;
```

Also verify:

```sql
SELECT COUNT(*)
FROM movie_list_items
WHERE original_language IS NULL;
```

Spot checks include:

- Mudborn is `zh`.
- Known Korean movies are `ko`.
- Known Japanese movies are `ja`.
- Known English movies are `en`.
- `xx` remains “No Language,” not null or English.

### 11.2 Index checks

Use `EXPLAIN QUERY PLAN` for:

- English + popularity.
- English + IMDb.
- Korean + popularity.
- Mandarin + IMDb.
- Multiple languages.
- All languages.
- Cursor pagination.
- Date, certification, genre, and provider combinations.

The plan should report the intended covering index and avoid a separate `movie_list_items` table read.

### 11.3 Production measurements

Compare:

- D1 `rows_read`.
- Execution duration.
- Temporary sorting.
- First-page and cursor-page performance.
- Index storage growth.
- Backfill write volume.

The exact final column order will be accepted only after these measurements confirm that it performs as intended.

## 12. Final rollout order

1. Implement and test schema-compatible Worker changes.
2. Apply migration 0022.
3. Deploy ingestion, lookup, and backfill support.
4. Refresh the language lookup.
5. Backfill staging.
6. Rebuild the searchable movie table.
7. Audit null and language distributions.
8. Apply migration 0023 with the new indexes.
9. Verify query plans and performance.
10. Deploy the language-aware search and lookup endpoints.
11. Verify live searches and caching.
12. Drop obsolete indexes with migration 0024.
13. Only then begin the mobile filter and English-default work.

No database, Worker, or application changes have been made yet.

## Questions Regarding the Plan Numbers

The answers below clarify Sections 5 and 10. The Section 5 answer also adds a stricter production-safety requirement: the historical backfill will update only the new `original_language` column instead of replacing complete existing movie rows.

### Question 5: Is there any risk of ruining data already stored for older movies?

> Is there any risk of ruining any data we already have in the old movies, how would you be able to use something we already have, without risking the data we already have for the old movies?

There is always some risk whenever production data is changed, but this work can be designed so that the existing movie data is neither replaced nor recalculated.

The stable value we already have is `tmdb_id`. The same TMDb ID appears in the existing database and in every TMDb Discover result. The backfill uses that ID only to locate the existing row, then changes only the new `original_language` column.

For example, the staging update will have this narrow shape:

```sql
UPDATE tmdb_movies_staging
SET original_language = ?
WHERE tmdb_id = ?;
```

It will not update `title`, `poster_path`, `release_date`, `us_certification`, `popularity`, enrichment timestamps, or error fields.

After staging is populated, the initial historical copy into the searchable table will also be a narrow update:

```sql
UPDATE movie_list_items
SET original_language = (
    SELECT staging.original_language
    FROM tmdb_movies_staging AS staging
    WHERE staging.tmdb_id = movie_list_items.tmdb_id
)
WHERE tmdb_id > ?
  AND tmdb_id <= ?
  AND EXISTS (
      SELECT 1
      FROM tmdb_movies_staging AS staging
      WHERE staging.tmdb_id = movie_list_items.tmdb_id
        AND staging.original_language IS NOT NULL
  );
```

The two ID boundaries make the operation a manageable batch. Only `movie_list_items.original_language` changes. The initial historical backfill will not use `INSERT OR REPLACE` to rewrite complete `movie_list_items` rows merely to populate this one new field.

Future normal movie-list builds will include `original_language` in their existing full-row promotion because that is how newly imported or ordinarily refreshed movies are already produced. That normal pipeline change is separate from the one-time historical backfill.

#### Production safeguards before changing any row

1. Confirm that the D1 database uses the production storage backend and retrieve its current Time Travel bookmark.
2. Export the production database to a dated SQL file before the migration and retain it until verification is complete.
3. Record row counts, minimum and maximum TMDb IDs, and non-null counts for the existing important columns in both movie tables.
4. Apply the schema migration first. Adding a nullable column does not delete or replace existing movie values; old rows simply receive `NULL` for the new column.
5. Test the backfill against a local database created from the production export.
6. Run a deliberately small production batch and verify it before allowing the next batch.
7. Put an expected-update ceiling on every batch. If a batch attempts to change more rows than expected, stop the job.
8. After every batch, record selected, updated, skipped, and failed counts in `import_job_runs`.
9. Compare the original row counts and existing-column measurements after the backfill. They must remain unchanged.
10. Verify a sample of English, Korean, Japanese, Mandarin, no-language, and unresolved rows before marking the job complete.

Cloudflare D1 Time Travel provides point-in-time recovery for production-backend databases. A bookmark gives us a precise pre-change restore point. A full SQL export provides a second independent copy that can also be loaded locally for rehearsal. See Cloudflare’s [Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) and [D1 export documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

The normal rollback for a language-only mistake would be even smaller than restoring the database: clear or correct only the new `original_language` values and rerun the backfill. A full Time Travel restoration is reserved for an actual wider database problem because it would also roll back legitimate writes that occurred after the bookmark.

### Question 10: What does forced index selection mean?

> What does this mean “The Worker currently forces specific indexes with `INDEXED BY`. Therefore, indexes and code must be deployed in the correct order.”

The current search SQL contains an instruction shaped like this:

```sql
FROM movie_list_items AS movie
INDEXED BY idx_movie_list_items_search_popularity_date_cover
```

`INDEXED BY` tells SQLite/D1 that it must use that specifically named index. It is stronger than a suggestion. If deployed Worker code names a new index before that index exists in production, the query fails instead of allowing D1 to choose a different index.

That is why the safe order is:

1. Create the new indexes while the current Worker still uses the current indexes.
2. Confirm the new indexes exist and their query plans are correct.
3. Deploy the Worker code that names the new indexes.
4. Verify live searches.
5. Only then remove indexes that no deployed code uses.

### Question 10 continued: Are the indexes for searches without a language being removed?

> Are you getting rid of the other indexes where the language is at the end, that makes no sense, what if a query is sent without a language?????

No. The two all-language indexes where `original_language` is at the end will remain. They are required for searches that do not provide a language.

The final production design intentionally retains four search indexes:

| Search type | Popularity index | IMDb index |
|---|---|---|
| No language / All languages | `idx_movie_search_all_popularity_v2` | `idx_movie_search_all_imdb_v2` |
| Language supplied | `idx_movie_search_language_popularity_v2` | `idx_movie_search_language_imdb_v2` |

For a query without a language:

```http
GET /movies/search?sort=popularity
```

the Worker uses:

```text
idx_movie_search_all_popularity_v2
```

That index begins with `popularity`, so it can scan the requested sort order across every language. `original_language` appears at the end so it remains available inside the covering index if the endpoint returns it, but it does not restrict the search.

For a query with a language:

```http
GET /movies/search?originalLanguages=ko&sort=popularity
```

the Worker uses:

```text
idx_movie_search_language_popularity_v2
```

That index begins with `original_language`, allowing D1 to enter the Korean portion of the index directly and then read it in popularity order.

The phrase “drop superseded search indexes” in Sections 10 and 12 refers only to the current pre-language indexes after the new all-language indexes have replaced them and after no deployed Worker still references their names. It does not refer to dropping the new all-language indexes.

To remove ambiguity, the index lifecycle is:

1. Keep the two current pre-language indexes.
2. Add the two new all-language `v2` indexes.
3. Add the two new language-first `v2` indexes.
4. Switch the Worker to choose among the four `v2` indexes.
5. Verify both searches with a language and searches without a language.
6. Drop only the two superseded pre-language indexes.
7. Permanently retain all four `v2` indexes unless later production measurements justify another documented design.

Therefore, `All` and `Clear all` remain fully supported. Omitting `originalLanguages` means no language predicate is added, and the Worker selects the appropriate all-language index.

---

# Implementation results

This appendix records what was actually implemented and verified after the plan
above was approved. It is intentionally separate from the original plan so the
planned design, the user’s questions, and the final production evidence remain
easy to compare.

## 1. Tables and migrations

Three production D1 migrations were applied to `movieapp-db`:

1. `0022_add_original_language.sql`
   - Added nullable `original_language TEXT` to
     `tmdb_movies_staging`.
   - Added nullable `original_language TEXT` to `movie_list_items`.
   - Created `tmdb_original_language_lookup` for TMDb code-to-name
     translations.
2. `0023_add_original_language_search_indexes.sql`
   - Added the four covering search indexes described below.
3. `0024_drop_superseded_forced_search_indexes.sql`
   - Removed only the two pre-language indexes that the old deployed Worker
     forced with `INDEXED BY`.
   - Did not remove any general-purpose, maintenance, or new all-language
     index.

All historical rows survived the migration. The row counts before and after
the work are identical:

| Table | Rows before | Rows after |
|---|---:|---:|
| `tmdb_movies_staging` | 1,019,622 | 1,019,622 |
| `movie_list_items` | 815,404 | 815,404 |

The migrations added fields and indexes; they did not recreate either movie
table.

## 2. Historical data protection and recovery evidence

Before changing production data, a complete SQL export was created:

```text
/Users/croncallo/repo/movieapp-cloudflare/artifacts/original-language/movieapp-db-before-original-language-2026-07-30.sql
```

The export is 1.7 GB. Its SHA-256 checksum is:

```text
9890c492b5dbc3d3caa4811f3310035cc468e76152bd38d247e13f87cc0eb7a2
```

The production D1 Time Travel bookmarks recorded before the two major database
phases are:

```text
Before migration 0022:
00000491-00000000-000050b9-b66317cf04b65054a3979ca33bd4997c

Before the covering-index migration:
00000493-000000e8-000050b9-30fa9c020ec2b3961d07169668793be6
```

The historical backfill used narrow `UPDATE` statements that changed only
`original_language`. It did not use `INSERT OR REPLACE`, did not rewrite
complete movie rows, and placed a maximum-change ceiling on every D1 statement.
If D1 had reported more changed rows than the supplied TMDb IDs, the job would
have stopped.

This is the concrete answer to the plan’s data-risk question: the existing
movie rows were used by their TMDb IDs, only the new nullable column was
updated, unchanged row counts were verified, and both a full export and precise
D1 restore points exist.

## 3. Original-language import and persistence

The Worker now retains TMDb’s existing `original_language` property throughout
the normal data path:

```text
TMDb response
  -> tmdbClient.ts
  -> tmdbPrimary.ts
  -> tmdb_movies_staging.original_language
  -> movieListBuild.ts
  -> movie_list_items.original_language
  -> /movies/search response
  -> MovieApp movie.original_language
```

This means newly imported or ordinarily rebuilt movies no longer discard the
property. The database stores TMDb’s two- or three-letter language code, such
as `en`, `ko`, `ja`, or `zh`; it does not store an inferred subtitle flag.

## 4. Historical backfill

The main production backfill was resumable and date-windowed. It fetched TMDb
Discover pages concurrently, updated small ID batches, and recorded its job
progress.

Main backfill result:

| Measurement | Result |
|---|---:|
| TMDb rows examined | 1,041,541 |
| Discover pages processed | 52,301 |
| `tmdb_movies_staging` rows updated | 1,014,035 |
| `movie_list_items` rows updated | 810,843 |
| Job errors | 0 |
| Elapsed time | 50 minutes 25.591 seconds |

The residual job then examined only the IDs still missing a language by calling
TMDb’s individual `/movie/{id}` endpoint:

| Residual measurement | Result |
|---|---:|
| Remaining IDs examined | 5,587 |
| Additional languages recovered | 1,719 |
| TMDb-not-found IDs retained as `NULL` | 3,868 |
| Job errors | 0 |

The residual process does not invent a language. A confirmed TMDb 404 remains
`NULL`, which is safer than incorrectly classifying a movie as English.

Final production coverage:

| Table | With language | Total rows | Remaining `NULL` |
|---|---:|---:|---:|
| `tmdb_movies_staging` | 1,015,754 | 1,019,622 | 3,868 |
| `movie_list_items` | 812,283 | 815,404 | 3,121 |

The example movie Mudborn, TMDb ID `1526650`, is stored as `zh` in both tables.

## 5. English language names

The Worker refreshes `tmdb_original_language_lookup` from TMDb’s
`/configuration/languages` endpoint.

Production currently contains 187 language codes, and all 187 have an English
display name. The public endpoint is:

```http
GET /movies/languages
```

Its response is shaped as:

```json
{
  "languages": [
    {
      "code": "ko",
      "englishName": "Korean",
      "nativeName": "한국어/조선말"
    }
  ]
}
```

Movie searches do not join this lookup table. The mobile app downloads and
caches the small lookup response for its filter labels, while the search query
uses only the stored language code and its covering index.

## 6. Search endpoint

`GET /movies/search` now accepts:

```http
originalLanguages=en
originalLanguages=ko
originalLanguages=ja,ko
```

Behavior:

- One code uses `movie.original_language = ?`.
- Multiple codes use `movie.original_language IN (?, ...)`.
- Codes are trimmed, lowercased, deduplicated, sorted, and validated.
- Only two- or three-letter alphabetic codes are accepted.
- Omitting `originalLanguages`, or clearing the mobile selection, means no
  language restriction.
- Every returned movie includes `original_language`.

Live production checks proved:

- An English request returns only `en`.
- A Korean request returns only `ko`.
- A `ko,ja` request is normalized to `ja,ko`.
- Mudborn appears in a matching `zh` search and is absent from the equivalent
  `en` search.
- The same no-language request used before this feature still returns results.

## 7. Covering indexes

The four final production indexes are:

| Search shape | Production index |
|---|---|
| All languages, popularity sort | `idx_movie_list_items_search_popularity_v2_cover` |
| All languages, IMDb sort | `idx_movie_list_items_search_imdb_v2_cover` |
| Language supplied, popularity sort | `idx_movie_list_items_language_popularity_v2_cover` |
| Language supplied, IMDb sort | `idx_movie_list_items_language_imdb_v2_cover` |

The two all-language indexes keep `original_language` at the end. They still
serve requests without a language predicate while covering the returned
column, so D1 does not need the main table merely to retrieve that value.

The two language-filtered indexes begin with `original_language`, allowing D1
to seek directly into a language range before following the requested sort.

Production `EXPLAIN QUERY PLAN` checks reported `COVERING INDEX` for all four
search shapes. First-page measurements were:

| Query | Rows read | D1 SQL time |
|---|---:|---:|
| All-language popularity | 21 | 0.9134 ms |
| English popularity | 21 | 0.1855 ms |
| Korean IMDb | 49 | 0.2034 ms |
| Korean and Japanese | 123 | 0.2528 ms |

The multi-language query uses the language-first covering index and an expected
temporary merge/order step to combine two language ranges into one global sort.

Only these two superseded forced indexes were removed:

```text
idx_movie_list_items_search_popularity_date_cover
idx_movie_list_items_search_imdb_date_cover
```

The four `v2` indexes are present in production, and the two names above are
absent. Both filtered and unfiltered live searches still return HTTP 200 after
the removal.

This is the concrete answer to the plan’s `INDEXED BY` question: the new
indexes were created first, the Worker was then deployed to force their exact
names, both query paths were verified, and only afterward were the two names
that no deployed code used removed.

## 8. Cache behavior

The Worker cache key includes the normalized language selection. These URLs
therefore cannot share cached results:

```http
/movies/search?originalLanguages=en
/movies/search?originalLanguages=ko
/movies/search
```

Code order, code case, and URL parameter order do not fragment the cache.
For example, `originalLanguages=KO,ja` and `originalLanguages=ja,ko` resolve to
the same canonical cache entry.

Live production verification showed a cache miss on the first canonical
multi-language request and a cache hit when the same logical request was sent
with reversed code and parameter order.

The standard search-cache warming matrix now adds
`originalLanguages=en`, matching the mobile app’s customer default. The
all-language and non-English combinations remain demand-cached.

The complete production English warm finished successfully:

| Measurement | Result |
|---|---:|
| Job run | `cache-warm-search-manual-1785463650722-d7ca3e42-776f-47ba-a27d-81674db310a9` |
| Search combinations processed | 3,024 of 3,024 |
| Result pages warmed | 5,724 |
| Errors | 0 |
| Started | 2026-07-31 02:07:30 UTC |
| Completed | 2026-07-31 02:43:50 UTC |
| Duration | 36 minutes 20 seconds |

## 9. Mobile application

Advanced Search now:

- Defaults a fresh search to English.
- Shows an “Original Language” filter.
- Loads all English language names from `/movies/languages`.
- Allows one language, multiple languages, “Add All,” “Clear All,” and
  “All Languages.”
- Clearly shows “All Languages” when no restriction is active.
- Sends normalized codes to the Worker.
- Includes the normalized selection in its TanStack Query cache key.
- Preserves `original_language` from every Worker movie result.
- Keeps the existing Home preset ordering: displayed filters converge, two
  animation frames paint them, and submission remains the final action.

## 10. Automated verification

Worker verification:

```text
TypeScript: passed
Vitest: 5 files, 43 tests passed
git diff --check: passed
```

MovieApp verification:

```text
TypeScript: passed
Jest: 24 suites, 77 tests passed
ESLint quiet run: passed
git diff --check: passed
```

Regression coverage includes:

- Default-English configuration.
- Language normalization and deduplication.
- Equivalent cache keys for equivalent selections.
- `originalLanguages=en` in the Advanced Search request URL.
- Preservation of a returned `original_language`.
- Existing Advanced Search submit, swipe, refresh, and Home-preset timing.

## 11. iPhone 17 Pro Max simulator verification

The feature was exercised in the iOS 26.5 iPhone 17 Pro Max simulator:

1. A fresh app launch displayed `Original Language > English`.
2. The modal loaded the complete English-name list and scrolled through the
   chip layout without clipping or overlap.
3. English was cleared and Korean was selected.
4. The filter summary changed to `Korean`.
5. Submitting displayed a full Korean result grid.
6. The corresponding live Worker page contained 20 movies, and the only
   returned language code was `ko`.
7. “All Languages” was selected and visibly highlighted.
8. The filter summary displayed `All Languages`, and an unrestricted search
   returned a full result grid.
9. Restarting the app restored the English default.
10. Opening Home’s Popular Movies preset painted `Popularity` and `English`
    before its automatic submission, then displayed results.

## 12. Production deployment state

The live Worker deployment that enabled language filtering is:

```text
5bc596f0-c9d7-401a-9643-48f6d54ba311
```

Production migration state:

```text
0022 applied
0023 applied
0024 applied
```

The Worker feature gate `ORIGINAL_LANGUAGE_SEARCH_ENABLED` is enabled. The
database, endpoint, covering indexes, cache-key isolation, English cache-warm
configuration, and mobile implementation are all in place.

The final Worker also uses the retained all-language `v2` indexes for
unfiltered searches even if the feature gate is later disabled. Disabling the
gate still rejects a supplied language filter, but it no longer points ordinary
searches at the two retired index names.
