import type { Env } from "../shared/types";

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
};

export type ImportJobProgressStats = {
	processed: number;
	updated: number;
	errors: number;
	providerRowsInserted: number;
};

export type ImportJobTrigger = "manual" | "cron";

export const TMDB_ENRICH_JOB_NAME = "tmdb-enrich";
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
	await env.DB.prepare(
		`INSERT INTO import_job_runs (
			 job_run_id,
			 job_name,
			 status,
			 trigger,
			 selected_count,
			 queued_count,
			 started_at,
			 last_progress_at
		 )
		 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
	)
		.bind(
			options.jobRunId,
			options.jobName,
			options.status ?? "running",
			options.trigger,
			options.selectedCount ?? 0,
			options.queuedCount ?? 0,
		)
		.run();
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
		         WHEN ? > 0 AND processed_count >= ? THEN CURRENT_TIMESTAMP
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
}

export async function incrementImportJobRunQueueProgress(
	env: Env,
	jobRunId: string,
	stats: ImportJobProgressStats,
	lastError: string | null,
) {
	await env.DB.prepare(
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
		         WHEN selected_count > 0 AND processed_count + ? >= selected_count THEN CURRENT_TIMESTAMP
		         ELSE ended_at
		       END,
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?`,
	)
		.bind(
			stats.processed,
			stats.errors,
			stats.processed,
			stats.updated,
			stats.errors,
			stats.providerRowsInserted,
			stats.processed,
			lastError,
			jobRunId,
		)
		.run();
}

export async function updateTmdbEnrichmentImportJobRunProgress(
	env: Env,
	jobRunId: string,
	stats: ImportJobProgressStats,
	lastError: string | null,
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status =
		       CASE
		         WHEN processed_count + ? >= selected_count THEN
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
		         WHEN processed_count + ? >= selected_count THEN CURRENT_TIMESTAMP
		         ELSE ended_at
		       END,
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?`,
	)
		.bind(
			stats.processed,
			stats.errors,
			stats.processed,
			stats.updated,
			stats.errors,
			stats.providerRowsInserted,
			stats.processed,
			lastError,
			jobRunId,
		)
		.run();
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
		        result_json
		 FROM import_job_runs
		 WHERE job_name = ?
		 ORDER BY started_at DESC
		 LIMIT 10`,
	)
		.bind(TMDB_ENRICH_JOB_NAME)
		.all<ImportJobRunRow>();

	return results;
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
	        result_json
	 FROM import_job_runs`;

	const query = options.jobName
		? `${selectSql} WHERE job_name = ? ORDER BY started_at DESC LIMIT ?`
		: `${selectSql} ORDER BY started_at DESC LIMIT ?`;
	const statement = env.DB.prepare(query);
	const { results } = options.jobName
		? await statement.bind(options.jobName, limit).all()
		: await statement.bind(limit).all();

	return results;
}

export async function getActiveTmdbEnrichmentImportJobRun(env: Env) {
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
		        result_json
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status IN ('queued', 'running')
		 ORDER BY started_at DESC
		 LIMIT 1`,
	)
		.bind(TMDB_ENRICH_JOB_NAME)
		.first<ImportJobRunRow>();
}
