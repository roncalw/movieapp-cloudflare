# MovieApp Scheduled Pipeline Job Report — 2026-08-03

## Summary

**PASS: The complete one-time scheduled pipeline ran successfully from beginning to end.**

The August 3 verification began with IMDb Ratings at 1:00 AM EDT and ended with Final Weekly Validation at 3:00 PM EDT. Every main job and every Movie List helper step reached `complete`, processed its full selected workload, recorded zero errors, and had its completion email accepted by the configured mail server.

Final Weekly Validation checked all 11 jobs it is responsible for checking and found:

- Zero validation issues.
- Zero abandoned `queued` or `running` records.
- Zero records that needed to be reconciled or force-closed.
- Zero dependency-date problems.
- Zero processed-count mismatches.

A separate manual cache verification performed after the normal cron schedules were restored is intentionally outside this report. This report is limited to the scheduled pipeline requested for August 3.

| Main finding | Result |
|---|---|
| Overall scheduled pipeline | Passed from the first source job through final validation |
| Scheduled and helper jobs | All 12 report rows completed; the validator checked the 11 preceding required jobs |
| Recorded job errors | 0 across every scheduled job and helper step |
| Final validation | Complete; 11 of 11 checked; 0 issues; 0 stalled runs reconciled |
| IMDb source validation | 1,702,067 data rows staged; 0 validation issues |
| TMDb popularity validation | 1,166,967 data rows staged; 0 validation issues; 99.5340% overlap with the Movie List |
| Movie List | 828,022 of 828,022 selected work items completed |
| Final production Movie List | 817,839 movies |
| Provider availability | 195,010 subscription relationships plus 73,418 ad-supported markers |
| Search cache | 3,024 of 3,024 search combinations completed; 5,897 result pages; 0 errors |
| Email records | Every scheduled job email was accepted by the configured mail server; no notification errors |
| Jobs left active at report time | 0 |

## Complete Scheduled Job Table

“Expected” normally means the number of work items the job selected for itself. The Search Cache expectation is its configured 3,024 search combinations. Final Validation expects the 11 preceding job records that it is designed to check. Movie List helper steps run inside or immediately after the Movie List build, so they do not have independent clock-time schedules.

| # | Job | Scheduled | Actual run (EDT) | Delay | Duration | Status | Expected | Processed | Difference | Result | Errors | Email |
|---:|---|---|---|---:|---:|---|---:|---:|---:|---|---:|---|
| 1 | IMDb Ratings | 1:00 AM | 1:00:33–1:14:11 AM | +33s | 13m 38s | Complete | 1,702,068 | 1,702,068 | 0 | 1,702,067 rows staged | 0 | Accepted |
| 2 | TMDb Primary New Movies | 3:00 AM | 3:00:33–3:00:35 AM | +33s | 2s | Complete | 57 | 57 | 0 | 57 upserted; 21 inserted | 0 | Accepted |
| 3 | TMDb New Movie Details | 5:00 AM | 5:00:34–5:00:36 AM | +34s | 2s | Complete | 21 | 21 | 0 | 21 details updated | 0 | Accepted |
| 4 | TMDb Watch Providers | 7:00 AM | 7:00:34–8:33:49 AM | +34s | 1h 33m 15s | Complete | 83,702 | 83,702 | 0 | 268,428 relationships staged | 0 | Accepted |
| 5 | TMDb Popularity | 9:00 AM | 9:00:34–9:34:58 AM | +34s | 34m 24s | Complete | 1,166,968 | 1,166,968 | 0 | 1,166,967 rows staged | 0 | Accepted |
| 6 | Movie List Build | 12:00 PM | 12:00:33–12:34:16 PM | +33s | 33m 43s | Complete | 828,022 | 828,022 | 0 | All differences completed | 0 | Accepted |
| 7 | Potential-Load Check | During Movie List | 12:00:47–12:01:06 PM | — | 19s | Complete | 817,839 | 817,839 | 0 | All thresholds passed | 0 | Accepted |
| 8 | Genres Apply Step | During Movie List | 12:01:10–12:01:12 PM | — | 2s | Complete | 41 | 41 | 0 | 81 relationships applied | 0 | Accepted |
| 9 | Providers Apply Step | During Movie List | 12:01:17–12:01:32 PM | — | 15s | Complete | 116,640 | 116,640 | 0 | 268,428 relationships applied | 0 | Accepted |
| 10 | Current-Count Snapshot | After Movie List | 12:34:10–12:34:13 PM | — | 3s | Complete | 817,839 | 817,839 | 0 | Production counts recorded | 0 | Accepted |
| 11 | Search Cache Warm | 1:00 PM | 1:00:32–1:53:38 PM | +32s | 53m 6s | Complete | 3,024 | 3,024 | 0 | 5,897 pages cached | 0 | Accepted |
| 12 | Final Weekly Validation | 3:00 PM | 3:00:31–3:00:44 PM | +31s | 13s | Complete | 11 | 11 | 0 | 0 issues; 0 reconciled | 0 | Accepted |
|  | **Total job time (excluding schedule gaps)** | — | — | — | **3h 49m 2s** | — | — | — | — | — | **0** | — |

The total is the sum of the 12 displayed Duration values. It does not include any waiting time between scheduled jobs. The four Movie List helper rows are separate recorded jobs that execute within the parent Movie List window, so their combined 39 seconds are included separately in this column total.

### Why Final Validation checks 11 jobs while the table has 12 rows

Final Weekly Validation is the twelfth row because it is itself a scheduled job. It checks the 11 required jobs that came before it; it does not check itself while it is still running. Its completed result therefore reports 11 of 11 checked.

### Why the Movie List selected 828,022 work items

The Movie List number is not 828,022 new movies. It is the total of three kinds of required work:

```text
Base Movie List rows added or refreshed       46
IMDb rating and vote differences          51,899
Popularity differences                    776,077
                                          -------
Total selected work                       828,022
```

All 776,077 popularity differences were processed through the permanent bounded queue design. The Movie List then verified that zero popularity differences remained before it declared success. Old IMDb and popularity staging records were also removed through bounded queue ranges rather than extending one Cron invocation past Cloudflare’s execution limit.

## Source-Data Results

| Source | August 3 result | Previous completed result | Difference | Validation |
|---|---:|---:|---:|---|
| IMDb data rows | 1,702,067 | 1,701,383 | +684 | 0 issues |
| TMDb popularity data rows | 1,166,967 | 1,166,736 | +231 | 0 issues |
| Popularity overlap with current Movie List | 814,008 of 817,819 | — | 99.5340% | Passed |
| TMDb Primary rows selected | 57 | — | 57 processed | 0 errors |
| Newly inserted TMDb movies | 21 | — | All 21 received details | 0 errors |
| Watch-provider movies | 83,702 | — | All selected movies processed | 0 errors |
| All provider-availability relationships | 268,428 | — | Applied exactly | 0 errors |

The popularity file excluded 60,710 video records by design and excluded zero rows as adult content. The Movie List used the exact completed August 3 IMDb, Popularity, and Provider runs rather than accepting an older run from a different date.

## Pre-Build Data Safety Comparison

Before changing the live Movie List, the job compared current production counts with the counts expected from staged data. Every measurement passed its allowed-decrease rule.

| Data measurement | Current | Potential | Difference | Percent | Allowed decrease | Result |
|---|---:|---:|---:|---:|---:|---|
| Movie count | 817,819 | 817,839 | +20 | +0.0024% | 1% | Passed; increased |
| IMDb rating count | 409,480 | 409,363 | -117 | -0.0286% | 1% | Passed; decrease inside threshold |
| IMDb vote count | 409,480 | 409,363 | -117 | -0.0286% | 1% | Passed; decrease inside threshold |
| Release date count | 817,818 | 817,838 | +20 | +0.0024% | 1% | Passed; increased |
| US certification count | 81,212 | 81,213 | +1 | +0.0012% | 1% | Passed; increased |
| Popularity count | 817,819 | 817,839 | +20 | +0.0024% | 1% | Passed; increased |
| Genre relationship count | 1,232,070 | 1,232,114 | +44 | +0.0036% | 1% | Passed; increased |
| Movies with genres | 797,777 | 797,799 | +22 | +0.0028% | 1% | Passed; increased |
| Subscription-provider relationships | 195,037 | 195,103 | +66 | +0.0338% | 10% | Passed; increased |
| Movies with subscription providers | 83,702 | 83,702 | 0 | 0.0000% | 10% | Passed; unchanged |
| Movies with ad-supported streams | 73,416 | 73,418 | +2 | +0.0027% | 10% | Passed; increased |
| All availability relationships | 268,453 | 268,521 | +68 | +0.0253% | 10% | Passed; increased |
| Movies with any recorded availability | 116,668 | 116,670 | +2 | +0.0017% | 10% | Passed; increased |

## Provider Safety-Count Correction Made During Monitoring

The scheduled safety check passed, but its provider “potential” counts included 93 historical subscription rows that were still present in the staging table from older completed runs. This did **not** change or damage production provider data:

- The provider application step already selected only the exact, latest completed August 3 provider run.
- The final live provider table exactly matched that completed run.
- No provider-data repair or re-import was performed.

The safety-count query was corrected so it now uses the same exact completed provider-run ID as the provider application step. The corrected query was deployed before Search Cache and Final Validation ran. A production verification at 12:40 PM EDT then confirmed:

| Corrected safety measurement | Live | Staged exact run | Difference |
|---|---:|---:|---:|
| Subscription-provider relationships | 195,010 | 195,010 | 0 |
| Ad-supported markers | 73,418 | 73,418 | 0 |
| All availability relationships | 268,428 | 268,428 | 0 |

The corrected verification processed all 817,839 expected movies, found zero safety failures, recorded zero errors, and had its completion email accepted. TypeScript checking and all 85 automated tests passed before deployment.

## What “Applied” Means for Providers and Genres

The staging tables are checked holding areas inside the same D1 database. The live tables are the tables used by the MovieApp.

For providers, the completed August 3 staging snapshot replaced the prior live U.S. provider snapshot only after the provider import finished successfully. The resulting 268,428 live relationships consist of:

- 195,010 movie-to-subscription-service relationships, covering 83,657 distinct movies.
- 73,418 internal ad-supported markers, one per applicable movie.
- 116,640 distinct movies with at least one subscription or ad-supported availability record.

For genres, 41 newly added or updated movies had checked genre data waiting in staging. Applying those 41 movies produced 81 genre relationships because one movie can belong to several genres. Existing genre information for all other movies was left alone.

## Final Production Counts at Report Time

| Production measurement | Count |
|---|---:|
| Movies in `movie_list_items` | 817,839 |
| Movies with an IMDb rating | 409,551 |
| Movies with an IMDb vote count | 409,551 |
| Movies with a release date | 817,838 |
| Movies with a U.S. certification | 81,213 |
| Movies with popularity | 817,839 |
| Genre relationships | 1,232,114 |
| Movies with one or more genres | 797,799 |
| Subscription-provider relationships | 195,010 |
| Movies with one or more subscription providers | 83,657 |
| Ad-supported movie markers | 73,418 |
| All availability relationships | 268,428 |
| Movies with subscription or ad-supported availability | 116,640 |
| Internal ad marker rows incorrectly exposed in the provider lookup | 0 |
| Jobs still `queued` or `running` | 0 |

## Search Cache Result

The scheduled Search Cache job waited for the successful August 3 Movie List build, then completed:

- 3,024 of 3,024 configured search combinations.
- 5,897 individual result pages.
- 5,897 first requests that created the new cache entries.
- 5,897 confirmation requests that returned cache hits.
- Zero failed combinations and zero recorded errors.

A later manual cache verification was started after restoring the normal cron configuration and is outside this scheduled-pipeline report. It was started conservatively under the assumption that the deployment would isolate these cache entries. Its live results proved that assumption did not apply to this project’s programmatic Cache API: in the Cloudflare locations serving the verification requests, 5,885 page requests found existing entries after deployment, while only 12 initially missed and were then stored successfully. This manual verification is not evidence required to pass the scheduled pipeline and is not included as another reported job.

## Final Validation and Email Evidence

Final Weekly Validation ran from 3:00:31–3:00:44 PM EDT. It checked all 11 required August 3 jobs, found zero issues, and did not need to reconcile any stale `queued` or `running` record.

Every scheduled job row in this report has a non-null notification timestamp and an empty notification-error field. The configured SMTP server returned `250 Queued` for the final validator’s email. “Accepted” means the configured email server accepted responsibility for delivery; the database cannot prove whether the recipient’s mailbox placed a message in the Inbox, Spam, or another folder.

## SQL and Production Evidence

The report SQL is:

- [`support/sql/2026-08-03-job-report.sql`](../sql/2026-08-03-job-report.sql)

Run it from the Cloudflare project root with:

```text
zsh support/run-sql-remote.sh support/sql/2026-08-03-job-report.sql
```

The SQL returns six read-only result sets:

1. Expected-versus-actual results for every scheduled job and helper step.
2. All 13 Movie List safety measurements.
3. Scheduled final-validation issues, including an explicit zero-issue row.
4. The corrected provider safety-count verification.
5. Complete August 3 attempt history, including the scheduled jobs and the corrective safety verification.
6. Final production counts and the number of jobs still active.

The successful report execution performed zero database writes. The first read-only Wrangler request received Cloudflare API authorization code `7403`; an immediate retry succeeded and returned all six result sets. That transient report-query response did not affect any scheduled job, Worker request, or production data.

## Report Metadata

- Pipeline date: `2026-08-03` UTC.
- Local operating window: Monday, August 3, 2026, EDT.
- Requested first-job start: 1:00 AM New York time.
- Actual first-job start: 1:00:33 AM EDT.
- Scheduled pipeline completion: 3:00:44 PM EDT.
- Production Worker: `https://movieapp-cloudflare.carlo-roncallo.workers.dev`.
- Worker version that completed Search Cache and Final Validation: `65372d74-1060-41c5-9dec-74c90805f4d5`.
- Database: `movieapp-db`.
- Scheduled-pipeline result: PASS.
