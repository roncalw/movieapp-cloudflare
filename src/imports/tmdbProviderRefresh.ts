import {
	getTmdbMovieWatchProviders,
	getTmdbUsFlatrateDiscoverPage,
	getUsFlatrateProviderIdsFromWatchProviders,
	isTerminalTmdbEnrichmentError,
	TMDB_DISCOVER_MAX_PAGE,
} from "../externalApis/tmdbClient";
import {
	acquireImportJobLock,
	createJobOwner,
	releaseImportJobLock,
} from "../jobs/importJobLocks";
import {
	cancelImportJobRun,
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getActiveImportJobRun,
	getImportJobRunById,
	incrementImportJobRunQueueProgress,
	setImportJobRunQueueTotals,
	TMDB_ENRICH_JOB_NAME,
	TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	TMDB_PRIMARY_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import {
	checkImportJobDependencies,
	finishSkippedDependencyRun,
} from "../jobs/importJobDependencies";
import { logEvent } from "../shared/logging";
import type {
	Env,
	TmdbProviderRefreshQueueMessage,
	WorkerQueueMessage,
} from "../shared/types";

type TmdbDateWindow = {
	beginDate: string;
	endDate: string;
};

type TmdbProviderRefreshRow = {
	tmdb_id: number;
};

type TmdbProviderRefreshOptions = {
	trigger: ImportJobTrigger;
	useLock?: boolean;
	nowMs?: number;
};

type TmdbProviderRefreshStats = {
	processed: number;
	updated: number;
	errors: number;
	providerRowsInserted: number;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TMDB_PROVIDER_REFRESH_BEGIN_DATE = "1874-01-01";
const TMDB_PROVIDER_REFRESH_LOCK_MINUTES = 30;
const TMDB_PROVIDER_REFRESH_IDS_PER_QUEUE_MESSAGE = 100;
const TMDB_PROVIDER_REFRESH_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_PROVIDER_REFRESH_D1_BATCH_MOVIES = 100;
const TMDB_PROVIDER_REFRESH_TMDB_CONCURRENCY = 25;

function todayIsoDate(nowMs = Date.now()) {
	return new Date(nowMs).toISOString().slice(0, 10);
}

function isoDateToTime(value: string) {
	const [year, month, day] = value.split("-").map(Number);
	return Date.UTC(year, month - 1, day);
}

function timeToIsoDate(value: number) {
	return new Date(value).toISOString().slice(0, 10);
}

function splitDateWindow(window: TmdbDateWindow) {
	const beginTime = isoDateToTime(window.beginDate);
	const endTime = isoDateToTime(window.endDate);

	if (beginTime >= endTime) {
		return null;
	}

	const daysBetween = Math.floor((endTime - beginTime) / ONE_DAY_MS);
	const leftEndTime = beginTime + Math.floor(daysBetween / 2) * ONE_DAY_MS;
	const rightBeginTime = leftEndTime + ONE_DAY_MS;

	return {
		left: {
			beginDate: window.beginDate,
			endDate: timeToIsoDate(leftEndTime),
		},
		right: {
			beginDate: timeToIsoDate(rightBeginTime),
			endDate: window.endDate,
		},
	};
}

export function isTmdbProviderRefreshQueueMessage(
	body: WorkerQueueMessage,
): body is TmdbProviderRefreshQueueMessage {
	return "kind" in body && body.kind === "tmdb-provider-refresh";
}

function buildProviderRefreshStatements(
	tmdbId: number,
	providerIds: number[],
	env: Env,
	loadRunId: string,
) {
	const statements = [
		env.DB.prepare(
			`DELETE FROM movie_watch_providers_staging
			 WHERE tmdb_id = ?
			   AND region = ?`,
		).bind(tmdbId, "US"),
	];

	for (const providerId of providerIds) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO movie_watch_providers_staging (
					tmdb_id,
					provider_id,
					region,
					load_run_id,
					is_full_refresh,
					staged_at,
					promoted_at
				)
				VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, NULL)`,
			).bind(tmdbId, providerId, "US", loadRunId),
		);
	}

	return statements;
}

async function loadUsFlatrateCandidateStaging(
	env: Env,
	jobRunId: string,
	endDate: string,
) {
	let pagesRead = 0;
	let rowsSeen = 0;
	let totalPagesSeen: number | null = null;
	let windowsLoaded = 0;
	let windowsSplit = 0;
	let stoppedWindow: TmdbDateWindow | null = null;
	let stopReason:
		| "end_of_windows"
		| "single_day_page_cap_reached" = "end_of_windows";
	const pendingWindows: TmdbDateWindow[] = [
		{ beginDate: TMDB_PROVIDER_REFRESH_BEGIN_DATE, endDate },
	];
	let pendingStatements: D1PreparedStatement[] = [];

	async function flushStatements() {
		if (pendingStatements.length === 0) {
			return;
		}

		await env.DB.batch(pendingStatements);
		pendingStatements = [];
	}

	await env.DB.batch([
		env.DB.prepare("DELETE FROM tmdb_us_flatrate_movies_staging"),
		env.DB.prepare(
			`DELETE FROM movie_watch_providers_staging
			 WHERE region = ?`,
		).bind("US"),
	]);

	while (pendingWindows.length > 0) {
		const currentWindow = pendingWindows.shift();

		if (!currentWindow) {
			break;
		}

		const firstPage = await getTmdbUsFlatrateDiscoverPage(
			1,
			currentWindow.beginDate,
			env,
			currentWindow.endDate,
		);

		pagesRead += 1;
		totalPagesSeen = Math.max(totalPagesSeen ?? 0, firstPage.total_pages);

		if (firstPage.total_pages > TMDB_DISCOVER_MAX_PAGE) {
			const splitWindow = splitDateWindow(currentWindow);

			if (!splitWindow) {
				stopReason = "single_day_page_cap_reached";
				stoppedWindow = currentWindow;
				break;
			}

			windowsSplit += 1;
			pendingWindows.unshift(splitWindow.right);
			pendingWindows.unshift(splitWindow.left);
			continue;
		}

		windowsLoaded += 1;

		for (let page = 1; page <= firstPage.total_pages; page += 1) {
			const discoverPage =
				page === 1
					? firstPage
					: await getTmdbUsFlatrateDiscoverPage(
							page,
							currentWindow.beginDate,
							env,
							currentWindow.endDate,
						);

			if (page !== 1) {
				pagesRead += 1;
			}

			for (const movie of discoverPage.results) {
				rowsSeen += 1;
				pendingStatements.push(
					env.DB.prepare(
						`INSERT OR REPLACE INTO tmdb_us_flatrate_movies_staging (
							tmdb_id,
							load_run_id,
							discovered_at
						)
						VALUES (?, ?, CURRENT_TIMESTAMP)`,
					).bind(movie.id, jobRunId),
				);
			}

			if (pendingStatements.length >= 1000) {
				await flushStatements();
			}
		}
	}

	await flushStatements();

	const candidateRow = await env.DB.prepare(
		`SELECT COUNT(*) AS candidateCount
		 FROM tmdb_us_flatrate_movies_staging
		 WHERE load_run_id = ?`,
	)
		.bind(jobRunId)
		.first<{ candidateCount: number }>();

	return {
		candidateCount: candidateRow?.candidateCount ?? 0,
		pagesRead,
		rowsSeen,
		totalPagesSeen,
		windowsLoaded,
		windowsSplit,
		pendingWindows: pendingWindows.length,
		stoppedWindow,
		stopReason,
	};
}

async function getProviderRefreshCandidateRows(env: Env, jobRunId: string) {
	const { results } = await env.DB.prepare(
		`SELECT tmdb_id
		 FROM tmdb_us_flatrate_movies_staging
		 WHERE load_run_id = ?
		 ORDER BY tmdb_id`,
	)
		.bind(jobRunId)
		.all<TmdbProviderRefreshRow>();

	return results;
}

export async function enqueueTmdbProviderRefreshJob(
	env: Env,
	options: TmdbProviderRefreshOptions,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const lockOwner = createJobOwner(options.trigger);
	const jobRunId = createImportJobRunId(
		TMDB_PROVIDER_REFRESH_JOB_NAME,
		options.trigger,
	);
	const endDate = todayIsoDate(options.nowMs ?? startedAtMs);
	let lockAcquired = false;
	let jobRunCreated = false;

	if (options.useLock) {
		lockAcquired = await acquireImportJobLock(
			env,
			TMDB_PROVIDER_REFRESH_JOB_NAME,
			lockOwner,
			TMDB_PROVIDER_REFRESH_LOCK_MINUTES,
		);

		if (!lockAcquired) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "job_already_running",
				jobRunId: null,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};
		}
	}

	try {
		const dependencies = await checkImportJobDependencies(env, [
			{ jobName: TMDB_PRIMARY_JOB_NAME },
			{
				jobName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
				afterJobName: TMDB_PRIMARY_JOB_NAME,
			},
		]);

		if (!dependencies.ok) {
			return finishSkippedDependencyRun(env, {
				jobRunId,
				jobName: TMDB_PROVIDER_REFRESH_JOB_NAME,
				trigger: options.trigger,
				startedAtMs,
				startedAt,
				blockers: dependencies.blockers,
			});
		}

		const activeProviderRun = await getActiveImportJobRun(
			env,
			TMDB_PROVIDER_REFRESH_JOB_NAME,
		);
		const activeEnrichmentRun = await getActiveImportJobRun(
			env,
			TMDB_ENRICH_JOB_NAME,
		);
		const activeRun = activeProviderRun ?? activeEnrichmentRun;

		if (activeRun) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "tmdb_provider_or_enrichment_job_active",
				activeJobRunId: activeRun.job_run_id,
				activeJobName: activeRun.job_name,
				activeStatus: activeRun.status,
				activeSelected: activeRun.selected_count,
				activeProcessed: activeRun.processed_count,
				jobRunId: null,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};
		}

		await createImportJobRun(env, {
			jobRunId,
			jobName: TMDB_PROVIDER_REFRESH_JOB_NAME,
			trigger: options.trigger,
		});
		jobRunCreated = true;

		logEvent("tmdb-provider-refresh-enqueue-start", {
			trigger: options.trigger,
			jobRunId,
			beginDate: TMDB_PROVIDER_REFRESH_BEGIN_DATE,
			endDate,
			startedAt,
		});

		const discovery = await loadUsFlatrateCandidateStaging(
			env,
			jobRunId,
			endDate,
		);

		if (discovery.stopReason !== "end_of_windows") {
			throw new Error(
				`TMDB provider refresh Discover stopped before all windows finished: ${discovery.stopReason}`,
			);
		}

		const rows = await getProviderRefreshCandidateRows(env, jobRunId);
		let queueMessages: TmdbProviderRefreshQueueMessage[] = [];
		let rowsQueued = 0;
		let messagesQueued = 0;

		async function flushQueueMessages() {
			if (queueMessages.length === 0) {
				return;
			}

			await env.TMDB_ENRICHMENT_QUEUE.sendBatch(
				queueMessages.map((message) => ({ body: message })),
			);

			messagesQueued += queueMessages.length;
			queueMessages = [];
		}

		for (
			let index = 0;
			index < rows.length;
			index += TMDB_PROVIDER_REFRESH_IDS_PER_QUEUE_MESSAGE
		) {
			const tmdbIds = rows
				.slice(index, index + TMDB_PROVIDER_REFRESH_IDS_PER_QUEUE_MESSAGE)
				.map((row) => row.tmdb_id);

			queueMessages.push({
				kind: "tmdb-provider-refresh",
				jobRunId,
				tmdbIds,
			});
			rowsQueued += tmdbIds.length;

			if (
				queueMessages.length >=
				TMDB_PROVIDER_REFRESH_QUEUE_MESSAGES_PER_SEND_BATCH
			) {
				await flushQueueMessages();
			}
		}

		await flushQueueMessages();

		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			trigger: options.trigger,
			beginDate: TMDB_PROVIDER_REFRESH_BEGIN_DATE,
			endDate,
			...discovery,
			selected: rows.length,
			rowsQueued,
			messagesQueued,
			jobRunId,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		if (rows.length === 0) {
			await finishImportJobRun(env, jobRunId, {
				status: "complete",
				result,
			});
		} else {
			await setImportJobRunQueueTotals(env, jobRunId, {
				selected: rows.length,
				queued: rowsQueued,
				result,
			});
		}

		logEvent("tmdb-provider-refresh-enqueue-end", result);

		return result;
	} catch (error) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const lastError =
			error instanceof Error ? error.message : "TMDB provider refresh failed.";

		const result = {
			jobRunId,
			trigger: options.trigger,
			status: "cancelled",
			reason: "tmdb_provider_refresh_enqueue_error",
			error: lastError,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		if (jobRunCreated) {
			await finishImportJobRun(env, jobRunId, {
				status: "cancelled",
				errors: 1,
				result,
				lastError,
			});
		}

		logEvent("tmdb-provider-refresh-cancelled", result);

		throw error;
	} finally {
		if (options.useLock && lockAcquired) {
			await releaseImportJobLock(
				env,
				TMDB_PROVIDER_REFRESH_JOB_NAME,
				lockOwner,
			);
		}
	}
}

export async function processTmdbProviderRefreshRows(
	env: Env,
	jobRunId: string,
	rows: TmdbProviderRefreshRow[],
	trigger: "queue",
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	let processed = 0;
	let updated = 0;
	let errors = 0;
	let providerRowsInserted = 0;
	let lastError: string | null = null;
	let pendingStatements: D1PreparedStatement[] = [];
	let pendingStatementMovies = 0;
	const activeJobRun = await getImportJobRunById(env, jobRunId);

	if (
		!activeJobRun ||
		!["running", "queued"].includes(activeJobRun.status)
	) {
		logEvent("tmdb-provider-refresh-queue-message-skipped", {
			trigger,
			jobRunId,
			status: activeJobRun?.status ?? "missing",
			selected: rows.length,
		});

		return {
			processed: 0,
			updated: 0,
			errors: 0,
			providerRowsInserted: 0,
		};
	}

	async function flushStatements() {
		if (pendingStatements.length === 0) {
			return;
		}

		await env.DB.batch(pendingStatements);
		pendingStatements = [];
		pendingStatementMovies = 0;
	}

	logEvent("tmdb-provider-refresh-queue-message-start", {
		trigger,
		jobRunId,
		selected: rows.length,
		tmdbConcurrency: TMDB_PROVIDER_REFRESH_TMDB_CONCURRENCY,
		startedAt,
	});

	for (
		let index = 0;
		index < rows.length;
		index += TMDB_PROVIDER_REFRESH_TMDB_CONCURRENCY
	) {
		const rowChunk = rows.slice(
			index,
			index + TMDB_PROVIDER_REFRESH_TMDB_CONCURRENCY,
		);
		const providerResults = await Promise.all(
			rowChunk.map(async (row) => {
				try {
					const watchProviders = await getTmdbMovieWatchProviders(
						row.tmdb_id,
						env,
					);
					return {
						row,
						providerIds:
							getUsFlatrateProviderIdsFromWatchProviders(watchProviders),
						error: null,
					};
				} catch (error) {
					return {
						row,
						providerIds: null,
						error,
					};
				}
			}),
		);
		const retryableErrorResult = providerResults.find(
			(result) =>
				result.error && !isTerminalTmdbEnrichmentError(result.error),
		);

		if (retryableErrorResult?.error) {
			await flushStatements();

			lastError =
				retryableErrorResult.error instanceof Error
					? retryableErrorResult.error.message
					: String(retryableErrorResult.error);

			const cancelledAtMs = Date.now();
			const cancelledAt = new Date(cancelledAtMs).toISOString();
			const result = {
				jobRunId,
				trigger,
				status: "cancelled",
				reason: "retryable_tmdb_failure_after_retries",
				tmdbId: retryableErrorResult.row.tmdb_id,
				error: lastError,
				processedInMessage: processed,
				updatedInMessage: updated,
				errorsInMessage: errors + 1,
				providerRowsInsertedInMessage: providerRowsInserted,
				startedAt,
				cancelledAt,
				durationMs: cancelledAtMs - startedAtMs,
			};

			await cancelImportJobRun(env, jobRunId, {
				processed,
				updated,
				errors: errors + 1,
				providerRowsInserted,
				result,
				lastError,
			});

			logEvent("tmdb-provider-refresh-cancelled", result);

			return {
				processed,
				updated,
				errors: errors + 1,
				providerRowsInserted,
			};
		}

		for (const result of providerResults) {
			if (result.providerIds) {
				pendingStatements.push(
					...buildProviderRefreshStatements(
						result.row.tmdb_id,
						result.providerIds,
						env,
						jobRunId,
					),
				);
				pendingStatementMovies += 1;
				updated += 1;
				providerRowsInserted += result.providerIds.length;

				if (pendingStatementMovies >= TMDB_PROVIDER_REFRESH_D1_BATCH_MOVIES) {
					await flushStatements();
				}
			} else {
				errors += 1;
				lastError =
					result.error instanceof Error
						? result.error.message
						: String(result.error);

				if (isTerminalTmdbEnrichmentError(result.error)) {
					pendingStatements.push(
						...buildProviderRefreshStatements(
							result.row.tmdb_id,
							[],
							env,
							jobRunId,
						),
					);
					pendingStatementMovies += 1;
				}

				logEvent("tmdb-provider-refresh-row-error", {
					trigger,
					jobRunId,
					tmdbId: result.row.tmdb_id,
					error: lastError,
				});
			}

			processed += 1;
		}
	}

	await flushStatements();

	const stats: TmdbProviderRefreshStats = {
		processed,
		updated,
		errors,
		providerRowsInserted,
	};

	await incrementImportJobRunQueueProgress(env, jobRunId, stats, lastError);

	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	logEvent("tmdb-provider-refresh-queue-message-end", {
		trigger,
		jobRunId,
		selected: rows.length,
		...stats,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
	});

	return stats;
}
