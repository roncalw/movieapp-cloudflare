import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import legacyMigration from '../migrations/0029_add_streaming_link_resolver.sql?raw';
import routeMigration from '../migrations/0030_add_subscription_route_links.sql?raw';
import samples from './fixtures/subscription-route-samples.json';
import { huluDisneyRouteTemplate, subscriptionRouteForProviderId, subscriptionRoutes } from '../src/streaming/subscriptionRoutes';
import { adapterForProviderId, destinationForRouteFromUrl } from '../src/streaming/providerCatalog';
import { resolveStreamingLink } from '../src/streaming/streamingLinkResolver';
import type { Env } from '../src/shared/types';
const env = { DB: testEnv.DB, TMDB_API_KEY: 'mock', STREAMING_AVAILABILITY_API_KEY: 'mock' } as Env;
const claim = (value: string) => ({ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value } } });
const request = (providerId: number, tmdbId = 938614) => ({ tmdbId, providerId, region: 'US' });
beforeEach(async () => {
	const tables = [
		'movie_streaming_route_links',
		'movie_streaming_links',
		'streaming_link_candidates',
		'streaming_link_lookups',
		'streaming_api_budget',
	];
	await testEnv.DB.batch(tables.map((t) => testEnv.DB.prepare(`DROP TABLE IF EXISTS ${t}`)));
	await testEnv.DB.batch(
		(legacyMigration + '\n' + routeMigration)
			.replace(/^--.*$/gm, '')
			.split(';')
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => testEnv.DB.prepare(s))
	);
});
afterEach(() => vi.restoreAllMocks());

function upstreams(tmdbId = 938614, body: unknown = samples[0], claims: Record<string, unknown> = {}) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = new URL(String(input));
		if (url.hostname === 'api.themoviedb.org') return Response.json({ id: tmdbId, wikidata_id: 'Q1' });
		if (url.hostname === 'www.wikidata.org')
			return Response.json({ entities: { Q1: { claims: { P4947: [claim(String(tmdbId))], ...claims } } } });
		if (url.hostname === 'api.movieofthenight.com') return Response.json(body);
		throw new Error('Unexpected upstream');
	});
}

describe('subscription route identities and platform resolution', () => {
	it('keeps all configured exact IDs unique, including channel variants', () => {
		expect(new Set(subscriptionRoutes.map((r) => r.tmdbProviderId)).size).toBe(subscriptionRoutes.length);
		expect(subscriptionRouteForProviderId(526)).toMatchObject({ subscriptionCategory: 'direct', playbackPlatform: 'amc' });
		expect(subscriptionRouteForProviderId(528)).toMatchObject({ subscriptionCategory: 'prime_video_channels', playbackPlatform: 'prime' });
		expect(adapterForProviderId(1794)?.provider).toBe('prime');
		expect(adapterForProviderId(1854)?.provider).toBe('apple');
	});

	it.each([
		[938614, 526, 'amc'],
		[938614, 528, 'prime'],
		[938614, 1854, 'apple'],
		[938614, 635, 'roku'],
		[936075, 43, 'starz'],
		[936075, 1794, 'prime'],
		[936075, 1855, 'apple'],
		[936075, 634, 'roku'],
	])('resolves the real captured route for movie %s provider %s on %s', async (tmdbId, providerId, platform) => {
		const body = samples.find((s) => s.tmdbId === `movie/${tmdbId}`)!;
		const fetchSpy = upstreams(tmdbId, body);
		const result = await resolveStreamingLink(env, request(providerId, tmdbId));
		expect(result).toMatchObject({
			resolved: true,
			providerId,
			playbackPlatform: platform,
			provider: platform,
			source: 'streaming-availability',
		});
		fetchSpy.mockClear();
		expect(await resolveStreamingLink(env, request(providerId, tmdbId))).toMatchObject({ ...result, cacheHit: true });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('stores AMC+ direct, Prime, Apple and Roku separately and reuses one backup response', async () => {
		const fetchSpy = upstreams();
		for (const id of [526, 528, 1854, 635])
			expect(await resolveStreamingLink(env, request(id))).toMatchObject({ resolved: true, providerId: id });
		expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.movieofthenight.com'))).toHaveLength(1);
		const rows = await testEnv.DB.prepare(
			'SELECT tmdb_provider_id, playback_platform FROM movie_streaming_route_links WHERE tmdb_provider_id IN (526,528,1854,635) ORDER BY tmdb_provider_id'
		).all();
		expect(rows.results).toEqual([
			{ tmdb_provider_id: 526, playback_platform: 'amc' },
			{ tmdb_provider_id: 528, playback_platform: 'prime' },
			{ tmdb_provider_id: 635, playback_platform: 'roku' },
			{ tmdb_provider_id: 1854, playback_platform: 'apple' },
		]);
	});

	it('uses Prime Wikidata identifiers for AMC+ on Prime, never its standalone AMC+ identifier', async () => {
		const fetchSpy = upstreams(
			938614,
			{},
			{
				P8055: [claim('B012345678')],
				P953: [claim('https://www.amcplus.com/movies/late-night-with-the-devil--1067652')],
			}
		);
		expect(await resolveStreamingLink(env, request(528))).toMatchObject({
			resolved: true,
			providerId: 528,
			playbackPlatform: 'prime',
			source: 'wikidata',
			webUrl: 'https://www.primevideo.com/detail/B012345678',
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it('does not substitute another channel, base Prime, rental, or another country', async () => {
		const link = 'https://www.amazon.com/gp/video/detail/B012345678';
		upstreams(938614, {
			showType: 'movie',
			tmdbId: 'movie/938614',
			streamingOptions: {
				us: [
					{ service: { id: 'prime' }, type: 'subscription', link },
					{ service: { id: 'prime' }, type: 'rent', link },
					{ service: { id: 'prime' }, type: 'addon', addon: { id: 'starzSub' }, link },
				],
				ca: [{ service: { id: 'prime' }, type: 'addon', addon: { id: 'amcplus' }, link }],
			},
		});
		expect(await resolveStreamingLink(env, request(528))).toMatchObject({ resolved: false, reason: 'no_match' });
		expect(await resolveStreamingLink(env, request(1794))).toMatchObject({ resolved: true, playbackPlatform: 'prime' });
		expect(await resolveStreamingLink(env, request(526))).toMatchObject({ resolved: false });
	});

	it('preserves the Apple offer selector and refuses store rentals and other channel selectors', async () => {
		upstreams();
		const result = await resolveStreamingLink(env, request(1854));
		expect(result.resolved).toBe(true);
		if (!result.resolved) return;
		expect(new URL(result.webUrl).searchParams.get('playableId')).toBe('tvs.sbd.1000383:AMCNFL0000013474');
		const route = subscriptionRouteForProviderId(1854)!;
		expect(destinationForRouteFromUrl(route, result.webUrl.replace('1000383', '9001'))).toBeNull();
		expect(destinationForRouteFromUrl(route, result.webUrl.replace('1000383', '1000231'))).toBeNull();
		expect(destinationForRouteFromUrl(route, result.webUrl.split('?')[0])).toBeNull();
	});

	it('does not reinterpret a legacy standalone mapping as a Prime channel mapping', async () => {
		await testEnv.DB.prepare(
			"INSERT INTO movie_streaming_links VALUES (938614,9,'prime','US','B012345678','https://www.amazon.com/gp/video/detail/B012345678',NULL,'wikidata','2026-08-31T00:00:00Z')"
		).run();
		const fetchSpy = upstreams();
		const result = await resolveStreamingLink(env, request(528));
		expect(result).toMatchObject({ resolved: true, source: 'streaming-availability', providerContentId: '0NYJVVVAGM57ZC561VK0R657IV' });
		expect(fetchSpy).toHaveBeenCalled();
		expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM movie_streaming_links').first('n')).toBe(1);
	});

	it('supports an explicitly bound Hulu/Disney route without making it live or changing Hulu direct', async () => {
		const mockId = 999001;
		const catalog = [...subscriptionRoutes, { ...huluDisneyRouteTemplate, tmdbProviderId: mockId }];
		const fetchSpy = upstreams();
		expect(await resolveStreamingLink(env, request(mockId))).toMatchObject({ resolved: false, reason: 'unsupported_provider' });
		expect(fetchSpy).not.toHaveBeenCalled();
		const disney = await resolveStreamingLink(env, request(mockId), catalog);
		expect(disney).toMatchObject({
			resolved: true,
			providerId: mockId,
			providerKey: 'hulu_disney_plus',
			playbackPlatform: 'disney',
			subscriptionCategory: 'disney_plus',
		});
		expect(await resolveStreamingLink(env, request(15))).toMatchObject({
			resolved: true,
			playbackPlatform: 'hulu',
			subscriptionCategory: 'direct',
		});
		expect(
			await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM movie_streaming_route_links WHERE tmdb_provider_id IN (15,999001)').first('n')
		).toBe(2);
	});
});
