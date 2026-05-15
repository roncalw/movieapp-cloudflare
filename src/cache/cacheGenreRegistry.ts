import actionUrls from "./data/cacheGenreActionURL.json";
import adventureUrls from "./data/cacheGenreAdventureURL.json";
import animationUrls from "./data/cacheGenreAnimationURL.json";
import comedyUrls from "./data/cacheGenreComedyURL.json";
import crimeUrls from "./data/cacheGenreCrimeURL.json";
import documentaryUrls from "./data/cacheGenreDocumentaryURL.json";
import dramaUrls from "./data/cacheGenreDramaURL.json";
import familyUrls from "./data/cacheGenreFamilyURL.json";
import fantasyUrls from "./data/cacheGenreFantasyURL.json";
import historyUrls from "./data/cacheGenreHistoryURL.json";
import horrorUrls from "./data/cacheGenreHorrorURL.json";
import musicUrls from "./data/cacheGenreMusicURL.json";
import mysteryUrls from "./data/cacheGenreMysteryURL.json";
import romanceUrls from "./data/cacheGenreRomanceURL.json";
import scifiUrls from "./data/cacheGenreSciFiURL.json";
import thrillerUrls from "./data/cacheGenreThrillerURL.json";
import warUrls from "./data/cacheGenreWarURL.json";
import westernUrls from "./data/cacheGenreWesternURL.json";
import type { CacheWarmGenreConfig, CacheWarmUrlEntry } from "./cacheWarmTypes";

function entries(value: unknown): CacheWarmUrlEntry[] {
	return value as CacheWarmUrlEntry[];
}

export const CACHE_WARM_GENRES: CacheWarmGenreConfig[] = [
	{ key: "action", label: "Action", genreId: 28, entries: entries(actionUrls) },
	{
		key: "adventure",
		label: "Adventure",
		genreId: 12,
		entries: entries(adventureUrls),
	},
	{
		key: "animation",
		label: "Animation",
		genreId: 16,
		entries: entries(animationUrls),
	},
	{ key: "comedy", label: "Comedy", genreId: 35, entries: entries(comedyUrls) },
	{ key: "crime", label: "Crime", genreId: 80, entries: entries(crimeUrls) },
	{
		key: "documentary",
		label: "Documentary",
		genreId: 99,
		entries: entries(documentaryUrls),
	},
	{ key: "drama", label: "Drama", genreId: 18, entries: entries(dramaUrls) },
	{ key: "family", label: "Family", genreId: 10751, entries: entries(familyUrls) },
	{
		key: "fantasy",
		label: "Fantasy",
		genreId: 14,
		entries: entries(fantasyUrls),
	},
	{
		key: "history",
		label: "History",
		genreId: 36,
		entries: entries(historyUrls),
	},
	{ key: "horror", label: "Horror", genreId: 27, entries: entries(horrorUrls) },
	{ key: "music", label: "Music", genreId: 10402, entries: entries(musicUrls) },
	{
		key: "mystery",
		label: "Mystery",
		genreId: 9648,
		entries: entries(mysteryUrls),
	},
	{
		key: "romance",
		label: "Romance",
		genreId: 10749,
		entries: entries(romanceUrls),
	},
	{ key: "scifi", label: "SciFi", genreId: 878, entries: entries(scifiUrls) },
	{
		key: "thriller",
		label: "Thriller",
		genreId: 53,
		entries: entries(thrillerUrls),
	},
	{ key: "war", label: "War", genreId: 10752, entries: entries(warUrls) },
	{
		key: "western",
		label: "Western",
		genreId: 37,
		entries: entries(westernUrls),
	},
];

function normalizeGenreInput(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findCacheWarmGenre(
	options: {
		genreKey?: string;
		genreId?: number;
	},
) {
	if (options.genreId !== undefined) {
		return CACHE_WARM_GENRES.find((genre) => genre.genreId === options.genreId);
	}

	if (options.genreKey !== undefined) {
		const requestedKey = normalizeGenreInput(options.genreKey);

		return CACHE_WARM_GENRES.find(
			(genre) =>
				normalizeGenreInput(genre.key) === requestedKey ||
				normalizeGenreInput(genre.label) === requestedKey,
		);
	}

	return undefined;
}
