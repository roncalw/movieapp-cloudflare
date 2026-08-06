import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getImportJobRunById,
	MOVIE_GENRES_PROMOTE_JOB_NAME,
	MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import type { Env } from "../shared/types";
import { logEvent } from "../shared/logging";
import { STREAMS_WITH_ADS_PROVIDER_ID } from "../shared/watchProviderAvailability";

type PendingGenrePromotionCounts = {
	pendingMovieCount: number;
	pendingGenreCount: number;
};

type PendingProviderPromotionCounts = {
	pendingMovieCount: number;
	pendingProviderCount: number;
	pendingAvailabilityRelationshipCount: number;
	adsSupportedMovieCount: number;
	fullRefreshPendingMovieCount: number;
	fullRefreshPendingProviderCount: number;
	fullRefreshPendingAvailabilityRelationshipCount: number;
	fullRefreshAdsSupportedMovieCount: number;
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
	providerRefreshJobRunId: string,
): Promise<PendingProviderPromotionCounts> {
	const row = await env.DB.prepare(
		`SELECT
		    COUNT(DISTINCT tmdb_id) AS pendingMovieCount,
		    COUNT(CASE WHEN provider_id <> ${STREAMS_WITH_ADS_PROVIDER_ID} THEN provider_id END) AS pendingProviderCount,
		    COUNT(provider_id) AS pendingAvailabilityRelationshipCount,
		    COUNT(CASE WHEN provider_id = ${STREAMS_WITH_ADS_PROVIDER_ID} THEN 1 END) AS adsSupportedMovieCount,
		    COUNT(DISTINCT CASE WHEN is_full_refresh = 1 THEN tmdb_id END) AS fullRefreshPendingMovieCount,
		    COUNT(CASE WHEN is_full_refresh = 1 AND provider_id <> ${STREAMS_WITH_ADS_PROVIDER_ID} THEN provider_id END) AS fullRefreshPendingProviderCount,
		    COUNT(CASE WHEN is_full_refresh = 1 THEN provider_id END) AS fullRefreshPendingAvailabilityRelationshipCount,
		    COUNT(CASE WHEN is_full_refresh = 1 AND provider_id = ${STREAMS_WITH_ADS_PROVIDER_ID} THEN 1 END) AS fullRefreshAdsSupportedMovieCount
		 FROM movie_watch_providers_staging
		 WHERE promoted_at IS NULL
		   AND region = 'US'
		   AND load_run_id = ?`,
	)
		.bind(providerRefreshJobRunId)
		.first<PendingProviderPromotionCounts>();

	return {
		pendingMovieCount: row?.pendingMovieCount ?? 0,
		pendingProviderCount: row?.pendingProviderCount ?? 0,
		pendingAvailabilityRelationshipCount:
			row?.pendingAvailabilityRelationshipCount ?? 0,
		adsSupportedMovieCount: row?.adsSupportedMovieCount ?? 0,
		fullRefreshPendingMovieCount: row?.fullRefreshPendingMovieCount ?? 0,
		fullRefreshPendingProviderCount: row?.fullRefreshPendingProviderCount ?? 0,
		fullRefreshPendingAvailabilityRelationshipCount:
			row?.fullRefreshPendingAvailabilityRelationshipCount ?? 0,
		fullRefreshAdsSupportedMovieCount:
			row?.fullRefreshAdsSupportedMovieCount ?? 0,
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
	providerRefreshJobRunId: string,
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
		const providerRefreshRun = await getImportJobRunById(
			env,
			providerRefreshJobRunId,
		);

		if (
			!providerRefreshRun ||
			providerRefreshRun.job_name !== TMDB_PROVIDER_REFRESH_JOB_NAME ||
			providerRefreshRun.status !== "complete" ||
			providerRefreshRun.error_count !== 0 ||
			providerRefreshRun.ended_at === null ||
			providerRefreshRun.processed_count !== providerRefreshRun.selected_count
		) {
			throw new Error(
				`Cannot apply watch providers because ${providerRefreshJobRunId} is not a complete, error-free ${TMDB_PROVIDER_REFRESH_JOB_NAME} run with all selected movies processed.`,
			);
		}

		const counts = await getPendingProviderPromotionCounts(
			env,
			providerRefreshJobRunId,
		);

		if (counts.fullRefreshPendingMovieCount > 0) {
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
					).bind(jobRunId, providerRefreshJobRunId),
					env.DB.prepare(
						`UPDATE movie_watch_providers_staging
						 SET promoted_at = CURRENT_TIMESTAMP
						 WHERE promoted_at IS NULL
						   AND region = 'US'
						   AND is_full_refresh = 1
						   AND load_run_id = ?`,
					).bind(providerRefreshJobRunId),
					env.DB.prepare(
						`DELETE FROM movie_watch_providers_staging
						 WHERE region = 'US'
						   AND is_full_refresh = 1
						   AND load_run_id <> ?`,
					).bind(providerRefreshJobRunId),
				]);
		} else {
			throw new Error(
				`Cannot apply watch providers because ${providerRefreshJobRunId} has no pending full-refresh provider rows.`,
			);
		}

		const result = {
			jobRunId,
			providerRefreshJobRunId,
			...counts,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected: counts.pendingMovieCount,
			processed: counts.pendingMovieCount,
			updated: counts.pendingAvailabilityRelationshipCount,
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
