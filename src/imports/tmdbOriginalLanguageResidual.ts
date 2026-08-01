import {
	getTmdbMovieOriginalLanguage,
	isTerminalTmdbEnrichmentError,
} from "../externalApis/tmdbClient";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getActiveImportJobRun,
	getImportJobRunById,
	recordImportJobQueueMessageCompletion,
	setImportJobRunQueueTotals,
	TMDB_ORIGINAL_LANGUAGE_RESIDUAL_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import { logEvent } from "../shared/logging";
import type {
	Env,
	TmdbOriginalLanguageResidualQueueMessage,
	WorkerQueueMessage,
} from "../shared/types";
import { updateOriginalLanguagesForPage } from "./tmdbOriginalLanguageBackfill";

type MissingOriginalLanguageRow = {
	tmdb_id: number;
};

const IDS_PER_QUEUE_MESSAGE = 100;
const QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_CONCURRENCY = 25;
const TMDB_ENRICHMENT_QUEUE_NAME = "movieapp-tmdb-enrichment-queue";

export function isTmdbOriginalLanguageResidualQueueMessage(
	body: WorkerQueueMessage,
): body is TmdbOriginalLanguageResidualQueueMessage {
	return "kind" in body && body.kind === "tmdb-original-language-residual";
}

export async function enqueueTmdbOriginalLanguageResidual(
	env: Env,
	trigger: ImportJobTrigger = "manual",
) {
	const activeRun = await getActiveImportJobRun(
		env,
		TMDB_ORIGINAL_LANGUAGE_RESIDUAL_JOB_NAME,
	);

	if (activeRun) {
		return {
			jobRunId: activeRun.job_run_id,
			trigger,
			skipped: true,
			skipReason: "residual_job_already_running",
			status: activeRun.status,
			lastProgressAt: activeRun.last_progress_at,
		};
	}

	const { results: rows } = await env.DB.prepare(
		`SELECT tmdb_id
		 FROM tmdb_movies_staging
		 WHERE original_language IS NULL
		 ORDER BY tmdb_id`,
	).all<MissingOriginalLanguageRow>();
	const jobRunId = createImportJobRunId(
		TMDB_ORIGINAL_LANGUAGE_RESIDUAL_JOB_NAME,
		trigger,
	);
	const messages: TmdbOriginalLanguageResidualQueueMessage[] = [];

	for (let index = 0; index < rows.length; index += IDS_PER_QUEUE_MESSAGE) {
		const messageNumber = messages.length + 1;
		messages.push({
			kind: "tmdb-original-language-residual",
			jobRunId,
			messageId: `${jobRunId}-${String(messageNumber).padStart(6, "0")}`,
			tmdbIds: rows
				.slice(index, index + IDS_PER_QUEUE_MESSAGE)
				.map((row) => row.tmdb_id),
		});
	}

	const result = {
		jobRunId,
		trigger,
		selected: rows.length,
		rowsQueued: rows.length,
		messagesQueued: messages.length,
		tmdbConcurrency: TMDB_CONCURRENCY,
		monitorEndpoint:
			"/admin/import/job-runs?jobName=tmdb-original-language-residual&limit=1",
	};

	await createImportJobRun(env, {
		jobRunId,
		jobName: TMDB_ORIGINAL_LANGUAGE_RESIDUAL_JOB_NAME,
		trigger,
	});

	if (rows.length === 0) {
		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			result,
		});
		return result;
	}

	for (
		let index = 0;
		index < messages.length;
		index += QUEUE_MESSAGES_PER_SEND_BATCH
	) {
		await env.TMDB_ENRICHMENT_QUEUE.sendBatch(
			messages.slice(index, index + QUEUE_MESSAGES_PER_SEND_BATCH).map(
				(message) => ({ body: message }),
			),
		);
	}

	await setImportJobRunQueueTotals(env, jobRunId, {
		selected: rows.length,
		queued: rows.length,
		result,
	});

	logEvent("tmdb-original-language-residual-queued", result);

	return result;
}

export async function processTmdbOriginalLanguageResidualMessage(
	env: Env,
	message: TmdbOriginalLanguageResidualQueueMessage,
) {
	const activeJobRun = await getImportJobRunById(env, message.jobRunId);

	if (!activeJobRun || !["running", "queued"].includes(activeJobRun.status)) {
		logEvent("tmdb-original-language-residual-message-skipped", {
			jobRunId: message.jobRunId,
			messageId: message.messageId,
			status: activeJobRun?.status ?? "missing",
		});
		return;
	}

	const resolvedMovies: Array<{
		id: number;
		original_language?: string | null;
	}> = [];
	let skippedCount = 0;

	for (
		let index = 0;
		index < message.tmdbIds.length;
		index += TMDB_CONCURRENCY
	) {
		const tmdbIds = message.tmdbIds.slice(index, index + TMDB_CONCURRENCY);
		const results = await Promise.allSettled(
			tmdbIds.map((tmdbId) => getTmdbMovieOriginalLanguage(tmdbId, env)),
		);

		for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
			const result = results[resultIndex];

			if (result.status === "fulfilled") {
				if (result.value.original_language) {
					resolvedMovies.push(result.value);
				} else {
					skippedCount += 1;
				}
				continue;
			}

			if (isTerminalTmdbEnrichmentError(result.reason)) {
				skippedCount += 1;
				continue;
			}

			throw result.reason;
		}
	}

	const updates = await updateOriginalLanguagesForPage(env, resolvedMovies);

	await recordImportJobQueueMessageCompletion(env, {
		jobRunId: message.jobRunId,
		messageId: message.messageId,
		jobName: TMDB_ORIGINAL_LANGUAGE_RESIDUAL_JOB_NAME,
		queueName: TMDB_ENRICHMENT_QUEUE_NAME,
		stats: {
			processed: message.tmdbIds.length,
			updated: updates.stagingRowsUpdated,
			errors: 0,
			providerRowsInserted: 0,
			tmdbIDNotFoundSkippedCount: skippedCount,
		},
		lastError: null,
	});

	logEvent("tmdb-original-language-residual-message-complete", {
		jobRunId: message.jobRunId,
		messageId: message.messageId,
		selected: message.tmdbIds.length,
		resolved: resolvedMovies.length,
		stagingRowsUpdated: updates.stagingRowsUpdated,
		movieListRowsUpdated: updates.movieListRowsUpdated,
		skipped: skippedCount,
	});
}
