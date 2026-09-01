import { env as testEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import legacyMigration from '../migrations/0029_add_streaming_link_resolver.sql?raw';
import routeMigration from '../migrations/0030_add_subscription_route_links.sql?raw';
const migration = legacyMigration + '\n' + routeMigration;
import { handleFetch } from '../src/httpRouting/httpRoutes';
import { parseStreamingLinkRequest } from '../src/httpRouting/streamingLink';
import { netflixAdapter, netflixIdFromWikidata, streamingCandidates } from '../src/streaming/providerAdapters';
import { reserveStreamingRequest, resolveStreamingLink } from '../src/streaming/streamingLinkResolver';
import type { Env } from '../src/shared/types';

const request = { tmdbId: 492188, providerId: 8, region: 'US' };
const env = { DB: testEnv.DB, TMDB_API_KEY: 'test-tmdb-key', STREAMING_AVAILABILITY_API_KEY: 'test-streaming-key' } as Env;
const claim = (value: string, rank = 'normal') => ({ rank, mainsnak: { snaktype: 'value', datavalue: { value } } });
const wiki = (ids = ['80223779']) => ({
	entities: { Q48671199: { claims: { P1874: ids.map((id) => claim(id)), P4947: [claim('492188')] } } },
});
const option = (provider = 'netflix', link = 'https://www.netflix.com/title/80223779', type = 'subscription') => ({
	service: { id: provider },
	link,
	type,
});
const backup = (us: unknown[] = [option()]) => ({ showType: 'movie', tmdbId: 'movie/492188', streamingOptions: { us } });

function mockUpstreams(
	options: { noWiki?: boolean; wikiBody?: unknown; backupBody?: unknown; backupStatus?: number; tmdbStatus?: number } = {}
) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === 'api.themoviedb.org')
			return Response.json({ id: 492188, wikidata_id: options.noWiki ? null : 'Q48671199' }, { status: options.tmdbStatus ?? 200 });
		if (url.hostname === 'www.wikidata.org') return Response.json(options.wikiBody ?? wiki());
		if (url.hostname === 'api.movieofthenight.com')
			return Response.json(options.backupBody ?? backup(), { status: options.backupStatus ?? 200 });
		throw new Error('Unexpected upstream.');
	});
}

function backupCalls(fetchSpy: ReturnType<typeof mockUpstreams>) {
	return fetchSpy.mock.calls.filter(([input]) => String(input).includes('api.movieofthenight.com'));
}

beforeEach(async () => {
	// Execute the actual migration in the test runner's isolated D1 database.
	// Production bindings are never contacted by these tests.
	await testEnv.DB.batch(
		[
			'movie_streaming_route_links',
			'movie_streaming_links',
			'streaming_link_candidates',
			'streaming_link_lookups',
			'streaming_api_budget',
		].map((table) => testEnv.DB.prepare(`DROP TABLE IF EXISTS ${table}`))
	);
	const sql = migration
		.replace(/^--.*$/gm, '')
		.split(';')
		.map((value) => value.trim())
		.filter(Boolean);
	await testEnv.DB.batch(sql.map((statement) => testEnv.DB.prepare(statement)));
});

afterEach(() => vi.restoreAllMocks());

describe('Netflix destination validation', () => {
	it('builds exact native and browser title URLs', () => {
		expect(netflixAdapter.buildUrls('80223779')).toEqual({
			webUrl: 'https://www.netflix.com/title/80223779',
			nativeUrl: 'nflx://www.netflix.com/watch/80223779',
		});
		expect(() => netflixAdapter.buildUrls('80223779/../1')).toThrow();
	});

	it('extracts IDs from verified Netflix title/watch links only', () => {
		for (const url of [
			'https://www.netflix.com/title/80223779',
			'https://netflix.com/watch/80223779?trackId=1',
			'https://www.netflix.com/jp-en/title/80223779',
		]) {
			expect(netflixAdapter.parseUrl(url)).toBe('80223779');
		}
		for (const url of [
			'http://www.netflix.com/title/80223779',
			'https://netflix.com.evil.example/title/80223779',
			'https://netflix.com@evil.example/title/80223779',
			'https://user:pass@netflix.com/title/80223779',
			'https://netflix.com:444/title/80223779',
			'https://netflix.com/search?q=80223779',
			'https://netflix.com/title/80223779/episode/1',
		]) {
			expect(netflixAdapter.parseUrl(url)).toBeNull();
		}
	});

	it('rejects conflicting, deprecated, qualified, or cross-movie Wikidata IDs', () => {
		expect(netflixIdFromWikidata(wiki(['80223779', '80000001']), 'Q48671199', 492188)).toBeNull();
		expect(netflixIdFromWikidata(wiki(), 'Q48671199', 123)).toBeNull();
		const payload = wiki();
		payload.entities.Q48671199.claims.P1874 = [claim('80223779', 'deprecated')];
		expect(netflixIdFromWikidata(payload, 'Q48671199', 492188)).toBeNull();
		const qualified = { entities: { Q48671199: { claims: { P1874: [{ ...claim('80223779'), qualifiers: { P518: [{}] } }] } } } };
		expect(netflixIdFromWikidata(qualified, 'Q48671199', 492188)).toBeNull();
	});

	it('uses a unique preferred statement and deduplicates identical claims', () => {
		const payload = wiki();
		payload.entities.Q48671199.claims.P1874 = [claim('80223779', 'preferred'), claim('80000001')];
		expect(netflixIdFromWikidata(payload, 'Q48671199', 492188)).toBe('80223779');
		expect(netflixIdFromWikidata(wiki(['80223779', '80223779']), 'Q48671199', 492188)).toBe('80223779');
	});

	it('rejects backup responses for TV series or the wrong TMDB movie', () => {
		expect(() => streamingCandidates({ ...backup(), showType: 'series' }, 492188)).toThrow();
		expect(() => streamingCandidates({ ...backup(), tmdbId: 'movie/123' }, 492188)).toThrow();
	});
});

describe('resolver order and persistent D1 behavior', () => {
	it('returns a D1 hit without contacting any upstream', async () => {
		await testEnv.DB.prepare(
			`INSERT INTO movie_streaming_links VALUES (492188, 8, 'netflix', 'US', '80223779', 'ignored stored URL', NULL, 'wikidata', '2026-08-31T00:00:00Z')`
		).run();
		const fetchSpy = mockUpstreams();
		expect(await resolveStreamingLink(env, request)).toMatchObject({
			resolved: true,
			providerContentId: '80223779',
			cacheHit: true,
			webUrl: 'https://www.netflix.com/title/80223779',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('resolves through TMDB then Wikidata, stores the mapping, and never spends backup quota', async () => {
		const fetchSpy = mockUpstreams();
		expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: true, source: 'wikidata', cacheHit: false });
		expect(String(fetchSpy.mock.calls[0][0])).toContain('/movie/492188/external_ids');
		expect(String(fetchSpy.mock.calls[1][0])).toContain('ids=Q48671199');
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(await resolveStreamingLink(env, request)).toMatchObject({ cacheHit: true });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM streaming_api_budget').first('count')).toBe(0);
	});

	it('uses one backup call when Wikidata has no Netflix ID and caches every country', async () => {
		const fetchSpy = mockUpstreams({
			wikiBody: wiki([]),
			backupBody: {
				...backup(),
				streamingOptions: { us: [option(), option('hulu', 'https://www.hulu.com/movie/example')], ca: [option()] },
			},
		});
		expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: true, source: 'streaming-availability' });
		expect(backupCalls(fetchSpy)).toHaveLength(1);
		expect(String(backupCalls(fetchSpy)[0][0])).toBe('https://api.movieofthenight.com/v4/shows/movie/492188');
		expect(backupCalls(fetchSpy)[0][1]?.headers).toMatchObject({ 'X-API-Key': 'test-streaming-key' });
		expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM streaming_link_candidates').first('count')).toBe(3);
		expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM movie_streaming_route_links').first('count')).toBe(4);
		fetchSpy.mockClear();
		expect(await resolveStreamingLink(env, { ...request, region: 'CA', providerId: 1796 })).toMatchObject({
			resolved: true,
			cacheHit: true,
			region: 'CA',
			providerId: 1796,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('skips Wikidata when TMDB supplies no Wikidata ID', async () => {
		const fetchSpy = mockUpstreams({ noWiki: true });
		expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: true, source: 'streaming-availability' });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it('still reaches the backup after a TMDB outage', async () => {
		const fetchSpy = mockUpstreams({ tmdbStatus: 503 });
		expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: true, source: 'streaming-availability' });
		expect(backupCalls(fetchSpy)).toHaveLength(1);
	});

	it('remembers a Netflix miss even if another provider was found', async () => {
		const fetchSpy = mockUpstreams({ noWiki: true, backupBody: backup([option('hulu', 'https://www.hulu.com/movie/example')]) });
		for (let attempt = 0; attempt < 3; attempt++)
			expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: false, reason: 'no_match' });
		expect(backupCalls(fetchSpy)).toHaveLength(1);
	});

	it('does not return another country or an add-on/rental as a direct Netflix subscription', async () => {
		mockUpstreams({
			noWiki: true,
			backupBody: {
				...backup(),
				streamingOptions: {
					ca: [option()],
					us: [option('netflix', 'https://www.netflix.com/title/80223779', 'rent'), { ...option(), addon: { id: 'different-package' } }],
				},
			},
		});
		expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: false, reason: 'no_match' });
	});

	it('does not call upstream for an unconfigured provider', async () => {
		const fetchSpy = mockUpstreams();
		expect(await resolveStreamingLink(env, { ...request, providerId: 999999 })).toMatchObject({
			resolved: false,
			reason: 'unsupported_provider',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('fails safely without a backup key while preserving the Wikidata path', async () => {
		mockUpstreams({ noWiki: true });
		expect(await resolveStreamingLink({ ...env, STREAMING_AVAILABILITY_API_KEY: undefined }, request)).toMatchObject({
			resolved: false,
			reason: 'temporarily_unavailable',
		});
	});

	it.each([404, 500, 429])('does not repeat a backup HTTP %s on the next tap', async (status) => {
		const fetchSpy = mockUpstreams({ noWiki: true, backupStatus: status });
		expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: false });
		expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: false });
		expect(backupCalls(fetchSpy)).toHaveLength(1);
	});

	it('rejects mismatched backup identity without saving links', async () => {
		mockUpstreams({ noWiki: true, backupBody: { ...backup(), tmdbId: 'movie/123' } });
		expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: false, reason: 'temporarily_unavailable' });
		expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM movie_streaming_route_links').first('count')).toBe(0);
	});

	it('allows only one simultaneous backup request across independent resolver calls', async () => {
		const fetchSpy = mockUpstreams({ noWiki: true });
		const results = await Promise.all([resolveStreamingLink(env, request), resolveStreamingLink(env, request)]);
		expect(results.some((result) => result.resolved)).toBe(true);
		expect(backupCalls(fetchSpy)).toHaveLength(1);
	});

	it('reserves a shared quota atomically and starts a new period without exceeding the limit', async () => {
		const limited = { ...env, STREAMING_AVAILABILITY_MONTHLY_LIMIT: '2' };
		const now = Date.parse('2026-08-31T23:59:00Z') / 1000;
		expect((await Promise.all(Array.from({ length: 8 }, () => reserveStreamingRequest(limited, now)))).filter(Boolean)).toHaveLength(2);
		expect(await reserveStreamingRequest(limited, now + 120)).toBe(true);
		expect(await reserveStreamingRequest({ ...env, STREAMING_AVAILABILITY_MONTHLY_LIMIT: '0' }, now)).toBe(false);
	});

	it('keeps the primary lookup working when the backup budget is disabled', async () => {
		const fetchSpy = mockUpstreams();
		expect(await resolveStreamingLink({ ...env, STREAMING_AVAILABILITY_MONTHLY_LIMIT: '0' }, request)).toMatchObject({
			resolved: true,
			source: 'wikidata',
		});
		expect(backupCalls(fetchSpy)).toHaveLength(0);
	});

	it('blocks the backup before spending any request when its budget is disabled', async () => {
		const fetchSpy = mockUpstreams({ noWiki: true });
		expect(await resolveStreamingLink({ ...env, STREAMING_AVAILABILITY_MONTHLY_LIMIT: '0' }, request)).toMatchObject({
			resolved: false,
			reason: 'quota_exhausted',
		});
		expect(backupCalls(fetchSpy)).toHaveLength(0);
	});
});

describe('HTTP contract', () => {
	it.each(['wikidata', 'streaming-availability'])('resolves %s through the real Worker fetch runtime', async (source) => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		try {
			fetchMock
				.get('https://api.themoviedb.org')
				.intercept({ path: '/3/movie/492188/external_ids?api_key=test-tmdb-key' })
				.reply(200, { id: 492188, wikidata_id: source === 'wikidata' ? 'Q48671199' : null });
			if (source === 'wikidata') {
				fetchMock
					.get('https://www.wikidata.org')
					.intercept({ path: /^\/w\/api.php\?/ })
					.reply(200, wiki());
			} else {
				fetchMock.get('https://api.movieofthenight.com').intercept({ path: '/v4/shows/movie/492188' }).reply(200, backup());
			}
			expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: true, source });
			fetchMock.assertNoPendingInterceptors();
		} finally {
			fetchMock.deactivate();
			fetchMock.enableNetConnect();
		}
	});

	it('does not follow an API redirect or send its key to the redirect destination', async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		try {
			fetchMock
				.get('https://api.themoviedb.org')
				.intercept({ path: '/3/movie/492188/external_ids?api_key=test-tmdb-key' })
				.reply(200, { id: 492188, wikidata_id: null });
			fetchMock
				.get('https://api.movieofthenight.com')
				.intercept({ path: '/v4/shows/movie/492188' })
				.reply(302, '', { headers: { location: 'https://other.example/collect' } });
			expect(await resolveStreamingLink(env, request)).toMatchObject({ resolved: false, reason: 'temporarily_unavailable' });
			fetchMock.assertNoPendingInterceptors();
		} finally {
			fetchMock.deactivate();
			fetchMock.enableNetConnect();
		}
	});

	it('normalizes region and rejects missing, duplicate, malformed and extra inputs', () => {
		expect(parseStreamingLinkRequest(new URL('https://example.com/streaming-link?tmdbId=492188&providerId=8&region=us'))).toEqual(request);
		for (const query of [
			'',
			'tmdbId=1&providerId=8',
			'tmdbId=-1&providerId=8&region=US',
			'tmdbId=1.2&providerId=8&region=US',
			'tmdbId=2147483648&providerId=8&region=US',
			'tmdbId=1&tmdbId=2&providerId=8&region=US',
			'tmdbId=1&providerId=8&region=USA',
			'tmdbId=1&providerId=8&region=US&url=https://evil.example',
		]) {
			expect(() => parseStreamingLinkRequest(new URL(`https://example.com/streaming-link?${query}`))).toThrow();
		}
	});

	it('routes GET, rejects POST, and never places secrets in the response', async () => {
		mockUpstreams();
		const url = 'https://example.com/streaming-link?tmdbId=492188&providerId=8&region=US';
		const response = await handleFetch(new Request(url), env);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await response.text();
		expect(JSON.parse(body)).toMatchObject({ resolved: true, tmdbId: 492188, providerId: 8, providerContentId: '80223779' });
		expect(body).not.toContain('test-streaming-key');
		expect((await handleFetch(new Request(url, { method: 'POST' }), env)).status).toBe(405);
		expect((await handleFetch(new Request('https://example.com/streaming-link'), env)).status).toBe(400);
	});
});
