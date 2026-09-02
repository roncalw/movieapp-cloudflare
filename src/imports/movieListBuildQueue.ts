import { releaseImportJobLock } from "../jobs/importJobLocks";
import {
	failActiveImportJobRun,
	finishImportJobRun,
	getImportJobRunById,
	IMDB_RATINGS_JOB_NAME,
	MOVIE_LIST_BUILD_JOB_NAME,
	TMDB_POPULARITY_REFRESH_JOB_NAME,
	updateImportJobRunProgress,
} from "../jobs/importJobRuns";
import { logEvent } from "../shared/logging";
import type {
	Env,
	MovieListBuildCleanupQueueMessage,
	MovieListBuildFinalizeQueueMessage,
	MovieListBuildQueueContext,
	MovieListPopularitySyncQueueMessage,
} from "../shared/types";
import { recordMovieListCurrentCountSnapshot } from "./movieListLoadCounts";

export const MOVIE_LIST_BUILD_QUEUE_NAME =
	"movieapp-movie-list-build-queue";

const MOVIE_LIST_POPULARITY_TMDB_ID_RANGE = 10_000;
const MOVIE_LIST_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const MOVIE_LIST_BUILD_LOCK_HEARTBEAT_MINUTES = 240;
const TERMINAL_JOB_STATUSES = new Set([
	"complete",
	"complete_with_errors",
	"failed",
	"cancelled",
	"skipped",
]);

type MovieListQueueDataMessage =
	| MovieListPopularitySyncQueueMessage
	| MovieListBuildCleanupQueueMessage;

function chunkMessages<T>(messages: T[], chunkSize: number) {
	const chunks: T[][] = [];

	for (let index = 0; index < messages.length; index += chunkSize) {
		chunks.push(messages.slice(index, index + chunkSize));
	}

	return chunks;
}

async function sendPhaseMessages(
	env: Env,
	messages: MovieListQueueDataMessage[],
	finalizer: MovieListBuildFinalizeQueueMessage,
) {
	for (const chunk of chunkMessages(
		messages,
		MOVIE_LIST_QUEUE_MESSAGES_PER_SEND_BATCH,
	)) {
		await env.MOVIE_LIST_BUILD_QUEUE.sendBatch(
			chunk.map((body) => ({ body })),
		);
	}

	await env.MOVIE_LIST_BUILD_QUEUE.send(finalizer);
}

export function buildMovieListPopularityRangeMessages(
	jobRunId: string,
	lockOwner: string,
	popularityRunId: string,
	maxTmdbId: number,
) {
	const messages: MovieListPopularitySyncQueueMessage[] = [];

	for (
		let firstTmdbIdExclusive = 0;
		firstTmdbIdExclusive < maxTmdbId;
		firstTmdbIdExclusive += MOVIE_LIST_POPULARITY_TMDB_ID_RANGE
	) {
		const lastTmdbIdInclusive = Math.min(
			firstTmdbIdExclusive + MOVIE_LIST_POPULARITY_TMDB_ID_RANGE,
			maxTmdbId,
		);
		messages.push({
			kind: "movie-list-popularity-sync",
			jobRunId,
			messageId: `${jobRunId}-popularity-sync-${String(lastTmdbIdInclusive).padStart(10, "0")}`,
			lockOwner,
			popularityRunId,
			firstTmdbIdExclusive,
			lastTmdbIdInclusive,
		});
	}

	return messages;
}

export function buildMovieListImdbCleanupMessages(
	jobRunId: string,
	lockOwner: string,
	selectedRunId: string,
	previousAppliedRunId: string | null,
) {
	/*
		IMDb identifiers begin with "tt" followed by digits. One thousand ordered
		string ranges split them by the first three digits after "tt". This keeps
		each DELETE small while still using the table's (load_run_id, imdb_id)
		primary key. The open-ended first and last ranges also remove any malformed
		historical identifier instead of silently leaving it behind.
	*/
	return Array.from({ length: 1_000 }, (_, index) => {
		const lowerImdbIdInclusive =
			index === 0 ? null : `tt${String(index).padStart(3, "0")}`;
		const upperImdbIdExclusive =
			index === 999
				? null
				: `tt${String(index + 1).padStart(3, "0")}`;

		return {
			kind: "movie-list-build-cleanup",
			jobRunId,
			messageId: `${jobRunId}-imdb-cleanup-${String(index).padStart(4, "0")}`,
			lockOwner,
			stage: "imdb-cleanup",
			selectedRunId,
			previousAppliedRunId,
			lowerImdbIdInclusive,
			upperImdbIdExclusive,
		} satisfies MovieListBuildCleanupQueueMessage;
	});
}

export function buildMovieListPopularityCleanupMessages(
	jobRunId: string,
	lockOwner: string,
	selectedRunId: string,
	previousAppliedRunId: string | null,
	maxTmdbId: number,
) {
	const messages: MovieListBuildCleanupQueueMessage[] = [];

	for (
		let firstTmdbIdExclusive = 0;
		firstTmdbIdExclusive < maxTmdbId;
		firstTmdbIdExclusive += MOVIE_LIST_POPULARITY_TMDB_ID_RANGE
	) {
		const lastTmdbIdInclusive = Math.min(
			firstTmdbIdExclusive + MOVIE_LIST_POPULARITY_TMDB_ID_RANGE,
			maxTmdbId,
		);
		messages.push({
			kind: "movie-list-build-cleanup",
			jobRunId,
			messageId: `${jobRunId}-popularity-cleanup-${String(lastTmdbIdInclusive).padStart(10, "0")}`,
			lockOwner,
			stage: "popularity-cleanup",
			selectedRunId,
			previousAppliedRunId,
			firstTmdbIdExclusive,
			lastTmdbIdInclusive,
		});
	}

	return messages;
}

export function isMovieListPopularitySyncQueueMessage(
	body: unknown,
): body is MovieListPopularitySyncQueueMessage {
	return (
		typeof body === "object" &&
		body !== null &&
		"kind" in body &&
		body.kind === "movie-list-popularity-sync"
	);
}

export function isMovieListBuildCleanupQueueMessage(
	body: unknown,
): body is MovieListBuildCleanupQueueMessage {
	return (
		typeof body === "object" &&
		body !== null &&
		"kind" in body &&
		body.kind === "movie-list-build-cleanup"
	);
}

export function isMovieListBuildFinalizeQueueMessage(
	body: unknown,
): body is MovieListBuildFinalizeQueueMessage {
	return (
		typeof body === "object" &&
		body !== null &&
		"kind" in body &&
		body.kind === "movie-list-build-finalize"
	);
}

export async function recordMovieListQueueError(
	env: Env,
	message: MovieListQueueDataMessage | MovieListBuildFinalizeQueueMessage,
	error: unknown,
) {
	const errorMessage = error instanceof Error ? error.message : String(error);

	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET last_progress_at = CURRENT_TIMESTAMP,
		     result_json = json_set(
		       COALESCE(result_json, '{}'),
		       '$.lastQueueError',
		       ?,
		       '$.lastQueueErrorAt',
		       CURRENT_TIMESTAMP,
		       '$.lastQueueErrorMessageId',
		       ?
		     )
		 WHERE job_run_id = ?
		   AND status IN ('queued', 'running')`,
	)
		.bind(errorMessage, message.messageId, message.jobRunId)
		.run();
}

async function getMaximumPopularityTmdbId(env: Env, loadRunId: string) {
	const row = await env.DB.prepare(
		`SELECT MAX(tmdb_id) AS maxTmdbId
		 FROM tmdb_movie_popularity_staging
		 WHERE load_run_id = ?`,
	)
		.bind(loadRunId)
		.first<{ maxTmdbId: number | null }>();

	return row?.maxTmdbId ?? 0;
}

export async function enqueueMovieListPopularityQueueWork(
	env: Env,
	jobRunId: string,
	context: MovieListBuildQueueContext,
) {
	const maxTmdbId = await getMaximumPopularityTmdbId(
		env,
		context.popularitySourceJobRunId,
	);
	const queuedContext = {
		...context,
		popularityMaxTmdbId: maxTmdbId,
	};
	const messages = buildMovieListPopularityRangeMessages(
		jobRunId,
		context.lockOwner,
		context.popularitySourceJobRunId,
		maxTmdbId,
	);
	const totalSelectedRows =
		context.baseSelectedRows + context.popularityCandidateRows;
	const initialResult = {
		jobRunId,
		trigger: context.trigger,
		executionMode: "queued-popularity-sync",
		phase: "popularity-sync",
		dependencyRunDate: context.dependencyRunDate,
		lastSuccessfulBuildEndedAt: context.lastSuccessfulBuildEndedAt,
		upsertedRows: context.upsertedRows,
		imdbSourceJobRunId: context.imdbSourceJobRunId,
		imdbSourceMode: context.imdbSourceMode,
		imdbSourceStartedAt: context.imdbSourceStartedAt,
		imdbSourceEndedAt: context.imdbSourceEndedAt,
		imdbRunWasExplicit: context.imdbRunWasExplicit,
		imdbSync: context.imdbSync,
		popularitySourceJobRunId: context.popularitySourceJobRunId,
		popularitySourceStartedAt: context.popularitySourceStartedAt,
		popularitySourceEndedAt: context.popularitySourceEndedAt,
		popularityRunWasExplicit: context.popularityRunWasExplicit,
		popularityCandidateRows: context.popularityCandidateRows,
		popularityUpdatedRows: 0,
		popularityRemainingRows: context.popularityCandidateRows,
		popularityQueueMessageCount: messages.length,
		popularityTmdbIdRange: MOVIE_LIST_POPULARITY_TMDB_ID_RANGE,
		readiness: context.readiness,
		genrePromotion: context.genrePromotion,
		startedAt: context.startedAt,
	};

	/*
		The extra selected item is a completion sentinel. Range messages can bring
		processed_count up to the real row total, but never to selected_count. The
		finalizer removes the sentinel only after it verifies every range, performs
		bounded staging cleanup, and records the final count snapshot.
	*/
	await updateImportJobRunProgress(env, jobRunId, {
		selected: totalSelectedRows + 1,
		queued: totalSelectedRows + 1,
		processed: context.baseUpdatedRows,
		updated: context.baseUpdatedRows,
		result: initialResult,
	});

	const finalizer: MovieListBuildFinalizeQueueMessage = {
		kind: "movie-list-build-finalize",
		jobRunId,
		messageId: `${jobRunId}-popularity-sync-finalize`,
		stage: "popularity-sync",
		expectedMessageCount: messages.length,
		context: queuedContext,
	};
	await sendPhaseMessages(env, messages, finalizer);

	logEvent("movie-list-popularity-queue-enqueued", {
		jobRunId,
		popularityCandidateRows: context.popularityCandidateRows,
		queueMessageCount: messages.length,
		maxTmdbId,
	});

	return {
		...initialResult,
		queued: true,
		monitorEndpoint:
			"/admin/import/job-runs?jobName=movie-list-build&limit=1",
	};
}

async function recordMovieListQueueMessage(
	env: Env,
	options: {
		jobRunId: string;
		messageId: string;
		stage: string;
		processedRows: number;
		updatedRows: number;
		lastTmdbId?: number;
		lockOwner: string;
		dataStatement: D1PreparedStatement;
	},
) {
	const insertStatement = env.DB.prepare(
		`INSERT OR IGNORE INTO import_job_queue_messages (
		   job_run_id,
		   message_id,
		   job_name,
		   queue_name,
		   processed_count,
		   updated_count,
		   error_count,
		   provider_rows_inserted,
		   last_error
		 )
		 VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
	)
		.bind(
			options.jobRunId,
			options.messageId,
			MOVIE_LIST_BUILD_JOB_NAME,
			MOVIE_LIST_BUILD_QUEUE_NAME,
			options.processedRows,
			options.updatedRows,
		);
	const progressStatement = env.DB.prepare(
		`UPDATE import_job_runs
		 SET status = 'running',
		     processed_count = processed_count + ?,
		     updated_count = updated_count + ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     result_json = json_set(
		       COALESCE(result_json, '{}'),
		       '$.phase',
		       ?,
		       '$.lastQueueMessageId',
		       ?,
		       '$.lastTmdbId',
		       COALESCE(?, json_extract(COALESCE(result_json, '{}'), '$.lastTmdbId')),
		       '$.popularityUpdatedRows',
		       COALESCE(json_extract(COALESCE(result_json, '{}'), '$.popularityUpdatedRows'), 0) + ?,
		       '$.popularityRemainingRows',
		       MAX(
		         COALESCE(json_extract(COALESCE(result_json, '{}'), '$.popularityCandidateRows'), 0) -
		         (
		           COALESCE(json_extract(COALESCE(result_json, '{}'), '$.popularityUpdatedRows'), 0) + ?
		         ),
		         0
		       )
		     )
		 WHERE job_run_id = ?
		   AND status IN ('queued', 'running')
		   AND changes() > 0`,
	)
		.bind(
			options.processedRows,
			options.updatedRows,
			options.stage,
			options.messageId,
			options.lastTmdbId ?? null,
			options.stage === "popularity-sync" ? options.updatedRows : 0,
			options.stage === "popularity-sync" ? options.updatedRows : 0,
			options.jobRunId,
		);
	const lockHeartbeatStatement = env.DB.prepare(
		`UPDATE import_job_locks
		 SET lock_expires_at = datetime('now', '+' || ? || ' minutes')
		 WHERE job_name = ?
		   AND owner = ?`,
	)
		.bind(
			MOVIE_LIST_BUILD_LOCK_HEARTBEAT_MINUTES,
			MOVIE_LIST_BUILD_JOB_NAME,
			options.lockOwner,
		);

	const batchResult = await env.DB.batch([
		options.dataStatement,
		insertStatement,
		progressStatement,
		lockHeartbeatStatement,
	]);
	const dataChangeCount = batchResult[0]?.meta.changes ?? 0;
	const insertedCompletion = batchResult[1]?.meta.changes ?? 0;

	if (
		insertedCompletion > 0 &&
		options.stage === "popularity-sync" &&
		dataChangeCount !== options.updatedRows
	) {
		const reason =
			`Movie List popularity range ${options.messageId} selected ` +
			`${options.updatedRows} difference(s) but changed ${dataChangeCount}.`;
		await failActiveImportJobRun(env, options.jobRunId, reason);
		await releaseImportJobLock(
			env,
			MOVIE_LIST_BUILD_JOB_NAME,
			options.lockOwner,
		);
		throw new Error(reason);
	}

	return {
		dataChangeCount,
		completionRecorded: insertedCompletion > 0,
	};
}

async function getPopularityDifferenceCountForRange(
	env: Env,
	message: MovieListPopularitySyncQueueMessage,
) {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS candidateRows
		 FROM movie_list_items AS movie
		 JOIN tmdb_movie_popularity_staging AS popularity
		   ON popularity.load_run_id = ?
		  AND popularity.tmdb_id = movie.tmdb_id
		 WHERE movie.tmdb_id > ?
		   AND movie.tmdb_id <= ?
		   AND movie.popularity IS NOT popularity.popularity`,
	)
		.bind(
			message.popularityRunId,
			message.firstTmdbIdExclusive,
			message.lastTmdbIdInclusive,
		)
		.first<{ candidateRows: number }>();

	return row?.candidateRows ?? 0;
}

export async function processMovieListPopularitySyncMessage(
	env: Env,
	message: MovieListPopularitySyncQueueMessage,
) {
	const run = await getImportJobRunById(env, message.jobRunId);

	if (!run) {
		throw new Error(`Movie List queue cannot find job ${message.jobRunId}.`);
	}

	if (TERMINAL_JOB_STATUSES.has(run.status)) {
		return { ignored: true, terminalStatus: run.status };
	}

	const candidateRows = await getPopularityDifferenceCountForRange(
		env,
		message,
	);
	const updateStatement = env.DB.prepare(
		`UPDATE movie_list_items AS movie
		 SET popularity = popularity_source.popularity,
		     last_refreshed_at = CURRENT_TIMESTAMP
		 FROM tmdb_movie_popularity_staging AS popularity_source
		 WHERE popularity_source.load_run_id = ?
		   AND movie.tmdb_id = popularity_source.tmdb_id
		   AND movie.tmdb_id > ?
		   AND movie.tmdb_id <= ?
		   AND movie.popularity IS NOT popularity_source.popularity`,
	)
		.bind(
			message.popularityRunId,
			message.firstTmdbIdExclusive,
			message.lastTmdbIdInclusive,
		);
	const recorded = await recordMovieListQueueMessage(env, {
		jobRunId: message.jobRunId,
		messageId: message.messageId,
		stage: "popularity-sync",
		processedRows: candidateRows,
		updatedRows: candidateRows,
		lastTmdbId: message.lastTmdbIdInclusive,
		lockOwner: message.lockOwner,
		dataStatement: updateStatement,
	});

	logEvent("movie-list-popularity-range-complete", {
		jobRunId: message.jobRunId,
		messageId: message.messageId,
		firstTmdbIdExclusive: message.firstTmdbIdExclusive,
		lastTmdbIdInclusive: message.lastTmdbIdInclusive,
		candidateRows,
		updatedRows: recorded.dataChangeCount,
		completionRecorded: recorded.completionRecorded,
	});

	return {
		candidateRows,
		updatedRows: recorded.dataChangeCount,
		completionRecorded: recorded.completionRecorded,
	};
}

export async function processMovieListBuildCleanupMessage(
	env: Env,
	message: MovieListBuildCleanupQueueMessage,
) {
	const run = await getImportJobRunById(env, message.jobRunId);

	if (!run) {
		throw new Error(`Movie List cleanup cannot find job ${message.jobRunId}.`);
	}

	if (TERMINAL_JOB_STATUSES.has(run.status)) {
		return { ignored: true, terminalStatus: run.status };
	}

	const activeJobName =
		message.stage === "imdb-cleanup"
			? IMDB_RATINGS_JOB_NAME
			: TMDB_POPULARITY_REFRESH_JOB_NAME;
	const deleteStatement =
		message.stage === "imdb-cleanup"
			? env.DB.prepare(
					`DELETE FROM imdb_ratings_staging_by_run
					 WHERE load_run_id IN (
					     SELECT job_run_id
					     FROM import_job_runs
					     WHERE job_name = ?
					       AND status NOT IN ('queued', 'running')
					       AND job_run_id <> ?
					       AND job_run_id <> ?
					   )
					   AND (? IS NULL OR imdb_id >= ?)
					   AND (? IS NULL OR imdb_id < ?)`,
				)
					.bind(
						activeJobName,
						message.selectedRunId,
						message.previousAppliedRunId ?? message.selectedRunId,
						message.lowerImdbIdInclusive ?? null,
						message.lowerImdbIdInclusive ?? null,
						message.upperImdbIdExclusive ?? null,
						message.upperImdbIdExclusive ?? null,
					)
			: env.DB.prepare(
					`DELETE FROM tmdb_movie_popularity_staging
					 WHERE load_run_id IN (
					     SELECT job_run_id
					     FROM import_job_runs
					     WHERE job_name = ?
					       AND status NOT IN ('queued', 'running')
					       AND job_run_id <> ?
					       AND job_run_id <> ?
					   )
					   AND tmdb_id > ?
					   AND tmdb_id <= ?`,
				)
					.bind(
						activeJobName,
						message.selectedRunId,
						message.previousAppliedRunId ?? message.selectedRunId,
						message.firstTmdbIdExclusive ?? 0,
						message.lastTmdbIdInclusive ?? 0,
					);
	const recorded = await recordMovieListQueueMessage(env, {
		jobRunId: message.jobRunId,
		messageId: message.messageId,
		stage: message.stage,
		processedRows: 0,
		updatedRows: 0,
		lastTmdbId: message.lastTmdbIdInclusive,
		lockOwner: message.lockOwner,
		dataStatement: deleteStatement,
	});

	logEvent("movie-list-staging-cleanup-range-complete", {
		jobRunId: message.jobRunId,
		messageId: message.messageId,
		stage: message.stage,
		deletedRows: recorded.dataChangeCount,
		completionRecorded: recorded.completionRecorded,
	});

	return {
		deletedRows: recorded.dataChangeCount,
		completionRecorded: recorded.completionRecorded,
	};
}

async function getCompletedPhaseMessageCount(
	env: Env,
	jobRunId: string,
	stage: MovieListBuildFinalizeQueueMessage["stage"],
) {
	const messageIdPrefix = `${jobRunId}-${stage}-`;
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS completedMessageCount
		 FROM import_job_queue_messages
		 WHERE job_run_id = ?
		   AND job_name = ?
		   AND substr(message_id, 1, ?) = ?`,
	)
		.bind(
			jobRunId,
			MOVIE_LIST_BUILD_JOB_NAME,
			messageIdPrefix.length,
			messageIdPrefix,
		)
		.first<{ completedMessageCount: number }>();

	return row?.completedMessageCount ?? 0;
}

async function getPopularityDifferenceCount(
	env: Env,
	popularityRunId: string,
) {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS candidateRows
		 FROM movie_list_items AS movie
		 JOIN tmdb_movie_popularity_staging AS popularity
		   ON popularity.load_run_id = ?
		  AND popularity.tmdb_id = movie.tmdb_id
		 WHERE movie.popularity IS NOT popularity.popularity`,
	)
		.bind(popularityRunId)
		.first<{ candidateRows: number }>();

	return row?.candidateRows ?? 0;
}

async function getPreviouslyAppliedSourceRunId(
	env: Env,
	resultJsonPath: string,
	excludeSourceRunId: string,
) {
	const row = await env.DB.prepare(
		`SELECT json_extract(COALESCE(result_json, '{}'), ?) AS sourceRunId
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status = 'complete'
		   AND error_count = 0
		   AND ended_at IS NOT NULL
		   AND json_extract(COALESCE(result_json, '{}'), ?) IS NOT NULL
		   AND json_extract(COALESCE(result_json, '{}'), ?) <> ?
		 ORDER BY ended_at DESC
		 LIMIT 1`,
	)
		.bind(
			resultJsonPath,
			MOVIE_LIST_BUILD_JOB_NAME,
			resultJsonPath,
			resultJsonPath,
			excludeSourceRunId,
		)
		.first<{ sourceRunId: string | null }>();

	return row?.sourceRunId ?? null;
}

async function getOldStagingRowCount(
	env: Env,
	options: {
		tableName:
			| "imdb_ratings_staging_by_run"
			| "tmdb_movie_popularity_staging";
		activeJobName: string;
		selectedRunId: string;
		previousAppliedRunId: string | null;
	},
) {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS oldRows
		 FROM ${options.tableName}
		 WHERE load_run_id <> ?
		   AND load_run_id <> ?
		   AND load_run_id NOT IN (
		     SELECT job_run_id
		     FROM import_job_runs
		     WHERE job_name = ?
		       AND status IN ('queued', 'running')
		   )`,
	)
		.bind(
			options.selectedRunId,
			options.previousAppliedRunId ?? options.selectedRunId,
			options.activeJobName,
		)
		.first<{ oldRows: number }>();

	return row?.oldRows ?? 0;
}

async function getMaximumOldPopularityTmdbId(
	env: Env,
	selectedRunId: string,
	previousAppliedRunId: string | null,
) {
	const row = await env.DB.prepare(
		`SELECT MAX(tmdb_id) AS maxTmdbId
		 FROM tmdb_movie_popularity_staging
		 WHERE load_run_id <> ?
		   AND load_run_id <> ?
		   AND load_run_id NOT IN (
		     SELECT job_run_id
		     FROM import_job_runs
		     WHERE job_name = ?
		       AND status IN ('queued', 'running')
		   )`,
	)
		.bind(
			selectedRunId,
			previousAppliedRunId ?? selectedRunId,
			TMDB_POPULARITY_REFRESH_JOB_NAME,
		)
		.first<{ maxTmdbId: number | null }>();

	return row?.maxTmdbId ?? 0;
}

async function updateQueuedPhaseResult(
	env: Env,
	jobRunId: string,
	phase: MovieListBuildFinalizeQueueMessage["stage"],
	context: MovieListBuildQueueContext,
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status = 'running',
		     last_progress_at = CURRENT_TIMESTAMP,
		     result_json = json_set(
		       COALESCE(result_json, '{}'),
		       '$.phase',
		       ?,
		       '$.imdbCleanupCandidateRows',
		       ?,
		       '$.popularityCleanupCandidateRows',
		       ?
		     )
		 WHERE job_run_id = ?
		   AND status IN ('queued', 'running')`,
	)
		.bind(
			phase,
			context.imdbCleanupCandidateRows ?? null,
			context.popularityCleanupCandidateRows ?? null,
			jobRunId,
		)
		.run();
}

async function failQueuedMovieListBuild(
	env: Env,
	message: MovieListBuildFinalizeQueueMessage,
	reason: string,
) {
	await failActiveImportJobRun(env, message.jobRunId, reason);
	await releaseImportJobLock(
		env,
		MOVIE_LIST_BUILD_JOB_NAME,
		message.context.lockOwner,
	);
	return { pending: false, terminalStatus: "failed", reason };
}

async function enqueueImdbCleanup(
	env: Env,
	message: MovieListBuildFinalizeQueueMessage,
) {
	if (message.context.imdbSourceMode !== "run-separated") {
		const context = {
			...message.context,
			imdbCleanupCandidateRows: 0,
			imdbCleanupSkipped: true,
			imdbCleanupSkipReason: "legacy_time_window_source",
		};
		const finalizer: MovieListBuildFinalizeQueueMessage = {
			kind: "movie-list-build-finalize",
			jobRunId: message.jobRunId,
			messageId: `${message.jobRunId}-imdb-cleanup-finalize`,
			stage: "imdb-cleanup",
			expectedMessageCount: 0,
			context,
		};

		await updateQueuedPhaseResult(
			env,
			message.jobRunId,
			"imdb-cleanup",
			context,
		);
		await sendPhaseMessages(env, [], finalizer);

		return { pending: false, transitionedTo: "imdb-cleanup" };
	}

	const previousAppliedRunId = await getPreviouslyAppliedSourceRunId(
		env,
		"$.imdbSourceJobRunId",
		message.context.imdbSourceJobRunId,
	);
	const actualCandidateRows = await getOldStagingRowCount(env, {
		tableName: "imdb_ratings_staging_by_run",
		activeJobName: IMDB_RATINGS_JOB_NAME,
		selectedRunId: message.context.imdbSourceJobRunId,
		previousAppliedRunId,
	});
	const context = {
		...message.context,
		imdbCleanupPreviousRunId: previousAppliedRunId,
		imdbCleanupCandidateRows: actualCandidateRows,
	};
	const messages =
		actualCandidateRows > 0
			? buildMovieListImdbCleanupMessages(
					message.jobRunId,
					message.context.lockOwner,
					context.imdbSourceJobRunId,
					previousAppliedRunId,
				)
			: [];
	const finalizer: MovieListBuildFinalizeQueueMessage = {
		kind: "movie-list-build-finalize",
		jobRunId: message.jobRunId,
		messageId: `${message.jobRunId}-imdb-cleanup-finalize`,
		stage: "imdb-cleanup",
		expectedMessageCount: messages.length,
		context,
	};

	await updateQueuedPhaseResult(env, message.jobRunId, "imdb-cleanup", context);
	await sendPhaseMessages(env, messages, finalizer);

	logEvent("movie-list-imdb-cleanup-enqueued", {
		jobRunId: message.jobRunId,
		candidateRows: actualCandidateRows,
		queueMessageCount: messages.length,
	});

	return { pending: false, transitionedTo: "imdb-cleanup" };
}

async function enqueuePopularityCleanup(
	env: Env,
	message: MovieListBuildFinalizeQueueMessage,
) {
	const previousAppliedRunId = await getPreviouslyAppliedSourceRunId(
		env,
		"$.popularitySourceJobRunId",
		message.context.popularitySourceJobRunId,
	);
	const [candidateRows, maxTmdbId] = await Promise.all([
		getOldStagingRowCount(env, {
			tableName: "tmdb_movie_popularity_staging",
			activeJobName: TMDB_POPULARITY_REFRESH_JOB_NAME,
			selectedRunId: message.context.popularitySourceJobRunId,
			previousAppliedRunId,
		}),
		getMaximumOldPopularityTmdbId(
			env,
			message.context.popularitySourceJobRunId,
			previousAppliedRunId,
		),
	]);
	const context = {
		...message.context,
		popularityCleanupPreviousRunId: previousAppliedRunId,
		popularityCleanupCandidateRows: candidateRows,
	};
	const messages =
		candidateRows > 0
			? buildMovieListPopularityCleanupMessages(
					message.jobRunId,
					message.context.lockOwner,
					context.popularitySourceJobRunId,
					previousAppliedRunId,
					maxTmdbId,
				)
			: [];
	const finalizer: MovieListBuildFinalizeQueueMessage = {
		kind: "movie-list-build-finalize",
		jobRunId: message.jobRunId,
		messageId: `${message.jobRunId}-popularity-cleanup-finalize`,
		stage: "popularity-cleanup",
		expectedMessageCount: messages.length,
		context,
	};

	await updateQueuedPhaseResult(
		env,
		message.jobRunId,
		"popularity-cleanup",
		context,
	);
	await sendPhaseMessages(env, messages, finalizer);

	logEvent("movie-list-popularity-cleanup-enqueued", {
		jobRunId: message.jobRunId,
		candidateRows,
		queueMessageCount: messages.length,
		maxTmdbId,
	});

	return { pending: false, transitionedTo: "popularity-cleanup" };
}

async function completeQueuedMovieListBuild(
	env: Env,
	message: MovieListBuildFinalizeQueueMessage,
) {
	const remainingOldPopularityRows = await getOldStagingRowCount(env, {
		tableName: "tmdb_movie_popularity_staging",
		activeJobName: TMDB_POPULARITY_REFRESH_JOB_NAME,
		selectedRunId: message.context.popularitySourceJobRunId,
		previousAppliedRunId:
			message.context.popularityCleanupPreviousRunId ?? null,
	});

	if (remainingOldPopularityRows !== 0) {
		return failQueuedMovieListBuild(
			env,
			message,
			`Movie List popularity cleanup left ${remainingOldPopularityRows} old staging row(s).`,
		);
	}

	const countResult = await env.DB.prepare(
		"SELECT COUNT(*) AS movie_list_count FROM movie_list_items",
	).first<{ movie_list_count: number }>();
	const currentCountSnapshot = await recordMovieListCurrentCountSnapshot(
		env,
		message.context.trigger,
	);
	const endedAtMs = Date.now();
	const startedAtMs = Date.parse(message.context.startedAt);
	const popularitySync = {
		candidateRows: message.context.popularityCandidateRows,
		updatedRows: message.context.popularityCandidateRows,
		remainingRows: 0,
		lastTmdbId: message.context.popularityMaxTmdbId ?? 0,
	};
	const result = {
		jobRunId: message.jobRunId,
		trigger: message.context.trigger,
		executionMode: "queued-popularity-sync",
		movieListCount: countResult?.movie_list_count ?? 0,
		dependencyRunDate: message.context.dependencyRunDate,
		lastSuccessfulBuildEndedAt:
			message.context.lastSuccessfulBuildEndedAt,
		insertChunkRows: 10_000,
		imdbUpdateChunkRows: 1_000,
		popularityTmdbIdRange: MOVIE_LIST_POPULARITY_TMDB_ID_RANGE,
		upsertedRows: message.context.upsertedRows,
		imdbSourceJobRunId: message.context.imdbSourceJobRunId,
		imdbSourceMode: message.context.imdbSourceMode,
		imdbRunWasExplicit: message.context.imdbRunWasExplicit,
		imdbSourceStartedAt: message.context.imdbSourceStartedAt,
		imdbSourceEndedAt: message.context.imdbSourceEndedAt,
		imdbSync: message.context.imdbSync,
		imdbStagingCleanup: {
			skipped: message.context.imdbCleanupSkipped ?? false,
			skipReason: message.context.imdbCleanupSkipReason ?? null,
			selectedRunId: message.context.imdbSourceJobRunId,
			previousAppliedRunId:
				message.context.imdbCleanupPreviousRunId ?? null,
			deletedRows: message.context.imdbCleanupCandidateRows ?? 0,
			executionMode: "queued-ranges",
		},
		popularitySourceJobRunId:
			message.context.popularitySourceJobRunId,
		popularitySourceStartedAt:
			message.context.popularitySourceStartedAt,
		popularitySourceEndedAt:
			message.context.popularitySourceEndedAt,
		popularityRunWasExplicit:
			message.context.popularityRunWasExplicit,
		popularitySync,
		popularityStagingCleanup: {
			selectedRunId: message.context.popularitySourceJobRunId,
			previousAppliedRunId:
				message.context.popularityCleanupPreviousRunId ?? null,
			deletedRows:
				message.context.popularityCleanupCandidateRows ?? 0,
			executionMode: "queued-ranges",
		},
		deletedRows: 0,
		genrePromotion: message.context.genrePromotion,
		readiness: message.context.readiness,
		currentCountSnapshot,
		startedAt: message.context.startedAt,
		endedAt: new Date(endedAtMs).toISOString(),
		durationMs:
			Number.isFinite(startedAtMs) ? endedAtMs - startedAtMs : null,
	};
	const totalRows =
		message.context.baseSelectedRows +
		message.context.popularityCandidateRows;

	await finishImportJobRun(env, message.jobRunId, {
		status: "complete",
		selected: totalRows,
		queued: totalRows,
		processed: totalRows,
		updated: totalRows,
		errors: 0,
		result,
	});
	await releaseImportJobLock(
		env,
		MOVIE_LIST_BUILD_JOB_NAME,
		message.context.lockOwner,
	);

	logEvent("movie-list-build-queued-complete", result);

	return { pending: false, terminalStatus: "complete", result };
}

export async function finalizeMovieListBuildQueuePhase(
	env: Env,
	message: MovieListBuildFinalizeQueueMessage,
) {
	const run = await getImportJobRunById(env, message.jobRunId);

	if (!run) {
		throw new Error(`Movie List finalizer cannot find job ${message.jobRunId}.`);
	}

	if (TERMINAL_JOB_STATUSES.has(run.status)) {
		await releaseImportJobLock(
			env,
			MOVIE_LIST_BUILD_JOB_NAME,
			message.context.lockOwner,
		);
		return { pending: false, terminalStatus: run.status };
	}

	const currentPhase = (() => {
		try {
			const result = JSON.parse(run.result_json ?? "{}") as {
				phase?: unknown;
			};
			return typeof result.phase === "string" ? result.phase : null;
		} catch {
			return null;
		}
	})();
	const phaseOrder = [
		"popularity-sync",
		"imdb-cleanup",
		"popularity-cleanup",
	];
	const currentPhaseIndex = currentPhase
		? phaseOrder.indexOf(currentPhase)
		: -1;
	const messagePhaseIndex = phaseOrder.indexOf(message.stage);

	if (currentPhaseIndex > messagePhaseIndex) {
		return {
			pending: false,
			ignored: true,
			reason: "phase_already_advanced",
			currentPhase,
			messagePhase: message.stage,
		};
	}

	const completedMessageCount = await getCompletedPhaseMessageCount(
		env,
		message.jobRunId,
		message.stage,
	);

	if (completedMessageCount < message.expectedMessageCount) {
		logEvent("movie-list-build-finalizer-waiting", {
			jobRunId: message.jobRunId,
			stage: message.stage,
			completedMessageCount,
			expectedMessageCount: message.expectedMessageCount,
		});
		return {
			pending: true,
			completedMessageCount,
			expectedMessageCount: message.expectedMessageCount,
		};
	}

	if (message.stage === "popularity-sync") {
		const remainingRows = await getPopularityDifferenceCount(
			env,
			message.context.popularitySourceJobRunId,
		);

		if (remainingRows !== 0) {
			return failQueuedMovieListBuild(
				env,
				message,
				`Movie List popularity synchronization left ${remainingRows} eligible row(s) different from ${message.context.popularitySourceJobRunId}.`,
			);
		}

		return enqueueImdbCleanup(env, message);
	}

	if (message.stage === "imdb-cleanup") {
		if (message.context.imdbCleanupSkipped) {
			return enqueuePopularityCleanup(env, message);
		}

		const remainingRows = await getOldStagingRowCount(env, {
			tableName: "imdb_ratings_staging_by_run",
			activeJobName: IMDB_RATINGS_JOB_NAME,
			selectedRunId: message.context.imdbSourceJobRunId,
			previousAppliedRunId:
				message.context.imdbCleanupPreviousRunId ?? null,
		});

		if (remainingRows !== 0) {
			return failQueuedMovieListBuild(
				env,
				message,
				`Movie List IMDb cleanup left ${remainingRows} old staging row(s).`,
			);
		}

		return enqueuePopularityCleanup(env, message);
	}

	return completeQueuedMovieListBuild(env, message);
}
