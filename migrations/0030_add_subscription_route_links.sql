-- A playback platform is not a subscription identity: AMC+ direct, AMC+ on
-- Prime Video, and STARZ on Prime Video must never overwrite one another.
-- Keep the old table intact for deployed clients and safe Worker rollback.
-- The resolver copies a validated legacy direct destination on its next use.
CREATE TABLE movie_streaming_route_links (
  tmdb_id INTEGER NOT NULL,
  tmdb_provider_id INTEGER NOT NULL,
  provider_key TEXT NOT NULL,
  display_service_name TEXT NOT NULL,
  subscription_category TEXT NOT NULL,
  playback_platform TEXT NOT NULL,
  region TEXT NOT NULL,
  provider_content_id TEXT NOT NULL,
  web_url TEXT NOT NULL,
  native_url TEXT,
  source TEXT NOT NULL CHECK (source IN ('wikidata', 'streaming-availability')),
  resolved_at TEXT NOT NULL,
  PRIMARY KEY (tmdb_id, tmdb_provider_id, region)
);
