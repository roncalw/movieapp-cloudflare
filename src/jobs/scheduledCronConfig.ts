// Generated from wrangler.jsonc by scripts/syncScheduledCrons.mjs.
// Edit wrangler.jsonc, then run npm run sync:cron or npm run deploy.

export const SCHEDULED_IMDB_CRON = "0 2 * * 6";
export const SCHEDULED_TMDB_PRIMARY_CRON = "0 3 * * 6";
export const SCHEDULED_TMDB_NEW_MOVIE_DETAILS_CRON = "0 5 * * 6";
export const SCHEDULED_TMDB_ENRICHMENT_CRON = "0 7 * * 6";
export const SCHEDULED_MOVIE_LIST_BUILD_CRON = "0 12 * * 6";
export const SCHEDULED_CACHE_WARM_ALL_GENRES_CRON = "0 13 * * 6";
