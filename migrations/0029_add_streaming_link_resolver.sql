-- These are title destinations, not streaming availability. Only TMDB decides
-- which provider rows MovieApp displays for the selected country.
CREATE TABLE movie_streaming_links (
	tmdb_id INTEGER NOT NULL,
	tmdb_provider_id INTEGER NOT NULL,
	provider TEXT NOT NULL,
	region TEXT NOT NULL,
	provider_content_id TEXT NOT NULL,
	web_url TEXT NOT NULL,
	native_url TEXT,
	source TEXT NOT NULL CHECK (source IN ('wikidata', 'streaming-availability')),
	resolved_at TEXT NOT NULL,
	PRIMARY KEY (tmdb_id, provider, region)
);

-- A single backup request returns many countries and services. Keep its useful
-- links here, including the purchase/add-on type, without enabling untested
-- provider adapters or confusing an Amazon channel with a direct subscription.
CREATE TABLE streaming_link_candidates (
	tmdb_id INTEGER NOT NULL,
	provider TEXT NOT NULL,
	region TEXT NOT NULL,
	web_url TEXT NOT NULL,
	provider_content_id TEXT,
	option_type TEXT NOT NULL,
	addon_id TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL DEFAULT 'streaming-availability',
	resolved_at TEXT NOT NULL,
	PRIMARY KEY (tmdb_id, provider, region, web_url, option_type, addon_id)
);

-- This movie-wide lease stops two Worker instances from spending a backup
-- request at the same time. retry_after also remembers unsuccessful lookups.
CREATE TABLE streaming_link_lookups (
	tmdb_id INTEGER PRIMARY KEY,
	owner TEXT NOT NULL,
	status TEXT NOT NULL,
	retry_after INTEGER NOT NULL
);

-- Reserve a request before calling the paid-capable service. The conditional
-- SQL update is atomic across Worker instances; in-memory counters are not.
CREATE TABLE streaming_api_budget (
	period TEXT PRIMARY KEY,
	requests INTEGER NOT NULL DEFAULT 0,
	blocked_until INTEGER NOT NULL DEFAULT 0
);
