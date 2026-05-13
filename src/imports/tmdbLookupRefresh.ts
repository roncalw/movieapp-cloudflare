import {
	getTmdbMovieGenreLookup,
	getTmdbMovieWatchProviderLookup,
	type TmdbGenreLookupResponse,
	type TmdbWatchProviderLookupResponse,
} from "../externalApis/tmdbClient";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	TMDB_GENRE_LOOKUP_REFRESH_JOB_NAME,
	TMDB_WATCH_PROVIDER_LOOKUP_REFRESH_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";

const LOOKUP_LANGUAGE = "en-US";
const WATCH_PROVIDER_REGION = "US";

type GenreLookupRow = {
	genreId: number;
	genreName: string;
};

type WatchProviderLookupRow = {
	providerId: number;
	providerName: string;
	logoPath: string | null;
	displayPriority: number | null;
};

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function normalizeGenreRows(response: TmdbGenreLookupResponse) {
	const rowsById = new Map<number, GenreLookupRow>();

	for (const genre of response.genres ?? []) {
		if (typeof genre.id !== "number" || typeof genre.name !== "string") {
			continue;
		}

		const genreName = genre.name.trim();

		if (!genreName) {
			continue;
		}

		rowsById.set(genre.id, {
			genreId: genre.id,
			genreName,
		});
	}

	return [...rowsById.values()].sort(
		(left, right) => left.genreId - right.genreId,
	);
}

function normalizeWatchProviderRows(response: TmdbWatchProviderLookupResponse) {
	const rowsById = new Map<number, WatchProviderLookupRow>();

	for (const provider of response.results ?? []) {
		if (
			typeof provider.provider_id !== "number" ||
			typeof provider.provider_name !== "string"
		) {
			continue;
		}

		const providerName = provider.provider_name.trim();

		if (!providerName) {
			continue;
		}

		rowsById.set(provider.provider_id, {
			providerId: provider.provider_id,
			providerName,
			logoPath:
				typeof provider.logo_path === "string" && provider.logo_path.length > 0
					? provider.logo_path
					: null,
			displayPriority:
				typeof provider.display_priority === "number"
					? provider.display_priority
					: null,
		});
	}

	return [...rowsById.values()].sort(
		(left, right) => left.providerId - right.providerId,
	);
}

export async function refreshTmdbGenreLookup(
	env: Env,
	trigger: ImportJobTrigger = "manual",
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const jobRunId = createImportJobRunId(
		TMDB_GENRE_LOOKUP_REFRESH_JOB_NAME,
		trigger,
	);

	await createImportJobRun(env, {
		jobRunId,
		jobName: TMDB_GENRE_LOOKUP_REFRESH_JOB_NAME,
		trigger,
	});

	logEvent("tmdb-genre-lookup-refresh-start", {
		trigger,
		jobRunId,
		language: LOOKUP_LANGUAGE,
		startedAt,
	});

	try {
		const response = await getTmdbMovieGenreLookup(LOOKUP_LANGUAGE, env);
		const rows = normalizeGenreRows(response);

		if (rows.length > 0) {
			await env.DB.batch(
				rows.map((row) =>
					env.DB.prepare(
						`INSERT INTO tmdb_genre_lookup (
							language,
							genre_id,
							genre_name,
							last_refreshed_at,
							created_at,
							updated_at
						)
						VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
						ON CONFLICT(language, genre_id) DO UPDATE SET
							genre_name = excluded.genre_name,
							last_refreshed_at = CURRENT_TIMESTAMP,
							updated_at = CURRENT_TIMESTAMP`,
					).bind(LOOKUP_LANGUAGE, row.genreId, row.genreName),
				),
			);
		}

		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const durationMs = endedAtMs - startedAtMs;
		const result = {
			jobRunId,
			trigger,
			language: LOOKUP_LANGUAGE,
			selected: rows.length,
			upsertedRows: rows.length,
			startedAt,
			endedAt,
			durationMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected: rows.length,
			processed: rows.length,
			updated: rows.length,
			result,
		});

		logEvent("tmdb-genre-lookup-refresh-end", result);

		return result;
	} catch (error) {
		const message = getErrorMessage(error);
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			jobRunId,
			trigger,
			language: LOOKUP_LANGUAGE,
			status: "cancelled",
			error: message,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			errors: 1,
			lastError: message,
			result,
		});

		logEvent("tmdb-genre-lookup-refresh-cancelled", result);

		throw error;
	}
}

export async function refreshTmdbWatchProviderLookup(
	env: Env,
	trigger: ImportJobTrigger = "manual",
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const jobRunId = createImportJobRunId(
		TMDB_WATCH_PROVIDER_LOOKUP_REFRESH_JOB_NAME,
		trigger,
	);

	await createImportJobRun(env, {
		jobRunId,
		jobName: TMDB_WATCH_PROVIDER_LOOKUP_REFRESH_JOB_NAME,
		trigger,
	});

	logEvent("tmdb-watch-provider-lookup-refresh-start", {
		trigger,
		jobRunId,
		region: WATCH_PROVIDER_REGION,
		language: LOOKUP_LANGUAGE,
		startedAt,
	});

	try {
		const response = await getTmdbMovieWatchProviderLookup(
			WATCH_PROVIDER_REGION,
			LOOKUP_LANGUAGE,
			env,
		);
		const rows = normalizeWatchProviderRows(response);

		if (rows.length > 0) {
			await env.DB.batch(
				rows.map((row) =>
					env.DB.prepare(
						`INSERT INTO tmdb_watch_provider_lookup (
							region,
							provider_id,
							provider_name,
							logo_path,
							display_priority,
							last_refreshed_at,
							created_at,
							updated_at
						)
						VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
						ON CONFLICT(region, provider_id) DO UPDATE SET
							provider_name = excluded.provider_name,
							logo_path = excluded.logo_path,
							display_priority = excluded.display_priority,
							last_refreshed_at = CURRENT_TIMESTAMP,
							updated_at = CURRENT_TIMESTAMP`,
					).bind(
						WATCH_PROVIDER_REGION,
						row.providerId,
						row.providerName,
						row.logoPath,
						row.displayPriority,
					),
				),
			);
		}

		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const durationMs = endedAtMs - startedAtMs;
		const result = {
			jobRunId,
			trigger,
			region: WATCH_PROVIDER_REGION,
			language: LOOKUP_LANGUAGE,
			selected: rows.length,
			upsertedRows: rows.length,
			startedAt,
			endedAt,
			durationMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected: rows.length,
			processed: rows.length,
			updated: rows.length,
			result,
		});

		logEvent("tmdb-watch-provider-lookup-refresh-end", result);

		return result;
	} catch (error) {
		const message = getErrorMessage(error);
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			jobRunId,
			trigger,
			region: WATCH_PROVIDER_REGION,
			language: LOOKUP_LANGUAGE,
			status: "cancelled",
			error: message,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			errors: 1,
			lastError: message,
			result,
		});

		logEvent("tmdb-watch-provider-lookup-refresh-cancelled", result);

		throw error;
	}
}
