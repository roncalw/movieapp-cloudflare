import {
	acquireImportJobLock,
	createJobOwner,
	releaseImportJobLock,
} from "../jobs/importJobLocks";
import {
	checkMovieListPotentialLoadCounts,
	recordMovieListCurrentCountSnapshot,
} from "./movieListLoadCounts";
import { promotePendingMovieGenres } from "./movieRelationshipPromotions";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getActiveImportJobRunForDate,
	getImportJobRunById,
	IMDB_RATINGS_JOB_NAME,
	MOVIE_LIST_BUILD_JOB_NAME,
	TMDB_ENRICH_JOB_NAME,
	TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	TMDB_POPULARITY_REFRESH_JOB_NAME,
	TMDB_PRIMARY_JOB_NAME,
	type ImportJobRunRow,
	updateImportJobRunProgress,
} from "../jobs/importJobRuns";
import {
	checkImportJobDependencies,
	getLatestCleanImportJobRunWithResultJsonNumberGreaterThan,
	type ImportJobDependencyRequirement,
} from "../jobs/importJobDependencies";
import type { Env } from "../shared/types";
import { logEvent } from "../shared/logging";
import { enqueueMovieListPopularityQueueWork } from "./movieListBuildQueue";

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

type MovieListImdbSyncResult = {
	candidateRows: number;
	updatedRows: number;
	remainingRows: number;
	lastTmdbId: number;
};

type MovieListPopularitySyncResult = {
	candidateRows: number;
	updatedRows: number;
	remainingRows: number;
	lastTmdbId: number;
};

type MovieListImdbSource = {
	run: ImportJobRunRow;
	mode: "legacy-time-window" | "run-separated";
};

const MOVIE_LIST_BUILD_LOCK_MINUTES = 240;
const MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS = 10000;
const MOVIE_LIST_BUILD_IMDB_UPDATE_CHUNK_ROWS = 1000;
const MOVIE_LIST_BUILD_POPULARITY_UPDATE_CHUNK_ROWS = 1000;
const MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS = 100000;
const MOVIE_LIST_BUILD_IMDB_PROGRESS_EVERY_ROWS = 10000;
const MOVIE_LIST_BUILD_POPULARITY_PROGRESS_EVERY_ROWS = 10000;
const MOVIE_LIST_BUILD_STAGING_CLEANUP_CHUNK_ROWS = 5000;

function parseRunResult(resultJson: string | null) {
	if (!resultJson) {
		return {} as Record<string, unknown>;
	}

	try {
		return JSON.parse(resultJson) as Record<string, unknown>;
	} catch {
		return {} as Record<string, unknown>;
	}
}

export function getMovieListImdbSource(
	run: ImportJobRunRow,
): MovieListImdbSource {
	const result = parseRunResult(run.result_json);

	if (result.isFullImport === true) {
		return { run, mode: "run-separated" };
	}

	return { run, mode: "legacy-time-window" };
}

export function getImdbSourceJoinSql(source: MovieListImdbSource) {
	if (source.mode === "run-separated") {
		return {
			tableName: "imdb_ratings_staging_by_run",
			predicate: "imdb.load_run_id = ?",
			bindings: [source.run.job_run_id] as unknown[],
		};
	}

	return {
		tableName: "imdb_ratings_staging",
		predicate: "imdb.imported_at >= ? AND imdb.imported_at <= ?",
		bindings: [source.run.started_at, source.run.ended_at] as unknown[],
	};
}

async function getPreviouslyAppliedSourceRunId(
	env: Env,
	resultJsonPath: string,
	excludeSourceRunId: string,
) {
	const row = await env.DB.prepare(
		`SELECT json_extract(COALESCE(result_json, '{}'), ?) AS sourceRunId
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status = 'complete'
		   AND error_count = 0
		   AND ended_at IS NOT NULL
		   AND json_extract(COALESCE(result_json, '{}'), ?) IS NOT NULL
		   AND json_extract(COALESCE(result_json, '{}'), ?) <> ?
		 ORDER BY ended_at DESC
		 LIMIT 1`,
	)
		.bind(
			resultJsonPath,
			MOVIE_LIST_BUILD_JOB_NAME,
			resultJsonPath,
			resultJsonPath,
			excludeSourceRunId,
		)
		.first<{ sourceRunId: string | null }>();

	return row?.sourceRunId ?? null;
}

async function cleanupOldPopularityStagingRuns(
	env: Env,
	selectedRunId: string,
) {
	const previousAppliedRunId = await getPreviouslyAppliedSourceRunId(
		env,
		"$.popularitySourceJobRunId",
		selectedRunId,
	);
	let deletedRows = 0;

	while (true) {
		const result = await env.DB.prepare(
			`DELETE FROM tmdb_movie_popularity_staging
			 WHERE load_run_id IN (
			     SELECT job_run_id
			     FROM import_job_runs
			     WHERE job_name = ?
			       AND status NOT IN ('queued', 'running')
			       AND job_run_id <> ?
			       AND job_run_id <> ?
			   )
			 LIMIT ?`,
		)
			.bind(
				TMDB_POPULARITY_REFRESH_JOB_NAME,
				selectedRunId,
				previousAppliedRunId ?? selectedRunId,
				MOVIE_LIST_BUILD_STAGING_CLEANUP_CHUNK_ROWS,
			)
			.run();

		deletedRows += result.meta.changes;

		if (result.meta.changes < MOVIE_LIST_BUILD_STAGING_CLEANUP_CHUNK_ROWS) {
			break;
		}
	}

	return {
		selectedRunId,
		previousAppliedRunId,
		deletedRows,
		chunkRows: MOVIE_LIST_BUILD_STAGING_CLEANUP_CHUNK_ROWS,
	};
}

async function cleanupOldImdbStagingRuns(
	env: Env,
	imdbSource: MovieListImdbSource,
) {
	if (imdbSource.mode !== "run-separated") {
		return {
			skipped: true,
			skipReason: "legacy_time_window_source",
			selectedRunId: imdbSource.run.job_run_id,
			deletedRows: 0,
		};
	}

	const selectedRunId = imdbSource.run.job_run_id;
	const previousAppliedRunId = await getPreviouslyAppliedSourceRunId(
		env,
		"$.imdbSourceJobRunId",
		selectedRunId,
	);
	let deletedRows = 0;

	while (true) {
		const result = await env.DB.prepare(
			`DELETE FROM imdb_ratings_staging_by_run
			 WHERE load_run_id IN (
			     SELECT job_run_id
			     FROM import_job_runs
			     WHERE job_name = ?
			       AND status NOT IN ('queued', 'running')
			       AND job_run_id <> ?
			       AND job_run_id <> ?
			   )
			 LIMIT ?`,
		)
			.bind(
				IMDB_RATINGS_JOB_NAME,
				selectedRunId,
				previousAppliedRunId ?? selectedRunId,
				MOVIE_LIST_BUILD_STAGING_CLEANUP_CHUNK_ROWS,
			)
			.run();

		deletedRows += result.meta.changes;

		if (result.meta.changes < MOVIE_LIST_BUILD_STAGING_CLEANUP_CHUNK_ROWS) {
			break;
		}
	}

	return {
		skipped: false,
		selectedRunId,
		previousAppliedRunId,
		deletedRows,
		chunkRows: MOVIE_LIST_BUILD_STAGING_CLEANUP_CHUNK_ROWS,
	};
}

async function getMovieListBuildReadiness(
	env: Env,
	changedAfter: string | null,
	imdbSource: MovieListImdbSource,
): Promise<MovieListBuildReadiness> {
	const imdbSql = getImdbSourceJoinSql(imdbSource);
	const row = await env.DB.prepare(
		`SELECT
		    (SELECT COUNT(*) FROM tmdb_movies_staging) AS tmdbRows,
		    (
		      SELECT COUNT(*)
		      FROM ${imdbSql.tableName} AS imdb
		      WHERE ${imdbSql.predicate}
		    ) AS imdbRows,
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
		.bind(
			...imdbSql.bindings,
			changedAfter,
			changedAfter,
			changedAfter,
		)
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
	imdbSource: MovieListImdbSource,
	popularityRun: ImportJobRunRow,
) {
	const imdbSql = getImdbSourceJoinSql(imdbSource);
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
			original_language,
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
			COALESCE(popularity.popularity, tmdb.popularity, 0) AS popularity,
			tmdb.original_language,
			CURRENT_TIMESTAMP AS last_refreshed_at
		FROM tmdb_movies_staging AS tmdb
		LEFT JOIN ${imdbSql.tableName} AS imdb
			ON imdb.imdb_id = tmdb.imdb_id
			AND ${imdbSql.predicate}
		LEFT JOIN tmdb_movie_popularity_staging AS popularity
			ON popularity.load_run_id = ?
			AND popularity.tmdb_id = tmdb.tmdb_id
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
			...imdbSql.bindings,
			popularityRun.job_run_id,
			firstTmdbIdExclusive,
			lastTmdbIdInclusive,
			changedAfter,
			changedAfter,
			changedAfter,
		)
		.run();
}

async function getMovieListImdbDifferenceCount(
	env: Env,
	imdbSource: MovieListImdbSource,
) {
	const imdbSql = getImdbSourceJoinSql(imdbSource);
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS candidateRows
		 FROM movie_list_items AS movie
		 JOIN tmdb_movies_staging AS tmdb
		   ON tmdb.tmdb_id = movie.tmdb_id
		 JOIN ${imdbSql.tableName} AS imdb
		   ON imdb.imdb_id = tmdb.imdb_id
		  AND ${imdbSql.predicate}
		 WHERE movie.imdb_rating IS NOT imdb.average_rating
		    OR movie.imdb_vote_count IS NOT imdb.num_votes`,
	)
		.bind(...imdbSql.bindings)
		.first<{ candidateRows: number }>();

	return row?.candidateRows ?? 0;
}

async function getNextMovieListImdbDifferenceChunk(
	env: Env,
	imdbSource: MovieListImdbSource,
	lastTmdbId: number,
) {
	const imdbSql = getImdbSourceJoinSql(imdbSource);
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS chunkRows,
		        MAX(tmdb_id) AS lastTmdbId
		 FROM (
		   SELECT movie.tmdb_id
		   FROM movie_list_items AS movie
		   JOIN tmdb_movies_staging AS tmdb
		     ON tmdb.tmdb_id = movie.tmdb_id
		   JOIN ${imdbSql.tableName} AS imdb
		     ON imdb.imdb_id = tmdb.imdb_id
		    AND ${imdbSql.predicate}
		   WHERE movie.tmdb_id > ?
		     AND (
		       movie.imdb_rating IS NOT imdb.average_rating
		       OR movie.imdb_vote_count IS NOT imdb.num_votes
		     )
		   ORDER BY movie.tmdb_id
		   LIMIT ?
		 )`,
	)
		.bind(
			...imdbSql.bindings,
			lastTmdbId,
			MOVIE_LIST_BUILD_IMDB_UPDATE_CHUNK_ROWS,
		)
		.first<MovieListBuildChunk>();

	return {
		chunkRows: row?.chunkRows ?? 0,
		lastTmdbId: row?.lastTmdbId ?? null,
	};
}

async function updateMovieListImdbDifferenceChunk(
	env: Env,
	imdbSource: MovieListImdbSource,
	firstTmdbIdExclusive: number,
	lastTmdbIdInclusive: number,
) {
	const imdbSql = getImdbSourceJoinSql(imdbSource);
	const updateResult = await env.DB.prepare(
		`UPDATE movie_list_items AS movie
		 SET imdb_rating = imdb.average_rating,
		     imdb_vote_count = imdb.num_votes,
		     last_refreshed_at = CURRENT_TIMESTAMP
		 FROM tmdb_movies_staging AS tmdb
		 JOIN ${imdbSql.tableName} AS imdb
		   ON imdb.imdb_id = tmdb.imdb_id
		  AND ${imdbSql.predicate}
		 WHERE movie.tmdb_id = tmdb.tmdb_id
		   AND movie.tmdb_id > ?
		   AND movie.tmdb_id <= ?
		   AND (
		     movie.imdb_rating IS NOT imdb.average_rating
		     OR movie.imdb_vote_count IS NOT imdb.num_votes
		   )`,
	)
		.bind(
			...imdbSql.bindings,
			firstTmdbIdExclusive,
			lastTmdbIdInclusive,
		)
		.run();

	return updateResult.meta.changes;
}

async function synchronizeMovieListImdbValues(
	env: Env,
	jobRunId: string,
	trigger: "manual" | "cron",
	imdbSource: MovieListImdbSource,
	metadataCandidateRows: number,
	metadataUpsertedRows: number,
	startedAtMs: number,
	onUpdatedRows: (updatedRows: number) => void,
): Promise<MovieListImdbSyncResult> {
	const candidateRows = await getMovieListImdbDifferenceCount(
		env,
		imdbSource,
	);
	let lastTmdbId = 0;
	let updatedRows = 0;
	let nextProgressLogAt = MOVIE_LIST_BUILD_IMDB_PROGRESS_EVERY_ROWS;

	while (true) {
		const chunk = await getNextMovieListImdbDifferenceChunk(
			env,
			imdbSource,
			lastTmdbId,
		);

		if (chunk.chunkRows === 0 || chunk.lastTmdbId === null) {
			break;
		}

		const chunkUpdatedRows = await updateMovieListImdbDifferenceChunk(
			env,
			imdbSource,
			lastTmdbId,
			chunk.lastTmdbId,
		);

		if (chunkUpdatedRows > chunk.chunkRows) {
			throw new Error(
				`IMDb movie-list chunk changed ${chunkUpdatedRows} rows after selecting at most ${chunk.chunkRows}.`,
			);
		}

		lastTmdbId = chunk.lastTmdbId;
		updatedRows += chunkUpdatedRows;
		onUpdatedRows(updatedRows);

		if (
			updatedRows >= nextProgressLogAt ||
			updatedRows === candidateRows
		) {
			const progressResult = {
				phase: "imdb-difference-update",
				imdbSourceJobRunId: imdbSource.run.job_run_id,
				imdbSourceMode: imdbSource.mode,
				imdbCandidateRows: candidateRows,
				imdbUpdatedRows: updatedRows,
				lastTmdbId,
				durationMs: Date.now() - startedAtMs,
			};

			logEvent("movie-list-build-imdb-progress", {
				trigger,
				jobRunId,
				...progressResult,
			});

			await updateImportJobRunProgress(env, jobRunId, {
				selected: metadataCandidateRows + candidateRows,
				processed: metadataUpsertedRows + updatedRows,
				updated: metadataUpsertedRows + updatedRows,
				result: progressResult,
			});

			while (nextProgressLogAt <= updatedRows) {
				nextProgressLogAt += MOVIE_LIST_BUILD_IMDB_PROGRESS_EVERY_ROWS;
			}
		}
	}

	const remainingRows = await getMovieListImdbDifferenceCount(
		env,
		imdbSource,
	);

	if (remainingRows !== 0) {
		throw new Error(
			`IMDb movie-list synchronization left ${remainingRows} eligible row(s) different from ${imdbSource.run.job_run_id}.`,
		);
	}

	return {
		candidateRows,
		updatedRows,
		remainingRows,
		lastTmdbId,
	};
}

async function getMovieListPopularityDifferenceCount(
	env: Env,
	popularityRun: ImportJobRunRow,
) {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS candidateRows
		 FROM movie_list_items AS movie
		 JOIN tmdb_movie_popularity_staging AS popularity
		   ON popularity.load_run_id = ?
		  AND popularity.tmdb_id = movie.tmdb_id
		 WHERE movie.popularity IS NOT popularity.popularity`,
	)
		.bind(popularityRun.job_run_id)
		.first<{ candidateRows: number }>();

	return row?.candidateRows ?? 0;
}

async function getNextMovieListPopularityDifferenceChunk(
	env: Env,
	popularityRun: ImportJobRunRow,
	lastTmdbId: number,
) {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS chunkRows,
		        MAX(tmdb_id) AS lastTmdbId
		 FROM (
		   SELECT movie.tmdb_id
		   FROM movie_list_items AS movie
		   JOIN tmdb_movie_popularity_staging AS popularity
		     ON popularity.load_run_id = ?
		    AND popularity.tmdb_id = movie.tmdb_id
		   WHERE movie.tmdb_id > ?
		     AND movie.popularity IS NOT popularity.popularity
		   ORDER BY movie.tmdb_id
		   LIMIT ?
		 )`,
	)
		.bind(
			popularityRun.job_run_id,
			lastTmdbId,
			MOVIE_LIST_BUILD_POPULARITY_UPDATE_CHUNK_ROWS,
		)
		.first<MovieListBuildChunk>();

	return {
		chunkRows: row?.chunkRows ?? 0,
		lastTmdbId: row?.lastTmdbId ?? null,
	};
}

async function updateMovieListPopularityDifferenceChunk(
	env: Env,
	popularityRun: ImportJobRunRow,
	firstTmdbIdExclusive: number,
	lastTmdbIdInclusive: number,
) {
	const updateResult = await env.DB.prepare(
		`UPDATE movie_list_items AS movie
		 SET popularity = popularity_source.popularity,
		     last_refreshed_at = CURRENT_TIMESTAMP
		 FROM tmdb_movie_popularity_staging AS popularity_source
		 WHERE popularity_source.load_run_id = ?
		   AND movie.tmdb_id = popularity_source.tmdb_id
		   AND movie.tmdb_id > ?
		   AND movie.tmdb_id <= ?
		   AND movie.popularity IS NOT popularity_source.popularity`,
	)
		.bind(
			popularityRun.job_run_id,
			firstTmdbIdExclusive,
			lastTmdbIdInclusive,
		)
		.run();

	return updateResult.meta.changes;
}

async function synchronizeMovieListPopularityValues(
	env: Env,
	jobRunId: string,
	trigger: "manual" | "cron",
	popularityRun: ImportJobRunRow,
	completedSelectedRows: number,
	completedUpdatedRows: number,
	startedAtMs: number,
	onUpdatedRows: (updatedRows: number) => void,
): Promise<MovieListPopularitySyncResult> {
	const candidateRows = await getMovieListPopularityDifferenceCount(
		env,
		popularityRun,
	);
	let lastTmdbId = 0;
	let updatedRows = 0;
	let nextProgressLogAt =
		MOVIE_LIST_BUILD_POPULARITY_PROGRESS_EVERY_ROWS;

	while (true) {
		const chunk = await getNextMovieListPopularityDifferenceChunk(
			env,
			popularityRun,
			lastTmdbId,
		);

		if (chunk.chunkRows === 0 || chunk.lastTmdbId === null) {
			break;
		}

		const chunkUpdatedRows =
			await updateMovieListPopularityDifferenceChunk(
				env,
				popularityRun,
				lastTmdbId,
				chunk.lastTmdbId,
			);

		if (chunkUpdatedRows > chunk.chunkRows) {
			throw new Error(
				`Popularity movie-list chunk changed ${chunkUpdatedRows} rows after selecting at most ${chunk.chunkRows}.`,
			);
		}

		lastTmdbId = chunk.lastTmdbId;
		updatedRows += chunkUpdatedRows;
		onUpdatedRows(updatedRows);

		if (
			updatedRows >= nextProgressLogAt ||
			updatedRows === candidateRows
		) {
			const progressResult = {
				phase: "popularity-difference-update",
				popularitySourceJobRunId: popularityRun.job_run_id,
				popularityCandidateRows: candidateRows,
				popularityUpdatedRows: updatedRows,
				lastTmdbId,
				durationMs: Date.now() - startedAtMs,
			};

			logEvent("movie-list-build-popularity-progress", {
				trigger,
				jobRunId,
				...progressResult,
			});

			await updateImportJobRunProgress(env, jobRunId, {
				selected: completedSelectedRows + candidateRows,
				processed: completedUpdatedRows + updatedRows,
				updated: completedUpdatedRows + updatedRows,
				result: progressResult,
			});

			while (nextProgressLogAt <= updatedRows) {
				nextProgressLogAt +=
					MOVIE_LIST_BUILD_POPULARITY_PROGRESS_EVERY_ROWS;
			}
		}
	}

	const remainingRows = await getMovieListPopularityDifferenceCount(
		env,
		popularityRun,
	);

	if (remainingRows !== 0) {
		throw new Error(
			`Popularity movie-list synchronization left ${remainingRows} eligible row(s) different from ${popularityRun.job_run_id}.`,
		);
	}

	return {
		candidateRows,
		updatedRows,
		remainingRows,
		lastTmdbId,
	};
}

export async function rebuildMovieListItems(
	env: Env,
	trigger: "manual" | "cron",
	options: {
		dependencyRunDate?: string;
		imdbRunId?: string;
		popularityRunId?: string;
		queuePopularitySync?: boolean;
	} = {},
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const dependencyRunDate =
		options.dependencyRunDate ?? startedAt.slice(0, 10);
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
			dependencyRunDate,
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
	let trackedImdbUpdatedRows = 0;
	let trackedPopularityUpdatedRows = 0;
	let releaseLockOnExit = true;

	try {
		logEvent("movie-list-build-start", {
			trigger,
			jobRunId,
			dependencyRunDate,
			startedAt,
		});

		const lastSuccessfulBuildEndedAt =
			await getLastSuccessfulMovieListBuildEndedAt(env);
		const latestPrimaryWithNewMovieIds =
			await getLatestCleanImportJobRunWithResultJsonNumberGreaterThan(env, {
				jobName: TMDB_PRIMARY_JOB_NAME,
				resultJsonPath: "$.rowsInserted",
				greaterThan: 0,
				runDate: dependencyRunDate,
			});
		const dependencyRequirements: ImportJobDependencyRequirement[] = [
			{ jobName: TMDB_PRIMARY_JOB_NAME },
		];

		if (!options.imdbRunId) {
			dependencyRequirements.unshift({ jobName: IMDB_RATINGS_JOB_NAME });
		}

		if (!options.popularityRunId) {
			dependencyRequirements.push({
				jobName: TMDB_POPULARITY_REFRESH_JOB_NAME,
			});
		}

		if (latestPrimaryWithNewMovieIds) {
			dependencyRequirements.push({
				jobName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
				endedAfter: latestPrimaryWithNewMovieIds.ended_at,
				endedAfterLabel:
					"latest TMDB primary run that inserted new movie IDs",
			});
		}

		const dependencies = await checkImportJobDependencies(
			env,
			dependencyRequirements,
			dependencyRunDate,
		);

		let popularityRun = dependencies.runs[TMDB_POPULARITY_REFRESH_JOB_NAME];
		let imdbRun = dependencies.runs[IMDB_RATINGS_JOB_NAME];

		if (options.imdbRunId) {
			const explicitImdbRun = await getImportJobRunById(
				env,
				options.imdbRunId,
			);
			const explicitImdbResult = parseRunResult(
				explicitImdbRun?.result_json ?? null,
			);

			if (
				!explicitImdbRun ||
				explicitImdbRun.job_name !== IMDB_RATINGS_JOB_NAME ||
				explicitImdbRun.status !== "complete" ||
				explicitImdbRun.error_count !== 0 ||
				explicitImdbRun.ended_at === null ||
				explicitImdbResult.isFullImport === false
			) {
				dependencies.ok = false;
				dependencies.blockers.push({
					jobName: IMDB_RATINGS_JOB_NAME,
					reason: "explicit_imdb_run_not_complete_full_import",
					jobRunId: explicitImdbRun?.job_run_id,
					status: explicitImdbRun?.status,
					errorCount: explicitImdbRun?.error_count,
					endedAt: explicitImdbRun?.ended_at,
				});
			} else {
				imdbRun = explicitImdbRun;
			}
		}

		if (options.popularityRunId) {
			const explicitPopularityRun = await getImportJobRunById(
				env,
				options.popularityRunId,
			);

			if (
				!explicitPopularityRun ||
				explicitPopularityRun.job_name !==
					TMDB_POPULARITY_REFRESH_JOB_NAME ||
				explicitPopularityRun.status !== "complete" ||
				explicitPopularityRun.error_count !== 0 ||
				explicitPopularityRun.ended_at === null
			) {
				dependencies.ok = false;
				dependencies.blockers.push({
					jobName: TMDB_POPULARITY_REFRESH_JOB_NAME,
					reason: "explicit_popularity_run_not_complete",
					jobRunId: explicitPopularityRun?.job_run_id,
					status: explicitPopularityRun?.status,
					errorCount: explicitPopularityRun?.error_count,
					endedAt: explicitPopularityRun?.ended_at,
				});
			} else {
				popularityRun = explicitPopularityRun;
			}
		}

		if (!dependencies.ok) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				jobRunId,
				trigger,
				skipped: true,
				skipReason: "job_dependency_not_ready",
				dependencyBlockers: dependencies.blockers,
				dependencyRunDate,
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

		if (!imdbRun?.ended_at) {
			throw new Error(
				`The Movie List job could not resolve a completed IMDb run for ${dependencyRunDate}.`,
			);
		}

		const imdbRunResult = parseRunResult(imdbRun.result_json);

		if (imdbRunResult.isFullImport === false) {
			throw new Error(
				`The Movie List job will not use partial IMDb run ${imdbRun.job_run_id}.`,
			);
		}

		const imdbSource = getMovieListImdbSource(imdbRun);

		if (!popularityRun?.ended_at) {
			throw new Error(
				`The Movie List job could not resolve a completed TMDb popularity run for ${dependencyRunDate}.`,
			);
		}

		const activeTmdbEnrichmentRun = await getActiveImportJobRunForDate(
			env,
			TMDB_ENRICH_JOB_NAME,
			dependencyRunDate,
		);

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
			imdbSource,
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
				imdbSource,
				popularityRun,
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

		const imdbSync = await synchronizeMovieListImdbValues(
			env,
			jobRunId,
			trigger,
			imdbSource,
			readiness.movieListCandidateRows,
			upsertedRows,
			startedAtMs,
			(updatedRows) => {
				trackedImdbUpdatedRows = updatedRows;
			},
		);

		if (options.queuePopularitySync) {
			const popularityCandidateRows =
				await getMovieListPopularityDifferenceCount(env, popularityRun);
			const queuedResult = await enqueueMovieListPopularityQueueWork(
				env,
				jobRunId,
				{
					trigger,
					lockOwner,
					dependencyRunDate,
					startedAt,
					lastSuccessfulBuildEndedAt,
					upsertedRows,
					imdbSourceJobRunId: imdbRun.job_run_id,
					imdbSourceMode: imdbSource.mode,
					imdbSourceStartedAt: imdbRun.started_at,
					imdbSourceEndedAt: imdbRun.ended_at,
					imdbRunWasExplicit: options.imdbRunId !== undefined,
					imdbSync,
					popularitySourceJobRunId: popularityRun.job_run_id,
					popularitySourceStartedAt: popularityRun.started_at,
					popularitySourceEndedAt: popularityRun.ended_at,
					popularityRunWasExplicit:
						options.popularityRunId !== undefined,
					popularityCandidateRows,
					baseSelectedRows:
						readiness.movieListCandidateRows + imdbSync.candidateRows,
					baseUpdatedRows: upsertedRows + imdbSync.updatedRows,
					readiness,
					genrePromotion,
				},
			);

			/*
				The queue finalizer owns this lock from this point forward. Releasing it
				here would allow another Movie List build to start while range messages
				are still changing production rows.
			*/
			releaseLockOnExit = false;
			return queuedResult;
		}

		const popularitySync = await synchronizeMovieListPopularityValues(
			env,
			jobRunId,
			trigger,
			popularityRun,
			readiness.movieListCandidateRows + imdbSync.candidateRows,
			upsertedRows + imdbSync.updatedRows,
			startedAtMs,
			(updatedRows) => {
				trackedPopularityUpdatedRows = updatedRows;
			},
		);
		const imdbStagingCleanup = await cleanupOldImdbStagingRuns(
			env,
			imdbSource,
		);
		const popularityStagingCleanup =
			await cleanupOldPopularityStagingRuns(
				env,
				popularityRun.job_run_id,
			);

		const countResult = await env.DB.prepare(
			"SELECT COUNT(*) AS movie_list_count FROM movie_list_items",
		).first<{ movie_list_count: number }>();
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			jobRunId,
			trigger,
			movieListCount: countResult?.movie_list_count ?? 0,
			dependencyRunDate,
			lastSuccessfulBuildEndedAt,
			insertChunkRows: MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS,
			imdbUpdateChunkRows: MOVIE_LIST_BUILD_IMDB_UPDATE_CHUNK_ROWS,
			popularityUpdateChunkRows:
				MOVIE_LIST_BUILD_POPULARITY_UPDATE_CHUNK_ROWS,
			upsertedRows,
			imdbSourceJobRunId: imdbRun.job_run_id,
			imdbSourceMode: imdbSource.mode,
			imdbRunWasExplicit: options.imdbRunId !== undefined,
			imdbSourceStartedAt: imdbRun.started_at,
			imdbSourceEndedAt: imdbRun.ended_at,
			imdbSync,
			imdbStagingCleanup,
			popularitySourceJobRunId: popularityRun.job_run_id,
			popularitySourceStartedAt: popularityRun.started_at,
			popularitySourceEndedAt: popularityRun.ended_at,
			popularityRunWasExplicit: options.popularityRunId !== undefined,
			popularitySync,
			popularityStagingCleanup,
			deletedRows: 0,
			genrePromotion,
			readiness,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected:
				readiness.movieListCandidateRows +
				imdbSync.candidateRows +
				popularitySync.candidateRows,
			processed:
				upsertedRows +
				imdbSync.updatedRows +
				popularitySync.updatedRows,
			updated:
				upsertedRows +
				imdbSync.updatedRows +
				popularitySync.updatedRows,
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
			dependencyRunDate,
			error: lastError,
			upsertedRows: trackedUpsertedRows,
			imdbUpdatedRows: trackedImdbUpdatedRows,
			popularityUpdatedRows: trackedPopularityUpdatedRows,
			startedAt,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			selected:
				trackedUpsertedRows +
				trackedImdbUpdatedRows +
				trackedPopularityUpdatedRows,
			processed:
				trackedUpsertedRows +
				trackedImdbUpdatedRows +
				trackedPopularityUpdatedRows,
			updated:
				trackedUpsertedRows +
				trackedImdbUpdatedRows +
				trackedPopularityUpdatedRows,
			errors: 1,
			result,
			lastError,
		});

		logEvent("movie-list-build-cancelled", result);

		throw error;
	} finally {
		if (releaseLockOnExit) {
			await releaseImportJobLock(env, MOVIE_LIST_BUILD_JOB_NAME, lockOwner);
		}
	}
}
