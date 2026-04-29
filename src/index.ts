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

const IMDB_QUEUE_ROWS_PER_MESSAGE = 33;
const IMDB_QUEUE_MESSAGES_PER_SEND_BATCH = 100;
const TMDB_MAX_REQUESTS_PER_SECOND = 35;
const TMDB_MAX_RETRIES = 3;
const TMDB_DISCOVER_MAX_PAGE = 500;
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
	async fetch(request: Request, env: Env): Promise<Response> {
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
		batch: MessageBatch<ImdbRatingQueueMessage>,
		env: Env,
	): Promise<void> {
		for (const message of batch.messages) {
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
} satisfies ExportedHandler<Env, ImdbRatingQueueMessage>;
