import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	MOVIE_LIST_CURRENT_COUNT_SNAPSHOT_JOB_NAME,
	MOVIE_LIST_POTENTIAL_LOAD_CHECK_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import type { Env } from "../shared/types";
import { logEvent } from "../shared/logging";

const MOVIE_LIST_LOAD_DEFAULT_THRESHOLD = 1.0;
const MOVIE_LIST_LOAD_DEFAULT_WATCH_PROVIDER_THRESHOLD = 10.0;

type MovieListLoadCounts = {
	count: number;
	imdbRatingCount: number;
	imdbVoteCount: number;
	releaseDateCount: number;
	certificationCount: number;
	popularityCount: number;
	genreCount: number;
	genrePerMovieCount: number;
	watchProviderCount: number;
	watchProviderPerMovieCount: number;
};

type MovieListLoadCountRow = {
	load_date: string;
	threshold: number;
	watch_provider_threshold: number;
};

type CountDrop = {
	column: string;
	ccCount: number;
	plCount: number;
	dropPercent: number;
	threshold: number;
};

function todayLoadDate() {
	return new Date(Date.now()).toISOString().slice(0, 10);
}

function getCountDrops(
	ccCounts: MovieListLoadCounts,
	plCounts: MovieListLoadCounts,
	threshold: number,
	watchProviderThreshold: number,
) {
	const countPairs: Array<[string, number, number, number]> = [
		["count", ccCounts.count, plCounts.count, threshold],
		["imdb_rating", ccCounts.imdbRatingCount, plCounts.imdbRatingCount, threshold],
		["imdb_vote", ccCounts.imdbVoteCount, plCounts.imdbVoteCount, threshold],
		["release_date", ccCounts.releaseDateCount, plCounts.releaseDateCount, threshold],
		[
			"certification",
			ccCounts.certificationCount,
			plCounts.certificationCount,
			threshold,
		],
		["popularity", ccCounts.popularityCount, plCounts.popularityCount, threshold],
		["genre", ccCounts.genreCount, plCounts.genreCount, threshold],
		[
			"genre_per_movie",
			ccCounts.genrePerMovieCount,
			plCounts.genrePerMovieCount,
			threshold,
		],
		[
			"watch_provider",
			ccCounts.watchProviderCount,
			plCounts.watchProviderCount,
			watchProviderThreshold,
		],
		[
			"watch_provider_per_movie",
			ccCounts.watchProviderPerMovieCount,
			plCounts.watchProviderPerMovieCount,
			watchProviderThreshold,
		],
	];

	return countPairs.reduce<CountDrop[]>(
		(drops, [column, ccCount, plCount, columnThreshold]) => {
			if (ccCount <= 0 || plCount >= ccCount) {
				return drops;
			}

			const dropPercent = ((ccCount - plCount) / ccCount) * 100;

			if (dropPercent > columnThreshold) {
				drops.push({
					column,
					ccCount,
					plCount,
					dropPercent,
					threshold: columnThreshold,
				});
			}

			return drops;
		},
		[],
	);
}

function formatJobStoppedReason(drops: CountDrop[]) {
	return drops
		.map(
			(drop) =>
				`${drop.column} dropped ${drop.dropPercent.toFixed(2)}% from ${drop.ccCount} to ${drop.plCount}; threshold ${drop.threshold}%`,
		)
		.join(" | ");
}

async function getLatestLoadThresholdRow(env: Env) {
	return env.DB.prepare(
		`SELECT load_date,
		        threshold,
		        watch_provider_threshold
			 FROM movie_list_load_counts
			 ORDER BY updated_at DESC
			 LIMIT 1`,
	).first<MovieListLoadCountRow>();
}

async function getMovieListCurrentCounts(env: Env): Promise<MovieListLoadCounts> {
	const row = await env.DB.prepare(
		`SELECT
		    COUNT(*) AS count,
		    COUNT(imdb_rating) AS imdbRatingCount,
		    COUNT(imdb_vote_count) AS imdbVoteCount,
		    COUNT(release_date) AS releaseDateCount,
		    COUNT(us_certification) AS certificationCount,
		    COUNT(popularity) AS popularityCount,
		    (SELECT COUNT(*) FROM movie_genres) AS genreCount,
		    (SELECT COUNT(DISTINCT tmdb_id) FROM movie_genres) AS genrePerMovieCount,
		    (SELECT COUNT(*) FROM movie_watch_providers WHERE region = 'US') AS watchProviderCount,
		    (
		      SELECT COUNT(DISTINCT tmdb_id)
		      FROM movie_watch_providers
		      WHERE region = 'US'
		    ) AS watchProviderPerMovieCount
		 FROM movie_list_items`,
	).first<MovieListLoadCounts>();

	return {
		count: row?.count ?? 0,
		imdbRatingCount: row?.imdbRatingCount ?? 0,
		imdbVoteCount: row?.imdbVoteCount ?? 0,
		releaseDateCount: row?.releaseDateCount ?? 0,
		certificationCount: row?.certificationCount ?? 0,
		popularityCount: row?.popularityCount ?? 0,
		genreCount: row?.genreCount ?? 0,
		genrePerMovieCount: row?.genrePerMovieCount ?? 0,
		watchProviderCount: row?.watchProviderCount ?? 0,
		watchProviderPerMovieCount: row?.watchProviderPerMovieCount ?? 0,
	};
}

async function getMovieListPotentialLoadCounts(
	env: Env,
): Promise<MovieListLoadCounts> {
	const row = await env.DB.prepare(
		`WITH movie_list_source AS (
		   SELECT
		     tmdb.tmdb_id,
		     tmdb.title,
		     tmdb.poster_path,
		     tmdb.release_date,
		     tmdb.us_certification,
		     imdb.average_rating AS imdb_rating,
		     imdb.num_votes AS imdb_vote_count,
		     COALESCE(tmdb.popularity, 0) AS popularity
		   FROM tmdb_movies_staging AS tmdb
		   LEFT JOIN imdb_ratings_staging AS imdb
		     ON imdb.imdb_id = tmdb.imdb_id
		   WHERE tmdb.tmdb_enriched_at IS NOT NULL
		     AND tmdb.tmdb_enrichment_error IS NULL
		     AND tmdb.poster_path IS NOT NULL
		     AND tmdb.poster_path <> ''
		 )
		 SELECT
			   COUNT(*) AS count,
			   COUNT(imdb_rating) AS imdbRatingCount,
			   COUNT(imdb_vote_count) AS imdbVoteCount,
			   COUNT(release_date) AS releaseDateCount,
			   COUNT(us_certification) AS certificationCount,
			   COUNT(popularity) AS popularityCount,
			   (SELECT COUNT(*) FROM movie_genres_staging) AS genreCount,
			   (
			     SELECT COUNT(DISTINCT tmdb_id)
			     FROM movie_genres_staging
			   ) AS genrePerMovieCount,
			   (
			     SELECT COUNT(*)
			     FROM movie_watch_providers_staging
			     WHERE region = 'US'
			       AND provider_id IS NOT NULL
			   ) AS watchProviderCount,
			   (
			     SELECT COUNT(DISTINCT tmdb_id)
			     FROM movie_watch_providers_staging
			     WHERE region = 'US'
			       AND provider_id IS NOT NULL
			   ) AS watchProviderPerMovieCount
			 FROM movie_list_source`,
	).first<MovieListLoadCounts>();

	return {
		count: row?.count ?? 0,
		imdbRatingCount: row?.imdbRatingCount ?? 0,
		imdbVoteCount: row?.imdbVoteCount ?? 0,
		releaseDateCount: row?.releaseDateCount ?? 0,
		certificationCount: row?.certificationCount ?? 0,
		popularityCount: row?.popularityCount ?? 0,
		genreCount: row?.genreCount ?? 0,
		genrePerMovieCount: row?.genrePerMovieCount ?? 0,
		watchProviderCount: row?.watchProviderCount ?? 0,
		watchProviderPerMovieCount: row?.watchProviderPerMovieCount ?? 0,
	};
}

export async function recordMovieListCurrentCountSnapshot(
	env: Env,
	trigger: ImportJobTrigger,
) {
	const startedAtMs = Date.now();
	const jobRunId = createImportJobRunId(
		MOVIE_LIST_CURRENT_COUNT_SNAPSHOT_JOB_NAME,
		trigger,
	);
	const loadDate = todayLoadDate();

	await createImportJobRun(env, {
		jobRunId,
		jobName: MOVIE_LIST_CURRENT_COUNT_SNAPSHOT_JOB_NAME,
		trigger,
	});

	try {
		const counts = await getMovieListCurrentCounts(env);

		await env.DB.prepare(
			`INSERT INTO movie_list_load_counts (
			    load_date,
			    cc_count,
				    imdb_rating_cc_count,
				    imdb_vote_cc_count,
				    release_date_cc_count,
				    certification_cc_count,
				    popularity_cc_count,
				    genre_cc_count,
				    genre_per_movie_cc_count,
				    watch_provider_cc_count,
				    watch_provider_per_movie_cc_count,
				    cc_counted_at,
				    threshold,
				    watch_provider_threshold,
				    updated_at
				 )
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
				 ON CONFLICT(load_date) DO UPDATE SET
				    cc_count = excluded.cc_count,
				    imdb_rating_cc_count = excluded.imdb_rating_cc_count,
				    imdb_vote_cc_count = excluded.imdb_vote_cc_count,
				    release_date_cc_count = excluded.release_date_cc_count,
				    certification_cc_count = excluded.certification_cc_count,
				    popularity_cc_count = excluded.popularity_cc_count,
				    genre_cc_count = excluded.genre_cc_count,
				    genre_per_movie_cc_count = excluded.genre_per_movie_cc_count,
				    watch_provider_cc_count = excluded.watch_provider_cc_count,
				    watch_provider_per_movie_cc_count = excluded.watch_provider_per_movie_cc_count,
				    cc_counted_at = CURRENT_TIMESTAMP,
				    threshold = COALESCE(movie_list_load_counts.threshold, excluded.threshold),
				    watch_provider_threshold = COALESCE(movie_list_load_counts.watch_provider_threshold, excluded.watch_provider_threshold),
				    updated_at = CURRENT_TIMESTAMP`,
			)
				.bind(
					loadDate,
					counts.count,
					counts.imdbRatingCount,
					counts.imdbVoteCount,
					counts.releaseDateCount,
					counts.certificationCount,
					counts.popularityCount,
					counts.genreCount,
					counts.genrePerMovieCount,
					counts.watchProviderCount,
					counts.watchProviderPerMovieCount,
					MOVIE_LIST_LOAD_DEFAULT_THRESHOLD,
					MOVIE_LIST_LOAD_DEFAULT_WATCH_PROVIDER_THRESHOLD,
				)
				.run();

		const result = {
			jobRunId,
			loadDate,
			counts,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected: counts.count,
			processed: counts.count,
			updated: counts.count,
			result,
		});

		return result;
	} catch (error) {
		const lastError =
			error instanceof Error
				? error.message
				: "Movie list current-count snapshot failed.";

		const result = {
			jobRunId,
			loadDate,
			status: "cancelled",
			reason: "movie_list_current_count_snapshot_error",
			error: lastError,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			errors: 1,
			result,
			lastError,
		});

		logEvent("movie-list-current-count-snapshot-cancelled", result);

		throw error;
	}
}

export async function checkMovieListPotentialLoadCounts(
	env: Env,
	trigger: ImportJobTrigger,
) {
	const startedAtMs = Date.now();
	const jobRunId = createImportJobRunId(
		MOVIE_LIST_POTENTIAL_LOAD_CHECK_JOB_NAME,
		trigger,
	);
	const loadDate = todayLoadDate();

	await createImportJobRun(env, {
		jobRunId,
		jobName: MOVIE_LIST_POTENTIAL_LOAD_CHECK_JOB_NAME,
		trigger,
	});

	try {
		const thresholdRow = await getLatestLoadThresholdRow(env);
		const threshold =
			thresholdRow?.threshold ?? MOVIE_LIST_LOAD_DEFAULT_THRESHOLD;
		const watchProviderThreshold =
			thresholdRow?.watch_provider_threshold ??
			MOVIE_LIST_LOAD_DEFAULT_WATCH_PROVIDER_THRESHOLD;
		const ccCounts = await getMovieListCurrentCounts(env);
		const plCounts = await getMovieListPotentialLoadCounts(env);
		const drops = getCountDrops(
			ccCounts,
			plCounts,
			threshold,
			watchProviderThreshold,
		);
		const jobStoppedReason =
			drops.length > 0 ? formatJobStoppedReason(drops) : null;

		await env.DB.prepare(
			`INSERT INTO movie_list_load_counts (
			    load_date,
			    cc_count,
			    imdb_rating_cc_count,
			    imdb_vote_cc_count,
			    release_date_cc_count,
			    certification_cc_count,
			    popularity_cc_count,
			    genre_cc_count,
			    genre_per_movie_cc_count,
			    watch_provider_cc_count,
			    watch_provider_per_movie_cc_count,
			    cc_counted_at,
			    pl_count,
			    imdb_rating_pl_count,
			    imdb_vote_pl_count,
			    release_date_pl_count,
			    certification_pl_count,
			    popularity_pl_count,
			    genre_pl_count,
			    genre_per_movie_pl_count,
			    watch_provider_pl_count,
			    watch_provider_per_movie_pl_count,
			    pl_counted_at,
			    threshold,
			    watch_provider_threshold,
			    job_stopped_reason,
			    updated_at
				 )
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)
				 ON CONFLICT(load_date) DO UPDATE SET
				    cc_count = excluded.cc_count,
				    imdb_rating_cc_count = excluded.imdb_rating_cc_count,
				    imdb_vote_cc_count = excluded.imdb_vote_cc_count,
				    release_date_cc_count = excluded.release_date_cc_count,
				    certification_cc_count = excluded.certification_cc_count,
				    popularity_cc_count = excluded.popularity_cc_count,
				    genre_cc_count = excluded.genre_cc_count,
				    genre_per_movie_cc_count = excluded.genre_per_movie_cc_count,
				    watch_provider_cc_count = excluded.watch_provider_cc_count,
				    watch_provider_per_movie_cc_count = excluded.watch_provider_per_movie_cc_count,
				    cc_counted_at = CURRENT_TIMESTAMP,
				    pl_count = excluded.pl_count,
				    imdb_rating_pl_count = excluded.imdb_rating_pl_count,
				    imdb_vote_pl_count = excluded.imdb_vote_pl_count,
				    release_date_pl_count = excluded.release_date_pl_count,
				    certification_pl_count = excluded.certification_pl_count,
				    popularity_pl_count = excluded.popularity_pl_count,
				    genre_pl_count = excluded.genre_pl_count,
				    genre_per_movie_pl_count = excluded.genre_per_movie_pl_count,
				    watch_provider_pl_count = excluded.watch_provider_pl_count,
				    watch_provider_per_movie_pl_count = excluded.watch_provider_per_movie_pl_count,
				    pl_counted_at = CURRENT_TIMESTAMP,
				    threshold = excluded.threshold,
				    watch_provider_threshold = excluded.watch_provider_threshold,
				    job_stopped_reason = excluded.job_stopped_reason,
				    updated_at = CURRENT_TIMESTAMP`,
			)
				.bind(
					loadDate,
					ccCounts.count,
					ccCounts.imdbRatingCount,
					ccCounts.imdbVoteCount,
					ccCounts.releaseDateCount,
					ccCounts.certificationCount,
					ccCounts.popularityCount,
					ccCounts.genreCount,
					ccCounts.genrePerMovieCount,
					ccCounts.watchProviderCount,
					ccCounts.watchProviderPerMovieCount,
					plCounts.count,
					plCounts.imdbRatingCount,
					plCounts.imdbVoteCount,
					plCounts.releaseDateCount,
					plCounts.certificationCount,
					plCounts.popularityCount,
					plCounts.genreCount,
					plCounts.genrePerMovieCount,
					plCounts.watchProviderCount,
					plCounts.watchProviderPerMovieCount,
					threshold,
					watchProviderThreshold,
					jobStoppedReason,
				)
				.run();

		const result = {
			jobRunId,
			loadDate,
			thresholdSourceLoadDate: thresholdRow?.load_date ?? null,
			threshold,
			watchProviderThreshold,
			ccCounts,
			plCounts,
			drops,
			jobStoppedReason,
			shouldStopMovieListBuild: drops.length > 0,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: drops.length > 0 ? "complete_with_errors" : "complete",
			selected: plCounts.count,
			processed: plCounts.count,
			updated: plCounts.count,
			result,
			lastError: jobStoppedReason,
		});

		return result;
	} catch (error) {
		const lastError =
			error instanceof Error
				? error.message
				: "Movie list potential-load check failed.";

		const result = {
			jobRunId,
			loadDate,
			status: "cancelled",
			reason: "movie_list_potential_load_check_error",
			error: lastError,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			errors: 1,
			result,
			lastError,
		});

		logEvent("movie-list-potential-load-check-cancelled", result);

		throw error;
	}
}
