import { describe, expect, it, vi } from "vitest";
import {
	buildMovieListImdbCleanupMessages,
	buildMovieListPopularityRangeMessages,
	enqueueMovieListPopularityQueueWork,
	finalizeMovieListBuildQueuePhase,
	processMovieListBuildCleanupMessage,
	processMovieListPopularitySyncMessage,
} from "../src/imports/movieListBuildQueue";
import type { ImportJobRunRow } from "../src/jobs/importJobRuns";
import { handleQueue } from "../src/jobs/queueHandler";
import type {
	Env,
	MovieListBuildCleanupQueueMessage,
	MovieListBuildFinalizeQueueMessage,
	MovieListBuildQueueContext,
	MovieListPopularitySyncQueueMessage,
} from "../src/shared/types";

function buildActiveMovieListRun(): ImportJobRunRow {
	return {
		job_run_id: "movie-list-build-cron-current",
		job_name: "movie-list-build",
		status: "running",
		trigger: "cron",
		selected_count: 101,
		queued_count: 101,
		processed_count: 0,
		updated_count: 0,
		error_count: 0,
		provider_rows_inserted: 0,
		started_at: "2026-08-02 12:00:00",
		last_progress_at: "2026-08-02 12:00:00",
		ended_at: null,
		last_error: null,
		result_json: "{}",
		notification_sent_at: null,
		notification_error: null,
	};
}

function buildQueueContext(): MovieListBuildQueueContext {
	return {
		trigger: "cron",
		lockOwner: "cron-lock-owner",
		dependencyRunDate: "2026-08-02",
		startedAt: "2026-08-02T12:00:00.000Z",
		lastSuccessfulBuildEndedAt: "2026-08-01 02:26:31",
		upsertedRows: 10,
		imdbSourceJobRunId: "imdb-ratings-cron-current",
		imdbSourceMode: "run-separated",
		imdbSourceStartedAt: "2026-08-02 01:00:00",
		imdbSourceEndedAt: "2026-08-02 01:15:00",
		imdbRunWasExplicit: false,
		imdbSync: {
			candidateRows: 20,
			updatedRows: 20,
			remainingRows: 0,
			lastTmdbId: 999,
		},
		popularitySourceJobRunId: "tmdb-popularity-refresh-cron-current",
		popularitySourceStartedAt: "2026-08-02 09:00:00",
		popularitySourceEndedAt: "2026-08-02 09:40:00",
		popularityRunWasExplicit: false,
		popularityCandidateRows: 100,
		baseSelectedRows: 30,
		baseUpdatedRows: 30,
		readiness: {
			tmdbRows: 1_000,
			imdbRows: 2_000,
			tmdbRowsMissingEnrichment: 0,
			tmdbTerminalErrorRows: 0,
			movieListCandidateRows: 10,
		},
		genrePromotion: { pendingMovieCount: 1 },
	};
}

describe("queued Movie List popularity synchronization", () => {
	it("divides the TMDb identifier space into non-overlapping bounded ranges", () => {
		const messages = buildMovieListPopularityRangeMessages(
			"movie-list-build-cron-current",
			"cron-lock-owner",
			"tmdb-popularity-refresh-cron-current",
			25_001,
		);

		expect(messages).toHaveLength(3);
		expect(
			messages.map((message) => [
				message.firstTmdbIdExclusive,
				message.lastTmdbIdInclusive,
			]),
		).toEqual([
			[0, 10_000],
			[10_000, 20_000],
			[20_000, 25_001],
		]);
	});

	it("partitions IMDb cleanup into 1,000 index-ordered string ranges", () => {
		const messages = buildMovieListImdbCleanupMessages(
			"movie-list-build-cron-current",
			"cron-lock-owner",
			"imdb-ratings-cron-current",
			"imdb-ratings-cron-previous",
		);

		expect(messages).toHaveLength(1_000);
		expect(messages[0]).toMatchObject({
			lowerImdbIdInclusive: null,
			upperImdbIdExclusive: "tt001",
		});
		expect(messages[1]).toMatchObject({
			lowerImdbIdInclusive: "tt001",
			upperImdbIdExclusive: "tt002",
		});
		expect(messages[999]).toMatchObject({
			lowerImdbIdInclusive: "tt999",
			upperImdbIdExclusive: null,
		});
	});

	it.each([
		{
			stage: "imdb-cleanup" as const,
			expectedTable: "imdb_ratings_staging_by_run",
			expectedJobName: "imdb-ratings",
			range: {
				lowerImdbIdInclusive: "tt100",
				upperImdbIdExclusive: "tt101",
			},
		},
		{
			stage: "popularity-cleanup" as const,
			expectedTable: "tmdb_movie_popularity_staging",
			expectedJobName: "tmdb-popularity-refresh",
			range: {
				firstTmdbIdExclusive: 10_000,
				lastTmdbIdInclusive: 20_000,
			},
		},
	])(
		"selects stale $stage runs before applying the primary-key range",
		async ({ stage, expectedTable, expectedJobName, range }) => {
			const batchStatements: Array<{ sql: string; bindings: unknown[] }> = [];
			const env = {
				DB: {
					prepare(sql: string) {
						return {
							sql,
							bindings: [] as unknown[],
							bind(...bindings: unknown[]) {
								this.bindings = bindings;
								return this;
							},
							async first() {
								return buildActiveMovieListRun();
							},
						};
					},
					async batch(statements: Array<{ sql: string; bindings: unknown[] }>) {
						batchStatements.push(...statements);
						return [
							{ meta: { changes: 25 } },
							{ meta: { changes: 1 } },
							{ meta: { changes: 1 } },
							{ meta: { changes: 1 } },
						];
					},
				},
			} as unknown as Env;
			const message: MovieListBuildCleanupQueueMessage = {
				kind: "movie-list-build-cleanup",
				jobRunId: "movie-list-build-cron-current",
				messageId: `movie-list-build-cron-current-${stage}-range`,
				lockOwner: "cron-lock-owner",
				stage,
				selectedRunId: `${expectedJobName}-cron-current`,
				previousAppliedRunId: `${expectedJobName}-cron-previous`,
				...range,
			};

			const result = await processMovieListBuildCleanupMessage(env, message);

			expect(result).toEqual({ deletedRows: 25, completionRecorded: true });
			const cleanup = batchStatements[0];
			expect(cleanup.sql).toContain(`DELETE FROM ${expectedTable}`);
			expect(cleanup.sql).toContain("WHERE load_run_id IN");
			expect(cleanup.sql).toContain(
				"status NOT IN ('queued', 'running')",
			);
			expect(cleanup.sql).toContain("AND job_run_id <> ?");
			expect(cleanup.bindings.slice(0, 3)).toEqual([
				expectedJobName,
				`${expectedJobName}-cron-current`,
				`${expectedJobName}-cron-previous`,
			]);
		},
	);

	it("adds a completion sentinel before sending popularity ranges", async () => {
		const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const send = vi.fn().mockResolvedValue(undefined);
		const env = {
			DB: {
				prepare(sql: string) {
					const statement = {
						sql,
						bindings: [] as unknown[],
						bind(...bindings: unknown[]) {
							this.bindings = bindings;
							prepared.push({ sql, bindings });
							return this;
						},
						async first() {
							return { maxTmdbId: 25_001 };
						},
						async run() {
							return { meta: { changes: 1 } };
						},
					};
					return statement;
				},
			},
			MOVIE_LIST_BUILD_QUEUE: { sendBatch, send },
		} as unknown as Env;

		const result = await enqueueMovieListPopularityQueueWork(
			env,
			"movie-list-build-cron-current",
			buildQueueContext(),
		);

		expect(result.queued).toBe(true);
		expect(sendBatch).toHaveBeenCalledOnce();
		expect(sendBatch.mock.calls[0][0]).toHaveLength(3);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "movie-list-build-finalize",
				stage: "popularity-sync",
				expectedMessageCount: 3,
			}),
		);
		const progressUpdate = prepared.find(({ sql }) =>
			sql.includes("SET status = 'running'"),
		);
		expect(progressUpdate?.bindings.slice(0, 4)).toEqual([
			131,
			131,
			30,
			30,
		]);
	});

	it("records one popularity range and guards duplicate progress", async () => {
		const preparedSql: string[] = [];
		const batchSql: string[] = [];
		const env = {
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
			DB: {
				prepare(sql: string) {
					preparedSql.push(sql);
					return {
						sql,
						bind() {
							return this;
						},
						async first() {
							if (sql.includes("FROM import_job_runs")) {
								return buildActiveMovieListRun();
							}
							return { candidateRows: 12 };
						},
					};
				},
				async batch(statements: Array<{ sql: string }>) {
					batchSql.push(...statements.map((statement) => statement.sql));
					return [
						{ meta: { changes: 12 } },
						{ meta: { changes: 1 } },
						{ meta: { changes: 1 } },
					];
				},
			},
		} as unknown as Env;
		const message: MovieListPopularitySyncQueueMessage = {
			kind: "movie-list-popularity-sync",
			jobRunId: "movie-list-build-cron-current",
			messageId: "movie-list-build-cron-current-popularity-sync-0000010000",
			lockOwner: "cron-lock-owner",
			popularityRunId: "tmdb-popularity-refresh-cron-current",
			firstTmdbIdExclusive: 0,
			lastTmdbIdInclusive: 10_000,
		};

		const result = await processMovieListPopularitySyncMessage(env, message);

		expect(result).toMatchObject({
			candidateRows: 12,
			updatedRows: 12,
			completionRecorded: true,
		});
		expect(preparedSql.join("\n")).toContain("movie.tmdb_id > ?");
		expect(batchSql.join("\n")).toContain(
			"INSERT OR IGNORE INTO import_job_queue_messages",
		);
		expect(batchSql.join("\n")).toContain("AND changes() > 0");
	});

	it("fails the build and releases its lock when a range changes fewer rows than it selected", async () => {
		const preparedSql: string[] = [];
		const env = {
			JOB_NOTIFICATION_EMAIL_ENABLED: "false",
			DB: {
				prepare(sql: string) {
					preparedSql.push(sql);
					return {
						sql,
						bind() {
							return this;
						},
						async first() {
							if (sql.includes("FROM import_job_runs")) {
								return buildActiveMovieListRun();
							}
							return { candidateRows: 12 };
						},
						async run() {
							return { meta: { changes: 1 } };
						},
					};
				},
				async batch() {
					return [
						{ meta: { changes: 11 } },
						{ meta: { changes: 1 } },
						{ meta: { changes: 1 } },
					];
				},
			},
		} as unknown as Env;
		const message: MovieListPopularitySyncQueueMessage = {
			kind: "movie-list-popularity-sync",
			jobRunId: "movie-list-build-cron-current",
			messageId: "movie-list-build-cron-current-popularity-sync-0000010000",
			lockOwner: "cron-lock-owner",
			popularityRunId: "tmdb-popularity-refresh-cron-current",
			firstTmdbIdExclusive: 0,
			lastTmdbIdInclusive: 10_000,
		};

		await expect(
			processMovieListPopularitySyncMessage(env, message),
		).rejects.toThrow("selected 12 difference(s) but changed 11");
		expect(preparedSql.join("\n")).toContain("SET status = 'failed'");
		expect(preparedSql.join("\n")).toContain(
			"DELETE FROM import_job_locks",
		);
	});

	it("keeps the finalizer waiting until every range reports completion", async () => {
		const releaseRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind() {
							return this;
						},
						async first() {
							if (sql.includes("FROM import_job_runs")) {
								return buildActiveMovieListRun();
							}
							return { completedMessageCount: 2 };
						},
						async run() {
							return releaseRun();
						},
					};
				},
			},
		} as unknown as Env;
		const message: MovieListBuildFinalizeQueueMessage = {
			kind: "movie-list-build-finalize",
			jobRunId: "movie-list-build-cron-current",
			messageId: "movie-list-build-cron-current-popularity-sync-finalize",
			stage: "popularity-sync",
			expectedMessageCount: 3,
			context: buildQueueContext(),
		};

		const result = await finalizeMovieListBuildQueuePhase(env, message);

		expect(result).toEqual({
			pending: true,
			completedMessageCount: 2,
			expectedMessageCount: 3,
		});
		expect(releaseRun).not.toHaveBeenCalled();
	});

	it("counts completed phase messages without a LIKE pattern", async () => {
		const preparedSql: string[] = [];
		const preparedBindings: unknown[][] = [];
		const env = {
			DB: {
				prepare(sql: string) {
					preparedSql.push(sql);
					return {
						bind(...bindings: unknown[]) {
							preparedBindings.push(bindings);
							return this;
						},
						async first() {
							if (sql.includes("FROM import_job_runs")) {
								return buildActiveMovieListRun();
							}
							return { completedMessageCount: 2 };
						},
					};
				},
			},
		} as unknown as Env;
		const message: MovieListBuildFinalizeQueueMessage = {
			kind: "movie-list-build-finalize",
			jobRunId: "movie-list-build-cron-current",
			messageId: "movie-list-build-cron-current-popularity-sync-finalize",
			stage: "popularity-sync",
			expectedMessageCount: 3,
			context: buildQueueContext(),
		};

		await finalizeMovieListBuildQueuePhase(env, message);

		const countSqlIndex = preparedSql.findIndex((sql) =>
			sql.includes("import_job_queue_messages"),
		);
		expect(preparedSql[countSqlIndex]).toContain(
			"substr(message_id, 1, ?) = ?",
		);
		expect(preparedSql[countSqlIndex]).not.toContain("LIKE");
		expect(preparedBindings[countSqlIndex]).toEqual([
			"movie-list-build-cron-current",
			"movie-list-build",
			"movie-list-build-cron-current-popularity-sync-".length,
			"movie-list-build-cron-current-popularity-sync-",
		]);
	});

	it("acknowledges a waiting finalizer and sends a fresh delayed check", async () => {
		const acknowledge = vi.fn();
		const retry = vi.fn();
		const send = vi.fn().mockResolvedValue(undefined);
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind() {
							return this;
						},
						async first() {
							if (sql.includes("FROM import_job_runs")) {
								return buildActiveMovieListRun();
							}
							return { completedMessageCount: 2 };
						},
					};
				},
			},
			MOVIE_LIST_BUILD_QUEUE: { send },
		} as unknown as Env;
		const body: MovieListBuildFinalizeQueueMessage = {
			kind: "movie-list-build-finalize",
			jobRunId: "movie-list-build-cron-current",
			messageId: "movie-list-build-cron-current-popularity-sync-finalize",
			stage: "popularity-sync",
			expectedMessageCount: 3,
			context: buildQueueContext(),
		};
		const batch = {
			queue: "movieapp-movie-list-build-queue",
			messages: [{ body, ack: acknowledge, retry }],
		} as unknown as MessageBatch<never>;

		await handleQueue(batch, env);

		expect(send).toHaveBeenCalledWith(
			{ ...body, finalizerCheckCount: 1 },
			{ delaySeconds: 30 },
		);
		expect(acknowledge).toHaveBeenCalledOnce();
		expect(retry).not.toHaveBeenCalled();
	});

	it("ignores a stale finalizer after the build has advanced to a later phase", async () => {
		const laterPhaseRun = {
			...buildActiveMovieListRun(),
			result_json: JSON.stringify({ phase: "imdb-cleanup" }),
		};
		const env = {
			DB: {
				prepare() {
					return {
						bind() {
							return this;
						},
						async first() {
							return laterPhaseRun;
						},
					};
				},
			},
		} as unknown as Env;
		const message: MovieListBuildFinalizeQueueMessage = {
			kind: "movie-list-build-finalize",
			jobRunId: "movie-list-build-cron-current",
			messageId: "movie-list-build-cron-current-popularity-sync-finalize",
			stage: "popularity-sync",
			expectedMessageCount: 3,
			context: buildQueueContext(),
		};

		const result = await finalizeMovieListBuildQueuePhase(env, message);

		expect(result).toMatchObject({
			pending: false,
			ignored: true,
			reason: "phase_already_advanced",
			currentPhase: "imdb-cleanup",
		});
	});

	it("skips run-separated IMDb cleanup when the selected source uses the legacy table", async () => {
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const send = vi.fn().mockResolvedValue(undefined);
		const legacyContext = {
			...buildQueueContext(),
			imdbSourceMode: "legacy-time-window" as const,
		};
		const activeRun = {
			...buildActiveMovieListRun(),
			result_json: JSON.stringify({ phase: "popularity-sync" }),
		};
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind() {
							return this;
						},
						async first() {
							if (sql.includes("FROM import_job_runs")) {
								return activeRun;
							}
							if (sql.includes("import_job_queue_messages")) {
								return { completedMessageCount: 0 };
							}
							return { candidateRows: 0 };
						},
						async run() {
							return { meta: { changes: 1 } };
						},
					};
				},
			},
			MOVIE_LIST_BUILD_QUEUE: { sendBatch, send },
		} as unknown as Env;
		const message: MovieListBuildFinalizeQueueMessage = {
			kind: "movie-list-build-finalize",
			jobRunId: "movie-list-build-cron-current",
			messageId: "movie-list-build-cron-current-popularity-sync-finalize",
			stage: "popularity-sync",
			expectedMessageCount: 0,
			context: legacyContext,
		};

		const result = await finalizeMovieListBuildQueuePhase(env, message);

		expect(result).toMatchObject({ transitionedTo: "imdb-cleanup" });
		expect(sendBatch).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "imdb-cleanup",
				expectedMessageCount: 0,
				context: expect.objectContaining({
					imdbCleanupSkipped: true,
					imdbCleanupSkipReason: "legacy_time_window_source",
				}),
			}),
		);
	});

	it("uses the exact SQL binding count when run-separated cleanup begins", async () => {
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const send = vi.fn().mockResolvedValue(undefined);
		const activeRun = {
			...buildActiveMovieListRun(),
			result_json: JSON.stringify({ phase: "popularity-sync" }),
		};
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind(...bindings: unknown[]) {
							const placeholderCount = (sql.match(/\?/g) ?? []).length;
							if (bindings.length !== placeholderCount) {
								throw new Error(
									`SQL expected ${placeholderCount} binding(s), received ${bindings.length}.`,
								);
							}
							return this;
						},
						async first() {
							if (
								sql.includes("FROM import_job_runs") &&
								sql.includes("job_run_id = ?")
							) {
								return activeRun;
							}
							if (sql.includes("import_job_queue_messages")) {
								return { completedMessageCount: 0 };
							}
							if (sql.includes("AS candidateRows")) {
								return { candidateRows: 0 };
							}
							if (sql.includes("AS sourceRunId")) {
								return { sourceRunId: "imdb-ratings-cron-previous" };
							}
							return { oldRows: 0 };
						},
						async run() {
							return { meta: { changes: 1 } };
						},
					};
				},
			},
			MOVIE_LIST_BUILD_QUEUE: { sendBatch, send },
		} as unknown as Env;
		const message: MovieListBuildFinalizeQueueMessage = {
			kind: "movie-list-build-finalize",
			jobRunId: "movie-list-build-cron-current",
			messageId: "movie-list-build-cron-current-popularity-sync-finalize",
			stage: "popularity-sync",
			expectedMessageCount: 0,
			context: buildQueueContext(),
		};

		const result = await finalizeMovieListBuildQueuePhase(env, message);

		expect(result).toMatchObject({ transitionedTo: "imdb-cleanup" });
		expect(sendBatch).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "imdb-cleanup",
				expectedMessageCount: 0,
			}),
		);
	});
});
