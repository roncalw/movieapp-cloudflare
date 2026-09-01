import type { Env } from '../shared/types';
import { resolveStreamingLink, type StreamingLinkRequest } from '../streaming/streamingLinkResolver';

export class StreamingLinkValidationError extends Error {}

export function parseStreamingLinkRequest(url: URL): StreamingLinkRequest {
	const allowed = ['tmdbId', 'providerId', 'region'];
	for (const name of url.searchParams.keys()) {
		if (!allowed.includes(name)) throw new StreamingLinkValidationError('Only tmdbId, providerId, and region are supported.');
	}
	for (const name of allowed) {
		if (url.searchParams.getAll(name).length !== 1) throw new StreamingLinkValidationError(`${name} must be provided exactly once.`);
	}
	function positiveId(name: string) {
		const raw = url.searchParams.get(name)!;
		const value = Number(raw);
		if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > 2147483647) {
			throw new StreamingLinkValidationError(`${name} must be a positive 32-bit integer.`);
		}
		return value;
	}
	const region = url.searchParams.get('region')!.toUpperCase();
	if (!/^[A-Z]{2}$/.test(region)) throw new StreamingLinkValidationError('region must be a two-letter country code.');
	return { tmdbId: positiveId('tmdbId'), providerId: positiveId('providerId'), region };
}

export async function getStreamingLinkResponse(url: URL, env: Env): Promise<Response> {
	try {
		const request = parseStreamingLinkRequest(url);
		const result = await resolveStreamingLink(env, request);
		return Response.json(result, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		if (error instanceof StreamingLinkValidationError) return Response.json({ error: error.message }, { status: 400 });
		console.error('Streaming link resolver failed. No destination was returned.');
		return Response.json(
			{ error: 'Streaming destination is temporarily unavailable.' },
			{ status: 503, headers: { 'cache-control': 'no-store' } }
		);
	}
}
