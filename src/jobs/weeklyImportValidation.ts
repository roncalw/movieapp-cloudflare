import {
	createImportJobRun,
	createImportJobRunId,
	failActiveImportJobRun,
	finishImportJobRun,
	IMDB_RATINGS_JOB_NAME,
	MOVIE_GENRES_PROMOTE_JOB_NAME,
	MOVIE_LIST_BUILD_JOB_NAME,
	MOVIE_LIST_CURRENT_COUNT_SNAPSHOT_JOB_NAME,
	MOVIE_LIST_POTENTIAL_LOAD_CHECK_JOB_NAME,
	MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
	TMDB_ENRICH_JOB_NAME,
	TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	TMDB_POPULARITY_REFRESH_JOB_NAME,
	TMDB_PRIMARY_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	WEEKLY_IMPORT_VALIDATION_JOB_NAME,
	type ImportJobRunRow,
	type ImportJobTrigger,
} from "./importJobRuns";
import { getLatestImportJobRunForDate } from "./importJobDependencies";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";
import { retryImportJobRunCompletionNotification } from "../notifications/jobNotifications";

export const REQUIRED_WEEKLY_IMPORT_JOB_NAMES = [
	IMDB_RATINGS_JOB_NAME,
	TMDB_PRIMARY_JOB_NAME,
	TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
	TMDB_POPULARITY_REFRESH_JOB_NAME,
	MOVIE_LIST_BUILD_JOB_NAME,
	"cache-warm-search",
] as const;

export const MOVIE_LIST_SUCCESS_JOB_NAMES = [
	MOVIE_LIST_POTENTIAL_LOAD_CHECK_JOB_NAME,
	MOVIE_GENRES_PROMOTE_JOB_NAME,
	MOVIE_WATCH_PROVIDERS_PROMOTE_JOB_NAME,
	MOVIE_LIST_CURRENT_COUNT_SNAPSHOT_JOB_NAME,
] as const;

const ACTIVE_JOB_NAMES_TO_RECONCILE = [
	...REQUIRED_WEEKLY_IMPORT_JOB_NAMES,
	...MOVIE_LIST_SUCCESS_JOB_NAMES,
	TMDB_ENRICH_JOB_NAME,
] as const;

type WeeklyImportValidationIssue = {
	jobName: string;
	code:
		| "missing"
		| "not_complete"
		| "errors_recorded"
		| "missing_end_time"
		| "processed_count_mismatch"
		| "notification_missing"
		| "notification_failed"
		| "source_run_missing"
		| "source_run_mismatch";
	message: string;
	jobRunId?: string;
	status?: string;
};

type CheckedJob = {
	jobRunId: string;
	status: string;
	selectedCount: number;
	queuedCount: number;
	processedCount: number;
	updatedCount: number;
	errorCount: number;
	startedAt: string;
	endedAt: string | null;
	lastError: string | null;
	notificationSentAt: string | null;
	notificationError: string | null;
};

function toCheckedJob(run: ImportJobRunRow): CheckedJob {
	return {
		jobRunId: run.job_run_id,
		status: run.status,
		selectedCount: run.selected_count,
		queuedCount: run.queued_count,
		processedCount: run.processed_count,
		updatedCount: run.updated_count,
		errorCount: run.error_count,
		startedAt: run.started_at,
		endedAt: run.ended_at,
		lastError: run.last_error,
		notificationSentAt: run.notification_sent_at,
		notificationError: run.notification_error,
	};
}

function getRunFailureDetail(run: ImportJobRunRow) {
	const details: string[] = [];

	if (run.last_error) {
		details.push(`Last error: ${run.last_error}.`);
	}

	if (run.result_json) {
		try {
			const result = JSON.parse(run.result_json) as {
				dependencyBlockers?: Array<{
					jobName?: unknown;
					reason?: unknown;
					status?: unknown;
				}>;
			};

			for (const blocker of result.dependencyBlockers ?? []) {
				const jobName =
					typeof blocker.jobName === "string" ? blocker.jobName : "unknown job";
				const reason =
					typeof blocker.reason === "string"
						? blocker.reason
						: "unknown reason";
				const status =
					typeof blocker.status === "string"
						? ` with status ${blocker.status}`
						: "";
				details.push(`Blocked by ${jobName}${status}: ${reason}.`);
			}
		} catch {
			// The stored result is still included in the detailed job monitor. A
			// malformed historical value must not prevent the final audit itself.
		}
	}

	return details.join(" ");
}

export function getMovieListSourceRunIssues(
	movieListRun: ImportJobRunRow,
	dependencyRuns: Record<string, ImportJobRunRow | null>,
) {
	const issues: WeeklyImportValidationIssue[] = [];
	let result: Record<string, unknown> = {};

	try {
		result = JSON.parse(movieListRun.result_json ?? "{}") as Record<
			string,
			unknown
		>;
	} catch {
		// The missing source-run checks below produce the actionable result.
	}

	for (const source of [
		{
			jobName: IMDB_RATINGS_JOB_NAME,
			resultProperty: "imdbSourceJobRunId",
		},
		{
			jobName: TMDB_POPULARITY_REFRESH_JOB_NAME,
			resultProperty: "popularitySourceJobRunId",
		},
	] as const) {
		const expectedRunId = dependencyRuns[source.jobName]?.job_run_id;
		const actualRunId = result[source.resultProperty];

		if (typeof actualRunId !== "string" || actualRunId.length === 0) {
			issues.push({
				jobName: MOVIE_LIST_BUILD_JOB_NAME,
				code: "source_run_missing",
				message: `Movie List did not record ${source.resultProperty}.`,
				jobRunId: movieListRun.job_run_id,
				status: movieListRun.status,
			});
			continue;
		}

		if (expectedRunId && actualRunId !== expectedRunId) {
			issues.push({
				jobName: MOVIE_LIST_BUILD_JOB_NAME,
				code: "source_run_mismatch",
				message: `Movie List used ${actualRunId} for ${source.jobName}, but this pipeline date requires ${expectedRunId}.`,
				jobRunId: movieListRun.job_run_id,
				status: movieListRun.status,
			});
		}
	}

	return issues;
}

export function getWeeklyImportValidationIssues(
	jobName: string,
	run: ImportJobRunRow | null,
) {
	const issues: WeeklyImportValidationIssue[] = [];

	if (!run) {
		issues.push({
			jobName,
			code: "missing",
			message: `No ${jobName} run exists for this pipeline date.`,
		});
		return issues;
	}

	if (run.status !== "complete") {
		const failureDetail = getRunFailureDetail(run);
		issues.push({
			jobName,
			code: "not_complete",
			message: `${jobName} ended with status ${run.status}.${failureDetail ? ` ${failureDetail}` : ""}`,
			jobRunId: run.job_run_id,
			status: run.status,
		});
	}

	if (run.error_count > 0) {
		issues.push({
			jobName,
			code: "errors_recorded",
			message: `${jobName} recorded ${run.error_count} error(s).`,
			jobRunId: run.job_run_id,
			status: run.status,
		});
	}

	if (run.ended_at === null) {
		issues.push({
			jobName,
			code: "missing_end_time",
			message: `${jobName} has no completion time.`,
			jobRunId: run.job_run_id,
			status: run.status,
		});
	}

	if (
		run.selected_count > 0 &&
		run.processed_count !== run.selected_count
	) {
		issues.push({
			jobName,
			code: "processed_count_mismatch",
			message: `${jobName} selected ${run.selected_count} item(s) but processed ${run.processed_count}.`,
			jobRunId: run.job_run_id,
			status: run.status,
		});
	}

	if (run.ended_at !== null && run.notification_sent_at === null) {
		if (run.notification_error) {
			issues.push({
				jobName,
				code: "notification_failed",
				message: `${jobName} finished, but its email was not accepted. Notification error: ${run.notification_error}`,
				jobRunId: run.job_run_id,
				status: run.status,
			});
		} else {
			issues.push({
				jobName,
				code: "notification_missing",
				message: `${jobName} finished, but no sent-email timestamp was recorded.`,
				jobRunId: run.job_run_id,
				status: run.status,
			});
		}
	}

	return issues;
}

async function getRunAfterNotificationRetry(
	env: Env,
	jobName: string,
	runDate: string,
) {
	let run = await getLatestImportJobRunForDate(env, jobName, runDate);

	if (run?.ended_at && !run.notification_sent_at) {
		await retryImportJobRunCompletionNotification(env, run.job_run_id);
		run = await getLatestImportJobRunForDate(env, jobName, runDate);
	}

	return run;
}

async function getActiveScheduledPipelineRuns(env: Env) {
	const placeholders = ACTIVE_JOB_NAMES_TO_RECONCILE.map(() => "?").join(", ");
	const { results } = await env.DB.prepare(
		`SELECT job_run_id,
		        job_name,
		        status,
		        trigger,
		        selected_count,
		        queued_count,
		        processed_count,
		        updated_count,
		        error_count,
		        provider_rows_inserted,
		        started_at,
		        last_progress_at,
		        ended_at,
		        last_error,
		        result_json,
		        notification_sent_at,
		        notification_error
		 FROM import_job_runs
		 WHERE trigger = 'cron'
		   AND status IN ('queued', 'running')
		   AND job_name IN (${placeholders})
		 ORDER BY started_at`,
	)
		.bind(...ACTIVE_JOB_NAMES_TO_RECONCILE)
		.all<ImportJobRunRow>();

	return results;
}

async function reconcileActiveScheduledPipelineRuns(env: Env) {
	const activeRuns = await getActiveScheduledPipelineRuns(env);
	const reconciledRuns: Array<{
		jobName: string;
		jobRunId: string;
		previousStatus: string;
		startedAt: string;
		lastProgressAt: string;
	}> = [];

	for (const run of activeRuns) {
		const reason =
			"The final weekly pipeline validation found this scheduled job still active after the pipeline deadline.";
		const changed = await failActiveImportJobRun(env, run.job_run_id, reason);

		if (changed > 0) {
			reconciledRuns.push({
				jobName: run.job_name,
				jobRunId: run.job_run_id,
				previousStatus: run.status,
				startedAt: run.started_at,
				lastProgressAt: run.last_progress_at,
			});
		}
	}

	return reconciledRuns;
}

export async function validateWeeklyImportPipeline(
	env: Env,
	trigger: ImportJobTrigger,
	options: { runDate?: string } = {},
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const runDate = options.runDate ?? startedAt.slice(0, 10);
	const jobRunId = createImportJobRunId(
		WEEKLY_IMPORT_VALIDATION_JOB_NAME,
		trigger,
	);

	await createImportJobRun(env, {
		jobRunId,
		jobName: WEEKLY_IMPORT_VALIDATION_JOB_NAME,
		trigger,
	});

	try {
		const reconciledRuns = await reconcileActiveScheduledPipelineRuns(env);
		const checkedJobs: Record<string, CheckedJob | null> = {};
		const checkedJobRuns: Record<string, ImportJobRunRow | null> = {};
		const issues: WeeklyImportValidationIssue[] = [];

		for (const jobName of REQUIRED_WEEKLY_IMPORT_JOB_NAMES) {
			const run = await getRunAfterNotificationRetry(env, jobName, runDate);
			checkedJobRuns[jobName] = run;
			checkedJobs[jobName] = run ? toCheckedJob(run) : null;
			issues.push(...getWeeklyImportValidationIssues(jobName, run));
		}

		const movieListRun = await getRunAfterNotificationRetry(
			env,
			MOVIE_LIST_BUILD_JOB_NAME,
			runDate,
		);

		if (movieListRun?.status === "complete" && movieListRun.error_count === 0) {
			issues.push(
				...getMovieListSourceRunIssues(movieListRun, checkedJobRuns),
			);

			for (const jobName of MOVIE_LIST_SUCCESS_JOB_NAMES) {
				const run = await getRunAfterNotificationRetry(env, jobName, runDate);
				checkedJobRuns[jobName] = run;
				checkedJobs[jobName] = run ? toCheckedJob(run) : null;
				issues.push(...getWeeklyImportValidationIssues(jobName, run));
			}
		}

		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			jobRunId,
			trigger,
			pipelineDate: runDate,
			status: issues.length === 0 ? "complete" : "failed",
			checkedJobCount: Object.keys(checkedJobs).length,
			issueCount: issues.length,
			issues,
			reconciledRunCount: reconciledRuns.length,
			reconciledRuns,
			checkedJobs,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: result.status,
			selected: Object.keys(checkedJobs).length,
			processed: Object.keys(checkedJobs).length,
			updated: reconciledRuns.length,
			errors: issues.length,
			result,
			lastError:
				issues.length > 0
					? `Weekly import validation found ${issues.length} issue(s).`
					: null,
		});

		logEvent("weekly-import-validation-end", {
			jobRunId,
			pipelineDate: runDate,
			status: result.status,
			errorCount: issues.length,
			reconciledRunCount: reconciledRuns.length,
			durationMs: result.durationMs,
		});

		return result;
	} catch (error) {
		const lastError =
			error instanceof Error
				? error.message
				: "Weekly import validation failed unexpectedly.";
		const result = {
			jobRunId,
			trigger,
			pipelineDate: runDate,
			status: "failed",
			reason: "weekly_import_validation_error",
			error: lastError,
			durationMs: Date.now() - startedAtMs,
		};

		await finishImportJobRun(env, jobRunId, {
			status: "failed",
			errors: 1,
			result,
			lastError,
		});

		logEvent("weekly-import-validation-failed", {
			jobRunId,
			pipelineDate: runDate,
			error: lastError,
		});

		throw error;
	}
}
