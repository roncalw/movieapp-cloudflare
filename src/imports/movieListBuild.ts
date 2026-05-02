import {
	acquireImportJobLock,
	createJobOwner,
	releaseImportJobLock,
} from "../jobs/importJobLocks";
import { getActiveTmdbEnrichmentImportJobRun } from "../jobs/importJobRuns";
import type { Env } from "../shared/types";

type MovieListBuildReadiness = {
	tmdbRows: number;
	imdbRows: number;
	tmdbRowsNeedingEnrichment: number;
	tmdbTerminalErrorRows: number;
	movieListCandidateRows: number;
};

type MovieListBuildChunk = {
	chunkRows: number;
	lastTmdbId: number | null;
};

const MOVIE_LIST_BUILD_JOB_NAME = "movie-list-build";
const MOVIE_LIST_BUILD_LOCK_MINUTES = 60;
const MOVIE_LIST_BUILD_REFRESH_OLDER_THAN_DAYS = 7;
const MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS = 10000;
const MOVIE_LIST_BUILD_CLEANUP_CHUNK_ROWS = 10000;
const MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS = 100000;

async function getMovieListBuildReadiness(
	env: Env,
	refreshOlderThanDays: number,
): Promise<MovieListBuildReadiness> {
	const row = await env.DB.prepare(
		`SELECT
		    (SELECT COUNT(*) FROM tmdb_movies_staging) AS tmdbRows,
		    (SELECT COUNT(*) FROM imdb_ratings_staging) AS imdbRows,
		    (
		      SELECT COUNT(*)
		      FROM tmdb_movies_staging
		      WHERE (tmdb_enriched_at IS NULL
		         OR tmdb_enriched_at < datetime('now', '-' || ? || ' days'))
		        AND tmdb_enrichment_error IS NULL
		    ) AS tmdbRowsNeedingEnrichment,
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
		    ) AS movieListCandidateRows`,
	)
		.bind(refreshOlderThanDays)
		.first<MovieListBuildReadiness>();

	return {
		tmdbRows: row?.tmdbRows ?? 0,
		imdbRows: row?.imdbRows ?? 0,
		tmdbRowsNeedingEnrichment: row?.tmdbRowsNeedingEnrichment ?? 0,
		tmdbTerminalErrorRows: row?.tmdbTerminalErrorRows ?? 0,
		movieListCandidateRows: row?.movieListCandidateRows ?? 0,
	};
}

function getMovieListBuildReadinessBlockers(
	readiness: MovieListBuildReadiness,
) {
	const blockers: string[] = [];

	if (readiness.tmdbRows === 0) {
		blockers.push("tmdb_staging_empty");
	}

	if (readiness.imdbRows === 0) {
		blockers.push("imdb_staging_empty");
	}

	if (readiness.tmdbRowsNeedingEnrichment > 0) {
		blockers.push("tmdb_enrichment_not_current");
	}

	if (readiness.movieListCandidateRows === 0) {
		blockers.push("no_movie_list_candidates");
	}

	return blockers;
}

async function getNextMovieListBuildChunk(
	env: Env,
	lastTmdbId: number,
	chunkRows: number,
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
		    ORDER BY tmdb.tmdb_id
		    LIMIT ?
		 )`,
	)
		.bind(lastTmdbId, chunkRows)
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
			AND tmdb.tmdb_id <= ?`,
	)
		.bind(firstTmdbIdExclusive, lastTmdbIdInclusive)
		.run();
}

async function cleanupInvalidMovieListItemsChunk(env: Env, chunkRows: number) {
	const result = await env.DB.prepare(
		`DELETE FROM movie_list_items
		 WHERE tmdb_id IN (
		    SELECT movie.tmdb_id
		    FROM movie_list_items AS movie
		    LEFT JOIN tmdb_movies_staging AS tmdb
		      ON tmdb.tmdb_id = movie.tmdb_id
		     AND tmdb.tmdb_enriched_at IS NOT NULL
		     AND tmdb.tmdb_enrichment_error IS NULL
		     AND tmdb.poster_path IS NOT NULL
		     AND tmdb.poster_path <> ''
		    WHERE tmdb.tmdb_id IS NULL
		    LIMIT ?
		 )`,
	)
		.bind(chunkRows)
		.run();

	return result.meta.changes ?? 0;
}

export async function rebuildMovieListItems(
	env: Env,
	trigger: "manual" | "cron",
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const lockOwner = createJobOwner(trigger);
	const lockAcquired = await acquireImportJobLock(
		env,
		MOVIE_LIST_BUILD_JOB_NAME,
		lockOwner,
		MOVIE_LIST_BUILD_LOCK_MINUTES,
	);

	if (!lockAcquired) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		return {
			trigger,
			skipped: true,
			skipReason: "job_already_running",
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};
	}

	try {
		console.log(
			JSON.stringify({
				event: "movie-list-build-start",
				trigger,
				startedAt,
			}),
		);

		const activeTmdbEnrichmentRun =
			await getActiveTmdbEnrichmentImportJobRun(env);

		if (activeTmdbEnrichmentRun) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				trigger,
				skipped: true,
				skipReason: "tmdb_enrichment_job_active",
				activeJobRunId: activeTmdbEnrichmentRun.job_run_id,
				activeStatus: activeTmdbEnrichmentRun.status,
				activeSelected: activeTmdbEnrichmentRun.selected_count,
				activeProcessed: activeTmdbEnrichmentRun.processed_count,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			console.log(
				JSON.stringify({
					event: "movie-list-build-skipped",
					...result,
				}),
			);

			return result;
		}

		const readiness = await getMovieListBuildReadiness(
			env,
			MOVIE_LIST_BUILD_REFRESH_OLDER_THAN_DAYS,
		);
		const readinessBlockers = getMovieListBuildReadinessBlockers(readiness);

		if (readinessBlockers.length > 0) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				trigger,
				skipped: true,
				skipReason: "staging_not_ready",
				readinessBlockers,
				refreshOlderThanDays: MOVIE_LIST_BUILD_REFRESH_OLDER_THAN_DAYS,
				readiness,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			console.log(
				JSON.stringify({
					event: "movie-list-build-skipped",
					...result,
				}),
			);

			return result;
		}

		let lastTmdbId = 0;
		let upsertedRows = 0;
		let nextProgressLogAt = MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS;

		while (true) {
			const chunk = await getNextMovieListBuildChunk(
				env,
				lastTmdbId,
				MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS,
			);

			if (chunk.chunkRows === 0 || chunk.lastTmdbId === null) {
				break;
			}

			await upsertMovieListItemsChunk(env, lastTmdbId, chunk.lastTmdbId);

			lastTmdbId = chunk.lastTmdbId;
			upsertedRows += chunk.chunkRows;

			if (
				upsertedRows >= nextProgressLogAt ||
				upsertedRows === readiness.movieListCandidateRows
			) {
				console.log(
					JSON.stringify({
						event: "movie-list-build-progress",
						trigger,
						upsertedRows,
						candidateRows: readiness.movieListCandidateRows,
						lastTmdbId,
						durationMs: Date.now() - startedAtMs,
					}),
				);

				while (nextProgressLogAt <= upsertedRows) {
					nextProgressLogAt += MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS;
				}
			}
		}

		let deletedRows = 0;

		while (true) {
			const chunkDeletedRows = await cleanupInvalidMovieListItemsChunk(
				env,
				MOVIE_LIST_BUILD_CLEANUP_CHUNK_ROWS,
			);

			if (chunkDeletedRows === 0) {
				break;
			}

			deletedRows += chunkDeletedRows;
		}

		const countResult = await env.DB.prepare(
			"SELECT COUNT(*) AS movie_list_count FROM movie_list_items",
		).first<{ movie_list_count: number }>();
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			trigger,
			movieListCount: countResult?.movie_list_count ?? 0,
			refreshOlderThanDays: MOVIE_LIST_BUILD_REFRESH_OLDER_THAN_DAYS,
			insertChunkRows: MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS,
			cleanupChunkRows: MOVIE_LIST_BUILD_CLEANUP_CHUNK_ROWS,
			upsertedRows,
			deletedRows,
			readiness,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		console.log(
			JSON.stringify({
				event: "movie-list-build-end",
				...result,
			}),
		);

		return result;
	} finally {
		await releaseImportJobLock(env, MOVIE_LIST_BUILD_JOB_NAME, lockOwner);
	}
}
