import type {
	Env,
	ImdbRatingQueueMessage,
	ImdbRatingRow,
} from "../shared/types";

const IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const IMDB_SAMPLE_SIZE = 33;
const IMDB_QUEUE_ROWS_PER_MESSAGE = 33;
const IMDB_QUEUE_MESSAGES_PER_SEND_BATCH = 100;

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

export async function enqueueImdbRatingRows(env: Env, limit?: number) {
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
	let batch: ImdbRatingRow[] = [];
	let queueMessages: ImdbRatingQueueMessage[] = [];

	async function flushQueueMessages() {
		if (queueMessages.length === 0) {
			return;
		}

		await env.IMDB_RATING_QUEUE.sendBatch(
			queueMessages.map((message) => ({ body: message })),
		);

		queueMessages = [];
	}

	async function flushBatch() {
		if (batch.length === 0) {
			return;
		}

		queueMessages.push({ rows: batch });
		rowsQueued += batch.length;
		batch = [];

		if (queueMessages.length >= IMDB_QUEUE_MESSAGES_PER_SEND_BATCH) {
			await flushQueueMessages();
		}
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
				return { rowsSeen, rowsQueued };
			}
		}
	}

	await flushBatch();
	await flushQueueMessages();
	await reader.cancel();

	return { rowsSeen, rowsQueued };
}

export async function insertImdbRatingQueueRows(
	env: Env,
	rows: ImdbRatingRow[],
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

	await env.DB
		.prepare(
			`INSERT OR REPLACE INTO imdb_ratings_staging
				(imdb_id, average_rating, num_votes)
			VALUES ${placeholders}`,
		)
		.bind(...values)
		.run();
}
