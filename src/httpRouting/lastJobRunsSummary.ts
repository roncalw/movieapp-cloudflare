/**
 * Human-readable summary of the six main weekly production jobs.
 *
 * The detailed /admin/import/job-runs endpoint is intentionally exhaustive. It
 * includes helper jobs, promotion steps, manual runs, and every database field.
 * This module provides a smaller operational view that answers one question:
 * "How did the latest scheduled production chain run?"
 *
 * The query selects the newest cron run independently for each main job. The
 * response is then rebuilt in production order so database return order cannot
 * rearrange the workflow presented to a reader.
 */
import {
	IMDB_RATINGS_JOB_NAME,
	MOVIE_LIST_BUILD_JOB_NAME,
	TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	TMDB_PRIMARY_JOB_NAME,
	TMDB_PROVIDER_REFRESH_JOB_NAME,
} from "../jobs/importJobRuns";
import { CACHE_WARM_SEARCH_JOB_NAME } from "../cache/cacheWarmTypes";
import type { Env } from "../shared/types";

type MainJobRunSummaryRow = {
	job_name: string;
	status: string;
	selected_count: number;
	processed_count: number;
	error_count: number;
	started_at: string;
	ended_at: string | null;
	duration_ms: number | null;
};

type JobSummary = {
	Timing: {
		Started_At: string | null;
		Ended_At: string | null;
		Duration: string | null;
	};
	Status: string;
	Work_Counts: {
		Selected: number | null;
		Processed: number | null;
		Errors: number | null;
	};
};

const MAIN_JOBS = [
	{ responseName: "IMDB", databaseName: IMDB_RATINGS_JOB_NAME },
	{ responseName: "Primary", databaseName: TMDB_PRIMARY_JOB_NAME },
	{
		responseName: "Primary Enhanced",
		databaseName: TMDB_NEW_MOVIE_DETAILS_JOB_NAME,
	},
	{
		responseName: "Watch Providers",
		databaseName: TMDB_PROVIDER_REFRESH_JOB_NAME,
	},
	{ responseName: "Movie Table", databaseName: MOVIE_LIST_BUILD_JOB_NAME },
	{
		responseName: "Cache Warming",
		databaseName: CACHE_WARM_SEARCH_JOB_NAME,
	},
] as const;

const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/New_York",
	weekday: "long",
	month: "numeric",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
	second: "2-digit",
	hour12: true,
	timeZoneName: "short",
});

export async function getLastJobRunsSummary(env: Env) {
	const jobPlaceholders = MAIN_JOBS.map(() => "?").join(", ");
	const { results } = await env.DB.prepare(
		`WITH ranked_main_job_runs AS (
			 SELECT job_name,
			        status,
			        selected_count,
			        processed_count,
			        error_count,
			        started_at,
			        ended_at,
			        CAST((julianday(ended_at) - julianday(started_at)) * 86400000 AS INTEGER) AS duration_ms,
			        ROW_NUMBER() OVER (
			          PARTITION BY job_name
			          ORDER BY started_at DESC, job_run_id DESC
			        ) AS run_rank
			 FROM import_job_runs
			 WHERE trigger = 'cron'
			   AND job_name IN (${jobPlaceholders})
		 )
		 SELECT job_name,
		        status,
		        selected_count,
		        processed_count,
		        error_count,
		        started_at,
		        ended_at,
		        duration_ms
		 FROM ranked_main_job_runs
		 WHERE run_rank = 1`,
	)
		.bind(...MAIN_JOBS.map((job) => job.databaseName))
		.all<MainJobRunSummaryRow>();

	const runsByJobName = new Map(
		results.map((run) => [run.job_name, run] as const),
	);
	const summary: Record<string, JobSummary> = {};

	for (const job of MAIN_JOBS) {
		const run = runsByJobName.get(job.databaseName);
		summary[job.responseName] = run
			? buildJobSummary(run)
			: buildMissingJobSummary();
	}

	return summary;
}

function buildJobSummary(run: MainJobRunSummaryRow): JobSummary {
	return {
		Timing: {
			Started_At: formatNewYorkDateTime(run.started_at),
			Ended_At: formatNewYorkDateTime(run.ended_at),
			Duration: formatDuration(run.duration_ms),
		},
		Status: run.status,
		Work_Counts: {
			Selected: run.selected_count,
			Processed: run.processed_count,
			Errors: run.error_count,
		},
	};
}

function buildMissingJobSummary(): JobSummary {
	return {
		Timing: {
			Started_At: null,
			Ended_At: null,
			Duration: null,
		},
		Status: "not_found",
		Work_Counts: {
			Selected: null,
			Processed: null,
			Errors: null,
		},
	};
}

function formatNewYorkDateTime(value: string | null): string | null {
	if (!value) {
		return null;
	}

	/*
	 * D1 CURRENT_TIMESTAMP values are UTC but omit the trailing Z. Adding it
	 * prevents JavaScript from interpreting the database value as local time.
	 */
	const utcDate = new Date(`${value.replace(" ", "T")}Z`);
	const parts = Object.fromEntries(
		NEW_YORK_DATE_FORMATTER.formatToParts(utcDate).map((part) => [
			part.type,
			part.value,
		]),
	);

	return `${parts.weekday.toUpperCase()} - ${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

function formatDuration(durationMs: number | null): string | null {
	if (durationMs === null) {
		return null;
	}

	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const durationParts: string[] = [];

	if (hours > 0) {
		durationParts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
	}

	if (minutes > 0) {
		durationParts.push(
			`${minutes} ${minutes === 1 ? "minute" : "minutes"}`,
		);
	}

	if (seconds > 0 || durationParts.length === 0) {
		durationParts.push(
			`${seconds} ${seconds === 1 ? "second" : "seconds"}`,
		);
	}

	return durationParts.join(" ");
}
