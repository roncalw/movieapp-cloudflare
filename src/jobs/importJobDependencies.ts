import {
	createImportJobRun,
	finishImportJobRun,
	getActiveImportJobRun,
	type ImportJobRunRow,
	type ImportJobTrigger,
} from "./importJobRuns";
import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";

export type ImportJobDependencyRequirement = {
	jobName: string;
	afterJobName?: string;
	endedAfter?: string | null;
	endedAfterLabel?: string;
};

export type ImportJobDependencyBlocker = {
	jobName: string;
	reason: string;
	jobRunId?: string;
	status?: string;
	errorCount?: number;
	endedAt?: string | null;
	afterJobName?: string;
	afterEndedAt?: string | null;
	requiredEndedAfter?: string | null;
	requiredEndedAfterLabel?: string;
};

export type ImportJobDependencyCheck = {
	ok: boolean;
	blockers: ImportJobDependencyBlocker[];
	runs: Record<string, ImportJobRunRow>;
};

function toUtcTime(value: string | null | undefined) {
	if (!value) {
		return null;
	}

	return Date.parse(`${value.replace(" ", "T")}Z`);
}

function isCompleteWithoutErrors(run: ImportJobRunRow | null | undefined) {
	return (
		!!run &&
		run.status === "complete" &&
		run.error_count === 0 &&
		run.ended_at !== null
	);
}

export async function getLatestImportJobRun(env: Env, jobName: string) {
	return env.DB.prepare(
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
		        result_json
		 FROM import_job_runs
		 WHERE job_name = ?
		 ORDER BY started_at DESC
		 LIMIT 1`,
	)
		.bind(jobName)
		.first<ImportJobRunRow>();
}

export async function getLatestCleanImportJobRunWithResultJsonNumberGreaterThan(
	env: Env,
	options: {
		jobName: string;
		resultJsonPath: string;
		greaterThan: number;
	},
) {
	return env.DB.prepare(
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
		        result_json
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status = 'complete'
		   AND error_count = 0
		   AND ended_at IS NOT NULL
		   AND COALESCE(
		     CAST(json_extract(COALESCE(result_json, '{}'), ?) AS INTEGER),
		     0
		   ) > ?
		 ORDER BY ended_at DESC
		 LIMIT 1`,
	)
		.bind(options.jobName, options.resultJsonPath, options.greaterThan)
		.first<ImportJobRunRow>();
}

export async function checkImportJobDependencies(
	env: Env,
	requirements: ImportJobDependencyRequirement[],
): Promise<ImportJobDependencyCheck> {
	const blockers: ImportJobDependencyBlocker[] = [];
	const runs: Record<string, ImportJobRunRow> = {};

	for (const requirement of requirements) {
		const activeRun = await getActiveImportJobRun(env, requirement.jobName);

		if (activeRun) {
			blockers.push({
				jobName: requirement.jobName,
				reason: "dependency_job_active",
				jobRunId: activeRun.job_run_id,
				status: activeRun.status,
				errorCount: activeRun.error_count,
				endedAt: activeRun.ended_at,
			});
			continue;
		}

		const latestRun = await getLatestImportJobRun(env, requirement.jobName);

		if (!isCompleteWithoutErrors(latestRun)) {
			blockers.push({
				jobName: requirement.jobName,
				reason: latestRun ? "dependency_job_not_complete" : "dependency_job_missing",
				jobRunId: latestRun?.job_run_id,
				status: latestRun?.status,
				errorCount: latestRun?.error_count,
				endedAt: latestRun?.ended_at,
			});
			continue;
		}

		if (!latestRun) {
			continue;
		}

		runs[requirement.jobName] = latestRun;
	}

	for (const requirement of requirements) {
		if (!requirement.afterJobName) {
			const run = runs[requirement.jobName];
			const requiredEndedAfter = toUtcTime(requirement.endedAfter);
			const runEndedAt = toUtcTime(run?.ended_at);

			if (
				run &&
				requiredEndedAfter !== null &&
				(runEndedAt === null || runEndedAt <= requiredEndedAfter)
			) {
				blockers.push({
					jobName: requirement.jobName,
					reason: "dependency_job_ended_before_required_time",
					jobRunId: run.job_run_id,
					status: run.status,
					errorCount: run.error_count,
					endedAt: run.ended_at,
					requiredEndedAfter: requirement.endedAfter,
					requiredEndedAfterLabel: requirement.endedAfterLabel,
				});
			}

			continue;
		}

		const run = runs[requirement.jobName];
		const afterRun = runs[requirement.afterJobName];

		if (!run || !afterRun) {
			continue;
		}

		const runEndedAt = toUtcTime(run.ended_at);
		const afterEndedAt = toUtcTime(afterRun.ended_at);

		if (
			runEndedAt === null ||
			afterEndedAt === null ||
			runEndedAt < afterEndedAt
		) {
			blockers.push({
				jobName: requirement.jobName,
				reason: "dependency_job_ran_before_required_job",
				jobRunId: run.job_run_id,
				status: run.status,
				errorCount: run.error_count,
				endedAt: run.ended_at,
				afterJobName: requirement.afterJobName,
				afterEndedAt: afterRun.ended_at,
			});
		}

		const requiredEndedAfter = toUtcTime(requirement.endedAfter);

		if (requiredEndedAfter === null) {
			continue;
		}

		if (runEndedAt === null || runEndedAt <= requiredEndedAfter) {
			blockers.push({
				jobName: requirement.jobName,
				reason: "dependency_job_ended_before_required_time",
				jobRunId: run.job_run_id,
				status: run.status,
				errorCount: run.error_count,
				endedAt: run.ended_at,
				requiredEndedAfter: requirement.endedAfter,
				requiredEndedAfterLabel: requirement.endedAfterLabel,
			});
		}
	}

	return {
		ok: blockers.length === 0,
		blockers,
		runs,
	};
}

export async function finishSkippedDependencyRun(
	env: Env,
	options: {
		jobRunId: string;
		jobName: string;
		trigger: ImportJobTrigger;
		startedAtMs: number;
		startedAt: string;
		blockers: ImportJobDependencyBlocker[];
		extraResult?: Record<string, unknown>;
	},
) {
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const result = {
		jobRunId: options.jobRunId,
		trigger: options.trigger,
		skipped: true,
		skipReason: "job_dependency_not_ready",
		dependencyBlockers: options.blockers,
		startedAt: options.startedAt,
		endedAt,
		durationMs: endedAtMs - options.startedAtMs,
		...options.extraResult,
	};

	await createImportJobRun(env, {
		jobRunId: options.jobRunId,
		jobName: options.jobName,
		trigger: options.trigger,
		status: "running",
	});
	await finishImportJobRun(env, options.jobRunId, {
		status: "skipped",
		result,
		lastError: result.skipReason,
	});

	logEvent(`${options.jobName}-skipped`, result);

	return result;
}
