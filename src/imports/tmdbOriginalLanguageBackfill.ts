import {
	getTmdbDiscoverPage,
	TMDB_DISCOVER_MAX_PAGE,
	type TmdbDiscoverResult,
	type TmdbFetchRetryOptions,
} from "../externalApis/tmdbClient";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getActiveImportJobRun,
	getImportJobRunById,
	TMDB_ORIGINAL_LANGUAGE_BACKFILL_JOB_NAME,
	touchImportJobRunProgress,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import { logEvent } from "../shared/logging";
import type {
	Env,
	TmdbOriginalLanguageBackfillQueueMessage,
	WorkerQueueMessage,
} from "../shared/types";
import { normalizeOriginalLanguage } from "./tmdbPrimary";

type TmdbDateWindow = {
	beginDate: string;
	endDate: string;
};

export type TmdbOriginalLanguageBackfillProgress = {
	phase: "original_language_backfill";
	status: "running" | "complete";
	reason: string;
	beginDate: string;
	endDate: string;
	currentWindow: TmdbDateWindow | null;
	currentWindowTotalPages: number | null;
	currentPage: number | null;
	pendingWindows: TmdbDateWindow[];
	lastSuccessfulWindow: TmdbDateWindow | null;
	lastSuccessfulPage: number | null;
	pagesRead: number;
	rowsSeen: number;
	rowsWithoutLanguage: number;
	stagingRowsUpdated: number;
	movieListRowsUpdated: number;
	totalPagesSeen: number | null;
	windowsLoaded: number;
	windowsSplit: number;
	attempt: number;
	maxAttempts: number;
	error: string | null;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BACKFILL_BEGIN_DATE = "1874-01-01";
const PAGES_PER_QUEUE_MESSAGE = 200;
const CONCURRENT_DISCOVER_PAGES = 30;
const MAX_ATTEMPTS = 10;
const RETRY_DELAY_SECONDS = 10;
const RESUME_AFTER_MINUTES_WITHOUT_PROGRESS = 10;
const LANGUAGE_UPDATES_PER_STATEMENT = 20;
const TMDB_DISCOVER_RETRY_OPTIONS: TmdbFetchRetryOptions = {
	maxAttempts: 10,
	retryDelayMs: 2000,
};

function todayIsoDate(nowMs = Date.now()) {
	return new Date(nowMs).toISOString().slice(0, 10);
}

function isoDateToTime(value: string) {
	const [year, month, day] = value.split("-").map(Number);
	return Date.UTC(year, month - 1, day);
}

function timeToIsoDate(value: number) {
	return new Date(value).toISOString().slice(0, 10);
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

function isDateWindow(value: unknown): value is TmdbDateWindow {
	return (
		typeof value === "object" &&
		value !== null &&
		"beginDate" in value &&
		"endDate" in value &&
		typeof value.beginDate === "string" &&
		typeof value.endDate === "string"
	);
}

function parseStoredUtcTimestamp(value: string) {
	const parsed = Date.parse(
		value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
	);
	return Number.isFinite(parsed) ? parsed : 0;
}

function getStoredBackfillEndDate(
	resultJson: string | null,
	fallbackEndDate: string,
) {
	if (!resultJson) {
		return fallbackEndDate;
	}

	try {
		const parsed = JSON.parse(resultJson) as { endDate?: unknown };
		return typeof parsed.endDate === "string"
			? parsed.endDate
			: fallbackEndDate;
	} catch {
		return fallbackEndDate;
	}
}

export function buildInitialOriginalLanguageBackfillProgress(
	endDate: string,
): TmdbOriginalLanguageBackfillProgress {
	return {
		phase: "original_language_backfill",
		status: "running",
		reason: "backfill-queued",
		beginDate: BACKFILL_BEGIN_DATE,
		endDate,
		currentWindow: null,
		currentWindowTotalPages: null,
		currentPage: null,
		pendingWindows: [{ beginDate: BACKFILL_BEGIN_DATE, endDate }],
		lastSuccessfulWindow: null,
		lastSuccessfulPage: null,
		pagesRead: 0,
		rowsSeen: 0,
		rowsWithoutLanguage: 0,
		stagingRowsUpdated: 0,
		movieListRowsUpdated: 0,
		totalPagesSeen: null,
		windowsLoaded: 0,
		windowsSplit: 0,
		attempt: 1,
		maxAttempts: MAX_ATTEMPTS,
		error: null,
	};
}

function parseOriginalLanguageBackfillProgress(
	resultJson: string | null,
	endDate: string,
): TmdbOriginalLanguageBackfillProgress {
	const initial = buildInitialOriginalLanguageBackfillProgress(endDate);

	if (!resultJson) {
		return initial;
	}

	try {
		const parsed = JSON.parse(
			resultJson,
		) as Partial<TmdbOriginalLanguageBackfillProgress>;

		if (
			parsed.phase !== "original_language_backfill" ||
			parsed.endDate !== endDate ||
			!Array.isArray(parsed.pendingWindows)
		) {
			return initial;
		}

		return {
			...initial,
			...parsed,
			status: parsed.status === "complete" ? "complete" : "running",
			currentWindow: isDateWindow(parsed.currentWindow)
				? { ...parsed.currentWindow }
				: null,
			pendingWindows: parsed.pendingWindows
				.filter(isDateWindow)
				.map((window) => ({ ...window })),
			lastSuccessfulWindow: isDateWindow(parsed.lastSuccessfulWindow)
				? { ...parsed.lastSuccessfulWindow }
				: null,
			error: typeof parsed.error === "string" ? parsed.error : null,
			maxAttempts: MAX_ATTEMPTS,
		};
	} catch {
		return initial;
	}
}

function snapshotProgress(
	progress: TmdbOriginalLanguageBackfillProgress,
	reason: string,
	attempt: number,
	error: string | null = null,
): TmdbOriginalLanguageBackfillProgress {
	return {
		...progress,
		reason,
		attempt,
		maxAttempts: MAX_ATTEMPTS,
		currentWindow: progress.currentWindow
			? { ...progress.currentWindow }
			: null,
		pendingWindows: progress.pendingWindows.map((window) => ({ ...window })),
		lastSuccessfulWindow: progress.lastSuccessfulWindow
			? { ...progress.lastSuccessfulWindow }
			: null,
		error,
	};
}

async function saveProgress(
	env: Env,
	jobRunId: string,
	progress: TmdbOriginalLanguageBackfillProgress,
) {
	await touchImportJobRunProgress(env, jobRunId, {
		result: progress,
		lastError: progress.error,
	});
}

export async function updateOriginalLanguagesForPage(
	env: Env,
	results: TmdbDiscoverResult[],
) {
	const statements: D1PreparedStatement[] = [];
	const statementTargets: Array<"staging" | "movie_list"> = [];
	const normalizedMovies = new Map<number, string>();
	let rowsWithoutLanguage = 0;

	for (const movie of results) {
		const originalLanguage = normalizeOriginalLanguage(movie.original_language);

		if (originalLanguage === null) {
			rowsWithoutLanguage += 1;
			continue;
		}

		normalizedMovies.set(movie.id, originalLanguage);
	}

	const movies = [...normalizedMovies].map(([tmdbId, originalLanguage]) => ({
		tmdbId,
		originalLanguage,
	}));

	for (
		let offset = 0;
		offset < movies.length;
		offset += LANGUAGE_UPDATES_PER_STATEMENT
	) {
		const chunk = movies.slice(offset, offset + LANGUAGE_UPDATES_PER_STATEMENT);
		const caseParts = chunk.map(() => "WHEN ? THEN ?").join(" ");
		const idPlaceholders = chunk.map(() => "?").join(", ");
		const caseBindings = chunk.flatMap((movie) => [
			movie.tmdbId,
			movie.originalLanguage,
		]);
		const idBindings = chunk.map((movie) => movie.tmdbId);

		for (const [tableName, target] of [
			["tmdb_movies_staging", "staging"],
			["movie_list_items", "movie_list"],
		] as const) {
			statements.push(
				env.DB.prepare(
					`UPDATE ${tableName}
					 SET original_language = CASE tmdb_id
					   ${caseParts}
					   ELSE original_language
					 END
					 WHERE tmdb_id IN (${idPlaceholders})
					   AND original_language IS NOT CASE tmdb_id
					     ${caseParts}
					     ELSE original_language
					   END`,
				).bind(...caseBindings, ...idBindings, ...caseBindings),
			);
			statementTargets.push(target);
		}
	}

	if (statements.length === 0) {
		return {
			rowsWithoutLanguage,
			stagingRowsUpdated: 0,
			movieListRowsUpdated: 0,
		};
	}

	const batchResults = await env.DB.batch(statements);
	let stagingRowsUpdated = 0;
	let movieListRowsUpdated = 0;

	for (let index = 0; index < batchResults.length; index += 1) {
		const changes = batchResults[index]?.meta.changes ?? 0;

		if (statementTargets[index] === "staging") {
			stagingRowsUpdated += changes;
		} else {
			movieListRowsUpdated += changes;
		}
	}

	if (
		stagingRowsUpdated > movies.length ||
		movieListRowsUpdated > movies.length
	) {
		throw new Error(
			"TMDB original-language backfill exceeded its per-table update ceiling.",
		);
	}

	return {
		rowsWithoutLanguage,
		stagingRowsUpdated,
		movieListRowsUpdated,
	};
}

async function processBackfillChunk(
	env: Env,
	jobRunId: string,
	progress: TmdbOriginalLanguageBackfillProgress,
	attempt: number,
) {
	let pagesProcessed = 0;

	while (pagesProcessed < PAGES_PER_QUEUE_MESSAGE) {
		if (!progress.currentWindow) {
			const nextWindow = progress.pendingWindows.shift();

			if (!nextWindow) {
				progress.status = "complete";
				progress.reason = "backfill-complete";
				const snapshot = snapshotProgress(
					progress,
					"backfill-complete",
					attempt,
				);
				await saveProgress(env, jobRunId, snapshot);
				return { complete: true, progress: snapshot };
			}

			progress.currentWindow = nextWindow;
			progress.currentWindowTotalPages = null;
			progress.currentPage = 1;
		}

		const currentWindow = progress.currentWindow;
		const currentPage = progress.currentPage ?? 1;

		if (
			currentPage > 1 &&
			progress.currentWindowTotalPages !== null
		) {
			const pagesRemainingInMessage =
				PAGES_PER_QUEUE_MESSAGE - pagesProcessed;
			const lastPage = Math.min(
				currentPage + CONCURRENT_DISCOVER_PAGES - 1,
				progress.currentWindowTotalPages,
				currentPage + pagesRemainingInMessage - 1,
			);
			const pageNumbers = Array.from(
				{ length: lastPage - currentPage + 1 },
				(_value, index) => currentPage + index,
			);
			const discoverPages = await Promise.all(
				pageNumbers.map((page) =>
					getTmdbDiscoverPage(
						page,
						currentWindow.beginDate,
						env,
						currentWindow.endDate,
						TMDB_DISCOVER_RETRY_OPTIONS,
					),
				),
			);
			const updateResult = await updateOriginalLanguagesForPage(
				env,
				discoverPages.flatMap((page) => page.results),
			);
			const rowsSeen = discoverPages.reduce(
				(total, page) => total + page.results.length,
				0,
			);

			progress.pagesRead += discoverPages.length;
			progress.totalPagesSeen = Math.max(
				progress.totalPagesSeen ?? 0,
				...discoverPages.map((page) => page.total_pages),
			);
			pagesProcessed += discoverPages.length;
			progress.rowsSeen += rowsSeen;
			progress.rowsWithoutLanguage += updateResult.rowsWithoutLanguage;
			progress.stagingRowsUpdated += updateResult.stagingRowsUpdated;
			progress.movieListRowsUpdated += updateResult.movieListRowsUpdated;
			progress.lastSuccessfulWindow = currentWindow;
			progress.lastSuccessfulPage = lastPage;

			if (lastPage >= progress.currentWindowTotalPages) {
				progress.currentWindow = null;
				progress.currentWindowTotalPages = null;
				progress.currentPage = null;
			} else {
				progress.currentPage = lastPage + 1;
			}

			const reason =
				pagesProcessed >= PAGES_PER_QUEUE_MESSAGE
					? "page-batch-read"
					: "page-group-read";
			await saveProgress(
				env,
				jobRunId,
				snapshotProgress(progress, reason, attempt),
			);
			continue;
		}

		const discoverPage = await getTmdbDiscoverPage(
			currentPage,
			currentWindow.beginDate,
			env,
			currentWindow.endDate,
			TMDB_DISCOVER_RETRY_OPTIONS,
		);

		progress.pagesRead += 1;
		progress.totalPagesSeen = Math.max(
			progress.totalPagesSeen ?? 0,
			discoverPage.total_pages,
		);
		pagesProcessed += 1;

		if (
			currentPage === 1 &&
			discoverPage.total_pages > TMDB_DISCOVER_MAX_PAGE
		) {
			const splitWindow = splitDateWindow(currentWindow);

			if (!splitWindow) {
				throw new Error(
					"TMDB original-language backfill reached the Discover page cap for a single-day window.",
				);
			}

			progress.windowsSplit += 1;
			progress.pendingWindows.unshift(splitWindow.right);
			progress.pendingWindows.unshift(splitWindow.left);
			progress.currentWindow = null;
			progress.currentWindowTotalPages = null;
			progress.currentPage = null;
			await saveProgress(
				env,
				jobRunId,
				snapshotProgress(progress, "window-split", attempt),
			);
			continue;
		}

		if (currentPage === 1) {
			progress.currentWindowTotalPages = discoverPage.total_pages;
			progress.windowsLoaded += 1;
		}

		const updateResult = await updateOriginalLanguagesForPage(
			env,
			discoverPage.results,
		);
		progress.rowsSeen += discoverPage.results.length;
		progress.rowsWithoutLanguage += updateResult.rowsWithoutLanguage;
		progress.stagingRowsUpdated += updateResult.stagingRowsUpdated;
		progress.movieListRowsUpdated += updateResult.movieListRowsUpdated;
		progress.lastSuccessfulWindow = currentWindow;
		progress.lastSuccessfulPage = currentPage;

		if (
			currentPage >=
			(progress.currentWindowTotalPages ?? discoverPage.total_pages)
		) {
			progress.currentWindow = null;
			progress.currentWindowTotalPages = null;
			progress.currentPage = null;
		} else {
			progress.currentPage = currentPage + 1;
		}

		const reason =
			progress.pagesRead > 0 &&
			progress.pagesRead % PAGES_PER_QUEUE_MESSAGE === 0
				? "page-batch-read"
				: "page-read";
		const snapshot = snapshotProgress(progress, reason, attempt);
		await saveProgress(env, jobRunId, snapshot);

		if (reason === "page-batch-read") {
			logEvent("tmdb-original-language-backfill-progress", {
				jobRunId,
				pagesRead: snapshot.pagesRead,
				rowsSeen: snapshot.rowsSeen,
				stagingRowsUpdated: snapshot.stagingRowsUpdated,
				movieListRowsUpdated: snapshot.movieListRowsUpdated,
				pendingWindows: snapshot.pendingWindows.length,
			});
		}
	}

	return {
		complete: false,
		progress: snapshotProgress(progress, "queue-message-complete", attempt),
	};
}

async function sendBackfillMessage(
	env: Env,
	message: TmdbOriginalLanguageBackfillQueueMessage,
	delaySeconds = 0,
) {
	if (delaySeconds > 0) {
		await env.TMDB_ENRICHMENT_QUEUE.send(message, { delaySeconds });
		return;
	}

	await env.TMDB_ENRICHMENT_QUEUE.send(message);
}

async function finishBackfill(
	env: Env,
	jobRunId: string,
	progress: TmdbOriginalLanguageBackfillProgress,
	trigger: ImportJobTrigger,
	startedAt: string,
) {
	const coverage = await env.DB.prepare(
		`SELECT
		    (SELECT COUNT(*) FROM tmdb_movies_staging) AS stagingTotal,
		    (
		      SELECT COUNT(*)
		      FROM tmdb_movies_staging
		      WHERE original_language IS NOT NULL
		    ) AS stagingWithLanguage,
		    (SELECT COUNT(*) FROM movie_list_items) AS movieListTotal,
		    (
		      SELECT COUNT(*)
		      FROM movie_list_items
		      WHERE original_language IS NOT NULL
		    ) AS movieListWithLanguage`,
	).first<{
		stagingTotal: number;
		stagingWithLanguage: number;
		movieListTotal: number;
		movieListWithLanguage: number;
	}>();
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const result = {
		...snapshotProgress(progress, "backfill-complete", progress.attempt),
		jobRunId,
		trigger,
		coverage: {
			stagingTotal: coverage?.stagingTotal ?? 0,
			stagingWithLanguage: coverage?.stagingWithLanguage ?? 0,
			movieListTotal: coverage?.movieListTotal ?? 0,
			movieListWithLanguage: coverage?.movieListWithLanguage ?? 0,
		},
		startedAt,
		endedAt,
		durationMs: endedAtMs - parseStoredUtcTimestamp(startedAt),
	};

	await finishImportJobRun(env, jobRunId, {
		status: "complete",
		selected: progress.rowsSeen,
		processed: progress.rowsSeen,
		updated: progress.stagingRowsUpdated,
		result,
	});

	logEvent("tmdb-original-language-backfill-end", result);

	return result;
}

export function isTmdbOriginalLanguageBackfillQueueMessage(
	body: WorkerQueueMessage,
): body is TmdbOriginalLanguageBackfillQueueMessage {
	return (
		"kind" in body && body.kind === "tmdb-original-language-backfill-discovery"
	);
}

export async function processTmdbOriginalLanguageBackfillMessage(
	env: Env,
	message: TmdbOriginalLanguageBackfillQueueMessage,
) {
	const activeJobRun = await getImportJobRunById(env, message.jobRunId);

	if (!activeJobRun || !["running", "queued"].includes(activeJobRun.status)) {
		logEvent("tmdb-original-language-backfill-message-skipped", {
			jobRunId: message.jobRunId,
			messageId: message.messageId,
			status: activeJobRun?.status ?? "missing",
		});
		return;
	}

	const attempt = Math.max(1, message.attempt || 1);
	const progress = parseOriginalLanguageBackfillProgress(
		activeJobRun.result_json,
		message.endDate,
	);
	const workingProgress: TmdbOriginalLanguageBackfillProgress = {
		...progress,
		attempt,
		maxAttempts: MAX_ATTEMPTS,
		error: null,
	};

	try {
		const processed = await processBackfillChunk(
			env,
			message.jobRunId,
			workingProgress,
			attempt,
		);

		if (processed.complete) {
			await finishBackfill(
				env,
				message.jobRunId,
				processed.progress,
				activeJobRun.trigger as ImportJobTrigger,
				activeJobRun.started_at,
			);
			return;
		}

		await sendBackfillMessage(env, {
			kind: "tmdb-original-language-backfill-discovery",
			jobRunId: message.jobRunId,
			messageId: `${message.jobRunId}-${String(
				processed.progress.pagesRead + 1,
			).padStart(6, "0")}`,
			endDate: message.endDate,
			attempt: 1,
		});
	} catch (error) {
		const lastError =
			error instanceof Error
				? error.message
				: "TMDB original-language backfill failed.";
		const nextAttempt = attempt + 1;

		if (attempt < MAX_ATTEMPTS) {
			const retryProgress = snapshotProgress(
				workingProgress,
				"backfill-retry-scheduled",
				nextAttempt,
				lastError,
			);
			await saveProgress(env, message.jobRunId, retryProgress);
			await sendBackfillMessage(
				env,
				{
					kind: "tmdb-original-language-backfill-discovery",
					jobRunId: message.jobRunId,
					messageId: `${message.jobRunId}-retry-${String(nextAttempt).padStart(
						2,
						"0",
					)}`,
					endDate: message.endDate,
					attempt: nextAttempt,
				},
				RETRY_DELAY_SECONDS,
			);

			logEvent("tmdb-original-language-backfill-retry-scheduled", {
				jobRunId: message.jobRunId,
				attempt,
				nextAttempt,
				error: lastError,
			});
			return;
		}

		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			jobRunId: message.jobRunId,
			trigger: activeJobRun.trigger,
			status: "cancelled",
			reason: "backfill-failed-after-retries",
			progress: snapshotProgress(
				workingProgress,
				"backfill-failed-after-retries",
				attempt,
				lastError,
			),
			error: lastError,
			startedAt: activeJobRun.started_at,
			endedAt,
			durationMs: endedAtMs - parseStoredUtcTimestamp(activeJobRun.started_at),
		};

		await finishImportJobRun(env, message.jobRunId, {
			status: "cancelled",
			errors: 1,
			result,
			lastError,
		});

		logEvent("tmdb-original-language-backfill-cancelled", result);
	}
}

export async function enqueueTmdbOriginalLanguageBackfill(
	env: Env,
	trigger: ImportJobTrigger = "manual",
) {
	const nowMs = Date.now();
	const endDate = todayIsoDate(nowMs);
	const activeRun = await getActiveImportJobRun(
		env,
		TMDB_ORIGINAL_LANGUAGE_BACKFILL_JOB_NAME,
	);

	if (activeRun) {
		const minutesWithoutProgress =
			(nowMs - parseStoredUtcTimestamp(activeRun.last_progress_at)) /
			(60 * 1000);

		if (minutesWithoutProgress < RESUME_AFTER_MINUTES_WITHOUT_PROGRESS) {
			return {
				jobRunId: activeRun.job_run_id,
				trigger,
				skipped: true,
				skipReason: "backfill_already_running",
				status: activeRun.status,
				lastProgressAt: activeRun.last_progress_at,
			};
		}

		const storedEndDate = getStoredBackfillEndDate(
			activeRun.result_json,
			endDate,
		);
		const activeProgress = parseOriginalLanguageBackfillProgress(
			activeRun.result_json,
			storedEndDate,
		);
		await sendBackfillMessage(env, {
			kind: "tmdb-original-language-backfill-discovery",
			jobRunId: activeRun.job_run_id,
			messageId: `${activeRun.job_run_id}-manual-resume-${Date.now()}`,
			endDate: activeProgress.endDate,
			attempt: 1,
		});

		return {
			jobRunId: activeRun.job_run_id,
			trigger,
			resumed: true,
			lastProgressAt: activeRun.last_progress_at,
			minutesWithoutProgress,
		};
	}

	const jobRunId = createImportJobRunId(
		TMDB_ORIGINAL_LANGUAGE_BACKFILL_JOB_NAME,
		trigger,
	);
	const progress = buildInitialOriginalLanguageBackfillProgress(endDate);

	await createImportJobRun(env, {
		jobRunId,
		jobName: TMDB_ORIGINAL_LANGUAGE_BACKFILL_JOB_NAME,
		trigger,
	});
	await saveProgress(env, jobRunId, progress);
	await sendBackfillMessage(env, {
		kind: "tmdb-original-language-backfill-discovery",
		jobRunId,
		messageId: `${jobRunId}-000001`,
		endDate,
		attempt: 1,
	});

	const result = {
		jobRunId,
		trigger,
		beginDate: BACKFILL_BEGIN_DATE,
		endDate,
		queued: true,
		startedAt: new Date(nowMs).toISOString(),
	};

	logEvent("tmdb-original-language-backfill-queued", result);

	return result;
}
