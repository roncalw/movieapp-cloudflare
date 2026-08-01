import type { Env } from "../shared/types";

type MovieLanguageRow = {
	language_code: string;
	english_name: string;
	native_name: string | null;
};

const MOVIE_LANGUAGES_CACHE_SECONDS = 60 * 60 * 24 * 7;
const MOVIE_LANGUAGES_STALE_SECONDS = 60 * 60 * 24;

function movieLanguagesCacheHeaders(cacheStatus: "HIT" | "MISS") {
	return {
		"Cache-Control": `public, max-age=60, s-maxage=${MOVIE_LANGUAGES_CACHE_SECONDS}, stale-while-revalidate=${MOVIE_LANGUAGES_STALE_SECONDS}`,
		"CDN-Cache-Control": `public, max-age=${MOVIE_LANGUAGES_CACHE_SECONDS}`,
		"Cloudflare-CDN-Cache-Control": `public, max-age=${MOVIE_LANGUAGES_CACHE_SECONDS}`,
		"X-MovieApp-Cache": cacheStatus,
	};
}

async function getMovieLanguages(env: Env) {
	const { results } = await env.DB.prepare(
		`SELECT
		    language_code,
		    english_name,
		    native_name
		  FROM tmdb_original_language_lookup
		  WHERE is_filter_enabled = 1
		  ORDER BY
		    display_order,
		    english_name COLLATE NOCASE,
		    language_code`,
	).all<MovieLanguageRow>();

	return {
		languages: results.map((row) => ({
			code: row.language_code,
			englishName: row.english_name,
			nativeName: row.native_name,
		})),
	};
}

export async function getCachedMovieLanguagesResponse(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
) {
	const cacheUrl = new URL(request.url);
	cacheUrl.pathname = "/movies/languages";
	cacheUrl.search = "";
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

	const result = await getMovieLanguages(env);
	const response = Response.json(result, {
		headers: movieLanguagesCacheHeaders("MISS"),
	});
	const cachePut = cache.put(cacheKey, response.clone()).catch(() => undefined);

	if (ctx) {
		ctx.waitUntil(cachePut);
	} else {
		await cachePut;
	}

	return response;
}
