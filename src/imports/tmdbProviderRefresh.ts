import {
	getTmdbMovieWatchProviders,
	getTmdbUsFlatrateDiscoverPage,
	getUsFlatrateProviderIdsFromWatchProviders,
	isTerminalTmdbEnrichmentError,
	TMDB_DISCOVER_MAX_PAGE,
	type TmdbFetchRetryOptions,
} from "../externalApis/tmdbClient";
import {
	acquireImportJobLock,
	createJobOwner,
	releaseImportJobLock,
} from "../jobs/importJobLocks";
import {
	cancelImportJobRun,
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getActiveImportJobRun,
	getActiveImportJobRunForDate,
	getImportJobRunById,
	recordImportJobQueueMessageCompletion,
	setImportJobRunQueueTotals,
	touchImportJobRunProgress,
	TMDB_ENRICH_JOB_NAME,
	TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	TMDB_PRIMARY_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import {
	checkImportJobDependencies,
	finishSkippedDependencyRun,
	getLatestCleanImportJobRunWithResultJsonNumberGreaterThan,
	type ImportJobDependencyRequirement,
} from "../jobs/importJobDependencies";
import { logEvent } from "../shared/logging";
import type {
	Env,
	TmdbProviderRefreshDiscoveryQueueMessage,
	TmdbProviderRefreshQueueMessage,
	WorkerQueueMessage,
} from "../shared/types";

type TmdbDateWindow = {
	beginDate: string;
	endDate: string;
};

type TmdbProviderRefreshRow = {
	tmdb_id: number;
};

type TmdbProviderRefreshOptions = {
	trigger: ImportJobTrigger;
	useLock?: boolean;
	nowMs?: number;
};

type TmdbProviderRefreshStats = {
	processed: number;
	updated: number;
	errors: number;
	providerRowsInserted: number;
	tmdbIDNotFoundSkippedCount: number;
};

export function classifyProviderLookupOutcome(
	providerIds: number[] | null,
	error: unknown,
) {
	if (providerIds !== null) {
		return { kind: "providers" as const, providerIds };
	}

	if (isTerminalTmdbEnrichmentError(error)) {
		return { kind: "movie_unavailable" as const };
	}

	return { kind: "retryable_error" as const, error };
}

type TmdbProviderRefreshDiscoveryProgress = {
	phase: "candidate_discovery";
	beginDate: string;
	endDate: string;
	currentWindow: TmdbDateWindow | null;
	currentWindowTotalPages: number | null;
	currentPage: number | null;
	pagesRead: number;
	rowsSeen: number;
	totalPagesSeen: number | null;
	windowsLoaded: number;
	windowsSplit: number;
	pendingWindows: TmdbDateWindow[];
	lastSuccessfulWindow: TmdbDateWindow | null;
	lastSuccessfulPage: number | null;
	attempt: number;
	maxAttempts: number;
	status: "running" | "complete";
	reason: string;
	error?: string | null;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TMDB_PROVIDER_REFRESH_BEGIN_DATE = "1874-01-01";
const TMDB_PROVIDER_REFRESH_LOCK_MINUTES = 30;
const TMDB_PROVIDER_REFRESH_STALE_RUN_MINUTES = 60;
const TMDB_PROVIDER_DISCOVERY_PROGRESS_HEARTBEAT_MS = 30 * 1000;
const TMDB_PROVIDER_DISCOVERY_PAGES_PER_QUEUE_MESSAGE = 50;
const TMDB_PROVIDER_DISCOVERY_MAX_ATTEMPTS = 10;
const TMDB_PROVIDER_DISCOVERY_RETRY_DELAY_SECONDS = 10;
const TMDB_PROVIDER_REFRESH_IDS_PER_QUEUE_MESSAGE = 25;
const TMDB_PROVIDER_REFRESH_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_PROVIDER_REFRESH_D1_BATCH_MOVIES = 25;
const TMDB_PROVIDER_REFRESH_TMDB_CONCURRENCY = 25;
const TMDB_ENRICHMENT_QUEUE_NAME = "movieapp-tmdb-enrichment-queue";
const TMDB_PROVIDER_DISCOVER_RETRY_OPTIONS: TmdbFetchRetryOptions = {
	maxAttempts: 10,
	retryDelayMs: 2000,
};

class TmdbProviderRefreshDiscoveryError extends Error {
	constructor(
		message: string,
		readonly progress: TmdbProviderRefreshDiscoveryProgress,
	) {
		super(message);
		this.name = "TmdbProviderRefreshDiscoveryError";
	}
}

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

function parseStoredUtcTimestamp(value: string) {
	const parsed = Date.parse(`${value.replace(" ", "T")}Z`);
	return Number.isFinite(parsed) ? parsed : Date.now();
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

export function isTmdbProviderRefreshQueueMessage(
	body: WorkerQueueMessage,
): body is TmdbProviderRefreshQueueMessage {
	return "kind" in body && body.kind === "tmdb-provider-refresh";
}

export function isTmdbProviderRefreshDiscoveryQueueMessage(
	body: WorkerQueueMessage,
): body is TmdbProviderRefreshDiscoveryQueueMessage {
	return "kind" in body && body.kind === "tmdb-provider-refresh-discovery";
}

function buildProviderRefreshStatements(
	tmdbId: number,
	providerIds: number[],
	env: Env,
	loadRunId: string,
) {
	const statements: D1PreparedStatement[] = [];

	for (const providerId of providerIds) {
		statements.push(
			env.DB.prepare(
				`INSERT OR REPLACE INTO movie_watch_providers_staging (
					tmdb_id,
					provider_id,
					region,
					load_run_id,
					is_full_refresh,
					staged_at,
					promoted_at
				)
				VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, NULL)`,
			).bind(tmdbId, providerId, "US", loadRunId),
		);
	}

	return statements;
}

function buildInitialDiscoveryCheckpoint(
	endDate: string,
	reason = "discovery-queued",
): TmdbProviderRefreshDiscoveryProgress {
	return {
		phase: "candidate_discovery",
		status: "running",
		reason,
		beginDate: TMDB_PROVIDER_REFRESH_BEGIN_DATE,
		endDate,
		currentWindow: null,
		currentWindowTotalPages: null,
		currentPage: null,
		pagesRead: 0,
		rowsSeen: 0,
		totalPagesSeen: null,
		windowsLoaded: 0,
		windowsSplit: 0,
		pendingWindows: [
			{ beginDate: TMDB_PROVIDER_REFRESH_BEGIN_DATE, endDate },
		],
		lastSuccessfulWindow: null,
		lastSuccessfulPage: null,
		attempt: 1,
		maxAttempts: TMDB_PROVIDER_DISCOVERY_MAX_ATTEMPTS,
		error: null,
	};
}

function cloneWindow(window: TmdbDateWindow | null) {
	return window ? { ...window } : null;
}

function cloneWindows(windows: TmdbDateWindow[]) {
	return windows.map((window) => ({ ...window }));
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

function parseDiscoveryCheckpoint(
	resultJson: string | null,
	endDate: string,
): TmdbProviderRefreshDiscoveryProgress {
	if (!resultJson) {
		return buildInitialDiscoveryCheckpoint(endDate);
	}

	try {
		const parsed = JSON.parse(resultJson) as Partial<TmdbProviderRefreshDiscoveryProgress>;

		if (
			parsed.phase !== "candidate_discovery" ||
			parsed.endDate !== endDate ||
			!Array.isArray(parsed.pendingWindows)
		) {
			return buildInitialDiscoveryCheckpoint(endDate);
		}

		const status: TmdbProviderRefreshDiscoveryProgress["status"] =
			parsed.status === "complete" ? "complete" : "running";

		return {
			...buildInitialDiscoveryCheckpoint(endDate),
			...parsed,
			currentWindow: isDateWindow(parsed.currentWindow)
				? { ...parsed.currentWindow }
				: null,
			currentWindowTotalPages:
				typeof parsed.currentWindowTotalPages === "number"
					? parsed.currentWindowTotalPages
					: null,
			currentPage:
				typeof parsed.currentPage === "number" ? parsed.currentPage : null,
			pendingWindows: parsed.pendingWindows.filter(isDateWindow).map((window) => ({
				...window,
			})),
			lastSuccessfulWindow: isDateWindow(parsed.lastSuccessfulWindow)
				? { ...parsed.lastSuccessfulWindow }
				: null,
			lastSuccessfulPage:
				typeof parsed.lastSuccessfulPage === "number"
					? parsed.lastSuccessfulPage
					: null,
			status,
			reason: parsed.reason ?? "checkpoint-loaded",
			attempt:
				typeof parsed.attempt === "number" && parsed.attempt > 0
					? parsed.attempt
					: 1,
			maxAttempts: TMDB_PROVIDER_DISCOVERY_MAX_ATTEMPTS,
		};
	} catch {
		return buildInitialDiscoveryCheckpoint(endDate);
	}
}

function snapshotDiscoveryCheckpoint(
	checkpoint: TmdbProviderRefreshDiscoveryProgress,
	reason: string,
	attempt: number,
	error?: string | null,
): TmdbProviderRefreshDiscoveryProgress {
	return {
		...checkpoint,
		reason,
		attempt,
		maxAttempts: TMDB_PROVIDER_DISCOVERY_MAX_ATTEMPTS,
		currentWindow: cloneWindow(checkpoint.currentWindow),
		pendingWindows: cloneWindows(checkpoint.pendingWindows),
		lastSuccessfulWindow: cloneWindow(checkpoint.lastSuccessfulWindow),
		error: error ?? null,
	};
}

function logDiscoveryProgress(
	jobRunId: string,
	checkpoint: TmdbProviderRefreshDiscoveryProgress,
	reason: string,
) {
	logEvent("tmdb-provider-refresh-discovery-progress", {
		trigger: "candidate-discovery",
		jobRunId,
		...snapshotDiscoveryCheckpoint(checkpoint, reason, checkpoint.attempt),
		pendingWindows: checkpoint.pendingWindows.length,
	});
}

async function saveDiscoveryCheckpoint(
	env: Env,
	jobRunId: string,
	checkpoint: TmdbProviderRefreshDiscoveryProgress,
	candidateIds: number[] = [],
) {
	const statements = candidateIds.map((tmdbId) =>
		env.DB.prepare(
			`INSERT OR REPLACE INTO tmdb_us_flatrate_movies_staging (
				tmdb_id,
				load_run_id,
				discovered_at
			)
			VALUES (?, ?, CURRENT_TIMESTAMP)`,
		).bind(tmdbId, jobRunId),
	);

	statements.push(
		env.DB.prepare(
			`UPDATE import_job_runs
			 SET last_progress_at = CURRENT_TIMESTAMP,
			     result_json = ?,
			     last_error = COALESCE(?, last_error)
			 WHERE job_run_id = ?
			   AND status IN ('running', 'queued')`,
		).bind(JSON.stringify(checkpoint), checkpoint.error ?? null, jobRunId),
	);

	await env.DB.batch(statements);
}

async function countProviderRefreshCandidateRows(env: Env, jobRunId: string) {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS candidateCount
		 FROM tmdb_us_flatrate_movies_staging
		 WHERE load_run_id = ?`,
	)
		.bind(jobRunId)
		.first<{ candidateCount: number }>();

	return row?.candidateCount ?? 0;
}

async function processDiscoveryChunk(
	env: Env,
	jobRunId: string,
	checkpoint: TmdbProviderRefreshDiscoveryProgress,
	attempt: number,
) {
	let pagesProcessed = 0;
	let lastHeartbeatAtMs = 0;

	async function maybeHeartbeat(reason: string, force = false) {
		const nowMs = Date.now();

		if (
			!force &&
			nowMs - lastHeartbeatAtMs <
				TMDB_PROVIDER_DISCOVERY_PROGRESS_HEARTBEAT_MS
		) {
			return;
		}

		lastHeartbeatAtMs = nowMs;
		await touchImportJobRunProgress(env, jobRunId, {
			result: snapshotDiscoveryCheckpoint(checkpoint, reason, attempt),
		});
	}

	await maybeHeartbeat("discovery-message-started", true);

	while (pagesProcessed < TMDB_PROVIDER_DISCOVERY_PAGES_PER_QUEUE_MESSAGE) {
		if (!checkpoint.currentWindow) {
			const nextWindow = checkpoint.pendingWindows.shift();

			if (!nextWindow) {
				checkpoint.status = "complete";
				checkpoint.reason = "discovery-complete";
				await saveDiscoveryCheckpoint(
					env,
					jobRunId,
					snapshotDiscoveryCheckpoint(checkpoint, "discovery-complete", attempt),
				);
				return { complete: true, checkpoint };
			}

			checkpoint.currentWindow = nextWindow;
			checkpoint.currentWindowTotalPages = null;
			checkpoint.currentPage = 1;
			await maybeHeartbeat("window-started", true);
		}

		const currentWindow = checkpoint.currentWindow;
		const currentPage = checkpoint.currentPage ?? 1;
		const discoverPage = await getTmdbUsFlatrateDiscoverPage(
			currentPage,
			currentWindow.beginDate,
			env,
			currentWindow.endDate,
			TMDB_PROVIDER_DISCOVER_RETRY_OPTIONS,
		);

		checkpoint.pagesRead += 1;
		checkpoint.totalPagesSeen = Math.max(
			checkpoint.totalPagesSeen ?? 0,
			discoverPage.total_pages,
		);
		pagesProcessed += 1;

		if (currentPage === 1 && discoverPage.total_pages > TMDB_DISCOVER_MAX_PAGE) {
			const splitWindow = splitDateWindow(currentWindow);

			if (!splitWindow) {
				throw new TmdbProviderRefreshDiscoveryError(
					"TMDB provider refresh Discover reached the TMDB page cap for a single-day window.",
					snapshotDiscoveryCheckpoint(
						checkpoint,
						"single-day-page-cap-reached",
						attempt,
					),
				);
			}

			checkpoint.windowsSplit += 1;
			checkpoint.pendingWindows.unshift(splitWindow.right);
			checkpoint.pendingWindows.unshift(splitWindow.left);
			checkpoint.currentWindow = null;
			checkpoint.currentWindowTotalPages = null;
			checkpoint.currentPage = null;

			const snapshot = snapshotDiscoveryCheckpoint(
				checkpoint,
				"window-split",
				attempt,
			);
			logDiscoveryProgress(jobRunId, snapshot, "window-split");
			await saveDiscoveryCheckpoint(env, jobRunId, snapshot);
			continue;
		}

		if (currentPage === 1) {
			checkpoint.currentWindowTotalPages = discoverPage.total_pages;
			checkpoint.windowsLoaded += 1;
			logDiscoveryProgress(jobRunId, checkpoint, "window-loaded");
		}

		const candidateIds = discoverPage.results.map((movie) => movie.id);
		checkpoint.rowsSeen += discoverPage.results.length;
		checkpoint.lastSuccessfulWindow = currentWindow;
		checkpoint.lastSuccessfulPage = currentPage;

		if (currentPage >= (checkpoint.currentWindowTotalPages ?? discoverPage.total_pages)) {
			checkpoint.currentWindow = null;
			checkpoint.currentWindowTotalPages = null;
			checkpoint.currentPage = null;
		} else {
			checkpoint.currentPage = currentPage + 1;
		}

		const reason =
			checkpoint.pagesRead > 0 && checkpoint.pagesRead % 50 === 0
				? "page-batch-read"
				: "page-read";
		const snapshot = snapshotDiscoveryCheckpoint(checkpoint, reason, attempt);

		if (reason === "page-batch-read") {
			logDiscoveryProgress(jobRunId, snapshot, reason);
		}

		await saveDiscoveryCheckpoint(env, jobRunId, snapshot, candidateIds);
	}

	return { complete: false, checkpoint };
}

async function getProviderRefreshCandidateRows(env: Env, jobRunId: string) {
	const { results } = await env.DB.prepare(
		`SELECT tmdb_id
		 FROM tmdb_us_flatrate_movies_staging
		 WHERE load_run_id = ?
		 ORDER BY tmdb_id`,
	)
		.bind(jobRunId)
		.all<TmdbProviderRefreshRow>();

	return results;
}

async function queueProviderRefreshCandidateRows(
	env: Env,
	jobRunId: string,
	trigger: ImportJobTrigger,
	startedAt: string,
	endDate: string,
	discovery: TmdbProviderRefreshDiscoveryProgress,
) {
	const rows = await getProviderRefreshCandidateRows(env, jobRunId);
	let queueMessages: TmdbProviderRefreshQueueMessage[] = [];
	let rowsQueued = 0;
	let messagesQueued = 0;
	let messageNumber = 0;

	async function flushQueueMessages() {
		if (queueMessages.length === 0) {
			return;
		}

		await env.TMDB_ENRICHMENT_QUEUE.sendBatch(
			queueMessages.map((message) => ({ body: message })),
		);

		messagesQueued += queueMessages.length;
		queueMessages = [];
	}

	for (
		let index = 0;
		index < rows.length;
		index += TMDB_PROVIDER_REFRESH_IDS_PER_QUEUE_MESSAGE
	) {
		const tmdbIds = rows
			.slice(index, index + TMDB_PROVIDER_REFRESH_IDS_PER_QUEUE_MESSAGE)
			.map((row) => row.tmdb_id);
		messageNumber += 1;

		queueMessages.push({
			kind: "tmdb-provider-refresh",
			jobRunId,
			messageId: `${jobRunId}-${String(messageNumber).padStart(6, "0")}`,
			tmdbIds,
		});
		rowsQueued += tmdbIds.length;

		if (
			queueMessages.length >=
			TMDB_PROVIDER_REFRESH_QUEUE_MESSAGES_PER_SEND_BATCH
		) {
			await flushQueueMessages();
		}
	}

	await flushQueueMessages();

	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const candidateCount = await countProviderRefreshCandidateRows(env, jobRunId);

	await env.DB.prepare(
		`DELETE FROM tmdb_us_flatrate_movies_staging
		 WHERE load_run_id <> ?`,
	)
		.bind(jobRunId)
		.run();

	const result = {
		trigger,
		beginDate: TMDB_PROVIDER_REFRESH_BEGIN_DATE,
		endDate,
		candidateCount,
		pagesRead: discovery.pagesRead,
		rowsSeen: discovery.rowsSeen,
		totalPagesSeen: discovery.totalPagesSeen,
		windowsLoaded: discovery.windowsLoaded,
		windowsSplit: discovery.windowsSplit,
		pendingWindows: discovery.pendingWindows.length,
		stoppedWindow: null,
		stopReason: "end_of_windows",
		selected: rows.length,
		rowsQueued,
		messagesQueued,
		jobRunId,
		startedAt,
		endedAt,
		durationMs: endedAtMs - parseStoredUtcTimestamp(startedAt),
	};

	if (rows.length === 0) {
		await finishImportJobRun(env, jobRunId, {
			status: "complete",
			result,
		});
	} else {
		await setImportJobRunQueueTotals(env, jobRunId, {
			selected: rows.length,
			queued: rowsQueued,
			result,
		});
	}

	logEvent("tmdb-provider-refresh-enqueue-end", result);

	return result;
}

async function cancelStaleProviderRefreshRuns(env: Env) {
	const { results } = await env.DB.prepare(
		`SELECT job_run_id,
		        status,
		        selected_count,
		        queued_count,
		        processed_count,
		        updated_count,
		        error_count,
		        provider_rows_inserted,
		        started_at,
		        last_progress_at
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status IN ('queued', 'running')
		   AND last_progress_at < datetime('now', '-' || ? || ' minutes')
		 ORDER BY started_at`,
	)
		.bind(TMDB_PROVIDER_REFRESH_JOB_NAME, TMDB_PROVIDER_REFRESH_STALE_RUN_MINUTES)
		.all<{
			job_run_id: string;
			status: string;
			selected_count: number;
			queued_count: number;
			processed_count: number;
			updated_count: number;
			error_count: number;
			provider_rows_inserted: number;
			started_at: string;
			last_progress_at: string;
		}>();

	for (const run of results) {
		const lastError = `Cancelled stale ${TMDB_PROVIDER_REFRESH_JOB_NAME} run after more than ${TMDB_PROVIDER_REFRESH_STALE_RUN_MINUTES} minutes without progress.`;

		await cancelImportJobRun(env, run.job_run_id, {
			errors: 1,
			result: {
				jobRunId: run.job_run_id,
				status: "cancelled",
				reason: "stale_provider_refresh_run",
				previousStatus: run.status,
				selectedCount: run.selected_count,
				queuedCount: run.queued_count,
				processedCount: run.processed_count,
				updatedCount: run.updated_count,
				errorCount: run.error_count,
				providerRowsInserted: run.provider_rows_inserted,
				startedAt: run.started_at,
				lastProgressAt: run.last_progress_at,
				staleAfterMinutes: TMDB_PROVIDER_REFRESH_STALE_RUN_MINUTES,
			},
			lastError,
		});

		logEvent("tmdb-provider-refresh-stale-run-cancelled", {
			jobRunId: run.job_run_id,
			startedAt: run.started_at,
			lastProgressAt: run.last_progress_at,
			staleAfterMinutes: TMDB_PROVIDER_REFRESH_STALE_RUN_MINUTES,
		});
	}
}

async function sendProviderRefreshDiscoveryMessage(
	env: Env,
	message: TmdbProviderRefreshDiscoveryQueueMessage,
	delaySeconds = 0,
) {
	if (delaySeconds > 0) {
		await env.TMDB_ENRICHMENT_QUEUE.send(message, { delaySeconds });
		return;
	}

	await env.TMDB_ENRICHMENT_QUEUE.send(message);
}

export async function processTmdbProviderRefreshDiscoveryMessage(
	env: Env,
	message: TmdbProviderRefreshDiscoveryQueueMessage,
) {
	const activeJobRun = await getImportJobRunById(env, message.jobRunId);

	if (
		!activeJobRun ||
		!["running", "queued"].includes(activeJobRun.status) ||
		activeJobRun.selected_count > 0
	) {
		logEvent("tmdb-provider-refresh-discovery-message-skipped", {
			jobRunId: message.jobRunId,
			messageId: message.messageId,
			status: activeJobRun?.status ?? "missing",
			selected: activeJobRun?.selected_count ?? 0,
		});
		return;
	}

	const attempt = Math.max(1, message.attempt || 1);
	const checkpoint = parseDiscoveryCheckpoint(
		activeJobRun.result_json,
		message.endDate,
	);

	try {
		const discovery = await processDiscoveryChunk(
			env,
			message.jobRunId,
			{
				...checkpoint,
				attempt,
				maxAttempts: TMDB_PROVIDER_DISCOVERY_MAX_ATTEMPTS,
				error: null,
			},
			attempt,
		);

		if (discovery.complete) {
			await queueProviderRefreshCandidateRows(
				env,
				message.jobRunId,
				activeJobRun.trigger as ImportJobTrigger,
				activeJobRun.started_at,
				message.endDate,
				discovery.checkpoint,
			);
			return;
		}

		await sendProviderRefreshDiscoveryMessage(env, {
			kind: "tmdb-provider-refresh-discovery",
			jobRunId: message.jobRunId,
			messageId: `${message.jobRunId}-discovery-${String(
				discovery.checkpoint.pagesRead + 1,
			).padStart(6, "0")}`,
			endDate: message.endDate,
			attempt: 1,
		});
	} catch (error) {
		const lastError =
			error instanceof Error
				? error.message
				: "TMDB provider refresh Discover candidate build failed.";
		const discoveryProgress =
			error instanceof TmdbProviderRefreshDiscoveryError
				? error.progress
				: checkpoint;
		const nextAttempt = attempt + 1;

		if (attempt < TMDB_PROVIDER_DISCOVERY_MAX_ATTEMPTS) {
			const retryCheckpoint = snapshotDiscoveryCheckpoint(
				discoveryProgress,
				"discovery-retry-scheduled",
				nextAttempt,
				lastError,
			);

			await saveDiscoveryCheckpoint(env, message.jobRunId, retryCheckpoint);
			await sendProviderRefreshDiscoveryMessage(
				env,
				{
					kind: "tmdb-provider-refresh-discovery",
					jobRunId: message.jobRunId,
					messageId: `${message.jobRunId}-discovery-retry-${String(
						nextAttempt,
					).padStart(2, "0")}`,
					endDate: message.endDate,
					attempt: nextAttempt,
				},
				TMDB_PROVIDER_DISCOVERY_RETRY_DELAY_SECONDS,
			);

			logEvent("tmdb-provider-refresh-discovery-retry-scheduled", {
				jobRunId: message.jobRunId,
				messageId: message.messageId,
				attempt,
				nextAttempt,
				maxAttempts: TMDB_PROVIDER_DISCOVERY_MAX_ATTEMPTS,
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
			reason: "tmdb_provider_refresh_discovery_failed_after_retries",
			phase: discoveryProgress.phase,
			discoveryProgress: snapshotDiscoveryCheckpoint(
				discoveryProgress,
				"discovery-failed-after-retries",
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

		logEvent("tmdb-provider-refresh-cancelled", result);
	}
}

export async function enqueueTmdbProviderRefreshJob(
	env: Env,
	options: TmdbProviderRefreshOptions,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const lockOwner = createJobOwner(options.trigger);
	const jobRunId = createImportJobRunId(
		TMDB_PROVIDER_REFRESH_JOB_NAME,
		options.trigger,
	);
	const endDate = todayIsoDate(options.nowMs ?? startedAtMs);
	let lockAcquired = false;
	let jobRunCreated = false;

	if (options.useLock) {
		lockAcquired = await acquireImportJobLock(
			env,
			TMDB_PROVIDER_REFRESH_JOB_NAME,
			lockOwner,
			TMDB_PROVIDER_REFRESH_LOCK_MINUTES,
		);

		if (!lockAcquired) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "job_already_running",
				jobRunId: null,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};
		}
	}

	try {
		const latestPrimaryWithNewMovieIds =
			await getLatestCleanImportJobRunWithResultJsonNumberGreaterThan(env, {
				jobName: TMDB_PRIMARY_JOB_NAME,
				resultJsonPath: "$.rowsInserted",
				greaterThan: 0,
				runDate: startedAt.slice(0, 10),
			});
		const dependencyRequirements: ImportJobDependencyRequirement[] = [
			{ jobName: TMDB_PRIMARY_JOB_NAME },
		];

		if (latestPrimaryWithNewMovieIds) {
			dependencyRequirements.push({
				jobName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
				endedAfter: latestPrimaryWithNewMovieIds.ended_at,
				endedAfterLabel:
					"latest TMDB primary run that inserted new movie IDs",
			});
		}

		const dependencies = await checkImportJobDependencies(
			env,
			dependencyRequirements,
			startedAt.slice(0, 10),
		);

		if (!dependencies.ok) {
			return finishSkippedDependencyRun(env, {
				jobRunId,
				jobName: TMDB_PROVIDER_REFRESH_JOB_NAME,
				trigger: options.trigger,
				startedAtMs,
				startedAt,
				blockers: dependencies.blockers,
			});
		}

		await cancelStaleProviderRefreshRuns(env);

		const runDate = startedAt.slice(0, 10);
		const activeProviderRun = await getActiveImportJobRunForDate(
			env,
			TMDB_PROVIDER_REFRESH_JOB_NAME,
			runDate,
		);
		const activeEnrichmentRun = await getActiveImportJobRunForDate(
			env,
			TMDB_ENRICH_JOB_NAME,
			runDate,
		);
		const activeRun = activeProviderRun ?? activeEnrichmentRun;

		if (activeRun) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "tmdb_provider_or_enrichment_job_active",
				activeJobRunId: activeRun.job_run_id,
				activeJobName: activeRun.job_name,
				activeStatus: activeRun.status,
				activeSelected: activeRun.selected_count,
				activeProcessed: activeRun.processed_count,
				jobRunId: null,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};
		}

		await createImportJobRun(env, {
			jobRunId,
			jobName: TMDB_PROVIDER_REFRESH_JOB_NAME,
			trigger: options.trigger,
		});
		jobRunCreated = true;

		logEvent("tmdb-provider-refresh-enqueue-start", {
			trigger: options.trigger,
			jobRunId,
			beginDate: TMDB_PROVIDER_REFRESH_BEGIN_DATE,
			endDate,
			startedAt,
		});

		const checkpoint = buildInitialDiscoveryCheckpoint(
			endDate,
			"discovery-queued",
		);

		await saveDiscoveryCheckpoint(env, jobRunId, checkpoint);
		await sendProviderRefreshDiscoveryMessage(env, {
			kind: "tmdb-provider-refresh-discovery",
			jobRunId,
			messageId: `${jobRunId}-discovery-000001`,
			endDate,
			attempt: 1,
		});

		const queuedAtMs = Date.now();
		const queuedAt = new Date(queuedAtMs).toISOString();
		const result = {
			trigger: options.trigger,
			beginDate: TMDB_PROVIDER_REFRESH_BEGIN_DATE,
			endDate,
			phase: "candidate_discovery",
			discoveryQueued: true,
			discoveryMessageId: `${jobRunId}-discovery-000001`,
			jobRunId,
			startedAt,
			queuedAt,
			durationMs: queuedAtMs - startedAtMs,
		};

		logEvent("tmdb-provider-refresh-discovery-queued", result);

		return result;
	} catch (error) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const lastError =
			error instanceof Error ? error.message : "TMDB provider refresh failed.";
		const discoveryProgress =
			error instanceof TmdbProviderRefreshDiscoveryError
				? error.progress
				: null;

		const result = {
			jobRunId,
			trigger: options.trigger,
			status: "cancelled",
			reason: "tmdb_provider_refresh_enqueue_error",
			phase: discoveryProgress?.phase ?? "enqueue",
			discoveryProgress,
			error: lastError,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		if (jobRunCreated) {
			await finishImportJobRun(env, jobRunId, {
				status: "cancelled",
				errors: 1,
				result,
				lastError,
			});
		}

		logEvent("tmdb-provider-refresh-cancelled", result);

		throw error;
	} finally {
		if (options.useLock && lockAcquired) {
			await releaseImportJobLock(
				env,
				TMDB_PROVIDER_REFRESH_JOB_NAME,
				lockOwner,
			);
		}
	}
}

export async function processTmdbProviderRefreshRows(
	env: Env,
	jobRunId: string,
	rows: TmdbProviderRefreshRow[],
	trigger: "queue",
	messageId?: string,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	let processed = 0;
	let updated = 0;
	let errors = 0;
	let providerRowsInserted = 0;
	let tmdbIDNotFoundSkippedCount = 0;
	let lastError: string | null = null;
	let pendingStatements: D1PreparedStatement[] = [];
	let pendingStatementMovies = 0;
	const activeJobRun = await getImportJobRunById(env, jobRunId);

	if (
		!activeJobRun ||
		!["running", "queued"].includes(activeJobRun.status)
	) {
		logEvent("tmdb-provider-refresh-queue-message-skipped", {
			trigger,
			jobRunId,
			status: activeJobRun?.status ?? "missing",
			selected: rows.length,
		});

		return {
			processed: 0,
			updated: 0,
			errors: 0,
			providerRowsInserted: 0,
			tmdbIDNotFoundSkippedCount: 0,
		};
	}

	async function flushStatements() {
		if (pendingStatements.length === 0) {
			return;
		}

		await env.DB.batch(pendingStatements);
		pendingStatements = [];
		pendingStatementMovies = 0;
	}

	logEvent("tmdb-provider-refresh-queue-message-start", {
		trigger,
		jobRunId,
		selected: rows.length,
		tmdbConcurrency: TMDB_PROVIDER_REFRESH_TMDB_CONCURRENCY,
		startedAt,
	});

	for (
		let index = 0;
		index < rows.length;
		index += TMDB_PROVIDER_REFRESH_TMDB_CONCURRENCY
	) {
		const rowChunk = rows.slice(
			index,
			index + TMDB_PROVIDER_REFRESH_TMDB_CONCURRENCY,
		);
		const providerResults = await Promise.all(
			rowChunk.map(async (row) => {
				try {
					const watchProviders = await getTmdbMovieWatchProviders(
						row.tmdb_id,
						env,
					);
					return {
						row,
						providerIds:
							getUsFlatrateProviderIdsFromWatchProviders(watchProviders),
						error: null,
					};
				} catch (error) {
					return {
						row,
						providerIds: null,
						error,
					};
				}
			}),
		);
		const retryableErrorResult = providerResults.find(
			(result) =>
				classifyProviderLookupOutcome(result.providerIds, result.error).kind ===
				"retryable_error",
		);

		if (retryableErrorResult?.error) {
			await flushStatements();

			lastError =
				retryableErrorResult.error instanceof Error
					? retryableErrorResult.error.message
					: String(retryableErrorResult.error);

			const cancelledAtMs = Date.now();
			const cancelledAt = new Date(cancelledAtMs).toISOString();
			const result = {
				jobRunId,
				trigger,
				status: "cancelled",
				reason: "retryable_tmdb_failure_after_retries",
				tmdbId: retryableErrorResult.row.tmdb_id,
				error: lastError,
				processedInMessage: processed,
				updatedInMessage: updated,
				errorsInMessage: errors + 1,
				providerRowsInsertedInMessage: providerRowsInserted,
				startedAt,
				cancelledAt,
				durationMs: cancelledAtMs - startedAtMs,
			};

			await cancelImportJobRun(env, jobRunId, {
				processed,
				updated,
				errors: errors + 1,
				providerRowsInserted,
				result,
				lastError,
			});

			logEvent("tmdb-provider-refresh-cancelled", result);

			return {
				processed,
				updated,
				errors: errors + 1,
				providerRowsInserted,
				tmdbIDNotFoundSkippedCount,
			};
		}

		for (const result of providerResults) {
			const outcome = classifyProviderLookupOutcome(
				result.providerIds,
				result.error,
			);

			if (outcome.kind === "providers") {
				pendingStatements.push(
					...buildProviderRefreshStatements(
						result.row.tmdb_id,
						outcome.providerIds,
						env,
						jobRunId,
					),
				);
				pendingStatementMovies += 1;
				updated += 1;
				providerRowsInserted += outcome.providerIds.length;

				if (pendingStatementMovies > TMDB_PROVIDER_REFRESH_D1_BATCH_MOVIES) {
					await flushStatements();
				}
			} else if (outcome.kind === "movie_unavailable") {
				// A missing TMDB provider resource is an accepted result. The full
				// refresh promotion rebuilds the live US provider table from this
				// run, so inserting no provider rows removes any obsolete providers.
				updated += 1;
				tmdbIDNotFoundSkippedCount += 1;

				logEvent("tmdb-provider-refresh-movie-unavailable", {
					trigger,
					jobRunId,
					tmdbId: result.row.tmdb_id,
					outcome: "accepted_no_provider_rows",
				});
			}

			processed += 1;
		}
	}

	const stats: TmdbProviderRefreshStats = {
		processed,
		updated,
		errors,
		providerRowsInserted,
		tmdbIDNotFoundSkippedCount,
	};

	await recordImportJobQueueMessageCompletion(env, {
		jobRunId,
		messageId:
			messageId ??
			`${jobRunId}-legacy-tmdb-provider-refresh-${
				rows[0]?.tmdb_id ?? "first"
			}-${rows[rows.length - 1]?.tmdb_id ?? "last"}-${rows.length}`,
		jobName: TMDB_PROVIDER_REFRESH_JOB_NAME,
		queueName: TMDB_ENRICHMENT_QUEUE_NAME,
		stats,
		lastError,
		dataStatements: pendingStatements,
	});
	pendingStatements = [];
	pendingStatementMovies = 0;

	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	logEvent("tmdb-provider-refresh-queue-message-end", {
		trigger,
		jobRunId,
		selected: rows.length,
		...stats,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
	});

	return stats;
}
