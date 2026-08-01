import {
	acquireImportJobLock,
	createJobOwner,
	releaseImportJobLock,
} from "../jobs/importJobLocks";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getActiveImportJobRun,
	getImportJobRunById,
	recordImportJobQueueMessageCompletion,
	setImportJobRunQueueTotals,
	TMDB_POPULARITY_REFRESH_JOB_NAME,
	type ImportJobTrigger,
} from "../jobs/importJobRuns";
import { logEvent } from "../shared/logging";
import type {
	Env,
	TmdbPopularityFinalizeQueueMessage,
	TmdbPopularityQueueMessage,
	TmdbPopularityRow,
} from "../shared/types";

const TMDB_POPULARITY_EXPORT_BASE_URL =
	"https://files.tmdb.org/p/exports";
const TMDB_POPULARITY_ROWS_PER_MESSAGE = 25;
const TMDB_POPULARITY_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_POPULARITY_QUEUE_NAME = "movieapp-tmdb-popularity-import-queue";
const TMDB_POPULARITY_LOCK_MINUTES = 30;
const TMDB_POPULARITY_MINIMUM_ROWS = 900000;
const TMDB_POPULARITY_MINIMUM_MOVIE_LIST_OVERLAP_RATIO = 0.9;
const TMDB_POPULARITY_MINIMUM_PREVIOUS_RUN_RATIO = 0.9;
const TMDB_POPULARITY_MAX_SOURCE_AGE_DAYS = 2;
const TMDB_POPULARITY_DOWNLOAD_ATTEMPTS_PER_DATE = 3;

type TmdbPopularityExportLine = {
	adult?: unknown;
	id?: unknown;
	original_title?: unknown;
	popularity?: unknown;
	video?: unknown;
};

function isIsoDate(value: string) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseIsoDateUtc(value: string) {
	if (!isIsoDate(value)) {
		throw new Error("TMDb popularity source date must use YYYY-MM-DD format.");
	}

	const parsed = Date.parse(`${value}T00:00:00.000Z`);

	if (!Number.isFinite(parsed)) {
		throw new Error("TMDb popularity source date is invalid.");
	}

	return parsed;
}

export function getDefaultTmdbPopularitySourceDate(nowMs = Date.now()) {
	return new Date(nowMs).toISOString().slice(0, 10);
}

export function buildTmdbPopularityExportUrl(sourceDate: string) {
	parseIsoDateUtc(sourceDate);
	const [year, month, day] = sourceDate.split("-");
	return `${TMDB_POPULARITY_EXPORT_BASE_URL}/movie_ids_${month}_${day}_${year}.json.gz`;
}

export function validateTmdbPopularitySourceDate(
	sourceDate: string,
	nowMs = Date.now(),
) {
	const sourceMs = parseIsoDateUtc(sourceDate);
	const todayMs = Date.parse(
		`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`,
	);
	const ageDays = Math.floor((todayMs - sourceMs) / (24 * 60 * 60 * 1000));

	if (ageDays < 0) {
		throw new Error("TMDb popularity source date cannot be in the future.");
	}

	if (ageDays > TMDB_POPULARITY_MAX_SOURCE_AGE_DAYS) {
		throw new Error(
			`TMDb popularity source date is ${ageDays} day(s) old; the maximum is ${TMDB_POPULARITY_MAX_SOURCE_AGE_DAYS}.`,
		);
	}

	return ageDays;
}

function subtractUtcDays(sourceDate: string, days: number) {
	return new Date(parseIsoDateUtc(sourceDate) - days * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);
}

async function waitForRetry(delayMs: number) {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, delayMs);
	});
}

export async function fetchTmdbPopularityExport(options: {
	requestedSourceDate: string;
	allowOneDayFallback: boolean;
	nowMs: number;
}) {
	const sourceDates = [options.requestedSourceDate];

	if (options.allowOneDayFallback) {
		sourceDates.push(subtractUtcDays(options.requestedSourceDate, 1));
	}

	let lastFailure = "TMDb popularity export was unavailable.";

	for (const sourceDate of sourceDates) {
		const sourceAgeDays = validateTmdbPopularitySourceDate(
			sourceDate,
			options.nowMs,
		);
		const sourceUrl = buildTmdbPopularityExportUrl(sourceDate);

		for (
			let attempt = 1;
			attempt <= TMDB_POPULARITY_DOWNLOAD_ATTEMPTS_PER_DATE;
			attempt += 1
		) {
			try {
				const response = await fetch(sourceUrl);

				if (response.ok && response.body) {
					return {
						response,
						sourceDate,
						sourceAgeDays,
						sourceUrl,
						usedFallback:
							sourceDate !== options.requestedSourceDate,
						downloadAttempt: attempt,
					};
				}

				lastFailure = `TMDb popularity download failed with status ${response.status} for ${sourceDate}.`;

				if (response.status === 404) {
					break;
				}

				if (response.status < 500 || attempt === TMDB_POPULARITY_DOWNLOAD_ATTEMPTS_PER_DATE) {
					throw new Error(lastFailure);
				}
			} catch (error) {
				lastFailure = error instanceof Error ? error.message : String(error);

				if (attempt === TMDB_POPULARITY_DOWNLOAD_ATTEMPTS_PER_DATE) {
					break;
				}
			}

			await waitForRetry(attempt * 1000);
		}
	}

	throw new Error(lastFailure);
}

export function parseTmdbPopularityExportLine(line: string) {
	let value: TmdbPopularityExportLine;

	try {
		value = JSON.parse(line) as TmdbPopularityExportLine;
	} catch {
		throw new Error("TMDb popularity export contains invalid JSON.");
	}

	if (!Number.isSafeInteger(value.id) || Number(value.id) < 1) {
		throw new Error("TMDb popularity export contains an invalid movie ID.");
	}

	if (
		typeof value.popularity !== "number" ||
		!Number.isFinite(value.popularity) ||
		value.popularity < 0
	) {
		throw new Error(
			`TMDb popularity export contains an invalid popularity value for movie ${String(value.id)}.`,
		);
	}

	if (typeof value.adult !== "boolean" || typeof value.video !== "boolean") {
		throw new Error(
			`TMDb popularity export contains invalid adult/video flags for movie ${String(value.id)}.`,
		);
	}

	return {
		row: {
			tmdb_id: Number(value.id),
			popularity: value.popularity,
		} satisfies TmdbPopularityRow,
		excludedAdult: value.adult,
		excludedVideo: value.video,
	};
}

function parseStoredResult(resultJson: string | null) {
	if (!resultJson) {
		return {} as Record<string, unknown>;
	}

	try {
		return JSON.parse(resultJson) as Record<string, unknown>;
	} catch {
		return {} as Record<string, unknown>;
	}
}

async function getPreviousCompletedPopularityRowCount(
	env: Env,
	jobRunId: string,
) {
	const row = await env.DB.prepare(
		`SELECT COALESCE(
		          CAST(json_extract(COALESCE(result_json, '{}'), '$.stagedRows') AS INTEGER),
		          0
		        ) AS stagedRows
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND job_run_id <> ?
		   AND status = 'complete'
		   AND error_count = 0
		   AND ended_at IS NOT NULL
		 ORDER BY ended_at DESC
		 LIMIT 1`,
	)
		.bind(TMDB_POPULARITY_REFRESH_JOB_NAME, jobRunId)
		.first<{ stagedRows: number }>();

	return row?.stagedRows ?? 0;
}

export function isTmdbPopularityQueueMessage(
	body: unknown,
): body is TmdbPopularityQueueMessage {
	return (
		typeof body === "object" &&
		body !== null &&
		"kind" in body &&
		body.kind === "tmdb-popularity" &&
		"rows" in body &&
		Array.isArray(body.rows)
	);
}

export function isTmdbPopularityFinalizeQueueMessage(
	body: unknown,
): body is TmdbPopularityFinalizeQueueMessage {
	return (
		typeof body === "object" &&
		body !== null &&
		"kind" in body &&
		body.kind === "tmdb-popularity-finalize"
	);
}

export async function processTmdbPopularityRows(
	env: Env,
	message: TmdbPopularityQueueMessage,
) {
	if (message.rows.length === 0) {
		return;
	}

	const placeholders = message.rows.map(() => "(?, ?, ?, ?)").join(", ");
	const values = message.rows.flatMap((row) => [
		message.jobRunId,
		row.tmdb_id,
		row.popularity,
		message.sourceExportDate,
	]);
	const insertStatement = env.DB.prepare(
		`INSERT INTO tmdb_movie_popularity_staging (
		   load_run_id,
		   tmdb_id,
		   popularity,
		   source_export_date
		 )
		 VALUES ${placeholders}
		 ON CONFLICT(load_run_id, tmdb_id) DO UPDATE SET
		   popularity = excluded.popularity,
		   source_export_date = excluded.source_export_date,
		   staged_at = CURRENT_TIMESTAMP`,
	).bind(...values);

	await recordImportJobQueueMessageCompletion(env, {
		jobRunId: message.jobRunId,
		messageId: message.messageId,
		jobName: TMDB_POPULARITY_REFRESH_JOB_NAME,
		queueName: TMDB_POPULARITY_QUEUE_NAME,
		stats: {
			processed: message.rows.length,
			updated: message.rows.length,
			errors: 0,
			providerRowsInserted: 0,
		},
		lastError: null,
		dataStatements: [insertStatement],
	});
}

export async function finalizeTmdbPopularityRun(
	env: Env,
	message: TmdbPopularityFinalizeQueueMessage,
) {
	const run = await getImportJobRunById(env, message.jobRunId);

	if (!run) {
		throw new Error(
			`TMDb popularity finalizer cannot find job ${message.jobRunId}.`,
		);
	}

	if (
		["complete", "complete_with_errors", "failed", "cancelled", "skipped"].includes(
			run.status,
		)
	) {
		return { pending: false, terminalStatus: run.status };
	}

	if (run.processed_count < message.expectedRows) {
		logEvent("tmdb-popularity-finalizer-waiting", {
			jobRunId: message.jobRunId,
			processedRows: run.processed_count,
			expectedRows: message.expectedRows,
			remainingRows: message.expectedRows - run.processed_count,
		});
		return {
			pending: true,
			processedRows: run.processed_count,
			expectedRows: message.expectedRows,
		};
	}

	const [stagingRow, movieListRow, overlapRow, previousRows] = await Promise.all([
		env.DB.prepare(
			`SELECT COUNT(*) AS stagedRows
			 FROM tmdb_movie_popularity_staging
			 WHERE load_run_id = ?`,
		)
			.bind(message.jobRunId)
			.first<{ stagedRows: number }>(),
		env.DB.prepare(
			"SELECT COUNT(*) AS movieListRows FROM movie_list_items",
		).first<{ movieListRows: number }>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS overlapRows
			 FROM movie_list_items AS movie
			 JOIN tmdb_movie_popularity_staging AS popularity
			   ON popularity.load_run_id = ?
			  AND popularity.tmdb_id = movie.tmdb_id`,
		)
			.bind(message.jobRunId)
			.first<{ overlapRows: number }>(),
		getPreviousCompletedPopularityRowCount(env, message.jobRunId),
	]);
	const stagedRows = stagingRow?.stagedRows ?? 0;
	const movieListRows = movieListRow?.movieListRows ?? 0;
	const overlapRows = overlapRow?.overlapRows ?? 0;
	const overlapRatio = movieListRows > 0 ? overlapRows / movieListRows : 0;
	const previousRunRatio = previousRows > 0 ? stagedRows / previousRows : null;
	const issues: string[] = [];

	if (stagedRows !== message.expectedRows) {
		issues.push(
			`staging contains ${stagedRows} rows but ${message.expectedRows} were expected`,
		);
	}

	if (stagedRows < TMDB_POPULARITY_MINIMUM_ROWS) {
		issues.push(
			`staging contains fewer than ${TMDB_POPULARITY_MINIMUM_ROWS} rows`,
		);
	}

	if (overlapRatio < TMDB_POPULARITY_MINIMUM_MOVIE_LIST_OVERLAP_RATIO) {
		issues.push(
			`movie-list overlap ${(overlapRatio * 100).toFixed(2)}% is below ${(TMDB_POPULARITY_MINIMUM_MOVIE_LIST_OVERLAP_RATIO * 100).toFixed(0)}%`,
		);
	}

	if (
		previousRunRatio !== null &&
		previousRunRatio < TMDB_POPULARITY_MINIMUM_PREVIOUS_RUN_RATIO
	) {
		issues.push(
			`row count is ${(previousRunRatio * 100).toFixed(2)}% of the previous completed run`,
		);
	}

	const existingResult = parseStoredResult(run.result_json);
	const validationResult = {
		...existingResult,
		stagedRows,
		movieListRows,
		overlapRows,
		overlapRatio,
		previousCompletedRunRows: previousRows,
		previousRunRatio,
		validationIssueCount: issues.length,
		validationIssues: issues,
		validationCompletedAt: new Date().toISOString(),
	};
	const resultStatement = env.DB.prepare(
		`UPDATE import_job_runs
		 SET result_json = ?
		 WHERE job_run_id = ?`,
	).bind(JSON.stringify(validationResult), message.jobRunId);

	await recordImportJobQueueMessageCompletion(env, {
		jobRunId: message.jobRunId,
		messageId: message.messageId,
		jobName: TMDB_POPULARITY_REFRESH_JOB_NAME,
		queueName: TMDB_POPULARITY_QUEUE_NAME,
		stats: {
			processed: 1,
			updated: 0,
			errors: issues.length > 0 ? 1 : 0,
			providerRowsInserted: 0,
		},
		lastError: issues.length > 0 ? issues.join("; ") : null,
		dataStatements: [resultStatement],
	});

	if (issues.length > 0) {
		logEvent("tmdb-popularity-validation-failed", {
			jobRunId: message.jobRunId,
			stagedRows,
			overlapRows,
			overlapRatio,
			issues: issues.join("; "),
			errorCount: 1,
		});
		return { pending: false, terminalStatus: "complete_with_errors" };
	}

	logEvent("tmdb-popularity-validation-complete", {
		jobRunId: message.jobRunId,
		stagedRows,
		overlapRows,
		overlapRatio,
	});

	return { pending: false, terminalStatus: "complete" };
}

export async function dryRunReadTmdbPopularity(
	sourceDate: string,
	limit = 33,
) {
	validateTmdbPopularitySourceDate(sourceDate);
	const sourceUrl = buildTmdbPopularityExportUrl(sourceDate);
	const response = await fetch(sourceUrl);

	if (!response.ok || !response.body) {
		throw new Error(
			`TMDb popularity download failed with status ${response.status}.`,
		);
	}

	const reader = response.body
		.pipeThrough(new DecompressionStream("gzip"))
		.getReader();
	const decoder = new TextDecoder();
	const rows: TmdbPopularityRow[] = [];
	let buffer = "";
	let linesSeen = 0;

	while (rows.length < limit) {
		const { value, done } = await reader.read();

		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}

			linesSeen += 1;
			const parsed = parseTmdbPopularityExportLine(line);

			if (!parsed.excludedAdult && !parsed.excludedVideo) {
				rows.push(parsed.row);
			}

			if (rows.length >= limit) {
				break;
			}
		}
	}

	await reader.cancel();

	return {
		sourceDate,
		sourceUrl,
		linesSeen,
		rowsRead: rows.length,
		rows,
	};
}

export async function enqueueTmdbPopularityRefresh(
	env: Env,
	options: {
		trigger: ImportJobTrigger;
		sourceDate?: string;
		nowMs?: number;
	},
) {
	const startedAtMs = options.nowMs ?? Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const requestedSourceDate =
		options.sourceDate ?? getDefaultTmdbPopularitySourceDate(startedAtMs);
	validateTmdbPopularitySourceDate(
		requestedSourceDate,
		startedAtMs,
	);
	let sourceDate = requestedSourceDate;
	let sourceUrl = buildTmdbPopularityExportUrl(sourceDate);
	const lockOwner = createJobOwner(options.trigger);
	const lockAcquired = await acquireImportJobLock(
		env,
		TMDB_POPULARITY_REFRESH_JOB_NAME,
		lockOwner,
		TMDB_POPULARITY_LOCK_MINUTES,
	);

	if (!lockAcquired) {
		return {
			trigger: options.trigger,
			skipped: true,
			skipReason: "job_already_starting",
			sourceDate,
			sourceUrl,
		};
	}

	let jobRunId: string | null = null;

	try {
		const activeRun = await getActiveImportJobRun(
			env,
			TMDB_POPULARITY_REFRESH_JOB_NAME,
		);

		if (activeRun) {
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "job_already_running",
				activeJobRunId: activeRun.job_run_id,
				activeStatus: activeRun.status,
				sourceDate,
				sourceUrl,
			};
		}

		jobRunId = createImportJobRunId(
			TMDB_POPULARITY_REFRESH_JOB_NAME,
			options.trigger,
		);
		await createImportJobRun(env, {
			jobRunId,
			jobName: TMDB_POPULARITY_REFRESH_JOB_NAME,
			trigger: options.trigger,
			status: "running",
		});

		logEvent("tmdb-popularity-enqueue-start", {
			jobRunId,
			trigger: options.trigger,
			sourceDate,
			sourceUrl,
		});

		const download = await fetchTmdbPopularityExport({
			requestedSourceDate,
			allowOneDayFallback: options.sourceDate === undefined,
			nowMs: startedAtMs,
		});
		const response = download.response;
		const responseBody = response.body;

		if (!responseBody) {
			throw new Error("TMDb popularity download returned an empty body.");
		}

		sourceDate = download.sourceDate;
		sourceUrl = download.sourceUrl;

		const reader = responseBody
			.pipeThrough(new DecompressionStream("gzip"))
			.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let linesSeen = 0;
		let acceptedRows = 0;
		let adultRowsExcluded = 0;
		let videoRowsExcluded = 0;
		let queueMessageCount = 0;
		let queueSendBatchCount = 0;
		let batch: TmdbPopularityRow[] = [];
		let queueMessages: TmdbPopularityQueueMessage[] = [];

		async function flushQueueMessages() {
			if (queueMessages.length === 0) {
				return;
			}

			await env.TMDB_POPULARITY_QUEUE.sendBatch(
				queueMessages.map((message) => ({ body: message })),
			);
			queueMessages = [];
			queueSendBatchCount += 1;
		}

		async function flushBatch() {
			if (batch.length === 0) {
				return;
			}

			queueMessageCount += 1;
			queueMessages.push({
				kind: "tmdb-popularity",
				jobRunId: jobRunId as string,
				messageId: `${jobRunId}-${String(queueMessageCount).padStart(6, "0")}`,
				sourceExportDate: sourceDate,
				rows: batch,
			});
			acceptedRows += batch.length;
			batch = [];

			if (
				queueMessages.length >= TMDB_POPULARITY_MESSAGES_PER_SEND_BATCH
			) {
				await flushQueueMessages();
			}
		}

		function processLine(line: string) {
			if (!line.trim()) {
				return;
			}

			linesSeen += 1;
			const parsed = parseTmdbPopularityExportLine(line);

			if (parsed.excludedAdult) {
				adultRowsExcluded += 1;
				return;
			}

			if (parsed.excludedVideo) {
				videoRowsExcluded += 1;
				return;
			}

			batch.push(parsed.row);
		}

		while (true) {
			const { value, done } = await reader.read();

			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				processLine(line);

				if (batch.length >= TMDB_POPULARITY_ROWS_PER_MESSAGE) {
					await flushBatch();
				}
			}
		}

		buffer += decoder.decode();

		if (buffer.trim()) {
			processLine(buffer);
		}

		await flushBatch();
		await flushQueueMessages();
		await reader.cancel();

		const enqueueEndedAtMs = Date.now();
		const result = {
			jobRunId,
			trigger: options.trigger,
			requestedSourceDate,
			sourceDate,
			sourceAgeDays: download.sourceAgeDays,
			sourceUrl,
			usedFallback: download.usedFallback,
			downloadAttempt: download.downloadAttempt,
			sourceLastModified: response.headers.get("last-modified"),
			sourceContentLength: Number(
				response.headers.get("content-length") ?? "0",
			),
			linesSeen,
			acceptedRows,
			adultRowsExcluded,
			videoRowsExcluded,
			queueMessageCount,
			queueSendBatchCount,
			rowsPerMessage: TMDB_POPULARITY_ROWS_PER_MESSAGE,
			messagesPerSendBatch: TMDB_POPULARITY_MESSAGES_PER_SEND_BATCH,
			enqueueDurationMs: enqueueEndedAtMs - startedAtMs,
			startedAt,
			enqueueEndedAt: new Date(enqueueEndedAtMs).toISOString(),
		};

		await setImportJobRunQueueTotals(env, jobRunId, {
			selected: acceptedRows + 1,
			queued: acceptedRows + 1,
			result,
		});

		const finalizer: TmdbPopularityFinalizeQueueMessage = {
			kind: "tmdb-popularity-finalize",
			jobRunId,
			messageId: `${jobRunId}-finalize`,
			sourceExportDate: sourceDate,
			expectedRows: acceptedRows,
		};
		await env.TMDB_POPULARITY_QUEUE.send(finalizer);

		logEvent("tmdb-popularity-enqueue-end", result);

		return {
			...result,
			monitorEndpoint:
				"/admin/import/job-runs?jobName=tmdb-popularity-refresh&limit=1",
		};
	} catch (error) {
		const lastError = error instanceof Error ? error.message : String(error);

		if (jobRunId) {
			const result = {
				jobRunId,
				trigger: options.trigger,
				status: "cancelled",
				reason: "tmdb_popularity_enqueue_error",
				sourceDate,
				sourceUrl,
				error: lastError,
				durationMs: Date.now() - startedAtMs,
			};

			await finishImportJobRun(env, jobRunId, {
				status: "cancelled",
				errors: 1,
				result,
				lastError,
			});
		}

		throw error;
	} finally {
		await releaseImportJobLock(
			env,
			TMDB_POPULARITY_REFRESH_JOB_NAME,
			lockOwner,
		);
	}
}
