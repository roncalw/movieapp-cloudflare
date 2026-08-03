/**
 * Internal movie/provider relationship used only to record that TMDb Discover
 * currently reports at least one US ad-supported stream for a movie.
 *
 * Real TMDb provider IDs used by MovieApp are positive integers. Keeping this
 * marker negative prevents it from colliding with a real provider and, because
 * it is never inserted into tmdb_watch_provider_lookup, prevents it from
 * appearing as a selectable streamer in Advanced Search.
 */
export const STREAMS_WITH_ADS_PROVIDER_ID = -1;

