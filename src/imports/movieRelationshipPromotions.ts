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

export type PendingProviderPromotionCounts = {
	pendingMovieCount: number;
	providerRelationshipAdditionCount: number;
	providerRelationshipRemovalCount: number;
	pendingAvailabilityRelationshipCount: number;
};

export type ProviderAvailabilityCounts = {
	subscriptionRelationshipCount: number;
	subscriptionMovieCount: number;
	adsMovieCount: number;
	totalAvailabilityRelationshipCount: number;
	availabilityMovieCount: number;
};

function normalizeProviderAvailabilityCounts(
	row: ProviderAvailabilityCounts | null,
): ProviderAvailabilityCounts {
	return {
		subscriptionRelationshipCount:
			row?.subscriptionRelationshipCount ?? 0,
		subscriptionMovieCount: row?.subscriptionMovieCount ?? 0,
		adsMovieCount: row?.adsMovieCount ?? 0,
		totalAvailabilityRelationshipCount:
			row?.totalAvailabilityRelationshipCount ?? 0,
		availabilityMovieCount: row?.availabilityMovieCount ?? 0,
	};
}

export async function getProjectedMovieWatchProviderCounts(
	env: Env,
	providerRefreshJobRunId: string,
) {
	const row = await env.DB.prepare(
		`WITH projected AS (
			SELECT live.tmdb_id, live.provider_id
			FROM movie_watch_providers AS live
			WHERE live.region = 'US'
			  AND NOT EXISTS (
				SELECT 1
				FROM movie_watch_provider_changes_staging AS changes
				WHERE changes.load_run_id = ?
				  AND changes.change_type = 'remove'
				  AND changes.tmdb_id = live.tmdb_id
				  AND changes.provider_id = live.provider_id
				  AND changes.region = live.region
			  )
			UNION ALL
			SELECT changes.tmdb_id, changes.provider_id
			FROM movie_watch_provider_changes_staging AS changes
			WHERE changes.load_run_id = ?
			  AND changes.region = 'US'
			  AND changes.change_type = 'add'
		)
		SELECT
			COUNT(CASE WHEN provider_id <> ? THEN 1 END) AS subscriptionRelationshipCount,
			COUNT(DISTINCT CASE WHEN provider_id <> ? THEN tmdb_id END) AS subscriptionMovieCount,
			COUNT(CASE WHEN provider_id = ? THEN 1 END) AS adsMovieCount,
			COUNT(*) AS totalAvailabilityRelationshipCount,
			COUNT(DISTINCT tmdb_id) AS availabilityMovieCount
		FROM projected`,
	)
		.bind(
			providerRefreshJobRunId,
			providerRefreshJobRunId,
			STREAMS_WITH_ADS_PROVIDER_ID,
			STREAMS_WITH_ADS_PROVIDER_ID,
			STREAMS_WITH_ADS_PROVIDER_ID,
		)
		.first<ProviderAvailabilityCounts>();

	return normalizeProviderAvailabilityCounts(row);
}

export async function countUnappliedMovieWatchProviderChanges(
	env: Env,
	providerRefreshJobRunId: string,
) {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS mismatchCount
		 FROM movie_watch_provider_changes_staging AS changes
		 WHERE changes.load_run_id = ?
		   AND changes.region = 'US'
		   AND (
			(changes.change_type = 'add' AND NOT EXISTS (
				SELECT 1
				FROM movie_watch_providers AS live
				WHERE live.tmdb_id = changes.tmdb_id
				  AND live.provider_id = changes.provider_id
				  AND live.region = changes.region
			))
			OR
			(changes.change_type = 'remove' AND EXISTS (
				SELECT 1
				FROM movie_watch_providers AS live
				WHERE live.tmdb_id = changes.tmdb_id
				  AND live.provider_id = changes.provider_id
				  AND live.region = changes.region
			))
		   )`,
	)
		.bind(providerRefreshJobRunId)
		.first<{ mismatchCount: number }>();

	return row?.mismatchCount ?? 0;
}

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
		    COUNT(CASE WHEN change_type = 'add' THEN 1 END) AS providerRelationshipAdditionCount,
		    COUNT(CASE WHEN change_type = 'remove' THEN 1 END) AS providerRelationshipRemovalCount,
		    COUNT(*) AS pendingAvailabilityRelationshipCount
		 FROM movie_watch_provider_changes_staging
		 WHERE applied_at IS NULL
		   AND region = 'US'
		   AND load_run_id = ?`,
	)
		.bind(providerRefreshJobRunId)
		.first<PendingProviderPromotionCounts>();

	return {
		pendingMovieCount: row?.pendingMovieCount ?? 0,
		providerRelationshipAdditionCount:
			row?.providerRelationshipAdditionCount ?? 0,
		providerRelationshipRemovalCount:
			row?.providerRelationshipRemovalCount ?? 0,
		pendingAvailabilityRelationshipCount:
			row?.pendingAvailabilityRelationshipCount ?? 0,
	};
}

/**
 * Completes the change list after every per-movie TMDB lookup succeeded.
 *
 * Per-movie queue messages compare providers for movies in the new flatrate
 * candidate set. This final step also covers movies that disappeared from that
 * candidate set entirely, plus the ad-supported candidate set that TMDB
 * Discover supplies without per-movie requests.
 */
export async function preparePendingMovieWatchProviderChanges(
	env: Env,
	providerRefreshJobRunId: string,
) {
	await env.DB.batch([
		env.DB.prepare(
			`DELETE FROM movie_watch_provider_changes_staging
			 WHERE load_run_id = ?
			   AND provider_id = ?`,
		).bind(providerRefreshJobRunId, STREAMS_WITH_ADS_PROVIDER_ID),
		env.DB.prepare(
			`INSERT OR REPLACE INTO movie_watch_provider_changes_staging (
				load_run_id,
				tmdb_id,
				provider_id,
				region,
				change_type,
				staged_at,
				applied_at
			)
			SELECT
				?,
				live.tmdb_id,
				live.provider_id,
				live.region,
				'remove',
				CURRENT_TIMESTAMP,
				NULL
			FROM movie_watch_providers AS live
			WHERE live.region = 'US'
			  AND live.provider_id <> ?
			  AND NOT EXISTS (
				SELECT 1
				FROM tmdb_us_flatrate_movies_staging AS candidate
				WHERE candidate.load_run_id = ?
				  AND candidate.tmdb_id = live.tmdb_id
			  )`,
		).bind(
			providerRefreshJobRunId,
			STREAMS_WITH_ADS_PROVIDER_ID,
			providerRefreshJobRunId,
		),
		env.DB.prepare(
			`INSERT OR REPLACE INTO movie_watch_provider_changes_staging (
				load_run_id,
				tmdb_id,
				provider_id,
				region,
				change_type,
				staged_at,
				applied_at
			)
			SELECT
				?,
				candidate.tmdb_id,
				?,
				'US',
				'add',
				CURRENT_TIMESTAMP,
				NULL
			FROM tmdb_us_ads_refresh_candidates AS candidate
			WHERE candidate.load_run_id = ?
			  AND NOT EXISTS (
				SELECT 1
				FROM movie_watch_providers AS live
				WHERE live.tmdb_id = candidate.tmdb_id
				  AND live.provider_id = ?
				  AND live.region = 'US'
			  )`,
		).bind(
			providerRefreshJobRunId,
			STREAMS_WITH_ADS_PROVIDER_ID,
			providerRefreshJobRunId,
			STREAMS_WITH_ADS_PROVIDER_ID,
		),
		env.DB.prepare(
			`INSERT OR REPLACE INTO movie_watch_provider_changes_staging (
				load_run_id,
				tmdb_id,
				provider_id,
				region,
				change_type,
				staged_at,
				applied_at
			)
			SELECT
				?,
				live.tmdb_id,
				live.provider_id,
				live.region,
				'remove',
				CURRENT_TIMESTAMP,
				NULL
			FROM movie_watch_providers AS live
			WHERE live.region = 'US'
			  AND live.provider_id = ?
			  AND NOT EXISTS (
				SELECT 1
				FROM tmdb_us_ads_refresh_candidates AS candidate
				WHERE candidate.load_run_id = ?
				  AND candidate.tmdb_id = live.tmdb_id
			  )`,
		).bind(
			providerRefreshJobRunId,
			STREAMS_WITH_ADS_PROVIDER_ID,
			providerRefreshJobRunId,
		),
	]);

	return getPendingProviderPromotionCounts(env, providerRefreshJobRunId);
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
	expectedLiveCounts?: ProviderAvailabilityCounts,
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

		const counts = expectedLiveCounts
			? await getPendingProviderPromotionCounts(env, providerRefreshJobRunId)
			: await preparePendingMovieWatchProviderChanges(
					env,
					providerRefreshJobRunId,
				);
		const projectedCounts =
			expectedLiveCounts ??
			(await getProjectedMovieWatchProviderCounts(
				env,
				providerRefreshJobRunId,
			));

		await env.DB.batch([
			env.DB.prepare(
				`DELETE FROM movie_watch_providers
				 WHERE (tmdb_id, provider_id, region) IN (
					SELECT tmdb_id, provider_id, region
					FROM movie_watch_provider_changes_staging
					WHERE load_run_id = ?
					  AND change_type = 'remove'
				 )`,
			).bind(providerRefreshJobRunId),
			env.DB.prepare(
				`INSERT OR IGNORE INTO movie_watch_providers (
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
					FROM movie_watch_provider_changes_staging
					WHERE applied_at IS NULL
					  AND region = 'US'
					  AND change_type = 'add'
					  AND load_run_id = ?`,
			).bind(jobRunId, providerRefreshJobRunId),
			env.DB.prepare(
				`UPDATE movie_watch_provider_changes_staging
				 SET applied_at = CURRENT_TIMESTAMP
				 WHERE applied_at IS NULL
				   AND region = 'US'
				   AND load_run_id = ?`,
			).bind(providerRefreshJobRunId),
			env.DB.prepare(
				`DELETE FROM movie_watch_provider_changes_staging
				 WHERE load_run_id <> ?`,
			).bind(providerRefreshJobRunId),
		]);

		const result = {
			jobRunId,
			providerRefreshJobRunId,
			...counts,
			projectedCounts,
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
