export const CACHE_WARM_SEARCH_JOB_NAME = "cache-warm-search";
export const CACHE_WARM_SEARCH_QUEUE_KIND = "cache-warm-search";
export const CACHE_WARM_SEARCH_PAGE_LIMIT = 10;

export type CacheWarmTrigger = "manual" | "cron";

export type CacheWarmUrlEntry = {
	name: string;
	url: string;
};

export type CacheWarmGenreConfig = {
	key: string;
	label: string;
	genreId: number;
	entries: CacheWarmUrlEntry[];
};

export type CacheWarmSearchQueueMessage = {
	kind: typeof CACHE_WARM_SEARCH_QUEUE_KIND;
	jobRunId: string;
	genreKey: string;
	genreLabel: string;
	entryName: string;
	url: string;
	maxPages: number;
};

export type CacheWarmSearchStats = {
	pageCount: number;
	firstRequestCount: number;
	retryRequestCount: number;
	hitCount: number;
	missCount: number;
	retryHitCount: number;
	errorCount: number;
	lastError: string | null;
};
