import { describe, expect, it } from "vitest";
import type { Env } from "../src/shared/types";
import {
	buildInitialOriginalLanguageBackfillProgress,
	updateOriginalLanguagesForPage,
} from "../src/imports/tmdbOriginalLanguageBackfill";
import { normalizeLanguageRows } from "../src/imports/tmdbLookupRefresh";
import { normalizeOriginalLanguage } from "../src/imports/tmdbPrimary";
import { addDefaultOriginalLanguageToCacheWarmUrl } from "../src/cache/cacheWarmJob";

describe("original-language data handling", () => {
	it("normalizes valid TMDB language codes without assuming English", () => {
		expect(normalizeOriginalLanguage(" EN ")).toBe("en");
		expect(normalizeOriginalLanguage("ko")).toBe("ko");
		expect(normalizeOriginalLanguage("ZHO")).toBe("zho");
		expect(normalizeOriginalLanguage("")).toBeNull();
		expect(normalizeOriginalLanguage("english")).toBeNull();
		expect(normalizeOriginalLanguage(null)).toBeNull();
	});

	it("uses TMDB's English and native language names", () => {
		expect(
			normalizeLanguageRows([
				{
					iso_639_1: "ko",
					english_name: "Korean",
					name: "한국어/조선말",
				},
				{
					iso_639_1: " en ",
					english_name: " English ",
					name: "English",
				},
				{
					iso_639_1: "ko",
					english_name: "Korean",
					name: "",
				},
				{
					iso_639_1: "invalid",
					english_name: "Invalid",
					name: "",
				},
			]),
		).toEqual([
			{
				languageCode: "en",
				englishName: "English",
				nativeName: "English",
			},
			{
				languageCode: "ko",
				englishName: "Korean",
				nativeName: null,
			},
		]);
	});

	it("starts a resumable full-history checkpoint", () => {
		const progress = buildInitialOriginalLanguageBackfillProgress("2026-07-30");

		expect(progress).toMatchObject({
			phase: "original_language_backfill",
			status: "running",
			beginDate: "1874-01-01",
			endDate: "2026-07-30",
			pagesRead: 0,
			rowsSeen: 0,
			stagingRowsUpdated: 0,
			movieListRowsUpdated: 0,
		});
		expect(progress.pendingWindows).toEqual([
			{ beginDate: "1874-01-01", endDate: "2026-07-30" },
		]);
	});

	it("warms the English cache variant used by the default mobile filter", () => {
		expect(
			addDefaultOriginalLanguageToCacheWarmUrl(
				"https://example.com/movies/search?pageSize=20&genreIds=27",
			),
		).toBe(
			"https://example.com/movies/search?genreIds=27&originalLanguages=en&pageSize=20",
		);
	});

	it("backfills only original_language on matching existing movie IDs", async () => {
		const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind(...bindings: unknown[]) {
							prepared.push({ sql, bindings });
							return this;
						},
					};
				},
				async batch(statements: unknown[]) {
					return statements.map(() => ({
						meta: { changes: 1 },
					}));
				},
			},
		} as unknown as Env;

		const result = await updateOriginalLanguagesForPage(env, [
			{ id: 1526650, original_language: "zh" },
			{ id: 1, original_language: null },
		]);

		expect(result).toEqual({
			rowsWithoutLanguage: 1,
			stagingRowsUpdated: 1,
			movieListRowsUpdated: 1,
		});
		expect(prepared).toHaveLength(2);
		expect(prepared[0].sql).toContain("UPDATE tmdb_movies_staging");
		expect(prepared[1].sql).toContain("UPDATE movie_list_items");

		for (const statement of prepared) {
			expect(statement.sql).toContain("SET original_language = CASE tmdb_id");
			expect(statement.sql).toContain("WHERE tmdb_id IN (?)");
			expect(statement.sql).not.toContain("title");
			expect(statement.sql).not.toContain("poster_path");
			expect(statement.sql).not.toContain("release_date");
			expect(statement.bindings).toEqual([
				1526650,
				"zh",
				1526650,
				1526650,
				"zh",
			]);
		}
	});

	it("stops if D1 reports more changed rows than the page can contain", async () => {
		const env = {
			DB: {
				prepare() {
					return {
						bind() {
							return this;
						},
					};
				},
				async batch(statements: unknown[]) {
					return statements.map(() => ({
						meta: { changes: 2 },
					}));
				},
			},
		} as unknown as Env;

		await expect(
			updateOriginalLanguagesForPage(env, [
				{ id: 1526650, original_language: "zh" },
			]),
		).rejects.toThrow(
			"TMDB original-language backfill exceeded its per-table update ceiling.",
		);
	});
});
