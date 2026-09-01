# Subscription movie-link resolver

The resolver translates a TMDB movie ID into an exact movie destination for the subscription provider the user tapped. It does **not** decide whether that provider currently carries the movie. MovieApp still uses TMDB's US watch-provider response to decide which provider rows to display.

## What happens when someone taps a provider

1. MovieApp sends the movie ID, TMDB provider ID, and country to `GET /streaming-link`.
2. The Worker classifies the exact TMDB provider ID using `subscriptionRoutes.ts`, then checks `movie_streaming_route_links` in D1 for that exact movie, route, and country. A valid saved destination returns immediately, with no external request. Previously retained API candidates are also checked here, so links collected during the Netflix release can be reused.
3. On a miss, the existing TMDB client requests the movie's external IDs. Its Wikidata ID identifies the movie's Wikidata record; it is not a Netflix ID.
4. The Worker reads the record's structured claims. The playback-platform adapter identifies which properties to inspect; for example, `P1874` supplies a Netflix ID. The Worker saves it and returns without calling the backup API.
5. If that fails, the Worker requests the movie once from Streaming Availability. The response includes all countries and services, so the Worker saves useful results from the entire response.
6. MovieApp uses the exact HTTPS title page. Netflix retains its verified native URL first, with the same movie page as its fallback. No other custom app scheme is guessed.

For example, TMDB movie `492188` is **Marriage Story**. TMDB returns Wikidata item `Q48671199`, whose Netflix ID is `80223779`. The two returned destinations are:

```text
nflx://www.netflix.com/watch/80223779
https://www.netflix.com/title/80223779
```

## Subscription routes, August 31, 2026

Current route-aware deployment: `878e4607-c2d1-44a8-b243-ce2b92c5fe9b`. Migration 0030 is applied. It adds a separate route table without deleting or changing the legacy direct-provider table.

TMDB distinguishes AMC+ direct (`526`) from AMC+ Amazon Channel (`528`), and STARZ direct (`43`) from STARZ Amazon Channel (`1794`). These IDs remain distinct from availability through rendering, the request, and the D1 key. The display name describes the content service; the category and playback platform describe where the user watches it.

| Selected route | Category | Adapter used to resolve the movie |
| --- | --- | --- |
| AMC+ 526 | Direct, without a category heading | AMC+ |
| AMC+ 528 | Prime Video Channels | Prime Video |
| STARZ 1794 | Prime Video Channels | Prime Video |
| AMC+ 1854 / STARZ 1855 | Apple TV Channels | Apple TV |
| AMC+ 635 / STARZ 634 | The Roku Channel | Roku |

The shared `subscriptionRoutes.ts` catalog includes 15 direct IDs and 147 channel IDs. Of the channel routes, 113 have verified US Movie of the Night add-on identifiers. The others can use a valid platform-specific Wikidata destination where sufficient; they never match a guessed API add-on. Unsupported new providers remain visible in MovieApp without a launch action. The catalog does not add providers to a movie or change Advanced Search filters.

For an API channel candidate to qualify, its country, playback service, `addon` type, and exact add-on ID must match the selected route. A base Prime subscription, rental, or another channel is not a substitute. Apple channel links also retain and validate the `playableId` offer selector, so AMC+ cannot silently become an Apple Store rental. Apple channel resolution skips bare Wikidata Apple IDs because those IDs cannot identify a channel offer.

**Hulu through Disney+ is a data-source gap, not an AMC+/STARZ limitation.** The current global TMDB provider catalog has no separate Hulu-through-Disney ID. Movie of the Night does explicitly return Disney's `hulu` add-on for Late Night with the Devil. The unbound `huluDisneyRouteTemplate` supports that distinction, but is not in the live route catalog. Tests bind it to fictional ID `999001`; the public endpoint rejects that ID. Do not add this row based on standalone Hulu, simultaneous Hulu/Disney availability, or a D1 record. A future live binding requires an explicit availability identifier or an approved change to the availability-source policy.

The manual `scripts/verify-subscription-routes.mjs` harness ran the production resolver with empty isolated D1 storage and deliberately missing primary IDs. Two real backup calls resolved 12 routes for Late Night with the Devil and Michael, including the explicit Hulu/Disney mock. Every repeat used D1 with no further network request. Production separately resolved 12 real routes, and their repeats also used D1. All 160 Worker tests and 172 app tests pass. Both source typechecks pass.

Sanitized route responses, the captured TMDB catalogs, and production D1 records are under `.codex/verification/subscription-routes/`. The app report at `MovieApp/.codex/SubscriptionRoutes.md` explains the iOS/Android checks and browser limitations. The manual harness consumes paid/quota-limited API requests, so run it intentionally, supply its key on stdin, and never add it to CI. Ordinary tests use the sanitized fixture `test/fixtures/subscription-route-samples.json` and make no real supplier requests.

## Provider coverage and browser behavior

The ten IDs below come from MovieApp's `src/search/shared/movieStreamers.ts`, the same list used by Advanced Search. Streaming availability and the filter list were not changed by this feature.

| Filter | TMDB ID | Backup service | Primary Wikidata properties |
| --- | --- | --- | --- |
| Netflix | 8 (also 1796 ads variant) | netflix | P1874 |
| Hulu | 15 | hulu | P6466 |
| Prime Video | 9 | prime | P8055, P14440, P14462 |
| Max | 1899 | hbo | P8298 (movie paths only) |
| YouTube | 192 | Not in the US API catalog | P953, full-work URL only |
| Disney+ | 337 | disney | P13902 (entity IDs, not collection pages) |
| Apple TV+ | 350 | apple | P9586 |
| Peacock | 387 | peacock | P11815 (movie paths only) |
| AMC+ | 526 | amc | P953, full-work URL only |
| Paramount+ | 531 | paramount | P13147 |

YouTube is a real coverage limitation. Its general P1651 video identifier may name a trailer, so it is deliberately ignored. A valid P953 full-work YouTube URL can resolve, but the sampled current filter titles had none. Missing YouTube links return `no_match` without spending backup quota. They do not open a trailer, search, or provider home page.

One backup response can describe several editions of the same movie. After checking the exact TMDB movie identity, country, service, subscription type, and URL format, the resolver makes a deterministic choice among those editions. Netflix retains its stricter conflicting-ID rejection. All valid countries and configured services are saved, including services other than the one tapped.

Two simulator-discovered URL corrections are intentional:

- Prime's `app.primevideo.com/detail?gti=...` redirected iOS to an installation page. The same GTI now uses `https://www.primevideo.com/detail/{GTI}`, the documented P14462 formatter. Both simulators displayed Project Hail Mary. Prime may display account/territory notices; title-page opening does not verify subscription playback.
- Peacock's `/watch/asset/movies/{slug}/{UUID}` enters its web player and produced an unsupported-browser screen on Android. Its public `/watch-online/movies/{slug}/{UUID}` page preserves the same movie ID and displayed Insidious on both platforms. No authentication or browser restrictions were bypassed.

Both repositories contain identical provider catalogs. After editing URL rules, copy the Worker catalog to `MovieApp/src/api/cloudflare/streamingProviderCatalog.ts` (or the reverse), verify they match with `cmp`, and run both test suites. This keeps the client's safety validation aligned with the server while the repositories remain independently deployable.

## Expanded verification, August 31, 2026

The expanded resolver is deployed. Historical direct-provider deployment: `ba84dd9c-6278-4e26-8f86-1037a81e6024`; superseded by the route-aware deployment above.

`scripts/verify-all-streaming-fallbacks.mjs` bundles the production resolver in an isolated D1 runtime. It deliberately removes all primary provider IDs, allows only the nine listed test movies, and makes at most nine real backup calls. Each provider must resolve through the live API; the repeat must use D1 with no network call. It also verifies a second provider learned from Toy Story's single response. Supply the key on stdin, never in an argument. This manual harness is not run in CI and has no production DB binding.

Both the initial and final runs passed all nine providers; each used nine real requests and saved 414 mappings. The final run includes the Prime and Peacock browser corrections. All 145 Worker tests and the source typecheck pass; MovieApp has 160 passing tests. Sanitized API samples, primary-source records, live production results, and forced-fallback evidence are under `.codex/verification/all-provider-streaming-links/`. Simulator evidence is in MovieApp's directory of the same name. The app's `.codex/SubscriptionProviderLinks.md` records the visible outcomes and any limitations.

## HTTP contract

```text
GET /streaming-link?tmdbId=492188&providerId=8&region=US
```

All three parameters must appear exactly once. Movie and provider IDs must be positive 32-bit integers. Region is normalized to two uppercase letters. Extra parameters and non-GET requests are rejected. Netflix (`8`) and Netflix Standard with Ads (`1796`) use the same Netflix adapter and stored identifier.

A successful response includes the request identifiers, `resolved: true`, `provider`, `providerContentId`, `webUrl`, `nativeUrl`, `source`, `resolvedAt`, `cacheHit`, `providerKey`, `displayServiceName`, `subscriptionCategory`, and `playbackPlatform`. `provider` now identifies the playback platform; `providerId` remains the exact selected TMDB route. `source` records where the ID was originally learned; `cacheHit` says whether this request used D1.

A supported but unresolved request returns HTTP 200 with `resolved: false` and a reason: `no_match`, `temporarily_unavailable`, `quota_exhausted`, or `lookup_in_progress`. Other providers return `unsupported_provider` without external requests. Invalid inputs return 400; a D1 failure returns 503. Responses use `Cache-Control: no-store`; the persistent cache is D1, not an additional HTTP cache.

## Where to maintain it

| File | Responsibility |
| --- | --- |
| `src/httpRouting/streamingLink.ts` | Validate parameters and translate results into HTTP responses. |
| `src/httpRouting/httpRoutes.ts` | Register the route without changing existing endpoints. |
| `src/streaming/streamingLinkResolver.ts` | Enforce lookup order, save results, coordinate concurrent requests, and guard the quota. |
| `src/streaming/subscriptionRoutes.ts` | Exact TMDB IDs, display names, categories, playback platforms, and verified API add-on IDs. Keep its app copy identical. |
| `src/streaming/providerCatalog.ts` | Playback adapters, service names, Wikidata properties, and strict URL/offer rules. Keep its app copy identical. |
| `src/streaming/providerAdapters.ts` | Read usable Wikidata claims, retain API candidates, and select the exact direct or channel subscription destination. |
| `src/externalApis/tmdbClient.ts` | Reuse the existing TMDB secret and request governor; use a short timeout and no retries for this foreground lookup. |
| `migrations/0029_add_streaming_link_resolver.sql` | Create the four independent tables below. |
| `test/streamingLink.spec.ts` | Test real D1 statements, lookup order, failure handling, and the Worker fetch runtime. |

## What D1 stores

| Table | Purpose |
| --- | --- |
| `movie_streaming_route_links` | Current destinations, keyed by movie, exact TMDB provider ID, and country; stores display service, category, playback platform, content ID, web/native URLs, source, and resolution time. |
| `movie_streaming_links` | Legacy normalized direct destinations. A validated link is copied lazily when its direct route is tapped. Channel routes never inherit these entries. Retained for safe Worker rollback. |
| `streaming_link_candidates` | Useful HTTPS links returned for all services and countries, including the purchase/subscription type and add-on ID. Only configured adapters can promote these records to launchable destinations. |
| `streaming_link_lookups` | A movie-wide request lease and the next permitted backup attempt. This is shared across Worker instances. |
| `streaming_api_budget` | An atomic count of reserved backup requests per UTC calendar month, plus any temporary account-level block. |

Each configured adapter extracts its movie identifier into `provider_content_id`. Unsupported formats remain raw candidates. Add-on and rental links are retained but cannot be mistaken for a direct subscription. For example, an AMC+ channel on Amazon does not qualify as direct AMC+ or a Prime subscription. Candidate rows are not exposed by the endpoint.

## Quota and failure safeguards

- `STREAMING_AVAILABILITY_API_KEY` is a Cloudflare secret. It must never go in `wrangler.jsonc`, source control, the mobile bundle, or diagnostic output.
- `STREAMING_AVAILABILITY_MONTHLY_LIMIT` defaults to **900**, reserving space within the verified 1,000-request free plan for account-side/manual requests. Set it to `0` and deploy to disable only the backup. D1 and Wikidata still work.
- A D1 lease permits only one in-flight backup lookup per movie, across countries and Worker instances. Another caller rechecks D1 or receives a controlled busy result.
- A completed backup lookup, including a missing movie or missing selected-provider option, is remembered for 30 days. A failed request waits one hour before retrying. This prevents repeated taps from repeatedly spending quota.
- Requests are counted before sending and are never refunded automatically: after a network failure the Worker cannot reliably know whether the supplier charged the request. The counter can therefore be higher than actual account usage.
- HTTP 429 blocks further backup requests until the supplier's reset time, with a minimum one-hour wait. Authentication failures also create a one-hour shared block.
- Both the Wikidata and backup fetches use `redirect: 'manual'` and reject non-success responses. Cloudflare rejects `redirect: 'error'`; blindly following redirects could also send the API key to another host.
- TMDB, Wikidata, and the backup each have a five-second request timeout. The app has a 20-second total request timeout.
- Ambiguous, deprecated, qualified, malformed, or cross-movie Wikidata IDs do not produce a guessed destination. API responses must identify the requested TMDB **movie**, not a series or another title.

The API account's reset was verified as the start of the UTC calendar month. If its billing/reset arrangement changes, revisit the budget period calculation. No plan upgrade or recurring purchase was made.

## Operations

From `/Users/croncallo/repo/movieapp-cloudflare`:

```sh
npm test
npx tsc --noEmit
npx wrangler d1 migrations apply movieapp-db --remote
npx wrangler secret put STREAMING_AVAILABILITY_API_KEY
npx wrangler deploy
```

The secret command prompts for the key; do not place the value directly in a shell command. Migrations 0029 and 0030 are already applied. Both are additive and leave existing availability/import tables untouched. For a fresh environment, apply migrations before deploying the resolver. Do not rebuild or drop the legacy tables.

Use Worker logs filtered to `event: streaming-link`. Each entry includes the movie, selected provider, country, stage, and outcome. It never includes the API key or full upstream bodies. For a healthy repeat request, the only resolver stage should be `d1` with outcome `hit`.

To retry a known failed test lookup after fixing its cause, update **only that movie's** `retry_after` in `streaming_link_lookups`. Do not clear the monthly counter or bulk-delete saved mappings to force a test.

To remove the feature, revert the new route/client integration or roll back the Worker to the previous deployment. The additive tables can remain unused; dropping them is not required. The production version before this work was `a7cc69ab-d1e0-4b48-80b5-2ac3217ecbd9`; that older version predates the new secret. Disabling the backup limit is a smaller intervention when only the supplier is unavailable.

## Historical Netflix verification, August 30–31, 2026

Netflix-only deployment at that stage: `5dc59a06-3fb3-4c81-8739-293e28557a83`.

| Live movie | First resolution | Repeat request |
| --- | --- | --- |
| Marriage Story, TMDB `492188` | Wikidata → Netflix `80223779`, 620 ms | D1 hit, 53 ms |
| The Whisper Man, TMDB `860508` | Streaming Availability → Netflix `81278442`, 1,063 ms | D1 hit, 60 ms |

The backup response saved 65 country mappings for The Whisper Man. Account usage was **2 of 1,000**: one direct API smoke test and one successful Worker fallback. The D1 reservation counter was 3 because two failed attempts during runtime debugging were conservatively retained. Existing movie search and movie-card endpoints still returned HTTP 200. Invalid and unsupported resolver requests returned the expected controlled responses.

At that stage, all **128 Worker tests** passed, including **27 resolver tests**, and the Worker source typecheck passes. A separate typecheck of the entire test directory still reports two existing fixture-type errors in `test/personFamily.spec.ts`; these were reproduced on an untouched copy of the starting commit and are unrelated to this feature.

The mobile simulator build and interaction status is recorded in `/Users/croncallo/repo/MovieApp/.codex/NetflixStreamingLinks.md`.

### Forced missing-ID test with the real backup API

On August 31, 2026, both mobile simulators completed a deliberately forced fallback for Marriage Story (TMDB 492188). Each began with an empty local D1 database. The test supplied a mock TMDB external-ID response and a mock Wikidata record with no Netflix ID. The backup API response was real: it returned Netflix ID 80223779, and an actual app tap opened the correct Netflix page in Safari or Chrome.

Each platform used one live backup request, saved 65 country mappings, then reused the D1 mapping when Netflix Standard with Ads was tapped. There were two live backup calls in total. Production data was untouched.

The reusable manual harness consists of `scripts/verify-streaming-fallback.mjs` and `test/manual/streamingFallback.worker.ts`. It bundles the production HTTP handler and resolver into Miniflare with a disposable D1 binding. Only the primary source responses are replaced. Real network forwarding is restricted to the expected Movie of the Night show endpoint, with a hard maximum of two calls per process. It is not part of normal unit-test runs, and neither file is referenced by the production Wrangler entry point.

To repeat this test, supply the API key through standard input from a private file, never as a command argument or committed source:

```sh
node scripts/verify-streaming-fallback.mjs < /path/to/private/api-key-file
```

The harness listens only at `http://127.0.0.1:8789`. `GET /__test/status` reports sanitized call counts, resolver results, and stored-row counts. `POST /__test/reset` empties only its disposable database between platforms; the process-wide two-call ceiling is not reset. Back up the mobile service before temporarily pointing its streaming URL at this local server. For Android, forward port 8789 with `adb reverse`. Restore the production mobile URL, stop the harness, remove that port forwarding, and delete the temporary key file afterward.

The recorded run completed that cleanup. Its screenshots, sanitized logs, and checked JSON results are under `/Users/croncallo/repo/MovieApp/.codex/verification/netflix-streaming-links/`.

## Supplier references

- [TMDB movie external IDs](https://developer.themoviedb.org/reference/movie-external-ids)
- [Wikidata Netflix ID property](https://www.wikidata.org/wiki/Property:P1874)
- [Streaming Availability API quickstart](https://docs.movieofthenight.com/guide/quickstart)
- [Streaming Availability show endpoint](https://docs.movieofthenight.com/resource/shows#get-a-show)
- [Streaming Availability terms](https://developers.movieofthenight.com/terms-and-conditions): retention for application use is permitted; visible attribution is required. MovieApp includes a linked attribution beside its existing data-source credits. The Worker is an internal application service, not a standalone data product.

Additional verified references: [US services](https://docs.movieofthenight.com/guide/countries-and-services), [Prime GTI formatter](https://www.wikidata.org/wiki/Property:P14462), [Peacock public movie page](https://www.peacocktv.com/watch-online/movies/insidious/4e51408e-3b18-3583-8ea3-7f0790250456).
