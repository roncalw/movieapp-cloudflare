import {
	getTmdbDiscoverPage,
	TMDB_DISCOVER_MAX_PAGE,
	type TmdbDiscoverResult,
} from "../externalApis/tmdbClient";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	TMDB_PRIMARY_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";

type TmdbDateWindow = {
	beginDate: string;
	endDate: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const TMDB_PRIMARY_STANDARD_LIMIT = 2000000;
export const TMDB_PRIMARY_MAX_REFRESH_AGE_DAYS = 28;

function todayIsoDate(nowMs = Date.now()) {
	return new Date(nowMs).toISOString().slice(0, 10);
}

function isoDateDaysAgo(daysAgo: number, nowMs = Date.now()) {
	return timeToIsoDate(nowMs - daysAgo * ONE_DAY_MS);
}

export async function getTmdbRefreshStartDate(
	env: Env,
	fallbackBeginDate = "2000-01-01",
) {
	const result = await env.DB.prepare(
		`SELECT MAX(release_date) AS max_release_date
		 FROM tmdb_movies_staging`,
	).first<{ max_release_date: string | null }>();

	return result?.max_release_date ?? fallbackBeginDate;
}

function isoDateToTime(value: string) {
	const [year, month, day] = value.split("-").map(Number);
	return Date.UTC(year, month - 1, day);
}

function timeToIsoDate(value: number) {
	return new Date(value).toISOString().slice(0, 10);
}

export function isIsoDate(value: string) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && timeToIsoDate(isoDateToTime(value)) === value;
}

async function finishSkippedTmdbPrimaryRun(
	env: Env,
	trigger: ImportJobTrigger,
	result: {
		skipReason: string;
		beginDate: string;
		endDate: string;
		limit: number;
		oldestAllowedBeginDate?: string;
		startedAt: string;
		endedAt: string;
		durationMs: number;
	},
) {
	const jobRunId = createImportJobRunId(TMDB_PRIMARY_JOB_NAME, trigger);
	const skippedResult = {
		jobRunId,
		skipped: true,
		...result,
	};

	await createImportJobRun(env, {
		jobRunId,
		jobName: TMDB_PRIMARY_JOB_NAME,
		trigger,
		status: "running",
	});
	await finishImportJobRun(env, jobRunId, {
		status: "skipped",
		result: skippedResult,
		lastError: result.skipReason,
	});

	return skippedResult;
}

export async function loadNewTmdbPrimaryRows(
	env: Env,
	trigger: ImportJobTrigger = "manual",
	options: {
		nowMs?: number;
		enforceMaxRefreshAge?: boolean;
	} = {},
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const beginDate = await getTmdbRefreshStartDate(env);
	const nowMs = options.nowMs ?? startedAtMs;
	const endDate = todayIsoDate(nowMs);
	const limit = TMDB_PRIMARY_STANDARD_LIMIT;

	if (beginDate > endDate) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();

		return finishSkippedTmdbPrimaryRun(env, trigger, {
			skipReason: "begin_date_after_end_date",
			beginDate,
			endDate,
			limit,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		});
	}

	const oldestAllowedBeginDate = isoDateDaysAgo(
		TMDB_PRIMARY_MAX_REFRESH_AGE_DAYS,
		nowMs,
	);

	if (
		options.enforceMaxRefreshAge !== false &&
		beginDate < oldestAllowedBeginDate
	) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();

		return finishSkippedTmdbPrimaryRun(env, trigger, {
			skipReason: "begin_date_older_than_28_days",
			beginDate,
			endDate,
			limit,
			oldestAllowedBeginDate,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		});
	}

	logEvent("tmdb-primary-refresh-start", {
		trigger,
		startedAt,
		beginDate,
		endDate,
		limit,
		oldestAllowedBeginDate,
	});

	const result = await loadTmdbPrimaryRowsManual(
		env,
		beginDate,
		endDate,
		limit,
		trigger,
	);
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const responseBody = {
		...result,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
		oldestAllowedBeginDate,
	};

	logEvent("tmdb-primary-refresh-end", {
		trigger,
		...responseBody,
	});

	return responseBody;
}

function splitDateWindow(window: TmdbDateWindow) {
	const beginTime = isoDateToTime(window.beginDate);
	const endTime = isoDateToTime(window.endDate);

	if (beginTime >= endTime) {
		return null;
	}

	const daysBetween = Math.floor((endTime - beginTime) / ONE_DAY_MS);
	const leftEndTime = beginTime + Math.floor(daysBetween / 2) * ONE_DAY_MS;
	const rightBeginTime = leftEndTime + ONE_DAY_MS;

	return {
		left: {
			beginDate: window.beginDate,
			endDate: timeToIsoDate(leftEndTime),
		},
		right: {
			beginDate: timeToIsoDate(rightBeginTime),
			endDate: window.endDate,
		},
	};
}

function buildTmdbPrimaryStatements(
	discoverResult: TmdbDiscoverResult,
	env: Env,
	loadRunId: string,
) {
	const tmdbId = discoverResult.id;
	const genreIds = Array.isArray(discoverResult.genre_ids)
		? [...new Set(discoverResult.genre_ids.filter((genreId) => typeof genreId === "number"))]
		: [];
	const statements = [
		env.DB.prepare(
			`INSERT OR IGNORE INTO tmdb_primary_new_movie_ids_for_new_movie_details_staging (
				job_run_id,
				tmdb_id,
				loaded_at
			)
			SELECT ?, ?, CURRENT_TIMESTAMP
			WHERE NOT EXISTS (
				SELECT 1
				FROM tmdb_movies_staging
				WHERE tmdb_id = ?
			)`,
		).bind(loadRunId, tmdbId, tmdbId),
		env.DB.prepare(
			`INSERT INTO tmdb_movies_staging (
				tmdb_id,
				imdb_id,
				title,
				poster_path,
				release_date,
				us_certification,
				popularity,
				imported_at
			)
			VALUES (?, NULL, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(tmdb_id) DO UPDATE SET
				title = excluded.title,
				poster_path = excluded.poster_path,
				release_date = excluded.release_date,
				popularity = excluded.popularity,
				imported_at = CURRENT_TIMESTAMP`,
		).bind(
			tmdbId,
			discoverResult.title ?? "",
			discoverResult.poster_path ?? null,
			discoverResult.release_date ?? null,
			discoverResult.popularity ?? 0,
		),
		env.DB.prepare("DELETE FROM movie_genres_staging WHERE tmdb_id = ?").bind(
			tmdbId,
		),
	];

	for (const genreId of genreIds) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO movie_genres_staging (
					tmdb_id,
					genre_id,
					load_run_id,
					staged_at,
					promoted_at
				)
				VALUES (?, ?, ?, CURRENT_TIMESTAMP, NULL)`,
			).bind(tmdbId, genreId, loadRunId),
		);
	}

	return statements;
}

export async function loadTmdbPrimaryRowsManual(
	env: Env,
	beginDate: string,
	endDate: string,
	limit: number,
	trigger: ImportJobTrigger = "manual",
) {
	const jobRunId = createImportJobRunId(TMDB_PRIMARY_JOB_NAME, trigger);
	let pagesRead = 0;
	let rowsSeen = 0;
	let rowsInserted = 0;
	let rowsUpserted = 0;
	let totalPagesSeen: number | null = null;
	let windowsLoaded = 0;
	let windowsSplit = 0;
	let stopReason:
		| "limit_reached"
		| "end_of_windows"
		| "single_day_page_cap_reached" = "end_of_windows";
	let stoppedWindow: TmdbDateWindow | null = null;
	const pendingWindows: TmdbDateWindow[] = [{ beginDate, endDate }];

	await createImportJobRun(env, {
		jobRunId,
		jobName: TMDB_PRIMARY_JOB_NAME,
		trigger,
	});

	try {
		await env.DB.prepare(
			"DELETE FROM tmdb_primary_new_movie_ids_for_new_movie_details_staging",
		).run();

		while (pendingWindows.length > 0 && rowsUpserted < limit) {
			const currentWindow = pendingWindows.shift();

			if (!currentWindow) {
				break;
			}

			const firstPage = await getTmdbDiscoverPage(
				1,
				currentWindow.beginDate,
				env,
				currentWindow.endDate,
			);

			pagesRead += 1;
			totalPagesSeen = Math.max(totalPagesSeen ?? 0, firstPage.total_pages);

			if (firstPage.total_pages > TMDB_DISCOVER_MAX_PAGE) {
				const splitWindow = splitDateWindow(currentWindow);

				if (!splitWindow) {
					stopReason = "single_day_page_cap_reached";
					stoppedWindow = currentWindow;
					logEvent("tmdb-window-single-day-cap", {
						beginDate: currentWindow.beginDate,
						endDate: currentWindow.endDate,
						totalPagesSeen: firstPage.total_pages,
						tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
					});
					break;
				}

				windowsSplit += 1;
				logEvent("tmdb-window-split", {
					beginDate: currentWindow.beginDate,
					endDate: currentWindow.endDate,
					totalPagesSeen: firstPage.total_pages,
					tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
					leftWindow: JSON.stringify(splitWindow.left),
					rightWindow: JSON.stringify(splitWindow.right),
				});

				pendingWindows.unshift(splitWindow.right);
				pendingWindows.unshift(splitWindow.left);
				continue;
			}

			windowsLoaded += 1;

			for (let page = 1; page <= firstPage.total_pages; page += 1) {
				const discoverPage =
					page === 1
						? firstPage
						: await getTmdbDiscoverPage(
								page,
								currentWindow.beginDate,
								env,
								currentWindow.endDate,
							);

				if (page !== 1) {
					pagesRead += 1;
				}

				const pageStatements: D1PreparedStatement[] = [];

				for (const discoverResult of discoverPage.results) {
					rowsSeen += 1;

					if (discoverResult.adult) {
						continue;
					}

					pageStatements.push(
						...buildTmdbPrimaryStatements(discoverResult, env, jobRunId),
					);
					rowsUpserted += 1;

					if (rowsUpserted >= limit) {
						break;
					}
				}

				if (pageStatements.length > 0) {
					await env.DB.batch(pageStatements);
				}

				if (rowsUpserted >= limit) {
					stopReason = "limit_reached";
					break;
				}
			}
		}

		const insertedResult = await env.DB.prepare(
			`SELECT COUNT(*) AS count
			 FROM tmdb_primary_new_movie_ids_for_new_movie_details_staging
			 WHERE job_run_id = ?`,
		)
			.bind(jobRunId)
			.first<{ count: number }>();
		rowsInserted = insertedResult?.count ?? 0;

		const result = {
			jobRunId,
			beginDate,
			endDate: endDate ?? null,
			pagesRead,
			rowsSeen,
			rowsUpserted,
			rowsInserted,
			totalPagesSeen,
			tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
			windowsLoaded,
			windowsSplit,
			pendingWindows: pendingWindows.length,
			stoppedWindow,
			stopReason,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			selected: rowsSeen,
			processed: rowsSeen,
			updated: rowsUpserted,
			result,
		});

		return result;
	} catch (error) {
		const lastError =
			error instanceof Error ? error.message : "TMDB primary load failed.";

		const result = {
			jobRunId,
			beginDate,
			endDate,
			pagesRead,
			rowsSeen,
			rowsUpserted,
			rowsInserted,
			totalPagesSeen,
			windowsLoaded,
			windowsSplit,
			pendingWindows: pendingWindows.length,
			stoppedWindow,
			stopReason,
			status: "cancelled",
			reason: "tmdb_primary_load_error",
			error: lastError,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			selected: rowsSeen,
			processed: rowsSeen,
			updated: rowsUpserted,
			errors: 1,
			result,
			lastError,
		});

		logEvent("tmdb-primary-cancelled", result);

		throw error;
	}
}
