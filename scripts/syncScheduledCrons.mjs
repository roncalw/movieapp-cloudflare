import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_DIR = resolve(new URL("..", import.meta.url).pathname);
const WRANGLER_CONFIG_PATH = resolve(ROOT_DIR, "wrangler.jsonc");
const OUTPUT_PATH = resolve(ROOT_DIR, "src/jobs/scheduledCronConfig.ts");

const EXPECTED_CRON_COUNT = 6;

function stripJsonComments(source) {
	let output = "";
	let inString = false;
	let isEscaped = false;

	for (let index = 0; index < source.length; index += 1) {
		const current = source[index];
		const next = source[index + 1];

		if (inString) {
			output += current;

			if (isEscaped) {
				isEscaped = false;
			} else if (current === "\\") {
				isEscaped = true;
			} else if (current === "\"") {
				inString = false;
			}

			continue;
		}

		if (current === "\"") {
			inString = true;
			output += current;
			continue;
		}

		if (current === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") {
				index += 1;
			}
			output += "\n";
			continue;
		}

		if (current === "/" && next === "*") {
			index += 2;
			while (
				index < source.length &&
				!(source[index] === "*" && source[index + 1] === "/")
			) {
				if (source[index] === "\n") {
					output += "\n";
				}
				index += 1;
			}
			index += 1;
			continue;
		}

		output += current;
	}

	return output;
}

function assertCron(value, index) {
	if (typeof value !== "string" || value.trim().split(/\s+/).length !== 5) {
		throw new Error(
			`wrangler.jsonc trigger at position ${index + 1} is not a valid 5-field cron string.`,
		);
	}

	return value.trim();
}

const wranglerSource = readFileSync(WRANGLER_CONFIG_PATH, "utf8");
const wranglerConfig = JSON.parse(stripJsonComments(wranglerSource));
const crons = wranglerConfig.triggers?.crons;

if (!Array.isArray(crons)) {
	throw new Error("wrangler.jsonc must define triggers.crons.");
}

if (crons.length !== EXPECTED_CRON_COUNT) {
	throw new Error(
		`wrangler.jsonc must define exactly ${EXPECTED_CRON_COUNT} cron triggers in job order. Found ${crons.length}.`,
	);
}

const [
	imdbCron,
	tmdbPrimaryCron,
	tmdbNewMovieDetailsCron,
	tmdbEnrichmentCron,
	movieListBuildCron,
	cacheWarmAllGenresCron,
] = crons.map(assertCron);

const output = `// Generated from wrangler.jsonc by Wrangler's build command.
// Edit only wrangler.jsonc. Wrangler runs scripts/syncScheduledCrons.mjs before deploy/dev.

export const SCHEDULED_IMDB_CRON = ${JSON.stringify(imdbCron)};
export const SCHEDULED_TMDB_PRIMARY_CRON = ${JSON.stringify(tmdbPrimaryCron)};
export const SCHEDULED_TMDB_NEW_MOVIE_DETAILS_CRON = ${JSON.stringify(tmdbNewMovieDetailsCron)};
export const SCHEDULED_TMDB_ENRICHMENT_CRON = ${JSON.stringify(tmdbEnrichmentCron)};
export const SCHEDULED_MOVIE_LIST_BUILD_CRON = ${JSON.stringify(movieListBuildCron)};
export const SCHEDULED_CACHE_WARM_ALL_GENRES_CRON = ${JSON.stringify(cacheWarmAllGenresCron)};
`;

writeFileSync(OUTPUT_PATH, output, "utf8");
console.log(`Synced scheduled cron constants from wrangler.jsonc to ${OUTPUT_PATH}`);
