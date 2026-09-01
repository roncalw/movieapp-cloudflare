import { getTmdbMovieExternalIds } from '../externalApis/tmdbClient';
import type { Env } from '../shared/types';
import { providerLinkFromWikidata, destinationFromCandidates, streamingCandidates, type StreamingCandidate } from './providerAdapters';
import {
	adapterForRoute,
	destinationForRouteFromUrl,
	providerAdapters,
	type StreamingProvider,
	type ProviderDestination,
} from './providerCatalog';

import { subscriptionRouteForProviderId, subscriptionRoutes, type SubscriptionRoute } from './subscriptionRoutes';

export type StreamingLinkRequest = { tmdbId: number; providerId: number; region: string };
type RouteRequest = StreamingLinkRequest & { route: SubscriptionRoute };
type RouteMetadata = Pick<SubscriptionRoute, 'providerKey' | 'displayServiceName' | 'subscriptionCategory' | 'playbackPlatform'>;
const identity = ({ tmdbId, providerId, region }: StreamingLinkRequest): StreamingLinkRequest => ({ tmdbId, providerId, region });
const routeMetadata = (route: SubscriptionRoute): RouteMetadata => ({
	providerKey: route.providerKey,
	displayServiceName: route.displayServiceName,
	subscriptionCategory: route.subscriptionCategory,
	playbackPlatform: route.playbackPlatform,
});
type Source = 'wikidata' | 'streaming-availability';
type FailureReason = 'unsupported_provider' | 'no_match' | 'temporarily_unavailable' | 'quota_exhausted' | 'lookup_in_progress';
export type StreamingLinkResult = StreamingLinkRequest &
	(
		| (RouteMetadata & {
				resolved: true;
				provider: StreamingProvider;
				providerContentId: string;
				webUrl: string;
				nativeUrl: string | null;
				source: Source;
				resolvedAt: string;
				cacheHit: boolean;
		  })
		| { resolved: false; provider: StreamingProvider | null; reason: FailureReason }
	);
type LinkRow = { provider_content_id: string; web_url: string; source: Source; resolved_at: string };
const toRow = (destination: ProviderDestination, source: Source, resolvedAt: string): LinkRow => ({
	provider_content_id: destination.providerContentId,
	web_url: destination.webUrl,
	source,
	resolved_at: resolvedAt,
});

const UPSTREAM_TIMEOUT_MS = 5000;
const DAY_SECONDS = 86400;

// Log only known diagnostic fields, never upstream bodies, request headers,
// exception messages containing URLs, or API keys.
function trace(request: StreamingLinkRequest, stage: string, outcome: string) {
	console.info(JSON.stringify({ event: 'streaming-link', ...identity(request), stage, outcome }));
}

function unresolved(request: StreamingLinkRequest & { route?: SubscriptionRoute }, reason: FailureReason): StreamingLinkResult {
	return { ...identity(request), resolved: false, provider: request.route?.playbackPlatform ?? null, reason };
}

function resolved(request: RouteRequest, row: LinkRow, cacheHit: boolean): StreamingLinkResult {
	return {
		...identity(request),
		...routeMetadata(request.route),
		resolved: true,
		provider: request.route.playbackPlatform!,
		...destinationForRouteFromUrl(request.route, row.web_url)!,
		source: row.source,
		resolvedAt: row.resolved_at,
		cacheHit,
	};
}

async function cachedLink(env: Env, request: RouteRequest): Promise<LinkRow | null> {
	const { route } = request;
	const row = await env.DB.prepare(
		`SELECT provider_content_id, web_url, source, resolved_at FROM movie_streaming_route_links
     WHERE tmdb_id = ? AND tmdb_provider_id = ? AND region = ?
     AND provider_key = ? AND subscription_category = ? AND playback_platform = ?`
	)
		.bind(request.tmdbId, request.providerId, request.region, route.providerKey, route.subscriptionCategory, route.playbackPlatform)
		.first<LinkRow>();
	if (row && ['wikidata', 'streaming-availability'].includes(row.source)) {
		const destination = destinationForRouteFromUrl(route, row.web_url);
		if (destination?.providerContentId === row.provider_content_id) return row;
	}
	// Older releases stored only normalized direct providers. Copy those links
	// on demand, but never use them as evidence for a channel subscription.
	if (route.subscriptionCategory !== 'direct') return null;
	const legacy = await env.DB.prepare(
		`SELECT provider_content_id, web_url, source, resolved_at FROM movie_streaming_links
     WHERE tmdb_id = ? AND provider = ? AND region = ?`
	)
		.bind(request.tmdbId, route.playbackPlatform, request.region)
		.first<LinkRow>();
	if (!legacy || !['wikidata', 'streaming-availability'].includes(legacy.source)) return null;
	if (route.playbackPlatform === 'netflix' && /^[1-9]\d{5,7}$/.test(legacy.provider_content_id)) {
		legacy.web_url = `https://www.netflix.com/title/${legacy.provider_content_id}`;
	}
	const destination = destinationForRouteFromUrl(route, legacy.web_url);
	if (destination?.providerContentId !== legacy.provider_content_id) return null;
	await saveLink(env, request, destination, legacy.source, legacy.resolved_at).run();
	return toRow(destination, legacy.source, legacy.resolved_at);
}

function saveLink(env: Env, request: RouteRequest, destination: ProviderDestination, source: Source, resolvedAt: string) {
	const { route } = request;
	return env.DB.prepare(
		`INSERT INTO movie_streaming_route_links
    (tmdb_id, tmdb_provider_id, provider_key, display_service_name, subscription_category,
     playback_platform, region, provider_content_id, web_url, native_url, source, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tmdb_id, tmdb_provider_id, region) DO UPDATE SET
    provider_key = excluded.provider_key, display_service_name = excluded.display_service_name,
    subscription_category = excluded.subscription_category, playback_platform = excluded.playback_platform,
    provider_content_id = excluded.provider_content_id, web_url = excluded.web_url,
    native_url = excluded.native_url, source = excluded.source, resolved_at = excluded.resolved_at`
	).bind(
		request.tmdbId,
		request.providerId,
		route.providerKey,
		route.displayServiceName,
		route.subscriptionCategory,
		route.playbackPlatform,
		request.region,
		destination.providerContentId,
		destination.webUrl,
		destination.nativeUrl,
		source,
		resolvedAt
	);
}

// The Netflix release already saved other services' raw candidates. Promote
// those records on demand before spending a new upstream request.
async function retainedLink(env: Env, request: RouteRequest): Promise<LinkRow | null> {
	const adapter = adapterForRoute(request.route)!;
	if (!adapter.service) return null;
	const rows = await env.DB.prepare(
		`SELECT provider, region, web_url AS webUrl, provider_content_id AS providerContentId,
  option_type AS optionType, addon_id AS addonId, resolved_at AS resolvedAt FROM streaming_link_candidates
  WHERE tmdb_id = ? AND provider = ? AND region = ? ORDER BY resolved_at DESC`
	)
		.bind(request.tmdbId, adapter.service, request.region)
		.all<StreamingCandidate & { resolvedAt: string }>();
	if (!rows.results.length) return null;
	const latest = rows.results[0].resolvedAt;
	const destination = destinationFromCandidates(
		rows.results.filter((row) => row.resolvedAt === latest),
		adapter,
		request.region,
		request.route
	);
	if (!destination) return null;
	await saveLink(env, request, destination, 'streaming-availability', latest).run();
	return toRow(destination, 'streaming-availability', latest);
}

async function wikidataLink(env: Env, request: RouteRequest): Promise<LinkRow | null> {
	// A bare platform ID cannot select an Apple channel offer or establish the
	// Hulu add-on on Disney+. These routes require an explicit API add-on link.
	if (['apple_tv_channels', 'disney_plus'].includes(request.route.subscriptionCategory)) return null;
	let stage = 'tmdb';
	try {
		const externalIds = await getTmdbMovieExternalIds(request.tmdbId, env);
		if (externalIds.id !== request.tmdbId) throw new Error('TMDB movie mismatch.');
		const wikidataId = externalIds.wikidata_id;
		if (typeof wikidataId !== 'string' || !/^Q[1-9]\d*$/.test(wikidataId)) {
			trace(request, 'tmdb', 'no_wikidata_id');
			return null;
		}
		trace(request, 'tmdb', 'wikidata_id_found');
		stage = 'wikidata';
		const url = new URL('https://www.wikidata.org/w/api.php');
		url.search = new URLSearchParams({ action: 'wbgetentities', ids: wikidataId, props: 'claims', format: 'json', maxlag: '5' }).toString();
		const response = await fetch(url, {
			headers: { accept: 'application/json', 'user-agent': 'MovieApp/1.0 (https://codefest.com; streaming title resolver)' },
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			// Workers accepts manual/follow only. Reject redirects through the
			// response status instead of forwarding this request to another host.
			redirect: 'manual',
		});
		if (!response.ok) {
			trace(request, stage, `http_${response.status}`);
			return null;
		}
		const destination = providerLinkFromWikidata(await response.json(), wikidataId, request.tmdbId, adapterForRoute(request.route)!);
		trace(request, 'wikidata', destination ? 'resolved' : 'no_match');
		return destination ? toRow(destination, 'wikidata', new Date().toISOString()) : null;
	} catch (error) {
		trace(request, stage, error instanceof Error ? error.name : 'unavailable');
		return null;
	}
}

async function finishLookup(env: Env, tmdbId: number, owner: string, status: string, retryAfter: number) {
	await env.DB.prepare(`UPDATE streaming_link_lookups SET status = ?, retry_after = ? WHERE tmdb_id = ? AND owner = ?`)
		.bind(status, retryAfter, tmdbId, owner)
		.run();
}

export async function reserveStreamingRequest(env: Env, nowSeconds: number): Promise<boolean> {
	const configured = Number(env.STREAMING_AVAILABILITY_MONTHLY_LIMIT ?? '900');
	const limit = Number.isInteger(configured) && configured >= 0 && configured <= 1000 ? configured : 900;
	if (limit === 0) return false;
	const period = new Date(nowSeconds * 1000).toISOString().slice(0, 7);
	const row = await env.DB.prepare(
		`INSERT INTO streaming_api_budget (period, requests) VALUES (?, 1)
		ON CONFLICT (period) DO UPDATE SET requests = requests + 1
		WHERE requests < ? AND blocked_until <= ? RETURNING requests`
	)
		.bind(period, limit, nowSeconds)
		.first();
	return row !== null;
}

async function backupLink(env: Env, request: RouteRequest): Promise<StreamingLinkResult> {
	if (!env.STREAMING_AVAILABILITY_API_KEY) {
		trace(request, 'streaming_availability', 'key_not_configured');
		return unresolved(request, 'temporarily_unavailable');
	}
	const now = Math.floor(Date.now() / 1000);
	const owner = crypto.randomUUID();
	// All countries and providers share this lease because one API response
	// contains every country. A miss is remembered for 30 days; failures for 1 hour.
	const lease = await env.DB.prepare(
		`INSERT INTO streaming_link_lookups (tmdb_id, owner, status, retry_after)
		VALUES (?, ?, 'loading', ?) ON CONFLICT (tmdb_id) DO UPDATE SET
		owner = excluded.owner, status = excluded.status, retry_after = excluded.retry_after
		WHERE retry_after <= ? RETURNING owner`
	)
		.bind(request.tmdbId, owner, now + 60, now)
		.first();
	if (!lease) {
		const cached = await cachedLink(env, request);
		if (cached) return resolved(request, cached, true);
		const lookup = await env.DB.prepare('SELECT status FROM streaming_link_lookups WHERE tmdb_id = ?')
			.bind(request.tmdbId)
			.first<{ status: string }>();
		trace(request, 'streaming_availability', 'previous_lookup_reused');
		return unresolved(
			request,
			lookup?.status === 'complete'
				? 'no_match'
				: lookup?.status === 'loading'
				? 'lookup_in_progress'
				: lookup?.status === 'quota'
				? 'quota_exhausted'
				: 'temporarily_unavailable'
		);
	}
	if (!(await reserveStreamingRequest(env, now))) {
		await finishLookup(env, request.tmdbId, owner, 'quota', now + 3600);
		trace(request, 'streaming_availability', 'budget_exhausted');
		return unresolved(request, 'quota_exhausted');
	}
	let candidates: StreamingCandidate[];
	try {
		trace(request, 'streaming_availability', 'request');
		const response = await fetch(`https://api.movieofthenight.com/v4/shows/movie/${request.tmdbId}`, {
			headers: { accept: 'application/json', 'X-API-Key': env.STREAMING_AVAILABILITY_API_KEY },
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			// Never forward the API key when an upstream redirects to another URL.
			redirect: 'manual',
		});
		if (response.status === 404) {
			await finishLookup(env, request.tmdbId, owner, 'complete', now + 30 * DAY_SECONDS);
			trace(request, 'streaming_availability', 'movie_not_found');
			return unresolved(request, 'no_match');
		}
		if (response.status === 429 || response.status === 401 || response.status === 403) {
			const reset = Date.parse(response.headers.get('x-quota-reset') ?? '');
			const blockedUntil = response.status === 429 && Number.isFinite(reset) ? Math.max(now + 3600, Math.floor(reset / 1000)) : now + 3600;
			await env.DB.prepare('UPDATE streaming_api_budget SET blocked_until = MAX(blocked_until, ?) WHERE period = ?')
				.bind(blockedUntil, new Date(now * 1000).toISOString().slice(0, 7))
				.run();
			await finishLookup(env, request.tmdbId, owner, 'quota', blockedUntil);
			trace(request, 'streaming_availability', `http_${response.status}`);
			return unresolved(request, response.status === 429 ? 'quota_exhausted' : 'temporarily_unavailable');
		}
		if (!response.ok) {
			trace(request, 'streaming_availability', `http_${response.status}`);
			throw new Error('Streaming Availability request failed.');
		}
		// Validate the movie identity before any returned data reaches D1.
		candidates = streamingCandidates(await response.json(), request.tmdbId);
	} catch (error) {
		await finishLookup(env, request.tmdbId, owner, 'failed', now + 3600);
		trace(request, 'streaming_availability', error instanceof Error ? error.name : 'unavailable');
		return unresolved(request, 'temporarily_unavailable');
	}

	const resolvedAt = new Date().toISOString();
	const statements = candidates.map((candidate) =>
		env.DB.prepare(
			`INSERT INTO streaming_link_candidates
		(tmdb_id, provider, region, web_url, provider_content_id, option_type, addon_id, resolved_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET
		provider_content_id = excluded.provider_content_id, resolved_at = excluded.resolved_at`
		).bind(
			request.tmdbId,
			candidate.provider,
			candidate.region,
			candidate.webUrl,
			candidate.providerContentId,
			candidate.optionType,
			candidate.addonId,
			resolvedAt
		)
	);
	for (const region of new Set(candidates.map((candidate) => candidate.region))) {
		for (const adapter of providerAdapters) {
			const destination = destinationFromCandidates(candidates, adapter, region);
			if (!destination) continue;
			for (const providerId of adapter.tmdbProviderIds) {
				const route = subscriptionRouteForProviderId(providerId)!;
				statements.push(
					saveLink(env, { tmdbId: request.tmdbId, providerId, region, route }, destination, 'streaming-availability', resolvedAt)
				);
			}
		}
	}
	const selected = destinationFromCandidates(candidates, adapterForRoute(request.route)!, request.region, request.route);
	if (selected) statements.push(saveLink(env, request, selected, 'streaming-availability', resolvedAt));
	// Small batches bound D1 request sizes. Finish the lookup only after every
	// mapping has been saved; a database failure must never trigger another API call.
	try {
		for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
		await finishLookup(env, request.tmdbId, owner, 'complete', now + 30 * DAY_SECONDS);
	} catch {
		await finishLookup(env, request.tmdbId, owner, 'failed', now + 3600);
		throw new Error('Streaming destination storage failed.');
	}
	const row = await cachedLink(env, request);
	trace(request, 'streaming_availability', row ? 'resolved' : 'no_match');
	return row ? resolved(request, row, false) : unresolved(request, 'no_match');
}

/** The optional catalog supports isolated route fixtures; the HTTP handler always uses the real catalog. */
export async function resolveStreamingLink(
	env: Env,
	input: StreamingLinkRequest,
	routes: readonly SubscriptionRoute[] = subscriptionRoutes
): Promise<StreamingLinkResult> {
	const route = subscriptionRouteForProviderId(input.providerId, routes);
	if (!route || !adapterForRoute(route)) return unresolved(input, 'unsupported_provider');
	const request: RouteRequest = { ...input, route };
	const cached = (await cachedLink(env, request)) ?? (await retainedLink(env, request));
	if (cached) {
		trace(request, 'd1', 'hit');
		return resolved(request, cached, true);
	}
	trace(request, 'd1', 'miss');
	const wiki = await wikidataLink(env, request);
	if (wiki) {
		await saveLink(env, request, destinationForRouteFromUrl(route, wiki.web_url)!, wiki.source, wiki.resolved_at).run();
		return resolved(request, wiki, false);
	}
	if (!adapterForRoute(route)!.service) return unresolved(request, 'no_match');
	return backupLink(env, request);
}
