import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	MOVIE_GENRES_PROMOTE_JOB_NAME,
	MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import type { Env } from "../shared/types";

type PendingGenrePromotionCounts = {
	pendingMovieCount: number;
	pendingGenreCount: number;
};

type PendingProviderPromotionCounts = {
	pendingMovieCount: number;
	pendingProviderCount: number;
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
		    COUNT(provider_id) AS pendingProviderCount
		 FROM movie_watch_providers_staging
		 WHERE promoted_at IS NULL
		   AND region = 'US'`,
	).first<PendingProviderPromotionCounts>();

	return {
		pendingMovieCount: row?.pendingMovieCount ?? 0,
		pendingProviderCount: row?.pendingProviderCount ?? 0,
	};
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

		await finishImportJobRun(env, jobRunId, {
			status: "failed",
			result: {
				jobRunId,
				durationMs: Date.now() - startedAtMs,
			},
			lastError,
		});

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

		if (counts.pendingMovieCount > 0) {
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

		await finishImportJobRun(env, jobRunId, {
			status: "failed",
			result: {
				jobRunId,
				durationMs: Date.now() - startedAtMs,
			},
			lastError,
		});

		throw error;
	}
}
