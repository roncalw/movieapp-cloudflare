export interface Env {
	DB: D1Database;
	CACHE_WARM_QUEUE: Queue<CacheWarmSearchQueueMessage>;
	IMDB_RATING_QUEUE: Queue<ImdbRatingQueueMessage>;
	TMDB_ENRICHMENT_QUEUE: Queue<
		| TmdbEnrichmentQueueMessage
		| TmdbNewMovieDetailsQueueMessage
		| TmdbProviderRefreshQueueMessage
	>;
	TMDB_API_KEY: string;
	ADMIN_IMPORT_TOKEN?: string;
	JOB_NOTIFICATION_EMAIL_ENABLED?: string;
	JOB_NOTIFICATION_EMAIL_FROM?: string;
	JOB_NOTIFICATION_EMAIL_TO?: string;
	JOB_SMTP_HOST?: string;
	JOB_SMTP_PASSWORD?: string;
	JOB_SMTP_PORT?: string;
	JOB_SMTP_USERNAME?: string;
	ALL_JOBS_PAUSED?: string;
	CACHE_WARM_JOB_PAUSED?: string;
	IMDB_JOB_PAUSED?: string;
	TMDB_PRIMARY_JOB_PAUSED?: string;
	TMDB_NEW_MOVIE_DETAILS_JOB_PAUSED?: string;
	TMDB_ENRICH_JOB_PAUSED?: string;
	MOVIE_LIST_JOB_PAUSED?: string;
}

export type ImdbRatingRow = {
	imdb_id: string;
	average_rating: number | null;
	num_votes: number | null;
};

export type ImdbRatingQueueMessage = {
	kind?: "imdb-ratings";
	jobRunId?: string;
	messageId?: string;
	rows: ImdbRatingRow[];
};

export type TmdbEnrichmentQueueMessage = {
	kind: "tmdb-enrichment";
	jobRunId: string;
	messageId?: string;
	tmdbIds: number[];
};

export type TmdbNewMovieDetailsQueueMessage = {
	kind: "tmdb-new-movie-details";
	jobRunId: string;
	messageId?: string;
	tmdbIds: number[];
};

export type TmdbProviderRefreshQueueMessage = {
	kind: "tmdb-provider-refresh";
	jobRunId: string;
	messageId?: string;
	tmdbIds: number[];
};

export type CacheWarmSearchQueueMessage = {
	kind: "cache-warm-search";
	jobRunId: string;
	messageId?: string;
	genreKey: string;
	genreLabel: string;
	entryName: string;
	url: string;
	maxPages: number;
};

export type WorkerQueueMessage =
	| CacheWarmSearchQueueMessage
	| ImdbRatingQueueMessage
	| TmdbEnrichmentQueueMessage
	| TmdbNewMovieDetailsQueueMessage
	| TmdbProviderRefreshQueueMessage;
