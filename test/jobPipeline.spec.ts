import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getTmdbMovieWatchProviders,
	getTmdbUsAdsDiscoverPage,
} from "../src/externalApis/tmdbClient";
import { checkImportJobDependencies } from "../src/jobs/importJobDependencies";
import type { ImportJobRunRow } from "../src/jobs/importJobRuns";
import {
	getEmailOutcomeLabel,
	getJobNotificationSubject,
	getJobTitle,
} from "../src/notifications/jobNotifications";
import {
	classifyProviderLookupOutcome,
	enqueueTmdbProviderRefreshJob,
} from "../src/imports/tmdbProviderRefresh";
import { promotePendingMovieWatchProviders } from "../src/imports/movieRelationshipPromotions";
import { insertImdbRatingQueueRows } from "../src/imports/imdbRatings";
import {
	getImdbSourceJoinSql,
	getMovieListImdbSource,
} from "../src/imports/movieListBuild";
import {
	getMovieListSourceRunIssues,
	getWeeklyImportValidationIssues,
	MOVIE_LIST_SUCCESS_JOB_NAMES,
	REQUIRED_WEEKLY_IMPORT_JOB_NAMES,
} from "../src/jobs/weeklyImportValidation";
import { isIndependentProviderRefreshTime } from "../src/jobs/scheduled";
import {
	SCHEDULED_CACHE_WARM_ALL_GENRES_CRON,
	SCHEDULED_IMDB_CRON,
	SCHEDULED_MOVIE_LIST_BUILD_CRON,
	SCHEDULED_TMDB_NEW_MOVIE_DETAILS_CRON,
	SCHEDULED_TMDB_POPULARITY_CRON,
	SCHEDULED_TMDB_PRIMARY_CRON,
	SCHEDULED_TMDB_PROVIDER_REFRESH_CRON,
	SCHEDULED_WEEKLY_IMPORT_VALIDATION_CRON,
} from "../src/jobs/scheduledCronConfig";
import {
	getProviderAvailabilityCountIssues,
	type ProviderAvailabilityCounts,
} from "../src/jobs/providerAvailabilityCycle";
import {
	handleQueue,
	IMPORT_DEAD_LETTER_QUEUE_NAME,
} from "../src/jobs/queueHandler";
import type { Env } from "../src/shared/types";
import { warmCachePage } from "../src/cache/cacheWarmQueue";
import type { CacheWarmSearchStats } from "../src/cache/cacheWarmTypes";

function buildRun(overrides: Partial<ImportJobRunRow> = {}): ImportJobRunRow {
	return {
		job_run_id: "imdb-ratings-cron-current",
		job_name: "imdb-ratings",
		status: "complete",
		trigger: "cron",
		selected_count: 100,
		queued_count: 100,
		processed_count: 100,
		updated_count: 100,
		error_count: 0,
		provider_rows_inserted: 0,
		started_at: "2026-07-27 01:00:00",
		last_progress_at: "2026-07-27 01:30:00",
		ended_at: "2026-07-27 01:30:00",
		last_error: null,
		result_json: "{}",
		notification_sent_at: "2026-07-27 01:30:01",
		notification_error: null,
		...overrides,
	};
}

describe("weekly import job safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks only the requested pipeline date instead of consulting old active runs", async () => {
		const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
		const currentRun = buildRun();
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bindings: [] as unknown[],
						bind(...bindings: unknown[]) {
							this.bindings = bindings;
							prepared.push({ sql, bindings });
							return this;
						},
						async first() {
							return currentRun;
						},
					};
				},
			},
		} as unknown as Env;

		const result = await checkImportJobDependencies(
			env,
			[{ jobName: "imdb-ratings" }],
			"2026-07-27",
		);

		expect(result.ok).toBe(true);
		expect(result.runs["imdb-ratings"]).toEqual(currentRun);
		expect(prepared).toHaveLength(1);
		expect(prepared[0].bindings).toEqual([
			"imdb-ratings",
			"2026-07-27",
			"2026-07-27",
		]);
		expect(prepared[0].sql).toContain("started_at >= ? || ' 00:00:00'");
		expect(prepared[0].sql).not.toContain(
			"status IN ('queued', 'running')",
		);
	});

	it("keeps the provider refresh independent from the weekly required-job lists", () => {
		expect(REQUIRED_WEEKLY_IMPORT_JOB_NAMES).not.toContain(
			"tmdb-provider-refresh",
		);
		expect(MOVIE_LIST_SUCCESS_JOB_NAMES).not.toContain(
			"movie-watch-providers-promote",
		);
	});

	it("uses the approved weekly times after removing the old provider slot", () => {
		expect({
			imdb: SCHEDULED_IMDB_CRON,
			tmdbPrimary: SCHEDULED_TMDB_PRIMARY_CRON,
			newMovieDetails: SCHEDULED_TMDB_NEW_MOVIE_DETAILS_CRON,
			provider: SCHEDULED_TMDB_PROVIDER_REFRESH_CRON,
			popularity: SCHEDULED_TMDB_POPULARITY_CRON,
			movieList: SCHEDULED_MOVIE_LIST_BUILD_CRON,
			cacheWarm: SCHEDULED_CACHE_WARM_ALL_GENRES_CRON,
			weeklyValidation: SCHEDULED_WEEKLY_IMPORT_VALIDATION_CRON,
		}).toEqual({
			imdb: "0 1 * * 1",
			tmdbPrimary: "0 3 * * 1",
			newMovieDetails: "0 5 * * 1",
			provider: "0 19,20 * * TUE,THU,SAT",
			popularity: "0 7 * * 1",
			movieList: "0 10 * * 1",
			cacheWarm: "0 11 * * 1",
			weeklyValidation: "0 13 * * 1",
		});
	});

	it("starts the independent provider refresh at 3 PM Eastern in summer and winter", () => {
		// Tuesday, August 4, 2026: New York is on daylight time (UTC-4).
		expect(
			isIndependentProviderRefreshTime(Date.parse("2026-08-04T19:00:00Z")),
		).toBe(true);
		expect(
			isIndependentProviderRefreshTime(Date.parse("2026-08-04T20:00:00Z")),
		).toBe(false);

		// Tuesday, December 1, 2026: New York is on standard time (UTC-5).
		expect(
			isIndependentProviderRefreshTime(Date.parse("2026-12-01T19:00:00Z")),
		).toBe(false);
		expect(
			isIndependentProviderRefreshTime(Date.parse("2026-12-01T20:00:00Z")),
		).toBe(true);
	});

	it("stops a provider replacement when the completed snapshot drops too far", () => {
		const current: ProviderAvailabilityCounts = {
			subscriptionRelationshipCount: 100,
			subscriptionMovieCount: 100,
			adsMovieCount: 100,
			totalAvailabilityRelationshipCount: 100,
			availabilityMovieCount: 100,
		};
		const exactlyAllowed: ProviderAvailabilityCounts = {
			subscriptionRelationshipCount: 90,
			subscriptionMovieCount: 90,
			adsMovieCount: 90,
			totalAvailabilityRelationshipCount: 90,
			availabilityMovieCount: 90,
		};
		const unsafe: ProviderAvailabilityCounts = {
			...exactlyAllowed,
			totalAvailabilityRelationshipCount: 89,
		};

		expect(
			getProviderAvailabilityCountIssues(current, exactlyAllowed),
		).toEqual([]);
		expect(getProviderAvailabilityCountIssues(current, unsafe)).toEqual([
			"all availability relationships dropped 11.00% from 100 to 89; allowed decrease 10%.",
		]);
	});

	it("never replaces live providers with an empty completed snapshot", () => {
		const empty: ProviderAvailabilityCounts = {
			subscriptionRelationshipCount: 0,
			subscriptionMovieCount: 0,
			adsMovieCount: 0,
			totalAvailabilityRelationshipCount: 0,
			availabilityMovieCount: 0,
		};

		expect(getProviderAvailabilityCountIssues(empty, empty)).toEqual([
			"The completed provider refresh contains no availability rows.",
		]);
	});

	it("treats a TMDB provider 404 as an accepted unavailable outcome", () => {
		const outcome = classifyProviderLookupOutcome(
			null,
			new Error("TMDB request failed: 404 Not Found"),
		);

		expect(outcome).toEqual({ kind: "movie_unavailable" });
	});

	it("does not repeatedly request a provider resource after TMDB returns 404", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 404, statusText: "Not Found" }));
		const env = { TMDB_API_KEY: "test-key" } as Env;

		await expect(getTmdbMovieWatchProviders(123, env)).rejects.toThrow(
			"TMDB request failed: 404 Not Found",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("starts Provider Refresh without requiring same-day weekly TMDb jobs", async () => {
		const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
		const send = vi.fn().mockResolvedValue(undefined);
		const env = {
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
			DB: {
				prepare(sql: string) {
					const call = { sql, bindings: [] as unknown[] };
					prepared.push(call);
					return {
						bind(...bindings: unknown[]) {
							call.bindings = bindings;
							return this;
						},
						async all() {
							return { results: [] };
						},
						async first() {
							return null;
						},
						async run() {
							return { meta: { changes: 1 } };
						},
					};
				},
				async batch() {
					return [{ meta: { changes: 1 } }];
				},
			},
			TMDB_ENRICHMENT_QUEUE: { send },
		} as unknown as Env;

		const result = await enqueueTmdbProviderRefreshJob(env, {
			trigger: "manual",
			useLock: false,
			nowMs: Date.parse("2026-08-04T19:00:00Z"),
		});
		const allBindings = prepared.flatMap(({ bindings }) => bindings);

		expect(result).toMatchObject({
			trigger: "manual",
			phase: "candidate_discovery",
			discoveryQueued: true,
		});
		expect(send).toHaveBeenCalledOnce();
		expect(allBindings).not.toContain("tmdb-primary");
		expect(allBindings).not.toContain("tmdb-new-movie-details");
	});

	it("applies provider rows from the exact completed refresh run", async () => {
		type FakeStatement = {
			sql: string;
			bindings: unknown[];
			bind: (...bindings: unknown[]) => FakeStatement;
			first: () => Promise<unknown>;
			run: () => Promise<{ meta: { changes: number } }>;
		};
		const exactRefreshRunId = "tmdb-provider-refresh-cron-exact";
		const batchStatements: FakeStatement[] = [];
		const env = {
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
			DB: {
				prepare(sql: string) {
					const statement: FakeStatement = {
						sql,
						bindings: [],
						bind(...bindings: unknown[]) {
							this.bindings = bindings;
							return this;
						},
						async first() {
							if (sql.includes("WHERE job_run_id = ?")) {
								return buildRun({
									job_run_id: exactRefreshRunId,
									job_name: "tmdb-provider-refresh",
								});
							}

							return {
								pendingMovieCount: 80_000,
								pendingProviderCount: 190_000,
								pendingAvailabilityRelationshipCount: 260_000,
								adsSupportedMovieCount: 70_000,
								fullRefreshPendingMovieCount: 80_000,
								fullRefreshPendingProviderCount: 190_000,
								fullRefreshPendingAvailabilityRelationshipCount: 260_000,
								fullRefreshAdsSupportedMovieCount: 70_000,
							};
						},
						async run() {
							return { meta: { changes: 1 } };
						},
					};
					return statement;
				},
				async batch(statements: FakeStatement[]) {
					batchStatements.push(...statements);
					return statements.map(() => ({ meta: { changes: 1 } }));
				},
			},
		} as unknown as Env;

		await promotePendingMovieWatchProviders(
			env,
			"cron",
			exactRefreshRunId,
		);
		const insert = batchStatements.find(({ sql }) =>
			sql.includes("INSERT OR REPLACE INTO movie_watch_providers"),
		);
		const markApplied = batchStatements.find(({ sql }) =>
			sql.includes("UPDATE movie_watch_providers_staging"),
		);

		expect(insert?.sql).toContain("load_run_id = ?");
		expect(insert?.bindings.at(-1)).toBe(exactRefreshRunId);
		expect(markApplied?.bindings).toEqual([exactRefreshRunId]);
	});

	it("discovers US ad-supported movies without making per-movie provider requests", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ page: 1, total_pages: 1, results: [{ id: 123456 }] }),
		);
		const env = { TMDB_API_KEY: "test-key" } as Env;

		const result = await getTmdbUsAdsDiscoverPage(
			1,
			"2020-01-01",
			env,
			"2026-08-02",
		);

		expect(result.results).toEqual([{ id: 123456 }]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
		expect(requestedUrl.pathname).toBe("/3/discover/movie");
		expect(requestedUrl.searchParams.get("watch_region")).toBe("US");
		expect(
			requestedUrl.searchParams.get("with_watch_monetization_types"),
		).toBe("ads");
	});

	it("flags an incomplete running job and its mismatched work count", () => {
		const issues = getWeeklyImportValidationIssues(
			"imdb-ratings",
			buildRun({
				status: "running",
				processed_count: 75,
				ended_at: null,
			}),
		);

		expect(issues.map((issue) => issue.code)).toEqual([
			"not_complete",
			"missing_end_time",
			"processed_count_mismatch",
		]);
	});

	it("flags a finished job whose completion email was not accepted", () => {
		const issues = getWeeklyImportValidationIssues(
			"movie-list-build",
			buildRun({
				job_name: "movie-list-build",
				notification_sent_at: null,
				notification_error: "SMTP connection timed out",
			}),
		);

		expect(issues.map((issue) => issue.code)).toEqual([
			"notification_failed",
		]);
		expect(issues[0].message).toContain("SMTP connection timed out");
	});

	it("puts an unmistakable outcome at the front of email subjects", () => {
		expect(getEmailOutcomeLabel("complete")).toBe("SUCCESS");
		expect(getEmailOutcomeLabel("failed")).toBe("FAILED");
		expect(getEmailOutcomeLabel("complete_with_errors")).toBe("FAILED");
		expect(getEmailOutcomeLabel("skipped")).toBe("ACTION REQUIRED");
	});

	it("fails final validation when Movie List used a different popularity run", () => {
		const movieListRun = buildRun({
			job_run_id: "movie-list-build-cron-current",
			job_name: "movie-list-build",
			result_json: JSON.stringify({
				imdbSourceJobRunId: "imdb-ratings-cron-current",
				popularitySourceJobRunId: "tmdb-popularity-refresh-cron-old",
			}),
		});
		const issues = getMovieListSourceRunIssues(movieListRun, {
			"imdb-ratings": buildRun(),
			"tmdb-popularity-refresh": buildRun({
				job_run_id: "tmdb-popularity-refresh-cron-current",
				job_name: "tmdb-popularity-refresh",
			}),
		});

		expect(issues).toHaveLength(1);
		expect(issues[0].code).toBe("source_run_mismatch");
		expect(issues[0].message).toContain(
			"tmdb-popularity-refresh-cron-current",
		);
	});

	it("changes a job to failed when a queue message exhausts all retries", async () => {
		const preparedSql: string[] = [];
		const acknowledge = vi.fn();
		const env = {
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
			DB: {
				prepare(sql: string) {
					preparedSql.push(sql);
					return {
						bind() {
							return this;
						},
						async run() {
							return { meta: { changes: 1 } };
						},
					};
				},
			},
		} as unknown as Env;
		const batch = {
			queue: IMPORT_DEAD_LETTER_QUEUE_NAME,
			messages: [
				{
					id: "dead-letter-message-1",
					body: {
						kind: "imdb-ratings",
						jobRunId: "imdb-ratings-cron-current",
						messageId: "imdb-message-99",
						rows: [],
					},
					ack: acknowledge,
				},
			],
		} as unknown as MessageBatch<never>;

		await handleQueue(batch, env);

		expect(acknowledge).toHaveBeenCalledOnce();
		expect(preparedSql.join("\n")).toContain("SET status = 'failed'");
	});

	it("releases the Movie List lock when one of its queue messages exhausts all retries", async () => {
		const preparedSql: string[] = [];
		const acknowledge = vi.fn();
		const env = {
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
			DB: {
				prepare(sql: string) {
					preparedSql.push(sql);
					return {
						bind() {
							return this;
						},
						async run() {
							return { meta: { changes: 1 } };
						},
					};
				},
			},
		} as unknown as Env;
		const batch = {
			queue: IMPORT_DEAD_LETTER_QUEUE_NAME,
			messages: [
				{
					id: "dead-letter-message-2",
					body: {
						kind: "movie-list-popularity-sync",
						jobRunId: "movie-list-build-cron-current",
						messageId: "movie-list-popularity-message-99",
						lockOwner: "cron-lock-owner",
						popularityRunId: "tmdb-popularity-refresh-cron-current",
						firstTmdbIdExclusive: 0,
						lastTmdbIdInclusive: 10_000,
					},
					ack: acknowledge,
				},
			],
		} as unknown as MessageBatch<never>;

		await handleQueue(batch, env);

		expect(acknowledge).toHaveBeenCalledOnce();
		expect(preparedSql.join("\n")).toContain("SET status = 'failed'");
		expect(preparedSql.join("\n")).toContain(
			"DELETE FROM import_job_locks",
		);
	});

	it("keeps the former IMDb snapshot unchanged during run-separated imports", async () => {
		type FakeStatement = {
			sql: string;
			bind: (...values: unknown[]) => FakeStatement;
		};
		let batchedSql: string[] = [];
		const env = {
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
			DB: {
				prepare(sql: string): FakeStatement {
					return {
						sql,
						bind() {
							return this;
						},
					};
				},
				async batch(statements: FakeStatement[]) {
					batchedSql = statements.map((statement) => statement.sql);
					return statements.map(() => ({ meta: { changes: 1 } }));
				},
			},
		} as unknown as Env;

		await insertImdbRatingQueueRows(
			env,
			[
				{
					imdb_id: "tt0133093",
					average_rating: 8.7,
					num_votes: 2100000,
				},
			],
			"imdb-ratings-manual-new-run",
			"imdb-ratings-manual-new-run-000001",
		);

		expect(batchedSql.join("\n")).toContain(
			"INSERT INTO imdb_ratings_staging_by_run",
		);
		expect(batchedSql.join("\n")).not.toMatch(
			/INSERT INTO imdb_ratings_staging\s*\(/,
		);
	});

	it("selects an exact IMDb load partition after a full run is validated", () => {
		const run = buildRun({
			job_run_id: "imdb-ratings-cron-run-separated",
			result_json: JSON.stringify({
				isFullImport: true,
				stagedRows: 1700000,
				validationIssueCount: 0,
			}),
		});
		const source = getMovieListImdbSource(run);
		const sql = getImdbSourceJoinSql(source);

		expect(source.mode).toBe("run-separated");
		expect(sql.tableName).toBe("imdb_ratings_staging_by_run");
		expect(sql.predicate).toBe("imdb.load_run_id = ?");
		expect(sql.bindings).toEqual([run.job_run_id]);
	});

	it("keeps the proven time boundary only for a pre-migration IMDb run", () => {
		const run = buildRun({ result_json: "{}" });
		const source = getMovieListImdbSource(run);
		const sql = getImdbSourceJoinSql(source);

		expect(source.mode).toBe("legacy-time-window");
		expect(sql.tableName).toBe("imdb_ratings_staging");
		expect(sql.bindings).toEqual([run.started_at, run.ended_at]);
	});

	it("confirms a cache write again when the immediate retry also misses", async () => {
		const requestMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", {
					headers: { "x-movieapp-cache": "MISS" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("{}", {
					headers: { "x-movieapp-cache": "MISS" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("{}", {
					headers: { "x-movieapp-cache": "HIT" },
				}),
			);
		const stats: CacheWarmSearchStats = {
			pageCount: 0,
			firstRequestCount: 0,
			retryRequestCount: 0,
			hitCount: 0,
			missCount: 0,
			retryHitCount: 0,
			errorCount: 0,
			lastError: null,
		};

		const result = await warmCachePage(
			"https://example.com/movies/search?pageSize=20",
			stats,
			requestMock,
		);

		expect(result.status).toBe("HIT");
		expect(requestMock).toHaveBeenCalledTimes(3);
		expect(stats.firstRequestCount).toBe(1);
		expect(stats.retryRequestCount).toBe(2);
		expect(stats.missCount).toBe(2);
		expect(stats.retryHitCount).toBe(1);
	});

	it("names the final provider email as a summary report and puts its outcome after the title", () => {
		expect(getJobTitle("provider-availability-validation")).toBe(
			"Provider Refresh Job Summary Report",
		);
		expect(
			getJobNotificationSubject(
				"provider-availability-validation",
				"complete",
				"12 seconds",
			),
		).toBe(
			"[MovieApp] Provider Refresh Job Summary Report: SUCCESS (complete, 12 seconds)",
		);
		expect(
			getJobNotificationSubject(
				"provider-availability-validation",
				"failed",
				"1 second",
			),
		).toBe(
			"[MovieApp] Provider Refresh Job Summary Report: FAILED (failed, 1 second)",
		);
	});
});
