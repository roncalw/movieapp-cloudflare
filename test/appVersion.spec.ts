import { describe, expect, it } from "vitest";
import {
	AppVersionRequestValidationError,
	parseAppleLookupPayload,
	parseAppVersionCountry,
	parseGooglePlayReleasesPayload,
} from "../src/httpRouting/appVersion";

describe("app version endpoint helpers", () => {
	it("defaults the app-version country to us", () => {
		const url = new URL("https://example.com/app-version/latest");

		expect(parseAppVersionCountry(url)).toBe("us");
	});

	it("normalizes a valid app-version country", () => {
		const url = new URL("https://example.com/app-version/latest?country=CA");

		expect(parseAppVersionCountry(url)).toBe("ca");
	});

	it("rejects unsupported app-version query parameters", () => {
		const url = new URL(
			"https://example.com/app-version/latest?country=us&platform=android",
		);

		expect(() => parseAppVersionCountry(url)).toThrow(
			AppVersionRequestValidationError,
		);
	});

	it("parses the Apple lookup version payload", () => {
		const sourceUrl =
			"https://itunes.apple.com/lookup?bundleId=com.codefest.movieapp&country=us";

		expect(
			parseAppleLookupPayload(
				{
					resultCount: 1,
					results: [
						{
							trackName: "Movie Search: It's Movie Time!",
							version: "3.3.1",
							trackViewUrl: "https://apps.apple.com/app/id123",
							currentVersionReleaseDate: "2026-06-08T12:00:00Z",
							releaseNotes: "Bug fixes",
						},
					],
				},
				sourceUrl,
			),
		).toMatchObject({
			status: "ok",
			latestVersion: "3.3.1",
			storeUrl: "https://apps.apple.com/app/id123",
			name: "Movie Search: It's Movie Time!",
			releaseDate: "2026-06-08T12:00:00Z",
			releaseNotes: "Bug fixes",
			sourceUrl,
		});
	});

	it("uses the highest published Google Play versionCode", () => {
		const result = parseGooglePlayReleasesPayload(
			{
				releases: [
					{
						name: "3.3.0",
						status: "completed",
						versionCodes: ["72"],
					},
					{
						releaseName: "73 (3.3.1)",
						releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
						activeArtifacts: [{ versionCode: 73 }],
						releaseNotes: [{ language: "en-US", text: "Current release" }],
					},
					{
						name: "draft future build",
						status: "draft",
						versionCodes: ["999"],
					},
				],
			},
			"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.codefest.movieapp/tracks/production/releases",
			"com.codefest.movieapp",
			"production",
		);

		expect(result).toMatchObject({
			status: "ok",
			latestVersion: "73 (3.3.1)",
			latestVersionCode: 73,
			latestVersionName: "73 (3.3.1)",
			releaseNotes: "Current release",
			packageName: "com.codefest.movieapp",
			track: "production",
			storeUrl:
				"https://play.google.com/store/apps/details?id=com.codefest.movieapp",
		});
	});

	it("reports not_found when Google Play returns no published versionCode", () => {
		const result = parseGooglePlayReleasesPayload(
			{
				releases: [
					{
						name: "draft future build",
						status: "draft",
						versionCodes: ["999"],
					},
				],
			},
			"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.codefest.movieapp/tracks/production/releases",
			"com.codefest.movieapp",
			"production",
		);

		expect(result).toMatchObject({
			status: "not_found",
			latestVersion: null,
			latestVersionCode: null,
			latestVersionName: null,
			packageName: "com.codefest.movieapp",
			track: "production",
		});
	});
});
