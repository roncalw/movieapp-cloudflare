import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import {
	parsePersonFamilyWikidataId,
	parseWikidataPersonFamilyPayloads,
	PersonFamilyRequestValidationError,
	WikidataPersonNotFoundError,
} from "../src/httpRouting/personFamily";

function itemStatement(
	id: string,
	options: {
		rank?: "preferred" | "normal" | "deprecated";
		start?: { time: string; precision: number };
		end?: { time: string; precision: number };
	} = {},
) {
	const qualifiers: Record<string, unknown[]> = {};

	if (options.start) {
		qualifiers.P580 = [
			{
				snaktype: "value",
				datavalue: { value: options.start },
			},
		];
	}

	if (options.end) {
		qualifiers.P582 = [
			{
				snaktype: "value",
				datavalue: { value: options.end },
			},
		];
	}

	return {
		rank: options.rank ?? "normal",
		mainsnak: {
			snaktype: "value",
			datavalue: { value: { id } },
		},
		qualifiers,
	};
}

describe("person family endpoint helpers", () => {
	it("normalizes a valid Wikidata person ID", () => {
		const url = new URL("https://example.com/people/family?wikidataId=q35332");

		expect(parsePersonFamilyWikidataId(url)).toBe("Q35332");
	});

	it("rejects missing, malformed, duplicate, or unsupported parameters", () => {
		const urls = [
			"https://example.com/people/family",
			"https://example.com/people/family?wikidataId=BradPitt",
			"https://example.com/people/family?wikidataId=Q35332&wikidataId=Q1",
			"https://example.com/people/family?wikidataId=Q35332&language=en",
		];

		for (const value of urls) {
			expect(() => parsePersonFamilyWikidataId(new URL(value))).toThrow(
				PersonFamilyRequestValidationError,
			);
		}
	});

	it("parses current and former marriages while preserving Wikidata date precision", () => {
		const personPayload = {
			entities: {
				Q35332: {
					claims: {
						P26: [
							itemStatement("Q100", {
								start: {
									time: "+2019-00-00T00:00:00Z",
									precision: 9,
								},
							}),
							itemStatement("Q200", {
								start: {
									time: "+2000-07-29T00:00:00Z",
									precision: 11,
								},
								end: {
									time: "+2005-10-00T00:00:00Z",
									precision: 10,
								},
							}),
							itemStatement("Q300", { rank: "deprecated" }),
						],
					},
				},
			},
		};
		const labelsPayload = {
			entities: {
				Q100: { labels: { en: { value: "Current Spouse" } } },
				Q200: { labels: { en: { value: "Former Spouse" } } },
				Q300: { labels: { en: { value: "Ignored Person" } } },
			},
		};

		const result = parseWikidataPersonFamilyPayloads("Q35332", personPayload, [
			labelsPayload,
		]);

		expect(result.spouses).toEqual([
			{
				wikidataId: "Q100",
				name: "Current Spouse",
				status: "current",
				startDate: { value: "2019", precision: "year" },
				endDate: null,
			},
			{
				wikidataId: "Q200",
				name: "Former Spouse",
				status: "former",
				startDate: { value: "2000-07-29", precision: "day" },
				endDate: { value: "2005-10", precision: "month" },
			},
		]);
	});

	it("keeps separate marriage periods, deduplicates children, and reads a child-count fallback", () => {
		const personPayload = {
			entities: {
				Q1: {
					claims: {
						P26: [
							itemStatement("Q2", {
								start: {
									time: "+1964-03-15T00:00:00Z",
									precision: 11,
								},
								end: {
									time: "+1974-06-26T00:00:00Z",
									precision: 11,
								},
							}),
							itemStatement("Q2", {
								start: {
									time: "+1975-10-10T00:00:00Z",
									precision: 11,
								},
								end: {
									time: "+1976-08-01T00:00:00Z",
									precision: 11,
								},
							}),
						],
						P40: [
							itemStatement("Q3"),
							itemStatement("Q3"),
							itemStatement("Q4"),
						],
						P1971: [
							{
								rank: "preferred",
								mainsnak: {
									snaktype: "value",
									datavalue: { value: { amount: "+4" } },
								},
							},
						],
					},
				},
			},
		};
		const labelsPayload = {
			entities: {
				Q2: { labels: { en: { value: "Same Spouse" } } },
				Q3: { labels: { en: { value: "Child One" } } },
				Q4: { labels: { en: { value: "Child Two" } } },
			},
		};

		const result = parseWikidataPersonFamilyPayloads("Q1", personPayload, [
			labelsPayload,
		]);

		expect(result.spouses).toHaveLength(2);
		expect(result.children).toEqual([
			{ wikidataId: "Q3", name: "Child One" },
			{ wikidataId: "Q4", name: "Child Two" },
		]);
		expect(result.numberOfChildren).toBe(4);
	});

	it("returns empty arrays when the Wikidata person has no family statements", () => {
		expect(
			parseWikidataPersonFamilyPayloads("Q106932301", {
				entities: { Q106932301: { claims: {} } },
			}),
		).toMatchObject({
			spouses: [],
			children: [],
			numberOfChildren: null,
		});
	});

	it("rejects a Wikidata response that does not contain the requested person", () => {
		expect(() =>
			parseWikidataPersonFamilyPayloads("Q999", {
				entities: { Q999: { missing: "" } },
			}),
		).toThrow(WikidataPersonNotFoundError);
	});

	it("wires validation through the public Worker route without consulting D1", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/people/family?wikidataId=not-an-item"),
			{} as Env,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "wikidataId must be a Wikidata item ID such as Q35332.",
		});
	});
});
