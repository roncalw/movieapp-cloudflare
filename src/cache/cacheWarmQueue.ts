import type {
	Env,
	WorkerQueueMessage,
} from "../shared/types";
import { logEvent } from "../shared/logging";
import { recordCacheWarmSearchProgress } from "./cacheWarmJobRuns";
import { finalizeProviderAvailabilityCycleForCacheRun } from "../jobs/providerAvailabilityCycle";
import {
	CACHE_WARM_SEARCH_QUEUE_KIND,
	type CacheWarmSearchQueueMessage,
	type CacheWarmSearchStats,
} from "./cacheWarmTypes";

type CacheWarmRequestResult = {
	httpStatus: number;
	body: unknown;
	movieAppCacheStatus: string | null;
	cloudflareCacheStatus: string | null;
	status: string;
};

const CACHE_WARM_CONFIRMATION_MAX_ATTEMPTS = 3;
const CACHE_WARM_CONFIRMATION_DELAY_MS = 250;

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isCacheWarmSearchQueueMessage(
	body: WorkerQueueMessage,
): body is CacheWarmSearchQueueMessage {
	return "kind" in body && body.kind === CACHE_WARM_SEARCH_QUEUE_KIND;
}

async function requestCacheUrl(url: string): Promise<CacheWarmRequestResult> {
	const response = await fetch(url, {
		headers: {
			"user-agent": "movieapp-cache-warmer/1.0",
		},
	});
	const bodyText = await response.text();
	const movieAppCacheStatus = response.headers.get("x-movieapp-cache");
	const cloudflareCacheStatus = response.headers.get("cf-cache-status");

	return {
		httpStatus: response.status,
		body: parseJsonBody(bodyText),
		movieAppCacheStatus,
		cloudflareCacheStatus,
		status: movieAppCacheStatus ?? cloudflareCacheStatus ?? "UNKNOWN",
	};
}

function parseJsonBody(bodyText: string) {
	if (bodyText.trim() === "") {
		return null;
	}

	try {
		return JSON.parse(bodyText);
	} catch {
		return null;
	}
}

function getNextCursor(result: CacheWarmRequestResult) {
	if (
		result.body !== null &&
		typeof result.body === "object" &&
		("nextCursor" in result.body) &&
		(typeof result.body.nextCursor === "string" ||
			result.body.nextCursor === null)
	) {
		return result.body.nextCursor;
	}

	return null;
}

function appendCursorToUrl(baseUrl: string, cursor: string) {
	const separator = baseUrl.includes("?") ? "&" : "?";

	return `${baseUrl}${separator}cursor=${encodeURIComponent(cursor)}`;
}

function recordCacheStatus(
	stats: CacheWarmSearchStats,
	result: CacheWarmRequestResult,
	isRetry: boolean,
) {
	if (result.status === "MISS") {
		stats.missCount += 1;
		return;
	}

	if (result.status === "HIT") {
		stats.hitCount += 1;

		if (isRetry) {
			stats.retryHitCount += 1;
		}
	}
}

export async function warmCachePage(
	url: string,
	stats: CacheWarmSearchStats,
) {
	const firstResult = await requestCacheUrl(url);
	stats.firstRequestCount += 1;
	recordCacheStatus(stats, firstResult, false);

	if (firstResult.httpStatus >= 400) {
		throw new Error(`Cache warm request failed: ${firstResult.httpStatus}`);
	}

	if (firstResult.status !== "MISS") {
		return firstResult;
	}

	for (
		let confirmationAttempt = 1;
		confirmationAttempt <= CACHE_WARM_CONFIRMATION_MAX_ATTEMPTS;
		confirmationAttempt += 1
	) {
		if (confirmationAttempt > 1) {
			// Cache API writes can finish just after the response is returned. This
			// short delay is used only after an immediate confirmation also misses.
			await wait(CACHE_WARM_CONFIRMATION_DELAY_MS * (confirmationAttempt - 1));
		}

		const retryResult = await requestCacheUrl(url);
		stats.retryRequestCount += 1;
		recordCacheStatus(stats, retryResult, true);

		if (retryResult.httpStatus >= 400) {
			throw new Error(`Cache warm retry failed: ${retryResult.httpStatus}`);
		}

		if (retryResult.status === "HIT") {
			return retryResult;
		}
	}

	throw new Error(
		`Cache warm confirmation did not reach HIT after ${CACHE_WARM_CONFIRMATION_MAX_ATTEMPTS} attempts.`,
	);
}

export async function processCacheWarmSearchMessage(
	env: Env,
	message: CacheWarmSearchQueueMessage,
) {
	const stats: CacheWarmSearchStats = {
		pageCount: 0,
		firstRequestCount: 0,
		retryRequestCount: 0,
		hitCount: 0,
		missCount: 0,
		retryHitCount: 0,
		errorCount: 0,
		lastError: null,
	};
	let currentUrl = message.url;

	try {
		for (let page = 1; page <= message.maxPages; page += 1) {
			const result = await warmCachePage(currentUrl, stats);
			stats.pageCount += 1;
			const nextCursor = getNextCursor(result);

			if (nextCursor === null) {
				break;
			}

			currentUrl = appendCursorToUrl(message.url, nextCursor);
		}
	} catch (error) {
		stats.errorCount += 1;
		stats.lastError = error instanceof Error ? error.message : String(error);

		logEvent("cache-warm-search-entry-failed", {
			jobRunId: message.jobRunId,
			genreKey: message.genreKey,
			entryName: message.entryName,
			error: stats.lastError,
		});
	}

	const completedRun = await recordCacheWarmSearchProgress(env, {
		jobRunId: message.jobRunId,
		messageId:
			message.messageId ??
			`${message.jobRunId}-legacy-${message.genreKey}-${message.entryName}`,
		genreKey: message.genreKey,
		entryName: message.entryName,
		stats,
	});

	if (
		completedRun &&
		!["queued", "running"].includes(completedRun.status)
	) {
		await finalizeProviderAvailabilityCycleForCacheRun(
			env,
			completedRun.job_run_id,
		);
	}
}
