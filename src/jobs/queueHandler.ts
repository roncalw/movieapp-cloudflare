import {
	isCacheWarmSearchQueueMessage,
	processCacheWarmSearchMessage,
} from "../cache/cacheWarmQueue";
import { insertImdbRatingQueueRows } from "../imports/imdbRatings";
import {
	isTmdbEnrichmentQueueMessage,
	processTmdbEnrichmentRows,
} from "../imports/tmdbEnrichment";
import {
	isTmdbNewMovieDetailsQueueMessage,
	processTmdbNewMovieDetailsRows,
} from "../imports/tmdbNewMovieDetails";
import {
	isTmdbProviderRefreshQueueMessage,
	processTmdbProviderRefreshRows,
} from "../imports/tmdbProviderRefresh";
import { logEvent } from "../shared/logging";
import type { Env, WorkerQueueMessage } from "../shared/types";

export async function handleQueue(
	batch: MessageBatch<WorkerQueueMessage>,
	env: Env,
) {
	for (const message of batch.messages) {
		try {
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

			await insertImdbRatingQueueRows(
				env,
				message.body.rows,
				message.body.jobRunId,
				message.body.messageId,
			);
			message.ack();
		} catch (error) {
			logEvent("queue-message-failed", {
				kind: message.body.kind ?? "imdb-ratings",
				jobRunId: message.body.jobRunId ?? "missing",
				error: error instanceof Error ? error.message : String(error),
			});

			throw error;
		}
	}
}
