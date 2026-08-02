# Ad-Supported Availability and Shopping-Bag Badge Plan

## Introduction

The shopping-bag badge currently means that MovieApp found no US subscription
provider for a movie. That produces the wrong customer experience for a movie
that can be watched free with advertisements: the poster displays a shopping
bag even though the customer does not have to rent or purchase that movie.

The proposed correction makes the badge answer this question instead:

> Does the customer have to rent or purchase this movie, or can the customer
> watch it through either a subscription or an ad-supported stream?

This plan stores one synthetic provider relationship for each movie that TMDb
classifies as available with advertisements in the United States. It does not
store the identities of the ad-supported companies because MovieApp will not
offer an ad-supported streamer filter.

The implementation will not add a monetization column to
`movie_watch_providers`, and it will not add a new provider table. It will use
the existing staging and live provider relationship tables.

No production code or database schema is changed by this document.

## 1. Decision Summary

1. Keep every real TMDb US subscription relationship exactly as it works now.
2. Reserve one negative provider ID for the internal “streams with ads” marker.
3. Store no more than one marker per movie and region, even when TMDb lists
   several ad-supported providers.
4. Do not add the marker to the provider lookup table. Therefore, it cannot
   appear as a selectable streamer in Advanced Search.
5. Keep subscription filtering subscription-only by explicitly excluding the
   marker from every “flatrate” query.
6. Add a separate response fact for the badge: the movie is available without
   a separate rental or purchase when either a real subscription row or the
   ad-supported marker exists.
7. Preserve the current weekly schedule. The existing provider refresh remains
   the owner of this changing availability data.
8. Deploy and verify the Worker contract before changing MovieApp to use it.

## 2. Confirmed Current Behavior

The current database and code establish these facts:

- `movie_watch_providers` has the key `(tmdb_id, provider_id, region)`.
- `provider_id` is an integer and is required in the live table.
- Every current live provider row represents US `flatrate` availability.
- `movie_watch_providers_staging` is promoted into the live table only after
  the provider refresh and Movie List safety checks succeed.
- `tmdb_watch_provider_lookup` supplies the actual selectable streamer names.
- Advanced Search's broad subscription filter currently treats the existence
  of any US provider relationship as proof of subscription availability.
- The movie-card endpoint and Title/Advanced Search results currently return
  `available_with_subscription` using the same existence check.
- The weekly provider job currently discovers only movies returned by TMDb's
  US `flatrate` Discover filter.
- The Movie Detail screen obtains the real provider sections from TMDb and does
  not use the relationship table as its provider display list.

The proposed marker fits the existing relationship table, but simply inserting
it would make the broad subscription query incorrect. The query separation in
Parts 6 and 7 is therefore mandatory.

## 3. Synthetic Record Definition

Add one shared Worker constant with an unmistakable internal name:

```text
STREAMS_WITH_ADS_PROVIDER_ID = -1
```

The exact negative value should be declared once and imported wherever it is
needed. It must not be copied as an unexplained number throughout SQL strings.

Example rows for TMDb movie `12345`:

```text
Subscription and ads:
tmdb_id  provider_id  region
12345    8            US       <- real Netflix subscription relationship
12345    -1           US       <- internal streams-with-ads marker

Ads only:
tmdb_id  provider_id  region
12345    -1           US       <- exactly one internal marker
```

Why use a negative ID:

- Real TMDb provider IDs used by the application are positive integers.
- A reserved negative value cannot be selected from TMDb's provider lookup.
- The existing primary key automatically limits the movie to one such marker.
- Repeating the same ad-supported movie on multiple TMDb pages or retrying a
  queue message remains harmless when the insert is idempotent.

Do **not** insert provider `-1` into `tmdb_watch_provider_lookup`. The marker is
an internal availability fact, not a customer-visible streamer.

This marker is different from the staging-only `NULL` provider sentinel. A
`NULL` row means “the movie was checked and no subscription provider was
returned” and is never promoted. Provider `-1` means “TMDb currently reports
US ad-supported availability” and is deliberately promoted.

## 4. Tables Involved

### 4.1 `movie_watch_providers_staging`

The provider refresh first writes one staged `-1` relationship for every US
ads movie:

- `tmdb_id`: TMDb movie ID.
- `provider_id`: `STREAMS_WITH_ADS_PROVIDER_ID` (`-1`).
- `region`: `US`.
- `load_run_id`: the current provider-refresh job ID.
- `is_full_refresh`: `1`.
- `promoted_at`: `NULL` until the Movie List promotion succeeds.

The insert must use the table's existing key as its duplicate guard. Multiple
ad-supported companies still produce one row for the movie.

### 4.2 `movie_watch_providers`

The existing full provider promotion copies the current run's real subscription
rows and synthetic ads rows into this live table. No new column is required.

The full refresh already deletes the prior live US provider set before copying
the successful current staging set. Therefore, an old ads marker disappears
automatically when TMDb no longer returns that movie in the next ads discovery.

### 4.3 `tmdb_us_flatrate_movies_staging`

Keep this table dedicated to real subscription candidates. It continues to
drive the per-movie provider-detail requests needed to learn actual subscription
provider IDs.

Ads candidates do not need their own permanent candidate table because their
company IDs are intentionally discarded. Their synthetic rows can be written
directly to `movie_watch_providers_staging` as the ads Discover pages are read.

### 4.4 `tmdb_watch_provider_lookup`

No synthetic lookup row will be added. This is the main safeguard that keeps
“Streams With Ads” out of Advanced Search's streamer choices.

## 5. Provider Refresh Job

The existing `tmdb-provider-refresh` job remains the only scheduled owner of
the full US availability snapshot.

### 5.1 Keep the current subscription discovery

The first discovery pass remains:

```text
watch_region=US
with_watch_monetization_types=flatrate
```

It continues writing TMDb movie IDs to
`tmdb_us_flatrate_movies_staging`. The queue then calls each candidate movie's
watch-provider endpoint to obtain real subscription provider IDs.

### 5.2 Add a second ads discovery pass

After the subscription candidate discovery completes, run the same protected
date-window process with:

```text
watch_region=US
with_watch_monetization_types=ads
```

TMDb officially supports `ads` as a Discover monetization type when used with
`watch_region`. Because only a yes/no fact is needed, each returned movie ID
immediately stages one `-1` row. The Worker will **not** make an additional
per-movie request to identify the ad-supported companies.

### 5.3 Preserve the existing discovery protections

The ads pass must reuse the current behavior for:

- Release-date windows covering the complete catalog.
- Splitting windows when TMDb's 500-page limit is reached.
- Retry delays and maximum attempts.
- Queue checkpoints and progress timestamps.
- Safe continuation from the exact pass, window, and page after a retry.

The checkpoint must identify whether the job is currently discovering
`flatrate` or `ads`. A retry must never restart a completed pass or mistake ads
rows for subscription candidates.

### 5.4 Queue and completion accounting

Record separate, understandable job results:

- Subscription candidate movies discovered.
- Subscription provider rows staged.
- Ads candidate movies discovered.
- Synthetic ads rows staged.
- Duplicate ads rows ignored or replaced safely.
- Accepted TMDb 404 outcomes.
- Actual errors.

The provider job cannot be marked complete until both discovery passes and all
subscription provider-detail messages complete successfully.

### 5.5 Other provider-writing paths

The normal full refresh is the owner of creating and removing ads markers.
However, the existing partial enrichment path can replace provider staging for
one movie. Its delete/promotion SQL must be reviewed so it cannot accidentally
erase the last successful weekly `-1` marker while updating that movie's real
subscription providers.

The preferred rule is:

- Full provider refresh: may create, replace, or remove the ads marker.
- Partial enrichment: may replace real subscription rows but must preserve the
  last full-refresh ads marker.

This keeps the feature weekly, as requested, without adding daily work or
making every partial enrichment call perform a separate ads discovery.

## 6. Subscription Filtering Must Remain Subscription-Only

After synthetic rows exist, “any US provider row” no longer means “has a
subscription.” Every subscription query must distinguish real provider rows
from provider `-1`.

### 6.1 Broad subscription filter

The `watchMonetizationTypes=flatrate` query must require:

```text
region = 'US'
provider_id <> STREAMS_WITH_ADS_PROVIDER_ID
```

An ads-only movie must not appear in this result.

### 6.2 Selected streamer filters

Provider-specific filters already compare against the positive provider IDs
selected in the app. Keep that behavior and add tests proving the internal
negative marker cannot match.

### 6.3 `available_with_subscription`

If this field remains in a response for compatibility, it must retain its
literal meaning and exclude provider `-1`. It must never be changed to `true`
for an ads-only movie.

## 7. Shopping-Bag Availability Contract

The bag now represents the absence of both subscription and ad-supported
availability. A field named `available_with_subscription` is no longer enough.

Add a separately named response fact. Recommended name:

```text
available_without_rent_or_purchase
```

The Worker calculates it as:

```text
true  when any current US relationship exists
      (a real subscription provider or provider -1)

false when no current US subscription or ads relationship exists
```

MovieApp displays the shopping bag only when this value is `false`.

This is preferable to an API field named `show_shopping_bag` because the Worker
returns a data fact; MovieApp remains responsible for deciding how to display
that fact.

Update both Worker result paths:

1. The movie-card data endpoint used by Favorites and Seen.
2. The Title Search and Advanced Search SELECT statements used for poster
   results.

Keep `available_with_subscription` during a compatibility period so the
currently released app continues to work while the new app version is being
reviewed by the stores.

## 8. Search Cache

The new bag field is part of Title/Advanced Search response JSON and therefore
must be included in search caching.

1. Bump `MOVIE_SEARCH_RESPONSE_VERSION` so cached responses created before the
   new field cannot be reused.
2. Generate `available_without_rent_or_purchase` in the original database
   SELECT; do not make one provider query per returned poster.
3. Keep the normal order: provider refresh, Movie List promotion, Search Cache,
   final weekly validation.
4. For the first rollout, rebuild all Search Cache entries only after the new
   provider relationships have been promoted.

## 9. Indexes and Query Cost

The existing provider filter index remains required:

```text
(region, provider_id, tmdb_id)
```

It supports selected-streamer and subscription-only checks beginning with
region/provider ID.

The existing movie-first index is:

```text
(tmdb_id, region)
```

Before changing indexes, run `EXPLAIN QUERY PLAN` against these production-like
queries:

1. Does this movie have any US relationship for the bag?
2. Does this movie have any real US subscription relationship excluding `-1`?
3. Does this movie match one of the selected real provider IDs?

If excluding `-1` requires the database to return to the table for
`provider_id`, add a covering index:

```text
(tmdb_id, region, provider_id)
```

Do not remove either existing provider index during the initial rollout. Any
index consolidation should be a separate evidence-based cleanup after the new
queries are measured in production.

## 10. MovieApp Changes

After the Worker is deployed and verified:

1. Add `available_without_rent_or_purchase` to the shared movie-card and search
   result types.
2. Update the shared poster card so the shopping bag displays only when the new
   value is explicitly `false`.
3. Use the same rule on Favorites, Seen, Title Search, and Advanced Search.
4. Keep a safe compatibility fallback while older cached/local data lacks the
   new field. An unknown value must not be silently treated as a confirmed
   purchase-only movie.
5. Do not add Ads, Streams With Ads, or provider `-1` to the Advanced Search
   streamer popup.
6. Do not change the Movie Detail provider sections; they continue showing the
   actual TMDb provider information and attribution.

## 11. Safety Counts and Reporting

Provider totals will now contain two kinds of relationship rows. Job output and
support reports must show them separately:

- Real subscription provider relationships.
- Movies carrying the single ads marker.
- Total live provider-table rows.
- Distinct movies with either kind of relationship.

The Movie List safety comparison must continue to protect real subscription
provider data. A large increase from newly added ads markers must not hide an
unexpected drop in real subscription rows.

At minimum, compute the real-provider safety count with `provider_id <> -1` and
record the ads-marker count separately in job `result_json`. Add count-table
columns only if the implementation needs persistent historical comparisons;
no column is needed in either provider relationship table.

## 12. Automated Tests

### 12.1 Provider job tests

- The ads Discover request sends `watch_region=US` and
  `with_watch_monetization_types=ads`.
- Several ad-supported companies for one movie still create one marker.
- A movie available through subscription and ads gets real provider rows plus
  one marker.
- An ads-only movie gets one marker and no fabricated real provider.
- Retrying an ads page does not double-count or duplicate the marker.
- The job resumes the correct monetization pass after a retry.
- The job cannot complete until both discovery passes finish.
- The next successful full refresh removes a marker for a movie that is no
  longer returned as ads-supported.
- A partial enrichment does not erase the last successful full-refresh marker.

### 12.2 Search and endpoint tests

- Ads-only movies do not match `watchMonetizationTypes=flatrate`.
- Ads-only movies do not match a selected real streamer.
- Ads-only movies return
  `available_without_rent_or_purchase=true`.
- Subscription-only movies return the new value as `true`.
- Movies with both return the new value as `true`.
- Movies with neither return the new value as `false`.
- `available_with_subscription` remains `false` for ads-only movies.
- Title Search, Advanced Search, and movie-card data return consistent values.
- An old search-cache response is not reused after the response-version bump.

### 12.3 MovieApp tests

- No shopping bag for subscription-only, ads-only, or both.
- Shopping bag for confirmed movies with neither option.
- Unknown/missing availability does not create a false purchase warning.
- The same behavior appears on Favorites, Seen, Title Search, and Advanced
  Search.

### 12.4 Manual device checks

Verify on both iOS and Android with four known production examples:

1. Subscription only.
2. Ads only.
3. Subscription and ads.
4. Rent/buy only or no current provider.

## 13. Deployment Order

### Phase 1: Worker compatibility deployment

1. Add the marker constant, ads discovery, safe staging/promotion, separated
   subscription SQL, new response field, cache version, and Worker tests.
2. Keep the existing `available_with_subscription` field for released apps.
3. Run TypeScript, the complete Worker test suite, SQL query-plan checks, and a
   Wrangler deployment dry run.
4. Deploy the Worker first.

### Phase 2: Populate and verify production

1. Run the existing provider refresh once.
2. Confirm both discovery passes completed with zero errors.
3. Confirm one ads marker at most per movie and no `-1` lookup row.
4. Run the Movie List build so the successful staging snapshot is promoted.
5. Verify subscription filters exclude ads-only movies.
6. Verify the movie-card and search responses return the new field correctly.
7. Rebuild the Search Cache.
8. Run final weekly validation and confirm the emails were accepted.

### Phase 3: MovieApp deployment

1. Update MovieApp types and the shared poster badge rule.
2. Run the complete MovieApp test suite, TypeScript, lint, and iOS/Android
   device checks.
3. Release the app only after the Worker contract and production ads markers
   have already been verified.

## 14. Acceptance Criteria

The feature is complete only when all of these are true:

- Exactly one live `-1` marker exists per current US ads-supported movie.
- No synthetic provider appears in the provider lookup or streamer filter UI.
- Ads-only movies never satisfy the subscription filter.
- The shopping bag is hidden for subscription-only, ads-only, and combined
  availability.
- The shopping bag appears only for a confirmed movie with neither a US
  subscription nor US ads relationship.
- Weekly refresh removes obsolete ads markers without manual cleanup.
- Search cache contains the same new availability fact as uncached responses.
- All Worker and MovieApp automated tests pass.
- Manual iOS and Android checks pass.

## 15. Explicitly Out of Scope

- No Advanced Search filter for ad-supported services.
- No list of ad-supported company IDs.
- No `rent`, `buy`, or TMDb `free` marker in this change.
- No daily provider job.
- No provider-table monetization column.
- No new provider relationship table.
- No change to the Movie Detail provider presentation or attribution.

## 16. Plain-English Outcome

After this change, the database can answer two separate questions correctly:

```text
Subscription filter:
Does this movie have a real US subscription provider?

Shopping-bag badge:
Can this movie be watched through a US subscription or with advertisements,
without renting or purchasing this individual movie?
```

Keeping those questions separate prevents an internal ads marker from
polluting streamer filters while fixing the shopping-bag experience.
