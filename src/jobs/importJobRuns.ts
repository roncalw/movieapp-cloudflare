import type { Env } from "../shared/types";
import { notifyImportJobRunCompletion } from "../notifications/jobNotifications";

export type ImportJobRunRow = {
	job_run_id: string;
	job_name: string;
	status: string;
	trigger: string;
	selected_count: number;
	queued_count: number;
	processed_count: number;
	updated_count: number;
	error_count: number;
	provider_rows_inserted: number;
	started_at: string;
	last_progress_at: string;
	ended_at: string | null;
	last_error: string | null;
	result_json: string | null;
	notification_sent_at: string | null;
	notification_error: string | null;
};

export type ImportJobRunMonitorRow = Omit<ImportJobRunRow, "result_json"> & {
	result_json: unknown;
	duration_ms?: number | null;
};

export type ImportJobProgressStats = {
	processed: number;
	updated: number;
	errors: number;
	providerRowsInserted: number;
	tmdbIDNotFoundSkippedCount?: number;
};

export type ImportJobQueueMessageCompletion = {
	jobRunId: string;
	messageId: string;
	jobName: string;
	queueName: string;
	stats: ImportJobProgressStats;
	lastError: string | null;
	dataStatements?: D1PreparedStatement[];
};

export type ImportJobTrigger = "manual" | "cron";

export const TMDB_ENRICH_JOB_NAME = "tmdb-enrich";
export const TMDB_NEW_MOVIE_DETAILS_JOB_NAME = "tmdb-new-movie-details";
export const TMDB_PROVIDER_REFRESH_JOB_NAME = "tmdb-provider-refresh";
export const TMDB_GENRE_LOOKUP_REFRESH_JOB_NAME =
	"tmdb-genre-lookup-refresh";
export const TMDB_WATCH_PROVIDER_LOOKUP_REFRESH_JOB_NAME =
	"tmdb-watch-provider-lookup-refresh";
export const TMDB_PRIMARY_JOB_NAME = "tmdb-primary";
export const MOVIE_LIST_BUILD_JOB_NAME = "movie-list-build";
export const IMDB_RATINGS_JOB_NAME = "imdb-ratings";
export const MOVIE_LIST_POTENTIAL_LOAD_CHECK_JOB_NAME =
	"movie-list-potential-load-check";
export const MOVIE_LIST_CURRENT_COUNT_SNAPSHOT_JOB_NAME =
	"movie-list-current-count-snapshot";
export const MOVIE_GENRES_PROMOTE_JOB_NAME = "movie-genres-promote";
export const MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME =
	"movie-watch-providers-promote";

export function createImportJobRunId(
	jobName: string,
	trigger: ImportJobTrigger,
) {
	return `${jobName}-${trigger}-${Date.now()}-${crypto.randomUUID()}`;
}

export function createTmdbEnrichmentJobRunId(trigger: ImportJobTrigger) {
	return createImportJobRunId(TMDB_ENRICH_JOB_NAME, trigger);
}

export async function createTmdbEnrichmentImportJobRun(
	env: Env,
	jobRunId: string,
	trigger: ImportJobTrigger,
	selectedCount: number,
	queuedCount: number,
) {
	const status = selectedCount === 0 ? "complete" : "queued";

	await env.DB.prepare(
		`INSERT INTO import_job_runs (
			 job_run_id,
			 job_name,
			 status,
			 trigger,
			 selected_count,
			 queued_count,
			 started_at,
			 last_progress_at,
			 ended_at
		 )
		 VALUES (
			 ?,
			 ?,
			 ?,
			 ?,
			 ?,
			 ?,
			 CURRENT_TIMESTAMP,
			 CURRENT_TIMESTAMP,
			 CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE NULL END
		 )`,
	)
		.bind(
			jobRunId,
			TMDB_ENRICH_JOB_NAME,
			status,
			trigger,
			selectedCount,
			queuedCount,
			selectedCount,
		)
		.run();

	if (selectedCount === 0) {
		await notifyImportJobRunCompletion(env, jobRunId);
	}
}

export async function createImportJobRun(
	env: Env,
	options: {
		jobRunId: string;
		jobName: string;
		trigger: ImportJobTrigger;
		status?: string;
		selectedCount?: number;
		queuedCount?: number;
	},
) {
	const status = options.status ?? "running";

	await env.DB.prepare(
		`INSERT INTO import_job_runs (
			 job_run_id,
			 job_name,
			 status,
			 trigger,
			 selected_count,
			 queued_count,
			 started_at,
			 last_progress_at,
			 ended_at
		 )
		 VALUES (
			 ?,
			 ?,
			 ?,
			 ?,
			 ?,
			 ?,
			 CURRENT_TIMESTAMP,
			 CURRENT_TIMESTAMP,
			 CASE
			   WHEN ? IN ('complete', 'complete_with_errors', 'cancelled', 'failed', 'skipped')
			   THEN CURRENT_TIMESTAMP
			   ELSE NULL
			 END
		 )`,
	)
		.bind(
			options.jobRunId,
			options.jobName,
			status,
			options.trigger,
			options.selectedCount ?? 0,
			options.queuedCount ?? 0,
			status,
		)
		.run();

}

function parseStoredResultJson(resultJson: string | null) {
	if (resultJson === null) {
		return null;
	}

	try {
		return JSON.parse(resultJson) as unknown;
	} catch {
		return resultJson;
	}
}

function parseMonitorRunResultJson(
	run: ImportJobRunRow & { duration_ms?: number | null },
): ImportJobRunMonitorRow {
	return {
		...run,
		result_json: parseStoredResultJson(run.result_json),
	};
}

export async function updateImportJobRunProgress(
	env: Env,
	jobRunId: string,
	stats: {
		selected?: number;
		queued?: number;
		processed?: number;
		updated?: number;
		errors?: number;
		providerRowsInserted?: number;
		result?: unknown;
		lastError?: string | null;
	},
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status = 'running',
		     selected_count = ?,
		     queued_count = ?,
		     processed_count = ?,
		     updated_count = ?,
		     error_count = ?,
		     provider_rows_inserted = ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     result_json = COALESCE(?, result_json),
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?`,
	)
		.bind(
			stats.selected ?? 0,
			stats.queued ?? 0,
			stats.processed ?? 0,
			stats.updated ?? 0,
			stats.errors ?? 0,
			stats.providerRowsInserted ?? 0,
			stats.result === undefined ? null : JSON.stringify(stats.result),
			stats.lastError ?? null,
			jobRunId,
		)
		.run();
}

export async function touchImportJobRunProgress(
	env: Env,
	jobRunId: string,
	progress: {
		result?: unknown;
		lastError?: string | null;
	},
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET last_progress_at = CURRENT_TIMESTAMP,
		     result_json = COALESCE(?, result_json),
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?
		   AND status IN ('running', 'queued')`,
	)
		.bind(
			progress.result === undefined ? null : JSON.stringify(progress.result),
			progress.lastError ?? null,
			jobRunId,
		)
		.run();
}

export async function finishImportJobRun(
	env: Env,
	jobRunId: string,
	result: {
		status: string;
		selected?: number;
		queued?: number;
		processed?: number;
		updated?: number;
		errors?: number;
		providerRowsInserted?: number;
		result?: unknown;
		lastError?: string | null;
	},
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status = ?,
		     selected_count = ?,
		     queued_count = ?,
		     processed_count = ?,
		     updated_count = ?,
		     error_count = ?,
		     provider_rows_inserted = ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at = CURRENT_TIMESTAMP,
		     result_json = COALESCE(?, result_json),
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?`,
	)
		.bind(
			result.status,
			result.selected ?? 0,
			result.queued ?? 0,
			result.processed ?? 0,
			result.updated ?? 0,
			result.errors ?? 0,
			result.providerRowsInserted ?? 0,
			result.result === undefined ? null : JSON.stringify(result.result),
			result.lastError ?? null,
			jobRunId,
		)
		.run();

	await notifyImportJobRunCompletion(env, jobRunId);
}

export async function cancelImportJobRun(
	env: Env,
	jobRunId: string,
	result: {
		processed?: number;
		updated?: number;
		errors?: number;
		providerRowsInserted?: number;
		result?: unknown;
		lastError?: string | null;
	},
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status = 'cancelled',
		     processed_count = processed_count + ?,
		     updated_count = updated_count + ?,
		     error_count = error_count + ?,
		     provider_rows_inserted = provider_rows_inserted + ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at = CURRENT_TIMESTAMP,
		     result_json = COALESCE(?, result_json),
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?
		   AND status IN ('running', 'queued')`,
	)
		.bind(
			result.processed ?? 0,
			result.updated ?? 0,
			result.errors ?? 0,
			result.providerRowsInserted ?? 0,
			result.result === undefined ? null : JSON.stringify(result.result),
			result.lastError ?? null,
			jobRunId,
		)
		.run();

	await notifyImportJobRunCompletion(env, jobRunId);
}

export async function getImportJobRunById(env: Env, jobRunId: string) {
	return env.DB.prepare(
		`SELECT job_run_id,
		        job_name,
		        status,
		        trigger,
		        selected_count,
		        queued_count,
		        processed_count,
		        updated_count,
		        error_count,
		        provider_rows_inserted,
		        started_at,
		        last_progress_at,
		        ended_at,
		        last_error,
		        result_json,
		        notification_sent_at,
		        notification_error
		 FROM import_job_runs
		 WHERE job_run_id = ?`,
	)
		.bind(jobRunId)
		.first<ImportJobRunRow>();
}

export async function setImportJobRunQueueTotals(
	env: Env,
	jobRunId: string,
	totals: {
		selected: number;
		queued: number;
		result?: unknown;
		lastError?: string | null;
	},
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status =
		       CASE
		         WHEN ? > 0 AND processed_count >= ? THEN
		           CASE
		             WHEN error_count > 0 THEN 'complete_with_errors'
		             ELSE 'complete'
		           END
		         ELSE 'running'
		       END,
		     selected_count = ?,
		     queued_count = ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at =
		       CASE
		         WHEN ? > 0 AND processed_count >= ? THEN COALESCE(ended_at, CURRENT_TIMESTAMP)
		         ELSE ended_at
		       END,
		     result_json = COALESCE(?, result_json),
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?`,
	)
		.bind(
			totals.selected,
			totals.selected,
			totals.selected,
			totals.queued,
			totals.selected,
			totals.selected,
			totals.result === undefined ? null : JSON.stringify(totals.result),
			totals.lastError ?? null,
			jobRunId,
		)
		.run();

	await notifyImportJobRunCompletion(env, jobRunId);
}

async function refreshImportJobRunProgressFromQueueMessages(
	env: Env,
	jobRunId: string,
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status =
		       CASE
		         WHEN selected_count > 0
		              AND (
		                SELECT COALESCE(SUM(processed_count), 0)
		                FROM import_job_queue_messages
		                WHERE job_run_id = ?
		              ) >= selected_count THEN
		           CASE
		             WHEN (
		               SELECT COALESCE(SUM(error_count), 0)
		               FROM import_job_queue_messages
		               WHERE job_run_id = ?
		             ) > 0 THEN 'complete_with_errors'
		             ELSE 'complete'
		           END
		         ELSE 'running'
		       END,
		     processed_count = (
		       SELECT COALESCE(SUM(processed_count), 0)
		       FROM import_job_queue_messages
		       WHERE job_run_id = ?
		     ),
		     updated_count = (
		       SELECT COALESCE(SUM(updated_count), 0)
		       FROM import_job_queue_messages
		       WHERE job_run_id = ?
		     ),
		     error_count = (
		       SELECT COALESCE(SUM(error_count), 0)
		       FROM import_job_queue_messages
		       WHERE job_run_id = ?
		     ),
		     provider_rows_inserted = (
		       SELECT COALESCE(SUM(provider_rows_inserted), 0)
		       FROM import_job_queue_messages
		       WHERE job_run_id = ?
		     ),
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at =
		       CASE
		         WHEN selected_count > 0
		              AND (
		                SELECT COALESCE(SUM(processed_count), 0)
		                FROM import_job_queue_messages
		                WHERE job_run_id = ?
		              ) >= selected_count THEN COALESCE(ended_at, CURRENT_TIMESTAMP)
		         ELSE ended_at
		       END,
		     result_json =
		       CASE
		         WHEN (
		           SELECT COALESCE(SUM(tmdb_id_not_found_skipped_count), 0)
		           FROM import_job_queue_messages
		           WHERE job_run_id = ?
		         ) > 0 THEN
		           json_set(
		             COALESCE(result_json, '{}'),
		             '$.tmdbIDNotFoundSkippedCount',
		             (
		               SELECT COALESCE(SUM(tmdb_id_not_found_skipped_count), 0)
		               FROM import_job_queue_messages
		               WHERE job_run_id = ?
		             )
		           )
		         ELSE result_json
		       END,
		     last_error = COALESCE(
		       (
		         SELECT last_error
		         FROM import_job_queue_messages
		         WHERE job_run_id = ?
		           AND last_error IS NOT NULL
		         ORDER BY completed_at DESC
		         LIMIT 1
		       ),
		       last_error
		     )
		 WHERE job_run_id = ?
		   AND status IN ('running', 'queued', 'complete', 'complete_with_errors')`,
	)
		.bind(
			jobRunId,
			jobRunId,
			jobRunId,
			jobRunId,
			jobRunId,
			jobRunId,
			jobRunId,
			jobRunId,
			jobRunId,
			jobRunId,
			jobRunId,
		)
		.run();

	await notifyImportJobRunCompletion(env, jobRunId);
}

export async function recordImportJobQueueMessageCompletion(
	env: Env,
	options: ImportJobQueueMessageCompletion,
) {
	const stats = options.stats;
	const tmdbIDNotFoundSkippedCount = stats.tmdbIDNotFoundSkippedCount ?? 0;
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
			 tmdb_id_not_found_skipped_count,
			 last_error
		 )
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			options.jobRunId,
			options.messageId,
			options.jobName,
			options.queueName,
			stats.processed,
			stats.updated,
			stats.errors,
			stats.providerRowsInserted,
			tmdbIDNotFoundSkippedCount,
			options.lastError,
		);

	const progressStatement = env.DB.prepare(
		`UPDATE import_job_runs
		 SET status =
		       CASE
		         WHEN selected_count > 0 AND processed_count + ? >= selected_count THEN
		           CASE
		             WHEN error_count + ? > 0 THEN 'complete_with_errors'
		             ELSE 'complete'
		           END
		         ELSE 'running'
		       END,
		     processed_count = processed_count + ?,
		     updated_count = updated_count + ?,
		     error_count = error_count + ?,
		     provider_rows_inserted = provider_rows_inserted + ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at =
		       CASE
		         WHEN selected_count > 0 AND processed_count + ? >= selected_count THEN COALESCE(ended_at, CURRENT_TIMESTAMP)
		         ELSE ended_at
		       END,
		     result_json =
		       CASE
		         WHEN ? > 0 THEN
		           json_set(
		             COALESCE(result_json, '{}'),
		             '$.tmdbIDNotFoundSkippedCount',
		             COALESCE(
		               json_extract(
		                 COALESCE(result_json, '{}'),
		                 '$.tmdbIDNotFoundSkippedCount'
		               ),
		               0
		             ) + ?
		           )
		         ELSE result_json
		       END,
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?
		   AND status IN ('running', 'queued', 'complete', 'complete_with_errors')
		   AND changes() > 0`,
	)
		.bind(
			stats.processed,
			stats.errors,
			stats.processed,
			stats.updated,
			stats.errors,
			stats.providerRowsInserted,
			stats.processed,
			tmdbIDNotFoundSkippedCount,
			tmdbIDNotFoundSkippedCount,
			options.lastError,
			options.jobRunId,
		);

	const dataStatements = options.dataStatements ?? [];
	const batchResult = await env.DB.batch([
		...dataStatements,
		insertStatement,
		progressStatement,
	]);
	const insertResult = batchResult[dataStatements.length];

	if (insertResult?.meta.changes === 0) {
		await refreshImportJobRunProgressFromQueueMessages(env, options.jobRunId);
	}

	await notifyImportJobRunCompletion(env, options.jobRunId);
}

export async function getRecentTmdbEnrichmentImportJobRuns(env: Env) {
	const { results } = await env.DB.prepare(
		`SELECT job_run_id,
		        job_name,
		        status,
		        trigger,
		        selected_count,
		        queued_count,
		        processed_count,
		        updated_count,
		        error_count,
		        provider_rows_inserted,
		        started_at,
		        last_progress_at,
		        ended_at,
		        last_error,
		        result_json,
		        notification_sent_at,
		        notification_error
		 FROM import_job_runs
		 WHERE job_name = ?
		 ORDER BY started_at DESC
		 LIMIT 10`,
	)
		.bind(TMDB_ENRICH_JOB_NAME)
		.all<ImportJobRunRow>();

	return results.map(parseMonitorRunResultJson);
}

export async function getRecentImportJobRuns(
	env: Env,
	options: {
		jobName?: string;
		limit?: number;
	} = {},
) {
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
	const selectSql = `SELECT job_run_id,
	        job_name,
	        status,
	        trigger,
	        selected_count,
	        queued_count,
	        processed_count,
	        updated_count,
	        error_count,
	        provider_rows_inserted,
	        started_at,
	        last_progress_at,
	        ended_at,
	        CAST((julianday(ended_at) - julianday(started_at)) * 86400000 AS INTEGER) AS duration_ms,
	        last_error,
	        result_json,
	        notification_sent_at,
	        notification_error
	 FROM import_job_runs`;

	const query = options.jobName
		? `${selectSql} WHERE job_name = ? ORDER BY started_at DESC LIMIT ?`
		: `${selectSql} ORDER BY started_at DESC LIMIT ?`;
	const statement = env.DB.prepare(query);
	const { results } = options.jobName
		? await statement
				.bind(options.jobName, limit)
				.all<ImportJobRunRow & { duration_ms: number | null }>()
		: await statement
				.bind(limit)
				.all<ImportJobRunRow & { duration_ms: number | null }>();

	return results.map(parseMonitorRunResultJson);
}

export async function getActiveTmdbEnrichmentImportJobRun(env: Env) {
	return getActiveImportJobRun(env, TMDB_ENRICH_JOB_NAME);
}

export async function getActiveImportJobRun(env: Env, jobName: string) {
	return env.DB.prepare(
		`SELECT job_run_id,
		        job_name,
		        status,
		        trigger,
		        selected_count,
		        queued_count,
		        processed_count,
		        updated_count,
		        error_count,
		        provider_rows_inserted,
		        started_at,
		        last_progress_at,
		        ended_at,
		        last_error,
		        result_json,
		        notification_sent_at,
		        notification_error
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status IN ('queued', 'running')
		 ORDER BY started_at DESC
		 LIMIT 1`,
	)
		.bind(jobName)
		.first<ImportJobRunRow>();
}
