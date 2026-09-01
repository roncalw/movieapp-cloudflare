/**
 * Deliberately remove every primary provider ID, then call the real backup API
 * through the production resolver. stdin supplies the key; all storage is an
 * isolated, temporary D1 database. Never run this automatically in CI.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const key = Buffer.concat(chunks).toString('utf8').trim();
if (!key || /\s/.test(key)) throw new Error('Supply the API key on stdin.');
const cases = [
	[8, 492188],
	[15, 24428],
	[9, 687163],
	[1899, 155],
	[337, 862],
	[350, 911430],
	[387, 49018],
	[526, 938614],
	[531, 361743],
];
const allowed = new Set(cases.map(([, id]) => id));
const counters = { tmdb: 0, wikidata: 0, backup: 0 };
const compiled = await build({
	entryPoints: [root + 'test/manual/streamingFallback.worker.ts'],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
});
const runtime = new Miniflare({
	modules: true,
	script: compiled.outputFiles[0].text,
	compatibilityDate: '2026-08-01',
	d1Databases: { DB: 'all-provider-fallback-test-only' },
	bindings: { TMDB_API_KEY: 'mock-primary-key', STREAMING_AVAILABILITY_API_KEY: key, STREAMING_AVAILABILITY_MONTHLY_LIMIT: '9' },
	outboundService: async (request) => {
		const url = new URL(request.url);
		const tmdbId = Number(url.pathname.match(/\/movie\/(\d+)/)?.[1]);
		if (url.hostname === 'api.themoviedb.org' && allowed.has(tmdbId)) {
			counters.tmdb++;
			return WorkerResponse.json({ id: tmdbId, wikidata_id: 'Q' + tmdbId });
		}
		if (url.hostname === 'www.wikidata.org') {
			const q = url.searchParams.get('ids');
			const id = Number(q?.slice(1));
			if (!allowed.has(id)) return new WorkerResponse('Blocked', { status: 502 });
			counters.wikidata++;
			return WorkerResponse.json({
				entities: { [q]: { claims: { P4947: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: String(id) } } }] } } },
			});
		}
		if (url.origin === 'https://api.movieofthenight.com' && allowed.has(tmdbId) && counters.backup < 9) {
			counters.backup++;
			const response = await fetch(url, { headers: { 'X-API-Key': key }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
			return new WorkerResponse(await response.arrayBuffer(), { status: response.status, headers: response.headers });
		}
		return new WorkerResponse('Unexpected upstream blocked', { status: 502 });
	},
});
try {
	const db = await runtime.getD1Database('DB');
	const sql = (
		await Promise.all(
			['0029_add_streaming_link_resolver.sql', '0030_add_subscription_route_links.sql'].map((name) =>
				readFile(root + 'migrations/' + name, 'utf8')
			)
		)
	).join('\n');
	await db.batch(
		sql
			.replace(/^--.*$/gm, '')
			.split(';')
			.map((x) => x.trim())
			.filter(Boolean)
			.map((x) => db.prepare(x))
	);
	const results = [];
	for (const [providerId, tmdbId] of cases) {
		// The previous movie may have cached this provider, but this distinct movie
		// must still exercise a cold lookup followed by a cache-only second tap.
		const url = `http://localhost/streaming-link?tmdbId=${tmdbId}&providerId=${providerId}&region=US`;
		const cold = await (await runtime.dispatchFetch(url)).json();
		assert.equal(cold.resolved, true, JSON.stringify(cold));
		assert.equal(cold.source, 'streaming-availability');
		assert.equal(cold.cacheHit, false);
		const before = { ...counters };
		const cached = await (await runtime.dispatchFetch(url)).json();
		assert.equal(cached.cacheHit, true);
		assert.deepEqual(counters, before);
		assert.equal(cold.webUrl, cached.webUrl);
		results.push({ cold, cached });
		console.log(JSON.stringify({ provider: cold.provider, tmdbId, result: 'real fallback + D1 repeat passed' }));
	}
	// Toy Story's lookup also learns its Hulu link at no additional cost.
	const before = { ...counters };
	const shared = await (await runtime.dispatchFetch('http://localhost/streaming-link?tmdbId=862&providerId=15&region=US')).json();
	assert.equal(shared.resolved, true);
	assert.equal(shared.cacheHit, true);
	assert.deepEqual(counters, before);
	assert.deepEqual(counters, { tmdb: 9, wikidata: 9, backup: 9 });
	const evidence = {
		checkedAt: new Date().toISOString(),
		primaryIdsDeliberatelyMissing: true,
		counters,
		results,
		shared,
		storedMappings: await db.prepare('SELECT COUNT(*) AS count FROM movie_streaming_route_links').first('count'),
	};
	await writeFile(
		root + '.codex/verification/all-provider-streaming-links/forced-fallback-results.json',
		JSON.stringify(evidence, null, 2) + '\n'
	);
	console.log(JSON.stringify({ result: 'PASS', ...counters, storedMappings: evidence.storedMappings }));
} finally {
	await runtime.dispose();
}
