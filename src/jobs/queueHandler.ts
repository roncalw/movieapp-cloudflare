import { insertImdbRatingQueueRows } from "../imports/imdbRatings";
import {
	isTmdbEnrichmentQueueMessage,
	processTmdbEnrichmentRows,
} from "../imports/tmdbEnrichment";
import type { Env, WorkerQueueMessage } from "../shared/types";

export async function handleQueue(
	batch: MessageBatch<WorkerQueueMessage>,
	env: Env,
) {
	for (const message of batch.messages) {
		if (isTmdbEnrichmentQueueMessage(message.body)) {
			const rows = message.body.tmdbIds.map((tmdbId) => ({ tmdb_id: tmdbId }));

			await processTmdbEnrichmentRows(
				env,
				message.body.jobRunId,
				rows,
				"queue",
			);

			message.ack();
			continue;
		}

		await insertImdbRatingQueueRows(env, message.body.rows);
		message.ack();
	}
}
