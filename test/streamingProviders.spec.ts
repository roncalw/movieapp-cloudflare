import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import legacyMigration from '../migrations/0029_add_streaming_link_resolver.sql?raw';
import routeMigration from '../migrations/0030_add_subscription_route_links.sql?raw';
const migration = legacyMigration + '\n' + routeMigration;
import samples from './fixtures/streaming-provider-samples.json';
import { adapterForProviderId, destinationFromUrl, providerAdapters } from '../src/streaming/providerCatalog';
import { providerLinkFromWikidata } from '../src/streaming/providerAdapters';
import { resolveStreamingLink } from '../src/streaming/streamingLinkResolver';
import type { Env } from '../src/shared/types';
const env = { DB: testEnv.DB, TMDB_API_KEY: 'mock', STREAMING_AVAILABILITY_API_KEY: 'mock' } as Env;
const claim = (value: string) => ({ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value } } });
const scenarios = [
	[8, 756999, 'netflix'],
	[15, 24428, 'hulu'],
	[9, 687163, 'prime'],
	[1899, 155, 'max'],
	[337, 862, 'disney'],
	[350, 911430, 'apple'],
	[387, 49018, 'peacock'],
	[526, 938614, 'amc'],
	[531, 361743, 'paramount'],
] as const;
beforeEach(async () => {
	await testEnv.DB.batch(
		[
			'movie_streaming_route_links',
			'movie_streaming_links',
			'streaming_link_candidates',
			'streaming_link_lookups',
			'streaming_api_budget',
		].map((table) => testEnv.DB.prepare(`DROP TABLE IF EXISTS ${table}`))
	);
	await testEnv.DB.batch(
		migration
			.replace(/^--.*$/gm, '')
			.split(';')
			.map((sql) => sql.trim())
			.filter(Boolean)
			.map((sql) => testEnv.DB.prepare(sql))
	);
});
afterEach(() => vi.restoreAllMocks());

function upstreams(tmdbId: number, body: unknown) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = new URL(String(input));
		if (url.hostname === 'api.themoviedb.org') return Response.json({ id: tmdbId, wikidata_id: 'Q1' });
		if (url.hostname === 'www.wikidata.org') return Response.json({ entities: { Q1: { claims: { P4947: [claim(String(tmdbId))] } } } });
		if (url.hostname === 'api.movieofthenight.com') return Response.json(body);
		throw new Error('Unexpected upstream');
	});
}

describe('all Advanced Search providers', () => {
	it('has an adapter for all ten filter IDs, including YouTube without a backup service', () => {
		for (const id of [8, 15, 9, 1899, 192, 337, 350, 387, 526, 531]) expect(adapterForProviderId(id)).toBeDefined();
		expect(adapterForProviderId(192)?.service).toBeNull();
	});
	it.each(scenarios)(
		'resolves provider %s from the real API sample for movie %s, then uses only D1',
		async (providerId, tmdbId, provider) => {
			const sample = samples.find((show) => show.tmdbId === `movie/${tmdbId}`)!;
			const fetchSpy = upstreams(tmdbId, sample);
			const request = { tmdbId, providerId, region: 'US' };
			const result = await resolveStreamingLink(env, request);
			expect(result).toMatchObject({ resolved: true, provider, source: 'streaming-availability', cacheHit: false });
			expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
				'api.themoviedb.org',
				'www.wikidata.org',
				'api.movieofthenight.com',
			]);
			fetchSpy.mockClear();
			expect(await resolveStreamingLink(env, request)).toMatchObject({ ...result, cacheHit: true });
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(await testEnv.DB.prepare('SELECT requests FROM streaming_api_budget').first('requests')).toBe(1);
		}
	);
	it('saves Hulu and Disney from one response, without charging separately', async () => {
		const fetchSpy = upstreams(
			862,
			samples.find((show) => show.tmdbId === 'movie/862')
		);
		await resolveStreamingLink(env, { tmdbId: 862, providerId: 337, region: 'US' });
		fetchSpy.mockClear();
		expect(await resolveStreamingLink(env, { tmdbId: 862, providerId: 15, region: 'US' })).toMatchObject({
			resolved: true,
			provider: 'hulu',
			cacheHit: true,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
	it('promotes a previously retained non-Netflix link before calling any upstream', async () => {
		const url = 'https://www.amcplus.com/movies/late-night-with-the-devil--1067652';
		await testEnv.DB.prepare(
			`INSERT INTO streaming_link_candidates VALUES (938614, 'amc', 'US', ?, NULL, 'subscription', '', 'streaming-availability', '2026-08-31T00:00:00Z')`
		)
			.bind(url)
			.run();
		const fetchSpy = upstreams(938614, {});
		expect(await resolveStreamingLink(env, { tmdbId: 938614, providerId: 526, region: 'US' })).toMatchObject({
			resolved: true,
			providerContentId: '1067652',
			cacheHit: true,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
	it('does not confuse Amazon channels, rentals, and other countries with the selected service', async () => {
		upstreams(938614, {
			showType: 'movie',
			tmdbId: 'movie/938614',
			streamingOptions: {
				us: [
					{ service: { id: 'prime' }, type: 'addon', addon: { id: 'amc' }, link: 'https://www.amazon.com/gp/video/detail/B012345678' },
					{ service: { id: 'amc' }, type: 'rent', link: 'https://www.amcplus.com/movies/example--1067652' },
				],
				ca: [{ service: { id: 'amc' }, type: 'subscription', link: 'https://www.amcplus.com/movies/example--1067652' }],
			},
		});
		expect(await resolveStreamingLink(env, { tmdbId: 938614, providerId: 526, region: 'US' })).toMatchObject({
			resolved: false,
			reason: 'no_match',
		});
		expect(await resolveStreamingLink(env, { tmdbId: 938614, providerId: 9, region: 'US' })).toMatchObject({
			resolved: false,
			reason: 'no_match',
		});
	});
	it('never uses a YouTube trailer ID or spends backup quota for an unsupported catalog', async () => {
		const fetchSpy = upstreams(557950, {});
		expect(await resolveStreamingLink(env, { tmdbId: 557950, providerId: 192, region: 'US' })).toMatchObject({
			resolved: false,
			reason: 'no_match',
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const adapter = adapterForProviderId(192)!;
		expect(providerLinkFromWikidata({ entities: { Q1: { claims: { P1651: [claim('dQw4w9WgXcQ')] } } } }, 'Q1', 557950, adapter)).toBeNull();
		expect(
			providerLinkFromWikidata(
				{ entities: { Q1: { claims: { P953: [claim('https://www.youtube.com/watch?v=abcdefghijk')] } } } },
				'Q1',
				557950,
				adapter
			)
		).toMatchObject({ providerContentId: 'abcdefghijk' });
	});
	it('accepts verified Wikidata formats without an API request and rejects collection/series IDs', () => {
		const values: Record<string, [string, string]> = {
			netflix: ['P1874', '80223779'],
			hulu: ['P6466', 'd2ab699b-67da-4906-a7a4-5bc542c953cf'],
			prime: ['P8055', 'B00GD53IN2'],
			max: ['P8298', 'movie/52217243-a137-45d6-9c6a-0dfab4633034'],
			disney: ['P13902', 'entity-f6174ebf-cb92-453c-a52b-62bb3576e402'],
			apple: ['P9586', 'umc.cmc.3t6dvnnr87zwd4wmvpdx5came'],
			peacock: ['P11815', 'movies/psych-3-this-is-gus'],
			paramount: ['P13147', 'Alcn0hcGx0HosdhcawKteH8DXh3RiOF7'],
			amc: ['P953', 'https://www.amcplus.com/movies/late-night-with-the-devil--1067652'],
		};
		for (const adapter of providerAdapters.filter((a) => values[a.provider])) {
			const [property, value] = values[adapter.provider];
			expect(providerLinkFromWikidata({ entities: { Q1: { claims: { [property]: [claim(value)] } } } }, 'Q1', 1, adapter)).not.toBeNull();
		}
		expect(destinationFromUrl('disney', 'https://www.disneyplus.com/browse/page-f6174ebf-cb92-453c-a52b-62bb3576e402')).toBeNull();
		expect(destinationFromUrl('max', 'https://play.hbomax.com/show/52217243-a137-45d6-9c6a-0dfab4633034')).toBeNull();
	});
	it('rejects lookalike domains, login/search pages, credentials, and unrelated schemes for every provider', () => {
		for (const adapter of providerAdapters)
			for (const url of [
				'https://evil.example/movie/123',
				'https://www.' + adapter.provider + '.com.evil.example/movie/123',
				'file:///movie/123',
				'javascript:alert(1)',
				'https://user:password@www.hulu.com/movie/d2ab699b-67da-4906-a7a4-5bc542c953cf',
			])
				expect(destinationFromUrl(adapter.provider, url)).toBeNull();
		expect(
			destinationFromUrl('prime', 'https://app.primevideo.com/detail?gti=amzn1.dv.gti.eb88085b-27f7-4117-b318-a01c66788756&gti=evil')
		).toBeNull();
	});
});

// These regressions came from actual simulator visits: app/player links opened
// generic installation or unsupported-browser pages instead of the movie page.
it('keeps Prime and Peacock title identity when choosing their public browser pages', () => {
	expect(
		destinationFromUrl('prime', 'https://app.primevideo.com/detail?gti=amzn1.dv.gti.414eb1af-ee27-476c-bc46-bedd48595f59')
	).toMatchObject({
		providerContentId: 'amzn1.dv.gti.414eb1af-ee27-476c-bc46-bedd48595f59',
		webUrl: 'https://www.primevideo.com/detail/amzn1.dv.gti.414eb1af-ee27-476c-bc46-bedd48595f59',
	});
	expect(
		destinationFromUrl('peacock', 'https://www.peacocktv.com/watch/asset/movies/insidious/4e51408e-3b18-3583-8ea3-7f0790250456')
	).toMatchObject({
		providerContentId: '4e51408e-3b18-3583-8ea3-7f0790250456',
		webUrl: 'https://www.peacocktv.com/watch-online/movies/insidious/4e51408e-3b18-3583-8ea3-7f0790250456',
	});
});
