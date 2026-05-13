CREATE TABLE IF NOT EXISTS tmdb_genre_lookup (
	language TEXT NOT NULL,
	genre_id INTEGER NOT NULL,
	genre_name TEXT NOT NULL,
	last_refreshed_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (language, genre_id)
);

CREATE TABLE IF NOT EXISTS tmdb_watch_provider_lookup (
	region TEXT NOT NULL,
	provider_id INTEGER NOT NULL,
	provider_name TEXT NOT NULL,
	logo_path TEXT,
	display_priority INTEGER,
	last_refreshed_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (region, provider_id)
);
