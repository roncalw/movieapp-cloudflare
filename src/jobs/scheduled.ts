import { enqueueCacheWarmSearchJob } from "../cache/cacheWarmJob";
import { CACHE_WARM_SEARCH_JOB_NAME } from "../cache/cacheWarmTypes";
import { enqueueImdbRatingRows } from "../imports/imdbRatings";
import { rebuildMovieListItems } from "../imports/movieListBuild";
import { enqueueTmdbNewMovieDetailsJob } from "../imports/tmdbNewMovieDetails";
import { enqueueTmdbProviderRefreshJob } from "../imports/tmdbProviderRefresh";
import { enqueueTmdbPopularityRefresh } from "../imports/tmdbPopularity";
import { loadNewTmdbPrimaryRows } from "../imports/tmdbPrimary";
import {
	checkImportJobDependencies,
	finishSkippedDependencyRun,
} from "./importJobDependencies";
import {
	createImportJobRunId,
	MOVIE_LIST_BUILD_JOB_NAME,
} from "./importJobRuns";
import {
	SCHEDULED_CACHE_WARM_ALL_GENRES_CRON,
	SCHEDULED_IMDB_CRON,
	SCHEDULED_MOVIE_LIST_BUILD_CRON,
	SCHEDULED_TMDB_ENRICHMENT_CRON,
	SCHEDULED_TMDB_NEW_MOVIE_DETAILS_CRON,
	SCHEDULED_TMDB_POPULARITY_CRON,
	SCHEDULED_TMDB_PRIMARY_CRON,
	SCHEDULED_WEEKLY_IMPORT_VALIDATION_CRON,
} from "./scheduledCronConfig";
import { validateWeeklyImportPipeline } from "./weeklyImportValidation";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";

type JobPauseFlagName =
	| "CACHE_WARM_JOB_PAUSED"
	| "IMDB_JOB_PAUSED"
	| "TMDB_PRIMARY_JOB_PAUSED"
	| "TMDB_NEW_MOVIE_DETAILS_JOB_PAUSED"
	| "TMDB_POPULARITY_JOB_PAUSED"
	| "TMDB_ENRICH_JOB_PAUSED"
	| "MOVIE_LIST_JOB_PAUSED"
	| "PIPELINE_VALIDATION_JOB_PAUSED";

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

async function runScheduledTmdbPopularityRefresh(
	env: Env,
	scheduledTime: number,
) {
	return enqueueTmdbPopularityRefresh(env, {
		trigger: "cron",
		nowMs: scheduledTime,
	});
}

async function runScheduledMovieListBuild(env: Env, scheduledTime: number) {
	return rebuildMovieListItems(env, "cron", {
		dependencyRunDate: new Date(scheduledTime).toISOString().slice(0, 10),
	});
}

async function runScheduledCacheWarmAllGenres(
	env: Env,
	scheduledTime: number,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const pipelineRunDate = new Date(scheduledTime).toISOString().slice(0, 10);
	const requiredMovieListEndedAfter = new Date(
		scheduledTime - 6 * 60 * 60 * 1000,
	)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
	const dependencies = await checkImportJobDependencies(
		env,
		[
			{
				jobName: MOVIE_LIST_BUILD_JOB_NAME,
				endedAfter: requiredMovieListEndedAfter,
				endedAfterLabel: "cache-warm freshness window",
			},
		],
		pipelineRunDate,
	);

	if (!dependencies.ok) {
		return finishSkippedDependencyRun(env, {
			jobRunId: createImportJobRunId(CACHE_WARM_SEARCH_JOB_NAME, "cron"),
			jobName: CACHE_WARM_SEARCH_JOB_NAME,
			trigger: "cron",
			startedAtMs,
			startedAt,
			blockers: dependencies.blockers,
			extraResult: {
				reason: "movie_list_build_not_ready",
				pipelineRunDate,
				requiredMovieListEndedAfter,
			},
		});
	}

	return enqueueCacheWarmSearchJob(env, {
		trigger: "cron",
	});
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

	if (controller.cron === SCHEDULED_TMDB_POPULARITY_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"tmdb-popularity-refresh",
				"TMDB_POPULARITY_JOB_PAUSED",
			)
		) {
			return;
		}

		waitUntilLogged(
			ctx,
			"tmdb-popularity-refresh",
			controller.cron,
			runScheduledTmdbPopularityRefresh(env, controller.scheduledTime),
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
			runScheduledMovieListBuild(env, controller.scheduledTime),
		);
		return;
	}

	if (controller.cron === SCHEDULED_CACHE_WARM_ALL_GENRES_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"cache-warm-search",
				"CACHE_WARM_JOB_PAUSED",
			)
		) {
			return;
		}

		waitUntilLogged(
			ctx,
			"cache-warm-search",
			controller.cron,
			runScheduledCacheWarmAllGenres(env, controller.scheduledTime),
		);
		return;
	}

	if (controller.cron === SCHEDULED_WEEKLY_IMPORT_VALIDATION_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"weekly-import-validation",
				"PIPELINE_VALIDATION_JOB_PAUSED",
			)
		) {
			return;
		}

		waitUntilLogged(
			ctx,
			"weekly-import-validation",
			controller.cron,
			validateWeeklyImportPipeline(env, "cron", {
				runDate: new Date(controller.scheduledTime).toISOString().slice(0, 10),
			}),
		);
		return;
	}

	logEvent("scheduled-cron-unhandled", {
		cron: controller.cron,
	});
}
