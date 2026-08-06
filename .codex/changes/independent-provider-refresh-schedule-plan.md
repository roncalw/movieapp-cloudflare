# Independent Provider Availability Refresh Plan

> Implementation status: Implemented, tested, and deployed on August 5, 2026.
> The first automatically scheduled independent provider cycle is Thursday,
> August 6, 2026 at 3:00 PM Eastern and still requires first-run monitoring.

## Introduction

MovieApp's provider availability changes often enough that it should not wait
for the complete weekly movie-data pipeline. The provider workflow will become
an independent process that runs Tuesday, Thursday, and Saturday at 3:00 PM
Eastern time.

The later afternoon time gives JustWatch and TMDb additional time to synchronize
provider changes published earlier in the week. Neither company publishes a
guaranteed synchronization hour, so 3:00 PM is a practical delay rather than a
guarantee that every upstream change has arrived.

The independent process must do more than start the existing Provider Refresh.
Today, Provider Refresh downloads rows into staging, but the weekly Movie List
job later applies those rows to the live provider table. Search cache warming
also waits for the weekly Movie List. Moving only the existing cron would leave
new provider data in staging, continue serving old cached availability, and
cause the weekly Movie List dependency check to expect a provider run that no
longer belongs to that pipeline.

The completed design therefore treats the following sequence as one provider
availability cycle:

```text
Provider Refresh
    -> Validate the completed staging snapshot
    -> Apply that exact snapshot to the live provider table
    -> Start a new provider-aware search-cache generation
    -> Warm the configured search cache
    -> Validate the complete independent provider cycle
    -> Send a clearly labeled success or failure email
```

## 1. Final Scheduling Decision

### 1.1 Independent provider schedule

Run Provider Refresh on:

1. Tuesday at 3:00 PM Eastern.
2. Thursday at 3:00 PM Eastern.
3. Saturday at 3:00 PM Eastern.

Cloudflare Cron Triggers use UTC. The implementation must keep the intended
New York time through daylight-saving changes rather than silently moving the
job by one local hour. The scheduled handler will recognize the applicable UTC
triggers and start the provider cycle only when the scheduled time represents
3:00 PM in `America/New_York` on Tuesday, Thursday, or Saturday.

Only Provider Refresh needs a clock-based trigger. Provider application, cache
warming, and final provider validation must start from the actual successful
completion of the preceding step. Fixed follow-up cron times would be unsafe
because a slow or retried refresh could still be running when the next clock
time arrived.

### 1.2 Corrected weekly schedule

Removing the old Sunday Provider Refresh slot saves approximately two hours in
the weekly pipeline. Move every later weekly job two hours earlier while
preserving the existing safety gaps:

| Job | Current Eastern time | New Eastern time |
|---|---:|---:|
| IMDb Ratings | Saturday 9:00 PM | No change |
| TMDb Primary Movies | Saturday 11:00 PM | No change |
| TMDb New Movie Details | Sunday 1:00 AM | No change |
| Provider Refresh | Sunday 3:00 AM | Removed from the weekly pipeline |
| TMDb Popularity | Sunday 5:00 AM | Sunday 3:00 AM |
| Movie List Build | Sunday 8:00 AM | Sunday 6:00 AM |
| Search Cache Warming | Sunday 9:00 AM | Sunday 7:00 AM |
| Final Weekly Validation | Sunday 11:00 AM | Sunday 9:00 AM |

The weekly cache warm remains necessary. The independent provider cache warm
updates availability and provider-filter answers. The weekly cache warm later
updates results affected by new movies, IMDb values, popularity, genres, and
other weekly movie information.

## 2. Why Code Changes Are Required

The existing `tmdb-provider-refresh` implementation can still perform the
download. It cannot become independent through a cron edit alone because the
current code has these connections to the weekly pipeline:

1. Provider Refresh originally required same-day TMDb Primary and, when new
   movies existed, New Movie Details jobs. Those requirements cannot be met by
   an independent Tuesday or Thursday run and have been removed from Provider
   Refresh.
2. Provider Refresh finishes after writing its completed snapshot to staging.
3. Movie List Build requires a same-pipeline-date Provider Refresh.
4. Movie List Build applies the staged provider snapshot to
   `movie_watch_providers`.
5. Movie List's potential-load safety check compares live providers with the
   provider staging snapshot.
6. Search cache generation changes only after a successful Movie List build.
7. Scheduled cache warming requires a recent same-date Movie List build.
8. Final Weekly Validation requires Provider Refresh and Provider Apply records.

Without code changes, a Tuesday Provider Refresh would not immediately change
what customers see, its cache warm could not run independently, and the next
weekly Movie List could be blocked by the removed provider dependency.

## 3. Independent Provider Cycle

### 3.1 Start and download

The Tuesday, Thursday, and Saturday trigger starts the existing full US
provider download. Preserve its current behavior:

- Discover US subscription movies.
- Discover US ad-supported movies.
- Retrieve the actual subscription providers for the selected movies.
- Store subscription relationships and one internal ads marker per applicable
  movie in `movie_watch_providers_staging`.
- Keep all rows tied to the exact Provider Refresh job-run ID.

### 3.2 Validate before changing live data

Before applying anything, require the Provider Refresh to be complete with:

- Zero recorded errors.
- Every selected movie processed.
- No unfinished provider queue messages.
- A usable, nonempty full-refresh staging snapshot.
- Safety counts within the established provider decrease thresholds.

If any requirement fails, leave the current live provider table and its current
cache generation untouched. Record the failure and send a failure email.

### 3.3 Apply the exact completed snapshot

After validation succeeds, apply only the staging rows whose `load_run_id`
equals the exact completed Provider Refresh job-run ID. Replace the live US
provider snapshot in `movie_watch_providers`, mark only that run's staging rows
as applied, and clean older completed full-refresh staging rows through the
existing bounded cleanup design.

The independent cycle will reuse the existing
`movie-watch-providers-promote` job record. No new provider table or provider
column is required.

### 3.4 Change the cache generation

Advanced Search responses contain provider filters and the
subscription-or-ads availability answer used by the shopping-bag badge. Their
cache identity currently changes only when Movie List Build completes.

Add the latest successful provider-application job-run ID to the internal
search-cache generation. After provider application succeeds, requests must use
a new internal cache key even though the public application URL remains the
same. Existing cached responses then cannot hide the new provider snapshot.

### 3.5 Warm the search cache

Start the configured all-genres cache warm immediately after the successful
provider application. This provider-triggered cache warm must depend on that
exact provider-application run rather than requiring a same-date Movie List
build.

The existing weekly cache-warm path will retain its Movie List dependency. The
two triggers have different reasons and must record which source caused them:

- `provider-refresh`: provider availability changed.
- `weekly-movie-list`: the weekly Movie List changed.

### 3.6 Validate and notify

After cache warming completes, validate the complete provider cycle:

1. Provider Refresh completed without errors.
2. Provider Apply used the exact Provider Refresh run.
3. Live provider counts match that completed staging snapshot.
4. Cache warming completed all selected combinations without errors.
5. No provider-cycle job or queue record remains incorrectly `queued` or
   `running`.

Send an email whose subject makes the result immediately recognizable, such as:

```text
SUCCESS - Provider Availability Refresh
FAILURE - Provider Availability Refresh
```

## 4. Remove Provider Ownership From the Weekly Pipeline

The weekly pipeline that begins Saturday night will no longer own provider
availability.

1. Remove `tmdb-provider-refresh` from Movie List's same-date dependency list.
2. Remove provider application from Movie List Build.
3. Remove staged-provider comparisons from Movie List's potential-load safety
   decision. Existing live provider rows remain available to MovieApp; the
   weekly build simply stops owning their replacement.
4. Remove Provider Refresh and Provider Apply from the jobs required by Final
   Weekly Validation.
5. Do not let an old, failed, or active independent Provider Refresh block the
   weekly Movie List.
6. Keep the weekly cache warm and its Movie List dependency.

The independent provider validator becomes responsible for provider failures,
stalled provider records, provider counts, and provider-specific notifications.

## 5. Saturday Separation

The most recent production durations provide this approximate Saturday flow:

| Approximate Eastern time | Independent provider action |
|---|---|
| 3:00 PM | Provider Refresh starts |
| 4:33 PM | Provider Refresh completes |
| 4:34 PM | Completed snapshot is applied to the live table |
| 4:34 PM | Provider-triggered cache warming starts |
| 5:27 PM | Cache warming completes |
| 5:28 PM | Provider validation and notification complete |
| 9:00 PM | Separate weekly pipeline begins |

This normally leaves approximately three and one-half hours between the
independent provider cycle and weekly job night. A provider failure must be
contained and reported by the independent provider workflow; it must not become
a weekly-pipeline dependency.

## 6. Implemented Code Areas

Implementation affects these Worker areas:

1. `wrangler.jsonc`
   - Add the Tuesday, Thursday, and Saturday provider triggers.
   - Remove the old weekly provider trigger.
   - Move the later weekly triggers two hours earlier.
2. `scripts/syncScheduledCrons.mjs` and generated cron configuration
   - Stop assuming the old eight-job weekly-only order.
   - Represent the independent provider schedule clearly.
3. `src/jobs/scheduled.ts`
   - Route the new provider triggers.
   - Preserve the weekly job routing with the corrected times.
4. Provider completion and relationship-application code
   - Start provider application only after the exact refresh succeeds.
   - Start cache warming only after the exact application succeeds.
5. `src/httpRouting/movieSearch.ts`
   - Include the latest successful provider application in cache generation.
6. Cache-warm job code
   - Support a provider-triggered dependency path without weakening the weekly
     Movie List dependency.
7. `src/imports/movieListBuild.ts`
   - Remove Provider Refresh dependency and provider application.
8. `src/imports/movieListLoadCounts.ts`
   - Remove provider staging from the weekly potential-load stop decision.
9. `src/jobs/weeklyImportValidation.ts`
   - Remove provider jobs from weekly requirements.
10. Provider-cycle validation and notification code
    - Verify and report the independent sequence.
11. Automated tests
    - Cover both the independent provider cycle and the provider-free weekly
      pipeline.

The implementation also removed Provider Refresh's same-day dependency on
TMDb Primary and New Movie Details. Provider Refresh builds its own complete
candidate set directly from TMDb, so requiring those weekly jobs would have
prevented the Tuesday and Thursday schedules from starting.

## 7. Database and Mobile-App Scope

The completed local implementation requires:

- No new D1 table.
- No new provider column.
- No database migration.
- No MovieApp mobile-code change.
- No change to the stored subscription relationships or internal ads marker.
- No change to the existing TMDb provider-download batching and rate limiter.

These scope boundaries were confirmed during implementation.

## 8. Verification Plan

Before deployment:

1. Run formatting and TypeScript checks. **Complete.**
2. Run all automated Worker tests. **Complete: 95 tests pass.**
3. Test both Eastern daylight and standard-time cron routing. **Complete.**
4. Test that Provider Refresh starts without same-day weekly TMDb jobs.
   **Complete.**
5. Test that only the exact completed Provider Refresh snapshot can be applied.
   **Complete.**
6. Test that empty or unexpectedly reduced snapshots cannot replace live data.
   **Complete.**
7. Test a successful provider sequence through cache completion. **Complete
   using an isolated local D1 database and the real replacement SQL.**
8. Test a failed refresh and confirm that live provider data and cache
   generation remain unchanged. **Complete.**
9. Test a failed provider application and confirm cache warming does not start.
10. Test that weekly Movie List proceeds without a same-date Provider Refresh.
    **Complete through dependency-list and queue-context tests.**
11. Test that weekly validation no longer expects provider jobs. **Complete.**

For the first production run:

1. Record staging subscription, ads, total relationship, and distinct-movie
   counts.
2. Confirm the live table exactly matches the applied run.
3. Confirm provider-filter and shopping-bag answers for representative movies.
4. Confirm the provider-triggered cache warm completes every configured entry.
5. Confirm no provider-cycle jobs remain active.
6. Confirm the success email is accepted by the configured mail server.
7. Confirm the following Saturday weekly pipeline starts and finishes without
   looking for a same-date provider job.

## 9. Rollback

If the independent workflow is not reliable:

1. Pause its scheduled trigger.
2. Leave the last successfully applied live provider snapshot in place.
3. Restore the previous weekly provider trigger and later weekly cron times.
4. Restore Provider Refresh and Provider Apply as weekly dependencies.
5. Restore Movie List's provider safety comparison and application step.
6. Deploy, run one monitored weekly-style provider cycle, warm the cache, and
   validate before considering rollback complete.

## 10. Deployment Record

The Worker and all revised Cron Triggers were deployed successfully on August
5, 2026.

```text
Worker version: 415a7b3e-157b-4bd1-85f1-9572d95c904a
Independent Provider Refresh: Tuesday, Thursday, Saturday at 3:00 PM Eastern
Next automatic provider run: Thursday, August 6, 2026 at 3:00 PM Eastern
Automated tests: 95 passed
TypeScript: passed
Worker dry-run build: passed
```

The deployment changed the internal Advanced Search cache key by adding the
latest successful Provider Apply job-run ID. A representative production
request correctly returned `MISS` under the new key and then `HIT` on the
identical follow-up request.

The complete production cache was then warmed through public Advanced Search
requests because the locally stored manual-admin token was no longer accepted
by the deployed Worker. This public warming path does not create or modify job
records. All 3,024 configured English-default search combinations across 18
genres completed, their additional result pages were processed, and each new
cache write was confirmed by a subsequent `HIT`. A separate live Western
sample returned both `cf-cache-status: HIT` and `x-movieapp-cache: HIT` after
the full run.

The stale local admin token does not affect Cron Triggers or Queue processing.
It should be reconciled separately before the next manual production job is
needed; production security was not weakened and the deployed secret was not
rotated as part of this scheduling change.
