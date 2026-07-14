/**
 * Cached Wikidata family lookup for MovieApp person profiles.
 *
 * Data flow:
 * 1. MovieApp obtains a person's Wikidata ID from TMDB.
 * 2. This endpoint reads spouse and child statements from Wikidata.
 * 3. It resolves the related Wikidata IDs to human-readable names.
 * 4. It returns a small MovieApp-specific response and caches it at the edge.
 *
 * This module is intentionally stateless. It does not read or write D1.
 */

const PERSON_FAMILY_PATH = "/people/family";
const PERSON_FAMILY_CACHE_SECONDS = 60 * 60 * 24 * 7;
const WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php";
const WIKIDATA_USER_AGENT =
	"MovieApp/1.0 (https://codefest.com; admin@codefest.com)";
const WIKIDATA_ENTITY_BATCH_SIZE = 50;

const SPOUSE_PROPERTY = "P26";
const CHILD_PROPERTY = "P40";
const NUMBER_OF_CHILDREN_PROPERTY = "P1971";
const START_TIME_QUALIFIER = "P580";
const END_TIME_QUALIFIER = "P582";

type WikidataRank = "preferred" | "normal" | "deprecated";

type WikidataDataValue = {
	value?: unknown;
};

type WikidataSnak = {
	snaktype?: string;
	datavalue?: WikidataDataValue;
};

type WikidataStatement = {
	rank?: WikidataRank;
	mainsnak?: WikidataSnak;
	qualifiers?: Record<string, WikidataSnak[]>;
};

type WikidataEntity = {
	id?: string;
	missing?: string;
	labels?: Record<string, { language?: string; value?: string }>;
	claims?: Record<string, WikidataStatement[]>;
};

type WikidataEntitiesResponse = {
	entities?: Record<string, WikidataEntity>;
};

export type PersonFamilyDate = {
	value: string;
	precision: "year" | "month" | "day";
};

export type PersonFamilySpouse = {
	wikidataId: string;
	name: string;
	status: "current" | "former";
	startDate: PersonFamilyDate | null;
	endDate: PersonFamilyDate | null;
};

export type PersonFamilyChild = {
	wikidataId: string;
	name: string | null;
};

export type PersonFamilyData = {
	wikidataId: string;
	spouses: PersonFamilySpouse[];
	children: PersonFamilyChild[];
	numberOfChildren: number | null;
	sourceUrl: string;
};

export class PersonFamilyRequestValidationError extends Error {}
export class WikidataPersonNotFoundError extends Error {}
export class WikidataPersonFamilyUpstreamError extends Error {}

function personFamilyCacheHeaders(cacheStatus: "HIT" | "MISS") {
	return {
		"Cache-Control": `public, max-age=60, s-maxage=${PERSON_FAMILY_CACHE_SECONDS}`,
		"CDN-Cache-Control": `public, max-age=${PERSON_FAMILY_CACHE_SECONDS}`,
		"Cloudflare-CDN-Cache-Control": `public, max-age=${PERSON_FAMILY_CACHE_SECONDS}`,
		"X-MovieApp-Cache": cacheStatus,
	};
}

export function parsePersonFamilyWikidataId(url: URL) {
	for (const paramName of url.searchParams.keys()) {
		if (paramName !== "wikidataId") {
			throw new PersonFamilyRequestValidationError(
				"This endpoint accepts only the wikidataId query parameter.",
			);
		}
	}

	const values = url.searchParams.getAll("wikidataId");
	if (values.length !== 1) {
		throw new PersonFamilyRequestValidationError(
			"wikidataId must be provided exactly once.",
		);
	}

	const wikidataId = values[0].trim().toUpperCase();
	if (!/^Q[1-9]\d*$/.test(wikidataId)) {
		throw new PersonFamilyRequestValidationError(
			"wikidataId must be a Wikidata item ID such as Q35332.",
		);
	}

	return wikidataId;
}

function getEntity(payload: WikidataEntitiesResponse, wikidataId: string) {
	const entity = payload.entities?.[wikidataId];

	if (!entity || entity.missing !== undefined) {
		throw new WikidataPersonNotFoundError(
			`Wikidata item ${wikidataId} was not found.`,
		);
	}

	return entity;
}

function getNonDeprecatedStatements(entity: WikidataEntity, property: string) {
	return (entity.claims?.[property] ?? []).filter(
		(statement) => statement.rank !== "deprecated",
	);
}

function getItemId(snak: WikidataSnak | undefined) {
	if (snak?.snaktype !== "value") {
		return null;
	}

	const value = snak.datavalue?.value;
	if (!value || typeof value !== "object" || !("id" in value)) {
		return null;
	}

	const id = (value as { id?: unknown }).id;
	return typeof id === "string" && /^Q[1-9]\d*$/.test(id) ? id : null;
}

function getTimeQualifier(
	statement: WikidataStatement,
	qualifier: string,
): PersonFamilyDate | null {
	const snak = statement.qualifiers?.[qualifier]?.find(
		(candidate) => candidate.snaktype === "value",
	);
	const value = snak?.datavalue?.value;

	if (!value || typeof value !== "object") {
		return null;
	}

	const { time, precision } = value as {
		time?: unknown;
		precision?: unknown;
	};
	if (typeof time !== "string" || typeof precision !== "number") {
		return null;
	}

	const match = /^\+(\d{4,})-(\d{2})-(\d{2})T/.exec(time);
	if (!match || precision < 9) {
		return null;
	}

	const [, year, month, day] = match;
	if (precision >= 11) {
		return { value: `${year}-${month}-${day}`, precision: "day" };
	}

	if (precision === 10) {
		return { value: `${year}-${month}`, precision: "month" };
	}

	return { value: year, precision: "year" };
}

function getNumberOfChildren(entity: WikidataEntity) {
	const statements = getNonDeprecatedStatements(
		entity,
		NUMBER_OF_CHILDREN_PROPERTY,
	).sort((left, right) => {
		if (left.rank === right.rank) {
			return 0;
		}

		return left.rank === "preferred" ? -1 : 1;
	});

	for (const statement of statements) {
		const value = statement.mainsnak?.datavalue?.value;
		if (!value || typeof value !== "object" || !("amount" in value)) {
			continue;
		}

		const amount = Number((value as { amount?: unknown }).amount);
		if (Number.isSafeInteger(amount) && amount >= 0) {
			return amount;
		}
	}

	return null;
}

function collectRelatedIds(entity: WikidataEntity) {
	const relatedIds = new Set<string>();

	for (const property of [SPOUSE_PROPERTY, CHILD_PROPERTY]) {
		for (const statement of getNonDeprecatedStatements(entity, property)) {
			const id = getItemId(statement.mainsnak);
			if (id) {
				relatedIds.add(id);
			}
		}
	}

	return [...relatedIds];
}

function buildLabelMap(payloads: WikidataEntitiesResponse[]) {
	const labels = new Map<string, string>();

	for (const payload of payloads) {
		for (const [id, entity] of Object.entries(payload.entities ?? {})) {
			const englishLabel = entity.labels?.en?.value;
			const fallbackLabel = Object.values(entity.labels ?? {}).find(
				(label) => typeof label.value === "string" && label.value.length > 0,
			)?.value;
			const label = englishLabel ?? fallbackLabel;

			if (label) {
				labels.set(id, label);
			}
		}
	}

	return labels;
}

function compareSpouses(left: PersonFamilySpouse, right: PersonFamilySpouse) {
	if (left.status !== right.status) {
		return left.status === "current" ? -1 : 1;
	}

	const leftDate = left.endDate?.value ?? left.startDate?.value ?? "";
	const rightDate = right.endDate?.value ?? right.startDate?.value ?? "";
	if (leftDate !== rightDate) {
		return rightDate.localeCompare(leftDate);
	}

	return left.name.localeCompare(right.name);
}

export function parseWikidataPersonFamilyPayloads(
	wikidataId: string,
	personPayload: WikidataEntitiesResponse,
	labelPayloads: WikidataEntitiesResponse[] = [],
): PersonFamilyData {
	const entity = getEntity(personPayload, wikidataId);
	const labels = buildLabelMap(labelPayloads);
	const seenMarriageStatements = new Set<string>();
	const spouses = getNonDeprecatedStatements(entity, SPOUSE_PROPERTY)
		.map((statement): PersonFamilySpouse | null => {
			const spouseId = getItemId(statement.mainsnak);
			if (!spouseId) {
				return null;
			}

			const startDate = getTimeQualifier(statement, START_TIME_QUALIFIER);
			const endDate = getTimeQualifier(statement, END_TIME_QUALIFIER);
			const statementKey = [
				spouseId,
				startDate?.value ?? "",
				endDate?.value ?? "",
			].join(":");

			if (seenMarriageStatements.has(statementKey)) {
				return null;
			}
			seenMarriageStatements.add(statementKey);

			return {
				wikidataId: spouseId,
				name: labels.get(spouseId) ?? spouseId,
				status: endDate ? "former" : "current",
				startDate,
				endDate,
			};
		})
		.filter((spouse): spouse is PersonFamilySpouse => spouse !== null)
		.sort(compareSpouses);

	const seenChildren = new Set<string>();
	const children = getNonDeprecatedStatements(entity, CHILD_PROPERTY)
		.map((statement): PersonFamilyChild | null => {
			const childId = getItemId(statement.mainsnak);
			if (!childId || seenChildren.has(childId)) {
				return null;
			}
			seenChildren.add(childId);

			return {
				wikidataId: childId,
				name: labels.get(childId) ?? null,
			};
		})
		.filter((child): child is PersonFamilyChild => child !== null)
		.sort((left, right) =>
			(left.name ?? left.wikidataId).localeCompare(
				right.name ?? right.wikidataId,
			),
		);

	return {
		wikidataId,
		spouses,
		children,
		numberOfChildren: getNumberOfChildren(entity),
		sourceUrl: `https://www.wikidata.org/wiki/${wikidataId}`,
	};
}

async function fetchWikidataEntities(
	ids: string[],
	props: "claims" | "labels",
) {
	const url = new URL(WIKIDATA_API_URL);
	url.searchParams.set("action", "wbgetentities");
	url.searchParams.set("ids", ids.join("|"));
	url.searchParams.set("props", props);
	url.searchParams.set("format", "json");
	url.searchParams.set("maxlag", "5");

	if (props === "labels") {
		url.searchParams.set("languages", "en");
		url.searchParams.set("languagefallback", "1");
	}

	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				accept: "application/json",
				"user-agent": WIKIDATA_USER_AGENT,
			},
		});
	} catch (error) {
		throw new WikidataPersonFamilyUpstreamError(
			error instanceof Error ? error.message : String(error),
		);
	}

	if (!response.ok) {
		throw new WikidataPersonFamilyUpstreamError(
			`Wikidata returned HTTP ${response.status}.`,
		);
	}

	try {
		return (await response.json()) as WikidataEntitiesResponse;
	} catch (error) {
		throw new WikidataPersonFamilyUpstreamError(
			error instanceof Error ? error.message : String(error),
		);
	}
}

async function loadPersonFamily(wikidataId: string) {
	const personPayload = await fetchWikidataEntities([wikidataId], "claims");
	const entity = getEntity(personPayload, wikidataId);
	const relatedIds = collectRelatedIds(entity);
	const labelPayloads: WikidataEntitiesResponse[] = [];

	for (
		let index = 0;
		index < relatedIds.length;
		index += WIKIDATA_ENTITY_BATCH_SIZE
	) {
		labelPayloads.push(
			await fetchWikidataEntities(
				relatedIds.slice(index, index + WIKIDATA_ENTITY_BATCH_SIZE),
				"labels",
			),
		);
	}

	return parseWikidataPersonFamilyPayloads(
		wikidataId,
		personPayload,
		labelPayloads,
	);
}

export async function getCachedPersonFamilyResponse(
	request: Request,
	url: URL,
	ctx?: ExecutionContext,
) {
	const wikidataId = parsePersonFamilyWikidataId(url);
	const cacheUrl = new URL(request.url);
	cacheUrl.pathname = PERSON_FAMILY_PATH;
	cacheUrl.search = `?wikidataId=${wikidataId}`;

	const cacheKey = new Request(cacheUrl.toString(), request);
	const cache = caches.default;
	const cachedResponse = await cache.match(cacheKey).catch(() => undefined);

	if (cachedResponse) {
		return new Response(cachedResponse.body, {
			headers: {
				"content-type":
					cachedResponse.headers.get("content-type") ??
					"application/json; charset=UTF-8",
				...personFamilyCacheHeaders("HIT"),
			},
			status: cachedResponse.status,
			statusText: cachedResponse.statusText,
		});
	}

	const family = await loadPersonFamily(wikidataId);
	const response = Response.json(
		{
			...family,
			fetchedAt: new Date().toISOString(),
			cacheMaxAgeSeconds: PERSON_FAMILY_CACHE_SECONDS,
		},
		{ headers: personFamilyCacheHeaders("MISS") },
	);

	const cachePut = cache.put(cacheKey, response.clone()).catch(() => undefined);
	if (ctx) {
		ctx.waitUntil(cachePut);
	} else {
		await cachePut;
	}

	return response;
}
