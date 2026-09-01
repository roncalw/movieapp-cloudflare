import {
	providerAdapters,
	destinationFromUrl,
	destinationForRouteFromUrl,
	destinationFromWikidataValue,
	safeHttpsUrl,
	type ProviderAdapter,
	type ProviderDestination,
} from './providerCatalog';
import type { SubscriptionRoute } from './subscriptionRoutes';
export { safeHttpsUrl } from './providerCatalog';

/**
 * Provider-specific identifier and URL rules belong here. The mobile app only
 * launches a validated destination; it never discovers a provider's title ID.
 * Availability still comes from TMDB; these rules only resolve destinations.
 */
export const netflixAdapter = {
	provider: 'netflix' as const,
	tmdbProviderIds: [8, 1796] as readonly number[],
	wikidataProperty: 'P1874',
	parseId(value: unknown): string | null {
		return typeof value === 'string' && /^[1-9]\d{5,7}$/.test(value) ? value : null;
	},
	parseUrl(value: unknown): string | null {
		const url = safeHttpsUrl(value);
		if (!url || !['netflix.com', 'www.netflix.com'].includes(url.hostname)) return null;
		const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:title|watch)\/([1-9]\d{5,7})\/?$/);
		return match?.[1] ?? null;
	},
	buildUrls(id: string) {
		if (!this.parseId(id)) throw new Error('Invalid Netflix title ID.');
		return {
			webUrl: `https://www.netflix.com/title/${id}`,
			nativeUrl: `nflx://www.netflix.com/watch/${id}`,
		};
	},
};

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function claimValues(claims: Record<string, unknown>, property: string): string[] {
	const statements = claims[property];
	if (!Array.isArray(statements)) return [];
	const usable = statements.map(asRecord).filter(
		(statement) =>
			statement &&
			statement.rank !== 'deprecated' &&
			// A qualified ID may be for a DVD edition or a particular release. Do not
			// guess which edition the user selected when more evidence is needed.
			Object.keys(asRecord(statement.qualifiers) ?? {}).length === 0
	);
	const preferred = usable.filter((statement) => statement?.rank === 'preferred');
	return (preferred.length ? preferred : usable).flatMap((statement) => {
		const snak = asRecord(statement?.mainsnak);
		const value = asRecord(snak?.datavalue)?.value;
		return snak?.snaktype === 'value' && typeof value === 'string' ? [value] : [];
	});
}

export function providerLinkFromWikidata(
	payload: unknown,
	wikidataId: string,
	tmdbId: number,
	adapter: ProviderAdapter
): ProviderDestination | null {
	const entity = asRecord(asRecord(asRecord(payload)?.entities)?.[wikidataId]);
	if (!entity || 'missing' in entity) return null;
	const claims = asRecord(entity.claims) ?? {};
	const movieIds = claimValues(claims, 'P4947');
	if (movieIds.length && !movieIds.includes(String(tmdbId))) return null;
	for (const property of adapter.wikidataProperties) {
		const destinations = claimValues(claims, property)
			.map((value) => destinationFromWikidataValue(adapter.provider, property, value))
			.filter((value): value is ProviderDestination => value !== null);
		const unique = new Map(destinations.map((value) => [value.providerContentId, value]));
		// Conflicting Wikidata statements need corroboration from the backup API.
		if (unique.size > 1) return null;
		if (unique.size === 1) return [...unique.values()][0];
	}
	return null;
}

export function netflixIdFromWikidata(payload: unknown, wikidataId: string, tmdbId: number): string | null {
	return providerLinkFromWikidata(payload, wikidataId, tmdbId, providerAdapters[0])?.providerContentId ?? null;
}

export type StreamingCandidate = {
	provider: string;
	region: string;
	webUrl: string;
	providerContentId: string | null;
	optionType: string;
	addonId: string;
};

export function streamingCandidates(payload: unknown, tmdbId: number): StreamingCandidate[] {
	const show = asRecord(payload);
	if (show?.showType !== 'movie' || show.tmdbId !== `movie/${tmdbId}`) {
		throw new Error('Streaming Availability returned a different movie.');
	}
	const options = asRecord(show.streamingOptions);
	if (!options) throw new Error('Streaming Availability returned invalid options.');
	const candidates: StreamingCandidate[] = [];
	for (const [region, values] of Object.entries(options)) {
		if (!/^[a-z]{2}$/.test(region) || !Array.isArray(values)) continue;
		for (const value of values) {
			const option = asRecord(value);
			const provider = asRecord(option?.service)?.id;
			const url = safeHttpsUrl(option?.link);
			const optionType = option?.type;
			const addon = asRecord(option?.addon)?.id;
			if (
				typeof provider !== 'string' ||
				!/^[a-z0-9-]{1,64}$/.test(provider) ||
				!url ||
				typeof optionType !== 'string' ||
				!['subscription', 'free', 'rent', 'buy', 'addon'].includes(optionType)
			)
				continue;
			if (optionType === 'addon' && (typeof addon !== 'string' || addon.length > 128)) continue;
			candidates.push({
				provider,
				region: region.toUpperCase(),
				webUrl: url.href,
				providerContentId: (() => {
					const adapter = providerAdapters.find((value) => value.service === provider);
					return adapter ? destinationFromUrl(adapter.provider, url.href)?.providerContentId ?? null : null;
				})(),
				optionType,
				addonId: typeof addon === 'string' ? addon : '',
			});
			if (candidates.length > 2000) throw new Error('Streaming Availability response is too large.');
		}
	}
	return candidates;
}

/** Choose the exact subscription route in the requested country.
 * The API has already matched the TMDB movie. Providers may publish several
 * editions of that movie; a deterministic URL choice avoids arbitrary changes
 * between taps. Netflix retains its stricter conflicting-ID protection.
 */
export function destinationFromCandidates(
	candidates: StreamingCandidate[],
	adapter: ProviderAdapter,
	region: string,
	route?: SubscriptionRoute
): ProviderDestination | null {
	const options = candidates.filter(
		(candidate) =>
			candidate.provider === adapter.service &&
			candidate.region === region &&
			(route && route.subscriptionCategory !== 'direct'
				? candidate.optionType === 'addon' && route.addonIds.includes(candidate.addonId)
				: candidate.optionType === 'subscription' && !candidate.addonId)
	);
	const destinations = options
		.map((candidate) =>
			route ? destinationForRouteFromUrl(route, candidate.webUrl) : destinationFromUrl(adapter.provider, candidate.webUrl)
		)
		.filter((value): value is ProviderDestination => value !== null);
	if (adapter.provider === 'netflix' && new Set(options.map((candidate) => netflixAdapter.parseUrl(candidate.webUrl))).size !== 1)
		return null;
	return destinations.sort((a, b) => a.webUrl.localeCompare(b.webUrl))[0] ?? null;
}
