import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	MOVIE_GENRES_PROMOTE_JOB_NAME,
	MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import type { Env } from "../shared/types";
import { logEvent } from "../shared/logging";

type PendingGenrePromotionCounts = {
	pendingMovieCount: number;
	pendingGenreCount: number;
};

type PendingProviderPromotionCounts = {
	pendingMovieCount: number;
	pendingProviderCount: number;
	fullRefreshPendingMovieCount: number;
	fullRefreshPendingProviderCount: number;
};

type LatestProviderRefreshRun = {
	job_run_id: string;
	status: string;
	error_count: number;
};

async function getPendingGenrePromotionCounts(
	env: Env,
): Promise<PendingGenrePromotionCounts> {
	const row = await env.DB.prepare(
		`SELECT
		    COUNT(DISTINCT tmdb_id) AS pendingMovieCount,
		    COUNT(*) AS pendingGenreCount
		 FROM movie_genres_staging
		 WHERE promoted_at IS NULL`,
	).first<PendingGenrePromotionCounts>();

	return {
		pendingMovieCount: row?.pendingMovieCount ?? 0,
		pendingGenreCount: row?.pendingGenreCount ?? 0,
	};
}

async function getPendingProviderPromotionCounts(
	env: Env,
): Promise<PendingProviderPromotionCounts> {
	const row = await env.DB.prepare(
		`SELECT
		    COUNT(DISTINCT tmdb_id) AS pendingMovieCount,
		    COUNT(provider_id) AS pendingProviderCount,
		    COUNT(DISTINCT CASE WHEN is_full_refresh = 1 THEN tmdb_id END) AS fullRefreshPendingMovieCount,
		    COUNT(CASE WHEN is_full_refresh = 1 THEN provider_id END) AS fullRefreshPendingProviderCount
		 FROM movie_watch_providers_staging
		 WHERE promoted_at IS NULL
		   AND region = 'US'`,
	).first<PendingProviderPromotionCounts>();

	return {
		pendingMovieCount: row?.pendingMovieCount ?? 0,
		pendingProviderCount: row?.pendingProviderCount ?? 0,
		fullRefreshPendingMovieCount: row?.fullRefreshPendingMovieCount ?? 0,
		fullRefreshPendingProviderCount: row?.fullRefreshPendingProviderCount ?? 0,
	};
}

async function getLatestProviderRefreshRun(
	env: Env,
): Promise<LatestProviderRefreshRun | null> {
	const row = await env.DB.prepare(
		`SELECT job_run_id,
		        status,
		        error_count
		 FROM import_job_runs
		 WHERE job_name = ?
		 ORDER BY started_at DESC
		 LIMIT 1`,
	)
		.bind(TMDB_PROVIDER_REFRESH_JOB_NAME)
		.first<LatestProviderRefreshRun>();

	return row ?? null;
}

export async function promotePendingMovieGenres(
	env: Env,
	trigger: ImportJobTrigger,
) {
	const startedAtMs = Date.now();
	const jobRunId = createImportJobRunId(MOVIE_GENRES_PROMOTE_JOB_NAME, trigger);

	await createImportJobRun(env, {
		jobRunId,
		jobName: MOVIE_GENRES_PROMOTE_JOB_NAME,
		trigger,
	});

	try {
		const counts = await getPendingGenrePromotionCounts(env);

		if (counts.pendingMovieCount > 0) {
			await env.DB.batch([
				env.DB.prepare(
					`DELETE FROM movie_genres
					 WHERE tmdb_id IN (
					    SELECT DISTINCT tmdb_id
					    FROM movie_genres_staging
					    WHERE promoted_at IS NULL
					 )`,
				),
				env.DB.prepare(
					`INSERT OR REPLACE INTO movie_genres (
						tmdb_id,
						genre_id,
						promotion_run_id,
						promoted_at
					)
					SELECT
						tmdb_id,
						genre_id,
						?,
						CURRENT_TIMESTAMP
					FROM movie_genres_staging
					WHERE promoted_at IS NULL`,
				).bind(jobRunId),
				env.DB.prepare(
					`UPDATE movie_genres_staging
					 SET promoted_at = CURRENT_TIMESTAMP
					 WHERE promoted_at IS NULL`,
				),
			]);
		}

		const result = {
			jobRunId,
			...counts,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected: counts.pendingMovieCount,
			processed: counts.pendingMovieCount,
			updated: counts.pendingGenreCount,
			result,
		});

		return result;
	} catch (error) {
		const lastError =
			error instanceof Error ? error.message : "Movie genre promotion failed.";

		const result = {
			jobRunId,
			status: "cancelled",
			reason: "movie_genres_promotion_error",
			error: lastError,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			errors: 1,
			result,
			lastError,
		});

		logEvent("movie-genres-promote-cancelled", result);

		throw error;
	}
}

export async function promotePendingMovieWatchProviders(
	env: Env,
	trigger: ImportJobTrigger,
) {
	const startedAtMs = Date.now();
	const jobRunId = createImportJobRunId(
		MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
		trigger,
	);

	await createImportJobRun(env, {
		jobRunId,
		jobName: MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
		trigger,
	});

	try {
		const counts = await getPendingProviderPromotionCounts(env);

		if (counts.fullRefreshPendingMovieCount > 0) {
			const latestProviderRefreshRun = await getLatestProviderRefreshRun(env);

			if (latestProviderRefreshRun?.status !== "complete") {
				throw new Error(
					`Cannot promote full-refresh watch-provider staging because latest ${TMDB_PROVIDER_REFRESH_JOB_NAME} run is ${latestProviderRefreshRun?.status ?? "missing"} with ${latestProviderRefreshRun?.error_count ?? 0} errors.`,
				);
			}

			await env.DB.batch([
				env.DB.prepare(
					`DELETE FROM movie_watch_providers
					 WHERE region = 'US'`,
				),
				env.DB.prepare(
					`INSERT OR REPLACE INTO movie_watch_providers (
						tmdb_id,
						provider_id,
						region,
						promotion_run_id,
						promoted_at
					)
					SELECT
						tmdb_id,
						provider_id,
						region,
						?,
						CURRENT_TIMESTAMP
						FROM movie_watch_providers_staging
						WHERE promoted_at IS NULL
						  AND region = 'US'
						  AND is_full_refresh = 1
						  AND load_run_id = ?
						  AND provider_id IS NOT NULL`,
					).bind(jobRunId, latestProviderRefreshRun.job_run_id),
					env.DB.prepare(
						`UPDATE movie_watch_providers_staging
						 SET promoted_at = CURRENT_TIMESTAMP
						 WHERE promoted_at IS NULL
						   AND region = 'US'
						   AND is_full_refresh = 1
						   AND load_run_id = ?`,
					).bind(latestProviderRefreshRun.job_run_id),
					env.DB.prepare(
						`DELETE FROM movie_watch_providers_staging
						 WHERE region = 'US'
						   AND is_full_refresh = 1
						   AND load_run_id <> ?`,
					).bind(latestProviderRefreshRun.job_run_id),
				]);
		} else if (counts.pendingMovieCount > 0) {
			await env.DB.batch([
				env.DB.prepare(
					`DELETE FROM movie_watch_providers
					 WHERE region = 'US'
					   AND tmdb_id IN (
					     SELECT DISTINCT tmdb_id
					     FROM movie_watch_providers_staging
					     WHERE promoted_at IS NULL
					       AND region = 'US'
					   )`,
				),
				env.DB.prepare(
					`INSERT OR REPLACE INTO movie_watch_providers (
						tmdb_id,
						provider_id,
						region,
						promotion_run_id,
						promoted_at
					)
					SELECT
						tmdb_id,
						provider_id,
						region,
						?,
						CURRENT_TIMESTAMP
					FROM movie_watch_providers_staging
					WHERE promoted_at IS NULL
					  AND region = 'US'
					  AND provider_id IS NOT NULL`,
				).bind(jobRunId),
				env.DB.prepare(
					`UPDATE movie_watch_providers_staging
					 SET promoted_at = CURRENT_TIMESTAMP
					 WHERE promoted_at IS NULL
					   AND region = 'US'`,
				),
			]);
		}

		const result = {
			jobRunId,
			...counts,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected: counts.pendingMovieCount,
			processed: counts.pendingMovieCount,
			updated: counts.pendingProviderCount,
			result,
		});

		return result;
	} catch (error) {
		const lastError =
			error instanceof Error
				? error.message
				: "Movie watch-provider promotion failed.";

		const result = {
			jobRunId,
			status: "cancelled",
			reason: "movie_watch_providers_promotion_error",
			error: lastError,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			errors: 1,
			result,
			lastError,
		});

		logEvent("movie-watch-providers-promote-cancelled", result);

		throw error;
	}
}
