import type { Env } from "../shared/types";

type AppleLookupResponse = {
	resultCount?: number;
	results?: Array<{
		trackName?: string;
		bundleId?: string;
		version?: string;
		trackViewUrl?: string;
		currentVersionReleaseDate?: string;
		releaseDate?: string;
		releaseNotes?: string;
	}>;
};

type GooglePlayRelease = {
	name?: string;
	releaseName?: string;
	status?: string;
	releaseLifecycleState?: string;
	versionCodes?: string[];
	activeArtifacts?: Array<{
		versionCode?: number | string;
	}>;
	releaseNotes?: Array<{
		language?: string;
		text?: string;
	}>;
};

type GooglePlayReleasesResponse = {
	releases?: GooglePlayRelease[];
};

export class AppVersionRequestValidationError extends Error {}

const APP_VERSION_CACHE_SECONDS = 60 * 60 * 24;
const APP_VERSION_PATH = "/app-version/latest";
const IOS_BUNDLE_ID = "com.codefest.movieapp";
const DEFAULT_ANDROID_PACKAGE_NAME = "com.codefest.movieapp";
const DEFAULT_GOOGLE_PLAY_TRACK = "production";
const GOOGLE_PLAY_AUTH_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

type StoreLookupStatus =
	| "ok"
	| "not_found"
	| "fetch_failed"
	| "configuration_missing";

type StoreVersionResult = {
	status: StoreLookupStatus;
	latestVersion: string | null;
	latestVersionCode?: number | null;
	latestVersionName?: string | null;
	storeUrl: string | null;
	name: string | null;
	releaseDate: string | null;
	releaseNotes: string | null;
	sourceUrl: string;
	packageName?: string;
	track?: string;
	error?: string;
};

function appVersionCacheHeaders(cacheStatus: "HIT" | "MISS") {
	return {
		"Cache-Control": `public, max-age=60, s-maxage=${APP_VERSION_CACHE_SECONDS}`,
		"CDN-Cache-Control": `public, max-age=${APP_VERSION_CACHE_SECONDS}`,
		"Cloudflare-CDN-Cache-Control": `public, max-age=${APP_VERSION_CACHE_SECONDS}`,
		"X-MovieApp-Cache": cacheStatus,
	};
}

function normalizeCountry(value: string | null) {
	const country =
		value === null || value.trim() === "" ? "us" : value.trim().toLowerCase();

	if (!/^[a-z]{2}$/.test(country)) {
		throw new AppVersionRequestValidationError(
			"country must be a two-letter country code.",
		);
	}

	return country;
}

export function parseAppVersionCountry(url: URL) {
	for (const paramName of url.searchParams.keys()) {
		if (paramName !== "country") {
			throw new AppVersionRequestValidationError(
				"This endpoint accepts only the country query parameter.",
			);
		}
	}

	return normalizeCountry(url.searchParams.get("country"));
}

export function parseAppleLookupPayload(
	payload: AppleLookupResponse,
	sourceUrl: string,
): StoreVersionResult {
	const result = payload.results?.[0];

	if (!result || payload.resultCount === 0) {
		return {
			status: "not_found",
			latestVersion: null,
			storeUrl: null,
			name: null,
			releaseDate: null,
			releaseNotes: null,
			sourceUrl,
			error: "Apple lookup did not return this bundle id.",
		};
	}

	return {
		status: "ok",
		latestVersion: result.version ?? null,
		storeUrl: result.trackViewUrl ?? null,
		name: result.trackName ?? null,
		releaseDate: result.currentVersionReleaseDate ?? result.releaseDate ?? null,
		releaseNotes: result.releaseNotes ?? null,
		sourceUrl,
	};
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64UrlEncodeJson(value: unknown) {
	return base64UrlEncodeBytes(
		new TextEncoder().encode(JSON.stringify(value)),
	);
}

function normalizePrivateKey(value: string) {
	const trimmed = value.trim();
	const unquoted =
		(trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) ||
		(trimmed.startsWith(`'`) && trimmed.endsWith(`'`))
			? trimmed.slice(1, -1)
			: trimmed;

	return unquoted.replace(/\\n/g, "\n");
}

function privateKeyPemToDer(value: string) {
	const base64 = normalizePrivateKey(value)
		.replace("-----BEGIN PRIVATE KEY-----", "")
		.replace("-----END PRIVATE KEY-----", "")
		.replace(/\s+/g, "");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);

	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	return bytes;
}

async function signGoogleServiceAccountJwt(
	env: Env,
	issuedAtSeconds: number,
) {
	if (
		!env.GOOGLE_PLAY_CLIENT_EMAIL ||
		!env.GOOGLE_PLAY_PRIVATE_KEY ||
		!env.GOOGLE_PLAY_TOKEN_URI
	) {
		return null;
	}

	const header = {
		alg: "RS256",
		typ: "JWT",
	};
	const payload = {
		iss: env.GOOGLE_PLAY_CLIENT_EMAIL,
		scope: GOOGLE_PLAY_AUTH_SCOPE,
		aud: env.GOOGLE_PLAY_TOKEN_URI,
		exp: issuedAtSeconds + 60 * 60,
		iat: issuedAtSeconds,
	};
	const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		privateKeyPemToDer(env.GOOGLE_PLAY_PRIVATE_KEY),
		{
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256",
		},
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);

	return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function fetchGoogleAccessToken(env: Env) {
	const tokenUri = env.GOOGLE_PLAY_TOKEN_URI;
	const assertion = await signGoogleServiceAccountJwt(
		env,
		Math.floor(Date.now() / 1000),
	);

	if (!tokenUri || !assertion) {
		return {
			ok: false as const,
			error:
				"Google Play service account credentials are missing from the Worker environment.",
		};
	}

	const body = new URLSearchParams({
		grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
		assertion,
	});
	const response = await fetch(tokenUri, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});

	if (!response.ok) {
		return {
			ok: false as const,
			error: `Google OAuth token endpoint returned HTTP ${response.status}.`,
		};
	}

	const payload = (await response.json()) as { access_token?: string };
	if (!payload.access_token) {
		return {
			ok: false as const,
			error: "Google OAuth token endpoint did not return an access token.",
		};
	}

	return {
		ok: true as const,
		accessToken: payload.access_token,
	};
}

async function readGoogleErrorMessage(response: Response) {
	const fallback = `HTTP ${response.status}`;

	try {
		const payload = (await response.json()) as {
			error?: {
				message?: string;
				status?: string;
			};
		};
		const message = payload.error?.message;
		const status = payload.error?.status;

		if (message && status) {
			return `${fallback}: ${status}: ${message}`;
		}

		return message ? `${fallback}: ${message}` : fallback;
	} catch {
		return fallback;
	}
}

function parseReleaseVersionCode(value: number | string) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isPublishedRelease(release: GooglePlayRelease) {
	return (
		release.status === "completed" ||
		release.status === "inProgress" ||
		release.releaseLifecycleState === "RELEASE_LIFECYCLE_STATE_PUBLISHED" ||
		release.releaseLifecycleState === "RELEASE_LIFECYCLE_STATE_IN_PROGRESS"
	);
}

function getReleaseDisplayName(release: GooglePlayRelease) {
	return release.name ?? release.releaseName ?? null;
}

function getReleaseVersionCodes(release: GooglePlayRelease) {
	const versionCodes = release.versionCodes ?? [];
	const activeArtifactVersionCodes =
		release.activeArtifacts
			?.map((artifact) => artifact.versionCode)
			.filter(
				(versionCode): versionCode is number | string =>
					versionCode !== undefined,
			) ?? [];

	return [...versionCodes, ...activeArtifactVersionCodes];
}

export function parseGooglePlayReleasesPayload(
	payload: GooglePlayReleasesResponse,
	sourceUrl: string,
	packageName: string,
	track: string,
): StoreVersionResult {
	const candidates = (payload.releases ?? [])
		.filter(isPublishedRelease)
		.flatMap((release) =>
			getReleaseVersionCodes(release)
				.map((rawVersionCode) => ({
					release,
					versionCode: parseReleaseVersionCode(rawVersionCode),
				}))
				.filter(
					(
						item,
					): item is { release: GooglePlayRelease; versionCode: number } =>
						item.versionCode !== null,
				),
		)
		.sort((left, right) => right.versionCode - left.versionCode);

	const latest = candidates[0];
	if (!latest) {
		return {
			status: "not_found",
			latestVersion: null,
			latestVersionCode: null,
			latestVersionName: null,
			storeUrl: `https://play.google.com/store/apps/details?id=${packageName}`,
			name: null,
			releaseDate: null,
			releaseNotes: null,
			sourceUrl,
			packageName,
			track,
			error: "Google Play did not return a published release with a versionCode.",
		};
	}

	const latestVersionName = getReleaseDisplayName(latest.release);
	const englishReleaseNotes =
		latest.release.releaseNotes?.find((note) =>
			(note.language ?? "").toLowerCase().startsWith("en"),
		)?.text ??
		latest.release.releaseNotes?.[0]?.text ??
		null;

	return {
		status: "ok",
		latestVersion: latestVersionName ?? String(latest.versionCode),
		latestVersionCode: latest.versionCode,
		latestVersionName,
		storeUrl: `https://play.google.com/store/apps/details?id=${packageName}`,
		name: latestVersionName,
		releaseDate: null,
		releaseNotes: englishReleaseNotes,
		sourceUrl,
		packageName,
		track,
	};
}

function getGooglePlayPackageName(env: Env) {
	return env.GOOGLE_PLAY_PACKAGE_NAME || DEFAULT_ANDROID_PACKAGE_NAME;
}

function getGooglePlayTrack(env: Env) {
	return env.GOOGLE_PLAY_TRACK || DEFAULT_GOOGLE_PLAY_TRACK;
}

async function fetchAndroidVersion(env: Env): Promise<StoreVersionResult> {
	const packageName = getGooglePlayPackageName(env);
	const track = getGooglePlayTrack(env);
	const sourceUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/tracks/${track}/releases`;
	const token = await fetchGoogleAccessToken(env);

	if (!token.ok) {
		return {
			status: "configuration_missing",
			latestVersion: null,
			latestVersionCode: null,
			latestVersionName: null,
			storeUrl: `https://play.google.com/store/apps/details?id=${packageName}`,
			name: null,
			releaseDate: null,
			releaseNotes: null,
			sourceUrl,
			packageName,
			track,
			error: token.error,
		};
	}

	try {
		const response = await fetch(sourceUrl, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${token.accessToken}`,
			},
		});

		if (!response.ok) {
			const googleError = await readGoogleErrorMessage(response);

			return {
				status: response.status === 404 ? "not_found" : "fetch_failed",
				latestVersion: null,
				latestVersionCode: null,
				latestVersionName: null,
				storeUrl: `https://play.google.com/store/apps/details?id=${packageName}`,
				name: null,
				releaseDate: null,
				releaseNotes: null,
				sourceUrl,
				packageName,
				track,
				error: `Google Play Developer API returned ${googleError}.`,
			};
		}

		return parseGooglePlayReleasesPayload(
			(await response.json()) as GooglePlayReleasesResponse,
			sourceUrl,
			packageName,
			track,
		);
	} catch (error) {
		return {
			status: "fetch_failed",
			latestVersion: null,
			latestVersionCode: null,
			latestVersionName: null,
			storeUrl: `https://play.google.com/store/apps/details?id=${packageName}`,
			name: null,
			releaseDate: null,
			releaseNotes: null,
			sourceUrl,
			packageName,
			track,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function fetchAppleVersion(country: string): Promise<StoreVersionResult> {
	const sourceUrl = `https://itunes.apple.com/lookup?bundleId=${IOS_BUNDLE_ID}&country=${country}`;

	try {
		const response = await fetch(sourceUrl, {
			headers: { accept: "application/json" },
		});

		if (!response.ok) {
			return {
				status: "fetch_failed",
				latestVersion: null,
				storeUrl: null,
				name: null,
				releaseDate: null,
				releaseNotes: null,
				sourceUrl,
				error: `Apple lookup returned HTTP ${response.status}.`,
			};
		}

		return parseAppleLookupPayload(await response.json(), sourceUrl);
	} catch (error) {
		return {
			status: "fetch_failed",
			latestVersion: null,
			storeUrl: null,
			name: null,
			releaseDate: null,
			releaseNotes: null,
			sourceUrl,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getCachedAppVersionResponse(
	request: Request,
	env: Env,
	url: URL,
	ctx?: ExecutionContext,
) {
	const country = parseAppVersionCountry(url);

	const cacheUrl = new URL(request.url);
	cacheUrl.pathname = APP_VERSION_PATH;
	cacheUrl.search = `?country=${country}`;

	const cacheKey = new Request(cacheUrl.toString(), request);
	const cache = caches.default;
	const cachedResponse = await cache.match(cacheKey).catch(() => undefined);

	if (cachedResponse) {
		return new Response(cachedResponse.body, {
			headers: {
				"content-type":
					cachedResponse.headers.get("content-type") ??
					"application/json; charset=UTF-8",
				...appVersionCacheHeaders("HIT"),
			},
			status: cachedResponse.status,
			statusText: cachedResponse.statusText,
		});
	}

	const [ios, android] = await Promise.all([
		fetchAppleVersion(country),
		fetchAndroidVersion(env),
	]);

	const response = Response.json(
		{
			appId: {
				iosBundleId: IOS_BUNDLE_ID,
				androidPackageName: getGooglePlayPackageName(env),
			},
			country,
			fetchedAt: new Date().toISOString(),
			cacheMaxAgeSeconds: APP_VERSION_CACHE_SECONDS,
			ios,
			android,
		},
		{ headers: appVersionCacheHeaders("MISS") },
	);

	const cachePut = cache.put(cacheKey, response.clone()).catch(() => undefined);
	if (ctx) {
		ctx.waitUntil(cachePut);
	} else {
		await cachePut;
	}

	return response;
}
