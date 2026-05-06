export interface Env extends Cloudflare.Env {
	DB: D1Database;
	IMDB_RATING_QUEUE: Queue<ImdbRatingQueueMessage>;
	TMDB_ENRICHMENT_QUEUE: Queue<TmdbEnrichmentQueueMessage>;
	TMDB_API_KEY: string;
	ALL_JOBS_PAUSED?: string;
	IMDB_JOB_PAUSED?: string;
	TMDB_PRIMARY_JOB_PAUSED?: string;
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
	rows: ImdbRatingRow[];
};

export type TmdbEnrichmentQueueMessage = {
	kind: "tmdb-enrichment";
	jobRunId: string;
	tmdbIds: number[];
};

export type WorkerQueueMessage =
	| ImdbRatingQueueMessage
	| TmdbEnrichmentQueueMessage;
