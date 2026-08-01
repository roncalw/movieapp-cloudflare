import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildTmdbPopularityExportUrl,
	fetchTmdbPopularityExport,
	getDefaultTmdbPopularitySourceDate,
	parseTmdbPopularityExportLine,
	validateTmdbPopularitySourceDate,
} from "../src/imports/tmdbPopularity";

describe("TMDb popularity bulk export", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("builds the dated TMDb movie export URL", () => {
		expect(buildTmdbPopularityExportUrl("2026-07-31")).toBe(
			"https://files.tmdb.org/p/exports/movie_ids_07_31_2026.json.gz",
		);
	});

	it("uses the current UTC date when no source date is supplied", () => {
		expect(
			getDefaultTmdbPopularitySourceDate(
				Date.parse("2026-07-31T23:59:59.000Z"),
			),
		).toBe("2026-07-31");
	});

	it("accepts current and recent exports but rejects future or stale dates", () => {
		const now = Date.parse("2026-07-31T12:00:00.000Z");

		expect(validateTmdbPopularitySourceDate("2026-07-31", now)).toBe(0);
		expect(validateTmdbPopularitySourceDate("2026-07-29", now)).toBe(2);
		expect(() =>
			validateTmdbPopularitySourceDate("2026-08-01", now),
		).toThrow("cannot be in the future");
		expect(() =>
			validateTmdbPopularitySourceDate("2026-07-28", now),
		).toThrow("maximum is 2");
	});

	it("parses a movie row and retains the TMDb popularity number exactly", () => {
		expect(
			parseTmdbPopularityExportLine(
				JSON.stringify({
					adult: false,
					id: 1284465,
					original_title: "The Death of Robin Hood",
					popularity: 309.2191,
					video: false,
				}),
			),
		).toEqual({
			row: { tmdb_id: 1284465, popularity: 309.2191 },
			excludedAdult: false,
			excludedVideo: false,
		});
	});

	it("reports adult and video flags so non-movie export rows are not staged", () => {
		const parsed = parseTmdbPopularityExportLine(
			JSON.stringify({
				adult: true,
				id: 99,
				popularity: 1.5,
				video: true,
			}),
		);

		expect(parsed.excludedAdult).toBe(true);
		expect(parsed.excludedVideo).toBe(true);
	});

	it("rejects malformed identifiers, popularity, and flags", () => {
		expect(() =>
			parseTmdbPopularityExportLine(
				'{"adult":false,"id":0,"popularity":1,"video":false}',
			),
		).toThrow("invalid movie ID");
		expect(() =>
			parseTmdbPopularityExportLine(
				'{"adult":false,"id":1,"popularity":-1,"video":false}',
			),
		).toThrow("invalid popularity value");
		expect(() =>
			parseTmdbPopularityExportLine(
				'{"adult":"false","id":1,"popularity":1,"video":false}',
			),
		).toThrow("invalid adult/video flags");
	});

	it("records a one-day fallback when the scheduled-date file is missing", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(
				new Response("compressed-file-placeholder", { status: 200 }),
			);

		const result = await fetchTmdbPopularityExport({
			requestedSourceDate: "2026-07-31",
			allowOneDayFallback: true,
			nowMs: Date.parse("2026-07-31T09:00:00.000Z"),
		});

		expect(result.sourceDate).toBe("2026-07-30");
		expect(result.usedFallback).toBe(true);
		expect(result.sourceAgeDays).toBe(1);
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://files.tmdb.org/p/exports/movie_ids_07_31_2026.json.gz",
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://files.tmdb.org/p/exports/movie_ids_07_30_2026.json.gz",
		);
	});
});
