# MovieApp Weekly Job Report — 2026-08-02

## Summary

**Original weekly run: FAILED. Production recovery: COMPLETE AND VALIDATED.**

The original pipeline began at 9:00 PM EDT on Saturday, August 1 and ended with a failed final validation at 11:01 AM EDT on Sunday, August 2. The five source-data jobs all completed successfully with zero recorded errors. The failure occurred later, while the Movie List build was copying the new popularity values into `movie_list_items`. Production recovery finished with a clean final validation at 4:01 PM EDT.

| Main finding | Result |
|---|---|
| Source-data jobs | All 5 completed: IMDb, TMDb Primary, New Movie Details, Watch Providers, and Popularity |
| Source validation | Passed: IMDb and Popularity reported zero validation issues; the Movie List pre-build safety check passed all 10 data measurements |
| Movie List build | Its last saved checkpoint showed 611,801 of 826,605 recorded work items (74.01%); recovery later proved that 4,000 additional updates had committed after that checkpoint |
| Exact stopping point | Popularity update phase: 590,000 of 804,804 was the last saved progress count, while the production recovery count proved that 594,000 had actually committed and 210,804 remained |
| Search cache | Original run skipped; recovery completed all 3,024 entries with zero errors |
| Final current-count snapshot | Original snapshot missing; recovery confirmed all 817,819 production movies |
| Final validation | Original validation found 4 consequences; recovery validation checked all 11 applicable jobs and found zero issues |
| Email records | Original failure emails and the Movie List, snapshot, cache, and final recovery emails were all accepted by the configured mail server with no notification error |
| Permanent correction | Deployed; the dedicated queue and final verification path have completed successfully in production |
| Production recovery | Complete: zero remaining popularity differences, 817,819 movies confirmed, 3,024 cache entries rebuilt, and 11 of 11 jobs validated with zero errors |

### Most likely cause

The Movie List job’s last real progress was recorded **14 minutes 55 seconds** after it began. Cloudflare documents a **15-minute wall-time limit for a Cron Trigger invocation**. The timing and the absence of a normal completion record strongly indicate that Cloudflare terminated the scheduled invocation at that limit while the popularity synchronization was still running. This is an evidence-based conclusion, but the job table itself does not contain an explicit Cloudflare termination message. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

The final validator then did exactly what it was designed to do: at 11:00 AM EDT it found the abandoned `running` record, changed it to `failed`, recorded the terminal reason, and sent the failure notification.

### Permanent correction deployed

The corrected design no longer asks one scheduled Worker invocation to update the full Movie List popularity column. Both scheduled and manual Movie List builds now prepare the safe source data and place the large remaining work onto a dedicated Movie List queue.

The important behavior changes are:

1. Each queue delivery processes only one bounded Movie List range. The queue is configured with a batch size of one, so Cloudflare cannot combine 100 large Movie List ranges into another oversized Worker invocation.
2. Every completed range writes a unique checkpoint in `import_job_queue_messages`. If Cloudflare delivers the same message again, the data operation and progress count remain safe and are not counted twice.
3. A final verification step waits for every expected range and then checks the database for any remaining popularity difference. The parent Movie List job cannot be marked complete merely because messages were sent.
4. Old IMDb and popularity staging data is also removed through bounded queue ranges. This prevents cleanup from becoming a second long-running operation after the popularity update finishes.
5. Each successful range extends the Movie List job lock. A second Movie List build therefore cannot begin while the first build is still processing its queued ranges.
6. If a message exhausts all retries, the parent Movie List job is changed to `failed`, its lock is released, and the existing failure-email path runs. It will not remain incorrectly marked `running` until the final validator discovers it.
7. Manual Movie List rebuilds use this same queue path. Production recovery therefore exercised the permanent behavior rather than relying on a one-time synchronous repair.

This correction adds one dedicated Cloudflare queue named `movieapp-movie-list-build-queue`. It does not add a database table, does not replace the source imports, and does not delete or rebuild the existing Movie List before applying differences.

Local verification completed successfully:

- TypeScript type checking passed.
- Wrangler’s deployment dry run successfully built the Worker and recognized the new queue binding.
- All 82 automated tests passed, including new coverage for range boundaries, duplicate-delivery protection, finalizer waiting, phase ordering, wildcard-free checkpoint counting, legacy-source safety, permanent message failure, and lock release.

The correction is deployed in production. During recovery, the queue’s diagnostic recording exposed an additional D1 limitation: the long phase-checkpoint `LIKE` pattern was rejected as too complex. That lookup now uses a direct prefix comparison with no wildcard engine or pattern-length limit. The final recovery run completed through all phases with no errors.

### Production recovery results

The recovery preserved work already completed by the failed morning run:

1. The first corrected recovery found **210,804** remaining popularity differences, not the original 804,804. Therefore, **594,000** updates had actually committed before Cloudflare stopped the original invocation. The job status showed only 590,000 because the old code changed the database in 1,000-row groups but saved its progress record only after each 10,000 rows. Four additional groups committed after the last saved progress record. Recovery preserved all 594,000 and did not overwrite them unnecessarily.
2. All 210,804 remaining differences were applied through 175 separately recorded queue checkpoints.
3. The first verification attempt exhausted its finalizer retries after the data update. That attempt did not yet persist the underlying exception text, so error recording was added before the next retry.
4. The diagnostic retry exposed D1’s rejection of the long `LIKE` pattern. Because the first attempt used the same query, this is the evidence-backed explanation for both finalizer failures. The wildcard-free prefix comparison was deployed and verified in production.
5. The final Movie List recovery ran from **2:30:02–2:32:25 PM EDT**, completed with zero errors, and used the exact successful August 2 IMDb and Popularity source runs.
6. The final production Movie List count is **817,819**, exactly matching the pre-build safety check’s expected count.
7. The final count snapshot completed with 817,819 selected and processed, zero errors, and an accepted completion email.
8. The Movie List completion email was also accepted with no notification error.
9. Search Cache recovery ran from **2:40:47–3:37:24 PM EDT**, processed all **3,024 of 3,024** configured entries, produced 5,895 cached pages, and recorded zero errors.
10. The Search Cache completion email was accepted at **3:37:26 PM EDT** with no notification error.
11. Final weekly validation ran from **4:00:52–4:01:09 PM EDT**, checked all **11 of 11** applicable jobs, found zero issues, and reconciled no abandoned runs.
12. The successful final-validation email was accepted at **4:01:15 PM EDT** with no notification error.
13. The deployed and local schedules were restored to their normal weekly values after the one-time recovery checks. Final validation is again scheduled for Sunday at 11:00 AM EDT.

An independent production query also confirmed **817,819** live Movie List rows and **zero** popularity differences against the successful August 2 TMDb popularity source run.

## Recovery Job Table

The first two corrected Movie List attempts completed their database work but failed during final verification. Those failures did not reverse any committed data. The diagnostic information from those attempts exposed the D1 wildcard-pattern problem, which was then corrected before the successful third attempt.

| # | Recovery job | Actual run (EDT) | Status | Selected | Processed | Difference | Updated/output | Errors | Email |
|---:|---|---|---|---:|---:|---:|---|---:|---|
| 1 | Movie List corrected attempt | 2:00:52–2:04:43 PM | Failed in final verification | 210,905 | 210,904 | -1 completion sentinel | 210,804 remaining popularity differences applied plus 100 earlier work items | 1 | Accepted |
| 2 | Movie List diagnostic attempt | 2:15:53–2:17:43 PM | Failed in final verification | 101 | 100 | -1 completion sentinel | Confirmed zero remaining popularity differences; exposed D1 `LIKE` failure | 1 | Accepted |
| 3 | Movie List final attempt | 2:30:02–2:32:25 PM | Complete | 100 | 100 | 0 | Queue verification and bounded cleanup completed | 0 | Accepted |
| 4 | Current-count snapshot | 2:32:21–2:32:23 PM | Complete | 817,819 | 817,819 | 0 | Confirmed 817,819 production movies | 0 | Accepted |
| 5 | Search Cache recovery | 2:40:47–3:37:24 PM | Complete | 3,024 | 3,024 | 0 | 5,895 cached pages | 0 | Accepted |
| 6 | Final weekly validation | 4:00:52–4:01:09 PM | Complete | 11 jobs | 11 jobs | 0 | Zero validation issues | 0 | Accepted |

### Production-data impact at the time of the failure

The original job record reports 611,801 processed and updated work items before termination. Those changes were performed in database chunks; changing the job status to `failed` did not roll them back. At 11:00 AM, before recovery began, the production Movie List therefore contained a **partial** application of this week’s data:

- The preliminary Movie List work and IMDb-difference work had completed.
- The last saved progress record showed 590,000 popularity changes. Recovery later proved that 594,000 had actually committed.
- 210,804 popularity differences had not yet been applied when the invocation stopped.
- The final current-count snapshot was not created.
- The Search Cache job did not rebuild the weekly cache.

That list describes the temporary condition immediately after the morning
failure—not the current condition after recovery. The completed 594,000
popularity updates were preserved. Recovery changed only the remaining 210,804
rows, then successfully recorded the missing 817,819-row current-count snapshot.

## Original Weekly Run Table

This table preserves the original morning failure exactly as it appeared before recovery. It includes the eight main scheduled jobs and all four expected Movie List helper steps. “Expected” normally means the number of work items the job selected. The cache expectation is its configured 3,024 search entries. The missing original snapshot expectation is the 817,819-movie potential count calculated by the safety check.

| # | Job | Expected start (EDT) | Actual run (EDT) | Start difference | Status | Expected | Processed | Difference | Complete | Updated/output | Errors | Email |
|---:|---|---|---|---:|---|---:|---:|---:|---:|---|---:|---|
| 1 | IMDb Ratings | Sat 8/1 9:00 PM | 9:00:53–9:14:54 PM (14m 1s) | +53s | Complete | 1,701,384 | 1,701,384 | 0 | 100.00% | 1,701,383 staged | 0 | Accepted |
| 2 | TMDb Primary New Movies | Sat 8/1 11:00 PM | 11:00:57–11:01:00 PM (3s) | +57s | Complete | 119 | 119 | 0 | 100.00% | 119 upserted; 45 newly inserted | 0 | Accepted |
| 3 | TMDb New Movie Details | Sun 8/2 1:00 AM | 1:00:53–1:00:56 AM (3s) | +53s | Complete | 45 | 45 | 0 | 100.00% | 45 movie details updated | 0 | Accepted |
| 4 | TMDb Watch Providers | Sun 8/2 3:00 AM | 3:00:54–4:14:52 AM (1h 13m 58s) | +54s | Complete | 83,493 | 83,493 | 0 | 100.00% | 194,074 provider rows staged | 0 | Accepted |
| 5 | TMDb Popularity | Sun 8/2 5:00 AM | 5:00:53–5:40:49 AM (39m 56s) | +53s | Complete | 1,166,737 | 1,166,737 | 0 | 100.00% | 1,166,736 staged | 0 | Accepted |
| 6 | Movie List Build | Sun 8/2 8:00 AM | 8:00:53–11:00:53 AM (3h recorded) | +53s | **Failed** | 826,605 | 611,801 recorded | **-214,804 recorded** | **74.01% recorded** | Last checkpoint: 590,000/804,804; recovery proved 594,000 committed | 1 | Accepted |
| 7 | Movie List Potential-Load Check | During Movie List | 8:01:04–8:01:15 AM (11s) | — | Complete | 817,819 | 817,819 | 0 | 100.00% | All 10 safety measurements passed | 0 | Accepted |
| 8 | Movie Genres Apply Step | During Movie List | 8:01:20–8:01:21 AM (1s) | — | Complete | 85 movies | 85 movies | 0 | 100.00% | 161 genre rows applied | 0 | Accepted |
| 9 | Movie Watch Providers Apply Step | During Movie List | 8:01:26–8:01:32 AM (6s) | — | Complete | 83,493 movies | 83,493 movies | 0 | 100.00% | 194,074 provider rows applied | 0 | Accepted |
| 10 | Movie List Current-Count Snapshot | After Movie List succeeds | **Did not run** | — | **Missing** | 817,819 movies | 0 | **-817,819** | 0.00% | No final production-count confirmation | — | Not sent; no job existed |
| 11 | Search Cache Warm | Sun 8/2 9:00 AM | 9:00:53 AM (under 1s) | +53s | **Skipped** | 3,024 entries | 0 | **-3,024** | 0.00% | Blocked because Movie List was still active | 0 | Accepted |
| 12 | Final Weekly Validation | Sun 8/2 11:00 AM | 11:00:53–11:01:01 AM (8s) | +53s | **Failed** | 7 main jobs | 7 checked | 0 | 100.00% checked | 4 issues; 1 abandoned run reconciled | 4 | Accepted |

### How to read the Movie List counts

The Movie List’s 826,605 expected work items are not 826,605 distinct new movies. That number combines the different kinds of row work the build had to perform. By the time it entered the popularity phase, 21,801 earlier work items were already complete. Its last saved checkpoint contained this arithmetic:

```text
Earlier completed Movie List work       21,801
Popularity changes in last checkpoint  590,000
                                        -------
Total recorded processed                611,801

Popularity changes expected            804,804
Popularity changes in last checkpoint  590,000
                                        -------
Remaining according to checkpoint      214,804
```

That arithmetic explains the original job record. It is not the final physical
database count because the old loop committed four additional 1,000-row groups
after saving the 590,000 checkpoint. The recovery’s direct difference count
found the actual remaining total of 210,804, proving that 594,000 changes had
committed before termination.

## Pre-Build Data Safety Comparison

Before changing the production Movie List, the job compared the current production counts with the counts expected from the new staged data. All measurements passed their allowed-decrease rules.

| Data measurement | Current | Potential | Difference | Percent | Allowed decrease | Result |
|---|---:|---:|---:|---:|---:|---|
| Movie count | 817,785 | 817,819 | +34 | +0.0042% | 1% | Passed; increased |
| IMDb rating count | 409,464 | 409,363 | -101 | -0.0247% | 1% | Passed; decrease inside threshold |
| IMDb vote count | 409,464 | 409,363 | -101 | -0.0247% | 1% | Passed; decrease inside threshold |
| Release date count | 817,784 | 817,818 | +34 | +0.0042% | 1% | Passed; increased |
| US certification count | 81,212 | 81,212 | 0 | 0.0000% | 1% | Passed; unchanged |
| Popularity count | 817,785 | 817,819 | +34 | +0.0042% | 1% | Passed; increased |
| Genre row count | 1,232,021 | 1,232,070 | +49 | +0.0040% | 1% | Passed; increased |
| Movies with genres | 797,749 | 797,777 | +28 | +0.0035% | 1% | Passed; increased |
| Watch provider row count | 194,211 | 194,696 | +485 | +0.2497% | 10% | Passed; increased |
| Movies with watch providers | 83,573 | 83,749 | +176 | +0.2106% | 10% | Passed; increased |

This table proves that the incoming data was safe enough to load. It does **not** mean the later Movie List build completed; the build failed for execution-time reasons after this check passed.

## Source-Data Validation Details

| Source | Current result | Previous completed result | Comparison | Validation |
|---|---:|---:|---:|---|
| IMDb staging rows | 1,701,383 | 1,701,193 | +190 (+0.0112%) | 0 issues |
| TMDb popularity staging rows | 1,166,736 | 1,166,309 | +427 (+0.0366%) | 0 issues |
| Popularity overlap with current Movie List | 814,041 of 817,785 | — | 99.5422% | Passed |
| Watch-provider movies processed | 83,493 | — | 100% of selected movies | 0 errors |
| Watch-provider rows produced | 194,074 | — | Applied by the provider promotion step | 0 errors |

The popularity file excluded 60,681 video records by design. It did not exclude any rows as adult content in this run.

## Failure Timeline

1. **8:00:53 AM:** Movie List began.
2. **8:01:04–8:01:32 AM:** The safety check, genre promotion, and provider promotion completed successfully.
3. **8:15:48 AM:** Movie List saved its last progress checkpoint at 590,000 of 804,804 popularity changes. This was 14 minutes 55 seconds after the Cron invocation began. Four more 1,000-row database groups committed after that checkpoint and before termination.
4. **9:00:53 AM:** Search Cache checked its dependency, found Movie List still marked `running`, and correctly skipped itself.
5. **11:00:53 AM:** Final validation found Movie List still `running`, changed it to `failed`, and recorded one error.
6. **11:01:01 AM:** Final validation finished as `failed` after reporting the Movie List and cache consequences.

The Movie List’s displayed three-hour duration is therefore not three hours of continuous confirmed work. It is the time from the 8:00:53 AM start until final validation closed the abandoned record at 11:00:53 AM. Confirmed Movie List progress stopped at 8:15:48 AM.

## Validation Issues

The validator recorded four issue rows, but they do not represent four independent job failures:

| Job | Validation code | What it means |
|---|---|---|
| Movie List Build | `not_complete` | The job did not reach `complete`; validation changed the abandoned run to `failed` |
| Movie List Build | `errors_recorded` | The reconciliation recorded one terminal error on that same run |
| Movie List Build | `processed_count_mismatch` | 611,801 processed did not equal 826,605 selected |
| Search Cache Warm | `not_complete` | Cache warming was skipped because Movie List was still active |

In plain language, the operational outcome was one primary failure—the Movie List did not finish—and one expected downstream consequence—the cache did not run.

## Email Evidence

The database records show that all 11 jobs that actually created a run record had their email accepted by the configured SMTP server. Every `notification_error` is empty. “Accepted” means the mail server accepted responsibility for the message; it does not prove that a mailbox provider placed the message in the Inbox rather than Spam or another folder.

The three attention subjects should have been:

```text
[MovieApp] ACTION REQUIRED: Search Cache Warm Job (skipped, less than 1 second)
[MovieApp] FAILED: Movie List Build Job (failed, 3 hours)
[MovieApp] FAILED: Weekly Import Validation (failed, 8 seconds)
```

Acceptance timestamps were:

- Search Cache: 9:00:57 AM EDT.
- Movie List failure: 11:00:57 AM EDT.
- Final Validation failure: 11:01:05 AM EDT.

The missing Movie List current-count snapshot did not send an independent email because that helper job never started and therefore had no job-run record.

## Recovery Checklist

1. **Complete:** Create the dedicated production queue and deploy the tested Worker correction.
2. **Complete:** Run the corrected Movie List build using the successful August 2 IMDb and Popularity source runs. The difference-based updates preserved all 594,000 popularity values already applied and changed only the 210,804 rows that still differed.
3. **Complete:** Verify all Movie List queue checkpoints, confirm zero remaining popularity differences, and record the 817,819-row current-count snapshot.
4. **Complete:** Rebuild all 3,024 Search Cache entries after the Movie List completed; all entries finished with zero errors.
5. **Complete:** Rerun final weekly validation; all 11 applicable jobs passed with zero issues.
6. **Complete:** Restore and deploy the normal Sunday job schedules after the one-time recovery triggers.

## SQL and Production Evidence

The report SQL is:

- [`support/sql/2026-08-02-job-report.sql`](../sql/2026-08-02-job-report.sql)

Run it from the Cloudflare project root with:

```text
zsh support/run-sql-remote.sh support/sql/2026-08-02-job-report.sql
```

The SQL returns:

1. The newest expected-versus-actual state for every job, including the successful recovery snapshot, cache, and final validation.
2. The 10 Movie List data-safety comparisons.
3. The newest final-validation result, which explicitly reports that no issues remain.
4. Every original and recovery attempt for the Movie List, snapshot, Search Cache, and final validation so successful recovery cannot hide the original failure.

The original evidence was first collected through the deployed Worker’s read-only job endpoints, which read the `import_job_runs` records:

```text
GET /admin/import/last-job-runs-summary
GET /admin/import/job-runs?limit=30
```

Production Wrangler access was then restored. The dated SQL file was run directly against production D1 and returned four read-only result sets: the newest state for every expected job, the ten Movie List safety comparisons, the newest validation issues, and every original/recovery attempt for the affected downstream jobs. The SQL performed zero database writes.

## Report Metadata

- Pipeline date used by the jobs: `2026-08-02` UTC.
- Local operating window: Saturday, August 1 through Sunday, August 2, 2026 EDT.
- Report generated: Sunday, August 2, 2026 at approximately 1:11 PM EDT.
- Recovery status last updated: Sunday, August 2, 2026 at approximately 4:01 PM EDT.
- Production Worker: `https://movieapp-cloudflare.carlo-roncallo.workers.dev`
- Deployed Worker version after normal schedules were restored: `3c688e32-35c1-48d0-b67f-88a43eaa37d6`.
- Database: `movieapp-db`.
