import type { Env } from "../shared/types";
import {
	MOVIE_LIST_BUILD_JOB_NAME,
	MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
} from "../jobs/importJobRuns";
import { STREAMS_WITH_ADS_PROVIDER_ID } from "../shared/watchProviderAvailability";

type MovieSearchListItem = {
	tmdb_id: number;
	poster_path: string;
	imdb_rating: number | null;
	original_language: string | null;
	available_with_subscription: number | boolean;
	available_without_rent_or_purchase: number | boolean;
};

type MovieListImdbRatingRow = {
	tmdb_id: number;
	imdb_rating: number | null;
};

type MovieCardDataRow = {
	imdb_rating: number | null;
	available_with_subscription: number | boolean;
	available_without_rent_or_purchase: number | boolean;
};

type MovieSearchSort = "popularity" | "imdb";

type MovieSearchCursor = {
	sort: MovieSearchSort;
	tmdbId: number;
	popularity?: number;
	imdbRating?: number;
	imdbVoteCount?: number;
};

export class RequestValidationError extends Error {}

const MOVIE_SEARCH_CACHE_SECONDS = 60 * 60 * 24 * 7;
const MOVIE_SEARCH_STALE_SECONDS = 60 * 60 * 24;
const MOVIE_SEARCH_CACHE_GENERATION_PARAM = "__movieListBuild";
const MOVIE_SEARCH_PROVIDER_GENERATION_PARAM = "__providerApply";
const MOVIE_SEARCH_RESPONSE_VERSION_PARAM = "__responseVersion";
const MOVIE_SEARCH_RESPONSE_VERSION = "subscription-or-ads-availability-v2";

type MovieSearchCacheGenerationRow = {
	movie_list_job_run_id: string | null;
	provider_apply_job_run_id: string | null;
};

async function getMovieSearchCacheGeneration(env: Env) {
	/*
		Each successful Movie List build and provider application receives a unique
		job-run ID. Both IDs belong in the internal cache key: Movie List changes
		movie fields, while provider application changes streamer filters and the
		availability answer used by the shopping-bag badge. The caller's public URL
		is unchanged. A request that hits the cache performs only these two small,
		indexed job-history lookups.
	*/
	const row = await env.DB.prepare(
		`SELECT
		   (
		     SELECT job_run_id
		     FROM import_job_runs
		     WHERE job_name = ?
		       AND status = 'complete'
		     ORDER BY started_at DESC
		     LIMIT 1
		   ) AS movie_list_job_run_id,
		   (
		     SELECT job_run_id
		     FROM import_job_runs
		     WHERE job_name = ?
		       AND status = 'complete'
		     ORDER BY started_at DESC
		     LIMIT 1
		   ) AS provider_apply_job_run_id`,
	)
		.bind(MOVIE_LIST_BUILD_JOB_NAME, MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME)
		.first<MovieSearchCacheGenerationRow>();

	return {
		movieListJobRunId:
			row?.movie_list_job_run_id ?? "before-first-complete-build",
		providerApplyJobRunId:
			row?.provider_apply_job_run_id ?? "before-first-provider-apply",
	};
}

function isIsoDate(value: string) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parsePositiveIntegerParam(
	value: string | null,
	defaultValue: number,
	maxValue: number,
	paramName: string,
) {
	const parsedValue = value === null ? defaultValue : Number(value);

	if (
		!Number.isInteger(parsedValue) ||
		parsedValue < 1 ||
		parsedValue > maxValue
	) {
		throw new RequestValidationError(
			`${paramName} must be a whole number between 1 and ${maxValue}.`,
		);
	}

	return parsedValue;
}

export function parseMovieListTmdbIdPath(pathname: string) {
	const match = pathname.match(/^\/movies\/(\d+)\/imdb-rating$/);

	if (!match) {
		return null;
	}

	const tmdbId = Number(match[1]);

	if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) {
		throw new RequestValidationError("tmdbId must be a positive integer.");
	}

	return tmdbId;
}

export function parseMovieCardDataTmdbIdPath(pathname: string) {
	const match = pathname.match(/^\/movies\/(\d+)\/card-data$/);

	if (!match) {
		return null;
	}

	const tmdbId = Number(match[1]);

	if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) {
		throw new RequestValidationError("tmdbId must be a positive integer.");
	}

	return tmdbId;
}

export async function getMovieListImdbRatingByTmdbId(env: Env, tmdbId: number) {
	const row = await env.DB.prepare(
		`SELECT
		    tmdb_id,
		    imdb_rating
		  FROM movie_list_items
		  WHERE tmdb_id = ?
		  LIMIT 1`,
	).bind(tmdbId)
		.first<MovieListImdbRatingRow>();

	return {
		tmdb_id: tmdbId,
		imdb_rating: row?.imdb_rating ?? null,
	};
}

export async function getMovieCardDataByTmdbId(env: Env, tmdbId: number) {
	/*
		This query always returns one answer, even when the movie is absent from
		movie_list_items. That lets the app distinguish "no IMDb rating" from a
		failed HTTP request. The provider check reads the existing US-flatrate
		rows; it does not change or import provider data.
	*/
	const row = await env.DB.prepare(
		`SELECT
		    (SELECT imdb_rating
		     FROM movie_list_items
		     WHERE tmdb_id = ?
		     LIMIT 1) AS imdb_rating,
		    EXISTS (
		      SELECT 1
		      FROM movie_watch_providers
		      WHERE tmdb_id = ?
		        AND region = 'US'
		        AND provider_id <> ?
		    ) AS available_with_subscription,
		    EXISTS (
		      SELECT 1
		      FROM movie_watch_providers
		      WHERE tmdb_id = ?
		        AND region = 'US'
		    ) AS available_without_rent_or_purchase`,
	)
		.bind(tmdbId, tmdbId, STREAMS_WITH_ADS_PROVIDER_ID, tmdbId)
		.first<MovieCardDataRow>();

	return {
		tmdb_id: tmdbId,
		imdb_rating: row?.imdb_rating ?? null,
		available_with_subscription:
			row?.available_with_subscription === true ||
			row?.available_with_subscription === 1,
		available_without_rent_or_purchase:
			row?.available_without_rent_or_purchase === true ||
			row?.available_without_rent_or_purchase === 1,
	};
}

function parseOptionalPositiveIntegerParam(
	value: string | null,
	maxValue: number,
	paramName: string,
) {
	if (value === null || value.trim() === "") {
		return null;
	}

	return parsePositiveIntegerParam(value, 1, maxValue, paramName);
}

function parseMovieSearchSortParam(value: string | null): MovieSearchSort {
	if (value === null || value.trim() === "" || value === "popularity") {
		return "popularity";
	}

	if (value === "imdb") {
		return "imdb";
	}

	throw new RequestValidationError("sort must be popularity or imdb.");
}

function getDefaultMovieSearchBeginDate() {
	const today = new Date();
	const year = today.getUTCFullYear() - 5;
	return `${year}-01-01`;
}

function getDefaultMovieSearchEndDate() {
	return new Date().toISOString().slice(0, 10);
}

function getMovieSearchDateRange(url: URL) {
	const datePreset = url.searchParams.get("datePreset");
	const endDatePreset = url.searchParams.get("endDatePreset");

	if (
		endDatePreset !== null &&
		endDatePreset.trim() !== "" &&
		endDatePreset !== "today"
	) {
		throw new RequestValidationError("endDatePreset must be today.");
	}

	if (datePreset === null || datePreset.trim() === "") {
		if (endDatePreset === "today" && url.searchParams.has("endDate")) {
			throw new RequestValidationError(
				"endDatePreset cannot be combined with endDate.",
			);
		}

		return {
			beginDate:
				url.searchParams.get("beginDate") ?? getDefaultMovieSearchBeginDate(),
			endDate:
				endDatePreset === "today"
					? getDefaultMovieSearchEndDate()
					: (url.searchParams.get("endDate") ?? getDefaultMovieSearchEndDate()),
			datePreset: null,
			endDatePreset: endDatePreset === "today" ? endDatePreset : null,
		};
	}

	if (datePreset !== "last5years") {
		throw new RequestValidationError("datePreset must be last5years.");
	}

	if (
		url.searchParams.has("beginDate") ||
		url.searchParams.has("endDate") ||
		url.searchParams.has("endDatePreset")
	) {
		throw new RequestValidationError(
			"datePreset cannot be combined with beginDate, endDate, or endDatePreset.",
		);
	}

	return {
		beginDate: getDefaultMovieSearchBeginDate(),
		endDate: getDefaultMovieSearchEndDate(),
		datePreset,
		endDatePreset: null,
	};
}

function parseIntegerListParam(value: string | null, paramName: string) {
	if (value === null || value.trim() === "") {
		return [];
	}

	const parsedValues = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => Number(part));

	if (
		parsedValues.length === 0 ||
		parsedValues.some((parsedValue) => !Number.isInteger(parsedValue))
	) {
		throw new RequestValidationError(
			`${paramName} must be a comma-separated list of integers.`,
		);
	}

	return [...new Set(parsedValues)];
}

function parseStringListParam(value: string | null) {
	if (value === null || value.trim() === "") {
		return [];
	}

	return [
		...new Set(
			value
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0),
		),
	];
}

export function parseOriginalLanguagesParam(value: string | null) {
	const originalLanguages = parseStringListParam(value)
		.map((languageCode) => languageCode.toLowerCase())
		.sort();

	if (
		originalLanguages.some(
			(languageCode) => !/^[a-z]{2,3}$/.test(languageCode),
		)
	) {
		throw new RequestValidationError(
			"originalLanguages must be a comma-separated list of two- or three-letter language codes.",
		);
	}

	return [...new Set(originalLanguages)];
}

function parseWatchMonetizationTypesParam(value: string | null) {
	const monetizationTypes = parseStringListParam(value);

	if (
		monetizationTypes.some(
			(monetizationType) => monetizationType !== "flatrate",
		)
	) {
		throw new RequestValidationError(
			"watchMonetizationTypes must be flatrate.",
		);
	}

	return monetizationTypes;
}

function encodeMovieSearchCursor(item: {
	tmdb_id: number;
	imdb_rating: number | null;
	imdb_vote_count: number;
	popularity: number;
}, sort: MovieSearchSort) {
	const cursor: MovieSearchCursor =
		sort === "imdb"
			? {
					sort,
					imdbRating: item.imdb_rating ?? 0,
					imdbVoteCount: item.imdb_vote_count,
					tmdbId: item.tmdb_id,
				}
			: {
					sort,
					popularity: item.popularity,
					tmdbId: item.tmdb_id,
				};

	return btoa(JSON.stringify(cursor));
}

function decodeMovieSearchCursor(value: string | null, sort: MovieSearchSort) {
	if (value === null || value.trim() === "") {
		return null;
	}

	try {
		const parsedValue = JSON.parse(atob(value)) as Partial<MovieSearchCursor>;

		if (parsedValue.sort !== sort || typeof parsedValue.tmdbId !== "number") {
			throw new RequestValidationError("Invalid cursor shape.");
		}

		if (
			sort === "imdb" &&
			(typeof parsedValue.imdbRating !== "number" ||
				typeof parsedValue.imdbVoteCount !== "number")
		) {
			throw new RequestValidationError("Invalid cursor shape.");
		}

		if (sort === "popularity" && typeof parsedValue.popularity !== "number") {
			throw new RequestValidationError("Invalid cursor shape.");
		}

		return parsedValue as MovieSearchCursor;
	} catch {
		throw new RequestValidationError("cursor is invalid.");
	}
}

async function searchMovieListItems(env: Env, url: URL) {
	const pageSize = parsePositiveIntegerParam(
		url.searchParams.get("pageSize"),
		20,
		50,
		"pageSize",
	);
	let sort = parseMovieSearchSortParam(url.searchParams.get("sort"));
	const minImdbVotes = parseOptionalPositiveIntegerParam(
		url.searchParams.get("minImdbVotes"),
		10_000_000,
		"minImdbVotes",
	);

	if (minImdbVotes !== null) {
		sort = "imdb";
	}
	const genreIds = parseIntegerListParam(
		url.searchParams.get("genreIds"),
		"genreIds",
	);
	const providerIds = parseIntegerListParam(
		url.searchParams.get("providerIds"),
		"providerIds",
	);

	if (providerIds.some((providerId) => providerId <= 0)) {
		throw new RequestValidationError(
			"providerIds must contain positive TMDb provider IDs.",
		);
	}
	const watchMonetizationTypes = parseWatchMonetizationTypesParam(
		url.searchParams.get("watchMonetizationTypes"),
	);
	const certifications = parseStringListParam(
		url.searchParams.get("certifications"),
	);
	const originalLanguages = parseOriginalLanguagesParam(
		url.searchParams.get("originalLanguages"),
	);
	const originalLanguageSearchEnabled =
		env.ORIGINAL_LANGUAGE_SEARCH_ENABLED === "true";
	const { beginDate, endDate, datePreset, endDatePreset } =
		getMovieSearchDateRange(url);
	const cursor = decodeMovieSearchCursor(url.searchParams.get("cursor"), sort);

	if (!isIsoDate(beginDate)) {
		throw new RequestValidationError("beginDate must use YYYY-MM-DD format.");
	}

	if (!isIsoDate(endDate)) {
		throw new RequestValidationError("endDate must use YYYY-MM-DD format.");
	}

	if (beginDate > endDate) {
		throw new RequestValidationError(
			"beginDate must be less than or equal to endDate.",
		);
	}

	if (providerIds.length > 0 && watchMonetizationTypes.length > 0) {
		throw new RequestValidationError(
			"providerIds cannot be combined with watchMonetizationTypes.",
		);
	}

	if (originalLanguages.length > 0 && !originalLanguageSearchEnabled) {
		throw new RequestValidationError(
			"Original-language search is not available yet.",
		);
	}

	const movieIndexHint =
		originalLanguages.length > 0
			? sort === "popularity"
				? " INDEXED BY idx_movie_list_items_language_popularity_v2_cover"
				: " INDEXED BY idx_movie_list_items_language_imdb_v2_cover"
			: sort === "popularity"
				? " INDEXED BY idx_movie_list_items_search_popularity_v2_cover"
				: " INDEXED BY idx_movie_list_items_search_imdb_v2_cover";
	const availableWithSubscriptionSql =
		providerIds.length > 0 || watchMonetizationTypes.includes("flatrate")
			? "1"
			: `EXISTS (
		        SELECT 1
		        FROM movie_watch_providers AS subscription_provider
			        WHERE subscription_provider.tmdb_id = movie.tmdb_id
			          AND subscription_provider.region = 'US'
			          AND subscription_provider.provider_id <> ${STREAMS_WITH_ADS_PROVIDER_ID}
			      )`;
	const availableWithoutRentOrPurchaseSql =
		providerIds.length > 0 || watchMonetizationTypes.includes("flatrate")
			? "1"
			: `EXISTS (
		        SELECT 1
		        FROM movie_watch_providers AS viewing_option
		        WHERE viewing_option.tmdb_id = movie.tmdb_id
		          AND viewing_option.region = 'US'
		      )`;
	const sqlParts = [
		`SELECT
		    movie.tmdb_id,
		    movie.poster_path,
		    movie.imdb_rating,
		    movie.imdb_vote_count,
		    movie.popularity,
		    movie.original_language,
		    ${availableWithSubscriptionSql} AS available_with_subscription,
		    ${availableWithoutRentOrPurchaseSql} AS available_without_rent_or_purchase
		  FROM movie_list_items AS movie${movieIndexHint}
		  WHERE movie.release_date >= ?
		    AND movie.release_date <= ?`,
	];
	const bindings: Array<number | string> = [beginDate, endDate];

	if (sort === "imdb") {
		sqlParts.push("AND movie.imdb_rating IS NOT NULL");
	}

	if (minImdbVotes !== null) {
		sqlParts.push("AND movie.imdb_vote_count >= ?");
		bindings.push(minImdbVotes);
	}

	for (const genreId of genreIds) {
		sqlParts.push(
			`AND EXISTS (
			   SELECT 1
			   FROM movie_genres AS genre
			   WHERE genre.tmdb_id = movie.tmdb_id
			     AND genre.genre_id = ?
			 )`,
		);
		bindings.push(genreId);
	}

	if (providerIds.length > 0) {
		const placeholders = providerIds.map(() => "?").join(", ");
		sqlParts.push(
			`AND EXISTS (
			   SELECT 1
			   FROM movie_watch_providers AS provider
			   WHERE provider.tmdb_id = movie.tmdb_id
			     AND provider.region = 'US'
			     AND provider.provider_id IN (${placeholders})
			 )`,
		);
		bindings.push(...providerIds);
	}

	if (watchMonetizationTypes.includes("flatrate")) {
		sqlParts.push(
			`AND EXISTS (
			   SELECT 1
			   FROM movie_watch_providers AS provider
			   WHERE provider.tmdb_id = movie.tmdb_id
			     AND provider.region = 'US'
			     AND provider.provider_id <> ${STREAMS_WITH_ADS_PROVIDER_ID}
			 )`,
		);
	}

	if (certifications.length > 0) {
		const placeholders = certifications.map(() => "?").join(", ");
		sqlParts.push(`AND movie.us_certification IN (${placeholders})`);
		bindings.push(...certifications);
	}

	if (originalLanguages.length === 1) {
		sqlParts.push("AND movie.original_language = ?");
		bindings.push(originalLanguages[0]);
	} else if (originalLanguages.length > 1) {
		const placeholders = originalLanguages.map(() => "?").join(", ");
		sqlParts.push(`AND movie.original_language IN (${placeholders})`);
		bindings.push(...originalLanguages);
	}

	if (cursor !== null) {
		if (sort === "imdb") {
			sqlParts.push(
				`AND (
				   movie.imdb_rating < ?
				   OR (
				     movie.imdb_rating = ?
				     AND movie.imdb_vote_count < ?
				   )
				   OR (
				     movie.imdb_rating = ?
				     AND movie.imdb_vote_count = ?
				     AND movie.tmdb_id > ?
				   )
				 )`,
			);
			bindings.push(
				cursor.imdbRating ?? 0,
				cursor.imdbRating ?? 0,
				cursor.imdbVoteCount ?? 0,
				cursor.imdbRating ?? 0,
				cursor.imdbVoteCount ?? 0,
				cursor.tmdbId,
			);
		} else {
			sqlParts.push(
				`AND (
				   movie.popularity < ?
				   OR (
				     movie.popularity = ?
				     AND movie.tmdb_id > ?
				   )
				 )`,
			);
			bindings.push(cursor.popularity ?? 0, cursor.popularity ?? 0, cursor.tmdbId);
		}
	}

	if (sort === "imdb") {
		sqlParts.push(
			`ORDER BY
			    movie.imdb_rating DESC,
			    movie.imdb_vote_count DESC,
			    movie.tmdb_id
			  LIMIT ?`,
		);
	} else {
		sqlParts.push(
			`ORDER BY
			    movie.popularity DESC,
			    movie.tmdb_id
			  LIMIT ?`,
		);
	}

	bindings.push(pageSize + 1);

	const { results } = await env.DB.prepare(sqlParts.join("\n"))
		.bind(...bindings)
		.all<MovieSearchListItem & { imdb_vote_count: number; popularity: number }>();
	const pageRows = results.slice(0, pageSize);
	const lastRow = pageRows.at(-1);
	const nextCursor =
		results.length > pageSize && lastRow
			? encodeMovieSearchCursor(lastRow, sort)
			: null;
	const movies = pageRows.map(
		({ imdb_vote_count: _imdbVoteCount, popularity: _popularity, ...movie }) => ({
			...movie,
			available_with_subscription:
				movie.available_with_subscription === true ||
				movie.available_with_subscription === 1,
			available_without_rent_or_purchase:
				movie.available_without_rent_or_purchase === true ||
				movie.available_without_rent_or_purchase === 1,
		}),
	);

	return {
		movies,
		nextCursor,
		pageSize,
		sort,
		beginDate,
		endDate,
		datePreset,
		endDatePreset,
		originalLanguages,
	};
}

function movieSearchCacheHeaders(cacheStatus: "HIT" | "MISS") {
	return {
		"Cache-Control": `public, max-age=60, s-maxage=${MOVIE_SEARCH_CACHE_SECONDS}, stale-while-revalidate=${MOVIE_SEARCH_STALE_SECONDS}`,
		"CDN-Cache-Control": `public, max-age=${MOVIE_SEARCH_CACHE_SECONDS}`,
		"Cloudflare-CDN-Cache-Control": `public, max-age=${MOVIE_SEARCH_CACHE_SECONDS}`,
		"X-MovieApp-Cache": cacheStatus,
	};
}

export async function getCachedMovieSearchResponse(
	request: Request,
	env: Env,
	url: URL,
	ctx?: ExecutionContext,
) {
	const searchUrl = new URL(url.toString());
	const originalLanguages = parseOriginalLanguagesParam(
		searchUrl.searchParams.get("originalLanguages"),
	);

	if (originalLanguages.length > 0) {
		searchUrl.searchParams.set("originalLanguages", originalLanguages.join(","));
	} else {
		searchUrl.searchParams.delete("originalLanguages");
	}

	searchUrl.searchParams.sort();
	const cacheGeneration = await getMovieSearchCacheGeneration(env);
	const cacheUrl = new URL(searchUrl.toString());
	cacheUrl.searchParams.set(
		MOVIE_SEARCH_CACHE_GENERATION_PARAM,
		cacheGeneration.movieListJobRunId,
	);
	cacheUrl.searchParams.set(
		MOVIE_SEARCH_PROVIDER_GENERATION_PARAM,
		cacheGeneration.providerApplyJobRunId,
	);
	/*
		A cache entry stores the complete JSON response. When that response gains a
		new field, an entry saved by the previous Worker cannot supply it. Including
		this internal format version makes the first request after deployment miss
		the old entry and save the complete new response. This does not change the
		public request URL or the weekly cache-job order.
	*/
	cacheUrl.searchParams.set(
		MOVIE_SEARCH_RESPONSE_VERSION_PARAM,
		MOVIE_SEARCH_RESPONSE_VERSION,
	);
	cacheUrl.searchParams.sort();
	const cacheKey = new Request(cacheUrl.toString(), request);
	const cache = caches.default;
	const cachedResponse = await cache.match(cacheKey).catch(() => undefined);

	if (cachedResponse) {
		const headers = new Headers(cachedResponse.headers);
		headers.set("X-MovieApp-Cache", "HIT");

		return new Response(cachedResponse.body, {
			status: cachedResponse.status,
			statusText: cachedResponse.statusText,
			headers,
		});
	}

	const result = await searchMovieListItems(env, searchUrl);
	const response = Response.json(result, {
		headers: movieSearchCacheHeaders("MISS"),
	});
	const cachePut = cache.put(cacheKey, response.clone()).catch(() => undefined);

	if (ctx) {
		ctx.waitUntil(cachePut);
	} else {
		await cachePut;
	}

	return response;
}
