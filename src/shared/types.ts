export interface Env {
	DB: D1Database;
	CACHE_WARM_QUEUE: Queue<CacheWarmSearchQueueMessage>;
	IMDB_RATING_QUEUE: Queue<
		ImdbRatingQueueMessage | ImdbRatingFinalizeQueueMessage
	>;
	TMDB_POPULARITY_QUEUE: Queue<
		TmdbPopularityQueueMessage | TmdbPopularityFinalizeQueueMessage
	>;
	TMDB_ENRICHMENT_QUEUE: Queue<
		| TmdbEnrichmentQueueMessage
		| TmdbNewMovieDetailsQueueMessage
		| TmdbOriginalLanguageBackfillQueueMessage
		| TmdbOriginalLanguageResidualQueueMessage
		| TmdbProviderRefreshDiscoveryQueueMessage
		| TmdbProviderRefreshQueueMessage
	>;
	TMDB_API_KEY: string;
	ADMIN_IMPORT_TOKEN?: string;
	GOOGLE_PLAY_PACKAGE_NAME?: string;
	GOOGLE_PLAY_TRACK?: string;
	GOOGLE_PLAY_CLIENT_EMAIL?: string;
	GOOGLE_PLAY_PRIVATE_KEY?: string;
	GOOGLE_PLAY_TOKEN_URI?: string;
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
	TMDB_POPULARITY_JOB_PAUSED?: string;
	TMDB_NEW_MOVIE_DETAILS_JOB_PAUSED?: string;
	TMDB_ENRICH_JOB_PAUSED?: string;
	MOVIE_LIST_JOB_PAUSED?: string;
	PIPELINE_VALIDATION_JOB_PAUSED?: string;
	ORIGINAL_LANGUAGE_SEARCH_ENABLED?: string;
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

export type ImdbRatingFinalizeQueueMessage = {
	kind: "imdb-ratings-finalize";
	jobRunId: string;
	messageId: string;
	expectedRows: number;
};

export type TmdbPopularityRow = {
	tmdb_id: number;
	popularity: number;
};

export type TmdbPopularityQueueMessage = {
	kind: "tmdb-popularity";
	jobRunId: string;
	messageId: string;
	sourceExportDate: string;
	rows: TmdbPopularityRow[];
};

export type TmdbPopularityFinalizeQueueMessage = {
	kind: "tmdb-popularity-finalize";
	jobRunId: string;
	messageId: string;
	sourceExportDate: string;
	expectedRows: number;
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

export type TmdbProviderRefreshDiscoveryQueueMessage = {
	kind: "tmdb-provider-refresh-discovery";
	jobRunId: string;
	messageId?: string;
	endDate: string;
	attempt: number;
};

export type TmdbOriginalLanguageBackfillQueueMessage = {
	kind: "tmdb-original-language-backfill-discovery";
	jobRunId: string;
	messageId?: string;
	endDate: string;
	attempt: number;
};

export type TmdbOriginalLanguageResidualQueueMessage = {
	kind: "tmdb-original-language-residual";
	jobRunId: string;
	messageId: string;
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
	| ImdbRatingFinalizeQueueMessage
	| TmdbPopularityQueueMessage
	| TmdbPopularityFinalizeQueueMessage
	| TmdbEnrichmentQueueMessage
	| TmdbNewMovieDetailsQueueMessage
	| TmdbOriginalLanguageBackfillQueueMessage
	| TmdbOriginalLanguageResidualQueueMessage
	| TmdbProviderRefreshDiscoveryQueueMessage
	| TmdbProviderRefreshQueueMessage;
