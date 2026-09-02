/**
 * Coordinates the provider-only production workflow.
 *
 * The TMDB provider refresh deliberately builds a complete snapshot in a safe
 * staging table. Before this module existed, Movie List Build owned the later
 * live-table application. Provider availability now has its own schedule, so
 * its successful completion must start the remaining work itself:
 *
 * Provider Refresh -> safety check -> live apply -> cache warm -> validation.
 *
 * Every lookup below is tied to the exact refresh job-run ID. A newer, older,
 * retried, or manually started run can therefore never be mixed into the
 * middle of another provider cycle.
 */
import { enqueueCacheWarmSearchJob } from "../cache/cacheWarmJob";
import { CACHE_WARM_SEARCH_JOB_NAME } from "../cache/cacheWarmTypes";
import {
	countUnappliedMovieWatchProviderChanges,
	getProjectedMovieWatchProviderCounts,
	preparePendingMovieWatchProviderChanges,
	promotePendingMovieWatchProviders,
	type ProviderAvailabilityCounts,
} from "../imports/movieRelationshipPromotions";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";
import { STREAMS_WITH_ADS_PROVIDER_ID } from "../shared/watchProviderAvailability";
import {
	acquireImportJobLock,
	createJobOwner,
	releaseImportJobLock,
} from "./importJobLocks";
import {
	createImportJobRun,
	createImportJobRunId,
	finishImportJobRun,
	getImportJobRunById,
	MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
	PROVIDER_AVAILABILITY_VALIDATION_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	type ImportJobRunRow,
	type ImportJobTrigger,
} from "./importJobRuns";

const PROVIDER_AVAILABILITY_CYCLE_LOCK_NAME =
	"provider-availability-cycle-coordinator";
const PROVIDER_AVAILABILITY_CYCLE_LOCK_MINUTES = 10;
const PROVIDER_AVAILABILITY_VALIDATION_LOCK_NAME =
	"provider-availability-cycle-validation";
const PROVIDER_AVAILABILITY_VALIDATION_LOCK_MINUTES = 10;
const PROVIDER_COUNT_DROP_THRESHOLD_PERCENT = 10;

export type { ProviderAvailabilityCounts } from "../imports/movieRelationshipPromotions";

type ProviderCycleSource = {
	providerRefreshJobRunId: string;
	providerPromotionJobRunId: string | null;
	cacheWarmJobRunId: string | null;
};

function normalizeTrigger(trigger: string): ImportJobTrigger {
	return trigger === "manual" ? "manual" : "cron";
}

function parseResultJson(resultJson: string | null) {
	if (!resultJson) {
		return {} as Record<string, unknown>;
	}

	try {
		return JSON.parse(resultJson) as Record<string, unknown>;
	} catch {
		return {} as Record<string, unknown>;
	}
}

function isCompleteWithoutErrors(
	run: ImportJobRunRow | null,
): run is ImportJobRunRow {
	return (
		run !== null &&
		run.status === "complete" &&
		run.error_count === 0 &&
		run.ended_at !== null &&
		run.processed_count === run.selected_count
	);
}

async function getLiveProviderCounts(env: Env) {
	const row = await env.DB.prepare(
		`SELECT
		   COUNT(CASE WHEN provider_id <> ? THEN 1 END) AS subscriptionRelationshipCount,
		   COUNT(DISTINCT CASE WHEN provider_id <> ? THEN tmdb_id END) AS subscriptionMovieCount,
		   COUNT(CASE WHEN provider_id = ? THEN 1 END) AS adsMovieCount,
		   COUNT(*) AS totalAvailabilityRelationshipCount,
		   COUNT(DISTINCT tmdb_id) AS availabilityMovieCount
		 FROM movie_watch_providers
		 WHERE region = 'US'`,
	)
		.bind(
			STREAMS_WITH_ADS_PROVIDER_ID,
			STREAMS_WITH_ADS_PROVIDER_ID,
			STREAMS_WITH_ADS_PROVIDER_ID,
		)
		.first<ProviderAvailabilityCounts>();

	return normalizeCounts(row);
}

function parseProviderAvailabilityCounts(
	value: unknown,
): ProviderAvailabilityCounts | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const counts = value as Partial<ProviderAvailabilityCounts>;
	const properties: Array<keyof ProviderAvailabilityCounts> = [
		"subscriptionRelationshipCount",
		"subscriptionMovieCount",
		"adsMovieCount",
		"totalAvailabilityRelationshipCount",
		"availabilityMovieCount",
	];

	if (properties.some((property) => typeof counts[property] !== "number")) {
		return null;
	}

	return counts as ProviderAvailabilityCounts;
}

function normalizeCounts(
	row: ProviderAvailabilityCounts | null,
): ProviderAvailabilityCounts {
	return {
		subscriptionRelationshipCount: row?.subscriptionRelationshipCount ?? 0,
		subscriptionMovieCount: row?.subscriptionMovieCount ?? 0,
		adsMovieCount: row?.adsMovieCount ?? 0,
		totalAvailabilityRelationshipCount:
			row?.totalAvailabilityRelationshipCount ?? 0,
		availabilityMovieCount: row?.availabilityMovieCount ?? 0,
	};
}

/**
 * Returns human-readable safety failures. A decrease equal to the configured
 * threshold is accepted; only a decrease greater than the threshold stops the
 * live replacement.
 */
export function getProviderAvailabilityCountIssues(
	current: ProviderAvailabilityCounts,
	staged: ProviderAvailabilityCounts,
	thresholdPercent = PROVIDER_COUNT_DROP_THRESHOLD_PERCENT,
) {
	const issues: string[] = [];
	const comparisons: Array<
		[keyof ProviderAvailabilityCounts, string]
	> = [
		["subscriptionRelationshipCount", "subscription relationships"],
		["subscriptionMovieCount", "movies with subscriptions"],
		["adsMovieCount", "movies with ad-supported streams"],
		["totalAvailabilityRelationshipCount", "all availability relationships"],
		["availabilityMovieCount", "movies with any recorded availability"],
	];

	if (staged.totalAvailabilityRelationshipCount === 0) {
		issues.push("The completed provider refresh contains no availability rows.");
	}

	for (const [property, label] of comparisons) {
		const currentCount = current[property];
		const stagedCount = staged[property];

		if (currentCount <= 0 || stagedCount >= currentCount) {
			continue;
		}

		const dropPercent = ((currentCount - stagedCount) / currentCount) * 100;

		if (dropPercent > thresholdPercent) {
			issues.push(
				`${label} dropped ${dropPercent.toFixed(2)}% from ${currentCount} to ${stagedCount}; allowed decrease ${thresholdPercent}%.`,
			);
		}
	}

	return issues;
}

async function findRunByResultValue(
	env: Env,
	jobName: string,
	jsonPath: string,
	value: string,
) {
	const row = await env.DB.prepare(
		`SELECT job_run_id
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND json_extract(COALESCE(result_json, '{}'), ?) = ?
		 ORDER BY started_at DESC
		 LIMIT 1`,
	)
		.bind(jobName, jsonPath, value)
		.first<{ job_run_id: string }>();

	return row ? getImportJobRunById(env, row.job_run_id) : null;
}

async function findProviderPromotionRun(
	env: Env,
	providerRefreshJobRunId: string,
) {
	return findRunByResultValue(
		env,
		MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
		"$.providerRefreshJobRunId",
		providerRefreshJobRunId,
	);
}

async function findProviderCacheWarmRun(
	env: Env,
	providerPromotionJobRunId: string,
) {
	return findRunByResultValue(
		env,
		CACHE_WARM_SEARCH_JOB_NAME,
		"$.providerPromotionJobRunId",
		providerPromotionJobRunId,
	);
}

async function findProviderValidationRun(
	env: Env,
	providerRefreshJobRunId: string,
) {
	return findRunByResultValue(
		env,
		PROVIDER_AVAILABILITY_VALIDATION_JOB_NAME,
		"$.providerRefreshJobRunId",
		providerRefreshJobRunId,
	);
}

async function validateProviderAvailabilityCycleUnlocked(
	env: Env,
	source: ProviderCycleSource,
	forcedIssue?: string,
) {
	const existing = await findProviderValidationRun(
		env,
		source.providerRefreshJobRunId,
	);

	if (existing) {
		return existing;
	}

	const providerRefreshRun = await getImportJobRunById(
		env,
		source.providerRefreshJobRunId,
	);
	const trigger = normalizeTrigger(providerRefreshRun?.trigger ?? "cron");
	const jobRunId = createImportJobRunId(
		PROVIDER_AVAILABILITY_VALIDATION_JOB_NAME,
		trigger,
	);

	await createImportJobRun(env, {
		jobRunId,
		jobName: PROVIDER_AVAILABILITY_VALIDATION_JOB_NAME,
		trigger,
	});

	const issues = forcedIssue ? [forcedIssue] : [];
	const providerPromotionRun = source.providerPromotionJobRunId
		? await getImportJobRunById(env, source.providerPromotionJobRunId)
		: null;
	const cacheWarmRun = source.cacheWarmJobRunId
		? await getImportJobRunById(env, source.cacheWarmJobRunId)
		: null;

	if (!isCompleteWithoutErrors(providerRefreshRun)) {
		issues.push("Provider Refresh did not complete every selected movie without errors.");
	}

	if (!isCompleteWithoutErrors(providerPromotionRun)) {
		issues.push("Provider Apply did not complete without errors.");
	} else if (
		parseResultJson(providerPromotionRun.result_json)
			.providerRefreshJobRunId !== source.providerRefreshJobRunId
	) {
		issues.push("Provider Apply did not use the exact completed Provider Refresh run.");
	}

	if (!isCompleteWithoutErrors(cacheWarmRun)) {
		issues.push("Provider-triggered search cache warming did not complete without errors.");
	}

	let expectedCounts: ProviderAvailabilityCounts | null = null;
	let liveCounts: ProviderAvailabilityCounts | null = null;
	let unappliedChangeCount: number | null = null;

	if (providerPromotionRun) {
		expectedCounts = parseProviderAvailabilityCounts(
			parseResultJson(providerPromotionRun.result_json).projectedCounts,
		);
		liveCounts = await getLiveProviderCounts(env);
		unappliedChangeCount = await countUnappliedMovieWatchProviderChanges(
			env,
			source.providerRefreshJobRunId,
		);

		if (!expectedCounts) {
			issues.push("Provider Apply did not record its expected final live counts.");
		} else {
			for (const property of Object.keys(
				expectedCounts,
			) as Array<keyof ProviderAvailabilityCounts>) {
				if (expectedCounts[property] !== liveCounts[property]) {
					issues.push(
						`Live ${property} is ${liveCounts[property]}, but Provider Apply expected ${expectedCounts[property]}.`,
					);
				}
			}
		}

		if (unappliedChangeCount > 0) {
			issues.push(
				`${unappliedChangeCount} provider relationship change(s) were not reflected in the live table.`,
			);
		}
	}

	const endedAt = new Date().toISOString();
	const result = {
		jobRunId,
		status: issues.length === 0 ? "complete" : "failed",
		providerRefreshJobRunId: source.providerRefreshJobRunId,
		providerPromotionJobRunId: source.providerPromotionJobRunId,
		cacheWarmJobRunId: source.cacheWarmJobRunId,
		issueCount: issues.length,
		issues,
		expectedCounts,
		liveCounts,
		unappliedChangeCount,
		endedAt,
	};

	await finishImportJobRun(env, jobRunId, {
		status: result.status,
		selected: 3,
		processed: 3,
		updated: liveCounts?.totalAvailabilityRelationshipCount ?? 0,
		errors: issues.length,
		result,
		lastError:
			issues.length > 0
				? `Provider availability validation found ${issues.length} issue(s).`
				: null,
	});

	logEvent("provider-availability-validation-complete", {
		jobRunId,
		status: result.status,
		providerRefreshJobRunId: source.providerRefreshJobRunId,
		providerPromotionJobRunId: source.providerPromotionJobRunId,
		cacheWarmJobRunId: source.cacheWarmJobRunId,
		errorCount: issues.length,
	});

	return getImportJobRunById(env, jobRunId);
}

async function validateProviderAvailabilityCycle(
	env: Env,
	source: ProviderCycleSource,
	forcedIssue?: string,
) {
	const existing = await findProviderValidationRun(
		env,
		source.providerRefreshJobRunId,
	);

	if (existing) {
		return existing;
	}

	const providerRefreshRun = await getImportJobRunById(
		env,
		source.providerRefreshJobRunId,
	);
	const trigger = normalizeTrigger(providerRefreshRun?.trigger ?? "cron");
	const lockOwner = createJobOwner(trigger);
	const acquired = await acquireImportJobLock(
		env,
		PROVIDER_AVAILABILITY_VALIDATION_LOCK_NAME,
		lockOwner,
		PROVIDER_AVAILABILITY_VALIDATION_LOCK_MINUTES,
	);

	if (!acquired) {
		/*
			Only one queue message may create the final validation and its email. A
			second message can arrive while that short operation is still running; the
			lock owner will finish the shared work, so the second caller has nothing to
			create.
		*/
		return null;
	}

	try {
		return await validateProviderAvailabilityCycleUnlocked(
			env,
			source,
			forcedIssue,
		);
	} finally {
		await releaseImportJobLock(
			env,
			PROVIDER_AVAILABILITY_VALIDATION_LOCK_NAME,
			lockOwner,
		);
	}
}

export async function recordProviderAvailabilityCycleFailure(
	env: Env,
	providerRefreshJobRunId: string,
	reason: string,
	partialSource: Partial<Omit<ProviderCycleSource, "providerRefreshJobRunId">> = {},
) {
	return validateProviderAvailabilityCycle(
		env,
		{
			providerRefreshJobRunId,
			providerPromotionJobRunId:
				partialSource.providerPromotionJobRunId ?? null,
			cacheWarmJobRunId: partialSource.cacheWarmJobRunId ?? null,
		},
		reason,
	);
}

/**
 * Called after provider queue progress is recorded. Most messages return
 * immediately because the parent refresh is still running. Only the message
 * that observes the completed parent run can begin the live-data sequence.
 */
export async function continueIndependentProviderAvailabilityCycle(
	env: Env,
	providerRefreshJobRunId: string,
) {
	const providerRefreshRun = await getImportJobRunById(
		env,
		providerRefreshJobRunId,
	);

	if (!providerRefreshRun || ["queued", "running"].includes(providerRefreshRun.status)) {
		return { started: false, reason: "provider_refresh_still_running" };
	}

	if (!isCompleteWithoutErrors(providerRefreshRun)) {
		await recordProviderAvailabilityCycleFailure(
			env,
			providerRefreshJobRunId,
			"Provider Refresh ended without a complete, error-free snapshot.",
		);
		return { started: false, reason: "provider_refresh_not_successful" };
	}

	const completedValidation = await findProviderValidationRun(
		env,
		providerRefreshJobRunId,
	);

	if (completedValidation) {
		return { started: false, reason: "provider_cycle_already_validated" };
	}

	const trigger = normalizeTrigger(providerRefreshRun.trigger);
	const lockOwner = createJobOwner(trigger);
	const acquired = await acquireImportJobLock(
		env,
		PROVIDER_AVAILABILITY_CYCLE_LOCK_NAME,
		lockOwner,
		PROVIDER_AVAILABILITY_CYCLE_LOCK_MINUTES,
	);

	if (!acquired) {
		return { started: false, reason: "provider_cycle_coordinator_active" };
	}

	let promotionRun = await findProviderPromotionRun(
		env,
		providerRefreshJobRunId,
	);
	let cacheWarmRun: ImportJobRunRow | null = null;

	try {
		if (!promotionRun) {
			await preparePendingMovieWatchProviderChanges(
				env,
				providerRefreshJobRunId,
			);
			const [currentCounts, projectedCounts] = await Promise.all([
				getLiveProviderCounts(env),
				getProjectedMovieWatchProviderCounts(
					env,
					providerRefreshJobRunId,
				),
			]);
			const countIssues = getProviderAvailabilityCountIssues(
				currentCounts,
				projectedCounts,
			);

			if (countIssues.length > 0) {
				throw new Error(
					`Provider safety validation stopped the live replacement: ${countIssues.join(" ")}`,
				);
			}

			const promotion = await promotePendingMovieWatchProviders(
				env,
				trigger,
				providerRefreshJobRunId,
				projectedCounts,
			);
			promotionRun = await getImportJobRunById(env, promotion.jobRunId);
		}

		if (!isCompleteWithoutErrors(promotionRun)) {
			throw new Error("Provider Apply did not complete without errors.");
		}

		cacheWarmRun = await findProviderCacheWarmRun(
			env,
			promotionRun.job_run_id,
		);

		if (!cacheWarmRun) {
			const cacheWarm = await enqueueCacheWarmSearchJob(env, {
				trigger,
				source: {
					kind: "provider-refresh",
					providerRefreshJobRunId,
					providerPromotionJobRunId: promotionRun.job_run_id,
				},
			});
			cacheWarmRun = await getImportJobRunById(env, cacheWarm.jobRunId);
		}

		if (
			cacheWarmRun &&
			!["queued", "running"].includes(cacheWarmRun.status)
		) {
			await validateProviderAvailabilityCycle(env, {
				providerRefreshJobRunId,
				providerPromotionJobRunId: promotionRun.job_run_id,
				cacheWarmJobRunId: cacheWarmRun.job_run_id,
			});
		}

		return {
			started: true,
			providerRefreshJobRunId,
			providerPromotionJobRunId: promotionRun.job_run_id,
			cacheWarmJobRunId: cacheWarmRun?.job_run_id ?? null,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);

		await recordProviderAvailabilityCycleFailure(
			env,
			providerRefreshJobRunId,
			reason,
			{
				providerPromotionJobRunId: promotionRun?.job_run_id ?? null,
				cacheWarmJobRunId: cacheWarmRun?.job_run_id ?? null,
			},
		);

		logEvent("provider-availability-cycle-failed", {
			providerRefreshJobRunId,
			providerPromotionJobRunId: promotionRun?.job_run_id ?? null,
			cacheWarmJobRunId: cacheWarmRun?.job_run_id ?? null,
			error: reason,
		});

		return { started: false, reason: "provider_cycle_failed", error: reason };
	} finally {
		await releaseImportJobLock(
			env,
			PROVIDER_AVAILABILITY_CYCLE_LOCK_NAME,
			lockOwner,
		);
	}
}

/**
 * Cache queue messages use this only when their parent cache job records a
 * provider source. Weekly and manually requested cache jobs return without
 * entering provider validation.
 */
export async function finalizeProviderAvailabilityCycleForCacheRun(
	env: Env,
	cacheWarmJobRunId: string,
) {
	const cacheWarmRun = await getImportJobRunById(env, cacheWarmJobRunId);

	if (!cacheWarmRun || ["queued", "running"].includes(cacheWarmRun.status)) {
		return null;
	}

	const result = parseResultJson(cacheWarmRun.result_json);
	const providerRefreshJobRunId = result.providerRefreshJobRunId;
	const providerPromotionJobRunId = result.providerPromotionJobRunId;

	if (
		result.sourceKind !== "provider-refresh" ||
		typeof providerRefreshJobRunId !== "string" ||
		typeof providerPromotionJobRunId !== "string"
	) {
		return null;
	}

	return validateProviderAvailabilityCycle(env, {
		providerRefreshJobRunId,
		providerPromotionJobRunId,
		cacheWarmJobRunId,
	});
}
