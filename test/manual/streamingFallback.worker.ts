import { getStreamingLinkResponse } from '../../src/httpRouting/streamingLink';
import type { Env } from '../../src/shared/types';

/**
 * Local manual-test entry point. The test runner supplies an isolated D1
 * database and replaces only the primary lookup responses. The HTTP handler,
 * Netflix resolver, backup API request, and database writes are production code.
 * This file is never referenced by wrangler.jsonc or deployed.
 */
export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return getStreamingLinkResponse(new URL(request.url), env);
	},
};
