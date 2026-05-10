import {
	getTmdbMovieDetails,
	getUsCertification,
	isTerminalTmdbEnrichmentError,
	type TmdbMovieDetails,
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
	TmdbNewMovieDetailsQueueMessage,
	WorkerQueueMessage,
} from "../shared/types";

type TmdbNewMovieDetailsRow = {
	tmdb_id: number;
};

type TmdbNewMovieDetailsOptions = {
	trigger: ImportJobTrigger;
	useLock?: boolean;
};

type TmdbNewMovieDetailsStats = {
	processed: number;
	updated: number;
	errors: number;
	providerRowsInserted: number;
	tmdbIDNotFoundSkippedCount?: number;
};

const TMDB_NEW_MOVIE_DETAILS_LOCK_MINUTES = 30;
const TMDB_NEW_MOVIE_DETAILS_IDS_PER_QUEUE_MESSAGE = 100;
const TMDB_NEW_MOVIE_DETAILS_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_NEW_MOVIE_DETAILS_D1_BATCH_MOVIES = 100;
const TMDB_NEW_MOVIE_DETAILS_TMDB_CONCURRENCY = 25;

export function isTmdbNewMovieDetailsQueueMessage(
	body: WorkerQueueMessage,
): body is TmdbNewMovieDetailsQueueMessage {
	return "kind" in body && body.kind === "tmdb-new-movie-details";
}

function buildNewMovieDetailsStatements(
	tmdbId: number,
	details: TmdbMovieDetails,
	env: Env,
) {
	return env.DB.prepare(
		`UPDATE tmdb_movies_staging
		 SET imdb_id = ?,
		     us_certification = ?,
		     tmdb_enriched_at = CURRENT_TIMESTAMP,
		     tmdb_enrichment_error = NULL
		 WHERE tmdb_id = ?`,
	).bind(
		details.external_ids?.imdb_id ?? null,
		getUsCertification(details),
		tmdbId,
	);
}

function buildNewMovieDetailsErrorStatement(
	tmdbId: number,
	error: unknown,
	env: Env,
) {
	const message = error instanceof Error ? error.message : String(error);

	return env.DB.prepare(
		`UPDATE tmdb_movies_staging
		 SET tmdb_enrichment_error = ?
		 WHERE tmdb_id = ?`,
	).bind(message, tmdbId);
}

async function getNewMovieDetailsRows(
	env: Env,
	primaryJobRunId: string,
) {
	const { results } = await env.DB.prepare(
		`SELECT primary_load.tmdb_id
		 FROM tmdb_primary_new_movie_ids_for_new_movie_details_staging AS primary_load
		 INNER JOIN tmdb_movies_staging AS tmdb
		   ON tmdb.tmdb_id = primary_load.tmdb_id
		 WHERE primary_load.job_run_id = ?
		   AND tmdb.tmdb_enriched_at IS NULL
		   AND tmdb.tmdb_enrichment_error IS NULL
		 ORDER BY primary_load.tmdb_id`,
	)
		.bind(primaryJobRunId)
		.all<TmdbNewMovieDetailsRow>();

	return results;
}

export async function enqueueTmdbNewMovieDetailsJob(
	env: Env,
	options: TmdbNewMovieDetailsOptions,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const lockOwner = createJobOwner(options.trigger);
	const jobRunId = createImportJobRunId(
		TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
		options.trigger,
	);
	let lockAcquired = false;
	let jobRunCreated = false;

	if (options.useLock) {
		lockAcquired = await acquireImportJobLock(
			env,
			TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
			lockOwner,
			TMDB_NEW_MOVIE_DETAILS_LOCK_MINUTES,
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
		]);

		if (!dependencies.ok) {
			return finishSkippedDependencyRun(env, {
				jobRunId,
				jobName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
				trigger: options.trigger,
				startedAtMs,
				startedAt,
				blockers: dependencies.blockers,
			});
		}

		const activeRuns = await Promise.all([
			getActiveImportJobRun(env, TMDB_NEW_MOVIE_DETAILS_JOB_NAME),
			getActiveImportJobRun(env, TMDB_ENRICH_JOB_NAME),
			getActiveImportJobRun(env, TMDB_PROVIDER_REFRESH_JOB_NAME),
		]);
		const activeRun = activeRuns.find(Boolean);

		if (activeRun) {
			return finishSkippedDependencyRun(env, {
				jobRunId,
				jobName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
				trigger: options.trigger,
				startedAtMs,
				startedAt,
				blockers: [
					{
						jobName: activeRun.job_name,
						reason: "tmdb_details_or_provider_job_active",
						jobRunId: activeRun.job_run_id,
						status: activeRun.status,
						errorCount: activeRun.error_count,
						endedAt: activeRun.ended_at,
					},
				],
			});
		}

		const primaryRun = dependencies.runs[TMDB_PRIMARY_JOB_NAME];
		const rows = await getNewMovieDetailsRows(env, primaryRun.job_run_id);
		let queueMessages: TmdbNewMovieDetailsQueueMessage[] = [];
		let rowsQueued = 0;
		let messagesQueued = 0;

		await createImportJobRun(env, {
			jobRunId,
			jobName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
			trigger: options.trigger,
		});
		jobRunCreated = true;

		logEvent("tmdb-new-movie-details-enqueue-start", {
			trigger: options.trigger,
			jobRunId,
			primaryJobRunId: primaryRun.job_run_id,
			selected: rows.length,
			startedAt,
		});

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
			index += TMDB_NEW_MOVIE_DETAILS_IDS_PER_QUEUE_MESSAGE
		) {
			const tmdbIds = rows
				.slice(index, index + TMDB_NEW_MOVIE_DETAILS_IDS_PER_QUEUE_MESSAGE)
				.map((row) => row.tmdb_id);

			queueMessages.push({
				kind: "tmdb-new-movie-details",
				jobRunId,
				tmdbIds,
			});
			rowsQueued += tmdbIds.length;

			if (
				queueMessages.length >=
				TMDB_NEW_MOVIE_DETAILS_QUEUE_MESSAGES_PER_SEND_BATCH
			) {
				await flushQueueMessages();
			}
		}

		await flushQueueMessages();

		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			trigger: options.trigger,
			primaryJobRunId: primaryRun.job_run_id,
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

		logEvent("tmdb-new-movie-details-enqueue-end", result);

		return result;
	} catch (error) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const lastError =
			error instanceof Error ? error.message : "TMDB new movie details failed.";
		const result = {
			jobRunId,
			trigger: options.trigger,
			status: "cancelled",
			reason: "tmdb_new_movie_details_enqueue_error",
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

		logEvent("tmdb-new-movie-details-cancelled", result);

		throw error;
	} finally {
		if (options.useLock && lockAcquired) {
			await releaseImportJobLock(
				env,
				TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
				lockOwner,
			);
		}
	}
}

export async function processTmdbNewMovieDetailsRows(
	env: Env,
	jobRunId: string,
	rows: TmdbNewMovieDetailsRow[],
	trigger: "queue",
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	let processed = 0;
	let updated = 0;
	let errors = 0;
	let tmdbIDNotFoundSkippedCount = 0;
	let lastError: string | null = null;
	let pendingStatements: D1PreparedStatement[] = [];
	const activeJobRun = await getImportJobRunById(env, jobRunId);

	if (
		!activeJobRun ||
		!["running", "queued"].includes(activeJobRun.status)
	) {
		logEvent("tmdb-new-movie-details-queue-message-skipped", {
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
	}

	logEvent("tmdb-new-movie-details-queue-message-start", {
		trigger,
		jobRunId,
		selected: rows.length,
		tmdbConcurrency: TMDB_NEW_MOVIE_DETAILS_TMDB_CONCURRENCY,
		startedAt,
	});

	for (
		let index = 0;
		index < rows.length;
		index += TMDB_NEW_MOVIE_DETAILS_TMDB_CONCURRENCY
	) {
		const rowChunk = rows.slice(
			index,
			index + TMDB_NEW_MOVIE_DETAILS_TMDB_CONCURRENCY,
		);
		const detailsResults = await Promise.all(
			rowChunk.map(async (row) => {
				try {
					const details = await getTmdbMovieDetails(row.tmdb_id, env);
					return {
						row,
						statement: buildNewMovieDetailsStatements(row.tmdb_id, details, env),
						error: null,
					};
				} catch (error) {
					return {
						row,
						statement: null,
						error,
					};
				}
			}),
		);
		const retryableErrorResult = detailsResults.find(
			(result) =>
				result.error && !isTerminalTmdbEnrichmentError(result.error),
		);

		if (retryableErrorResult?.error) {
			await flushStatements();

			lastError =
				retryableErrorResult.error instanceof Error
					? retryableErrorResult.error.message
					: String(retryableErrorResult.error);
			await env.DB.batch([
				buildNewMovieDetailsErrorStatement(
					retryableErrorResult.row.tmdb_id,
					retryableErrorResult.error,
					env,
				),
			]);

			const cancelledAtMs = Date.now();
			const cancelledAt = new Date(cancelledAtMs).toISOString();
			const result = {
				jobRunId,
				trigger,
				status: "cancelled",
				reason: "tmdb_new_movie_details_failure_after_retries",
				tmdbId: retryableErrorResult.row.tmdb_id,
				error: lastError,
				processedInMessage: processed,
				updatedInMessage: updated,
				errorsInMessage: errors + 1,
				startedAt,
				cancelledAt,
				durationMs: cancelledAtMs - startedAtMs,
			};

			await cancelImportJobRun(env, jobRunId, {
				processed,
				updated,
				errors: errors + 1,
				result,
				lastError,
			});

			logEvent("tmdb-new-movie-details-cancelled", result);

			return {
				processed,
				updated,
				errors: errors + 1,
				providerRowsInserted: 0,
			};
		}

		for (const result of detailsResults) {
			if (result.statement) {
				pendingStatements.push(result.statement);
				processed += 1;
				updated += 1;

				if (pendingStatements.length >= TMDB_NEW_MOVIE_DETAILS_D1_BATCH_MOVIES) {
					await flushStatements();
				}

				continue;
			}

			if (result.error && isTerminalTmdbEnrichmentError(result.error)) {
				lastError =
					result.error instanceof Error
						? result.error.message
						: String(result.error);
				pendingStatements.push(
					buildNewMovieDetailsErrorStatement(
						result.row.tmdb_id,
						result.error,
						env,
					),
				);
				processed += 1;
				tmdbIDNotFoundSkippedCount += 1;

				logEvent("tmdb-new-movie-details-row-skipped", {
					trigger,
					jobRunId,
					tmdbId: result.row.tmdb_id,
					error: lastError,
				});

				if (pendingStatements.length >= TMDB_NEW_MOVIE_DETAILS_D1_BATCH_MOVIES) {
					await flushStatements();
				}
			}
		}
	}

	await flushStatements();

	const stats: TmdbNewMovieDetailsStats = {
		processed,
		updated,
		errors,
		providerRowsInserted: 0,
		tmdbIDNotFoundSkippedCount,
	};

	await incrementImportJobRunQueueProgress(env, jobRunId, stats, null);

	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	logEvent("tmdb-new-movie-details-queue-message-end", {
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
