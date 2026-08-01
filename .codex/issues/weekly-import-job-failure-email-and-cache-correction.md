# Weekly Import Job Status, Failure Email, and Search-Cache Correction

## Purpose and verified status

This document explains why historical MovieApp import jobs remained marked as
`running`, why the expected failure email was not obvious or sometimes was not
sent at all, how job dependencies are matched to one weekly pipeline, how TMDb
provider `404` responses are handled, and how rebuilt movie data is prevented
from being hidden behind old cached search results.

The corrections described here have been implemented, tested, deployed, and
verified against the production Cloudflare database and live Worker.

## 1. Technical terms used in this document

### Job

A **job** is one complete task, such as importing all IMDb ratings or rebuilding
the searchable movie list.

For example, the IMDb job may need to process approximately 1.7 million rating
records. That is too much work for one uninterrupted request, so the job is
divided into smaller units.

### Work message

A **work message** is one small unit of a larger job. Each message contains a
manageable portion of the work.

The overall job record tracks totals such as:

- How many records were selected.
- How many work messages were created.
- How many records were processed.
- How many errors occurred.
- Whether all the work finished.

The overall job cannot be considered complete until all required work messages
report their results.

### Parent job

The **parent job** is the single database record that represents the complete
operation. Thousands of smaller work messages can belong to that one parent
job.

For example:

1. The IMDb parent job selects 1,700,000 ratings.
2. It divides them among many work messages.
3. Every work message reports its processed count to the same parent job.
4. The parent job becomes `complete` only after the processed total reaches the
   selected total.

### Queue

A **queue** is a waiting line for work messages. Cloudflare takes messages from
the queue and gives them to the MovieApp Worker for processing.

The queue lets a large import continue in the background instead of requiring
one web request to remain open for hours.

### Retry

A **retry** means Cloudflare automatically attempts a failed work message
again. Temporary network failures, service interruptions, and rate limits can
often be resolved by retrying.

### Dead-letter queue

A **dead-letter queue** is a separate holding area for a work message that
still cannot be completed after all automatic retries.

Despite its technical name, its purpose is straightforward:

> This work could not be completed. Do not silently discard it. Preserve it in
> a place where MovieApp can detect the permanent failure.

Without this separate holding area, Cloudflare can delete a message after its
maximum retries are exhausted. The remaining MovieApp job can then wait forever
for a completion report from a message that no longer exists.

### SMTP and accepted email

**SMTP** is the system used to hand an outgoing email to the configured mail
server.

When MovieApp records an email as accepted, it means the configured SMTP server
accepted responsibility for the message. It does not prove that the recipient
opened the email or that another mail system did not place it in a spam folder.

### Cache

A **cache** is a temporarily saved response. MovieApp can reuse the saved
response instead of repeating the same expensive movie search every time a
customer submits identical filters.

### Cache key

A **cache key** is the unique identity of a saved response. It normally includes
the search URL and its filters. Two requests with the same cache key can share
the same saved answer.

### Cache warm

A **cache warm** deliberately runs common searches after the movie list is
rebuilt. This saves their responses before customers request them, making those
searches faster.

## 2. Why the historical IMDb jobs remained `running`

The old failure sequence was:

1. The IMDb parent job divided its work into many messages.
2. Most messages completed normally.
3. At least one message repeatedly failed.
4. Cloudflare exhausted the allowed retries and discarded the message.
5. The MovieApp database was never told that the message had permanently
   failed.
6. The parent job continued waiting for a completion report that could never
   arrive.
7. The job remained `running` indefinitely.
8. Because the job never received an ending time, the email code never ran.

The parent job therefore did not formally say `failed`. It was functionally
broken but remained incorrectly labeled `running` because one portion of its
work vanished without reporting a result.

Cloudflare documents that messages which reach their maximum retries are
deleted unless a dead-letter queue is configured:

- [Cloudflare Queues batching and retry documentation](https://developers.cloudflare.com/queues/configuration/batching-retries/)

The new failure sequence is:

1. A work message fails repeatedly.
2. Cloudflare moves it to `movieapp-import-dead-letter-queue`.
3. The MovieApp Worker detects the failed message there.
4. MovieApp changes the parent job from `queued` or `running` to `failed`.
5. MovieApp records the message identifier and failure reason.
6. MovieApp preserves the parent job's existing progress counts.
7. MovieApp sends a failure email.

Late work messages are not permitted to change a failed parent job back to
`running` or `complete`.

Implementation references:

- [`src/jobs/queueHandler.ts`](../../src/jobs/queueHandler.ts)
- [`src/jobs/importJobRuns.ts`](../../src/jobs/importJobRuns.ts)
- Queue configuration in [`wrangler.jsonc`](../../wrangler.jsonc)

## 3. How one weekly pipeline date is determined

### UTC is the database clock

The weekly pipeline uses **UTC**, the standard time zone used by Cloudflare and
the database timestamps. A pipeline date therefore means one UTC calendar
date, not necessarily one calendar date in the phone's or administrator's
local time zone.

For example, `01:00 UTC` on Sunday is `9:00 PM` Saturday in New York while
daylight saving time is active. The pipeline is still identified as Sunday
because its records use UTC.

### All current scheduled jobs start on one UTC date

The current weekly schedule deliberately starts every regular pipeline job on
the same Sunday in UTC:

| UTC time | Scheduled operation |
| --- | --- |
| 01:00 | IMDb ratings import |
| 03:00 | TMDb primary new-movie import |
| 05:00 | TMDb details for newly discovered movies |
| 07:00 | TMDb streaming-provider refresh |
| 09:00 | TMDb popularity-file refresh |
| 12:00 | Searchable movie-list build |
| 13:00 | Search-cache warm |
| 15:00 | Final weekly validation |

The final validation is scheduled two hours after the cache warm begins and
fourteen hours after the first job begins.

### The pipeline date belongs to the parent job

The date is determined from the parent job's UTC `started_at` time. It is not
recalculated whenever one of the smaller work messages finishes.

Example:

1. An IMDb parent job starts at `23:55 UTC` on Sunday.
2. One of its work messages finishes at `00:05 UTC` on Monday.
3. That work message still belongs to the parent job that started Sunday.
4. Updating the parent job after midnight does not change its pipeline date.

This means crossing midnight during the execution of one parent job does not
make its messages belong to a different pipeline.

### The scheduled pipeline is not allowed to run indefinitely

The normal weekly schedule is designed to finish well before UTC midnight. At
`15:00 UTC`, the final validation examines all applicable scheduled jobs. A job
that is still `queued` or `running` at that deadline is changed to `failed` and
reported.

Therefore, the production policy is not to let a scheduled job continue across
multiple days without an explicit failure. A job that would run until the next
UTC day has already missed the final validation deadline and is treated as an
unfinished pipeline job.

### A manual historical rebuild uses an explicit date

A manual movie-list rebuild may occur several days after the original weekly
pipeline. The rebuild endpoint accepts an explicit `runDate=YYYY-MM-DD` value.
This tells the dependency checker which historical pipeline should be
examined, regardless of the date on which the historical rebuild is executed.

For example, a rebuild performed Thursday can explicitly validate and rebuild
the Sunday pipeline instead of looking for Thursday's scheduled imports.

### Boundary if the schedule is changed in the future

The current dependency design is safe because all scheduled parent jobs begin
on the same UTC date. If a future schedule intentionally starts some parent
jobs Sunday and others Monday, deriving the date independently from each
job's start time would no longer be sufficient.

Before allowing a scheduled pipeline to span two UTC dates, the schema and job
messages should receive a durable `pipeline_date` value. The first scheduled
job would assign it, and every later parent job and work message would carry
that exact value. This prevents a Monday job from accidentally looking for
Monday prerequisites when it actually belongs to Sunday's pipeline.

The current schedule does not cross that boundary, so the deployed date-scoped
dependency checks match the complete production schedule.

## 4. How dependency checks now select the correct records

A dependency is an earlier job that must finish successfully before a later
job is allowed to run.

For example, the movie-list build depends on the appropriate IMDb and TMDb jobs
for the same pipeline date.

The old code first searched all historical records for any unfinished job. An
obsolete July 20 IMDb record could therefore block a successful July 27
pipeline.

The new code receives the intended UTC pipeline date and searches only the
records whose parent jobs started during that date:

- At or after `00:00:00 UTC` on the requested date.
- Before `00:00:00 UTC` on the following date.
- Ordered with the newest applicable record first.

For a July 27 recovery, the dependency checker therefore examines July 27
records and ignores an abandoned July 20 record.

Implementation references:

- [`src/jobs/importJobDependencies.ts`](../../src/jobs/importJobDependencies.ts)
- [`migrations/0025_add_job_date_lookup_index.sql`](../../migrations/0025_add_job_date_lookup_index.sql)

The supporting database index begins with `job_name` and `started_at`, allowing
Cloudflare D1 to find one job's records for one date without scanning unrelated
historical jobs.

## 5. Why the expected movie-list email was not noticeable

Two different notification problems occurred.

### The skipped movie-list job

Production records show that the email server accepted an email for the July
27 movie-list job. However, the old subject was approximately:

```text
[MovieApp] Movie List Build Job skipped (...)
```

The word `skipped` did not appear prominently enough to communicate that the
expected weekly movie list had not been produced.

### The abandoned IMDb jobs

The abandoned IMDb jobs had no ending time because they remained incorrectly
marked `running`. The old notification code sent mail only after a job ended.
Those jobs therefore never entered the email-sending path.

### New email subjects

The outcome now appears immediately after `[MovieApp]`:

```text
[MovieApp] FAILED: IMDb Ratings Job (...)
[MovieApp] FAILED: Weekly Import Validation (...)
[MovieApp] ACTION REQUIRED: Movie List Build Job (...)
[MovieApp] SUCCESS: Search Cache Warm Job (...)
```

A skipped job uses `ACTION REQUIRED` because the expected operation did not
happen even when no program exception occurred.

Implementation reference:

- [`src/notifications/jobNotifications.ts`](../../src/notifications/jobNotifications.ts)

## 6. How missing emails are detected and retried

The last weekly operation is now a complete pipeline validation. It checks:

- Every required parent job exists for the pipeline date.
- No applicable job remains `queued` or `running`.
- Every required job ended successfully.
- No required job recorded errors.
- Every finished job has an ending time.
- The processed count matches the selected count when work was selected.
- The movie-list safety check finished.
- Movie genres were applied.
- Streaming-provider relationships were applied.
- The final movie-count snapshot finished.
- Every finished job has a recorded email acceptance time.
- No email attempt recorded a failure.
- No email remained stuck in the temporary `sending` state.

When a finished job has no recorded accepted email, the validation clears an
unfinished email claim and tries once more. This favors a possible duplicate
email over silently losing an important failure notification.

If the second attempt still fails, the validation records one of these explicit
issues:

- `notification_missing`
- `notification_failed`

The validation email includes the job name and the stored reason for each
problem.

Implementation reference:

- [`src/jobs/weeklyImportValidation.ts`](../../src/jobs/weeklyImportValidation.ts)

### Remaining limitation of a single email system

All current job emails use the same SMTP server. If that server is completely
unavailable, it cannot send an email explaining that it is unable to send
emails.

MovieApp still preserves the notification error and missing acceptance time in
the production database. Guaranteed notification independent of SMTP would
require a second delivery channel, such as:

- A Cloudflare alert.
- A webhook to another monitoring service.
- A text-message service.
- A separate email provider.

This is a limitation of relying on one notification channel, not an
unrecorded job-state failure.

## 7. How TMDb provider `404` responses are handled

An HTTP `404` response means TMDb says the requested movie/provider resource is
not available.

For the provider refresh, this is now an accepted business result:

- It is not counted as an error.
- It is not logged as a warning.
- It does not cause `complete_with_errors`.
- It is counted separately in `tmdbIDNotFoundSkippedCount`.
- No current provider rows are staged for that movie.

During the full provider replacement step, storing no current provider rows
also removes obsolete provider relationships that may previously have existed
for the movie.

Implementation references:

- [`src/externalApis/tmdbClient.ts`](../../src/externalApis/tmdbClient.ts)
- [`src/imports/tmdbProviderRefresh.ts`](../../src/imports/tmdbProviderRefresh.ts)

## 8. Why rebuilt movie data could still look unchanged

Movie search responses can remain cached for seven days. Before this correction,
the cache key identified the search filters but did not identify which
movie-list build supplied the underlying data.

This created the following possibility:

1. The database movie list was brought current.
2. A customer repeated a search that had been performed before the update.
3. Cloudflare found the old saved response.
4. Advanced Search displayed the old results even though the database was now
   correct.

Every successful movie-list build now receives a unique job-run identifier.
MovieApp adds that identifier to the internal search cache key.

The resulting behavior is:

- Old movie-list build ID means old saved searches.
- New movie-list build ID means a fresh set of saved searches.
- The mobile application's public URL does not change.
- A completed movie-list build automatically stops using the preceding build's
  cached responses.

Finding the current build ID performs a small indexed query against job
history. It does not query the large movie table merely to determine whether a
cached response is current.

Implementation reference:

- [`src/httpRouting/movieSearch.ts`](../../src/httpRouting/movieSearch.ts)

## 9. How cache warming verifies that a response was saved

After receiving a new search response, Cloudflare may finish writing it to the
cache just after returning the response. An immediate confirmation request can
occasionally arrive too soon and receive another cache miss.

The warmer now behaves as follows:

1. Request the search URL.
2. If it is already cached, record the cache hit.
3. If it is not cached, allow the response to be saved.
4. Request it again to confirm a cache hit.
5. If the immediate confirmation is still too early, wait briefly and check
   again.
6. Try no more than three confirmation requests.
7. If none confirms a hit, record a real cache-warm failure instead of reporting
   clean success.

Implementation reference:

- [`src/cache/cacheWarmQueue.ts`](../../src/cache/cacheWarmQueue.ts)

## 10. Live database correction and verification results

Four abandoned historical parent jobs were changed from `running` to `failed`.
This changed only their job-status records. It did not delete, replace, or
damage existing movie data.

The live movie-list update completed with:

- 817,478 total searchable movies.
- 2,233 changed movies applied.
- Zero eligible staging movies missing from `movie_list_items`.
- Successful genre promotion.
- Successful streaming-provider promotion.
- Successful current-count snapshot.

The subsequent production cache warm completed with:

- 3,024 of 3,024 configured search entries processed.
- 5,784 result pages processed.
- Zero errors.
- A recorded accepted success email.

Final production checks found:

- Zero applicable jobs incorrectly left `queued` or `running`.
- Zero recent finished jobs without a recorded accepted email.
- Confirmed live cache hits for the updated popularity search.
- Confirmed live cache hit for the one URL whose initial confirmation had been
  delayed.

The live English-only popularity search for releases from 2021 through 2026
now returns The Odyssey at result number 1 and Supergirl at result number 10.

## 11. Why Spider-Man was not in the Cloudflare movie table

TMDb currently reports TMDb movie ID `969681`, *Spider-Man: Brand New Day*, with
a release date of July 28, 2026.

The preceding scheduled primary import ran July 27 and imported releases
through July 27. Spider-Man was therefore not eligible for that import.

The homepage could display it because the homepage requests current information
directly from TMDb. The Cloudflare database could not display it because its
weekly new-movie import had run one day before the movie's current TMDb release
date.

Spider-Man becomes eligible for the following scheduled primary import.

This particular absence was different from The Odyssey and Supergirl. Those
movies already existed in staging, but the blocked movie-list build prevented
their refreshed records from reaching Advanced Search.

Exact daily agreement between the homepage and Advanced Search is not guaranteed
while the homepage uses live TMDb data and Cloudflare imports new movies and
popularity values on a schedule. Near-real-time agreement would require a more
frequent TMDb popularity and new-movie refresh.

## 12. Verification and deployment

The implementation passed:

- TypeScript validation.
- Cloudflare deployment validation.
- Source-difference validation.
- All 52 automated tests.
- Production database checks.
- Live search checks.
- Live cache checks.
- Production notification-status checks.

The final deployed Worker version for these corrections was:

```text
479175eb-9136-41e7-9daf-b73dad41c876
```
