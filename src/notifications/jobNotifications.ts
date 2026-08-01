import { logEvent } from "../shared/logging";
import type { Env } from "../shared/types";
import { sendSmtpEmail } from "./smtpClient";

type NotificationJobRunRow = {
	job_run_id: string;
	job_name: string;
	status: string;
	trigger: string;
	selected_count: number;
	queued_count: number;
	processed_count: number;
	updated_count: number;
	error_count: number;
	provider_rows_inserted: number;
	started_at: string;
	last_progress_at: string;
	ended_at: string | null;
	last_error: string | null;
	result_json: string | null;
	notification_sent_at: string | null;
	notification_error: string | null;
};

const JOB_NAME_TITLES: Record<string, string> = {
	"cache-warm-search": "Search Cache Warm Job",
	"imdb-ratings": "IMDb Ratings Job",
	"movie-genres-promote": "Movie Genres Apply Step",
	"movie-list-build": "Movie List Build Job",
	"movie-list-current-count-snapshot": "Movie List Current Count Snapshot",
	"movie-list-potential-load-check": "Movie List Potential Load Safety Check",
	"movie-watch-providers-promote": "Movie Watch Providers Apply Step",
	"tmdb-enrich": "TMDB Full Detail Enrichment Job",
	"tmdb-genre-lookup-refresh": "TMDB Genre Lookup Refresh Job",
	"tmdb-language-lookup-refresh": "TMDB Language Lookup Refresh Job",
	"tmdb-new-movie-details": "TMDB New Movie Details Job",
	"tmdb-original-language-backfill": "TMDB Original Language Backfill Job",
	"tmdb-original-language-residual": "TMDB Original Language Residual Job",
	"tmdb-primary": "TMDB Primary New Movies Job",
	"tmdb-popularity-refresh": "TMDB Popularity Refresh Job",
	"tmdb-provider-refresh": "TMDB Watch Provider Refresh Job",
	"tmdb-watch-provider-lookup-refresh":
		"TMDB Watch Provider Lookup Refresh Job",
	"weekly-import-validation": "Weekly Import Validation",
};

function isNotificationDisabled(env: Env) {
	return env.JOB_NOTIFICATION_EMAIL_ENABLED?.toLowerCase() === "false";
}

function getJobTitle(jobName: string) {
	return JOB_NAME_TITLES[jobName] ?? jobName;
}

export function getEmailOutcomeLabel(status: string) {
	if (status === "complete") {
		return "SUCCESS";
	}

	if (["failed", "cancelled", "complete_with_errors"].includes(status)) {
		return "FAILED";
	}

	if (status === "skipped") {
		return "ACTION REQUIRED";
	}

	return status.toUpperCase();
}

function formatDateForRuntime(value: string | null) {
	if (!value) {
		return null;
	}

	if (value.includes("T")) {
		return value;
	}

	return `${value.replace(" ", "T")}Z`;
}

function getDurationMs(run: NotificationJobRunRow) {
	const startedAt = Date.parse(formatDateForRuntime(run.started_at) ?? "");
	const endedAt = Date.parse(formatDateForRuntime(run.ended_at) ?? "");

	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
		return null;
	}

	return Math.max(endedAt - startedAt, 0);
}

function formatDurationMs(durationMs: number | null) {
	if (durationMs === null) {
		return "not recorded";
	}

	if (durationMs < 1000) {
		return "less than 1 second";
	}

	const totalSeconds = Math.round(durationMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];

	if (hours > 0) {
		parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
	}

	if (minutes > 0) {
		parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
	}

	if (seconds > 0 && hours === 0) {
		parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
	}

	return parts.join(" ");
}

function truncateNotificationError(error: unknown) {
	const message =
		error instanceof Error ? error.message : String(error ?? "Unknown error");

	return message.slice(0, 1000);
}

function getSmtpNotificationConfig(env: Env) {
	const from = env.JOB_NOTIFICATION_EMAIL_FROM;
	const to = env.JOB_NOTIFICATION_EMAIL_TO;
	const smtpHost = env.JOB_SMTP_HOST;
	const smtpPort = Number(env.JOB_SMTP_PORT ?? "465");
	const smtpUsername = env.JOB_SMTP_USERNAME;
	const smtpPassword = env.JOB_SMTP_PASSWORD;

	if (
		!from ||
		!to ||
		!smtpHost ||
		!Number.isInteger(smtpPort) ||
		smtpPort <= 0 ||
		!smtpUsername ||
		!smtpPassword
	) {
		throw new Error(
			"Job notification SMTP is not configured. Set JOB_NOTIFICATION_EMAIL_FROM, JOB_NOTIFICATION_EMAIL_TO, JOB_SMTP_HOST, JOB_SMTP_PORT, JOB_SMTP_USERNAME, and JOB_SMTP_PASSWORD.",
		);
	}

	return {
		from,
		to,
		smtpHost,
		smtpPort,
		smtpUsername,
		smtpPassword,
	};
}

function getMonitorUrl(run: NotificationJobRunRow) {
	const jobName = encodeURIComponent(run.job_name);

	return `https://movieapp-cloudflare.carlo-roncallo.workers.dev/admin/import/job-runs?jobName=${jobName}&limit=1`;
}

function getWeeklyValidationSummaryLines(run: NotificationJobRunRow) {
	if (run.job_name !== "weekly-import-validation" || !run.result_json) {
		return [];
	}

	try {
		const result = JSON.parse(run.result_json) as {
			pipelineDate?: unknown;
			issues?: Array<{ message?: unknown }>;
			reconciledRunCount?: unknown;
		};
		const issues = Array.isArray(result.issues) ? result.issues : [];
		const lines = [
			"",
			`Pipeline date: ${typeof result.pipelineDate === "string" ? result.pipelineDate : "not recorded"}`,
			`Validation issues: ${issues.length}`,
			`Jobs changed from running to failed: ${typeof result.reconciledRunCount === "number" ? result.reconciledRunCount : 0}`,
		];

		for (const issue of issues) {
			if (typeof issue.message === "string") {
				lines.push(`- ${issue.message}`);
			}
		}

		return lines;
	} catch {
		return [];
	}
}

function buildEmailText(run: NotificationJobRunRow) {
	const durationText = formatDurationMs(getDurationMs(run));
	const outcomeLabel = getEmailOutcomeLabel(run.status);
	const lines = [
		`${outcomeLabel}: MovieApp job finished with status ${run.status}.`,
		"",
		`Job: ${getJobTitle(run.job_name)} (${run.job_name})`,
		`Status: ${run.status}`,
		`Trigger: ${run.trigger}`,
		`Duration: ${durationText}`,
		`Job run ID: ${run.job_run_id}`,
		"",
		`Selected count: ${run.selected_count}`,
		`Queued count: ${run.queued_count}`,
		`Processed count: ${run.processed_count}`,
		`Updated count: ${run.updated_count}`,
		`Error count: ${run.error_count}`,
		`Provider rows inserted: ${run.provider_rows_inserted}`,
		"",
		`Started at: ${run.started_at}`,
		`Ended at: ${run.ended_at ?? "not recorded"}`,
		`Last error: ${run.last_error ?? "none"}`,
		...getWeeklyValidationSummaryLines(run),
		"",
		`Monitor: ${getMonitorUrl(run)}`,
	];

	if (run.result_json) {
		lines.push("", "Result JSON:", run.result_json);
	}

	return lines.join("\n");
}

async function setNotificationError(
	env: Env,
	jobRunId: string,
	error: string,
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET notification_error = ?
		 WHERE job_run_id = ?`,
	)
		.bind(error, jobRunId)
		.run();
}

async function markNotificationSent(
	env: Env,
	jobRunId: string,
	messageId: string | null,
	smtpAcceptedReply: string | null,
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET notification_sent_at = CURRENT_TIMESTAMP,
		     notification_error = NULL,
		     result_json =
		       CASE
		         WHEN ? IS NOT NULL AND ? IS NOT NULL THEN
		           json_set(
		             COALESCE(result_json, '{}'),
		             '$.notificationEmailMessageId',
		             ?,
		             '$.notificationEmailSmtpReply',
		             ?
		           )
		         WHEN ? IS NOT NULL THEN
		           json_set(
		             COALESCE(result_json, '{}'),
		             '$.notificationEmailMessageId',
		             ?
		           )
		         ELSE result_json
		       END
		 WHERE job_run_id = ?`,
	)
		.bind(
			messageId,
			smtpAcceptedReply,
			messageId,
			smtpAcceptedReply,
			messageId,
			messageId,
			jobRunId,
		)
		.run();
}

async function getNotificationJobRun(env: Env, jobRunId: string) {
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
		        result_json,
		        notification_sent_at,
		        notification_error
		 FROM import_job_runs
		 WHERE job_run_id = ?`,
	)
		.bind(jobRunId)
		.first<NotificationJobRunRow>();
}

export async function notifyImportJobRunCompletion(
	env: Env,
	jobRunId: string,
) {
	try {
		if (isNotificationDisabled(env)) {
			return;
		}

		const claimResult = await env.DB.prepare(
			`UPDATE import_job_runs
			 SET notification_error = 'sending'
			 WHERE job_run_id = ?
			   AND ended_at IS NOT NULL
			   AND notification_sent_at IS NULL
			   AND COALESCE(notification_error, '') != 'sending'`,
		)
			.bind(jobRunId)
			.run();

		if (claimResult.meta.changes === 0) {
			return;
		}

		const run = await getNotificationJobRun(env, jobRunId);

		if (!run || !run.ended_at) {
			return;
		}

		let config: ReturnType<typeof getSmtpNotificationConfig>;

		try {
			config = getSmtpNotificationConfig(env);
		} catch (error) {
			const message = truncateNotificationError(error);
			await setNotificationError(env, jobRunId, message);
			logEvent("job-notification-email-skipped", {
				jobName: run.job_name,
				jobRunId,
				status: run.status,
				error: message,
			});
			return;
		}

		const durationText = formatDurationMs(getDurationMs(run));
		const smtpResult = await sendSmtpEmail(
			{
				host: config.smtpHost,
				port: config.smtpPort,
				username: config.smtpUsername,
				password: config.smtpPassword,
			},
			{
				from: config.from,
				to: config.to,
				subject: `[MovieApp] ${getEmailOutcomeLabel(run.status)}: ${getJobTitle(run.job_name)} (${run.status}, ${durationText})`,
				text: buildEmailText(run),
			},
		);

		await markNotificationSent(
			env,
			jobRunId,
			smtpResult.messageId,
			smtpResult.smtpAcceptedReply,
		);
		logEvent("job-notification-email-sent", {
			jobName: run.job_name,
			jobRunId,
			status: run.status,
			durationMs: getDurationMs(run),
			errorCount: run.error_count,
			messageId: smtpResult.messageId,
			smtpAcceptedReply: smtpResult.smtpAcceptedReply,
		});
	} catch (error) {
		const notificationError = truncateNotificationError(error);

		try {
			await setNotificationError(env, jobRunId, notificationError);
		} catch (recordError) {
			logEvent("job-notification-error-record-failed", {
				jobRunId,
				error: truncateNotificationError(recordError),
			});
		}

		logEvent("job-notification-email-failed", {
			jobRunId,
			error: notificationError,
		});
	}
}

export async function retryImportJobRunCompletionNotification(
	env: Env,
	jobRunId: string,
) {
	/*
		A Worker can stop after claiming an email but before recording the SMTP
		result, leaving notification_error set to "sending". The final pipeline
		audit runs hours after the individual jobs, so it is safe for that audit to
		clear an unfinished claim and retry. In the rare case that SMTP accepted the
		first message but D1 did not record it, this favors a duplicate notification
		over silently losing a failure notice.
	*/
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET notification_error = NULL
		 WHERE job_run_id = ?
		   AND ended_at IS NOT NULL
		   AND notification_sent_at IS NULL`,
	)
		.bind(jobRunId)
		.run();

	await notifyImportJobRunCompletion(env, jobRunId);
}

export async function sendJobNotificationTestEmail(env: Env) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();

	if (isNotificationDisabled(env)) {
		throw new Error("Job notification email is disabled.");
	}

	const config = getSmtpNotificationConfig(env);
	const smtpResult = await sendSmtpEmail(
		{
			host: config.smtpHost,
			port: config.smtpPort,
			username: config.smtpUsername,
			password: config.smtpPassword,
		},
		{
			from: config.from,
			to: config.to,
			subject: "[MovieApp] Job notification email test",
			text: [
				"MovieApp job notification email test.",
				"",
				"This confirms the Worker can connect to Dynu SMTP and Dynu accepted the message.",
				"",
				`Started at: ${startedAt}`,
				`From: ${config.from}`,
				`To: ${config.to}`,
			].join("\n"),
		},
	);
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const durationMs = endedAtMs - startedAtMs;
	const result = {
		status: "sent",
		from: config.from,
		to: config.to,
		messageId: smtpResult.messageId,
		smtpAcceptedReply: smtpResult.smtpAcceptedReply,
		startedAt,
		endedAt,
		durationMs,
	};

	logEvent("job-notification-email-test-complete", {
		durationMs,
		errorCount: 0,
		messageId: smtpResult.messageId,
		smtpAcceptedReply: smtpResult.smtpAcceptedReply,
	});

	return result;
}
