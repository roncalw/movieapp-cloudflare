import {
	acquireImportJobLock,
	createJobOwner,
	releaseImportJobLock,
} from "../jobs/importJobLocks";
import {
	checkMovieListPotentialLoadCounts,
	recordMovieListCurrentCountSnapshot,
} from "./movieListLoadCounts";
import {
	promotePendingMovieGenres,
	promotePendingMovieWatchProviders,
} from "./movieRelationshipPromotions";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getActiveTmdbEnrichmentImportJobRun,
	IMDB_RATINGS_JOB_NAME,
	MOVIE_LIST_BUILD_JOB_NAME,
	TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	TMDB_PRIMARY_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	updateImportJobRunProgress,
} from "../jobs/importJobRuns";
import {
	checkImportJobDependencies,
	getLatestCleanImportJobRunWithResultJsonNumberGreaterThan,
	type ImportJobDependencyRequirement,
} from "../jobs/importJobDependencies";
import type { Env } from "../shared/types";
import { logEvent } from "../shared/logging";

type MovieListBuildReadiness = {
	tmdbRows: number;
	imdbRows: number;
	tmdbRowsMissingEnrichment: number;
	tmdbTerminalErrorRows: number;
	movieListCandidateRows: number;
};

type MovieListBuildChunk = {
	chunkRows: number;
	lastTmdbId: number | null;
};

const MOVIE_LIST_BUILD_LOCK_MINUTES = 60;
const MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS = 10000;
const MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS = 100000;

async function getMovieListBuildReadiness(
	env: Env,
	changedAfter: string | null,
): Promise<MovieListBuildReadiness> {
	const row = await env.DB.prepare(
		`SELECT
		    (SELECT COUNT(*) FROM tmdb_movies_staging) AS tmdbRows,
		    (SELECT COUNT(*) FROM imdb_ratings_staging) AS imdbRows,
		    (
		      SELECT COUNT(*)
		      FROM tmdb_movies_staging
		      WHERE tmdb_enriched_at IS NULL
		        AND tmdb_enrichment_error IS NULL
		    ) AS tmdbRowsMissingEnrichment,
		    (
		      SELECT COUNT(*)
		      FROM tmdb_movies_staging
		      WHERE tmdb_enrichment_error IS NOT NULL
		    ) AS tmdbTerminalErrorRows,
		    (
		      SELECT COUNT(*)
		      FROM tmdb_movies_staging AS tmdb
		      LEFT JOIN imdb_ratings_staging AS imdb
		        ON imdb.imdb_id = tmdb.imdb_id
		      WHERE tmdb.tmdb_enriched_at IS NOT NULL
		        AND tmdb.tmdb_enrichment_error IS NULL
		        AND tmdb.poster_path IS NOT NULL
		        AND tmdb.poster_path <> ''
		        AND (
		          ? IS NULL
		          OR tmdb.imported_at > ?
		          OR tmdb.tmdb_enriched_at > ?
		        )
		    ) AS movieListCandidateRows`,
	)
		.bind(changedAfter, changedAfter, changedAfter)
		.first<MovieListBuildReadiness>();

	return {
		tmdbRows: row?.tmdbRows ?? 0,
		imdbRows: row?.imdbRows ?? 0,
		tmdbRowsMissingEnrichment: row?.tmdbRowsMissingEnrichment ?? 0,
		tmdbTerminalErrorRows: row?.tmdbTerminalErrorRows ?? 0,
		movieListCandidateRows: row?.movieListCandidateRows ?? 0,
	};
}

async function getLastSuccessfulMovieListBuildEndedAt(env: Env) {
	const row = await env.DB.prepare(
		`SELECT ended_at
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status = 'complete'
		   AND ended_at IS NOT NULL
		 ORDER BY ended_at DESC
		 LIMIT 1`,
	)
		.bind(MOVIE_LIST_BUILD_JOB_NAME)
		.first<{ ended_at: string | null }>();

	return row?.ended_at ?? null;
}

async function getNextMovieListBuildChunk(
	env: Env,
	lastTmdbId: number,
	chunkRows: number,
	changedAfter: string | null,
) {
	const row = await env.DB.prepare(
		`SELECT
		    COUNT(*) AS chunkRows,
		    MAX(tmdb_id) AS lastTmdbId
		 FROM (
		    SELECT tmdb.tmdb_id
		    FROM tmdb_movies_staging AS tmdb
		    WHERE tmdb.tmdb_enriched_at IS NOT NULL
		      AND tmdb.tmdb_enrichment_error IS NULL
		      AND tmdb.poster_path IS NOT NULL
		      AND tmdb.poster_path <> ''
		      AND tmdb.tmdb_id > ?
		      AND (
		        ? IS NULL
		        OR tmdb.imported_at > ?
		        OR tmdb.tmdb_enriched_at > ?
		      )
		    ORDER BY tmdb.tmdb_id
		    LIMIT ?
		 )`,
	)
		.bind(lastTmdbId, changedAfter, changedAfter, changedAfter, chunkRows)
		.first<MovieListBuildChunk>();

	return {
		chunkRows: row?.chunkRows ?? 0,
		lastTmdbId: row?.lastTmdbId ?? null,
	};
}

async function upsertMovieListItemsChunk(
	env: Env,
	firstTmdbIdExclusive: number,
	lastTmdbIdInclusive: number,
	changedAfter: string | null,
) {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO movie_list_items (
			tmdb_id,
			title,
			poster_path,
			release_date,
			us_certification,
			imdb_rating,
			imdb_vote_count,
			popularity,
			last_refreshed_at
		)
		SELECT
			tmdb.tmdb_id,
			tmdb.title,
			tmdb.poster_path,
			tmdb.release_date,
			tmdb.us_certification,
			imdb.average_rating AS imdb_rating,
			imdb.num_votes AS imdb_vote_count,
			COALESCE(tmdb.popularity, 0) AS popularity,
			CURRENT_TIMESTAMP AS last_refreshed_at
		FROM tmdb_movies_staging AS tmdb
		LEFT JOIN imdb_ratings_staging AS imdb
			ON imdb.imdb_id = tmdb.imdb_id
			WHERE tmdb.tmdb_enriched_at IS NOT NULL
				AND tmdb.tmdb_enrichment_error IS NULL
				AND tmdb.poster_path IS NOT NULL
				AND tmdb.poster_path <> ''
				AND tmdb.tmdb_id > ?
				AND tmdb.tmdb_id <= ?
				AND (
				  ? IS NULL
				  OR tmdb.imported_at > ?
				  OR tmdb.tmdb_enriched_at > ?
				)`,
	)
		.bind(
			firstTmdbIdExclusive,
			lastTmdbIdInclusive,
			changedAfter,
			changedAfter,
			changedAfter,
		)
		.run();
}

export async function rebuildMovieListItems(
	env: Env,
	trigger: "manual" | "cron",
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const jobRunId = createImportJobRunId(MOVIE_LIST_BUILD_JOB_NAME, trigger);
	const lockOwner = createJobOwner(trigger);
	await createImportJobRun(env, {
		jobRunId,
		jobName: MOVIE_LIST_BUILD_JOB_NAME,
		trigger,
	});

	const lockAcquired = await acquireImportJobLock(
		env,
		MOVIE_LIST_BUILD_JOB_NAME,
		lockOwner,
		MOVIE_LIST_BUILD_LOCK_MINUTES,
	);

	if (!lockAcquired) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			jobRunId,
			trigger,
			skipped: true,
			skipReason: "job_already_running",
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "skipped",
			result,
			lastError: result.skipReason,
		});

		return result;
	}

	let trackedUpsertedRows = 0;

	try {
		logEvent("movie-list-build-start", {
			trigger,
			jobRunId,
			startedAt,
		});

		const lastSuccessfulBuildEndedAt =
			await getLastSuccessfulMovieListBuildEndedAt(env);
		const latestPrimaryWithNewMovieIds =
			await getLatestCleanImportJobRunWithResultJsonNumberGreaterThan(env, {
				jobName: TMDB_PRIMARY_JOB_NAME,
				resultJsonPath: "$.rowsInserted",
				greaterThan: 0,
			});
		const dependencyRequirements: ImportJobDependencyRequirement[] = [
			{
				jobName: IMDB_RATINGS_JOB_NAME,
				endedAfter: lastSuccessfulBuildEndedAt,
				endedAfterLabel: "latest successful movie-list build",
			},
			{ jobName: TMDB_PRIMARY_JOB_NAME },
		];

		if (latestPrimaryWithNewMovieIds) {
			dependencyRequirements.push({
				jobName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
				endedAfter: latestPrimaryWithNewMovieIds.ended_at,
				endedAfterLabel:
					"latest TMDB primary run that inserted new movie IDs",
			});
		}

		dependencyRequirements.push({
			jobName: TMDB_PROVIDER_REFRESH_JOB_NAME,
			afterJobName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
		});

		const dependencies = await checkImportJobDependencies(
			env,
			dependencyRequirements,
		);

		if (!dependencies.ok) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				jobRunId,
				trigger,
				skipped: true,
				skipReason: "job_dependency_not_ready",
				dependencyBlockers: dependencies.blockers,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			await finishImportJobRun(env, jobRunId, {
				status: "skipped",
				result,
				lastError: result.skipReason,
			});

			logEvent("movie-list-build-skipped", result);

			return result;
		}

		const activeTmdbEnrichmentRun =
			await getActiveTmdbEnrichmentImportJobRun(env);

		if (activeTmdbEnrichmentRun) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				jobRunId,
				trigger,
				skipped: true,
				skipReason: "tmdb_full_enrichment_job_active",
				activeJobRunId: activeTmdbEnrichmentRun.job_run_id,
				activeJobName: activeTmdbEnrichmentRun.job_name,
				activeStatus: activeTmdbEnrichmentRun.status,
				activeSelected: activeTmdbEnrichmentRun.selected_count,
				activeProcessed: activeTmdbEnrichmentRun.processed_count,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			await finishImportJobRun(env, jobRunId, {
				status: "skipped",
				result,
				lastError: result.skipReason,
			});

			logEvent("movie-list-build-skipped", result);

			return result;
		}

		const readiness = await getMovieListBuildReadiness(
			env,
			lastSuccessfulBuildEndedAt,
		);

		const potentialLoadCheck = await checkMovieListPotentialLoadCounts(
			env,
			trigger,
		);

		if (potentialLoadCheck.shouldStopMovieListBuild) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				jobRunId,
				trigger,
				skipped: true,
				skipReason: "movie_list_potential_load_threshold_exceeded",
				potentialLoadCheck,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			await finishImportJobRun(env, jobRunId, {
				status: "skipped",
				selected: potentialLoadCheck.plCounts.count,
				processed: 0,
				updated: 0,
				result,
				lastError: potentialLoadCheck.jobStoppedReason,
			});

			logEvent("movie-list-build-skipped", result);

			return result;
		}

		const genrePromotion = await promotePendingMovieGenres(env, trigger);
		const watchProviderPromotion =
			await promotePendingMovieWatchProviders(env, trigger);

		let lastTmdbId = 0;
		let upsertedRows = 0;
		let nextProgressLogAt = MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS;

		while (true) {
			const chunk = await getNextMovieListBuildChunk(
				env,
				lastTmdbId,
				MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS,
				lastSuccessfulBuildEndedAt,
			);

			if (chunk.chunkRows === 0 || chunk.lastTmdbId === null) {
				break;
			}

			await upsertMovieListItemsChunk(
				env,
				lastTmdbId,
				chunk.lastTmdbId,
				lastSuccessfulBuildEndedAt,
			);

			lastTmdbId = chunk.lastTmdbId;
			upsertedRows += chunk.chunkRows;
			trackedUpsertedRows = upsertedRows;

			if (
				upsertedRows >= nextProgressLogAt ||
				upsertedRows === readiness.movieListCandidateRows
			) {
				const progressResult = {
					upsertedRows,
					candidateRows: readiness.movieListCandidateRows,
					lastTmdbId,
					durationMs: Date.now() - startedAtMs,
				};

				logEvent("movie-list-build-progress", {
					trigger,
					jobRunId,
					...progressResult,
				});

				await updateImportJobRunProgress(env, jobRunId, {
					selected: readiness.movieListCandidateRows,
					processed: upsertedRows,
					updated: upsertedRows,
					result: progressResult,
				});

				while (nextProgressLogAt <= upsertedRows) {
					nextProgressLogAt += MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS;
				}
			}
		}

		const countResult = await env.DB.prepare(
			"SELECT COUNT(*) AS movie_list_count FROM movie_list_items",
		).first<{ movie_list_count: number }>();
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			jobRunId,
			trigger,
			movieListCount: countResult?.movie_list_count ?? 0,
			lastSuccessfulBuildEndedAt,
			insertChunkRows: MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS,
			upsertedRows,
			deletedRows: 0,
			genrePromotion,
			watchProviderPromotion,
			readiness,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected: readiness.movieListCandidateRows,
			processed: upsertedRows,
			updated: upsertedRows,
			result,
		});

		const currentCountSnapshot =
			await recordMovieListCurrentCountSnapshot(env, trigger);

		logEvent("movie-list-build-end", {
			...result,
			currentCountSnapshot: JSON.stringify(currentCountSnapshot),
		});

		return {
			...result,
			currentCountSnapshot,
		};
	} catch (error) {
		const lastError =
			error instanceof Error ? error.message : "Movie list build failed.";

		const result = {
			jobRunId,
			trigger,
			status: "cancelled",
			reason: "movie_list_build_error",
			error: lastError,
			upsertedRows: trackedUpsertedRows,
			startedAt,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			selected: trackedUpsertedRows,
			processed: trackedUpsertedRows,
			updated: trackedUpsertedRows,
			errors: 1,
			result,
			lastError,
		});

		logEvent("movie-list-build-cancelled", result);

		throw error;
	} finally {
		await releaseImportJobLock(env, MOVIE_LIST_BUILD_JOB_NAME, lockOwner);
	}
}
