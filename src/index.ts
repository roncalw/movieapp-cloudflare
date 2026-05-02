/*
	This Env interface describes the Cloudflare resources
	that are attached to this Worker.

	A "Worker" is Cloudflare's name for a small JavaScript/TypeScript
	program that runs on Cloudflare's servers when someone makes an HTTP
	request to your Worker URL.

	A "binding" is Cloudflare's name for connecting one of its resources
	to your Worker code.

	In your Wrangler setup, you connected your D1 database to this Worker
	and gave that connection the binding name DB.

	That binding name becomes a property on env. So inside this Worker,
	Cloudflare gives us access to the database through:

		env.DB

	The word Env is not a JavaScript reserved word like if, return, or const.
	It is a TypeScript type name.

	It can still look like Env already exists because Wrangler generated this
	in worker-configuration.d.ts:

		interface Env extends Cloudflare.Env {}

	That generated Env is a global type. It is part of the type information
	Wrangler creates for the Worker project.

	In this file, we export our own Env interface for this Worker module.
	This local/exported Env is the one used below in:

		async fetch(request: Request, env: Env): Promise<Response>

	We extend Cloudflare.Env to stay connected to Wrangler's generated Worker
	environment type, then we add the DB property so TypeScript knows this
	Worker expects a D1 database binding named DB.

	The type D1Database is not imported at the top of this file because
	Wrangler generated Cloudflare type definitions for this project.
	Those definitions live in worker-configuration.d.ts, and tsconfig.json
	tells TypeScript to include that file.

	So TypeScript already knows names like:

		D1Database
		Request
		Response
		ResponseInit
		ExportedHandler

	Some of those names also exist at runtime in the Worker environment
	(for example Request and Response). Other names are only TypeScript
	types and disappear after TypeScript compiles the code.
*/
export interface Env extends Cloudflare.Env {
	DB: D1Database;
	IMDB_RATING_QUEUE: Queue<ImdbRatingQueueMessage>;
	TMDB_ENRICHMENT_QUEUE: Queue<TmdbEnrichmentQueueMessage>;
	MOVIE_SEARCH_BUILD_QUEUE: Queue<MovieSearchBuildQueueMessage>;
	TMDB_API_KEY: string;
}

/*
	This type describes one row from your D1 movies table.

	It matches the table columns you created:

		id
		MovieName
		IMDBRating
		IMDBVoteCounts

	The string | null parts mean:

		this field usually holds text, but the database could also
		return null if the column has no value for that row.

	This type is only for a movie row coming back from the database.
	It is not the type for every JSON response this Worker can send.
*/
type MovieRow = {
	id: number;
	MovieName: string;
	IMDBRating: string | null;
	IMDBVoteCounts: string | null;
};

type MovieSearchListItem = {
	tmdb_id: number;
	poster_path: string;
	imdb_rating: number | null;
};

type MovieSearchSort = "popularity" | "imdb";

type MovieSearchCursor = {
	sort: MovieSearchSort;
	tmdbId: number;
	popularity?: number;
	imdbRating?: number;
	imdbVoteCount?: number;
};

class RequestValidationError extends Error {}

/*
	This is the remote IMDb gzip file we want Cloudflare to read during the
	dry-run test.

	Step 4 only proves Cloudflare can fetch, unzip, and parse this file.
	It does not insert anything into D1 yet.
*/
const IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";

/*
	This dry-run sample size matches the later planned queue batch size.

	It is only for the sample we keep in memory and send back in the test
	response. It does not limit how many rows the helper can process overall.
*/
const IMDB_SAMPLE_SIZE = 33;

/*
	This type describes one parsed row from the IMDb ratings file.

	The TSV columns are:

		tconst
		averageRating
		numVotes

	We rename them into the field names we want to use in Worker code:

		imdb_id
		average_rating
		num_votes

	The rating and vote count are nullable because your later plan allows a
	matching IMDb row to exist even if one of those values is blank.
*/
type ImdbRatingRow = {
	imdb_id: string;
	average_rating: number | null;
	num_votes: number | null;
};

type ImdbRatingQueueMessage = {
	rows: ImdbRatingRow[];
};

type TmdbEnrichmentQueueMessage = {
	kind: "tmdb-enrichment";
	jobRunId: string;
	tmdbIds: number[];
};

type MovieSearchBuildQueueMessage = {
	kind: "movie-search-build";
	jobRunId: string;
	sourceRows: number;
};

type WorkerQueueMessage =
	| ImdbRatingQueueMessage
	| TmdbEnrichmentQueueMessage
	| MovieSearchBuildQueueMessage;

type TmdbDiscoverResult = {
	id: number;
	title?: string;
	poster_path?: string | null;
	release_date?: string;
	popularity?: number;
	genre_ids?: unknown;
	adult?: boolean;
};

type TmdbDiscoverPage = {
	page: number;
	total_pages: number;
	results: TmdbDiscoverResult[];
};

type TmdbDateWindow = {
	beginDate: string;
	endDate: string;
};

type TmdbMovieDetails = {
	id: number;
	external_ids?: {
		imdb_id?: string | null;
	};
	release_dates?: {
		results?: TmdbReleaseDateCountry[];
	};
	"watch/providers"?: {
		results?: {
			US?: {
				flatrate?: TmdbWatchProvider[];
			};
		};
	};
};

type TmdbReleaseDateCountry = {
	iso_3166_1?: string;
	release_dates?: TmdbReleaseDateItem[];
};

type TmdbReleaseDateItem = {
	certification?: string;
};

type TmdbWatchProvider = {
	provider_id?: unknown;
};

type TmdbEnrichmentRow = {
	tmdb_id: number;
};

type TmdbEnrichmentOptions = {
	limit: number;
	refreshOlderThanDays: number;
	progressEvery: number;
	tmdbConcurrency: number;
	trigger: "manual" | "cron";
	useLock?: boolean;
};

type ImportJobLockRow = {
	owner: string;
	lock_expires_at: string;
};

type ImportJobRunRow = {
	job_run_id: string;
	job_name: string;
	status: string;
	trigger: string;
	selected_count: number;
	queued_count: number;
	processed_count: number;
	updated_count: number;
	error_count: number;
	provider_rows_inserted: number;
	started_at: string;
	last_progress_at: string;
	ended_at: string | null;
	last_error: string | null;
};

type TmdbEnrichmentStats = {
	processed: number;
	updated: number;
	errors: number;
	imdbIdsFound: number;
	certificationsFound: number;
	providerMoviesFound: number;
	providerRowsInserted: number;
};

type MovieListBuildReadiness = {
	tmdbRows: number;
	imdbRows: number;
	tmdbRowsNeedingEnrichment: number;
	tmdbTerminalErrorRows: number;
	movieListCandidateRows: number;
};

type MovieListBuildChunk = {
	chunkRows: number;
	lastTmdbId: number | null;
};

type MovieSearchBuildReadiness = MovieListBuildReadiness & {
	movieListRows: number;
};

type MovieSearchBuildPass =
	| "no_filter"
	| "genre_only"
	| "provider_only"
	| "genre_provider"
	| "cleanup_stale"
	| "cleanup_invalid"
	| "complete";

type MovieSearchBuildState = {
	job_name: string;
	build_marker: string;
	status: string;
	pass_name: MovieSearchBuildPass;
	last_tmdb_id: number;
	selected_count: number;
	processed_count: number;
	started_at: string;
	updated_at: string;
	completed_at: string | null;
};

type MovieSearchBuildOptions = {
	sourceRows: number;
	reset: boolean;
};

const IMDB_QUEUE_ROWS_PER_MESSAGE = 33;
const IMDB_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_MAX_REQUESTS_PER_SECOND = 35;
const TMDB_MAX_RETRIES = 3;
const TMDB_DISCOVER_MAX_PAGE = 500;
const TMDB_ENRICH_D1_BATCH_MOVIES = 100;
const TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE = 100;
const TMDB_ENRICH_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_ENRICH_TMDB_CONCURRENCY = 25;
const TMDB_ENRICH_JOB_NAME = "tmdb-enrich";
const TMDB_ENRICH_LOCK_MINUTES = 30;
const MOVIE_LIST_BUILD_JOB_NAME = "movie-list-build";
const MOVIE_LIST_BUILD_LOCK_MINUTES = 60;
const MOVIE_LIST_BUILD_REFRESH_OLDER_THAN_DAYS = 7;
const MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS = 10000;
const MOVIE_LIST_BUILD_CLEANUP_CHUNK_ROWS = 10000;
const MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS = 100000;
const MOVIE_SEARCH_CACHE_SECONDS = 60 * 60 * 24 * 7;
const MOVIE_SEARCH_STALE_SECONDS = 60 * 60 * 24;
const MOVIE_SEARCH_BUILD_JOB_NAME = "movie-search-build";
const MOVIE_SEARCH_BUILD_LOCK_MINUTES = 60;
const MOVIE_SEARCH_BUILD_REFRESH_OLDER_THAN_DAYS = 7;
const MOVIE_SEARCH_BUILD_SOURCE_ROWS_PER_RUN = 25000;
const MOVIE_SEARCH_BUILD_CLEANUP_CHUNK_ROWS = 10000;
const TMDB_PRIMARY_CRON_LIMIT = 100000;
const TMDB_ENRICHMENT_CRON_LIMIT = 300000;
const SCHEDULED_IMDB_CRON = "0 22 * * 1";
const SCHEDULED_TMDB_PRIMARY_CRON = "0 4 * * 2";
const SCHEDULED_TMDB_ENRICHMENT_CRON = "0 10 * * 2";
const SCHEDULED_MOVIE_LIST_BUILD_CRON = "0 1 * * 3";
const SCHEDULED_MOVIE_SEARCH_BUILD_CRON = "0 2 * * 3";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const tmdbRequestTimestamps: number[] = [];

/*
	This helper does the Step 4 dry-run read.

	It:

		1. downloads the IMDb gzip file
		2. streams the unzip process instead of loading the whole file at once
		3. reads TSV lines one chunk at a time
		4. returns a small sample instead of writing anything to D1

	The limit parameter says how many data rows to read before stopping.
*/
async function dryRunReadImdbRatings(limit: number) {
	const response = await fetch(IMDB_RATINGS_URL);

	if (!response.ok || !response.body) {
		throw new Error(`IMDb download failed with status ${response.status}.`);
	}

	const decompressedStream = response.body.pipeThrough(
		new DecompressionStream("gzip"),
	);
	const reader = decompressedStream.getReader();
	const decoder = new TextDecoder();

	let buffer = "";
	let headerSkipped = false;
	let rowsRead = 0;
	const firstRows: ImdbRatingRow[] = [];
	const lastRows: ImdbRatingRow[] = [];

	while (rowsRead < limit) {
		const { value, done } = await reader.read();

		if (done) {
			break;
		}

		/*
			Convert the latest binary chunk into text and keep appending it to
			the unfinished text we already had in buffer.
		*/
		buffer += decoder.decode(value, { stream: true });

		const lines = buffer.split("\n");

		/*
			The last item may be a partial line if the chunk ended in the middle
			of a row, so keep that piece in buffer for the next loop.
		*/
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!headerSkipped) {
				headerSkipped = true;
				continue;
			}

			if (!line.trim()) {
				continue;
			}

			const [imdb_id, averageRating, numVotes] = line.split("\t");

			const parsedRow: ImdbRatingRow = {
				imdb_id,
				average_rating: averageRating === "" ? null : Number(averageRating),
				num_votes: numVotes === "" ? null : Number(numVotes),
			};

			/*
				Only keep a bounded sample in memory:

					1. the first IMDB_SAMPLE_SIZE rows we ever see
					2. the most recent IMDB_SAMPLE_SIZE rows we have seen so far

				This lets the Worker process a large limit without also keeping all
				parsed rows in RAM.
			*/
			if (firstRows.length < IMDB_SAMPLE_SIZE) {
				firstRows.push(parsedRow);
			}

			lastRows.push(parsedRow);

			if (lastRows.length > IMDB_SAMPLE_SIZE) {
				lastRows.shift();
			}

			rowsRead += 1;

			if (rowsRead >= limit) {
				break;
			}
		}
	}

	await reader.cancel();

	return {
		rowsRead,
		firstRows,
		lastRows,
	};
}

async function enqueueImdbRatingRows(env: Env, limit?: number) {
	const response = await fetch(IMDB_RATINGS_URL);

	if (!response.ok || !response.body) {
		throw new Error(
			`IMDb download failed with status ${response.status}.`,
		);
	}

	const decompressedStream = response.body.pipeThrough(
		new DecompressionStream("gzip"),
	);
	const reader = decompressedStream.getReader();
	const decoder = new TextDecoder();

	let buffer = "";
	let headerSkipped = false;
	let rowsSeen = 0;
	let rowsQueued = 0;
	let batch: ImdbRatingRow[] = [];
	let queueMessages: ImdbRatingQueueMessage[] = [];

	async function flushQueueMessages() {
		if (queueMessages.length === 0) {
			return;
		}

		await env.IMDB_RATING_QUEUE.sendBatch(
			queueMessages.map((message) => ({ body: message })),
		);

		queueMessages = [];
	}

	async function flushBatch() {
		if (batch.length === 0) {
			return;
		}

		queueMessages.push({ rows: batch });
		rowsQueued += batch.length;
		batch = [];

		if (queueMessages.length >= IMDB_QUEUE_MESSAGES_PER_SEND_BATCH) {
			await flushQueueMessages();
		}
	}

	while (true) {
		const { value, done } = await reader.read();

		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });

		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!headerSkipped) {
				headerSkipped = true;
				continue;
			}

			if (!line.trim()) {
				continue;
			}

			const [imdb_id, averageRating, numVotes] = line.split("\t");

			batch.push({
				imdb_id,
				average_rating: averageRating === "" ? null : Number(averageRating),
				num_votes: numVotes === "" ? null : Number(numVotes),
			});

			rowsSeen += 1;

			if (batch.length >= IMDB_QUEUE_ROWS_PER_MESSAGE) {
				await flushBatch();
			}

			if (limit && rowsSeen >= limit) {
				await flushBatch();
				await flushQueueMessages();
				await reader.cancel();
				return { rowsSeen, rowsQueued };
			}
		}
	}

	await flushBatch();
	await flushQueueMessages();
	await reader.cancel();

	return { rowsSeen, rowsQueued };
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTmdbRequestSlot() {
	while (true) {
		const now = Date.now();
		const oneSecondAgo = now - 1000;

		while (
			tmdbRequestTimestamps.length > 0 &&
			tmdbRequestTimestamps[0] <= oneSecondAgo
		) {
			tmdbRequestTimestamps.shift();
		}

		if (tmdbRequestTimestamps.length < TMDB_MAX_REQUESTS_PER_SECOND) {
			tmdbRequestTimestamps.push(now);
			return;
		}

		const oldestRequest = tmdbRequestTimestamps[0];
		const waitMs = Math.max(1000 - (now - oldestRequest), 50);
		await sleep(waitMs);
	}
}

async function fetchTmdbJson<T>(url: URL, env: Env): Promise<T> {
	for (let attempt = 0; attempt <= TMDB_MAX_RETRIES; attempt += 1) {
		await waitForTmdbRequestSlot();

		if (!env.TMDB_API_KEY) {
			throw new Error("TMDB_API_KEY is missing.");
		}

		url.searchParams.set("api_key", env.TMDB_API_KEY);

		const response = await fetch(url, {
			headers: {
				accept: "application/json",
			},
		});

		if (response.status !== 429 && response.status < 500) {
			if (!response.ok) {
				throw new Error(
					`TMDB request failed: ${response.status} ${response.statusText}`,
				);
			}

			return response.json();
		}

		if (attempt === TMDB_MAX_RETRIES) {
			throw new Error(
				`TMDB request failed after retries: ${response.status} ${response.statusText}`,
			);
		}

		const retryAfterSeconds = Number(response.headers.get("Retry-After"));
		const retryAfterMs = Number.isFinite(retryAfterSeconds)
			? retryAfterSeconds * 1000
			: 1000 * (attempt + 1);

		await sleep(retryAfterMs);
	}

	throw new Error("TMDB request failed unexpectedly.");
}

async function getTmdbDiscoverPage(
	page: number,
	beginDate: string,
	env: Env,
	endDate?: string,
) {
	const url = new URL("https://api.themoviedb.org/3/discover/movie");
	url.searchParams.set("page", String(page));
	url.searchParams.set("sort_by", "popularity.desc");
	url.searchParams.set("primary_release_date.gte", beginDate);
	url.searchParams.set("watch_region", "US");
	url.searchParams.set("include_adult", "false");
	url.searchParams.set("include_video", "false");

	if (endDate) {
		url.searchParams.set("primary_release_date.lte", endDate);
	}

	return fetchTmdbJson<TmdbDiscoverPage>(url, env);
}

async function getTmdbRefreshStartDate(
	env: Env,
	fallbackBeginDate = "2000-01-01",
) {
	const result = await env.DB.prepare(
		`SELECT MAX(release_date) AS max_release_date
		 FROM tmdb_movies_staging`,
	).first<{ max_release_date: string | null }>();

	return result?.max_release_date ?? fallbackBeginDate;
}

function isoDateToTime(value: string) {
	const [year, month, day] = value.split("-").map(Number);
	return Date.UTC(year, month - 1, day);
}

function timeToIsoDate(value: number) {
	return new Date(value).toISOString().slice(0, 10);
}

function isIsoDate(value: string) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && timeToIsoDate(isoDateToTime(value)) === value;
}

function splitDateWindow(window: TmdbDateWindow) {
	const beginTime = isoDateToTime(window.beginDate);
	const endTime = isoDateToTime(window.endDate);

	if (beginTime >= endTime) {
		return null;
	}

	const daysBetween = Math.floor((endTime - beginTime) / ONE_DAY_MS);
	const leftEndTime = beginTime + Math.floor(daysBetween / 2) * ONE_DAY_MS;
	const rightBeginTime = leftEndTime + ONE_DAY_MS;

	return {
		left: {
			beginDate: window.beginDate,
			endDate: timeToIsoDate(leftEndTime),
		},
		right: {
			beginDate: timeToIsoDate(rightBeginTime),
			endDate: window.endDate,
		},
	};
}

function buildTmdbPrimaryStatements(
	discoverResult: TmdbDiscoverResult,
	env: Env,
) {
	const tmdbId = discoverResult.id;
	const genreIds = Array.isArray(discoverResult.genre_ids)
		? [...new Set(discoverResult.genre_ids.filter((genreId) => typeof genreId === "number"))]
		: [];
	const statements = [
		env.DB.prepare(
			`INSERT OR REPLACE INTO tmdb_movies_staging (
				tmdb_id,
				imdb_id,
				title,
				poster_path,
				release_date,
				us_certification,
				popularity,
				imported_at
			)
			VALUES (?, NULL, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)`,
		).bind(
			tmdbId,
			discoverResult.title ?? "",
			discoverResult.poster_path ?? null,
			discoverResult.release_date ?? null,
			discoverResult.popularity ?? 0,
		),
		env.DB.prepare("DELETE FROM movie_genres WHERE tmdb_id = ?").bind(tmdbId),
	];

	for (const genreId of genreIds) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO movie_genres (tmdb_id, genre_id)
				 VALUES (?, ?)`,
			).bind(tmdbId, genreId),
		);
	}

	return statements;
}

async function loadTmdbPrimaryRowsManual(
	env: Env,
	beginDate: string,
	endDate: string,
	limit: number,
) {
	let pagesRead = 0;
	let rowsSeen = 0;
	let rowsInserted = 0;
	let totalPagesSeen: number | null = null;
	let windowsLoaded = 0;
	let windowsSplit = 0;
	let stopReason:
		| "limit_reached"
		| "end_of_windows"
		| "single_day_page_cap_reached" = "end_of_windows";
	let stoppedWindow: TmdbDateWindow | null = null;
	const pendingWindows: TmdbDateWindow[] = [{ beginDate, endDate }];

	while (pendingWindows.length > 0 && rowsInserted < limit) {
		const currentWindow = pendingWindows.shift();

		if (!currentWindow) {
			break;
		}

		const firstPage = await getTmdbDiscoverPage(
			1,
			currentWindow.beginDate,
			env,
			currentWindow.endDate,
		);

		pagesRead += 1;
		totalPagesSeen = Math.max(totalPagesSeen ?? 0, firstPage.total_pages);

		if (firstPage.total_pages > TMDB_DISCOVER_MAX_PAGE) {
			const splitWindow = splitDateWindow(currentWindow);

			if (!splitWindow) {
				stopReason = "single_day_page_cap_reached";
				stoppedWindow = currentWindow;
				console.log(
					JSON.stringify({
						event: "tmdb-window-single-day-cap",
						beginDate: currentWindow.beginDate,
						endDate: currentWindow.endDate,
						totalPagesSeen: firstPage.total_pages,
						tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
					}),
				);
				break;
			}

			windowsSplit += 1;
			console.log(
				JSON.stringify({
					event: "tmdb-window-split",
					beginDate: currentWindow.beginDate,
					endDate: currentWindow.endDate,
					totalPagesSeen: firstPage.total_pages,
					tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
					leftWindow: splitWindow.left,
					rightWindow: splitWindow.right,
				}),
			);

			pendingWindows.unshift(splitWindow.right);
			pendingWindows.unshift(splitWindow.left);
			continue;
		}

		windowsLoaded += 1;

		for (let page = 1; page <= firstPage.total_pages; page += 1) {
			const discoverPage =
				page === 1
					? firstPage
					: await getTmdbDiscoverPage(
							page,
							currentWindow.beginDate,
							env,
							currentWindow.endDate,
						);

			if (page !== 1) {
				pagesRead += 1;
			}

			const pageStatements: D1PreparedStatement[] = [];

			for (const discoverResult of discoverPage.results) {
				rowsSeen += 1;

				if (discoverResult.adult) {
					continue;
				}

				pageStatements.push(...buildTmdbPrimaryStatements(discoverResult, env));
				rowsInserted += 1;

				if (rowsInserted >= limit) {
					break;
				}
			}

			if (pageStatements.length > 0) {
				await env.DB.batch(pageStatements);
			}

			if (rowsInserted >= limit) {
				stopReason = "limit_reached";
				break;
			}
		}
	}

	return {
		beginDate,
		endDate: endDate ?? null,
		pagesRead,
		rowsSeen,
		rowsInserted,
		totalPagesSeen,
		tmdbDiscoverMaxPage: TMDB_DISCOVER_MAX_PAGE,
		windowsLoaded,
		windowsSplit,
		pendingWindows: pendingWindows.length,
		stoppedWindow,
		stopReason,
	};
}

async function getTmdbMovieDetails(tmdbId: number, env: Env) {
	const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
	url.searchParams.set(
		"append_to_response",
		"external_ids,release_dates,watch/providers",
	);

	return fetchTmdbJson<TmdbMovieDetails>(url, env);
}

function getUsCertification(details: TmdbMovieDetails) {
	const usReleaseBlock = details.release_dates?.results?.find(
		(entry) => entry.iso_3166_1 === "US",
	);

	return (
		usReleaseBlock?.release_dates?.find(
			(entry) =>
				typeof entry.certification === "string" &&
				entry.certification.length > 0,
		)?.certification ?? null
	);
}

function getUsFlatrateProviderIds(details: TmdbMovieDetails) {
	const providers = details["watch/providers"]?.results?.US?.flatrate ?? [];

	return [
		...new Set(
			providers
				.map((provider) => provider.provider_id)
				.filter((providerId) => typeof providerId === "number"),
		),
	];
}

function buildTmdbEnrichmentStatements(
	tmdbId: number,
	details: TmdbMovieDetails,
	env: Env,
) {
	const imdbId = details.external_ids?.imdb_id ?? null;
	const usCertification = getUsCertification(details);
	const providerIds = getUsFlatrateProviderIds(details);
	const statements = [
		env.DB.prepare(
			`UPDATE tmdb_movies_staging
			 SET imdb_id = ?,
			     us_certification = ?,
			     tmdb_enriched_at = CURRENT_TIMESTAMP,
			     tmdb_enrichment_error = NULL
			 WHERE tmdb_id = ?`,
		).bind(imdbId, usCertification, tmdbId),
		env.DB.prepare(
			`DELETE FROM movie_watch_providers
			 WHERE tmdb_id = ?
			   AND region = ?`,
		).bind(tmdbId, "US"),
	];

	for (const providerId of providerIds) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO movie_watch_providers (tmdb_id, provider_id, region)
				 VALUES (?, ?, ?)`,
			).bind(tmdbId, providerId, "US"),
		);
	}

	return {
		statements,
		imdbIdFound: imdbId ? 1 : 0,
		certificationFound: usCertification ? 1 : 0,
		providerMovieFound: providerIds.length > 0 ? 1 : 0,
		providerRowsInserted: providerIds.length,
	};
}

function isTerminalTmdbEnrichmentError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("404 Not Found");
}

function buildTmdbTerminalErrorStatements(
	tmdbId: number,
	error: unknown,
	env: Env,
) {
	const message = error instanceof Error ? error.message : String(error);
	return [
		env.DB.prepare(
			`UPDATE tmdb_movies_staging
			 SET imdb_id = NULL,
			     us_certification = NULL,
			     tmdb_enriched_at = CURRENT_TIMESTAMP,
			     tmdb_enrichment_error = ?
			 WHERE tmdb_id = ?`,
		).bind(message, tmdbId),
		env.DB.prepare(
			`DELETE FROM movie_watch_providers
			 WHERE tmdb_id = ?
			   AND region = ?`,
		).bind(tmdbId, "US"),
	];
}

async function getTmdbEnrichmentRows(
	env: Env,
	limit: number,
	refreshOlderThanDays: number,
) {
	const { results } = await env.DB.prepare(
		`SELECT tmdb_id
		 FROM tmdb_movies_staging
		 WHERE (tmdb_enriched_at IS NULL
		    OR tmdb_enriched_at < datetime('now', '-' || ? || ' days'))
		   AND tmdb_enrichment_error IS NULL
		 ORDER BY
		   tmdb_enriched_at IS NOT NULL,
		   tmdb_enriched_at,
		   tmdb_id
		 LIMIT ?`,
	)
		.bind(refreshOlderThanDays, limit)
		.all<TmdbEnrichmentRow>();

	return results;
}

function createJobOwner(trigger: "manual" | "cron") {
	return `${trigger}-${Date.now()}-${crypto.randomUUID()}`;
}

async function acquireImportJobLock(
	env: Env,
	jobName: string,
	owner: string,
	lockMinutes: number,
) {
	await env.DB.prepare(
		`DELETE FROM import_job_locks
		 WHERE job_name = ?
		   AND lock_expires_at < CURRENT_TIMESTAMP`,
	).bind(jobName).run();

	const insertResult = await env.DB.prepare(
		`INSERT OR IGNORE INTO import_job_locks (
			 job_name,
			 locked_at,
			 lock_expires_at,
			 owner
		 )
		 VALUES (?, CURRENT_TIMESTAMP, datetime('now', '+' || ? || ' minutes'), ?)`,
	).bind(jobName, lockMinutes, owner).run();

	if (insertResult.meta.changes > 0) {
		console.log(
			JSON.stringify({
				event: "import-job-lock-acquired",
				jobName,
				owner,
				lockMinutes,
			}),
		);
		return true;
	}

	const existingLock = await env.DB.prepare(
		`SELECT owner, lock_expires_at
		 FROM import_job_locks
		 WHERE job_name = ?`,
	).bind(jobName).first<ImportJobLockRow>();

	console.log(
		JSON.stringify({
			event: "import-job-lock-skipped",
			jobName,
			owner,
			existingOwner: existingLock?.owner ?? null,
			existingLockExpiresAt: existingLock?.lock_expires_at ?? null,
		}),
	);

	return false;
}

async function releaseImportJobLock(
	env: Env,
	jobName: string,
	owner: string,
) {
	await env.DB.prepare(
		`DELETE FROM import_job_locks
		 WHERE job_name = ?
		   AND owner = ?`,
	).bind(jobName, owner).run();

	console.log(
		JSON.stringify({
			event: "import-job-lock-released",
			jobName,
			owner,
		}),
	);
}

function isTmdbEnrichmentQueueMessage(
	body: WorkerQueueMessage,
): body is TmdbEnrichmentQueueMessage {
	return "kind" in body && body.kind === "tmdb-enrichment";
}

function isMovieSearchBuildQueueMessage(
	body: WorkerQueueMessage,
): body is MovieSearchBuildQueueMessage {
	return "kind" in body && body.kind === "movie-search-build";
}

function createJobRunId(trigger: "manual" | "cron") {
	return `${TMDB_ENRICH_JOB_NAME}-${trigger}-${Date.now()}-${crypto.randomUUID()}`;
}

async function createImportJobRun(
	env: Env,
	jobRunId: string,
	trigger: "manual" | "cron",
	selectedCount: number,
	queuedCount: number,
) {
	const status = selectedCount === 0 ? "complete" : "queued";

	await env.DB.prepare(
		`INSERT INTO import_job_runs (
			 job_run_id,
			 job_name,
			 status,
			 trigger,
			 selected_count,
			 queued_count,
			 started_at,
			 last_progress_at,
			 ended_at
		 )
		 VALUES (
			 ?,
			 ?,
			 ?,
			 ?,
			 ?,
			 ?,
			 CURRENT_TIMESTAMP,
			 CURRENT_TIMESTAMP,
			 CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE NULL END
		 )`,
	)
		.bind(
			jobRunId,
			TMDB_ENRICH_JOB_NAME,
			status,
			trigger,
			selectedCount,
			queuedCount,
			selectedCount,
		)
		.run();
}

async function updateImportJobRunProgress(
	env: Env,
	jobRunId: string,
	stats: TmdbEnrichmentStats,
	lastError: string | null,
) {
	await env.DB.prepare(
		`UPDATE import_job_runs
		 SET status =
		       CASE
		         WHEN processed_count + ? >= selected_count THEN
		           CASE
		             WHEN error_count + ? > 0 THEN 'complete_with_errors'
		             ELSE 'complete'
		           END
		         ELSE 'running'
		       END,
		     processed_count = processed_count + ?,
		     updated_count = updated_count + ?,
		     error_count = error_count + ?,
		     provider_rows_inserted = provider_rows_inserted + ?,
		     last_progress_at = CURRENT_TIMESTAMP,
		     ended_at =
		       CASE
		         WHEN processed_count + ? >= selected_count THEN CURRENT_TIMESTAMP
		         ELSE ended_at
		       END,
		     last_error = COALESCE(?, last_error)
		 WHERE job_run_id = ?`,
	)
		.bind(
			stats.processed,
			stats.errors,
			stats.processed,
			stats.updated,
			stats.errors,
			stats.providerRowsInserted,
			stats.processed,
			lastError,
			jobRunId,
		)
		.run();
}

async function getRecentImportJobRuns(env: Env) {
	const { results } = await env.DB.prepare(
		`SELECT job_run_id,
		        job_name,
		        status,
		        trigger,
		        selected_count,
		        queued_count,
		        processed_count,
		        updated_count,
		        error_count,
		        provider_rows_inserted,
		        started_at,
		        last_progress_at,
		        ended_at,
		        last_error
		 FROM import_job_runs
		 WHERE job_name = ?
		 ORDER BY started_at DESC
		 LIMIT 10`,
	)
		.bind(TMDB_ENRICH_JOB_NAME)
		.all<ImportJobRunRow>();

	return results;
}

async function getActiveImportJobRun(env: Env) {
	return env.DB.prepare(
		`SELECT job_run_id,
		        job_name,
		        status,
		        trigger,
		        selected_count,
		        queued_count,
		        processed_count,
		        updated_count,
		        error_count,
		        provider_rows_inserted,
		        started_at,
		        last_progress_at,
		        ended_at,
		        last_error
		 FROM import_job_runs
		 WHERE job_name = ?
		   AND status IN ('queued', 'running')
		 ORDER BY started_at DESC
		 LIMIT 1`,
	)
		.bind(TMDB_ENRICH_JOB_NAME)
		.first<ImportJobRunRow>();
}

async function processTmdbEnrichmentRows(
	env: Env,
	jobRunId: string,
	rows: TmdbEnrichmentRow[],
	trigger: "queue",
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	let processed = 0;
	let updated = 0;
	let errors = 0;
	let imdbIdsFound = 0;
	let certificationsFound = 0;
	let providerMoviesFound = 0;
	let providerRowsInserted = 0;
	let lastError: string | null = null;
	let pendingStatements: D1PreparedStatement[] = [];
	let pendingStatementMovies = 0;

	console.log(
		JSON.stringify({
			event: "tmdb-enrich-queue-message-start",
			trigger,
			jobRunId,
			selected: rows.length,
			tmdbConcurrency: TMDB_ENRICH_TMDB_CONCURRENCY,
			startedAt,
		}),
	);

	async function flushStatements() {
		if (pendingStatements.length === 0) {
			return;
		}

		await env.DB.batch(pendingStatements);
		pendingStatements = [];
		pendingStatementMovies = 0;
	}

	for (
		let index = 0;
		index < rows.length;
		index += TMDB_ENRICH_TMDB_CONCURRENCY
	) {
		const rowChunk = rows.slice(index, index + TMDB_ENRICH_TMDB_CONCURRENCY);
		const enrichmentResults = await Promise.all(
			rowChunk.map(async (row) => {
				try {
					const details = await getTmdbMovieDetails(row.tmdb_id, env);
					return {
						row,
						enrichment: buildTmdbEnrichmentStatements(
							row.tmdb_id,
							details,
							env,
						),
						error: null,
					};
				} catch (error) {
					return {
						row,
						enrichment: null,
						error,
					};
				}
			}),
		);

		for (const result of enrichmentResults) {
			if (result.enrichment) {
				pendingStatements.push(...result.enrichment.statements);
				pendingStatementMovies += 1;
				updated += 1;
				imdbIdsFound += result.enrichment.imdbIdFound;
				certificationsFound += result.enrichment.certificationFound;
				providerMoviesFound += result.enrichment.providerMovieFound;
				providerRowsInserted += result.enrichment.providerRowsInserted;

				if (pendingStatementMovies >= TMDB_ENRICH_D1_BATCH_MOVIES) {
					await flushStatements();
				}
			} else {
				errors += 1;
				lastError =
					result.error instanceof Error
						? result.error.message
						: String(result.error);

				if (isTerminalTmdbEnrichmentError(result.error)) {
					pendingStatements.push(
						...buildTmdbTerminalErrorStatements(
							result.row.tmdb_id,
							result.error,
							env,
						),
					);
					pendingStatementMovies += 1;

					if (pendingStatementMovies >= TMDB_ENRICH_D1_BATCH_MOVIES) {
						await flushStatements();
					}
				}

				console.log(
					JSON.stringify({
						event: "tmdb-enrich-row-error",
						trigger,
						jobRunId,
						tmdbId: result.row.tmdb_id,
						error: lastError,
					}),
				);
			}

			processed += 1;
		}
	}

	await flushStatements();

	const stats = {
		processed,
		updated,
		errors,
		imdbIdsFound,
		certificationsFound,
		providerMoviesFound,
		providerRowsInserted,
	};

	await updateImportJobRunProgress(env, jobRunId, stats, lastError);

	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	console.log(
		JSON.stringify({
			event: "tmdb-enrich-queue-message-end",
			trigger,
			jobRunId,
			selected: rows.length,
			...stats,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		}),
	);

	return stats;
}

async function enqueueTmdbEnrichmentJob(
	env: Env,
	options: TmdbEnrichmentOptions,
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const lockOwner = createJobOwner(options.trigger);
	const jobRunId = createJobRunId(options.trigger);
	let lockAcquired = false;

	if (options.useLock) {
		lockAcquired = await acquireImportJobLock(
			env,
			TMDB_ENRICH_JOB_NAME,
			lockOwner,
			TMDB_ENRICH_LOCK_MINUTES,
		);

		if (!lockAcquired) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "job_already_running",
				limit: options.limit,
				refreshOlderThanDays: options.refreshOlderThanDays,
				selected: 0,
				rowsQueued: 0,
				messagesQueued: 0,
				jobRunId: null,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};
		}
	}

	try {
		const activeRun = await getActiveImportJobRun(env);

		if (activeRun) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			return {
				trigger: options.trigger,
				skipped: true,
				skipReason: "job_already_queued_or_running",
				activeJobRunId: activeRun.job_run_id,
				activeStatus: activeRun.status,
				activeSelected: activeRun.selected_count,
				activeProcessed: activeRun.processed_count,
				limit: options.limit,
				refreshOlderThanDays: options.refreshOlderThanDays,
				selected: 0,
				rowsQueued: 0,
				messagesQueued: 0,
				jobRunId: null,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};
		}

		const rows = await getTmdbEnrichmentRows(
			env,
			options.limit,
			options.refreshOlderThanDays,
		);
		let queueMessages: TmdbEnrichmentQueueMessage[] = [];
		let rowsQueued = 0;
		let messagesQueued = 0;

		await createImportJobRun(
			env,
			jobRunId,
			options.trigger,
			rows.length,
			rows.length,
		);

		console.log(
			JSON.stringify({
				event: "tmdb-enrich-enqueue-start",
				trigger: options.trigger,
				jobRunId,
				limit: options.limit,
				refreshOlderThanDays: options.refreshOlderThanDays,
				selected: rows.length,
				idsPerMessage: TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE,
				startedAt,
			}),
		);

		async function flushQueueMessages() {
			if (queueMessages.length === 0) {
				return;
			}

			await env.TMDB_ENRICHMENT_QUEUE.sendBatch(
				queueMessages.map((message) => ({ body: message })),
			);

			messagesQueued += queueMessages.length;
			queueMessages = [];
		}

		for (
			let index = 0;
			index < rows.length;
			index += TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE
		) {
			const tmdbIds = rows
				.slice(index, index + TMDB_ENRICH_IDS_PER_QUEUE_MESSAGE)
				.map((row) => row.tmdb_id);

			queueMessages.push({
				kind: "tmdb-enrichment",
				jobRunId,
				tmdbIds,
			});
			rowsQueued += tmdbIds.length;

			if (
				queueMessages.length >=
				TMDB_ENRICH_QUEUE_MESSAGES_PER_SEND_BATCH
			) {
				await flushQueueMessages();
			}
		}

		await flushQueueMessages();

		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			trigger: options.trigger,
			limit: options.limit,
			refreshOlderThanDays: options.refreshOlderThanDays,
			selected: rows.length,
			rowsQueued,
			messagesQueued,
			jobRunId,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		console.log(
			JSON.stringify({
				event: "tmdb-enrich-enqueue-end",
				...result,
			}),
		);

		return result;
	} finally {
		if (options.useLock && lockAcquired) {
			await releaseImportJobLock(env, TMDB_ENRICH_JOB_NAME, lockOwner);
		}
	}
}

async function runScheduledImdbRatingsRefresh(env: Env) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();

	console.log(
		JSON.stringify({
			event: "imdb-ratings-cron-start",
			startedAt,
		}),
	);

	const result = await enqueueImdbRatingRows(env);
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	console.log(
		JSON.stringify({
			event: "imdb-ratings-cron-end",
			...result,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		}),
	);

	return {
		...result,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
	};
}

async function runScheduledTmdbPrimaryRefresh(env: Env) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const beginDate = await getTmdbRefreshStartDate(env);
	const endDate = timeToIsoDate(Date.now());

	if (beginDate > endDate) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			skipped: true,
			skipReason: "begin_date_after_end_date",
			beginDate,
			endDate,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		console.log(
			JSON.stringify({
				event: "tmdb-primary-cron-skipped",
				...result,
			}),
		);

		return result;
	}

	console.log(
		JSON.stringify({
			event: "tmdb-primary-cron-start",
			startedAt,
			beginDate,
			endDate,
			limit: TMDB_PRIMARY_CRON_LIMIT,
		}),
	);

	const result = await loadTmdbPrimaryRowsManual(
		env,
		beginDate,
		endDate,
		TMDB_PRIMARY_CRON_LIMIT,
	);
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();

	console.log(
		JSON.stringify({
			event: "tmdb-primary-cron-end",
			...result,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		}),
	);

	return {
		...result,
		startedAt,
		endedAt,
		durationMs: endedAtMs - startedAtMs,
	};
}

async function getMovieListBuildReadiness(
	env: Env,
	refreshOlderThanDays: number,
): Promise<MovieListBuildReadiness> {
	const row = await env.DB.prepare(
		`SELECT
		    (SELECT COUNT(*) FROM tmdb_movies_staging) AS tmdbRows,
		    (SELECT COUNT(*) FROM imdb_ratings_staging) AS imdbRows,
		    (
		      SELECT COUNT(*)
		      FROM tmdb_movies_staging
		      WHERE (tmdb_enriched_at IS NULL
		         OR tmdb_enriched_at < datetime('now', '-' || ? || ' days'))
		        AND tmdb_enrichment_error IS NULL
		    ) AS tmdbRowsNeedingEnrichment,
		    (
		      SELECT COUNT(*)
		      FROM tmdb_movies_staging
		      WHERE tmdb_enrichment_error IS NOT NULL
		    ) AS tmdbTerminalErrorRows,
		    (
		      SELECT COUNT(*)
		      FROM tmdb_movies_staging AS tmdb
		      LEFT JOIN imdb_ratings_staging AS imdb
		        ON imdb.imdb_id = tmdb.imdb_id
		      WHERE tmdb.tmdb_enriched_at IS NOT NULL
		        AND tmdb.tmdb_enrichment_error IS NULL
		        AND tmdb.poster_path IS NOT NULL
		        AND tmdb.poster_path <> ''
		    ) AS movieListCandidateRows`,
	)
		.bind(refreshOlderThanDays)
		.first<MovieListBuildReadiness>();

	return {
		tmdbRows: row?.tmdbRows ?? 0,
		imdbRows: row?.imdbRows ?? 0,
		tmdbRowsNeedingEnrichment: row?.tmdbRowsNeedingEnrichment ?? 0,
		tmdbTerminalErrorRows: row?.tmdbTerminalErrorRows ?? 0,
		movieListCandidateRows: row?.movieListCandidateRows ?? 0,
	};
}

function getMovieListBuildReadinessBlockers(
	readiness: MovieListBuildReadiness,
) {
	const blockers: string[] = [];

	if (readiness.tmdbRows === 0) {
		blockers.push("tmdb_staging_empty");
	}

	if (readiness.imdbRows === 0) {
		blockers.push("imdb_staging_empty");
	}

	if (readiness.tmdbRowsNeedingEnrichment > 0) {
		blockers.push("tmdb_enrichment_not_current");
	}

	if (readiness.movieListCandidateRows === 0) {
		blockers.push("no_movie_list_candidates");
	}

	return blockers;
}

async function getNextMovieListBuildChunk(
	env: Env,
	lastTmdbId: number,
	chunkRows: number,
) {
	const row = await env.DB.prepare(
		`SELECT
		    COUNT(*) AS chunkRows,
		    MAX(tmdb_id) AS lastTmdbId
		 FROM (
		    SELECT tmdb.tmdb_id
		    FROM tmdb_movies_staging AS tmdb
		    WHERE tmdb.tmdb_enriched_at IS NOT NULL
		      AND tmdb.tmdb_enrichment_error IS NULL
		      AND tmdb.poster_path IS NOT NULL
		      AND tmdb.poster_path <> ''
		      AND tmdb.tmdb_id > ?
		    ORDER BY tmdb.tmdb_id
		    LIMIT ?
		 )`,
	)
		.bind(lastTmdbId, chunkRows)
		.first<MovieListBuildChunk>();

	return {
		chunkRows: row?.chunkRows ?? 0,
		lastTmdbId: row?.lastTmdbId ?? null,
	};
}

async function upsertMovieListItemsChunk(
	env: Env,
	firstTmdbIdExclusive: number,
	lastTmdbIdInclusive: number,
) {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO movie_list_items (
			tmdb_id,
			title,
			poster_path,
			release_date,
			us_certification,
			imdb_rating,
			imdb_vote_count,
			popularity,
			last_refreshed_at
		)
		SELECT
			tmdb.tmdb_id,
			tmdb.title,
			tmdb.poster_path,
			tmdb.release_date,
			tmdb.us_certification,
			imdb.average_rating AS imdb_rating,
			imdb.num_votes AS imdb_vote_count,
			COALESCE(tmdb.popularity, 0) AS popularity,
			CURRENT_TIMESTAMP AS last_refreshed_at
		FROM tmdb_movies_staging AS tmdb
		LEFT JOIN imdb_ratings_staging AS imdb
			ON imdb.imdb_id = tmdb.imdb_id
		WHERE tmdb.tmdb_enriched_at IS NOT NULL
			AND tmdb.tmdb_enrichment_error IS NULL
			AND tmdb.poster_path IS NOT NULL
			AND tmdb.poster_path <> ''
			AND tmdb.tmdb_id > ?
			AND tmdb.tmdb_id <= ?`,
	)
		.bind(firstTmdbIdExclusive, lastTmdbIdInclusive)
		.run();
}

async function cleanupInvalidMovieListItemsChunk(env: Env, chunkRows: number) {
	const result = await env.DB.prepare(
		`DELETE FROM movie_list_items
		 WHERE tmdb_id IN (
		    SELECT movie.tmdb_id
		    FROM movie_list_items AS movie
		    LEFT JOIN tmdb_movies_staging AS tmdb
		      ON tmdb.tmdb_id = movie.tmdb_id
		     AND tmdb.tmdb_enriched_at IS NOT NULL
		     AND tmdb.tmdb_enrichment_error IS NULL
		     AND tmdb.poster_path IS NOT NULL
		     AND tmdb.poster_path <> ''
		    WHERE tmdb.tmdb_id IS NULL
		    LIMIT ?
		 )`,
	)
		.bind(chunkRows)
		.run();

	return result.meta.changes ?? 0;
}

async function rebuildMovieListItems(env: Env, trigger: "manual" | "cron") {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const lockOwner = createJobOwner(trigger);
	const lockAcquired = await acquireImportJobLock(
		env,
		MOVIE_LIST_BUILD_JOB_NAME,
		lockOwner,
		MOVIE_LIST_BUILD_LOCK_MINUTES,
	);

	if (!lockAcquired) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		return {
			trigger,
			skipped: true,
			skipReason: "job_already_running",
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};
	}

	try {
		console.log(
			JSON.stringify({
				event: "movie-list-build-start",
				trigger,
				startedAt,
			}),
		);

		const activeTmdbEnrichmentRun = await getActiveImportJobRun(env);

		if (activeTmdbEnrichmentRun) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				trigger,
				skipped: true,
				skipReason: "tmdb_enrichment_job_active",
				activeJobRunId: activeTmdbEnrichmentRun.job_run_id,
				activeStatus: activeTmdbEnrichmentRun.status,
				activeSelected: activeTmdbEnrichmentRun.selected_count,
				activeProcessed: activeTmdbEnrichmentRun.processed_count,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			console.log(
				JSON.stringify({
					event: "movie-list-build-skipped",
					...result,
				}),
			);

			return result;
		}

		const readiness = await getMovieListBuildReadiness(
			env,
			MOVIE_LIST_BUILD_REFRESH_OLDER_THAN_DAYS,
		);
		const readinessBlockers = getMovieListBuildReadinessBlockers(readiness);

		if (readinessBlockers.length > 0) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				trigger,
				skipped: true,
				skipReason: "staging_not_ready",
				readinessBlockers,
				refreshOlderThanDays: MOVIE_LIST_BUILD_REFRESH_OLDER_THAN_DAYS,
				readiness,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			console.log(
				JSON.stringify({
					event: "movie-list-build-skipped",
					...result,
				}),
			);

			return result;
		}

		let lastTmdbId = 0;
		let upsertedRows = 0;
		let nextProgressLogAt = MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS;

		while (true) {
			const chunk = await getNextMovieListBuildChunk(
				env,
				lastTmdbId,
				MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS,
			);

			if (chunk.chunkRows === 0 || chunk.lastTmdbId === null) {
				break;
			}

			await upsertMovieListItemsChunk(env, lastTmdbId, chunk.lastTmdbId);

			lastTmdbId = chunk.lastTmdbId;
			upsertedRows += chunk.chunkRows;

			if (
				upsertedRows >= nextProgressLogAt ||
				upsertedRows === readiness.movieListCandidateRows
			) {
				console.log(
					JSON.stringify({
						event: "movie-list-build-progress",
						trigger,
						upsertedRows,
						candidateRows: readiness.movieListCandidateRows,
						lastTmdbId,
						durationMs: Date.now() - startedAtMs,
					}),
				);

				while (nextProgressLogAt <= upsertedRows) {
					nextProgressLogAt += MOVIE_LIST_BUILD_PROGRESS_EVERY_ROWS;
				}
			}
		}

		let deletedRows = 0;

		while (true) {
			const chunkDeletedRows = await cleanupInvalidMovieListItemsChunk(
				env,
				MOVIE_LIST_BUILD_CLEANUP_CHUNK_ROWS,
			);

			if (chunkDeletedRows === 0) {
				break;
			}

			deletedRows += chunkDeletedRows;
		}

		const countResult = await env.DB.prepare(
			"SELECT COUNT(*) AS movie_list_count FROM movie_list_items",
		).first<{ movie_list_count: number }>();
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		const result = {
			trigger,
			movieListCount: countResult?.movie_list_count ?? 0,
			refreshOlderThanDays: MOVIE_LIST_BUILD_REFRESH_OLDER_THAN_DAYS,
			insertChunkRows: MOVIE_LIST_BUILD_INSERT_CHUNK_ROWS,
			cleanupChunkRows: MOVIE_LIST_BUILD_CLEANUP_CHUNK_ROWS,
			upsertedRows,
			deletedRows,
			readiness,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		console.log(
			JSON.stringify({
				event: "movie-list-build-end",
				...result,
			}),
		);

		return result;
	} finally {
		await releaseImportJobLock(env, MOVIE_LIST_BUILD_JOB_NAME, lockOwner);
	}
}

async function getMovieSearchBuildReadiness(
	env: Env,
	refreshOlderThanDays: number,
): Promise<MovieSearchBuildReadiness> {
	const movieListReadiness = await getMovieListBuildReadiness(
		env,
		refreshOlderThanDays,
	);
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS movieListRows FROM movie_list_items",
	).first<{ movieListRows: number }>();

	return {
		...movieListReadiness,
		movieListRows: row?.movieListRows ?? 0,
	};
}

function getMovieSearchBuildReadinessBlockers(
	readiness: MovieSearchBuildReadiness,
) {
	const blockers = getMovieListBuildReadinessBlockers(readiness);

	if (readiness.movieListRows === 0) {
		blockers.push("movie_list_empty");
	}

	if (
		readiness.movieListCandidateRows > 0 &&
		readiness.movieListRows !== readiness.movieListCandidateRows
	) {
		blockers.push("movie_list_count_does_not_match_candidates");
	}

	return blockers;
}

async function getNextMovieSearchBuildChunk(
	env: Env,
	lastTmdbId: number,
	chunkRows: number,
) {
	const row = await env.DB.prepare(
		`SELECT
		    COUNT(*) AS chunkRows,
		    MAX(tmdb_id) AS lastTmdbId
		 FROM (
		    SELECT tmdb_id
		    FROM movie_list_items
		    WHERE tmdb_id > ?
		    ORDER BY tmdb_id
		    LIMIT ?
		 )`,
	)
		.bind(lastTmdbId, chunkRows)
		.first<MovieListBuildChunk>();

	return {
		chunkRows: row?.chunkRows ?? 0,
		lastTmdbId: row?.lastTmdbId ?? null,
	};
}

function getNextMovieSearchBuildPass(
	passName: MovieSearchBuildPass,
): MovieSearchBuildPass {
	if (passName === "no_filter") {
		return "genre_only";
	}

	if (passName === "genre_only") {
		return "provider_only";
	}

	if (passName === "provider_only") {
		return "genre_provider";
	}

	if (passName === "genre_provider") {
		return "cleanup_stale";
	}

	if (passName === "cleanup_stale") {
		return "cleanup_invalid";
	}

	return "complete";
}

async function getMovieSearchBuildState(
	env: Env,
): Promise<MovieSearchBuildState | null> {
	return env.DB.prepare(
		`SELECT job_name,
		        build_marker,
		        status,
		        pass_name,
		        last_tmdb_id,
		        selected_count,
		        processed_count,
		        started_at,
		        updated_at,
		        completed_at
		 FROM movie_search_build_state
		 WHERE job_name = ?`,
	)
		.bind(MOVIE_SEARCH_BUILD_JOB_NAME)
		.first<MovieSearchBuildState>();
}

async function resetMovieSearchBuildState(env: Env) {
	await env.DB.prepare(
		`DELETE FROM movie_search_build_state
		 WHERE job_name = ?`,
	)
		.bind(MOVIE_SEARCH_BUILD_JOB_NAME)
		.run();
}

async function initializeMovieSearchBuildState(
	env: Env,
	buildMarker: string,
	selectedCount: number,
) {
	await env.DB.prepare(
		`INSERT INTO movie_search_build_state (
			 job_name,
			 build_marker,
			 status,
			 pass_name,
			 last_tmdb_id,
			 selected_count,
			 processed_count,
			 started_at,
			 updated_at
		 )
		 VALUES (?, ?, 'running', 'no_filter', 0, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
	)
		.bind(MOVIE_SEARCH_BUILD_JOB_NAME, buildMarker, selectedCount)
		.run();
}

async function updateMovieSearchBuildStateProgress(
	env: Env,
	passName: MovieSearchBuildPass,
	lastTmdbId: number,
	processedCount: number,
) {
	await env.DB.prepare(
		`UPDATE movie_search_build_state
		 SET pass_name = ?,
		     last_tmdb_id = ?,
		     processed_count = ?,
		     updated_at = CURRENT_TIMESTAMP
		 WHERE job_name = ?`,
	)
		.bind(
			passName,
			lastTmdbId,
			processedCount,
			MOVIE_SEARCH_BUILD_JOB_NAME,
		)
		.run();
}

async function advanceMovieSearchBuildStatePass(
	env: Env,
	nextPassName: MovieSearchBuildPass,
	processedCount: number,
) {
	await env.DB.prepare(
		`UPDATE movie_search_build_state
		 SET status = CASE WHEN ? = 'complete' THEN 'complete' ELSE 'running' END,
		     pass_name = ?,
		     last_tmdb_id = 0,
		     processed_count = ?,
		     updated_at = CURRENT_TIMESTAMP,
		     completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP ELSE completed_at END
		 WHERE job_name = ?`,
	)
		.bind(
			nextPassName,
			nextPassName,
			processedCount,
			nextPassName,
			MOVIE_SEARCH_BUILD_JOB_NAME,
		)
		.run();
}

async function insertMovieSearchItemsPassRange(
	env: Env,
	passName: MovieSearchBuildPass,
	firstTmdbIdExclusive: number,
	lastTmdbIdInclusive: number,
	buildMarker: string,
) {
	const movieSearchSelectColumns = `movie.title,
		movie.poster_path,
		movie.release_date,
		movie.us_certification,
		CASE WHEN movie.us_certification IS NOT NULL
		          AND movie.us_certification <> ''
		     THEN 1 ELSE 0 END AS has_us_certification,
		CASE WHEN EXISTS (
			SELECT 1
			FROM movie_watch_providers AS provider_check
			WHERE provider_check.tmdb_id = movie.tmdb_id
			  AND provider_check.region = 'US'
		) THEN 1 ELSE 0 END AS has_us_watch_provider,
		CASE WHEN movie.poster_path IS NOT NULL
		          AND movie.poster_path <> ''
		     THEN 1 ELSE 0 END AS has_poster,
		movie.imdb_rating,
		movie.imdb_vote_count,
		COALESCE(movie.popularity, 0) AS popularity,
		? AS last_refreshed_at`;

	const insertMovieSearchRows = async (sql: string) => {
		const result = await env.DB
			.prepare(
				`INSERT OR REPLACE INTO movie_search_items (
					genre_id,
					provider_id,
					region,
					tmdb_id,
					title,
					poster_path,
					release_date,
					us_certification,
					has_us_certification,
					has_us_watch_provider,
					has_poster,
					imdb_rating,
					imdb_vote_count,
					popularity,
					last_refreshed_at
			)
			${sql}`,
			)
			.bind(buildMarker, firstTmdbIdExclusive, lastTmdbIdInclusive)
			.run();

		return result.meta.changes ?? 0;
	};

	if (passName === "no_filter") {
		return insertMovieSearchRows(
			`SELECT
				0 AS genre_id,
				0 AS provider_id,
				'US' AS region,
				movie.tmdb_id,
				${movieSearchSelectColumns}
			 FROM movie_list_items AS movie
			 WHERE movie.tmdb_id > ?
			   AND movie.tmdb_id <= ?`,
		);
	}

	if (passName === "genre_only") {
		return insertMovieSearchRows(
			`SELECT
				genre.genre_id,
				0 AS provider_id,
				'US' AS region,
				movie.tmdb_id,
				${movieSearchSelectColumns}
			 FROM movie_list_items AS movie
			 JOIN movie_genres AS genre
			   ON genre.tmdb_id = movie.tmdb_id
			 WHERE movie.tmdb_id > ?
			   AND movie.tmdb_id <= ?`,
		);
	}

	if (passName === "provider_only") {
		return insertMovieSearchRows(
			`SELECT
				0 AS genre_id,
				provider.provider_id,
				provider.region,
				movie.tmdb_id,
				${movieSearchSelectColumns}
			 FROM movie_list_items AS movie
			 JOIN movie_watch_providers AS provider
			   ON provider.tmdb_id = movie.tmdb_id
			  AND provider.region = 'US'
			 WHERE movie.tmdb_id > ?
			   AND movie.tmdb_id <= ?`,
		);
	}

	if (passName === "genre_provider") {
		return insertMovieSearchRows(
			`SELECT
				genre.genre_id,
				provider.provider_id,
				provider.region,
				movie.tmdb_id,
				${movieSearchSelectColumns}
			 FROM movie_list_items AS movie
			 JOIN movie_genres AS genre
			   ON genre.tmdb_id = movie.tmdb_id
			 JOIN movie_watch_providers AS provider
			   ON provider.tmdb_id = movie.tmdb_id
			  AND provider.region = 'US'
			 WHERE movie.tmdb_id > ?
			   AND movie.tmdb_id <= ?`,
		);
	}

	return 0;
}

async function cleanupInvalidMovieSearchItemsChunk(env: Env, chunkRows: number) {
	const result = await env.DB.prepare(
		`DELETE FROM movie_search_items
		 WHERE tmdb_id IN (
		    SELECT search.tmdb_id
		    FROM movie_search_items AS search
		    LEFT JOIN movie_list_items AS movie
		      ON movie.tmdb_id = search.tmdb_id
		    WHERE movie.tmdb_id IS NULL
		    LIMIT ?
		 )`,
	)
		.bind(chunkRows)
		.run();

	return result.meta.changes ?? 0;
}

async function cleanupStaleMovieSearchItemsChunk(
	env: Env,
	buildMarker: string,
	chunkRows: number,
) {
	const result = await env.DB.prepare(
		`DELETE FROM movie_search_items
		 WHERE rowid IN (
		    SELECT rowid
		    FROM movie_search_items
		    WHERE last_refreshed_at <> ?
		    LIMIT ?
		 )`,
	)
		.bind(buildMarker, chunkRows)
		.run();

	return result.meta.changes ?? 0;
}

async function rebuildMovieSearchItems(
	env: Env,
	trigger: "manual" | "cron",
	options: MovieSearchBuildOptions = {
		sourceRows: MOVIE_SEARCH_BUILD_SOURCE_ROWS_PER_RUN,
		reset: false,
	},
) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const lockOwner = createJobOwner(trigger);
	const jobRunId = `${MOVIE_SEARCH_BUILD_JOB_NAME}-${trigger}-${Date.now()}-${crypto.randomUUID()}`;
	const lockAcquired = await acquireImportJobLock(
		env,
		MOVIE_SEARCH_BUILD_JOB_NAME,
		lockOwner,
		MOVIE_SEARCH_BUILD_LOCK_MINUTES,
	);

	if (!lockAcquired) {
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		return {
			trigger,
			skipped: true,
			skipReason: "job_already_running",
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};
	}

	try {
		if (options.reset) {
			await resetMovieSearchBuildState(env);
		}

		console.log(
			JSON.stringify({
				event: "movie-search-build-start",
				trigger,
				startedAt,
				sourceRows: options.sourceRows,
				reset: options.reset,
			}),
		);

		const activeTmdbEnrichmentRun = await getActiveImportJobRun(env);

		if (activeTmdbEnrichmentRun) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				trigger,
				skipped: true,
				skipReason: "tmdb_enrichment_job_active",
				activeJobRunId: activeTmdbEnrichmentRun.job_run_id,
				activeStatus: activeTmdbEnrichmentRun.status,
				activeSelected: activeTmdbEnrichmentRun.selected_count,
				activeProcessed: activeTmdbEnrichmentRun.processed_count,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			console.log(
				JSON.stringify({
					event: "movie-search-build-skipped",
					...result,
				}),
			);

			return result;
		}

		const readiness = await getMovieSearchBuildReadiness(
			env,
			MOVIE_SEARCH_BUILD_REFRESH_OLDER_THAN_DAYS,
		);
		const readinessBlockers =
			getMovieSearchBuildReadinessBlockers(readiness);

		if (readinessBlockers.length > 0) {
			const endedAtMs = Date.now();
			const endedAt = new Date(endedAtMs).toISOString();
			const result = {
				trigger,
				skipped: true,
				skipReason: "movie_list_not_ready",
				readinessBlockers,
				refreshOlderThanDays: MOVIE_SEARCH_BUILD_REFRESH_OLDER_THAN_DAYS,
				readiness,
				startedAt,
				endedAt,
				durationMs: endedAtMs - startedAtMs,
			};

			console.log(
				JSON.stringify({
					event: "movie-search-build-skipped",
					...result,
				}),
			);

			return result;
		}

		let state = await getMovieSearchBuildState(env);

		if (!state || state.status === "complete") {
			await initializeMovieSearchBuildState(
				env,
				startedAt,
				readiness.movieListRows,
			);
			state = await getMovieSearchBuildState(env);
		}

		if (!state) {
			throw new Error("Movie search build state was not initialized.");
		}

		await env.DB.prepare(
			`INSERT INTO import_job_runs (
				 job_run_id,
				 job_name,
				 status,
				 trigger,
				 selected_count,
				 queued_count,
				 started_at,
				 last_progress_at
			 )
			 VALUES (?, ?, 'running', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
		)
			.bind(
				jobRunId,
				MOVIE_SEARCH_BUILD_JOB_NAME,
				trigger,
				state.selected_count,
				options.sourceRows,
			)
			.run();

		let insertedRows = 0;
		let deletedRows = 0;
		let staleDeletedRows = 0;
		let lastTmdbId = state.last_tmdb_id;
		let sourceRowsProcessed = state.processed_count;
		let completedPass = false;

		if (
			state.pass_name === "no_filter" ||
			state.pass_name === "genre_only" ||
			state.pass_name === "provider_only" ||
			state.pass_name === "genre_provider"
		) {
			const chunk = await getNextMovieSearchBuildChunk(
				env,
				state.last_tmdb_id,
				options.sourceRows,
			);

			if (chunk.chunkRows === 0 || chunk.lastTmdbId === null) {
				const nextPassName = getNextMovieSearchBuildPass(state.pass_name);
				await advanceMovieSearchBuildStatePass(
					env,
					nextPassName,
					sourceRowsProcessed,
				);
				completedPass = true;
			} else {
				insertedRows = await insertMovieSearchItemsPassRange(
					env,
					state.pass_name,
					state.last_tmdb_id,
					chunk.lastTmdbId,
					state.build_marker,
				);

				lastTmdbId = chunk.lastTmdbId;
				sourceRowsProcessed += chunk.chunkRows;

				await updateMovieSearchBuildStateProgress(
					env,
					state.pass_name,
					lastTmdbId,
					sourceRowsProcessed,
				);
			}
		} else if (state.pass_name === "cleanup_stale") {
			staleDeletedRows = await cleanupStaleMovieSearchItemsChunk(
				env,
				state.build_marker,
				MOVIE_SEARCH_BUILD_CLEANUP_CHUNK_ROWS,
			);

			if (staleDeletedRows === 0) {
				await advanceMovieSearchBuildStatePass(
					env,
					"cleanup_invalid",
					sourceRowsProcessed,
				);
				completedPass = true;
			}
		} else if (state.pass_name === "cleanup_invalid") {
			deletedRows = await cleanupInvalidMovieSearchItemsChunk(
				env,
				MOVIE_SEARCH_BUILD_CLEANUP_CHUNK_ROWS,
			);

			if (deletedRows === 0) {
				await advanceMovieSearchBuildStatePass(
					env,
					"complete",
					sourceRowsProcessed,
				);
				completedPass = true;
			}
		}

		const latestState = await getMovieSearchBuildState(env);
		const endedAtMs = Date.now();
		const endedAt = new Date(endedAtMs).toISOString();
		await env.DB.prepare(
			`UPDATE import_job_runs
			 SET status = ?,
			     processed_count = ?,
			     updated_count = ?,
			     ended_at = CURRENT_TIMESTAMP,
			     last_progress_at = CURRENT_TIMESTAMP
			 WHERE job_run_id = ?`,
		)
			.bind(
				latestState?.status === "complete" ? "complete" : "partial",
				sourceRowsProcessed,
				insertedRows,
				jobRunId,
			)
			.run();

		const result = {
			trigger,
			refreshOlderThanDays: MOVIE_SEARCH_BUILD_REFRESH_OLDER_THAN_DAYS,
			sourceRows: options.sourceRows,
			cleanupChunkRows: MOVIE_SEARCH_BUILD_CLEANUP_CHUNK_ROWS,
			passName: state.pass_name,
			nextPassName: latestState?.pass_name ?? null,
			completedPass,
			buildStatus: latestState?.status ?? null,
			buildMarker: state.build_marker,
			lastTmdbId,
			sourceRowsProcessed,
			insertedRows,
			deletedRows,
			staleDeletedRows,
			readiness,
			startedAt,
			endedAt,
			durationMs: endedAtMs - startedAtMs,
		};

		console.log(
			JSON.stringify({
				event: "movie-search-build-end",
				...result,
			}),
		);

		return result;
	} catch (error) {
		await env.DB.prepare(
			`UPDATE import_job_runs
			 SET status = 'failed',
			     ended_at = CURRENT_TIMESTAMP,
			     last_progress_at = CURRENT_TIMESTAMP,
			     last_error = ?
			 WHERE job_run_id = ?`,
		)
			.bind(error instanceof Error ? error.message : String(error), jobRunId)
			.run();

		throw error;
	} finally {
		await releaseImportJobLock(env, MOVIE_SEARCH_BUILD_JOB_NAME, lockOwner);
	}
}

async function enqueueMovieSearchBuildJob(
	env: Env,
	trigger: "manual" | "cron",
	options: MovieSearchBuildOptions,
) {
	if (options.reset) {
		await resetMovieSearchBuildState(env);
	}

	const jobRunId = `${MOVIE_SEARCH_BUILD_JOB_NAME}-${trigger}-${Date.now()}-${crypto.randomUUID()}`;

	await env.MOVIE_SEARCH_BUILD_QUEUE.send({
		kind: "movie-search-build",
		jobRunId,
		sourceRows: options.sourceRows,
	});

	console.log(
		JSON.stringify({
			event: "movie-search-build-queued",
			trigger,
			jobRunId,
			sourceRows: options.sourceRows,
			reset: options.reset,
		}),
	);

	return {
		trigger,
		queued: true,
		jobRunId,
		sourceRows: options.sourceRows,
		reset: options.reset,
	};
}

async function processMovieSearchBuildQueueMessage(
	env: Env,
	message: MovieSearchBuildQueueMessage,
) {
	const result = await rebuildMovieSearchItems(env, "cron", {
		sourceRows: message.sourceRows,
		reset: false,
	});

	console.log(
		JSON.stringify({
			event: "movie-search-build-queue-chain-disabled",
			jobRunId: message.jobRunId,
			result,
		}),
	);

	return result;
}

/*
	This helper makes JSON HTTP responses.

	Response.json(...) is the shorter built-in version. This helper does
	the same basic job, but also lets us keep the response shape consistent
	when we need to add options like:

		status: 404
		status: 405
		headers: { allow: "GET" }

	The body parameter is the value that the code calling jsonResponse(...)
	passes into this helper.

	For example, later in this file we call:

		jsonResponse({ movies: results })

	In that call:

		{ movies: results }

	is passed into this function as the body parameter.

	Then jsonResponse(...) takes that body value, turns it into a JSON
	string, puts that JSON string inside a Response object, and returns that
	Response back to the fetch function.

	The fetch function then returns that Response to Cloudflare, and
	Cloudflare sends it back over HTTP to the browser or mobile app.

	So "body" starts as a normal JavaScript value passed into this helper,
	and ends up as the JSON response body sent to the caller.

	body uses the type unknown on purpose.

	That can look odd because we just defined MovieRow above, but MovieRow
	only describes one database row. This helper is more general than that.
	It can send:

		{ movies: MovieRow[] }
		{ error: "Not found." }
		{ error: "Only GET requests are supported." }

	So unknown means:

		"jsonResponse can accept any kind of value, but this function should
		not make assumptions about that value before turning it into JSON."

	init uses the type ResponseInit.

	ResponseInit is everything about the response that is not the body.

	Like D1Database, ResponseInit is known because the Cloudflare Worker
	type definitions are included by this project. It is not a JavaScript
	reserved word and it does not need an import here.
	
	It is the whole second argument that can be
	passed into:

		new Response(body, init)

	The init object can contain several response options. For this file,
	the two important ones are:

		status: 404
		headers: { allow: "GET" }

	Those are sibling properties on the same object.

	An HTTP response has three separate main parts:

		1. status code
		2. headers
		3. body

	Example (In this *conceptual example of a full HTTP response, the status and headers are in the same ResponseInit object):

		{
			status: 404,
			headers: {
				allow: "GET"
			},
			body: {
				error: "Not found."
			}
		}

	* What the browser/app actually receives is an HTTP response. It has a status line, headers, and body separately:

		HTTP/1.1 404 Not Found
		content-type: application/json; charset=UTF-8

		{
		"error": "Not found."
		}

	In that conceptualexample above:

		status
			tells the browser/app the HTTP status code

		headers
			tells the browser/app extra HTTP metadata

	Important:

		body is not a property inside ResponseInit.

	The real Response constructor shape is:

		new Response(body, init)

	So there are two separate pieces:

		1. body
			the response content

		2. init
			the response options, such as status and headers

	Successful response example:

		jsonResponse({ movies: results })

	In that call:

		body gets:

			{ movies: results }

		init gets:

			undefined

	Because there is no second argument, the response uses the default
	success status code, which is 200.

	A beginner-friendly way to picture the final HTTP response is:

		{
			status: 200,
			headers: {
				"content-type": "application/json; charset=UTF-8"
			},
			body: {
				movies: results
			}
		}

	Again, that is the final response shape conceptually.
	In the actual code (1st line inside the function below), the call is still:

		new Response(JSON.stringify(body, null, 2), init)

*/
function jsonResponse(body: unknown, init?: ResponseInit) {
	/*
		JSON.stringify turns a JavaScript value into a JSON string.

		Its common parameter pattern is:

			JSON.stringify(value, replacer, space)

		Here that means:

			body
				the value we want to turn into JSON

			null
				no custom replacer function; keep the normal JSON behavior

			2
				pretty-print the JSON with 2 spaces of indentation

		Without the 2, the JSON would still work, but it would be compact
		on one line. The 2 makes browser output easier to read while learning.
	*/
	return new Response(JSON.stringify(body, null, 2), {
		/*
			The ... syntax here is object spread.

			Think of it as:

				copy the properties from one object into another object

			If init is this ResponseInit object:

				{ status: 404 }

			then this:

				{
					...init,
					headers: {
						"content-type": "application/json; charset=UTF-8"
					}
				}

			creates this final object:

				{
					status: 404,
					headers: {
						"content-type": "application/json; charset=UTF-8"
					}
				}

			But if we wrote init without the 3 dots:

				{
					init,
					headers: {
						"content-type": "application/json; charset=UTF-8"
					}
				}

			then JavaScript would create this different object:

				{
					init: {
						status: 404
					},
					headers: {
						"content-type": "application/json; charset=UTF-8"
					}
				}

			That is not what we want.

			The status would be trapped inside a property named init instead of
			being copied onto the main ResponseInit object. The Response
			constructor looks for status at the top level, not inside init.status.

			So the 3 dots are not JSON syntax. They are JavaScript object
			spread syntax.

			Here is another way without the dots that does not work:: 
				{
					status: init?.status,
					headers: {
						"content-type": "application/json; charset=UTF-8"
					}
				}

			That would copy only status, and only because we wrote status
			manually.

			The version with:

				...init

			is more flexible because it copies all properties from init, not
			just status.

			For example, if init is:

				{
					status: 405,
					statusText: "Method Not Allowed",
					headers: { allow: "GET" }
				}

			then:

				...init

			copies status, statusText, and headers into this new Response
			options object.

			Then our explicit headers block below sets the final headers object
			we want for JSON.

			This part is important:

				JavaScript objects cannot keep two separate headers properties.

			So this kind of object does not really keep both headers blocks:

				{
					status: 405,
					headers: { allow: "GET" },
					headers: {
						"content-type": "application/json; charset=UTF-8"
					}
				}

			The second headers property would replace the first headers property.

			That is why this helper rebuilds the final headers object itself.
			We are keeping control of the response headers by saying:

				1. every response from this helper should be JSON
				2. caller-provided headers, like allow: "GET", should still be kept

			So if init is:

				{
					status: 405,
					headers: { allow: "GET" }
				}

			then the final ResponseInit we are building becomes:

				{
					status: 405,
					headers: {
						"content-type": "application/json; charset=UTF-8",
						allow: "GET"
					}
				}

			So the final pattern means:

				1. start with any response options the caller passed in
				2. replace headers with our JSON headers object
				3. inside that headers object, also copy any caller headers

			If init is undefined, object spread does not copy anything.



			copy all init options,*/
		...init,
		/* 	keep the status from init, but replace the copied headers object with a rebuilt one so we can guarantee JSON content-type*/
		headers: {
			/*
				This lowercase headers key is just a normal property name
				inside the Response options object.

				If VS Code shows headers in white, that is expected. Here it
				is not a special keyword. It is just the property name that
				the Response constructor understands.

				There is also a capital-H Headers class in the Fetch API:

					new Headers(...)

				That is different. We are not using that class here. We are
				using a plain object because Response accepts plain header
				objects too.
			*/
			"content-type": "application/json; charset=UTF-8",
			/*
				This is another object spread.

				init?.headers means:

					if init exists, read init.headers
					if init does not exist, return undefined

				Then:

					...init?.headers

				copies any caller-provided headers into this headers object.

				Because this comes after content-type, a caller could override
				content-type if they passed a different one. For this beginner
				test API, the important part is that JSON responses get a JSON
				content type by default.

			but add back the other header properties from the caller so we can still keep the caller headers.*/
			...init?.headers,
		},
	});
}

function parsePositiveIntegerParam(
	value: string | null,
	defaultValue: number,
	maxValue: number,
	paramName: string,
) {
	const parsedValue = value === null ? defaultValue : Number(value);

	if (
		!Number.isInteger(parsedValue) ||
		parsedValue < 1 ||
		parsedValue > maxValue
	) {
		throw new RequestValidationError(
			`${paramName} must be a whole number between 1 and ${maxValue}.`,
		);
	}

	return parsedValue;
}

function parseOptionalPositiveIntegerParam(
	value: string | null,
	maxValue: number,
	paramName: string,
) {
	if (value === null || value.trim() === "") {
		return null;
	}

	return parsePositiveIntegerParam(value, 1, maxValue, paramName);
}

function parseMovieSearchSortParam(value: string | null): MovieSearchSort {
	if (value === null || value.trim() === "" || value === "popularity") {
		return "popularity";
	}

	if (value === "imdb") {
		return "imdb";
	}

	throw new RequestValidationError("sort must be popularity or imdb.");
}

function getDefaultMovieSearchBeginDate() {
	const today = new Date();
	const year = today.getUTCFullYear() - 5;
	return `${year}-01-01`;
}

function getDefaultMovieSearchEndDate() {
	return new Date().toISOString().slice(0, 10);
}

function getMovieSearchDateRange(url: URL) {
	const datePreset = url.searchParams.get("datePreset");
	const endDatePreset = url.searchParams.get("endDatePreset");

	if (
		endDatePreset !== null &&
		endDatePreset.trim() !== "" &&
		endDatePreset !== "today"
	) {
		throw new RequestValidationError("endDatePreset must be today.");
	}

	if (datePreset === null || datePreset.trim() === "") {
		if (endDatePreset === "today" && url.searchParams.has("endDate")) {
			throw new RequestValidationError(
				"endDatePreset cannot be combined with endDate.",
			);
		}

		return {
			beginDate:
				url.searchParams.get("beginDate") ?? getDefaultMovieSearchBeginDate(),
			endDate:
				endDatePreset === "today"
					? getDefaultMovieSearchEndDate()
					: (url.searchParams.get("endDate") ?? getDefaultMovieSearchEndDate()),
			datePreset: null,
			endDatePreset: endDatePreset === "today" ? endDatePreset : null,
		};
	}

	if (datePreset !== "last5years") {
		throw new RequestValidationError("datePreset must be last5years.");
	}

	if (
		url.searchParams.has("beginDate") ||
		url.searchParams.has("endDate") ||
		url.searchParams.has("endDatePreset")
	) {
		throw new RequestValidationError(
			"datePreset cannot be combined with beginDate, endDate, or endDatePreset.",
		);
	}

	return {
		beginDate: getDefaultMovieSearchBeginDate(),
		endDate: getDefaultMovieSearchEndDate(),
		datePreset,
		endDatePreset: null,
	};
}

function parseIntegerListParam(value: string | null, paramName: string) {
	if (value === null || value.trim() === "") {
		return [];
	}

	const parsedValues = value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => Number(part));

	if (
		parsedValues.length === 0 ||
		parsedValues.some((parsedValue) => !Number.isInteger(parsedValue))
	) {
		throw new RequestValidationError(
			`${paramName} must be a comma-separated list of integers.`,
		);
	}

	return [...new Set(parsedValues)];
}

function parseStringListParam(value: string | null) {
	if (value === null || value.trim() === "") {
		return [];
	}

	return [
		...new Set(
			value
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0),
		),
	];
}

function parseWatchMonetizationTypesParam(value: string | null) {
	const monetizationTypes = parseStringListParam(value);

	if (
		monetizationTypes.some(
			(monetizationType) => monetizationType !== "flatrate",
		)
	) {
		throw new RequestValidationError(
			"watchMonetizationTypes must be flatrate.",
		);
	}

	return monetizationTypes;
}

function encodeMovieSearchCursor(item: {
	tmdb_id: number;
	imdb_rating: number | null;
	imdb_vote_count: number;
	popularity: number;
}, sort: MovieSearchSort) {
	const cursor: MovieSearchCursor =
		sort === "imdb"
			? {
					sort,
					imdbRating: item.imdb_rating ?? 0,
					imdbVoteCount: item.imdb_vote_count,
					tmdbId: item.tmdb_id,
				}
			: {
					sort,
					popularity: item.popularity,
					tmdbId: item.tmdb_id,
				};

	return btoa(JSON.stringify(cursor));
}

function decodeMovieSearchCursor(value: string | null, sort: MovieSearchSort) {
	if (value === null || value.trim() === "") {
		return null;
	}

	try {
		const parsedValue = JSON.parse(atob(value)) as Partial<MovieSearchCursor>;

		if (parsedValue.sort !== sort || typeof parsedValue.tmdbId !== "number") {
			throw new RequestValidationError("Invalid cursor shape.");
		}

		if (
			sort === "imdb" &&
			(typeof parsedValue.imdbRating !== "number" ||
				typeof parsedValue.imdbVoteCount !== "number")
		) {
			throw new RequestValidationError("Invalid cursor shape.");
		}

		if (sort === "popularity" && typeof parsedValue.popularity !== "number") {
			throw new RequestValidationError("Invalid cursor shape.");
		}

		return parsedValue as MovieSearchCursor;
	} catch {
		throw new RequestValidationError("cursor is invalid.");
	}
}

async function searchMovieListItems(env: Env, url: URL) {
	const pageSize = parsePositiveIntegerParam(
		url.searchParams.get("pageSize"),
		20,
		50,
		"pageSize",
	);
	let sort = parseMovieSearchSortParam(url.searchParams.get("sort"));
	const minImdbVotes = parseOptionalPositiveIntegerParam(
		url.searchParams.get("minImdbVotes"),
		10_000_000,
		"minImdbVotes",
	);

	if (minImdbVotes !== null) {
		sort = "imdb";
	}
	const genreIds = parseIntegerListParam(
		url.searchParams.get("genreIds"),
		"genreIds",
	);
	const providerIds = parseIntegerListParam(
		url.searchParams.get("providerIds"),
		"providerIds",
	);
	const watchMonetizationTypes = parseWatchMonetizationTypesParam(
		url.searchParams.get("watchMonetizationTypes"),
	);
	const certifications = parseStringListParam(
		url.searchParams.get("certifications"),
	);
	const { beginDate, endDate, datePreset, endDatePreset } =
		getMovieSearchDateRange(url);
	const cursor = decodeMovieSearchCursor(url.searchParams.get("cursor"), sort);

	if (!isIsoDate(beginDate)) {
		throw new RequestValidationError("beginDate must use YYYY-MM-DD format.");
	}

	if (!isIsoDate(endDate)) {
		throw new RequestValidationError("endDate must use YYYY-MM-DD format.");
	}

	if (beginDate > endDate) {
		throw new RequestValidationError(
			"beginDate must be less than or equal to endDate.",
		);
	}

	if (providerIds.length > 0 && watchMonetizationTypes.length > 0) {
		throw new RequestValidationError(
			"providerIds cannot be combined with watchMonetizationTypes.",
		);
	}

	const movieIndexHint =
		sort === "popularity"
			? " INDEXED BY idx_movie_list_items_search_popularity_date_cover"
			: certifications.length === 0
				? " INDEXED BY idx_movie_list_items_search_imdb_date_cover"
				: "";
	const sqlParts = [
		`SELECT
		    movie.tmdb_id,
		    movie.poster_path,
		    movie.imdb_rating,
		    movie.imdb_vote_count,
		    movie.popularity
		  FROM movie_list_items AS movie${movieIndexHint}
		  WHERE movie.release_date >= ?
		    AND movie.release_date <= ?`,
	];
	const bindings: Array<number | string> = [beginDate, endDate];

	if (sort === "imdb") {
		sqlParts.push("AND movie.imdb_rating IS NOT NULL");
	}

	if (minImdbVotes !== null) {
		sqlParts.push("AND movie.imdb_vote_count >= ?");
		bindings.push(minImdbVotes);
	}

	for (const genreId of genreIds) {
		sqlParts.push(
			`AND EXISTS (
			   SELECT 1
			   FROM movie_genres AS genre
			   WHERE genre.tmdb_id = movie.tmdb_id
			     AND genre.genre_id = ?
			 )`,
		);
		bindings.push(genreId);
	}

	if (providerIds.length > 0) {
		const placeholders = providerIds.map(() => "?").join(", ");
		sqlParts.push(
			`AND EXISTS (
			   SELECT 1
			   FROM movie_watch_providers AS provider
			   WHERE provider.tmdb_id = movie.tmdb_id
			     AND provider.region = 'US'
			     AND provider.provider_id IN (${placeholders})
			 )`,
		);
		bindings.push(...providerIds);
	}

	if (watchMonetizationTypes.includes("flatrate")) {
		sqlParts.push(
			`AND EXISTS (
			   SELECT 1
			   FROM movie_watch_providers AS provider
			   WHERE provider.tmdb_id = movie.tmdb_id
			     AND provider.region = 'US'
			 )`,
		);
	}

	if (certifications.length > 0) {
		const placeholders = certifications.map(() => "?").join(", ");
		sqlParts.push(`AND movie.us_certification IN (${placeholders})`);
		bindings.push(...certifications);
	}

	if (cursor !== null) {
		if (sort === "imdb") {
			sqlParts.push(
				`AND (
				   movie.imdb_rating < ?
				   OR (
				     movie.imdb_rating = ?
				     AND movie.imdb_vote_count < ?
				   )
				   OR (
				     movie.imdb_rating = ?
				     AND movie.imdb_vote_count = ?
				     AND movie.tmdb_id > ?
				   )
				 )`,
			);
			bindings.push(
				cursor.imdbRating ?? 0,
				cursor.imdbRating ?? 0,
				cursor.imdbVoteCount ?? 0,
				cursor.imdbRating ?? 0,
				cursor.imdbVoteCount ?? 0,
				cursor.tmdbId,
			);
		} else {
			sqlParts.push(
				`AND (
				   movie.popularity < ?
				   OR (
				     movie.popularity = ?
				     AND movie.tmdb_id > ?
				   )
				 )`,
			);
			bindings.push(cursor.popularity ?? 0, cursor.popularity ?? 0, cursor.tmdbId);
		}
	}

	if (sort === "imdb") {
		sqlParts.push(
			`ORDER BY
			    movie.imdb_rating DESC,
			    movie.imdb_vote_count DESC,
			    movie.tmdb_id
			  LIMIT ?`,
		);
	} else {
		sqlParts.push(
			`ORDER BY
			    movie.popularity DESC,
			    movie.tmdb_id
			  LIMIT ?`,
		);
	}

	bindings.push(pageSize + 1);

	const { results } = await env.DB.prepare(sqlParts.join("\n"))
		.bind(...bindings)
		.all<MovieSearchListItem & { imdb_vote_count: number; popularity: number }>();
	const pageRows = results.slice(0, pageSize);
	const lastRow = pageRows.at(-1);
	const nextCursor =
		results.length > pageSize && lastRow
			? encodeMovieSearchCursor(lastRow, sort)
			: null;
	const movies = pageRows.map(
		({ imdb_vote_count: _imdbVoteCount, popularity: _popularity, ...movie }) =>
			movie,
	);

	return {
		movies,
		nextCursor,
		pageSize,
		sort,
		beginDate,
		endDate,
		datePreset,
		endDatePreset,
	};
}

function movieSearchCacheHeaders(cacheStatus: "HIT" | "MISS") {
	return {
		"Cache-Control": `public, max-age=60, s-maxage=${MOVIE_SEARCH_CACHE_SECONDS}, stale-while-revalidate=${MOVIE_SEARCH_STALE_SECONDS}`,
		"CDN-Cache-Control": `public, max-age=${MOVIE_SEARCH_CACHE_SECONDS}`,
		"Cloudflare-CDN-Cache-Control": `public, max-age=${MOVIE_SEARCH_CACHE_SECONDS}`,
		"X-MovieApp-Cache": cacheStatus,
	};
}

async function getCachedMovieSearchResponse(
	request: Request,
	env: Env,
	url: URL,
	ctx?: ExecutionContext,
) {
	const cacheKey = new Request(url.toString(), request);
	const cache = caches.default;
	const cachedResponse = await cache.match(cacheKey).catch(() => undefined);

	if (cachedResponse) {
		const headers = new Headers(cachedResponse.headers);
		headers.set("X-MovieApp-Cache", "HIT");

		return new Response(cachedResponse.body, {
			status: cachedResponse.status,
			statusText: cachedResponse.statusText,
			headers,
		});
	}

	const result = await searchMovieListItems(env, url);
	const response = Response.json(result, {
		headers: movieSearchCacheHeaders("MISS"),
	});
	const cachePut = cache.put(cacheKey, response.clone()).catch(() => undefined);

	if (ctx) {
		ctx.waitUntil(cachePut);
	} else {
		await cachePut;
	}

	return response;
}

/*
	This default export is the Worker itself.

	Cloudflare calls the fetch function every time someone makes
	an HTTP request to your Worker URL.

	This file is not a React page or an HTML page. It is the Worker entry
	file. When you open a Worker URL in a browser, Cloudflare routes that
	web request to this code and calls this fetch function.

	Example request later:

		GET https://your-worker.workers.dev/movies

	When running locally with Wrangler, the local version is usually:

		GET http://localhost:8787/movies

	The request parameter is a Request object.

	It contains information about the incoming web request, such as:

		request.url
		request.method
		request.headers
		request.body

	The env parameter is the Env object described above. It contains the
	Cloudflare bindings attached to this Worker, such as env.DB.

	This Worker function currently declares only:

		request
		env

	That is enough for this /movies endpoint because this code only needs to:

		1. read the incoming request
		2. use env.DB to query D1
		3. return a Response

	Cloudflare Workers also support another fetch signature with a third
	parameter:

		async fetch(
			request: Request,
			env: Env,
			ctx: ExecutionContext,
		): Promise<Response>

	The third parameter is usually called ctx, short for context.

	You would add ctx only when this Worker needs Worker-specific request
	tools, especially background work with:

		ctx.waitUntil(...)

	Example future idea:

		1. return the /movies JSON response to the app immediately
		2. use ctx.waitUntil(...) to update a cache after the response

	We are not using that yet, so this file keeps the simpler two-parameter
	fetch function.

	The return type Promise<Response> means:

		this async fetch function returns a Promise
		and when that Promise finishes, the final value must be a Response

	Response is the HTTP response that Cloudflare sends back to the browser
	or app that called the Worker.
*/
export default {
	async fetch(
		request: Request,
		env: Env,
		ctx?: ExecutionContext,
	): Promise<Response> {
		/*
			Convert the incoming request URL into a URL object.

			This lets us easily read parts of the request like:

				url.pathname

			If the full URL is:

				https://your-worker.workers.dev/movies

			then:

				url.pathname === "/movies"
		*/
		const url = new URL(request.url);

		/*
			This Worker is only acting like a read-only API right now.

			GET means "read data".

			If someone tries POST, PUT, PATCH, or DELETE, this returns 405.
			Status 405 means:

				the route exists, but this HTTP method is not allowed.

			The allow: "GET" header tells the caller which method is valid.
		*/
		if (request.method !== "GET") {
			return jsonResponse(
				{ error: "Only GET requests are supported." },
				{ status: 405, headers: { allow: "GET" } },
			);
		}

		if (url.pathname === "/movies/search") {
			try {
				return await getCachedMovieSearchResponse(request, env, url, ctx);
			} catch (error) {
				if (error instanceof RequestValidationError) {
					return Response.json({ error: error.message }, { status: 400 });
				}

				return Response.json(
					{ error: "Movie search failed." },
					{ status: 500 },
				);
			}
		}

		/*
			This temporary admin route is the Step 4 dry-run test.

			Example:

				/admin/import/imdb-ratings/dry-run?limit=10000

			It reads a limited number of rows from the remote IMDb file and
			returns sample JSON so we can prove Cloudflare can process the file
			before we build the real D1 import.
		*/
		if (url.pathname === "/admin/import/imdb-ratings/dry-run") {
			const limit = Number(url.searchParams.get("limit") ?? 10000);
			const result = await dryRunReadImdbRatings(limit);
			return Response.json(result);
		}

		if (url.pathname === "/admin/import/imdb-ratings/enqueue-manual") {
			const limit = Number(url.searchParams.get("limit") ?? 330);
			const result = await enqueueImdbRatingRows(env, limit);
			return Response.json(result);
		}

			if (url.pathname === "/admin/import/tmdb/load-manual") {
				const startedAtMs = Date.now();
				const startedAt = new Date(startedAtMs).toISOString();
				const limit = Number(url.searchParams.get("limit") ?? 100);
				const beginDate =
					url.searchParams.get("beginDate") ??
					(await getTmdbRefreshStartDate(env));
				const endDate = url.searchParams.get("endDate");

				if (!Number.isInteger(limit) || limit < 1) {
					return Response.json(
						{ error: "limit must be a positive integer." },
						{ status: 400 },
					);
				}

				if (!isIsoDate(beginDate)) {
					return Response.json(
						{ error: "beginDate must use YYYY-MM-DD format.", beginDate },
						{ status: 400 },
					);
				}

				if (!endDate || !isIsoDate(endDate)) {
					return Response.json(
						{ error: "endDate is required and must use YYYY-MM-DD format.", endDate },
						{ status: 400 },
					);
				}

				if (beginDate > endDate) {
					return Response.json(
						{
							error: "beginDate must be less than or equal to endDate.",
							beginDate,
							endDate,
						},
						{ status: 400 },
					);
				}

				console.log(
					JSON.stringify({
						event: "tmdb-load-manual-start",
						startedAt,
						limit,
						beginDate,
						endDate,
					}),
				);

				const result = await loadTmdbPrimaryRowsManual(
					env,
					beginDate,
					endDate,
					limit,
				);

				const endedAtMs = Date.now();
				const endedAt = new Date(endedAtMs).toISOString();
				const durationMs = endedAtMs - startedAtMs;
				const responseBody = {
					...result,
					startedAt,
					endedAt,
					durationMs,
				};

				console.log(
					JSON.stringify({
						event: "tmdb-load-manual-end",
						startedAt,
						endedAt,
						durationMs,
						limit,
						beginDate,
						endDate,
						pagesRead: result.pagesRead,
						rowsSeen: result.rowsSeen,
						rowsInserted: result.rowsInserted,
						totalPagesSeen: result.totalPagesSeen,
						tmdbDiscoverMaxPage: result.tmdbDiscoverMaxPage,
						windowsLoaded: result.windowsLoaded,
						windowsSplit: result.windowsSplit,
						pendingWindows: result.pendingWindows,
						stoppedWindow: result.stoppedWindow,
						stopReason: result.stopReason,
					}),
				);

			return Response.json(responseBody);
		}

		if (url.pathname === "/admin/import/tmdb/enrich-progress") {
			const runs = await getRecentImportJobRuns(env);
			return Response.json({ runs });
		}

		if (url.pathname === "/admin/import/tmdb/enrich-manual") {
			const limit = Number(url.searchParams.get("limit") ?? 1000);
			const refreshOlderThanDays = Number(
				url.searchParams.get("refreshOlderThanDays") ?? 7,
			);

			if (!Number.isInteger(limit) || limit < 1) {
				return Response.json(
					{ error: "limit must be a positive integer." },
					{ status: 400 },
				);
			}

			if (
				!Number.isInteger(refreshOlderThanDays) ||
				refreshOlderThanDays < 1
			) {
				return Response.json(
					{ error: "refreshOlderThanDays must be a positive integer." },
					{ status: 400 },
				);
			}

			const result = await enqueueTmdbEnrichmentJob(env, {
				limit,
				refreshOlderThanDays,
				progressEvery: 5000,
				tmdbConcurrency: TMDB_ENRICH_TMDB_CONCURRENCY,
				useLock: true,
				trigger: "manual",
			});

			return Response.json(result);
		}

		if (url.pathname === "/admin/import/movie-list/rebuild-manual") {
			const result = await rebuildMovieListItems(env, "manual");
			return Response.json(result);
		}

		if (url.pathname === "/admin/import/movie-search/rebuild-manual") {
			const sourceRows = Number(
				url.searchParams.get("sourceRows") ??
					MOVIE_SEARCH_BUILD_SOURCE_ROWS_PER_RUN,
			);
			const reset = url.searchParams.get("reset") === "true";

			if (!Number.isInteger(sourceRows) || sourceRows < 1) {
				return Response.json(
					{ error: "sourceRows must be a positive integer." },
					{ status: 400 },
				);
			}

			const result = await enqueueMovieSearchBuildJob(env, "manual", {
				sourceRows,
				reset,
			});
			return Response.json(result);
		}

		/*
			This creates a simple GET API route.

			We only want this block to run when the request path is /movies.
		*/
		if (url.pathname === "/movies") {
			/*
				This SQL query reads rows from your D1 table.

				It selects these columns:

					id
					MovieName
					IMDBRating
					IMDBVoteCounts

				ORDER BY id means:

					return rows by id from low to high

				That usually means oldest inserted to newest inserted,
				as long as id grows each time you insert a row.
			*/
			const { results } = await env.DB.prepare(
				"SELECT id, MovieName, IMDBRating, IMDBVoteCounts FROM movies ORDER BY id",
			).all<MovieRow>();

			/*
				results contains the actual rows returned by D1.

				jsonResponse(...) turns those rows into a JSON HTTP response.

				This Worker returns an object with a movies key:

					{
						"movies": [
							{
								"id": 1,
								"MovieName": "Terminator 2",
								"IMDBRating": "9.9",
								"IMDBVoteCounts": "56,000"
							}
						]
					}

				Wrapping the array in { movies: ... } gives the app a stable
				top-level shape if we add more fields later, such as count or page.
			*/
			return jsonResponse({ movies: results });
		}

		/*
			If the user requests anything other than /movies,
			return a 404 response.

			Example:

				/hello
				/test
				/whatever

			Those are not valid routes yet, so they get "Not found".
		*/
		return jsonResponse({ error: "Not found." }, { status: 404 });
	},

	async queue(
		batch: MessageBatch<WorkerQueueMessage>,
		env: Env,
	): Promise<void> {
		for (const message of batch.messages) {
			if (isTmdbEnrichmentQueueMessage(message.body)) {
				const rows = message.body.tmdbIds.map((tmdbId) => ({ tmdb_id: tmdbId }));

				await processTmdbEnrichmentRows(
					env,
					message.body.jobRunId,
					rows,
					"queue",
				);

				message.ack();
				continue;
			}

			if (isMovieSearchBuildQueueMessage(message.body)) {
				await processMovieSearchBuildQueueMessage(env, message.body);
				message.ack();
				continue;
			}

			const rows = message.body.rows;

			if (rows.length === 0) {
				message.ack();
				continue;
			}

			const placeholders = rows.map(() => "(?, ?, ?)").join(", ");
			const values = rows.flatMap((row) => [
				row.imdb_id,
				row.average_rating,
				row.num_votes,
			]);

			await env.DB
				.prepare(
					`INSERT OR REPLACE INTO imdb_ratings_staging
						(imdb_id, average_rating, num_votes)
					VALUES ${placeholders}`,
				)
				.bind(...values)
				.run();

			message.ack();
		}
	},

	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		if (controller.cron === SCHEDULED_IMDB_CRON) {
			ctx.waitUntil(runScheduledImdbRatingsRefresh(env));
			return;
		}

		if (controller.cron === SCHEDULED_TMDB_PRIMARY_CRON) {
			ctx.waitUntil(runScheduledTmdbPrimaryRefresh(env));
			return;
		}

		if (controller.cron === SCHEDULED_TMDB_ENRICHMENT_CRON) {
			ctx.waitUntil(
				enqueueTmdbEnrichmentJob(env, {
					limit: TMDB_ENRICHMENT_CRON_LIMIT,
					refreshOlderThanDays: 7,
					progressEvery: 5000,
					tmdbConcurrency: TMDB_ENRICH_TMDB_CONCURRENCY,
					useLock: true,
					trigger: "cron",
				}),
			);
			return;
		}

		if (controller.cron === SCHEDULED_MOVIE_LIST_BUILD_CRON) {
			ctx.waitUntil(rebuildMovieListItems(env, "cron"));
			return;
		}

		if (controller.cron === SCHEDULED_MOVIE_SEARCH_BUILD_CRON) {
			console.log(
				JSON.stringify({
					event: "movie-search-build-cron-disabled",
					cron: controller.cron,
					reason: "Using movie_list_items plus existing genre/provider tables for search.",
				}),
			);
			return;
		}

		console.log(
			JSON.stringify({
				event: "scheduled-cron-unhandled",
				cron: controller.cron,
			}),
		);
	},
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
