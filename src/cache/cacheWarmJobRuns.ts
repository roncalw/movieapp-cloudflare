import {
	createImportJobRun,
	createImportJobRunId,
	getImportJobRunById,
	getRecentImportJobRuns,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import { notifyImportJobRunCompletion } from "../notifications/jobNotifications";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";
import {
	CACHE_WARM_SEARCH_JOB_NAME,
	type CacheWarmSearchStats,
} from "./cacheWarmTypes";

export function createCacheWarmSearchJobRunId(trigger: ImportJobTrigger) {
	return createImportJobRunId(CACHE_WARM_SEARCH_JOB_NAME, trigger);
}

export async function createCacheWarmSearchJobRun(
	env: Env,
	options: {
		jobRunId: string;
		trigger: ImportJobTrigger;
		selectedGenreKey: string | null;
		selectedGenreCount: number;
		selectedEntryCount: number;
		pageLimit: number;
		selectedGenres: string[];
	},
) {
	await createImportJobRun(env, {
		jobRunId: options.jobRunId,
		jobName: CACHE_WARM_SEARCH_JOB_NAME,
		trigger: options.trigger,
		status: options.selectedEntryCount === 0 ? "complete" : "queued",
		selectedCount: options.selectedEntryCount,
		queuedCount: options.selectedEntryCount,
	});

	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET result_json = ?
		 WHERE job_run_id = ?`,
	)
		.bind(
			JSON.stringify({
				jobRunId: options.jobRunId,
				trigger: options.trigger,
				selectedGenreKey: options.selectedGenreKey,
				selectedGenreCount: options.selectedGenreCount,
				selectedEntryCount: options.selectedEntryCount,
				pageLimit: options.pageLimit,
				selectedGenres: options.selectedGenres,
				pageCount: 0,
				firstRequestCount: 0,
				retryRequestCount: 0,
				hitCount: 0,
				missCount: 0,
				retryHitCount: 0,
				errorCount: 0,
			}),
			options.jobRunId,
		)
		.run();

	if (options.selectedEntryCount === 0) {
		await notifyImportJobRunCompletion(env, options.jobRunId);
	}
}

function parseCacheWarmSearchResultJson(resultJson: string | null) {
	if (!resultJson) {
		return {
			selectedGenreKey: null,
			selectedGenreCount: null,
		};
	}

	try {
		const result = JSON.parse(resultJson) as {
			selectedGenreKey?: unknown;
			selectedGenreCount?: unknown;
		};

		return {
			selectedGenreKey:
				typeof result.selectedGenreKey === "string"
					? result.selectedGenreKey
					: null,
			selectedGenreCount:
				typeof result.selectedGenreCount === "number" &&
				Number.isFinite(result.selectedGenreCount)
					? result.selectedGenreCount
					: null,
		};
	} catch {
		return {
			selectedGenreKey: null,
			selectedGenreCount: null,
		};
	}
}

export async function recordCacheWarmSearchProgress(
	env: Env,
	options: {
		jobRunId: string;
		messageId: string;
		genreKey: string;
		entryName: string;
		stats: CacheWarmSearchStats;
	},
) {
	const stats = options.stats;
	const insertStatement = env.DB.prepare(
		`INSERT OR IGNORE INTO import_job_queue_messages (
			 job_run_id,
			 message_id,
			 job_name,
			 queue_name,
			 processed_count,
			 updated_count,
			 error_count,
			 cache_page_count,
			 cache_first_request_count,
			 cache_retry_request_count,
			 cache_hit_count,
			 cache_miss_count,
			 cache_retry_hit_count,
			 cache_error_count,
			 genre_key,
			 entry_name,
			 last_error
		 )
		 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			options.jobRunId,
			options.messageId,
			CACHE_WARM_SEARCH_JOB_NAME,
			"movieapp-cache-warm-queue",
			stats.pageCount,
			stats.errorCount,
			stats.pageCount,
			stats.firstRequestCount,
			stats.retryRequestCount,
			stats.hitCount,
			stats.missCount,
			stats.retryHitCount,
			stats.errorCount,
			options.genreKey,
			options.entryName,
			stats.lastError,
		)
		;

	const updateStatement = env.DB.prepare(
		`UPDATE import_job_runs
		 SET status =
		       CASE
		         WHEN selected_count > 0 AND processed_count + 1 >= selected_count THEN
		           CASE
		             WHEN error_count + ? > 0 THEN 'complete_with_errors'
		             ELSE 'complete'
		           END
		         ELSE 'running'
		       END,
		     processed_count = processed_count + 1,
		     updated_count = updated_count + ?,
		     error_count = error_count + ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at =
		       CASE
		         WHEN selected_count > 0 AND processed_count + 1 >= selected_count THEN COALESCE(ended_at, CURRENT_TIMESTAMP)
		         ELSE ended_at
		       END,
		     result_json = json_set(
		       COALESCE(result_json, '{}'),
		       '$.pageCount',
		       COALESCE(json_extract(COALESCE(result_json, '{}'), '$.pageCount'), 0) + ?,
		       '$.firstRequestCount',
		       COALESCE(json_extract(COALESCE(result_json, '{}'), '$.firstRequestCount'), 0) + ?,
		       '$.retryRequestCount',
		       COALESCE(json_extract(COALESCE(result_json, '{}'), '$.retryRequestCount'), 0) + ?,
		       '$.hitCount',
		       COALESCE(json_extract(COALESCE(result_json, '{}'), '$.hitCount'), 0) + ?,
		       '$.missCount',
		       COALESCE(json_extract(COALESCE(result_json, '{}'), '$.missCount'), 0) + ?,
		       '$.retryHitCount',
		       COALESCE(json_extract(COALESCE(result_json, '{}'), '$.retryHitCount'), 0) + ?,
		       '$.errorCount',
		       COALESCE(json_extract(COALESCE(result_json, '{}'), '$.errorCount'), 0) + ?,
		       '$.lastGenreKey',
		       ?,
		       '$.lastEntryName',
		       ?,
		       '$.lastError',
		       ?
		     ),
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?
		   AND status IN ('queued', 'running', 'complete', 'complete_with_errors')
		   AND changes() > 0`,
	)
		.bind(
			stats.errorCount,
			stats.pageCount,
			stats.errorCount,
			stats.pageCount,
			stats.firstRequestCount,
			stats.retryRequestCount,
			stats.hitCount,
			stats.missCount,
			stats.retryHitCount,
			stats.errorCount,
			options.genreKey,
			options.entryName,
			stats.lastError,
			stats.lastError,
			options.jobRunId,
		);

	const batchResult = await env.DB.batch([insertStatement, updateStatement]);
	const insertResult = batchResult[0];
	const updateResult = batchResult[1];

	if (insertResult?.meta.changes === 0) {
		await refreshCacheWarmSearchProgressFromQueueMessages(env, options.jobRunId);
		await notifyImportJobRunCompletion(env, options.jobRunId);
		return;
	}

	if (updateResult?.meta.changes === 0) {
		return;
	}

	const run = await getImportJobRunById(env, options.jobRunId);

	if (
		run &&
		(run.status === "complete" || run.status === "complete_with_errors")
	) {
		const resultJson = parseCacheWarmSearchResultJson(run.result_json);

		logEvent("cache-warm-search-complete", {
			jobName: CACHE_WARM_SEARCH_JOB_NAME,
			jobRunId: options.jobRunId,
			status: run.status,
			selectedGenreKey: resultJson.selectedGenreKey,
			selectedGenreCount: resultJson.selectedGenreCount,
			selectedCount: run.selected_count,
			processedCount: run.processed_count,
			pageCount: run.updated_count,
			errorCount: run.error_count,
			startedAt: run.started_at,
			endedAt: run.ended_at,
		});

		await notifyImportJobRunCompletion(env, options.jobRunId);
	}
}

async function refreshCacheWarmSearchProgressFromQueueMessages(
	env: Env,
	jobRunId: string,
) {
	const totals = await env.DB.prepare(
		`SELECT COALESCE(SUM(processed_count), 0) AS processed_count,
		        COALESCE(SUM(updated_count), 0) AS updated_count,
		        COALESCE(SUM(error_count), 0) AS error_count,
		        COALESCE(SUM(cache_page_count), 0) AS cache_page_count,
		        COALESCE(SUM(cache_first_request_count), 0) AS cache_first_request_count,
		        COALESCE(SUM(cache_retry_request_count), 0) AS cache_retry_request_count,
		        COALESCE(SUM(cache_hit_count), 0) AS cache_hit_count,
		        COALESCE(SUM(cache_miss_count), 0) AS cache_miss_count,
		        COALESCE(SUM(cache_retry_hit_count), 0) AS cache_retry_hit_count,
		        COALESCE(SUM(cache_error_count), 0) AS cache_error_count
		 FROM import_job_queue_messages
		 WHERE job_run_id = ?`,
	)
		.bind(jobRunId)
		.first<{
			processed_count: number;
			updated_count: number;
			error_count: number;
			cache_page_count: number;
			cache_first_request_count: number;
			cache_retry_request_count: number;
			cache_hit_count: number;
			cache_miss_count: number;
			cache_retry_hit_count: number;
			cache_error_count: number;
		}>();

	if (!totals) {
		return;
	}

	const latest = await env.DB.prepare(
		`SELECT genre_key,
		        entry_name,
		        last_error
		 FROM import_job_queue_messages
		 WHERE job_run_id = ?
		 ORDER BY completed_at DESC
		 LIMIT 1`,
	)
		.bind(jobRunId)
		.first<{
			genre_key: string | null;
			entry_name: string | null;
			last_error: string | null;
		}>();

	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status =
		       CASE
		         WHEN selected_count > 0 AND ? >= selected_count THEN
		           CASE
		             WHEN ? > 0 THEN 'complete_with_errors'
		             ELSE 'complete'
		           END
		         ELSE 'running'
		       END,
		     processed_count = ?,
		     updated_count = ?,
		     error_count = ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at =
		       CASE
		         WHEN selected_count > 0 AND ? >= selected_count THEN COALESCE(ended_at, CURRENT_TIMESTAMP)
		         ELSE ended_at
		       END,
		     result_json = json_set(
		       COALESCE(result_json, '{}'),
		       '$.pageCount',
		       ?,
		       '$.firstRequestCount',
		       ?,
		       '$.retryRequestCount',
		       ?,
		       '$.hitCount',
		       ?,
		       '$.missCount',
		       ?,
		       '$.retryHitCount',
		       ?,
		       '$.errorCount',
		       ?,
		       '$.lastGenreKey',
		       ?,
		       '$.lastEntryName',
		       ?,
		       '$.lastError',
		       ?
		     ),
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?
		   AND status IN ('queued', 'running', 'complete', 'complete_with_errors')`,
	)
		.bind(
			totals.processed_count,
			totals.error_count,
			totals.processed_count,
			totals.updated_count,
			totals.error_count,
			totals.processed_count,
			totals.cache_page_count,
			totals.cache_first_request_count,
			totals.cache_retry_request_count,
			totals.cache_hit_count,
			totals.cache_miss_count,
			totals.cache_retry_hit_count,
			totals.cache_error_count,
			latest?.genre_key ?? null,
			latest?.entry_name ?? null,
			latest?.last_error ?? null,
			latest?.last_error ?? null,
			jobRunId,
		)
		.run();

	await notifyImportJobRunCompletion(env, jobRunId);
}

export async function getRecentCacheWarmSearchJobRuns(
	env: Env,
	options: {
		limit?: number;
	} = {},
) {
	return getRecentImportJobRuns(env, {
		jobName: CACHE_WARM_SEARCH_JOB_NAME,
		limit: options.limit,
	});
}
