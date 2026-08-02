import { afterEach, describe, expect, it, vi } from "vitest";
import { getTmdbMovieWatchProviders } from "../src/externalApis/tmdbClient";
import { checkImportJobDependencies } from "../src/jobs/importJobDependencies";
import type { ImportJobRunRow } from "../src/jobs/importJobRuns";
import { getEmailOutcomeLabel } from "../src/notifications/jobNotifications";
import { classifyProviderLookupOutcome } from "../src/imports/tmdbProviderRefresh";
import { insertImdbRatingQueueRows } from "../src/imports/imdbRatings";
import {
	getImdbSourceJoinSql,
	getMovieListImdbSource,
} from "../src/imports/movieListBuild";
import {
	getMovieListSourceRunIssues,
	getWeeklyImportValidationIssues,
} from "../src/jobs/weeklyImportValidation";
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
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
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
		);

		expect(result.status).toBe("HIT");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(stats.firstRequestCount).toBe(1);
		expect(stats.retryRequestCount).toBe(2);
		expect(stats.missCount).toBe(2);
		expect(stats.retryHitCount).toBe(1);
	});
});
