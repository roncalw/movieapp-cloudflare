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
function createMockEnv(rows: unknown[]) {
	/*
		This variable remembers the SQL string that the Worker sends to D1.

		Later in the test, we check it with expect(...).toBe(...).
		That proves the Worker asked for the columns we expect.
	*/
	let preparedSql = "";

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

				return {
					bind() {
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
				};
			},
		},
	} as unknown as Env;

	return {
		env,
		getPreparedSql: () => preparedSql,
	};
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
		expect(mock.getPreparedSql()).not.toContain("provider.provider_id IN");
	});

	it("rejects query strings on the normal TMDB primary manual endpoint", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
			"http://example.com/admin/import/tmdb/new-primary-manual?limit=100",
		);
		const response = await worker.fetch(request, mock.env);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error:
				"new-primary-manual does not accept beginDate, endDate, or limit. Use limited-primary-manual for explicit ranges.",
		});
	});

	it("requires an explicit limit on the limited TMDB primary manual endpoint", async () => {
		const mock = createMockEnv([]);
		const request = new IncomingRequest(
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
