const JOB_NAME_TITLES: Record<string, string> = {
	"cache-warm-search": "Search Cache Warm Job",
	"imdb-ratings": "IMDb Ratings Job",
	"movie-genres-promote": "Movie Genres Apply Step",
	"movie-list": "Movie List Job",
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
	"provider-availability-validation": "Provider Refresh Job Summary Report",
	"tmdb-watch-provider-lookup-refresh": "TMDB Watch Provider Lookup Refresh Job",
	"weekly-import-validation": "Weekly Import Validation",
};

const EVENT_TITLE_OVERRIDES: Record<string, string> = {
	"admin-manual-endpoint-method-rejected": "Admin Manual Endpoint Rejected",
	"admin-manual-endpoint-token-missing": "Admin Manual Endpoint Rejected",
	"admin-manual-endpoint-unauthorized": "Admin Manual Endpoint Rejected",
	"manual-endpoint-cancelled": "Manual Endpoint Cancelled",
	"queue-message-failed": "Queue Message Failed",
	"scheduled-cron-unhandled": "Scheduled Cron Unhandled",
	"tmdb-limited-primary-manual-end": "TMDB Limited Primary Manual Job Complete",
	"tmdb-limited-primary-manual-start": "TMDB Limited Primary Manual Job Started",
	"tmdb-window-single-day-cap": "TMDB Primary Date Window Hit Single-Day Cap",
	"tmdb-window-split": "TMDB Primary Date Window Split",
};

function getStringField(fields: Record<string, unknown>, key: string) {
	const value = fields[key];
	return typeof value === "string" ? value : null;
}

function getNumberField(fields: Record<string, unknown>, key: string) {
	const value = fields[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getErrorCount(event: string, fields: Record<string, unknown>) {
	const explicitErrorCount =
		getNumberField(fields, "errorCount") ??
		getNumberField(fields, "error_count") ??
		getNumberField(fields, "errors") ??
		getNumberField(fields, "errorsInMessage");

	if (explicitErrorCount !== null) {
		return explicitErrorCount;
	}

	if (
		fields.error !== undefined ||
		fields.lastError !== undefined ||
		fields.last_error !== undefined
	) {
		return 1;
	}

	if (/(cancelled|error|failed|missing|rejected|unauthorized)/.test(event)) {
		return 1;
	}

	return 0;
}

function formatDurationMs(durationMs: number) {
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

function getDurationText(fields: Record<string, unknown>) {
	const durationMs = getNumberField(fields, "durationMs");

	if (durationMs !== null) {
		return formatDurationMs(durationMs);
	}

	const startedAt = getStringField(fields, "startedAt");
	const endedAt = getStringField(fields, "endedAt");

	if (startedAt && endedAt) {
		const startedAtMs = Date.parse(startedAt);
		const endedAtMs = Date.parse(endedAt);

		if (Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)) {
			return formatDurationMs(Math.max(endedAtMs - startedAtMs, 0));
		}
	}

	return "Not recorded";
}

function toTitleCase(value: string) {
	return value
		.split("-")
		.filter(Boolean)
		.map((part) => {
			const lowerPart = part.toLowerCase();

			if (lowerPart === "api") {
				return "API";
			}

			if (lowerPart === "id") {
				return "ID";
			}

			if (lowerPart === "imdb") {
				return "IMDb";
			}

			if (lowerPart === "tmdb") {
				return "TMDB";
			}

			if (lowerPart === "url") {
				return "URL";
			}

			return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
		})
		.join(" ");
}

function getEventPhase(event: string) {
	if (event.endsWith("-queue-message-start")) {
		return "Queue Message Started";
	}

	if (event.endsWith("-queue-message-end")) {
		return "Queue Message Complete";
	}

	if (event.endsWith("-queue-message-skipped")) {
		return "Queue Message Skipped";
	}

	if (event.endsWith("-enqueue-start")) {
		return "Enqueue Started";
	}

	if (event.endsWith("-enqueue-end")) {
		return "Enqueue Complete";
	}

	if (event.endsWith("-row-error")) {
		return "Row Error";
	}

	if (event.endsWith("-entry-failed")) {
		return "Entry Failed";
	}

	if (event.endsWith("-method-rejected")) {
		return "Method Rejected";
	}

	if (event.endsWith("-token-missing")) {
		return "Token Missing";
	}

	if (event.endsWith("-unauthorized")) {
		return "Unauthorized";
	}

	if (event.endsWith("-cancelled")) {
		return "Cancelled";
	}

	if (event.endsWith("-skipped")) {
		return "Skipped";
	}

	if (event.endsWith("-progress")) {
		return "Progress Status";
	}

	if (event.endsWith("-start")) {
		return "Started";
	}

	if (event.endsWith("-end") || event.endsWith("-complete")) {
		return "Complete";
	}

	if (event.endsWith("-paused")) {
		return "Paused";
	}

	if (event.endsWith("-acquired")) {
		return "Acquired";
	}

	if (event.endsWith("-released")) {
		return "Released";
	}

	if (event.endsWith("-failed")) {
		return "Failed";
	}

	return "";
}

function getCacheWarmGenreSuffix(
	event: string,
	fields: Record<string, unknown>,
) {
	if (!event.startsWith("cache-warm-search")) {
		return "";
	}

	const selectedGenreCount = getNumberField(fields, "selectedGenreCount");

	if (selectedGenreCount !== null && selectedGenreCount !== 1) {
		return "";
	}

	const selectedGenreKey = getStringField(fields, "selectedGenreKey");

	if (!selectedGenreKey) {
		return "";
	}

	return ` - ${toTitleCase(selectedGenreKey).toUpperCase()}`;
}

function getEventTitle(event: string, fields: Record<string, unknown>) {
	const titleOverride = EVENT_TITLE_OVERRIDES[event];

	if (titleOverride) {
		return titleOverride;
	}

	const explicitJobName = getStringField(fields, "jobName");
	const matchedJobName =
		explicitJobName ??
		Object.keys(JOB_NAME_TITLES)
			.sort((left, right) => right.length - left.length)
			.find((jobName) => event.startsWith(jobName));
	const baseTitle = matchedJobName
		? JOB_NAME_TITLES[matchedJobName] ?? toTitleCase(matchedJobName)
		: toTitleCase(event);
	const phase = getEventPhase(event);

	if (!phase || baseTitle.endsWith(phase)) {
		return `${baseTitle}${getCacheWarmGenreSuffix(event, fields)}`;
	}

	return `${baseTitle} ${phase}${getCacheWarmGenreSuffix(event, fields)}`;
}

function buildEventSummary(event: string, fields: Record<string, unknown>) {
	return `[EVENT]: ${getEventTitle(event, fields)} .......... [ERROR]: ${getErrorCount(
		event,
		fields,
	)} Errors .......... [DURATION]: ${getDurationText(fields)}`;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}) {
	console.log(buildEventSummary(event, fields));
}
