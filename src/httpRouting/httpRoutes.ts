import {
	dryRunReadImdbRatings,
	enqueueImdbRatingRows,
} from "../imports/imdbRatings";
import { enqueueCacheWarmSearchJob } from "../cache/cacheWarmJob";
import {
	checkMovieListPotentialLoadCounts,
	recordMovieListCurrentCountSnapshot,
} from "../imports/movieListLoadCounts";
import {
	getRecentImportJobRuns,
	getRecentTmdbEnrichmentImportJobRuns,
	IMDB_RATINGS_JOB_NAME,
	MOVIE_LIST_BUILD_JOB_NAME,
	MOVIE_LIST_CURRENT_COUNT_SNAPSHOT_JOB_NAME,
	MOVIE_LIST_POTENTIAL_LOAD_CHECK_JOB_NAME,
	TMDB_ENRICH_JOB_NAME,
	TMDB_GENRE_LOOKUP_REFRESH_JOB_NAME,
	TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	TMDB_PRIMARY_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	TMDB_WATCH_PROVIDER_LOOKUP_REFRESH_JOB_NAME,
} from "../jobs/importJobRuns";
import {
	getCachedMovieSearchResponse,
	RequestValidationError,
} from "./movieSearch";
import { rebuildMovieListItems } from "../imports/movieListBuild";
import {
	enqueueTmdbEnrichmentJob,
	TMDB_ENRICH_TMDB_CONCURRENCY,
} from "../imports/tmdbEnrichment";
import { enqueueTmdbNewMovieDetailsJob } from "../imports/tmdbNewMovieDetails";
import { enqueueTmdbProviderRefreshJob } from "../imports/tmdbProviderRefresh";
import {
	isIsoDate,
	loadNewTmdbPrimaryRows,
	loadTmdbPrimaryRowsManual,
	TMDB_PRIMARY_STANDARD_LIMIT,
} from "../imports/tmdbPrimary";
import {
	refreshTmdbGenreLookup,
	refreshTmdbWatchProviderLookup,
} from "../imports/tmdbLookupRefresh";
import { sendJobNotificationTestEmail } from "../notifications/jobNotifications";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";

type MovieRow = {
	id: number;
	MovieName: string;
	IMDBRating: string | null;
	IMDBVoteCounts: string | null;
};

function jsonResponse(body: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(body, null, 2), {
		...init,
		headers: {
			"content-type": "application/json; charset=UTF-8",
			...init?.headers,
		},
	});
}

const MANUAL_MUTATION_PATHS = new Set([
	"/admin/import/imdb-ratings/enqueue-manual",
	"/admin/import/tmdb/new-primary-manual",
	"/admin/import/tmdb/limited-primary-manual",
	"/admin/import/tmdb/enrich-all-manual",
	"/admin/import/tmdb/new-movie-details-manual",
	"/admin/import/tmdb/provider-refresh-manual",
	"/admin/import/tmdb/genre-lookup-refresh-manual",
	"/admin/import/tmdb/watch-provider-lookup-refresh-manual",
	"/admin/cache/search/warm-manual",
	"/admin/import/movie-list/rebuild-manual",
	"/admin/import/movie-list/potential-load-check",
	"/admin/import/movie-list/current-count-snapshot",
	"/admin/notifications/email-test-manual",
]);

const ACCESS_NOT_PERMITTED_BODY = {
	error: "Access not permitted",
};

function validateManualMutationAccess(
	request: Request,
	env: Env,
	url: URL,
) {
	if (!MANUAL_MUTATION_PATHS.has(url.pathname)) {
		return null;
	}

	if (request.method !== "POST") {
		logEvent("admin-manual-endpoint-method-rejected", {
			path: url.pathname,
			method: request.method,
			requiredMethod: "POST",
			userAgent: request.headers.get("user-agent"),
			cfConnectingIp: request.headers.get("cf-connecting-ip"),
		});

		return jsonResponse(
			ACCESS_NOT_PERMITTED_BODY,
			{ status: 405, headers: { allow: "POST" } },
		);
	}

	if (!env.ADMIN_IMPORT_TOKEN) {
		logEvent("admin-manual-endpoint-token-missing", {
			path: url.pathname,
		});

		return jsonResponse(
			ACCESS_NOT_PERMITTED_BODY,
			{ status: 500 },
		);
	}

	const authorization = request.headers.get("authorization") ?? "";
	const expectedAuthorization = `Bearer ${env.ADMIN_IMPORT_TOKEN}`;

	if (authorization !== expectedAuthorization) {
		logEvent("admin-manual-endpoint-unauthorized", {
			path: url.pathname,
			method: request.method,
			hasAuthorization: authorization.length > 0,
			userAgent: request.headers.get("user-agent"),
			cfConnectingIp: request.headers.get("cf-connecting-ip"),
		});

		return jsonResponse(
			ACCESS_NOT_PERMITTED_BODY,
			{ status: 401, headers: { "www-authenticate": "Bearer" } },
		);
	}

	return null;
}

function jobErrorResponse(
	error: unknown,
	jobName: string,
	monitorEndpoint: string,
) {
	const message = error instanceof Error ? error.message : String(error);

	logEvent("manual-endpoint-cancelled", {
		jobName,
		monitorEndpoint,
		error: message,
	});

	return jsonResponse(
		{
			error: message,
			jobName,
			monitorEndpoint,
		},
		{ status: 500 },
	);
}

export async function handleFetch(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
) {
	const url = new URL(request.url);

	const manualMutationAccessError = validateManualMutationAccess(
		request,
		env,
		url,
	);

	if (manualMutationAccessError) {
		return manualMutationAccessError;
	}

	if (!MANUAL_MUTATION_PATHS.has(url.pathname) && request.method !== "GET") {
		return jsonResponse(
			{ error: "Only GET requests are supported." },
			{ status: 405, headers: { allow: "GET" } },
		);
	}

	if (url.pathname === "/movies/search") {
		try {
			return await getCachedMovieSearchResponse(request, env, url, ctx);
		} catch (error) {
			if (error instanceof RequestValidationError) {
				return Response.json({ error: error.message }, { status: 400 });
			}

			return Response.json({ error: "Movie search failed." }, { status: 500 });
		}
	}

	if (url.pathname === "/admin/import/imdb-ratings/dry-run") {
		const limit = Number(url.searchParams.get("limit") ?? 10000);
		const result = await dryRunReadImdbRatings(limit);
		return Response.json(result);
	}

	if (url.pathname === "/admin/import/imdb-ratings/enqueue-manual") {
		const rawLimit = url.searchParams.get("limit");
		const limit = rawLimit === null ? undefined : Number(rawLimit);
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			return Response.json(
				{ error: "limit must be a positive integer." },
				{ status: 400 },
			);
		}
		try {
			const result = await enqueueImdbRatingRows(env, limit);
			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				IMDB_RATINGS_JOB_NAME,
				"/admin/import/job-runs?jobName=imdb-ratings&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/tmdb/new-primary-manual") {
		if (url.search !== "") {
			return Response.json(
				{
					error:
						"new-primary-manual does not accept beginDate, endDate, or limit. Use limited-primary-manual for explicit ranges.",
				},
				{ status: 400 },
			);
		}

		try {
			const result = await loadNewTmdbPrimaryRows(env, "manual");
			const status =
				"skipped" in result &&
				result.skipped &&
				result.skipReason === "begin_date_older_than_28_days"
					? 409
					: 200;

			return Response.json(result, {
				status,
			});
		} catch (error) {
			return jobErrorResponse(
				error,
				TMDB_PRIMARY_JOB_NAME,
				"/admin/import/job-runs?jobName=tmdb-primary&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/tmdb/limited-primary-manual") {
		const startedAtMs = Date.now();
		const startedAt = new Date(startedAtMs).toISOString();
		const rawLimit = url.searchParams.get("limit");
		const limit = Number(rawLimit);
		const beginDate = url.searchParams.get("beginDate");
		const endDate = url.searchParams.get("endDate");

		if (!rawLimit) {
			return Response.json(
				{ error: "limit is required and must be a positive integer." },
				{ status: 400 },
			);
		}

		if (!Number.isInteger(limit) || limit < 1) {
			return Response.json(
				{ error: "limit must be a positive integer." },
				{ status: 400 },
			);
		}

		if (limit > TMDB_PRIMARY_STANDARD_LIMIT) {
			return Response.json(
				{
					error: `limit must be less than or equal to ${TMDB_PRIMARY_STANDARD_LIMIT}.`,
					limit,
				},
				{ status: 400 },
			);
		}

		if (!beginDate || !isIsoDate(beginDate)) {
			return Response.json(
				{
					error: "beginDate is required and must use YYYY-MM-DD format.",
					beginDate,
				},
				{ status: 400 },
			);
		}

		if (!endDate || !isIsoDate(endDate)) {
			return Response.json(
				{
					error: "endDate is required and must use YYYY-MM-DD format.",
					endDate,
				},
				{ status: 400 },
			);
		}

		if (beginDate > endDate) {
			return Response.json(
				{
					error: "beginDate must be less than or equal to endDate.",
					beginDate,
					endDate,
				},
				{ status: 400 },
			);
		}

		logEvent("tmdb-limited-primary-manual-start", {
			startedAt,
			limit,
			beginDate,
			endDate,
		});

		try {
			const result = await loadTmdbPrimaryRowsManual(
				env,
				beginDate,
				endDate,
				limit,
			);

			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const durationMs = endedAtMs - startedAtMs;
			const responseBody = {
				...result,
				startedAt,
				endedAt,
				durationMs,
			};

			logEvent("tmdb-limited-primary-manual-end", {
				startedAt,
				endedAt,
				durationMs,
				limit,
				beginDate,
				endDate,
				pagesRead: result.pagesRead,
				rowsSeen: result.rowsSeen,
				rowsInserted: result.rowsInserted,
				totalPagesSeen: result.totalPagesSeen,
				tmdbDiscoverMaxPage: result.tmdbDiscoverMaxPage,
				windowsLoaded: result.windowsLoaded,
				windowsSplit: result.windowsSplit,
				pendingWindows: result.pendingWindows,
				stoppedWindow: result.stoppedWindow,
				stopReason: result.stopReason,
			});

			return Response.json(responseBody);
		} catch (error) {
			return jobErrorResponse(
				error,
				TMDB_PRIMARY_JOB_NAME,
				"/admin/import/job-runs?jobName=tmdb-primary&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/tmdb/enrich-progress") {
		const runs = await getRecentTmdbEnrichmentImportJobRuns(env);
		return Response.json({ runs });
	}

	if (url.pathname === "/admin/import/job-runs") {
		const jobName = url.searchParams.get("jobName") ?? undefined;
		const limit = Number(url.searchParams.get("limit") ?? 20);

		if (!Number.isInteger(limit) || limit < 1) {
			return Response.json(
				{ error: "limit must be a positive integer." },
				{ status: 400 },
			);
		}

		const runs = await getRecentImportJobRuns(env, { jobName, limit });
		return Response.json({ runs });
	}

	if (url.pathname === "/admin/notifications/email-test-manual") {
		if (url.search !== "") {
			return Response.json(
				{
					error:
						"email-test-manual does not accept query parameters. It sends one test email through the configured Dynu SMTP settings.",
				},
				{ status: 400 },
			);
		}

		try {
			const result = await sendJobNotificationTestEmail(env);

			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				"job-notification-email-test",
				"/admin/notifications/email-test-manual",
			);
		}
	}

	if (url.pathname === "/admin/cache/search/warm-manual") {
		const allowedParams = new Set(["genre", "genreId"]);
		for (const key of url.searchParams.keys()) {
			if (!allowedParams.has(key)) {
				return Response.json(
					{
						error:
							"warm-manual only accepts optional genre or genreId query parameters.",
					},
					{ status: 400 },
				);
			}
		}

		const genreKey = url.searchParams.get("genre") ?? undefined;
		const rawGenreId = url.searchParams.get("genreId");

		if (genreKey && rawGenreId) {
			return Response.json(
				{ error: "Use either genre or genreId, not both." },
				{ status: 400 },
			);
		}

		let genreId: number | undefined;
		if (rawGenreId !== null) {
			const parsedGenreId = Number(rawGenreId);
			if (!Number.isInteger(parsedGenreId) || parsedGenreId < 1) {
				return Response.json(
					{ error: "genreId must be a positive integer." },
					{ status: 400 },
				);
			}

			genreId = parsedGenreId;
		}

		try {
			const result = await enqueueCacheWarmSearchJob(env, {
				trigger: "manual",
				genreKey,
				genreId,
			});

			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				"cache-warm-search",
				"/admin/import/job-runs?jobName=cache-warm-search&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/tmdb/enrich-all-manual") {
		const limit = Number(url.searchParams.get("limit") ?? 1000);
		const refreshOlderThanDays = Number(
			url.searchParams.get("refreshOlderThanDays") ?? 7,
		);

		if (!Number.isInteger(limit) || limit < 1) {
			return Response.json(
				{ error: "limit must be a positive integer." },
				{ status: 400 },
			);
		}

		if (!Number.isInteger(refreshOlderThanDays) || refreshOlderThanDays < 1) {
			return Response.json(
				{ error: "refreshOlderThanDays must be a positive integer." },
				{ status: 400 },
			);
		}

		try {
			const result = await enqueueTmdbEnrichmentJob(env, {
				limit,
				refreshOlderThanDays,
				progressEvery: 5000,
				tmdbConcurrency: TMDB_ENRICH_TMDB_CONCURRENCY,
				useLock: true,
				trigger: "manual",
			});

			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				TMDB_ENRICH_JOB_NAME,
				"/admin/import/job-runs?jobName=tmdb-enrich&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/tmdb/new-movie-details-manual") {
		if (url.search !== "") {
			return Response.json(
				{
					error:
						"new-movie-details-manual does not accept query parameters. It enriches the movies from the latest successful TMDB primary run that still need details.",
				},
				{ status: 400 },
			);
		}

		try {
			const result = await enqueueTmdbNewMovieDetailsJob(env, {
				useLock: true,
				trigger: "manual",
			});

			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
				"/admin/import/job-runs?jobName=tmdb-new-movie-details&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/tmdb/provider-refresh-manual") {
		if (url.search !== "") {
			return Response.json(
				{
					error:
						"provider-refresh-manual does not accept query parameters. It always refreshes the current US flatrate provider set.",
				},
				{ status: 400 },
			);
		}

		try {
			const result = await enqueueTmdbProviderRefreshJob(env, {
				useLock: true,
				trigger: "manual",
			});

			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				TMDB_PROVIDER_REFRESH_JOB_NAME,
				"/admin/import/job-runs?jobName=tmdb-provider-refresh&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/tmdb/genre-lookup-refresh-manual") {
		if (url.search !== "") {
			return Response.json(
				{
					error:
						"genre-lookup-refresh-manual does not accept query parameters. It refreshes the en-US TMDB movie genre lookup table.",
				},
				{ status: 400 },
			);
		}

		try {
			const result = await refreshTmdbGenreLookup(env, "manual");

			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				TMDB_GENRE_LOOKUP_REFRESH_JOB_NAME,
				"/admin/import/job-runs?jobName=tmdb-genre-lookup-refresh&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/tmdb/watch-provider-lookup-refresh-manual") {
		if (url.search !== "") {
			return Response.json(
				{
					error:
						"watch-provider-lookup-refresh-manual does not accept query parameters. It refreshes the US TMDB watch-provider lookup table.",
				},
				{ status: 400 },
			);
		}

		try {
			const result = await refreshTmdbWatchProviderLookup(env, "manual");

			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				TMDB_WATCH_PROVIDER_LOOKUP_REFRESH_JOB_NAME,
				"/admin/import/job-runs?jobName=tmdb-watch-provider-lookup-refresh&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/movie-list/rebuild-manual") {
		try {
			const result = await rebuildMovieListItems(env, "manual");
			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				MOVIE_LIST_BUILD_JOB_NAME,
				"/admin/import/job-runs?jobName=movie-list-build&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/movie-list/potential-load-check") {
		try {
			const result = await checkMovieListPotentialLoadCounts(env, "manual");
			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				MOVIE_LIST_POTENTIAL_LOAD_CHECK_JOB_NAME,
				"/admin/import/job-runs?jobName=movie-list-potential-load-check&limit=1",
			);
		}
	}

	if (url.pathname === "/admin/import/movie-list/current-count-snapshot") {
		try {
			const result = await recordMovieListCurrentCountSnapshot(env, "manual");
			return Response.json(result);
		} catch (error) {
			return jobErrorResponse(
				error,
				MOVIE_LIST_CURRENT_COUNT_SNAPSHOT_JOB_NAME,
				"/admin/import/job-runs?jobName=movie-list-current-count-snapshot&limit=1",
			);
		}
	}

	if (url.pathname === "/movies") {
		const { results } = await env.DB.prepare(
			"SELECT id, MovieName, IMDBRating, IMDBVoteCounts FROM movies ORDER BY id",
		).all<MovieRow>();

		return jsonResponse({ movies: results });
	}

	return jsonResponse({ error: "Not found." }, { status: 404 });
}
