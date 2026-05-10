import { enqueueImdbRatingRows } from "../imports/imdbRatings";
import { rebuildMovieListItems } from "../imports/movieListBuild";
import { enqueueTmdbNewMovieDetailsJob } from "../imports/tmdbNewMovieDetails";
import { enqueueTmdbProviderRefreshJob } from "../imports/tmdbProviderRefresh";
import { loadNewTmdbPrimaryRows } from "../imports/tmdbPrimary";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";

const SCHEDULED_IMDB_CRON = "0 22 * * 1";
const SCHEDULED_TMDB_PRIMARY_CRON = "0 4 * * 2";
const SCHEDULED_TMDB_NEW_MOVIE_DETAILS_CRON = "0 6 * * 2";
const SCHEDULED_TMDB_ENRICHMENT_CRON = "0 10 * * 2";
const SCHEDULED_MOVIE_LIST_BUILD_CRON = "0 1 * * 3";

type JobPauseFlagName =
	| "IMDB_JOB_PAUSED"
	| "TMDB_PRIMARY_JOB_PAUSED"
	| "TMDB_NEW_MOVIE_DETAILS_JOB_PAUSED"
	| "TMDB_ENRICH_JOB_PAUSED"
	| "MOVIE_LIST_JOB_PAUSED";

function isPauseFlagEnabled(value: string | undefined) {
	return value?.toLowerCase() === "true";
}

function getPausedBy(env: Env, jobPauseFlagName: JobPauseFlagName) {
	if (isPauseFlagEnabled(env.ALL_JOBS_PAUSED)) {
		return "ALL_JOBS_PAUSED";
	}

	if (isPauseFlagEnabled(env[jobPauseFlagName])) {
		return jobPauseFlagName;
	}

	return null;
}

function skipPausedScheduledJob(
	env: Env,
	controller: ScheduledController,
	jobName: string,
	jobPauseFlagName: JobPauseFlagName,
) {
	const pausedBy = getPausedBy(env, jobPauseFlagName);

	if (!pausedBy) {
		return false;
	}

	logEvent("scheduled-cron-paused", {
		jobName,
		cron: controller.cron,
		pausedBy,
	});

	return true;
}

async function runScheduledImdbRatingsRefresh(env: Env) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();

	logEvent("imdb-ratings-cron-start", {
		startedAt,
	});

	const result = await enqueueImdbRatingRows(env, undefined, "cron");
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	logEvent("imdb-ratings-cron-end", {
		...result,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
	});

	return {
		...result,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
	};
}

async function runScheduledTmdbPrimaryRefresh(env: Env) {
	return loadNewTmdbPrimaryRows(env, "cron");
}

function waitUntilLogged(
	ctx: ExecutionContext,
	jobName: string,
	cron: string,
	promise: Promise<unknown>,
) {
	ctx.waitUntil(
		promise.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);

			logEvent("scheduled-job-cancelled", {
				jobName,
				cron,
				error: message,
			});

			throw error;
		}),
	);
}

export function handleScheduled(
	controller: ScheduledController,
	env: Env,
	ctx: ExecutionContext,
) {
	if (controller.cron === SCHEDULED_IMDB_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"imdb-ratings",
				"IMDB_JOB_PAUSED",
			)
		) {
			return;
		}

		waitUntilLogged(
			ctx,
			"imdb-ratings",
			controller.cron,
			runScheduledImdbRatingsRefresh(env),
		);
		return;
	}

	if (controller.cron === SCHEDULED_TMDB_PRIMARY_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"tmdb-primary",
				"TMDB_PRIMARY_JOB_PAUSED",
			)
		) {
			return;
		}

		waitUntilLogged(
			ctx,
			"tmdb-primary",
			controller.cron,
			runScheduledTmdbPrimaryRefresh(env),
		);
		return;
	}

	if (controller.cron === SCHEDULED_TMDB_NEW_MOVIE_DETAILS_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"tmdb-new-movie-details",
				"TMDB_NEW_MOVIE_DETAILS_JOB_PAUSED",
			)
		) {
			return;
		}

		waitUntilLogged(
			ctx,
			"tmdb-new-movie-details",
			controller.cron,
			enqueueTmdbNewMovieDetailsJob(env, {
				useLock: true,
				trigger: "cron",
			}),
		);
		return;
	}

	if (controller.cron === SCHEDULED_TMDB_ENRICHMENT_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"tmdb-provider-refresh",
				"TMDB_ENRICH_JOB_PAUSED",
			)
		) {
			return;
		}

		waitUntilLogged(
			ctx,
			"tmdb-provider-refresh",
			controller.cron,
			enqueueTmdbProviderRefreshJob(env, {
				useLock: true,
				trigger: "cron",
			}),
		);
		return;
	}

	if (controller.cron === SCHEDULED_MOVIE_LIST_BUILD_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"movie-list",
				"MOVIE_LIST_JOB_PAUSED",
			)
		) {
			return;
		}

		waitUntilLogged(
			ctx,
			"movie-list-build",
			controller.cron,
			rebuildMovieListItems(env, "cron"),
		);
		return;
	}

	logEvent("scheduled-cron-unhandled", {
		cron: controller.cron,
	});
}
