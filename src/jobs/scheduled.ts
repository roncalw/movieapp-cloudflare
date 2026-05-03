import { enqueueImdbRatingRows } from "../imports/imdbRatings";
import { rebuildMovieListItems } from "../imports/movieListBuild";
import {
	enqueueTmdbEnrichmentJob,
	TMDB_ENRICH_TMDB_CONCURRENCY,
} from "../imports/tmdbEnrichment";
import {
	getTmdbRefreshStartDate,
	loadTmdbPrimaryRowsManual,
} from "../imports/tmdbPrimary";
import type { Env } from "../shared/types";

const TMDB_PRIMARY_CRON_LIMIT = 100000;
const TMDB_ENRICHMENT_CRON_LIMIT = 300000;
const SCHEDULED_IMDB_CRON = "0 22 * * 1";
const SCHEDULED_TMDB_PRIMARY_CRON = "0 4 * * 2";
const SCHEDULED_TMDB_ENRICHMENT_CRON = "0 10 * * 2";
const SCHEDULED_MOVIE_LIST_BUILD_CRON = "0 1 * * 3";

type JobPauseFlagName =
	| "IMDB_JOB_PAUSED"
	| "TMDB_PRIMARY_JOB_PAUSED"
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

	console.log(
		JSON.stringify({
			event: "scheduled-cron-paused",
			jobName,
			cron: controller.cron,
			pausedBy,
		}),
	);

	return true;
}

function todayIsoDate() {
	return new Date(Date.now()).toISOString().slice(0, 10);
}

async function runScheduledImdbRatingsRefresh(env: Env) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();

	console.log(
		JSON.stringify({
			event: "imdb-ratings-cron-start",
			startedAt,
		}),
	);

	const result = await enqueueImdbRatingRows(env);
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	console.log(
		JSON.stringify({
			event: "imdb-ratings-cron-end",
			...result,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		}),
	);

	return {
		...result,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
	};
}

async function runScheduledTmdbPrimaryRefresh(env: Env) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const beginDate = await getTmdbRefreshStartDate(env);
	const endDate = todayIsoDate();

	if (beginDate > endDate) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			skipped: true,
			skipReason: "begin_date_after_end_date",
			beginDate,
			endDate,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		console.log(
			JSON.stringify({
				event: "tmdb-primary-cron-skipped",
				...result,
			}),
		);

		return result;
	}

	console.log(
		JSON.stringify({
			event: "tmdb-primary-cron-start",
			startedAt,
			beginDate,
			endDate,
			limit: TMDB_PRIMARY_CRON_LIMIT,
		}),
	);

	const result = await loadTmdbPrimaryRowsManual(
		env,
		beginDate,
		endDate,
		TMDB_PRIMARY_CRON_LIMIT,
	);
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	console.log(
		JSON.stringify({
			event: "tmdb-primary-cron-end",
			...result,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		}),
	);

	return {
		...result,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
	};
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

		ctx.waitUntil(runScheduledImdbRatingsRefresh(env));
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

		ctx.waitUntil(runScheduledTmdbPrimaryRefresh(env));
		return;
	}

	if (controller.cron === SCHEDULED_TMDB_ENRICHMENT_CRON) {
		if (
			skipPausedScheduledJob(
				env,
				controller,
				"tmdb-enrichment",
				"TMDB_ENRICH_JOB_PAUSED",
			)
		) {
			return;
		}

		ctx.waitUntil(
			enqueueTmdbEnrichmentJob(env, {
				limit: TMDB_ENRICHMENT_CRON_LIMIT,
				refreshOlderThanDays: 7,
				progressEvery: 5000,
				tmdbConcurrency: TMDB_ENRICH_TMDB_CONCURRENCY,
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

		ctx.waitUntil(rebuildMovieListItems(env, "cron"));
		return;
	}

	console.log(
		JSON.stringify({
			event: "scheduled-cron-unhandled",
			cron: controller.cron,
		}),
	);
}
