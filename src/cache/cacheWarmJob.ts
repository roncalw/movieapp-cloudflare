import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";
import {
	CACHE_WARM_GENRES,
	findCacheWarmGenre,
} from "./cacheGenreRegistry";
import {
	createCacheWarmSearchJobRun,
	createCacheWarmSearchJobRunId,
} from "./cacheWarmJobRuns";
import {
	CACHE_WARM_SEARCH_PAGE_LIMIT,
	CACHE_WARM_SEARCH_QUEUE_KIND,
	type CacheWarmGenreConfig,
	type CacheWarmTrigger,
	type CacheWarmSearchQueueMessage,
} from "./cacheWarmTypes";

const CACHE_WARM_MESSAGES_PER_SEND_BATCH = 100;

type EnqueueCacheWarmSearchOptions = {
	trigger: CacheWarmTrigger;
	genreKey?: string;
	genreId?: number;
};

function selectGenres(options: EnqueueCacheWarmSearchOptions) {
	if (options.genreKey !== undefined || options.genreId !== undefined) {
		const selectedGenre = findCacheWarmGenre({
			genreKey: options.genreKey,
			genreId: options.genreId,
		});

		if (!selectedGenre) {
			throw new Error("Unknown cache warm genre.");
		}

		return [selectedGenre];
	}

	return CACHE_WARM_GENRES;
}

function buildQueueMessages(
	jobRunId: string,
	genres: CacheWarmGenreConfig[],
) {
	const messages: CacheWarmSearchQueueMessage[] = [];
	let messageNumber = 0;

	for (const genre of genres) {
		for (const entry of genre.entries) {
			messageNumber += 1;
			messages.push({
				kind: CACHE_WARM_SEARCH_QUEUE_KIND,
				jobRunId,
				messageId: `${jobRunId}-${String(messageNumber).padStart(6, "0")}`,
				genreKey: genre.key,
				genreLabel: genre.label,
				entryName: entry.name,
				url: entry.url,
				maxPages: CACHE_WARM_SEARCH_PAGE_LIMIT,
			});
		}
	}

	return messages;
}

function chunkMessages<T>(items: T[], size: number) {
	const chunks: T[][] = [];

	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}

	return chunks;
}

export async function enqueueCacheWarmSearchJob(
	env: Env,
	options: EnqueueCacheWarmSearchOptions,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const selectedGenres = selectGenres(options);
	const jobRunId = createCacheWarmSearchJobRunId(options.trigger);
	const queueMessages = buildQueueMessages(jobRunId, selectedGenres);

	logEvent("cache-warm-search-enqueue-start", {
		trigger: options.trigger,
		jobRunId,
		selectedGenreKey: options.genreKey ?? null,
		selectedGenreId: options.genreId ?? null,
		selectedGenreCount: selectedGenres.length,
		selectedEntryCount: queueMessages.length,
		pageLimit: CACHE_WARM_SEARCH_PAGE_LIMIT,
	});

	await createCacheWarmSearchJobRun(env, {
		jobRunId,
		trigger: options.trigger,
		selectedGenreKey:
			selectedGenres.length === 1 ? selectedGenres[0].key : null,
		selectedGenreCount: selectedGenres.length,
		selectedEntryCount: queueMessages.length,
		pageLimit: CACHE_WARM_SEARCH_PAGE_LIMIT,
		selectedGenres: selectedGenres.map((genre) => genre.key),
	});

	for (const chunk of chunkMessages(queueMessages, CACHE_WARM_MESSAGES_PER_SEND_BATCH)) {
		await env.CACHE_WARM_QUEUE.sendBatch(
			chunk.map((message) => ({
				body: message,
			})),
		);
	}

	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const durationMs = endedAtMs - startedAtMs;
	const response = {
		jobRunId,
		trigger: options.trigger,
		selectedGenreKey:
			selectedGenres.length === 1 ? selectedGenres[0].key : null,
		selectedGenres: selectedGenres.map((genre) => ({
			key: genre.key,
			label: genre.label,
			genreId: genre.genreId,
			entryCount: genre.entries.length,
		})),
		selectedGenreCount: selectedGenres.length,
		selectedEntryCount: queueMessages.length,
		rowsQueued: queueMessages.length,
		messagesQueued: queueMessages.length,
		pageLimit: CACHE_WARM_SEARCH_PAGE_LIMIT,
		monitorEndpoint:
			"/admin/import/job-runs?jobName=cache-warm-search&limit=1",
		startedAt,
		endedAt,
		durationMs,
	};

	logEvent("cache-warm-search-enqueue-end", {
		trigger: options.trigger,
		jobRunId,
		selectedGenreKey:
			selectedGenres.length === 1 ? selectedGenres[0].key : null,
		selectedGenreCount: selectedGenres.length,
		selectedEntryCount: queueMessages.length,
		durationMs,
	});

	return response;
}
