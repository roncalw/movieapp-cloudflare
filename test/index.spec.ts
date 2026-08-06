/*
	This file tests the Worker code in src/index.ts.

	Vitest is the test runner.

	A test runner is a tool that:

		1. loads your test files
		2. runs each test
		3. reports pass or fail

	In this repo, package.json has:

		"test": "vitest"

	That means you can run these tests from the Cloudflare repo with:

		npm test

	This is different from your browser test.

	Browser/manual test:

		1. run npm run dev
		2. open http://localhost:8787/movies
		3. look at the JSON response in the browser

	Vitest/automated test:

		1. run npm test
		2. Vitest calls the Worker code directly
		3. Vitest checks the response for you

	The browser test proves the local Worker can respond in a real request.
	The Vitest test proves the code still behaves correctly after changes.

	The imports below bring in the tools this test file needs.

	Notice what is not imported here:

		createExecutionContext
		waitOnExecutionContext

	Those tools come from cloudflare:test, and they are used when a Worker
	test needs the third Cloudflare fetch parameter, usually called ctx.

	This /movies Worker does not use ctx.

	Right now src/index.ts declares:

		fetch(request, env)

	So this test also calls:

		worker.fetch(request, mock.env)

	That keeps the test matched to the Worker we actually wrote.

	Cloudflare Workers can also use a larger fetch signature:

		fetch(request, env, ctx)

	ctx is a context object for request-related Worker tools.
	A common future use is:

		ctx.waitUntil(...)

	That lets a Worker return a response now, while Cloudflare keeps some
	background work alive afterward.

	Example future idea:

		1. return the /movies JSON response
		2. use ctx.waitUntil(...) to refresh a cache after responding

	If we add ctx to src/index.ts later, then this test can import
	createExecutionContext and waitOnExecutionContext. We do not need them
	for the current two-parameter /movies Worker.

	From vitest:

		describe
			groups related tests together so the test output is organized.

		it
			defines one individual test case.

		expect
			checks that the actual result matches what we expected.
			If an expect(...) check fails, npm test fails.

	From ../src/index:

		worker
			imports the default export from src/index.ts.
			That is the Worker object whose fetch(...) function we want to test.

		type Env
			imports only the TypeScript type named Env.
			The word type means this import is for TypeScript checking only.
			It does not become runtime JavaScript.

			This is why we cannot "just bring in Env.DB".

			Env is not a real object that exists while the test runs.
			Env is only a TypeScript description of what the real env object
			should look like.

			In the real Worker, Cloudflare creates the actual runtime env object
			for each request. That real runtime object has:

				env.DB

			because your Wrangler config binds the D1 database as DB.

			In this test, Cloudflare is not giving us the real D1 database.
			So we create our own fake env object lower in this file:

				const env = {
					DB: {
						prepare(...) { ... }
					}
				}

			Then we use the Env type to tell TypeScript:

				"treat this fake object like the Worker env shape."

			So:

				type Env
					compile-time shape/checking only

				env.DB
					real runtime object/property used by the Worker code
*/
import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/index";

/*
	The Cloudflare test tools need this typed Request helper.

	The real request we create in this test is simple:

		new IncomingRequest("http://example.com/movies")

	The important part for our Worker is the path:

		/movies

	because src/index.ts does this:

		const url = new URL(request.url);

		if (url.pathname === "/movies") {
			...
		}

	So the request is still just a normal test request with a URL.
	The generic types below do not change that URL.

	This line uses a TypeScript feature called generics:

		Request<unknown, IncomingRequestCfProperties>

	Generics let a type receive extra type details inside angle brackets.

	The values inside the angle brackets are called type arguments.
	They are separated by a comma:

		Request<firstTypeArgument, secondTypeArgument>

	So this:

		Request<unknown, IncomingRequestCfProperties>

	means:

		Request
			the main type we are customizing

		unknown
			the first type argument

		IncomingRequestCfProperties
			the second type argument

		The comma is just how TypeScript separates multiple generic type
		arguments. It is similar to how function arguments are separated:

			someFunction(firstValue, secondValue)

	For this Cloudflare Request type, the two type arguments describe
	Cloudflare-specific request typing details:

		1. the first type argument describes Cloudflare host metadata
		2. the second type argument describes Cloudflare request properties

	We use unknown for the first type argument because this test does not
	use custom Cloudflare host metadata.

	For example, we are not testing anything like:

		"which Cloudflare account did this request come through?"
		"which custom Cloudflare host routed this request?"
		"what extra platform metadata did Cloudflare attach to the host?"

	Our Worker only cares about the URL path:

		/movies

	So we use unknown to say:

		"there might be host metadata in Cloudflare's bigger type system,
		but this test does not know it or use it."

	unknown means:

		"there may be a value here, but this test is not going to assume
		anything specific about its shape."

	That is safer than using any.

	any means:

		"turn off type checking for this value."

	unknown means:

		"we do not know the shape, so TypeScript should not let us casually
		use properties on it without narrowing/checking first."

	The second type argument, IncomingRequestCfProperties, tells TypeScript
	to use the Cloudflare request-property shape expected by Workers tests.

	That means TypeScript treats this as a request shaped for a Cloudflare
	Worker test, not just a plain browser-only request.

	For example, Cloudflare Worker requests can have Cloudflare-specific
	request information available through request.cf in real Worker contexts.

	We are not reading request.cf in this test. We are still only reading:

		request.url

	But this type keeps the fake request compatible with the Cloudflare
	Worker testing tools.

	In plain English, this helper says:

		"make a Request class that TypeScript treats like a Cloudflare
		Worker incoming request, even though our actual test request is just
		a simple URL."
*/
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/*
	This function creates a fake Worker environment for the test.

	Later in this file, the test calls it like this:

		const mock = createMockEnv(rows);

	In that call:

		rows
			the fake database rows we want D1 to return

		That mock constant because it is equal to this function's return value will then have these properties:
			mock.env
				the fake Worker environment that gets passed into worker.fetch(...)

			mock.getPreparedSql()
				a helper function the test uses to check which SQL query the
				Worker sent to D1

	In the real Worker, Cloudflare provides:

		env.DB

	and env.DB talks to your real D1 database.

	In this test file, we do not want to depend on the real database.
	Instead, we create a small fake DB object with the same basic shape:

		env.DB.prepare(...).all()

	That lets Vitest test the Worker route logic without needing:

		a browser
		Wrangler dev server
		a live Cloudflare request
		real D1 rows
*/
function createMockEnv(rows: unknown[], envOverrides: Partial<Env> = {}) {
	/*
		This variable remembers the SQL string that the Worker sends to D1.

		Later in the test, we check it with expect(...).toBe(...).
		That proves the Worker asked for the columns we expect.
	*/
	let preparedSql = "";
	let preparedBindings: unknown[] = [];
	const preparedCalls: Array<{ sql: string; bindings: unknown[] }> = [];
	let prepareCount = 0;

	const env = {
		DB: {
			/*
				This fake prepare function stands in for:

					env.DB.prepare(...)

				The Worker passes SQL into prepare(...).
				We store that SQL in preparedSql so the test can inspect it later.
			*/
			prepare(sql: string) {
				preparedSql = sql;
				prepareCount += 1;
				const preparedCall = { sql, bindings: [] as unknown[] };
				preparedCalls.push(preparedCall);

				return {
					bind(...bindings: unknown[]) {
						preparedBindings = bindings;
						preparedCall.bindings = bindings;
						return this;
					},
					/*
						This fake all function stands in for:

							env.DB.prepare(...).all()

						Real D1 returns an object with a results property.
						So this fake returns the same shape:

							{ results: rows }
					*/
					async all() {
						return { results: rows };
					},
					async first() {
						return rows[0] ?? null;
					},
				};
			},
		},
		ADMIN_IMPORT_TOKEN: "test-admin-token",
		ORIGINAL_LANGUAGE_SEARCH_ENABLED: "true",
		...envOverrides,
	} as unknown as Env;

	return {
		env,
		getPreparedSql: () => preparedSql,
		getPreparedBindings: () => preparedBindings,
		getPreparedCalls: () => preparedCalls,
		getPrepareCount: () => prepareCount,
	};
}

function createManualAdminRequest(url: string) {
	return new IncomingRequest(url, {
		method: "POST",
		headers: {
			authorization: "Bearer test-admin-token",
		},
	});
}

/*
	describe(...) groups related tests.

	This group is named "MovieApp Worker", so Vitest output tells us
	these tests belong to the Worker.
*/
describe("MovieApp Worker", () => {
	/*
		it(...) defines one test.

		This test checks the happy path:

			GET /movies

		Expected behavior:

			1. the Worker queries the movies table
			2. the Worker returns status 200
			3. the Worker returns JSON shaped like { movies: [...] }
	*/
	it("returns movies from the D1 movies table", async () => {
		/*
			These rows pretend to be rows from D1.

			Because this is a unit-style test, the database is fake.
			The point is to test our Worker code, not Cloudflare's database.
		*/
		const rows = [
			{
				id: 1,
				MovieName: "Blade Runner",
				IMDBRating: "8.1",
				IMDBVoteCounts: "850,000",
			},
		];

		const mock = createMockEnv(rows);

		/*
			This creates a fake incoming request for:

				GET http://example.com/movies

			The domain does not matter here. The important part is /movies,
			because the Worker reads url.pathname.
		*/
		const request = new IncomingRequest("http://example.com/movies");

		/*
			This line calls the Worker directly.

			In a browser test, the browser sends an HTTP request.
			In this Vitest test, we call worker.fetch(...) ourselves.

			We pass the same two values that src/index.ts currently declares:

				request
				env

			No ctx is passed because the current Worker does not use the optional
			third Cloudflare context parameter.
		*/
		const response = await worker.fetch(request, mock.env);

		/*
			expect(...) is how Vitest checks results.

			If any expect(...) line is wrong, npm test fails.
		*/
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ movies: rows });
		expect(mock.getPreparedSql()).toBe(
			"SELECT id, MovieName, IMDBRating, IMDBVoteCounts FROM movies ORDER BY id",
		);
	});

	it("returns app-shaped movie search rows", async () => {
		const rows = [
			{
				tmdb_id: 281979,
				poster_path: "/ikb6cZI8RXUqcxApMJmIdimAJ1X.jpg",
				imdb_rating: 8.8,
				imdb_vote_count: 9981,
				popularity: 12.34,
				original_language: "en",
				available_with_subscription: 1,
				available_without_rent_or_purchase: 1,
			},
		];
		const mock = createMockEnv(rows);
		const request = new IncomingRequest(
			"http://example.com/movies/search?genreIds=27&minImdbVotes=5000&pageSize=20",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			movies: [
				{
					tmdb_id: 281979,
					poster_path: "/ikb6cZI8RXUqcxApMJmIdimAJ1X.jpg",
					imdb_rating: 8.8,
					original_language: "en",
					available_with_subscription: true,
					available_without_rent_or_purchase: true,
				},
			],
			nextCursor: null,
			pageSize: 20,
			sort: "imdb",
		});
		expect(mock.getPreparedSql()).toContain(
			"FROM movie_list_items AS movie",
		);
		expect(mock.getPreparedSql()).toContain(
			"FROM movie_genres AS genre",
		);
		expect(mock.getPreparedSql()).toContain(
			"INDEXED BY idx_movie_list_items_search_imdb_v2_cover",
		);
	});

	it("calculates subscription availability for an unfiltered movie search", async () => {
		const mock = createMockEnv([]);
		const response = await worker.fetch(
			new IncomingRequest(
				"http://example.com/movies/search?pageSize=20&datePreset=last5years",
			),
			mock.env,
		);

		expect(response.status).toBe(200);
		expect(mock.getPreparedSql()).toContain(
			"FROM movie_watch_providers AS subscription_provider",
		);
		expect(mock.getPreparedSql()).toContain(
			"subscription_provider.tmdb_id = movie.tmdb_id",
		);
		expect(mock.getPreparedSql()).toContain(
			"subscription_provider.region = 'US'",
		);
		expect(mock.getPreparedSql()).toContain(
			"subscription_provider.provider_id <> -1",
		);
		expect(mock.getPreparedSql()).toContain(
			"AS available_with_subscription",
		);
		expect(mock.getPreparedSql()).toContain(
			"AS available_without_rent_or_purchase",
		);
	});

	it("uses a language-first covering index for adaptable language filtering", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://language-filter.example/movies/search?originalLanguages=KO,en,ko&pageSize=20",
		);
		const response = await worker.fetch(request, mock.env);
		const body = await response.json() as {
			originalLanguages: string[];
		};

		expect(response.status).toBe(200);
		expect(body.originalLanguages).toEqual(["en", "ko"]);
		expect(mock.getPreparedSql()).toContain(
			"INDEXED BY idx_movie_list_items_language_popularity_v2_cover",
		);
		expect(mock.getPreparedSql()).toContain(
			"movie.original_language IN (?, ?)",
		);
		expect(mock.getPreparedBindings()).toContain("en");
		expect(mock.getPreparedBindings()).toContain("ko");
	});

	it("keeps all-language search on its separate covering index", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://all-languages.example/movies/search?pageSize=20",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(mock.getPreparedSql()).toContain(
			"INDEXED BY idx_movie_list_items_search_popularity_v2_cover",
		);
		expect(mock.getPreparedSql()).not.toContain(
			"movie.original_language = ?",
		);
	});

	it("uses the language-first IMDb index for one selected language", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://language-imdb.example/movies/search?originalLanguages=ja&sort=imdb&pageSize=20",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(mock.getPreparedSql()).toContain(
			"INDEXED BY idx_movie_list_items_language_imdb_v2_cover",
		);
		expect(mock.getPreparedSql()).toContain("movie.original_language = ?");
		expect(mock.getPreparedBindings()).toContain("ja");
	});

	it("keeps unfiltered search on a retained v2 index when language search is disabled", async () => {
		const mock = createMockEnv([], {
			ORIGINAL_LANGUAGE_SEARCH_ENABLED: "false",
		});
		const response = await worker.fetch(
			new IncomingRequest(
				"http://pre-index-deploy.example/movies/search?pageSize=20",
			),
			mock.env,
		);

		expect(response.status).toBe(200);
		expect(mock.getPreparedSql()).toContain(
			"INDEXED BY idx_movie_list_items_search_popularity_v2_cover",
		);
	});

	it("rejects malformed original-language codes before querying D1", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://invalid-language.example/movies/search?originalLanguages=english",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error:
				"originalLanguages must be a comma-separated list of two- or three-letter language codes.",
		});
		expect(mock.getPrepareCount()).toBe(0);
	});

	it("returns TMDB language codes with authoritative English names", async () => {
		const mock = createMockEnv([
			{
				language_code: "en",
				english_name: "English",
				native_name: "English",
			},
			{
				language_code: "ko",
				english_name: "Korean",
				native_name: "한국어/조선말",
			},
		]);
		const request = new IncomingRequest(
			"http://language-lookup.example/movies/languages",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			languages: [
				{ code: "en", englishName: "English", nativeName: "English" },
				{
					code: "ko",
					englishName: "Korean",
					nativeName: "한국어/조선말",
				},
			],
		});
		expect(mock.getPreparedSql()).toContain(
			"FROM tmdb_original_language_lookup",
		);
	});

	it("canonicalizes language order and case in the movie-search cache key", async () => {
		const mock = createMockEnv([]);
		const firstResponse = await worker.fetch(
			new IncomingRequest(
				"http://language-cache.example/movies/search?pageSize=20&originalLanguages=KO,en",
			),
			mock.env,
		);
		const secondResponse = await worker.fetch(
			new IncomingRequest(
				"http://language-cache.example/movies/search?originalLanguages=en,ko&pageSize=20",
			),
			mock.env,
		);

		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(200);
		expect(secondResponse.headers.get("x-movieapp-cache")).toBe("HIT");
		/*
			The first request performs one small cache-generation lookup plus the
			movie search. The second request repeats only the generation lookup and
			then serves the cached movie result, so the large search runs once.
		*/
		expect(mock.getPrepareCount()).toBe(3);
		expect(mock.getPreparedSql()).toContain("FROM import_job_runs");
	});

	it("changes the Advanced Search cache generation when providers are applied", async () => {
		const mock = createMockEnv([]);

		const response = await worker.fetch(
			new IncomingRequest(
				"http://provider-cache-generation.example/movies/search?pageSize=20",
			),
			mock.env,
		);
		const generationCall = mock
			.getPreparedCalls()
			.find(({ sql }) => sql.includes("AS provider_apply_job_run_id"));

		expect(response.status).toBe(200);
		expect(generationCall?.bindings).toEqual([
			"movie-list-build",
			"movie-watch-providers-promote",
		]);
	});

	it("does not reuse an Advanced Search response saved before ads availability existed", async () => {
		const publicUrl =
			"http://response-version-cache.example/movies/search?pageSize=20";
		const oldCacheUrl = new URL(publicUrl);
		oldCacheUrl.searchParams.set(
			"__movieListBuild",
			"before-first-complete-build",
		);
		oldCacheUrl.searchParams.sort();
		await caches.default.put(
			new Request(oldCacheUrl.toString()),
			Response.json({
				movies: [
					{
						tmdb_id: 969681,
						poster_path: "/old-cache.jpg",
						imdb_rating: 8.3,
						original_language: "en",
					},
				],
				nextCursor: null,
			}),
		);

		const mock = createMockEnv([
			{
				tmdb_id: 969681,
				poster_path: "/current-result.jpg",
				imdb_rating: 8.3,
				imdb_vote_count: 2000,
				popularity: 500,
				original_language: "en",
				available_with_subscription: 0,
				available_without_rent_or_purchase: 1,
			},
		]);
		const response = await worker.fetch(
			new IncomingRequest(publicUrl),
			mock.env,
		);
		const body = await response.json() as {
			movies: Array<{
				poster_path: string;
				available_with_subscription: boolean;
				available_without_rent_or_purchase: boolean;
			}>;
		};

		expect(response.headers.get("x-movieapp-cache")).toBe("MISS");
		expect(body.movies[0]).toMatchObject({
			poster_path: "/current-result.jpg",
			available_with_subscription: false,
			available_without_rent_or_purchase: true,
		});
		expect(mock.getPreparedSql()).toContain("AS available_with_subscription");
	});

	it("returns one MovieList IMDb rating by TMDB id", async () => {
		const mock = createMockEnv([
			{
				tmdb_id: 281979,
				imdb_rating: 8.8,
			},
		]);
		const request = new IncomingRequest(
			"http://example.com/movies/281979/imdb-rating",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			tmdb_id: 281979,
			imdb_rating: 8.8,
		});
		expect(mock.getPreparedSql()).toContain("FROM movie_list_items");
		expect(mock.getPreparedSql()).toContain("WHERE tmdb_id = ?");
	});

	it("returns null when a MovieList IMDb rating is not available", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://example.com/movies/999999/imdb-rating",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			tmdb_id: 999999,
			imdb_rating: null,
		});
	});

	it("returns IMDb rating and subscription-or-ads availability as movie card data", async () => {
		const mock = createMockEnv([
			{
				imdb_rating: 8.8,
				available_with_subscription: 1,
				available_without_rent_or_purchase: 1,
			},
		]);
		const request = new IncomingRequest(
			"http://example.com/movies/281979/card-data",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			tmdb_id: 281979,
			imdb_rating: 8.8,
			available_with_subscription: true,
			available_without_rent_or_purchase: true,
		});
		expect(mock.getPreparedSql()).toContain("FROM movie_list_items");
		expect(mock.getPreparedSql()).toContain("FROM movie_watch_providers");
		expect(mock.getPreparedSql()).toContain("region = 'US'");
		expect(mock.getPreparedSql()).toContain("provider_id <> ?");
		expect(mock.getPreparedBindings()).toEqual([281979, 281979, -1, 281979]);
	});

	it("returns a confirmed rent-or-purchase answer when no viewing-option row exists", async () => {
		const mock = createMockEnv([
			{
				imdb_rating: null,
				available_with_subscription: 0,
				available_without_rent_or_purchase: 0,
			},
		]);
		const request = new IncomingRequest(
			"http://example.com/movies/999999/card-data",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			tmdb_id: 999999,
			imdb_rating: null,
			available_with_subscription: false,
			available_without_rent_or_purchase: false,
		});
	});

	it("keeps ads-only availability separate from subscription availability", async () => {
		const mock = createMockEnv([
			{
				imdb_rating: 6.8,
				available_with_subscription: 0,
				available_without_rent_or_purchase: 1,
			},
		]);
		const response = await worker.fetch(
			new IncomingRequest("http://example.com/movies/123456/card-data"),
			mock.env,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			tmdb_id: 123456,
			imdb_rating: 6.8,
			available_with_subscription: false,
			available_without_rent_or_purchase: true,
		});
	});

	it("accepts a stable current-day end date preset for movie search", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://example.com/movies/search?beginDate=2020-01-01&endDatePreset=today&pageSize=20",
		);
		const response = await worker.fetch(request, mock.env);
		const body = await response.json() as {
			beginDate: string;
			endDate: string;
			endDatePreset: string | null;
		};

		expect(response.status).toBe(200);
		expect(body.beginDate).toBe("2020-01-01");
		expect(body.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(body.endDatePreset).toBe("today");
	});

	it("supports any US flatrate provider filtering for movie search", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://example.com/movies/search?pageSize=20&datePreset=last5years&watchMonetizationTypes=flatrate",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(200);
		expect(mock.getPreparedSql()).toContain(
			"FROM movie_watch_providers AS provider",
		);
		expect(mock.getPreparedSql()).toContain("provider.region = 'US'");
		expect(mock.getPreparedSql()).toContain("provider.provider_id <> -1");
		expect(mock.getPreparedSql()).not.toContain("provider.provider_id IN");
		expect(mock.getPreparedSql()).toContain(
			"1 AS available_with_subscription",
		);
		expect(mock.getPreparedSql()).not.toContain(
			"movie_watch_providers AS subscription_provider",
		);
	});

	it("does not allow the internal ads marker to be selected as a streamer", async () => {
		const mock = createMockEnv([]);
		const response = await worker.fetch(
			new IncomingRequest(
				"http://example.com/movies/search?pageSize=20&providerIds=-1",
			),
			mock.env,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "providerIds must contain positive TMDb provider IDs.",
		});
	});

	it("parses import job result_json for monitor responses", async () => {
		const mock = createMockEnv([
			{
				job_run_id: "tmdb-genre-lookup-refresh-manual-test",
				job_name: "tmdb-genre-lookup-refresh",
				status: "complete",
				trigger: "manual",
				selected_count: 19,
				queued_count: 0,
				processed_count: 19,
				updated_count: 19,
				error_count: 0,
				provider_rows_inserted: 0,
				started_at: "2026-05-18 00:43:39",
				last_progress_at: "2026-05-18 00:43:40",
				ended_at: "2026-05-18 00:43:40",
				duration_ms: 999,
				last_error: null,
				result_json:
					'{"jobRunId":"tmdb-genre-lookup-refresh-manual-test","notificationEmailMessageId":"message@test.example"}',
				notification_sent_at: "2026-05-18 00:43:42",
				notification_error: null,
			},
		]);
		const request = new IncomingRequest(
			"http://example.com/admin/import/job-runs?jobName=tmdb-genre-lookup-refresh&limit=1",
		);
		const response = await worker.fetch(request, mock.env);
		const body = (await response.json()) as {
			runs: Array<{ result_json: unknown }>;
		};

		expect(response.status).toBe(200);
		expect(body.runs[0].result_json).toEqual({
			jobRunId: "tmdb-genre-lookup-refresh-manual-test",
			notificationEmailMessageId: "message@test.example",
		});
	});

	it("summarizes the latest scheduled main jobs in production order", async () => {
		const mock = createMockEnv([
			{
				job_name: "weekly-import-validation",
				status: "complete",
				selected_count: 10,
				processed_count: 10,
				error_count: 0,
				started_at: "2026-06-22 15:00:46",
				ended_at: "2026-06-22 15:00:48",
				duration_ms: 2000,
			},
			{
				job_name: "cache-warm-search",
				status: "complete_with_errors",
				selected_count: 3024,
				processed_count: 3024,
				error_count: 1,
				started_at: "2026-06-22 13:00:46",
				ended_at: "2026-06-22 13:41:09",
				duration_ms: 2422999,
			},
			{
				job_name: "movie-list-build",
				status: "complete",
				selected_count: 599,
				processed_count: 599,
				error_count: 0,
				started_at: "2026-06-22 12:00:45",
				ended_at: "2026-06-22 12:01:32",
				duration_ms: 46999,
			},
			{
				job_name: "tmdb-provider-refresh",
				status: "complete",
				selected_count: 82511,
				processed_count: 82511,
				error_count: 0,
				started_at: "2026-06-22 07:00:55",
				ended_at: "2026-06-22 08:04:42",
				duration_ms: 3827000,
			},
			{
				job_name: "tmdb-new-movie-details",
				status: "complete",
				selected_count: 604,
				processed_count: 604,
				error_count: 0,
				started_at: "2026-06-22 05:00:47",
				ended_at: "2026-06-22 05:01:07",
				duration_ms: 20000,
			},
			{
				job_name: "tmdb-primary",
				status: "complete",
				selected_count: 677,
				processed_count: 677,
				error_count: 0,
				started_at: "2026-06-22 03:00:46",
				ended_at: "2026-06-22 03:00:58",
				duration_ms: 12000,
			},
			{
				job_name: "imdb-ratings",
				status: "complete",
				selected_count: 1683289,
				processed_count: 1683289,
				error_count: 0,
				started_at: "2026-06-22 01:00:58",
				ended_at: "2026-06-22 01:11:50",
				duration_ms: 652000,
			},
		]);
		const request = new IncomingRequest(
			"http://example.com/admin/import/last-job-runs-summary",
		);
		const response = await worker.fetch(request, mock.env);
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(Object.keys(body)).toEqual([
			"IMDB",
			"Primary",
			"Primary Enhanced",
			"Watch Providers",
			"Popularity",
			"Movie Table",
			"Cache Warming",
			"Final Validation",
		]);
		expect(body.IMDB).toEqual({
			Timing: {
				Started_At: "SUNDAY - 6/21/2026 9:00:58 PM EDT",
				Ended_At: "SUNDAY - 6/21/2026 9:11:50 PM EDT",
				Duration: "10 minutes 52 seconds",
			},
			Status: "complete",
			Work_Counts: {
				Selected: 1683289,
				Processed: 1683289,
				Errors: 0,
			},
		});
		expect(body["Watch Providers"]).toMatchObject({
			Timing: {
				Duration: "1 hour 3 minutes 47 seconds",
			},
		});
		expect(body["Cache Warming"]).toEqual({
			Timing: {
				Started_At: "MONDAY - 6/22/2026 9:00:46 AM EDT",
				Ended_At: "MONDAY - 6/22/2026 9:41:09 AM EDT",
				Duration: "40 minutes 23 seconds",
			},
			Status: "complete_with_errors",
			Work_Counts: {
				Selected: 3024,
				Processed: 3024,
				Errors: 1,
			},
		});
		expect(mock.getPreparedSql()).toContain("WHERE trigger = 'cron'");
		expect(mock.getPreparedSql()).toContain("ROW_NUMBER() OVER");
	});

	it("requires POST for manual admin import endpoints", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://example.com/admin/import/tmdb/new-primary-manual",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
		expect(await response.json()).toEqual({
			error: "Access not permitted",
		});
	});

	it("uses the same public response for missing or wrong manual admin tokens", async () => {
		const missingTokenMock = createMockEnv([]);
		delete (missingTokenMock.env as { ADMIN_IMPORT_TOKEN?: string })
			.ADMIN_IMPORT_TOKEN;

		const missingTokenResponse = await worker.fetch(
			createManualAdminRequest(
				"http://example.com/admin/import/tmdb/new-primary-manual",
			),
			missingTokenMock.env,
		);

		expect(missingTokenResponse.status).toBe(500);
		expect(await missingTokenResponse.json()).toEqual({
			error: "Access not permitted",
		});

		const wrongTokenMock = createMockEnv([]);
		const wrongTokenRequest = new IncomingRequest(
			"http://example.com/admin/import/tmdb/new-primary-manual",
			{
				method: "POST",
				headers: {
					authorization: "Bearer wrong-token",
				},
			},
		);
		const wrongTokenResponse = await worker.fetch(
			wrongTokenRequest,
			wrongTokenMock.env,
		);

		expect(wrongTokenResponse.status).toBe(401);
		expect(wrongTokenResponse.headers.get("www-authenticate")).toBe(
			"Bearer",
		);
		expect(await wrongTokenResponse.json()).toEqual({
			error: "Access not permitted",
		});
	});

	it("rejects query strings on the normal TMDB primary manual endpoint", async () => {
		const mock = createMockEnv([]);
		const request = createManualAdminRequest(
			"http://example.com/admin/import/tmdb/new-primary-manual?limit=100",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error:
				"new-primary-manual does not accept beginDate, endDate, or limit. Use limited-primary-manual for explicit ranges.",
		});
	});

	it("rejects query strings on TMDB lookup refresh manual endpoints", async () => {
		const mock = createMockEnv([]);

		const genreResponse = await worker.fetch(
			createManualAdminRequest(
				"http://example.com/admin/import/tmdb/genre-lookup-refresh-manual?language=en-US",
			),
			mock.env,
		);
		const providerResponse = await worker.fetch(
			createManualAdminRequest(
				"http://example.com/admin/import/tmdb/watch-provider-lookup-refresh-manual?region=US",
			),
			mock.env,
		);
		const languageResponse = await worker.fetch(
			createManualAdminRequest(
				"http://example.com/admin/import/tmdb/language-lookup-refresh-manual?language=en-US",
			),
			mock.env,
		);
		const backfillResponse = await worker.fetch(
			createManualAdminRequest(
				"http://example.com/admin/import/tmdb/original-language-backfill-manual?limit=20",
			),
			mock.env,
		);

		expect(genreResponse.status).toBe(400);
		expect(await genreResponse.json()).toEqual({
			error:
				"genre-lookup-refresh-manual does not accept query parameters. It refreshes the en-US TMDB movie genre lookup table.",
		});
		expect(providerResponse.status).toBe(400);
		expect(await providerResponse.json()).toEqual({
			error:
				"watch-provider-lookup-refresh-manual does not accept query parameters. It refreshes the US TMDB watch-provider lookup table.",
		});
		expect(languageResponse.status).toBe(400);
		expect(await languageResponse.json()).toEqual({
			error:
				"language-lookup-refresh-manual does not accept query parameters. It refreshes TMDB's original-language names.",
		});
		expect(backfillResponse.status).toBe(400);
		expect(await backfillResponse.json()).toEqual({
			error:
				"original-language-backfill-manual does not accept query parameters. It safely fills only original_language for existing movie IDs.",
		});
	});

	it("rejects malformed popularity source dates before starting an import", async () => {
		const mock = createMockEnv([]);
		const request = createManualAdminRequest(
			"http://example.com/admin/import/tmdb/popularity-refresh-manual?sourceDate=07-31-2026",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "sourceDate must use YYYY-MM-DD format.",
		});
	});

	it("rejects a Movie List popularity override that is not a popularity job ID", async () => {
		const mock = createMockEnv([]);
		const request = createManualAdminRequest(
			"http://example.com/admin/import/movie-list/rebuild-manual?runDate=2026-07-27&popularityRunId=imdb-ratings-cron-123",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error:
				"popularityRunId must identify a tmdb-popularity-refresh job run.",
		});
	});

	it("rejects a Movie List IMDb override that is not an IMDb job ID", async () => {
		const mock = createMockEnv([]);
		const request = createManualAdminRequest(
			"http://example.com/admin/import/movie-list/rebuild-manual?runDate=2026-07-27&imdbRunId=tmdb-primary-cron-123",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "imdbRunId must identify an imdb-ratings job run.",
		});
	});

	it("rejects an invalid weekly validation date before querying job status", async () => {
		const mock = createMockEnv([]);
		const response = await worker.fetch(
			createManualAdminRequest(
				"http://example.com/admin/import/weekly-validation-manual?runDate=July-27",
			),
			mock.env,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "runDate must use YYYY-MM-DD format.",
		});
		expect(mock.getPrepareCount()).toBe(0);
	});

	it("requires an explicit limit on the limited TMDB primary manual endpoint", async () => {
		const mock = createMockEnv([]);
		const request = createManualAdminRequest(
			"http://example.com/admin/import/tmdb/limited-primary-manual?beginDate=2000-01-01&endDate=2000-12-31",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "limit is required and must be a positive integer.",
		});
	});

	it("does not keep the old TMDB primary load-manual route", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://example.com/admin/import/tmdb/load-manual?limit=100&beginDate=2000-01-01&endDate=2000-12-31",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found." });
	});

	/*
		This test checks the fallback route.

		If someone asks for:

			/

		instead of:

			/movies

		the Worker should return 404.
	*/
	it("returns not found for routes other than /movies", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest("http://example.com/");
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found." });
	});
});
