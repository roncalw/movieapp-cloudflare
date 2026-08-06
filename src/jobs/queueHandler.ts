import {
	isCacheWarmSearchQueueMessage,
	processCacheWarmSearchMessage,
} from "../cache/cacheWarmQueue";
import {
	finalizeImdbRatingRun,
	insertImdbRatingQueueRows,
	isImdbRatingFinalizeQueueMessage,
} from "../imports/imdbRatings";
import {
	isTmdbEnrichmentQueueMessage,
	processTmdbEnrichmentRows,
} from "../imports/tmdbEnrichment";
import {
	isTmdbNewMovieDetailsQueueMessage,
	processTmdbNewMovieDetailsRows,
} from "../imports/tmdbNewMovieDetails";
import {
	isTmdbOriginalLanguageBackfillQueueMessage,
	processTmdbOriginalLanguageBackfillMessage,
} from "../imports/tmdbOriginalLanguageBackfill";
import {
	isTmdbOriginalLanguageResidualQueueMessage,
	processTmdbOriginalLanguageResidualMessage,
} from "../imports/tmdbOriginalLanguageResidual";
import {
	isTmdbProviderRefreshDiscoveryQueueMessage,
	isTmdbProviderRefreshQueueMessage,
	processTmdbProviderRefreshDiscoveryMessage,
	processTmdbProviderRefreshRows,
} from "../imports/tmdbProviderRefresh";
import {
	finalizeTmdbPopularityRun,
	isTmdbPopularityFinalizeQueueMessage,
	isTmdbPopularityQueueMessage,
	processTmdbPopularityRows,
} from "../imports/tmdbPopularity";
import {
	finalizeMovieListBuildQueuePhase,
	isMovieListBuildCleanupQueueMessage,
	isMovieListBuildFinalizeQueueMessage,
	isMovieListPopularitySyncQueueMessage,
	processMovieListBuildCleanupMessage,
	processMovieListPopularitySyncMessage,
	recordMovieListQueueError,
} from "../imports/movieListBuildQueue";
import { logEvent } from "../shared/logging";
import type { Env, WorkerQueueMessage } from "../shared/types";
import { releaseImportJobLock } from "./importJobLocks";
import {
	failActiveImportJobRun,
	MOVIE_LIST_BUILD_JOB_NAME,
} from "./importJobRuns";
import {
	finalizeProviderAvailabilityCycleForCacheRun,
	recordProviderAvailabilityCycleFailure,
} from "./providerAvailabilityCycle";

export const IMPORT_DEAD_LETTER_QUEUE_NAME =
	"movieapp-import-dead-letter-queue";

async function handleDeadLetterQueue(
	batch: MessageBatch<WorkerQueueMessage>,
	env: Env,
) {
	for (const message of batch.messages) {
		const jobRunId = message.body.jobRunId;
		const messageId = message.body.messageId ?? message.id;

		if (!jobRunId) {
			logEvent("queue-dead-letter-job-run-missing", {
				queue: batch.queue,
				messageId,
				errorCount: 1,
			});
			message.ack();
			continue;
		}

		const reason = `Queue message ${messageId} exhausted all delivery retries and entered ${IMPORT_DEAD_LETTER_QUEUE_NAME}.`;
		const changed = await failActiveImportJobRun(env, jobRunId, reason);
		const movieListLockOwner = isMovieListPopularitySyncQueueMessage(
			message.body,
		)
			? message.body.lockOwner
			: isMovieListBuildCleanupQueueMessage(message.body)
				? message.body.lockOwner
				: isMovieListBuildFinalizeQueueMessage(message.body)
					? message.body.context.lockOwner
					: null;

		if (movieListLockOwner) {
			await releaseImportJobLock(
				env,
				MOVIE_LIST_BUILD_JOB_NAME,
				movieListLockOwner,
			);
		}

		if (
			isTmdbProviderRefreshQueueMessage(message.body) ||
			isTmdbProviderRefreshDiscoveryQueueMessage(message.body)
		) {
			await recordProviderAvailabilityCycleFailure(
				env,
				jobRunId,
				reason,
			);
		}

		if (isCacheWarmSearchQueueMessage(message.body)) {
			await finalizeProviderAvailabilityCycleForCacheRun(env, jobRunId);
		}

		logEvent("queue-message-dead-lettered", {
			queue: batch.queue,
			kind: message.body.kind ?? "imdb-ratings",
			jobRunId,
			messageId,
			jobStatusChangedToFailed: changed > 0,
			errorCount: 1,
		});
		message.ack();
	}
}

export async function handleQueue(
	batch: MessageBatch<WorkerQueueMessage>,
	env: Env,
) {
	if (batch.queue === IMPORT_DEAD_LETTER_QUEUE_NAME) {
		await handleDeadLetterQueue(batch, env);
		return;
	}

	for (const message of batch.messages) {
		try {
			if (isMovieListPopularitySyncQueueMessage(message.body)) {
				await processMovieListPopularitySyncMessage(env, message.body);
				message.ack();
				continue;
			}

			if (isMovieListBuildCleanupQueueMessage(message.body)) {
				await processMovieListBuildCleanupMessage(env, message.body);
				message.ack();
				continue;
			}

			if (isMovieListBuildFinalizeQueueMessage(message.body)) {
				const result = await finalizeMovieListBuildQueuePhase(
					env,
					message.body,
				);

				if (result.pending) {
					/*
						Waiting for other messages is normal, not a failed delivery. Send a
						fresh delayed check and acknowledge this one so ordinary waiting does
						not consume the queue's ten error retries.
					*/
					const finalizerCheckCount =
						(message.body.finalizerCheckCount ?? 0) + 1;

					if (finalizerCheckCount > 60) {
						throw new Error(
							`Movie List ${message.body.stage} finalizer waited for incomplete ranges for more than 30 minutes.`,
						);
					}

					await env.MOVIE_LIST_BUILD_QUEUE.send(
						{
							...message.body,
							finalizerCheckCount,
						},
						{ delaySeconds: 30 },
					);
					message.ack();
				} else {
					message.ack();
				}
				continue;
			}

			if (isImdbRatingFinalizeQueueMessage(message.body)) {
				const result = await finalizeImdbRatingRun(env, message.body);

				if (result.pending) {
					message.retry({ delaySeconds: 300 });
				} else {
					message.ack();
				}
				continue;
			}

			if (isTmdbPopularityQueueMessage(message.body)) {
				await processTmdbPopularityRows(env, message.body);
				message.ack();
				continue;
			}

			if (isTmdbPopularityFinalizeQueueMessage(message.body)) {
				const result = await finalizeTmdbPopularityRun(env, message.body);

				if (result.pending) {
					message.retry({ delaySeconds: 300 });
				} else {
					message.ack();
				}
				continue;
			}

			if (isCacheWarmSearchQueueMessage(message.body)) {
				await processCacheWarmSearchMessage(env, message.body);
				message.ack();
				continue;
			}

			if (isTmdbEnrichmentQueueMessage(message.body)) {
				const rows = message.body.tmdbIds.map((tmdbId) => ({ tmdb_id: tmdbId }));

				await processTmdbEnrichmentRows(
					env,
					message.body.jobRunId,
					rows,
					"queue",
					message.body.messageId,
				);

				message.ack();
				continue;
			}

			if (isTmdbNewMovieDetailsQueueMessage(message.body)) {
				const rows = message.body.tmdbIds.map((tmdbId) => ({ tmdb_id: tmdbId }));

				await processTmdbNewMovieDetailsRows(
					env,
					message.body.jobRunId,
					rows,
					"queue",
					message.body.messageId,
				);

				message.ack();
				continue;
			}

			if (isTmdbOriginalLanguageBackfillQueueMessage(message.body)) {
				await processTmdbOriginalLanguageBackfillMessage(
					env,
					message.body,
				);
				message.ack();
				continue;
			}

			if (isTmdbOriginalLanguageResidualQueueMessage(message.body)) {
				await processTmdbOriginalLanguageResidualMessage(
					env,
					message.body,
				);
				message.ack();
				continue;
			}

			if (isTmdbProviderRefreshQueueMessage(message.body)) {
				const rows = message.body.tmdbIds.map((tmdbId) => ({ tmdb_id: tmdbId }));

				await processTmdbProviderRefreshRows(
					env,
					message.body.jobRunId,
					rows,
					"queue",
					message.body.messageId,
				);

				message.ack();
				continue;
			}

			if (isTmdbProviderRefreshDiscoveryQueueMessage(message.body)) {
				await processTmdbProviderRefreshDiscoveryMessage(env, message.body);
				message.ack();
				continue;
			}

			await insertImdbRatingQueueRows(
				env,
				message.body.rows,
				message.body.jobRunId,
				message.body.messageId,
			);
			message.ack();
		} catch (error) {
			if (
				isMovieListPopularitySyncQueueMessage(message.body) ||
				isMovieListBuildCleanupQueueMessage(message.body) ||
				isMovieListBuildFinalizeQueueMessage(message.body)
			) {
				try {
					await recordMovieListQueueError(env, message.body, error);
				} catch (recordError) {
					logEvent("movie-list-queue-error-record-failed", {
						jobRunId: message.body.jobRunId,
						messageId: message.body.messageId,
						error:
							recordError instanceof Error
								? recordError.message
								: String(recordError),
					});
				}
			}

			logEvent("queue-message-failed", {
				kind: message.body.kind ?? "imdb-ratings",
				jobRunId: message.body.jobRunId ?? "missing",
				error: error instanceof Error ? error.message : String(error),
			});

			throw error;
		}
	}
}
