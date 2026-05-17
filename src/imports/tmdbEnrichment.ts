import {
	acquireImportJobLock,
	createJobOwner,
	releaseImportJobLock,
} from "../jobs/importJobLocks";
import {
	cancelImportJobRun,
	createTmdbEnrichmentImportJobRun,
	createTmdbEnrichmentJobRunId,
	getActiveTmdbEnrichmentImportJobRun,
	getImportJobRunById,
	recordImportJobQueueMessageCompletion,
	TMDB_ENRICH_JOB_NAME,
} from "../jobs/importJobRuns";
import {
	getTmdbMovieDetails,
	getUsCertification,
	getUsFlatrateProviderIds,
	isTerminalTmdbEnrichmentError,
	type TmdbMovieDetails,
} from "../externalApis/tmdbClient";
import { logEvent } from "../shared/logging";
import type {
	Env,
	TmdbEnrichmentQueueMessage,
	WorkerQueueMessage,
} from "../shared/types";

type TmdbEnrichmentRow = {
	tmdb_id: number;
};

type TmdbEnrichmentOptions = {
	limit: number;
	refreshOlderThanDays: number;
	progressEvery: number;
	tmdbConcurrency: number;
	trigger: "manual" | "cron";
	useLock?: boolean;
};

type TmdbEnrichmentStats = {
	processed: number;
	updated: number;
	errors: number;
	imdbIdsFound: number;
	certificationsFound: number;
	providerMoviesFound: number;
	providerRowsInserted: number;
};

const TMDB_ENRICH_D1_BATCH_MOVIES = 100;
const TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE = 100;
const TMDB_ENRICH_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
export const TMDB_ENRICH_TMDB_CONCURRENCY = 25;
const TMDB_ENRICH_LOCK_MINUTES = 30;
const TMDB_ENRICHMENT_QUEUE_NAME = "movieapp-tmdb-enrichment-queue";

function buildTmdbEnrichmentStatements(
	tmdbId: number,
	details: TmdbMovieDetails,
	env: Env,
	loadRunId: string,
) {
	const imdbId = details.external_ids?.imdb_id ?? null;
	const usCertification = getUsCertification(details);
	const providerIds = getUsFlatrateProviderIds(details);
	const statements = [
		env.DB.prepare(
			`UPDATE tmdb_movies_staging
			 SET imdb_id = ?,
			     us_certification = ?,
			     tmdb_enriched_at = CURRENT_TIMESTAMP,
			     tmdb_enrichment_error = NULL
			 WHERE tmdb_id = ?`,
			).bind(imdbId, usCertification, tmdbId),
			env.DB.prepare(
				`DELETE FROM movie_watch_providers_staging
				 WHERE tmdb_id = ?
				   AND region = ?`,
			).bind(tmdbId, "US"),
		];

	if (providerIds.length === 0) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO movie_watch_providers_staging (
					tmdb_id,
					provider_id,
					region,
					load_run_id,
					staged_at,
					promoted_at
				)
				VALUES (?, NULL, ?, ?, CURRENT_TIMESTAMP, NULL)`,
			).bind(tmdbId, "US", loadRunId),
		);
	} else {
		for (const providerId of providerIds) {
			statements.push(
				env.DB.prepare(
					`INSERT INTO movie_watch_providers_staging (
						tmdb_id,
						provider_id,
						region,
						load_run_id,
						staged_at,
						promoted_at
					)
					VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)`,
				).bind(tmdbId, providerId, "US", loadRunId),
			);
		}
	}

	return {
		statements,
		imdbIdFound: imdbId ? 1 : 0,
		certificationFound: usCertification ? 1 : 0,
		providerMovieFound: providerIds.length > 0 ? 1 : 0,
		providerRowsInserted: providerIds.length,
	};
}

function buildTmdbTerminalErrorStatements(
	tmdbId: number,
	error: unknown,
	env: Env,
) {
	const message = error instanceof Error ? error.message : String(error);
	return [
		env.DB.prepare(
			`UPDATE tmdb_movies_staging
			 SET imdb_id = NULL,
			     us_certification = NULL,
			     tmdb_enriched_at = CURRENT_TIMESTAMP,
			     tmdb_enrichment_error = ?
			 WHERE tmdb_id = ?`,
		).bind(message, tmdbId),
	];
}

async function getTmdbEnrichmentRows(
	env: Env,
	limit: number,
	refreshOlderThanDays: number,
) {
	const { results } = await env.DB.prepare(
		`SELECT tmdb_id
		 FROM tmdb_movies_staging
		 WHERE (tmdb_enriched_at IS NULL
		    OR tmdb_enriched_at < datetime('now', '-' || ? || ' days'))
		   AND tmdb_enrichment_error IS NULL
		 ORDER BY
		   tmdb_enriched_at IS NOT NULL,
		   tmdb_enriched_at,
		   tmdb_id
		 LIMIT ?`,
	)
		.bind(refreshOlderThanDays, limit)
		.all<TmdbEnrichmentRow>();

	return results;
}

export function isTmdbEnrichmentQueueMessage(
	body: WorkerQueueMessage,
): body is TmdbEnrichmentQueueMessage {
	return "kind" in body && body.kind === "tmdb-enrichment";
}

export async function processTmdbEnrichmentRows(
	env: Env,
	jobRunId: string,
	rows: TmdbEnrichmentRow[],
	trigger: "queue",
	messageId?: string,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	let processed = 0;
	let updated = 0;
	let errors = 0;
	let imdbIdsFound = 0;
	let certificationsFound = 0;
	let providerMoviesFound = 0;
	let providerRowsInserted = 0;
	let lastError: string | null = null;
	let pendingStatements: D1PreparedStatement[] = [];
	let pendingStatementMovies = 0;
	const activeJobRun = await getImportJobRunById(env, jobRunId);

	if (
		!activeJobRun ||
		!["running", "queued"].includes(activeJobRun.status)
	) {
		logEvent("tmdb-enrich-queue-message-skipped", {
			trigger,
			jobRunId,
			status: activeJobRun?.status ?? "missing",
			selected: rows.length,
		});

		return {
			processed: 0,
			updated: 0,
			errors: 0,
			imdbIdsFound: 0,
			certificationsFound: 0,
			providerMoviesFound: 0,
			providerRowsInserted: 0,
		};
	}

	logEvent("tmdb-enrich-queue-message-start", {
		trigger,
		jobRunId,
		selected: rows.length,
		tmdbConcurrency: TMDB_ENRICH_TMDB_CONCURRENCY,
		startedAt,
	});

	async function flushStatements() {
		if (pendingStatements.length === 0) {
			return;
		}

		await env.DB.batch(pendingStatements);
		pendingStatements = [];
		pendingStatementMovies = 0;
	}

	for (
		let index = 0;
		index < rows.length;
		index += TMDB_ENRICH_TMDB_CONCURRENCY
	) {
		const rowChunk = rows.slice(index, index + TMDB_ENRICH_TMDB_CONCURRENCY);
		const enrichmentResults = await Promise.all(
			rowChunk.map(async (row) => {
				try {
					const details = await getTmdbMovieDetails(row.tmdb_id, env);
					return {
						row,
							enrichment: buildTmdbEnrichmentStatements(
								row.tmdb_id,
								details,
								env,
								jobRunId,
							),
						error: null,
					};
				} catch (error) {
					return {
						row,
						enrichment: null,
						error,
					};
				}
			}),
		);
		const retryableErrorResult = enrichmentResults.find(
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
				imdbIdsFoundInMessage: imdbIdsFound,
				certificationsFoundInMessage: certificationsFound,
				providerMoviesFoundInMessage: providerMoviesFound,
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

			logEvent("tmdb-enrich-cancelled", result);

			return {
				processed,
				updated,
				errors: errors + 1,
				imdbIdsFound,
				certificationsFound,
				providerMoviesFound,
				providerRowsInserted,
			};
		}

		for (const result of enrichmentResults) {
			if (result.enrichment) {
				pendingStatements.push(...result.enrichment.statements);
				pendingStatementMovies += 1;
				updated += 1;
				imdbIdsFound += result.enrichment.imdbIdFound;
				certificationsFound += result.enrichment.certificationFound;
				providerMoviesFound += result.enrichment.providerMovieFound;
				providerRowsInserted += result.enrichment.providerRowsInserted;

				if (pendingStatementMovies >= TMDB_ENRICH_D1_BATCH_MOVIES) {
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
						...buildTmdbTerminalErrorStatements(
							result.row.tmdb_id,
							result.error,
							env,
						),
					);
					pendingStatementMovies += 1;

					if (pendingStatementMovies >= TMDB_ENRICH_D1_BATCH_MOVIES) {
						await flushStatements();
					}
				}

				logEvent("tmdb-enrich-row-error", {
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

	const stats: TmdbEnrichmentStats = {
		processed,
		updated,
		errors,
		imdbIdsFound,
		certificationsFound,
		providerMoviesFound,
		providerRowsInserted,
	};

	await recordImportJobQueueMessageCompletion(env, {
		jobRunId,
		messageId:
			messageId ??
			`${jobRunId}-legacy-tmdb-enrich-${rows[0]?.tmdb_id ?? "first"}-${
				rows[rows.length - 1]?.tmdb_id ?? "last"
			}-${rows.length}`,
		jobName: TMDB_ENRICH_JOB_NAME,
		queueName: TMDB_ENRICHMENT_QUEUE_NAME,
		stats,
		lastError,
	});

	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	logEvent("tmdb-enrich-queue-message-end", {
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

export async function enqueueTmdbEnrichmentJob(
	env: Env,
	options: TmdbEnrichmentOptions,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const lockOwner = createJobOwner(options.trigger);
	const jobRunId = createTmdbEnrichmentJobRunId(options.trigger);
	let lockAcquired = false;
	let jobRunCreated = false;

	if (options.useLock) {
		lockAcquired = await acquireImportJobLock(
			env,
			TMDB_ENRICH_JOB_NAME,
			lockOwner,
			TMDB_ENRICH_LOCK_MINUTES,
		);

		if (!lockAcquired) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "job_already_running",
				limit: options.limit,
				refreshOlderThanDays: options.refreshOlderThanDays,
				selected: 0,
				rowsQueued: 0,
				messagesQueued: 0,
				jobRunId: null,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};
		}
	}

	try {
		const activeRun = await getActiveTmdbEnrichmentImportJobRun(env);

		if (activeRun) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "job_already_queued_or_running",
				activeJobRunId: activeRun.job_run_id,
				activeStatus: activeRun.status,
				activeSelected: activeRun.selected_count,
				activeProcessed: activeRun.processed_count,
				limit: options.limit,
				refreshOlderThanDays: options.refreshOlderThanDays,
				selected: 0,
				rowsQueued: 0,
				messagesQueued: 0,
				jobRunId: null,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};
		}

		const rows = await getTmdbEnrichmentRows(
			env,
			options.limit,
			options.refreshOlderThanDays,
		);
		let queueMessages: TmdbEnrichmentQueueMessage[] = [];
		let rowsQueued = 0;
		let messagesQueued = 0;
		let messageNumber = 0;

		await createTmdbEnrichmentImportJobRun(
			env,
			jobRunId,
			options.trigger,
			rows.length,
			rows.length,
		);
		jobRunCreated = true;

		logEvent("tmdb-enrich-enqueue-start", {
			trigger: options.trigger,
			jobRunId,
			limit: options.limit,
			refreshOlderThanDays: options.refreshOlderThanDays,
			selected: rows.length,
			idsPerMessage: TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE,
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
			index += TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE
		) {
			const tmdbIds = rows
				.slice(index, index + TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE)
				.map((row) => row.tmdb_id);
			messageNumber += 1;

			queueMessages.push({
				kind: "tmdb-enrichment",
				jobRunId,
				messageId: `${jobRunId}-${String(messageNumber).padStart(6, "0")}`,
				tmdbIds,
			});
			rowsQueued += tmdbIds.length;

			if (
				queueMessages.length >=
				TMDB_ENRICH_QUEUE_MESSAGES_PER_SEND_BATCH
			) {
				await flushQueueMessages();
			}
		}

		await flushQueueMessages();

		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			trigger: options.trigger,
			limit: options.limit,
			refreshOlderThanDays: options.refreshOlderThanDays,
			selected: rows.length,
			rowsQueued,
			messagesQueued,
			jobRunId,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		logEvent("tmdb-enrich-enqueue-end", result);

		return result;
	} catch (error) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const lastError =
			error instanceof Error ? error.message : "TMDB enrichment enqueue failed.";
		const result = {
			jobRunId,
			trigger: options.trigger,
			status: "cancelled",
			reason: "tmdb_enrichment_enqueue_error",
			error: lastError,
			limit: options.limit,
			refreshOlderThanDays: options.refreshOlderThanDays,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		if (jobRunCreated) {
			await cancelImportJobRun(env, jobRunId, {
				errors: 1,
				result,
				lastError,
			});
		}

		logEvent("tmdb-enrich-cancelled", result);

		throw error;
	} finally {
		if (options.useLock && lockAcquired) {
			await releaseImportJobLock(env, TMDB_ENRICH_JOB_NAME, lockOwner);
		}
	}
}
