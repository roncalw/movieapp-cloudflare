import {
	dryRunReadImdbRatings,
	enqueueImdbRatingRows,
} from "../imports/imdbRatings";
import {
	checkMovieListPotentialLoadCounts,
	recordMovieListCurrentCountSnapshot,
} from "../imports/movieListLoadCounts";
import {
	getRecentImportJobRuns,
	getRecentTmdbEnrichmentImportJobRuns,
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
import {
	getTmdbRefreshStartDate,
	isIsoDate,
	loadTmdbPrimaryRowsManual,
} from "../imports/tmdbPrimary";
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

export async function handleFetch(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
) {
	const url = new URL(request.url);

	if (request.method !== "GET") {
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
		const limit = Number(url.searchParams.get("limit") ?? 330);
		const result = await enqueueImdbRatingRows(env, limit);
		return Response.json(result);
	}

	if (url.pathname === "/admin/import/tmdb/load-manual") {
		const startedAtMs = Date.now();
		const startedAt = new Date(startedAtMs).toISOString();
		const limit = Number(url.searchParams.get("limit") ?? 100);
		const beginDate =
			url.searchParams.get("beginDate") ??
			(await getTmdbRefreshStartDate(env));
		const endDate = url.searchParams.get("endDate");

		if (!Number.isInteger(limit) || limit < 1) {
			return Response.json(
				{ error: "limit must be a positive integer." },
				{ status: 400 },
			);
		}

		if (!isIsoDate(beginDate)) {
			return Response.json(
				{ error: "beginDate must use YYYY-MM-DD format.", beginDate },
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

		console.log(
			JSON.stringify({
				event: "tmdb-load-manual-start",
				startedAt,
				limit,
				beginDate,
				endDate,
			}),
		);

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

		console.log(
			JSON.stringify({
				event: "tmdb-load-manual-end",
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
			}),
		);

		return Response.json(responseBody);
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

	if (url.pathname === "/admin/import/tmdb/enrich-manual") {
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

		const result = await enqueueTmdbEnrichmentJob(env, {
			limit,
			refreshOlderThanDays,
			progressEvery: 5000,
			tmdbConcurrency: TMDB_ENRICH_TMDB_CONCURRENCY,
			useLock: true,
			trigger: "manual",
		});

		return Response.json(result);
	}

	if (url.pathname === "/admin/import/movie-list/rebuild-manual") {
		const result = await rebuildMovieListItems(env, "manual");
		return Response.json(result);
	}

	if (url.pathname === "/admin/import/movie-list/potential-load-check") {
		const result = await checkMovieListPotentialLoadCounts(env, "manual");
		return Response.json(result);
	}

	if (url.pathname === "/admin/import/movie-list/current-count-snapshot") {
		const result = await recordMovieListCurrentCountSnapshot(env, "manual");
		return Response.json(result);
	}

	if (url.pathname === "/movies") {
		const { results } = await env.DB.prepare(
			"SELECT id, MovieName, IMDBRating, IMDBVoteCounts FROM movies ORDER BY id",
		).all<MovieRow>();

		return jsonResponse({ movies: results });
	}

	return jsonResponse({ error: "Not found." }, { status: 404 });
}
