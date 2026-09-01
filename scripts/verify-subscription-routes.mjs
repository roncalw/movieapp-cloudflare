/**
 * Manual verification only: two real backup requests, no primary provider IDs,
 * and an isolated D1 database. The Hulu/Disney route uses a fictional TMDB ID
 * because TMDB does not currently publish that route. stdin supplies the key.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const key = Buffer.concat(input).toString('utf8').trim();
assert(key && !/\s/.test(key), 'Supply the existing key on stdin.');
const cases = [
	[938614, [526, 528, 1854, 635, 204, 2049, 15, 999001]],
	[936075, [43, 1794, 1855, 634]],
];
const allowed = new Set(cases.map(([id]) => id));
const counts = { tmdb: 0, wikidata: 0, backup: 0 };
const responses = [];
const output = root + '.codex/verification/subscription-routes/';
await mkdir(output, { recursive: true });
const compiled = await build({
	stdin: {
		resolveDir: root,
		contents: `
      import { resolveStreamingLink } from './src/streaming/streamingLinkResolver';
      import { subscriptionRoutes, huluDisneyRouteTemplate } from './src/streaming/subscriptionRoutes';
      const mockCatalog = [...subscriptionRoutes, { ...huluDisneyRouteTemplate, tmdbProviderId: 999001 }];
      export default { async fetch(request, env) {
        const p = new URL(request.url).searchParams;
        return Response.json(await resolveStreamingLink(env, {
          tmdbId: Number(p.get('tmdbId')), providerId: Number(p.get('providerId')), region: 'US'
        }, mockCatalog));
      }};`,
	},
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
	d1Databases: { DB: 'subscription-routes-isolated-verification' },
	bindings: { TMDB_API_KEY: 'mock-primary', STREAMING_AVAILABILITY_API_KEY: key, STREAMING_AVAILABILITY_MONTHLY_LIMIT: '2' },
	outboundService: async (request) => {
		const url = new URL(request.url);
		const tmdbId = Number(url.pathname.match(/\/movie\/(\d+)/)?.[1]);
		if (url.hostname === 'api.themoviedb.org' && allowed.has(tmdbId)) {
			counts.tmdb++;
			return WorkerResponse.json({ id: tmdbId, wikidata_id: 'Q' + tmdbId });
		}
		if (url.hostname === 'www.wikidata.org') {
			counts.wikidata++;
			const q = url.searchParams.get('ids');
			assert(allowed.has(Number(q?.slice(1))));
			return WorkerResponse.json({ entities: { [q]: { claims: {} } } });
		}
		if (url.origin === 'https://api.movieofthenight.com' && allowed.has(tmdbId) && counts.backup < 2) {
			counts.backup++;
			const response = await fetch(url, { headers: { 'X-API-Key': key }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
			const body = await response.json();
			if (response.ok) responses.push(body);
			return WorkerResponse.json(body, { status: response.status });
		}
		return new WorkerResponse('Unexpected upstream blocked', { status: 502 });
	},
});
const results = [];
try {
	const db = await runtime.getD1Database('DB');
	for (const file of ['0029_add_streaming_link_resolver.sql', '0030_add_subscription_route_links.sql']) {
		const sql = await readFile(root + 'migrations/' + file, 'utf8');
		await db.batch(
			sql
				.replace(/^--.*$/gm, '')
				.split(';')
				.map((s) => s.trim())
				.filter(Boolean)
				.map((s) => db.prepare(s))
		);
	}
	for (const [tmdbId, providers] of cases) {
		for (const providerId of providers) {
			const url = `http://localhost/streaming-link?tmdbId=${tmdbId}&providerId=${providerId}`;
			const result = await (await runtime.dispatchFetch(url)).json();
			results.push(result);
			assert.equal(result.resolved, true, JSON.stringify(result));
			assert.equal(result.source, 'streaming-availability');
			const before = { ...counts };
			const cached = await (await runtime.dispatchFetch(url)).json();
			assert.equal(cached.cacheHit, true);
			assert.equal(cached.webUrl, result.webUrl);
			assert.deepEqual(counts, before);
			console.log(
				JSON.stringify({
					tmdbId,
					providerId,
					platform: result.playbackPlatform,
					category: result.subscriptionCategory,
					result: 'fallback and isolated D1 passed',
				})
			);
		}
	}
	assert.equal(counts.backup, 2);
	const rows = await db
		.prepare(
			'SELECT tmdb_id, tmdb_provider_id, provider_key, subscription_category, playback_platform, provider_content_id FROM movie_streaming_route_links WHERE region = ? ORDER BY tmdb_id, tmdb_provider_id'
		)
		.bind('US')
		.all();
	await writeFile(
		output + 'forced-route-fallbacks.json',
		JSON.stringify({ checkedAt: new Date().toISOString(), mockHuluProviderId: 999001, counts, results, rows: rows.results }, null, 2)
	);
} finally {
	await writeFile(output + 'live-route-api-shows.json', JSON.stringify(responses, null, 2));
	await writeFile(output + 'route-results.json', JSON.stringify(results, null, 2));
	await runtime.dispose();
}
