# D1 Provider and Weekend Pipeline Cost Reduction

**Recorded:** September 1, 2026  
**Project:** `movieapp-cloudflare`  
**Scope:** Final net changes relative to committed baseline `abe1629`  
**Production status:** Provider changes are deployed and verified. The first production measurement of the revised weekend pipeline is still pending.

This document records only the final behavior that remains in the project. It does not describe intermediate approaches that were later removed.

## 1. Start here

Cloudflare invoice `IN-76854700` was **$108.94**, compared with the previous **$5.00** invoice. Most of the increase came from D1 database reads and writes.

The final correction has two parts:

1. The independent provider job still checks the complete current TMDB provider data, but it writes only actual provider relationship additions and removals to the live provider table.
2. The weekend pipeline keeps its existing jobs and safety model, but uses smaller Movie List indexes and indexed cleanup of completed old snapshots.

The provider job now runs **Tuesday and Friday at 3:00 PM Eastern**, followed by provider application, cache warming, and validation.

The first production change-only provider cycle reduced D1 writes from **2,554,191** to **357,051**, an **86.02% reduction**. No provider relationships had changed, so the live provider table received **zero** inserts, deletes, or updates.

The remaining 357,051 writes were primarily the complete candidate ID snapshots needed to prove that the TMDB run was complete and to find movies that used to have providers but no longer do.

### The simplest before-and-after view

| Area | Before | Final behavior |
|---|---|---|
| Provider schedule | Tuesday, Thursday, and Saturday at 3:00 PM Eastern | Tuesday and Friday at 3:00 PM Eastern |
| TMDB provider check | Complete check of current US subscription and ad-supported availability | Same complete check |
| Provider staging | Stored the complete set of approximately 260,000 provider relationships | Stores only relationship additions and removals |
| Live provider update | Deleted and reinserted the complete US provider table | Deletes removed relationships and inserts new relationships only |
| Unchanged provider rows | Rewritten every provider cycle | Left untouched |
| Movies that lost every provider | Removed because they were absent from the replacement snapshot | Explicitly detected from the complete candidate set and staged as removals |
| Provider cache | Fully warmed after every successful provider cycle | Same behavior |
| Provider validation | Compared the replacement snapshot with the live table | Compares projected final counts with live counts and requires zero unapplied changes |
| Weekend job sequence | IMDb, TMDB Primary, New Movie Details, Popularity, Movie List, cache warm, validation | Same sequence and schedule |
| Weekend old-snapshot cleanup | Repeatedly filtered millions of rows with broad `not this run` conditions | Selects completed old run IDs and deletes through indexed run and item ranges |
| Movie List indexes | Popularity and IMDb values were repeated across all four search indexes | Each changing measurement is present only in its two relevant indexes |

## 2. Why this work was necessary

### 2.1 The invoice that triggered the investigation

Cloudflare invoice `IN-76854700` covered July 27 through August 26, 2026.

| Invoice item | Billed amount |
|---|---:|
| D1 rows written | $84.00 |
| D1 rows read | $19.14 |
| Queue operations | $0.80 |
| Workers Paid subscription | $5.00 |
| **Total** | **$108.94** |

The invoice listed 83,827,719 billed D1 rows written and 19,142,382,571 billed D1 rows read after the plan's included usage. The charge was therefore a database-usage problem, especially a write problem.

Cloudflare Workers Paid currently includes:

| D1 resource | Included each month | Overage rate |
|---|---:|---:|
| Rows read | 25 billion | $0.001 per million rows |
| Rows written | 50 million | $1.00 per million rows |
| Workers subscription | - | $5.00 per month |

Cloudflare counts indexes as additional writes. For example, updating one table row and one index entry counts as two rows written. This is why removing unnecessary index updates matters even when the logical number of application records is unchanged.

Current pricing reference: [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

### 2.2 What the production history showed

Removing providers from the weekend job was not itself the cause of the expensive weekend pipeline. Historical production windows showed that the weekend pipeline was already expensive before the provider schedule was separated.

| Production window | Provider ownership | Reads per run | Writes per run |
|---|---|---:|---:|
| August 3 combined pipeline | Providers still included in the weekend pipeline | About 6.32 billion | About 16.60 million |
| August 30 weekend pipeline | Providers already separate | 6,586,981,536 | 14,147,486 |

Separating providers reduced weekend writes by roughly 2.45 million per run. It did not create the remaining 14.15 million weekend writes.

The investigation found two independent cost areas:

| Cost area | Main problem |
|---|---|
| Independent provider cycle | Rebuilt complete staging and live relationship snapshots even when almost nothing changed |
| Weekend pipeline | Old snapshot cleanup read large tables repeatedly, and Movie List updates rewrote indexes for unrelated measurements |

## 3. Final provider design

### 3.1 What remains a complete refresh

The provider cycle still performs a complete source check. This is essential for correctness.

Every provider cycle still:

1. Discovers every US TMDB subscription candidate.
2. Discovers every US TMDB ad-supported candidate.
3. Requests the current US subscription providers for every subscription candidate.
4. Requires every selected movie to be processed successfully.
5. Rejects incomplete, failed, empty, or unexpectedly reduced results before changing live data.
6. Warms the complete provider-sensitive search cache after a successful apply.
7. Validates the exact refresh, apply, and cache-warm chain.

The change is **how provider relationships are stored and applied**, not how thoroughly TMDB is checked.

### 3.2 Before flow

```text
Complete TMDB candidate discovery
    -> Store every provider relationship in full-snapshot staging
    -> Validate the complete staging snapshot
    -> Delete every live US provider relationship
    -> Insert every relationship from staging
    -> Mark the complete staging snapshot as promoted
    -> Warm the provider search cache
    -> Validate staging against live data
```

Even an unchanged provider table was written twice: once in staging and again in the live table. Indexes multiplied those logical writes.

### 3.3 Final flow

```text
Complete TMDB candidate discovery
    -> Keep complete subscription and ads candidate ID lists
    -> Read current live relationships in batches of 25 movies
    -> Compare TMDB relationships with live relationships in memory
    -> Stage only additions and removals
    -> Detect live movies missing from the complete new candidate lists
    -> Calculate projected final live counts
    -> Reject incomplete or unexpectedly reduced results
    -> Delete only staged removals
    -> Insert only staged additions
    -> Warm the provider search cache
    -> Validate projected counts, live counts, and zero unapplied changes
```

This is a **complete source verification with a change-only database apply**.

### 3.4 How a movie that loses every provider is handled

This was a required safety case.

Suppose movie `12345` had Netflix in the live provider table last week. TMDB no longer returns that movie in the current subscription candidate set.

The job does not simply ignore the missing movie. After all candidate and per-movie work finishes, it compares the complete candidate set with existing live relationships.

```text
Live relationship:
12345 -> Netflix

Current complete candidate set:
movie 12345 is absent

Staged change:
remove 12345 -> Netflix
```

The same complete-set comparison is used for the internal ad-supported marker. Therefore, a movie that no longer has any provider is removed from live availability even though it was not returned as a current candidate.

### 3.5 Tables and responsibilities

| Table | Final responsibility |
|---|---|
| `tmdb_us_flatrate_movies_staging` | Complete current subscription candidate movie IDs |
| `tmdb_us_ads_refresh_candidates` | Complete current ad-supported candidate movie IDs |
| `movie_watch_provider_changes_staging` | Only provider relationship additions and removals for one exact refresh run |
| `movie_watch_providers` | Live provider relationships used by search |
| `import_job_runs` | Parent job status, counts, exact run linkage, and final results |
| `import_job_queue_messages` | Idempotent queue-message completion and progress accounting |

The older `movie_watch_providers_staging` table still exists for other established paths. The independent complete provider refresh no longer uses it to store and promote every relationship.

### 3.6 Why an unchanged cycle still has writes

An unchanged provider cycle is not completely write-free because the complete current candidate set must be recorded before the job can safely determine what disappeared.

The verified change-only cycle contained:

| Write source | Logical work | Approximate physical D1 writes |
|---|---:|---:|
| Subscription candidates | 84,395 movie IDs | 168,790 |
| Ad-supported candidates | 74,030 movie IDs | 148,060 |
| Job, queue, cache, validation, and unavoidable overlapping traffic | Progress and operational records | 40,201 |
| Live provider relationship changes | 0 additions and 0 removals | **0** |
| **Measured total** |  | **357,051** |

Each candidate normally writes one table row and one `load_run_id` index entry. That makes the complete candidate coverage approximately 316,850 physical writes even when no relationship changes.

This remaining write volume is intentional under the current D1-based safety design. Eliminating it would require storing the complete candidate snapshot somewhere other than D1 or introducing a substantially more complex streaming set-comparison design.

### 3.7 Apply and validation safety

The final apply is tied to one exact completed Provider Refresh job ID.

Before applying changes, the coordinator requires:

- Provider Refresh status is complete.
- Processed movie count equals selected movie count.
- Error count is zero.
- All queue messages are complete.
- The complete candidate sets are available.
- Projected subscription, ads, total relationship, and distinct movie counts pass the existing decrease protection.

The D1 batch then:

1. Deletes relationships explicitly staged as `remove`.
2. Inserts relationships explicitly staged as `add`.
3. Marks that exact run's changes as applied.
4. Removes older change-list rows.

Validation requires:

- The apply job references the exact completed Provider Refresh run.
- The cache warm references the exact apply and refresh runs.
- Live counts equal the apply job's projected counts.
- No staged addition is missing from live data.
- No staged removal remains in live data.
- The cache warm completed every selected entry without errors.

Unchanged live relationships deliberately retain their older `promotion_run_id`. A mixture of old promotion IDs is therefore expected after a change-only apply and is not data corruption.

## 4. Provider measurements

### 4.1 Per-cycle before and after

| Provider cycle | Design | Rows read | Rows written |
|---|---|---:|---:|
| August 27 baseline | Complete staging and complete live replacement | 913,823,303 | 3,073,175 |
| September 1 first optimization | Complete staging and replacement with two redundant indexes removed | 900,347,084 | 2,554,191 |
| September 1 final change-only cycle | Complete verification and candidate coverage; relationship changes only | 912,641,542 | **357,051** |

The cleanest same-day comparison is the two September 1 cycles:

| Same-day change | Reads | Writes |
|---|---:|---:|
| Numerical difference | 12,294,458 more | **2,197,140 fewer** |
| Percentage difference | 1.37% more | **86.02% fewer** |

The read difference is small relative to the 900-million-row cycle and is affected by ordinary application traffic, status checks, and which cache queries ran during the measurement window. The cache warm still causes almost all provider-cycle reads.

The write reduction is the intended result. Compared with the original August 27 baseline, the final cycle used 2,716,124 fewer writes, an 88.38% reduction.

### 4.2 Final production verification run

| Verification item | Result |
|---|---:|
| Provider Refresh job | Complete |
| Selected and processed movies | 84,395 / 84,395 |
| Changed movies | 0 |
| Staged additions | 0 |
| Staged removals | 0 |
| Live relationship changes | 0 |
| Errors | 0 |
| Subscription relationships | 186,328 |
| Subscription movies | 84,395 |
| Ad-supported movies | 74,030 |
| Total live relationships | 260,358 |
| Movies with any availability | 117,039 |
| Unapplied changes | 0 |
| Cache entries processed | 3,024 |
| Cache pages processed | 5,920 |
| Cache errors | 0 |
| Validation issues | 0 |
| Advanced Search | HTTP 200 with 20 results |

Exact production job chain:

| Stage | Job ID |
|---|---|
| Provider Refresh | `tmdb-provider-refresh-manual-1788303895526-ccbc5d40-e40e-4985-8ab4-7e1b95461e23` |
| Provider Apply | `movie-watch-providers-promote-manual-1788308000709-e6adcd19-2590-4efc-8501-a9b4c246da9a` |
| Cache Warm | `cache-warm-search-manual-1788308003167-5bbb6d1d-27f8-40d5-890f-3d6fbaa795cd` |
| Provider Validation | `provider-availability-validation-manual-1788310652280-6d5a0fcb-9507-4749-ac46-a866228227ad` |

The measured interval was September 1 at 11:04:55 PM UTC through September 2 at 12:57:33 AM UTC. It includes unavoidable ordinary application traffic and read-only monitoring during the interval. Post-completion verification queries were excluded.

## 5. Final provider schedule

### 5.1 Schedule change

| Schedule | Before | Final |
|---|---|---|
| Eastern days | Tuesday, Thursday, Saturday | Tuesday, Friday |
| Eastern time | 3:00 PM | 3:00 PM |
| Typical four-week count | 12 cycles | 8 cycles |
| Possible calendar count | 12 to 14 depending on calendar | 8 or 9 depending on calendar |

Cloudflare Cron Triggers use UTC. Both possible UTC hours are registered, and the Worker starts the job only when that trigger corresponds to 3:00 PM in `America/New_York`. This preserves the local time across daylight-saving changes without running twice.

The dependent flow remains completion-driven:

```text
Tuesday or Friday at 3:00 PM Eastern
    -> Provider Refresh
    -> Provider Apply after exact refresh success
    -> Cache Warm after exact apply success
    -> Provider Validation after cache completion
```

No fixed clock is used for the later stages.

### 5.2 Monthly provider projection

| Provider schedule | Monthly cycles | Projected reads | Projected writes |
|---|---:|---:|---:|
| Old schedule using August 27 full replacement | 12 | 10,965,879,636 | 36,878,100 |
| Final typical four-week schedule | 8 | 7,301,132,336 | 2,856,408 |
| Final nine-cycle calendar case | 9 | 8,213,773,878 | 3,213,459 |

Moving from the old 12-cycle pattern to the final eight-cycle pattern projects:

- 3,664,747,300 fewer reads per four weeks, a 33.42% reduction.
- 34,021,692 fewer writes per four weeks, a 92.25% reduction.

At eight cycles, providers consume approximately 29.20% of the 25-billion read allowance and 5.71% of the 50-million write allowance.

At nine cycles, providers consume approximately 32.86% of the read allowance and 6.43% of the write allowance.

## 6. Final weekend-pipeline changes

The weekend pipeline's schedule, source files, staging snapshots, Movie List output, cache warm, and validation sequence remain unchanged.

The net changes are limited to index write amplification and stale snapshot cleanup.

### 6.1 Smaller Movie List search indexes

Before this change, all four main Movie List search indexes repeated both changing measurements:

- TMDB popularity.
- IMDb rating and vote count.

That meant a popularity-only update also rewrote IMDb-oriented index entries, and an IMDb-only update also rewrote popularity-oriented index entries.

The final indexes separate those responsibilities:

| Index family | Changing values retained in the index |
|---|---|
| Popularity sort, all languages | Popularity |
| Popularity sort, language first | Popularity |
| IMDb sort, all languages | IMDb rating and vote count |
| IMDb sort, language first | IMDb rating and vote count |

The omitted measurement is read from the table only after SQLite selects the small requested result page. Search behavior and response fields remain the same.

This reduces writes during Movie List updates. It may add a small number of table reads for returned search rows, which is far smaller than rewriting unrelated index entries for hundreds of thousands of movies.

### 6.2 Indexed cleanup of completed old snapshots

The weekend pipeline keeps run-separated IMDb and popularity snapshots for failure safety.

The old cleanup started with millions of staging rows and repeatedly asked whether each row did **not** belong to the current, previous, or active runs. That SQL shape prevented efficient use of the primary keys whose first column is `load_run_id`.

The final cleanup starts from `import_job_runs` and selects only known finished old run IDs. It then deletes rows belonging to those eligible runs through indexed item ranges.

The retention rules remain unchanged:

| Snapshot | Protected from cleanup? |
|---|---|
| Current selected snapshot | Yes |
| Previous successfully applied snapshot | Yes |
| Queued snapshot | Yes |
| Running snapshot | Yes |
| Failed or completed older snapshot | Eligible for cleanup |

The new SQL changes how old rows are found. It does not weaken snapshot recovery.

### 6.3 Other index and schema cleanup

Two redundant provider indexes were removed:

- `idx_movie_watch_providers_tmdb_region`
- `idx_movie_watch_providers_staging_filter`

The remaining indexes already support the production lookup paths. Removing the redundant indexes avoids extra physical writes when provider-related rows change.

The unused and empty experimental table `tmdb_us_ads_movies_staging` was also removed. The final ad-supported candidate table is `tmdb_us_ads_refresh_candidates`.

## 7. Monthly cost expectations

### 7.1 What is already proven

The final provider measurement is proven in production:

| Provider frequency | Monthly reads | Monthly writes | Read allowance remaining | Write allowance remaining |
|---|---:|---:|---:|---:|
| 8 cycles | 7,301,132,336 | 2,856,408 | 17,698,867,664 | 47,143,592 |
| 9 cycles | 8,213,773,878 | 3,213,459 | 16,786,226,122 | 46,786,541 |

The provider cycle is now comfortably inside both included D1 allowances by itself.

### 7.2 Why the August 30 weekend number cannot be the final forecast

The August 30 weekend baseline ran before the smaller indexes and indexed cleanup were active.

If that old weekend number were repeated four times and combined with the final provider cycle, the project would still exceed both allowances:

| Conservative old-weekend scenario | Monthly reads | Monthly writes | Estimated base plus D1 cost |
|---|---:|---:|---:|
| 4 old weekends plus 8 final provider cycles | 33,649,058,480 | 59,446,352 | About $23.10 |
| 4 old weekends plus 9 final provider cycles | 34,561,700,022 | 59,803,403 | About $24.36 |

These figures intentionally overstate the future because they apply the old weekend SQL to the new provider design.

They exclude Queue overages, storage overages, Workers request or CPU overages, and ordinary traffic outside the measured job windows.

### 7.3 Current engineering expectation before the first revised weekend run

Query-level estimates made before the next production run projected approximately:

| Revised weekend projection | Four-week reads | Four-week writes |
|---|---:|---:|
| Weekend pipeline only | About 6.5 billion | About 49 million |

Combined with the final provider measurement:

| Provisional combined projection | Monthly reads | Monthly writes | Interpretation |
|---|---:|---:|---|
| Four weekends plus 8 provider cycles | About 13.80 billion | About 51.86 million | Reads comfortably included; writes close to the limit and possibly about 1.86 million over |
| Four weekends plus 9 provider cycles | About 14.71 billion | About 52.21 million | Reads comfortably included; writes close to the limit and possibly about 2.21 million over |

This is why the next weekend measurement matters. The current evidence supports a strong expectation that reads will be below the allowance. It does **not** yet prove that total writes will be well below the allowance.

### 7.4 Exact weekend thresholds

To remain within the included monthly limits, the average weekend run must stay below these numbers:

| Provider calendar case | Maximum reads per weekend | Maximum writes per weekend |
|---|---:|---:|
| 8 provider cycles | 4,424,716,916 | 11,785,898 |
| 9 provider cycles | 4,196,556,531 | 11,696,635 |

For a stronger 20% safety margin, using no more than 80% of either D1 allowance, the nine-provider-cycle target is:

| Operational headroom target | Reads per weekend | Writes per weekend |
|---|---:|---:|
| Four weekends plus 9 provider cycles stay below 80% of allowance | Less than 2,946,556,531 | Less than 9,196,635 |

The weekend pipeline should not be declared cost-complete until production measurements show where it lands relative to both the hard maximum and the safer headroom target.

## 8. Database migrations

| Migration | Final purpose |
|---|---|
| `0031_reduce_refresh_write_amplification.sql` | Separates popularity and IMDb values across their relevant Movie List indexes |
| `0032_remove_redundant_provider_indexes.sql` | Removes two provider indexes that added writes without helping production queries |
| `0033_remove_unused_ads_candidate_staging.sql` | Removes one unused experimental table |
| `0034_stage_only_provider_relationship_changes.sql` | Adds the ads candidate table and exact-run provider addition/removal staging table |

Production reported **no pending migrations** on September 1, 2026.

## 9. Code areas changed

| Code area | Net responsibility change |
|---|---|
| `src/imports/tmdbProviderRefresh.ts` | Compares each 25-movie TMDB result batch with current live relationships and stages only differences |
| `src/imports/movieRelationshipPromotions.ts` | Completes missing-candidate changes, projects final counts, and applies only additions and removals |
| `src/jobs/providerAvailabilityCycle.ts` | Validates projected final counts and requires zero unapplied changes |
| `src/imports/movieListBuild.ts` | Uses completed old run IDs for synchronous snapshot cleanup |
| `src/imports/movieListBuildQueue.ts` | Uses completed old run IDs and indexed ranges for queued cleanup |
| `src/jobs/scheduled.ts` | Accepts Tuesday and Friday at 3:00 PM Eastern |
| `src/jobs/scheduledCronConfig.ts` | Generated Tuesday/Friday UTC trigger definition |
| `wrangler.jsonc` | Deploys the Tuesday/Friday trigger schedule |

## 10. Verification completed

### Automated verification

| Check | Result |
|---|---|
| Worker tests | 164 passed |
| TypeScript source check | Passed |
| Wrangler deployment dry run | Passed |
| Provider scheduling test | Tuesday and Friday at 3:00 PM Eastern passed |
| Exact refresh/apply linkage test | Passed |
| Add/remove-only staging test | Passed |
| Unchanged provider cycle test | Passed with zero live rewrites |
| Missing provider removal coverage | Passed |
| Indexed Movie List cleanup tests | Passed for IMDb and popularity |

### Production verification

| Check | Result |
|---|---|
| Migrations 0031 through 0034 | Applied |
| Change-only Worker code version | `774aeb0a-0295-4247-a244-a54cda2f9a14` |
| Current effective Worker version after secret rotation | `10b6f512-befb-4b97-ab52-868f1476a28b` |
| Exact Provider Refresh and Apply chain | Passed |
| Cache warm | 3,024 entries and 5,920 pages, zero errors |
| Live provider counts | Equal projected counts |
| Unapplied provider changes | 0 |
| Advanced Search | HTTP 200 with 20 results |

The later secret rotation created a new Worker version without changing the deployed source code. No secret value belongs in this document.

## 11. Remaining production check

The remaining unknown is the first production cost measurement of the revised weekend pipeline.

The Sunday follow-up must:

1. Confirm IMDb, TMDB Primary, New Movie Details, Popularity, Movie List, cache warm, and final validation complete successfully.
2. Confirm current and previous completed IMDb and popularity snapshots remain protected.
3. Confirm completed older snapshots are removed through the indexed cleanup path.
4. Confirm live Movie List values remain correct.
5. Confirm Advanced Search succeeds.
6. Measure the narrow weekend window's D1 rows read and rows written.
7. Replace the August 30 baseline in this document with the new measurement.
8. Recalculate four weekends plus eight provider cycles.
9. Also show the nine-provider-cycle calendar case.
10. Compare both cases with the hard monthly allowance and the 20% headroom target.

The existing `verify-provider-cost-fix` monitor is scheduled for Sunday, September 6, 2026 at 2:00 PM Eastern to perform this check after the weekly pipeline finishes.

## 12. Six-month maintenance notes

If this code is revisited later, preserve these rules:

1. Do not replace the complete TMDB source check with a changed-movie feed unless TMDB explicitly guarantees watch-provider changes are complete in that feed.
2. Do not update live providers until every selected provider movie is processed without errors.
3. Keep the full subscription and ads candidate coverage so vanished movies are detected.
4. Keep provider additions and removals tied to one exact Provider Refresh run ID.
5. Keep projected-count decrease protection before apply.
6. Keep final validation based on expected live counts and zero unapplied changes.
7. Do not require unchanged live rows to have the newest `promotion_run_id`.
8. Keep provider-triggered cache warming after successful application unless the cache design itself is deliberately redesigned and measured.
9. Keep the current and previous successful IMDb and popularity snapshots during cleanup.
10. Use final production measurements rather than assuming an index or SQL-plan improvement produced the expected billing reduction.

Cloudflare analytics reference: [D1 metrics and analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
