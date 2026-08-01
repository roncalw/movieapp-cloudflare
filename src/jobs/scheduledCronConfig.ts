// Generated from wrangler.jsonc by Wrangler's build command.
// Edit only wrangler.jsonc. Wrangler runs scripts/syncScheduledCrons.mjs before deploy/dev.

export const SCHEDULED_IMDB_CRON = "0 1 * * 1";
export const SCHEDULED_TMDB_PRIMARY_CRON = "0 3 * * 1";
export const SCHEDULED_TMDB_NEW_MOVIE_DETAILS_CRON = "0 5 * * 1";
export const SCHEDULED_TMDB_ENRICHMENT_CRON = "0 7 * * 1";
export const SCHEDULED_TMDB_POPULARITY_CRON = "0 9 * * 1";
export const SCHEDULED_MOVIE_LIST_BUILD_CRON = "0 12 * * 1";
export const SCHEDULED_CACHE_WARM_ALL_GENRES_CRON = "0 13 * * 1";
export const SCHEDULED_WEEKLY_IMPORT_VALIDATION_CRON = "0 15 * * 1";
