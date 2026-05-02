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
};

export type ImportJobProgressStats = {
	processed: number;
	updated: number;
	errors: number;
	providerRowsInserted: number;
};

export const TMDB_ENRICH_JOB_NAME = "tmdb-enrich";

export function createTmdbEnrichmentJobRunId(trigger: "manual" | "cron") {
	return `${TMDB_ENRICH_JOB_NAME}-${trigger}-${Date.now()}-${crypto.randomUUID()}`;
}

export async function createTmdbEnrichmentImportJobRun(
	env: Env,
	jobRunId: string,
	trigger: "manual" | "cron",
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
		        last_error
		 FROM import_job_runs
		 WHERE job_name = ?
		 ORDER BY started_at DESC
		 LIMIT 10`,
	)
		.bind(TMDB_ENRICH_JOB_NAME)
		.all<ImportJobRunRow>();

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
		        last_error
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status IN ('queued', 'running')
		 ORDER BY started_at DESC
		 LIMIT 1`,
	)
		.bind(TMDB_ENRICH_JOB_NAME)
		.first<ImportJobRunRow>();
}
