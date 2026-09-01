/**
 * Run an explicit missing-ID scenario from either mobile simulator.
 * Supply the real Streaming Availability key through stdin, never an argument.
 * Only Marriage Story is accepted, with at most two live backup requests per run.
 * All D1 data is temporary; no production database or Worker is changed.
 */
import { build } from 'esbuild';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const apiKey = Buffer.concat(chunks).toString('utf8').trim();
if (!apiKey || /\s/.test(apiKey)) throw new Error('Supply one API key through stdin.');

const compiled = await build({
	entryPoints: [`${root}test/manual/streamingFallback.worker.ts`],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
});

const counters = { mockedTmdb: 0, mockedWikidataWithoutNetflixId: 0, realBackupRequests: 0 };
const results = [];
let round = 1;
let activeRequests = 0;
const runtime = new Miniflare({
	modules: true,
	script: compiled.outputFiles[0].text,
	compatibilityDate: '2026-08-01',
	host: '127.0.0.1',
	port: 0,
	d1Databases: { DB: 'netflix-fallback-manual-test-only' },
	bindings: {
		TMDB_API_KEY: 'mock-primary-test-key',
		STREAMING_AVAILABILITY_API_KEY: apiKey,
		STREAMING_AVAILABILITY_MONTHLY_LIMIT: '2',
	},
	outboundService: async (request) => {
		const url = new URL(request.url);
		if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/movie/492188/external_ids') {
			counters.mockedTmdb++;
			return WorkerResponse.json({ id: 492188, wikidata_id: 'Q48671199' });
		}
		if (url.hostname === 'www.wikidata.org' && url.searchParams.get('ids') === 'Q48671199') {
			counters.mockedWikidataWithoutNetflixId++;
			// P4947 identifies the movie. Deliberately omit P1874 (Netflix ID).
			return WorkerResponse.json({
				entities: {
					Q48671199: {
						claims: {
							P4947: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: '492188' } } }],
						},
					},
				},
			});
		}
		if (url.origin === 'https://api.movieofthenight.com' && url.pathname === '/v4/shows/movie/492188') {
			if (counters.realBackupRequests >= 2) return new WorkerResponse('Manual test request limit reached.', { status: 429 });
			counters.realBackupRequests++;
			// This is the only real upstream. Never follow a redirect with the key.
			const response = await fetch(url, {
				headers: { accept: 'application/json', 'X-API-Key': request.headers.get('X-API-Key') },
				redirect: 'manual',
				signal: AbortSignal.timeout(5000),
			});
			console.log(JSON.stringify({ event: 'manual-fallback-live-api', round, status: response.status }));
			return new WorkerResponse(await response.arrayBuffer(), { status: response.status, headers: response.headers });
		}
		return new WorkerResponse('Unexpected upstream blocked by manual test.', { status: 502 });
	},
});

const db = await runtime.getD1Database('DB');
const migration = (
	await Promise.all(
		['0029_add_streaming_link_resolver.sql', '0030_add_subscription_route_links.sql'].map((name) =>
			readFile(root + 'migrations/' + name, 'utf8')
		)
	)
).join('\n');
const statements = migration
	.replace(/^--.*$/gm, '')
	.split(';')
	.map((sql) => sql.trim())
	.filter(Boolean);
await db.batch(statements.map((sql) => db.prepare(sql)));

async function status() {
	return {
		round,
		...counters,
		results,
		storedMappings: await db.prepare('SELECT COUNT(*) AS count FROM movie_streaming_route_links').first('count'),
		storedCandidates: await db.prepare('SELECT COUNT(*) AS count FROM streaming_link_candidates').first('count'),
		budget: (await db.prepare('SELECT period, requests FROM streaming_api_budget').all()).results,
	};
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', 'http://127.0.0.1:8789');
	response.setHeader('content-type', 'application/json');
	response.setHeader('cache-control', 'no-store');
	try {
		if (request.method === 'GET' && url.pathname === '/__test/status') {
			response.end(JSON.stringify(await status()));
			return;
		}
		if (request.method === 'POST' && url.pathname === '/__test/reset' && activeRequests === 0) {
			// Reset only this process's disposable database, between simulator runs.
			await db.batch(
				[
					'movie_streaming_links',
					'movie_streaming_route_links',
					'streaming_link_candidates',
					'streaming_link_lookups',
					'streaming_api_budget',
				].map((table) => db.prepare(`DELETE FROM ${table}`))
			);
			round++;
			response.end(JSON.stringify(await status()));
			return;
		}
		if (request.method !== 'GET' || url.pathname !== '/streaming-link' || url.searchParams.get('tmdbId') !== '492188') {
			response.writeHead(404).end(JSON.stringify({ error: 'This isolated test accepts only Marriage Story.' }));
			return;
		}
		activeRequests++;
		try {
			const resolved = await runtime.dispatchFetch(url);
			const body = await resolved.json();
			results.push({ round, ...body });
			console.log(JSON.stringify({ event: 'manual-fallback-result', round, ...body }));
			response.writeHead(resolved.status).end(JSON.stringify(body));
		} finally {
			activeRequests--;
		}
	} catch {
		// Never emit raw errors that could include request headers or the API key.
		response.writeHead(500).end(JSON.stringify({ error: 'Manual fallback test failed; inspect sanitized resolver logs.' }));
	}
});

server.listen(8789, '127.0.0.1', () =>
	console.log('Isolated fallback test ready on http://127.0.0.1:8789; primary Netflix ID is deliberately missing.')
);
async function stop() {
	server.close();
	await runtime.dispose();
	process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
