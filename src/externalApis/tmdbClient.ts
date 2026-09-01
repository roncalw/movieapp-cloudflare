import type { Env } from "../shared/types";

export type TmdbDiscoverResult = {
	id: number;
	title?: string;
	poster_path?: string | null;
	release_date?: string;
	popularity?: number;
	original_language?: string | null;
	genre_ids?: unknown;
	adult?: boolean;
};

export type TmdbWatchMonetizationType = "flatrate" | "ads";

type TmdbDiscoverPage = {
	page: number;
	total_pages: number;
	results: TmdbDiscoverResult[];
};

export type TmdbMovieDetails = {
	id: number;
	external_ids?: {
		imdb_id?: string | null;
	};
	release_dates?: {
		results?: TmdbReleaseDateCountry[];
	};
	"watch/providers"?: {
		results?: {
			US?: {
				flatrate?: TmdbWatchProvider[];
			};
		};
	};
};

export type TmdbWatchProviderResponse = {
	id: number;
	results?: {
		US?: {
			flatrate?: TmdbWatchProvider[];
		};
	};
};

type TmdbReleaseDateCountry = {
	iso_3166_1?: string;
	release_dates?: TmdbReleaseDateItem[];
};

type TmdbReleaseDateItem = {
	certification?: string;
};

type TmdbWatchProvider = {
	provider_id?: unknown;
};

export type TmdbGenreLookupResponse = {
	genres?: TmdbGenreLookupItem[];
};

export type TmdbGenreLookupItem = {
	id?: unknown;
	name?: unknown;
};

export type TmdbWatchProviderLookupResponse = {
	results?: TmdbWatchProviderLookupItem[];
};

export type TmdbWatchProviderLookupItem = {
	provider_id?: unknown;
	provider_name?: unknown;
	logo_path?: unknown;
	display_priority?: unknown;
};

export type TmdbLanguageLookupResponse = TmdbLanguageLookupItem[];

export type TmdbLanguageLookupItem = {
	iso_639_1?: unknown;
	english_name?: unknown;
	name?: unknown;
};

const TMDB_MAX_REQUESTS_PER_SECOND = 35;
const TMDB_DEFAULT_MAX_ATTEMPTS = 6;
const TMDB_RETRY_DELAY_MS = 3000;
export const TMDB_DISCOVER_MAX_PAGE = 500;
const tmdbRequestTimestamps: number[] = [];

export type TmdbFetchRetryOptions = {
	requestTimeoutMs?: number;
	maxAttempts?: number;
	retryDelayMs?: number;
	retryNotFound?: boolean;
};

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTmdbRequestSlot() {
	while (true) {
		const now = Date.now();
		const oneSecondAgo = now - 1000;

		while (
			tmdbRequestTimestamps.length > 0 &&
			tmdbRequestTimestamps[0] <= oneSecondAgo
		) {
			tmdbRequestTimestamps.shift();
		}

		if (tmdbRequestTimestamps.length < TMDB_MAX_REQUESTS_PER_SECOND) {
			tmdbRequestTimestamps.push(now);
			return;
		}

		const oldestRequest = tmdbRequestTimestamps[0];
		const waitMs = Math.max(1000 - (now - oldestRequest), 50);
		await sleep(waitMs);
	}
}

async function fetchTmdbJson<T>(
	url: URL,
	env: Env,
	retryOptions: TmdbFetchRetryOptions = {},
): Promise<T> {
	const maxAttempts =
		retryOptions.maxAttempts ?? TMDB_DEFAULT_MAX_ATTEMPTS;
	const retryDelayMs = retryOptions.retryDelayMs ?? TMDB_RETRY_DELAY_MS;
	const retryNotFound = retryOptions.retryNotFound ?? true;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		await waitForTmdbRequestSlot();

		if (!env.TMDB_API_KEY) {
			throw new Error("TMDB_API_KEY is missing.");
		}

		url.searchParams.set("api_key", env.TMDB_API_KEY);

		const response = await fetch(url, {
			signal: retryOptions.requestTimeoutMs ? AbortSignal.timeout(retryOptions.requestTimeoutMs) : undefined,
			headers: {
				accept: "application/json",
			},
		});

		const shouldRetry =
			(response.status === 404 && retryNotFound) ||
			response.status === 429 ||
			response.status >= 500;

		if (!shouldRetry) {
			if (!response.ok) {
				throw new Error(
					`TMDB request failed: ${response.status} ${response.statusText}`,
				);
			}

			return response.json();
		}

		if (attempt === maxAttempts) {
			throw new Error(
				`TMDB request failed after retries: ${response.status} ${response.statusText}`,
			);
		}

		const retryAfterSeconds = Number(response.headers.get("Retry-After"));
		const retryAfterMs = Number.isFinite(retryAfterSeconds)
			? Math.max(retryAfterSeconds * 1000, retryDelayMs)
			: retryDelayMs;

		await sleep(retryAfterMs);
	}

	throw new Error("TMDB request failed unexpectedly.");
}

export async function getTmdbDiscoverPage(
	page: number,
	beginDate: string,
	env: Env,
	endDate?: string,
	retryOptions?: TmdbFetchRetryOptions,
) {
	const url = new URL("https://api.themoviedb.org/3/discover/movie");
	url.searchParams.set("page", String(page));
	url.searchParams.set("sort_by", "popularity.desc");
	url.searchParams.set("primary_release_date.gte", beginDate);
	url.searchParams.set("watch_region", "US");
	url.searchParams.set("include_adult", "false");
	url.searchParams.set("include_video", "false");

	if (endDate) {
		url.searchParams.set("primary_release_date.lte", endDate);
	}

	return fetchTmdbJson<TmdbDiscoverPage>(url, env, retryOptions);
}

export async function getTmdbUsFlatrateDiscoverPage(
	page: number,
	beginDate: string,
	env: Env,
	endDate?: string,
	retryOptions?: TmdbFetchRetryOptions,
) {
	return getTmdbUsWatchMonetizationDiscoverPage(
		"flatrate",
		page,
		beginDate,
		env,
		endDate,
		retryOptions,
	);
}

export async function getTmdbUsAdsDiscoverPage(
	page: number,
	beginDate: string,
	env: Env,
	endDate?: string,
	retryOptions?: TmdbFetchRetryOptions,
) {
	return getTmdbUsWatchMonetizationDiscoverPage(
		"ads",
		page,
		beginDate,
		env,
		endDate,
		retryOptions,
	);
}

async function getTmdbUsWatchMonetizationDiscoverPage(
	monetizationType: TmdbWatchMonetizationType,
	page: number,
	beginDate: string,
	env: Env,
	endDate?: string,
	retryOptions?: TmdbFetchRetryOptions,
) {
	const url = new URL("https://api.themoviedb.org/3/discover/movie");
	url.searchParams.set("page", String(page));
	url.searchParams.set("sort_by", "popularity.desc");
	url.searchParams.set("primary_release_date.gte", beginDate);
	url.searchParams.set("watch_region", "US");
	url.searchParams.set("with_watch_monetization_types", monetizationType);
	url.searchParams.set("include_adult", "false");
	url.searchParams.set("include_video", "false");

	if (endDate) {
		url.searchParams.set("primary_release_date.lte", endDate);
	}

	return fetchTmdbJson<TmdbDiscoverPage>(url, env, retryOptions);
}

export async function getTmdbMovieExternalIds(tmdbId: number, env: Env) {
	const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`);
	// A foreground tap must not inherit the import jobs' long retry schedule.
	return fetchTmdbJson<{ id: number; wikidata_id?: string | null }>(url, env, {
		maxAttempts: 1, retryNotFound: false, requestTimeoutMs: 5000,
	});
}

export async function getTmdbMovieDetails(tmdbId: number, env: Env) {
	const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
	url.searchParams.set(
		"append_to_response",
		"external_ids,release_dates,watch/providers",
	);

	return fetchTmdbJson<TmdbMovieDetails>(url, env);
}

export async function getTmdbMovieOriginalLanguage(
	tmdbId: number,
	env: Env,
) {
	const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);

	return fetchTmdbJson<{
		id: number;
		original_language?: string | null;
	}>(url, env, {
		maxAttempts: 6,
		retryDelayMs: 2000,
		retryNotFound: false,
	});
}

export async function getTmdbMovieWatchProviders(tmdbId: number, env: Env) {
	const url = new URL(
		`https://api.themoviedb.org/3/movie/${tmdbId}/watch/providers`,
	);

	return fetchTmdbJson<TmdbWatchProviderResponse>(url, env, {
		retryNotFound: false,
	});
}

export async function getTmdbMovieGenreLookup(language: string, env: Env) {
	const url = new URL("https://api.themoviedb.org/3/genre/movie/list");
	url.searchParams.set("language", language);

	return fetchTmdbJson<TmdbGenreLookupResponse>(url, env);
}

export async function getTmdbMovieWatchProviderLookup(
	region: string,
	language: string,
	env: Env,
) {
	const url = new URL("https://api.themoviedb.org/3/watch/providers/movie");
	url.searchParams.set("language", language);
	url.searchParams.set("watch_region", region);

	return fetchTmdbJson<TmdbWatchProviderLookupResponse>(url, env);
}

export async function getTmdbLanguageLookup(env: Env) {
	const url = new URL("https://api.themoviedb.org/3/configuration/languages");

	return fetchTmdbJson<TmdbLanguageLookupResponse>(url, env);
}

export function getUsCertification(details: TmdbMovieDetails) {
	const usReleaseBlock = details.release_dates?.results?.find(
		(entry) => entry.iso_3166_1 === "US",
	);

	return (
		usReleaseBlock?.release_dates?.find(
			(entry) =>
				typeof entry.certification === "string" &&
				entry.certification.length > 0,
		)?.certification ?? null
	);
}

export function getUsFlatrateProviderIds(details: TmdbMovieDetails) {
	const providers = details["watch/providers"]?.results?.US?.flatrate ?? [];

	return getDistinctProviderIds(providers);
}

export function getUsFlatrateProviderIdsFromWatchProviders(
	response: TmdbWatchProviderResponse,
) {
	const providers = response.results?.US?.flatrate ?? [];

	return getDistinctProviderIds(providers);
}

function getDistinctProviderIds(providers: TmdbWatchProvider[]) {
	return [
		...new Set(
			providers
				.map((provider) => provider.provider_id)
				.filter((providerId) => typeof providerId === "number"),
		),
	];
}

export function isTerminalTmdbEnrichmentError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("404 Not Found");
}
