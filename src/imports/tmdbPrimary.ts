import {
	getTmdbDiscoverPage,
	TMDB_DISCOVER_MAX_PAGE,
	type TmdbDiscoverResult,
} from "../externalApis/tmdbClient";
import type { Env } from "../shared/types";

type TmdbDateWindow = {
	beginDate: string;
	endDate: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
) {
	const tmdbId = discoverResult.id;
	const genreIds = Array.isArray(discoverResult.genre_ids)
		? [...new Set(discoverResult.genre_ids.filter((genreId) => typeof genreId === "number"))]
		: [];
	const statements = [
		env.DB.prepare(
			`INSERT OR REPLACE INTO tmdb_movies_staging (
				tmdb_id,
				imdb_id,
				title,
				poster_path,
				release_date,
				us_certification,
				popularity,
				imported_at
			)
			VALUES (?, NULL, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)`,
		).bind(
			tmdbId,
			discoverResult.title ?? "",
			discoverResult.poster_path ?? null,
			discoverResult.release_date ?? null,
			discoverResult.popularity ?? 0,
		),
		env.DB.prepare("DELETE FROM movie_genres WHERE tmdb_id = ?").bind(tmdbId),
	];

	for (const genreId of genreIds) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO movie_genres (tmdb_id, genre_id)
				 VALUES (?, ?)`,
			).bind(tmdbId, genreId),
		);
	}

	return statements;
}

export async function loadTmdbPrimaryRowsManual(
	env: Env,
	beginDate: string,
	endDate: string,
	limit: number,
) {
	let pagesRead = 0;
	let rowsSeen = 0;
	let rowsInserted = 0;
	let totalPagesSeen: number | null = null;
	let windowsLoaded = 0;
	let windowsSplit = 0;
	let stopReason:
		| "limit_reached"
		| "end_of_windows"
		| "single_day_page_cap_reached" = "end_of_windows";
	let stoppedWindow: TmdbDateWindow | null = null;
	const pendingWindows: TmdbDateWindow[] = [{ beginDate, endDate }];

	while (pendingWindows.length > 0 && rowsInserted < limit) {
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
				console.log(
					JSON.stringify({
						event: "tmdb-window-single-day-cap",
						beginDate: currentWindow.beginDate,
						endDate: currentWindow.endDate,
						totalPagesSeen: firstPage.total_pages,
						tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
					}),
				);
				break;
			}

			windowsSplit += 1;
			console.log(
				JSON.stringify({
					event: "tmdb-window-split",
					beginDate: currentWindow.beginDate,
					endDate: currentWindow.endDate,
					totalPagesSeen: firstPage.total_pages,
					tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
					leftWindow: splitWindow.left,
					rightWindow: splitWindow.right,
				}),
			);

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

				pageStatements.push(...buildTmdbPrimaryStatements(discoverResult, env));
				rowsInserted += 1;

				if (rowsInserted >= limit) {
					break;
				}
			}

			if (pageStatements.length > 0) {
				await env.DB.batch(pageStatements);
			}

			if (rowsInserted >= limit) {
				stopReason = "limit_reached";
				break;
			}
		}
	}

	return {
		beginDate,
		endDate: endDate ?? null,
		pagesRead,
		rowsSeen,
		rowsInserted,
		totalPagesSeen,
		tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
		windowsLoaded,
		windowsSplit,
		pendingWindows: pendingWindows.length,
		stoppedWindow,
		stopReason,
	};
}
