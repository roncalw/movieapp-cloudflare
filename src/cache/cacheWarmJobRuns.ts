import {
	createImportJobRun,
	createImportJobRunId,
	getImportJobRunById,
	getRecentImportJobRuns,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
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
		genreKey: string;
		entryName: string;
		stats: CacheWarmSearchStats;
	},
) {
	const stats = options.stats;
	const updateResult = await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status =
		       CASE
		         WHEN selected_count > 0 AND MIN(selected_count, processed_count + 1) >= selected_count THEN
		           CASE
		             WHEN error_count + ? > 0 THEN 'complete_with_errors'
		             ELSE 'complete'
		           END
		         ELSE 'running'
		       END,
		     processed_count =
		       CASE
		         WHEN selected_count > 0 THEN MIN(selected_count, processed_count + 1)
		         ELSE processed_count + 1
		       END,
		     updated_count = updated_count + ?,
		     error_count = error_count + ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at =
		       CASE
		         WHEN selected_count > 0 AND MIN(selected_count, processed_count + 1) >= selected_count THEN CURRENT_TIMESTAMP
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
		   AND status IN ('queued', 'running')`,
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
		)
		.run();

	if (updateResult.meta.changes === 0) {
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
	}
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
