import type {
	Env,
	ImdbRatingFinalizeQueueMessage,
	ImdbRatingQueueMessage,
	ImdbRatingRow,
} from "../shared/types";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getImportJobRunById,
	IMDB_RATINGS_JOB_NAME,
	recordImportJobQueueMessageCompletion,
	type ImportJobTrigger,
	setImportJobRunQueueTotals,
} from "../jobs/importJobRuns";
import { logEvent } from "../shared/logging";

const IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const IMDB_SAMPLE_SIZE = 33;
const IMDB_QUEUE_ROWS_PER_MESSAGE = 25;
const IMDB_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const IMDB_RATINGS_QUEUE_NAME = "movieapp-imdb-rating-import-queue";
const IMDB_RATINGS_MINIMUM_FULL_IMPORT_ROWS = 1600000;
const IMDB_RATINGS_MINIMUM_PREVIOUS_RUN_RATIO = 0.9;

export async function dryRunReadImdbRatings(limit: number) {
	const response = await fetch(IMDB_RATINGS_URL);

	if (!response.ok || !response.body) {
		throw new Error(`IMDb download failed with status ${response.status}.`);
	}

	const decompressedStream = response.body.pipeThrough(
		new DecompressionStream("gzip"),
	);
	const reader = decompressedStream.getReader();
	const decoder = new TextDecoder();

	let buffer = "";
	let headerSkipped = false;
	let rowsRead = 0;
	const firstRows: ImdbRatingRow[] = [];
	const lastRows: ImdbRatingRow[] = [];

	while (rowsRead < limit) {
		const { value, done } = await reader.read();

		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });

		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!headerSkipped) {
				headerSkipped = true;
				continue;
			}

			if (!line.trim()) {
				continue;
			}

			const [imdb_id, averageRating, numVotes] = line.split("\t");

			const parsedRow: ImdbRatingRow = {
				imdb_id,
				average_rating: averageRating === "" ? null : Number(averageRating),
				num_votes: numVotes === "" ? null : Number(numVotes),
			};

			if (firstRows.length < IMDB_SAMPLE_SIZE) {
				firstRows.push(parsedRow);
			}

			lastRows.push(parsedRow);

			if (lastRows.length > IMDB_SAMPLE_SIZE) {
				lastRows.shift();
			}

			rowsRead += 1;

			if (rowsRead >= limit) {
				break;
			}
		}
	}

	await reader.cancel();

	return {
		rowsRead,
		firstRows,
		lastRows,
	};
}

export async function enqueueImdbRatingRows(
	env: Env,
	limit?: number,
	trigger: ImportJobTrigger = "manual",
) {
	const startedAtMs = Date.now();
	const jobRunId = createImportJobRunId(IMDB_RATINGS_JOB_NAME, trigger);

	await createImportJobRun(env, {
		jobRunId,
		jobName: IMDB_RATINGS_JOB_NAME,
		trigger,
		status: "running",
	});

	try {
		logEvent("imdb-ratings-enqueue-start", {
			jobRunId,
			trigger,
			limit: limit ?? "full",
		});

		const response = await fetch(IMDB_RATINGS_URL);

		if (!response.ok || !response.body) {
			throw new Error(
				`IMDb download failed with status ${response.status}.`,
			);
		}

		const decompressedStream = response.body.pipeThrough(
			new DecompressionStream("gzip"),
		);
		const reader = decompressedStream.getReader();
		const decoder = new TextDecoder();

		let buffer = "";
		let headerSkipped = false;
		let rowsSeen = 0;
		let rowsQueued = 0;
		let queueMessageCount = 0;
		let queueSendBatchCount = 0;
		let batch: ImdbRatingRow[] = [];
		let queueMessages: ImdbRatingQueueMessage[] = [];

		async function flushQueueMessages() {
			if (queueMessages.length === 0) {
				return;
			}

			await env.IMDB_RATING_QUEUE.sendBatch(
				queueMessages.map((message) => ({ body: message })),
			);

			queueSendBatchCount += 1;
			queueMessages = [];
		}

		async function flushBatch() {
			if (batch.length === 0) {
				return;
			}

			queueMessages.push({
				kind: "imdb-ratings",
				jobRunId,
				messageId: `${jobRunId}-${String(queueMessageCount + 1).padStart(
					6,
					"0",
				)}`,
				rows: batch,
			});
			rowsQueued += batch.length;
			queueMessageCount += 1;
			batch = [];

			if (queueMessages.length >= IMDB_QUEUE_MESSAGES_PER_SEND_BATCH) {
				await flushQueueMessages();
			}
		}

		async function finishEnqueue() {
			const endedAtMs = Date.now();
			const result = {
				jobRunId,
				trigger,
				rowsSeen,
				rowsQueued,
				queueMessageCount,
				queueSendBatchCount,
				rowsPerMessage: IMDB_QUEUE_ROWS_PER_MESSAGE,
				messagesPerSendBatch: IMDB_QUEUE_MESSAGES_PER_SEND_BATCH,
				isFullImport: limit === undefined,
				sourceLastModified: response.headers.get("last-modified"),
				sourceContentLength: Number(
					response.headers.get("content-length") ?? "0",
				),
				enqueueDurationMs: endedAtMs - startedAtMs,
			};

			await setImportJobRunQueueTotals(env, jobRunId, {
				selected: rowsSeen + 1,
				queued: rowsQueued + 1,
				result,
			});

			const finalizer: ImdbRatingFinalizeQueueMessage = {
				kind: "imdb-ratings-finalize",
				jobRunId,
				messageId: `${jobRunId}-finalize`,
				expectedRows: rowsSeen,
			};
			await env.IMDB_RATING_QUEUE.send(finalizer);

			logEvent("imdb-ratings-enqueue-end", result);

			return result;
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
				if (!headerSkipped) {
					headerSkipped = true;
					continue;
				}

				if (!line.trim()) {
					continue;
				}

				const [imdb_id, averageRating, numVotes] = line.split("\t");

				batch.push({
					imdb_id,
					average_rating: averageRating === "" ? null : Number(averageRating),
					num_votes: numVotes === "" ? null : Number(numVotes),
				});

				rowsSeen += 1;

				if (batch.length >= IMDB_QUEUE_ROWS_PER_MESSAGE) {
					await flushBatch();
				}

				if (limit && rowsSeen >= limit) {
					await flushBatch();
					await flushQueueMessages();
					await reader.cancel();
					return await finishEnqueue();
				}
			}
		}

		await flushBatch();
		await flushQueueMessages();
		await reader.cancel();

		return await finishEnqueue();
	} catch (error) {
		const lastError = error instanceof Error ? error.message : String(error);
		const result = {
			jobRunId,
			trigger,
			status: "cancelled",
			reason: "imdb_ratings_enqueue_error",
			error: lastError,
			enqueueDurationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "cancelled",
			errors: 1,
			result,
			lastError,
		});

		logEvent("imdb-ratings-cancelled", result);

		throw error;
	}
}

export function isImdbRatingFinalizeQueueMessage(
	body: unknown,
): body is ImdbRatingFinalizeQueueMessage {
	return (
		typeof body === "object" &&
		body !== null &&
		"kind" in body &&
		body.kind === "imdb-ratings-finalize"
	);
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

async function getPreviousCompletedFullImdbRowCount(
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
		   AND json_extract(COALESCE(result_json, '{}'), '$.isFullImport') = 1
		 ORDER BY ended_at DESC
		 LIMIT 1`,
	)
		.bind(IMDB_RATINGS_JOB_NAME, jobRunId)
		.first<{ stagedRows: number }>();

	return row?.stagedRows ?? 0;
}

export async function finalizeImdbRatingRun(
	env: Env,
	message: ImdbRatingFinalizeQueueMessage,
) {
	const run = await getImportJobRunById(env, message.jobRunId);

	if (!run) {
		throw new Error(`IMDb finalizer cannot find job ${message.jobRunId}.`);
	}

	if (
		["complete", "complete_with_errors", "failed", "cancelled", "skipped"].includes(
			run.status,
		)
	) {
		return { pending: false, terminalStatus: run.status };
	}

	if (run.processed_count < message.expectedRows) {
		logEvent("imdb-ratings-finalizer-waiting", {
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

	const existingResult = parseStoredResult(run.result_json);
	const isFullImport = existingResult.isFullImport === true;
	const [stagingRow, movieListOverlapRow, previousRows] = await Promise.all([
		env.DB.prepare(
			`SELECT COUNT(*) AS stagedRows
			 FROM imdb_ratings_staging_by_run
			 WHERE load_run_id = ?`,
		)
			.bind(message.jobRunId)
			.first<{ stagedRows: number }>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS movieListOverlapRows
			 FROM movie_list_items AS movie
			 JOIN tmdb_movies_staging AS tmdb
			   ON tmdb.tmdb_id = movie.tmdb_id
			 JOIN imdb_ratings_staging_by_run AS imdb
			   ON imdb.load_run_id = ?
			  AND imdb.imdb_id = tmdb.imdb_id`,
		)
			.bind(message.jobRunId)
			.first<{ movieListOverlapRows: number }>(),
		getPreviousCompletedFullImdbRowCount(env, message.jobRunId),
	]);
	const stagedRows = stagingRow?.stagedRows ?? 0;
	const movieListOverlapRows = movieListOverlapRow?.movieListOverlapRows ?? 0;
	const previousRunRatio = previousRows > 0 ? stagedRows / previousRows : null;
	const issues: string[] = [];

	if (stagedRows !== message.expectedRows) {
		issues.push(
			`run-separated staging contains ${stagedRows} rows but ${message.expectedRows} were expected`,
		);
	}

	if (isFullImport && stagedRows < IMDB_RATINGS_MINIMUM_FULL_IMPORT_ROWS) {
		issues.push(
			`full IMDb staging contains fewer than ${IMDB_RATINGS_MINIMUM_FULL_IMPORT_ROWS} rows`,
		);
	}

	if (
		isFullImport &&
		previousRunRatio !== null &&
		previousRunRatio < IMDB_RATINGS_MINIMUM_PREVIOUS_RUN_RATIO
	) {
		issues.push(
			`row count is ${(previousRunRatio * 100).toFixed(2)}% of the previous completed full import`,
		);
	}

	if (isFullImport && movieListOverlapRows < 350000) {
		issues.push(
			`only ${movieListOverlapRows} current Movie List rows match the completed IMDb file`,
		);
	}

	const validationResult = {
		...existingResult,
		stagedRows,
		movieListOverlapRows,
		previousCompletedFullRunRows: previousRows,
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
		jobName: IMDB_RATINGS_JOB_NAME,
		queueName: IMDB_RATINGS_QUEUE_NAME,
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
		logEvent("imdb-ratings-validation-failed", {
			jobRunId: message.jobRunId,
			stagedRows,
			movieListOverlapRows,
			issues: issues.join("; "),
			errorCount: 1,
		});
		return { pending: false, terminalStatus: "complete_with_errors" };
	}

	logEvent("imdb-ratings-validation-complete", {
		jobRunId: message.jobRunId,
		stagedRows,
		movieListOverlapRows,
		isFullImport,
	});

	return { pending: false, terminalStatus: "complete" };
}

export async function insertImdbRatingQueueRows(
	env: Env,
	rows: ImdbRatingRow[],
	jobRunId?: string,
	messageId?: string,
) {
	if (rows.length === 0) {
		return;
	}

	const placeholders = rows.map(() => "(?, ?, ?)").join(", ");
	const values = rows.flatMap((row) => [
		row.imdb_id,
		row.average_rating,
		row.num_votes,
	]);

	const insertStatement = env.DB
		.prepare(
			`INSERT INTO imdb_ratings_staging
				(imdb_id, average_rating, num_votes)
			VALUES ${placeholders}
			ON CONFLICT(imdb_id) DO UPDATE SET
				average_rating = excluded.average_rating,
				num_votes = excluded.num_votes,
				imported_at = CURRENT_TIMESTAMP`,
		)
		.bind(...values);

	if (jobRunId) {
		const runPlaceholders = rows.map(() => "(?, ?, ?, ?)").join(", ");
		const runValues = rows.flatMap((row) => [
			jobRunId,
			row.imdb_id,
			row.average_rating,
			row.num_votes,
		]);
		const runInsertStatement = env.DB.prepare(
			`INSERT INTO imdb_ratings_staging_by_run
				(load_run_id, imdb_id, average_rating, num_votes)
			VALUES ${runPlaceholders}
			ON CONFLICT(load_run_id, imdb_id) DO UPDATE SET
				average_rating = excluded.average_rating,
				num_votes = excluded.num_votes,
				imported_at = CURRENT_TIMESTAMP`,
		).bind(...runValues);

		await recordImportJobQueueMessageCompletion(env, {
			jobRunId,
			messageId:
				messageId ??
				`${jobRunId}-legacy-${rows[0]?.imdb_id ?? "first"}-${
					rows[rows.length - 1]?.imdb_id ?? "last"
				}-${rows.length}`,
			jobName: IMDB_RATINGS_JOB_NAME,
			queueName: IMDB_RATINGS_QUEUE_NAME,
			stats: {
				processed: rows.length,
				updated: rows.length,
				errors: 0,
				providerRowsInserted: 0,
			},
			lastError: null,
			// A tracked file import writes only to its isolated run partition.
			// Keeping the former single-snapshot table unchanged gives us a clean
			// rollback source until the new path has passed production verification.
			dataStatements: [runInsertStatement],
		});
	} else {
		await insertStatement.run();
	}
}
