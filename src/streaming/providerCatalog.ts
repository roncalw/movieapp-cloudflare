/**
 * Exact movie destinations accepted by MovieApp and its Worker. Keep this file
 * identical in both repositories. A provider's home/search page is never a
 * substitute for a movie link. HTTPS also lets the OS use installed app links.
 */
import {
  subscriptionRouteForProviderId,
  subscriptionRoutes,
  type PlaybackPlatform,
  type SubscriptionRoute,
} from './subscriptionRoutes';
export type StreamingProvider = PlaybackPlatform;
export type ProviderDestination = {
  providerContentId: string;
  webUrl: string;
  nativeUrl: string | null;
};
export type ProviderAdapter = {
  provider: StreamingProvider;
  name: string;
  tmdbProviderIds: readonly number[];
  service: string | null;
  wikidataProperties: readonly string[];
};
const directProviderIds = (platform: PlaybackPlatform) =>
  subscriptionRoutes
    .filter(
      route =>
        route.subscriptionCategory === 'direct' &&
        route.playbackPlatform === platform,
    )
    .map(route => route.tmdbProviderId);
export const providerAdapters: readonly ProviderAdapter[] = [
  {
    provider: 'netflix',
    name: 'Netflix',
    tmdbProviderIds: directProviderIds('netflix'),
    service: 'netflix',
    wikidataProperties: ['P1874'],
  },
  {
    provider: 'hulu',
    name: 'Hulu',
    tmdbProviderIds: directProviderIds('hulu'),
    service: 'hulu',
    wikidataProperties: ['P6466'],
  },
  {
    provider: 'prime',
    name: 'Prime Video',
    tmdbProviderIds: directProviderIds('prime'),
    service: 'prime',
    wikidataProperties: ['P8055', 'P14440', 'P14462'],
  },
  {
    provider: 'max',
    name: 'Max',
    tmdbProviderIds: directProviderIds('max'),
    service: 'hbo',
    wikidataProperties: ['P8298'],
  },
  {
    provider: 'youtube',
    name: 'YouTube',
    tmdbProviderIds: directProviderIds('youtube'),
    service: null,
    wikidataProperties: ['P953'],
  },
  {
    provider: 'disney',
    name: 'Disney+',
    tmdbProviderIds: directProviderIds('disney'),
    service: 'disney',
    wikidataProperties: ['P13902'],
  },
  {
    provider: 'apple',
    name: 'Apple TV+',
    tmdbProviderIds: directProviderIds('apple'),
    service: 'apple',
    wikidataProperties: ['P9586'],
  },
  {
    provider: 'peacock',
    name: 'Peacock',
    tmdbProviderIds: directProviderIds('peacock'),
    service: 'peacock',
    wikidataProperties: ['P11815'],
  },
  {
    provider: 'amc',
    name: 'AMC+',
    tmdbProviderIds: directProviderIds('amc'),
    service: 'amc',
    wikidataProperties: ['P953'],
  },
  {
    provider: 'paramount',
    name: 'Paramount+',
    tmdbProviderIds: directProviderIds('paramount'),
    service: 'paramount',
    wikidataProperties: ['P13147'],
  },
  {
    provider: 'starz',
    name: 'STARZ',
    tmdbProviderIds: directProviderIds('starz'),
    service: 'starz',
    wikidataProperties: ['P953'],
  },
  {
    provider: 'roku',
    name: 'The Roku Channel',
    tmdbProviderIds: directProviderIds('roku'),
    service: 'roku',
    wikidataProperties: ['P953'],
  },
];
export function adapterForProviderId(id: number): ProviderAdapter | undefined {
  const route = subscriptionRouteForProviderId(id);
  return route ? adapterForRoute(route) : undefined;
}
export function adapterForRoute(
  route: SubscriptionRoute,
): ProviderAdapter | undefined {
  return providerAdapters.find(
    adapter => adapter.provider === route.playbackPlatform,
  );
}
export function safeHttpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value))
    return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port
      ? url
      : null;
  } catch {
    return null;
  }
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const slug = '[a-zA-Z0-9%._~-]+';
const matchPath = (path: string, pattern: string) =>
  path.match(new RegExp('^' + pattern + '/?$'));

export function destinationFromUrl(
  provider: StreamingProvider,
  value: unknown,
): ProviderDestination | null {
  const url = safeHttpsUrl(value);
  if (!url) return null;
  const host = url.hostname;
  const path = url.pathname;
  let id: string | undefined;
  let webUrl = url.origin + path;
  let nativeUrl: string | null = null;
  switch (provider) {
    case 'netflix':
      if (!['netflix.com', 'www.netflix.com'].includes(host)) return null;
      id = matchPath(
        path,
        '/(?:[a-z]{2}(?:-[a-z]{2})?/)?(?:title|watch)/([1-9]\\d{5,7})',
      )?.[1];
      if (id) {
        webUrl = `https://www.netflix.com/title/${id}`;
        nativeUrl = `nflx://www.netflix.com/watch/${id}`;
      }
      break;
    case 'hulu':
      if (!['hulu.com', 'www.hulu.com'].includes(host)) return null;
      id = matchPath(
        path,
        '/(?:movie|watch)/(?:' + slug + '-)?(' + uuid + ')',
      )?.[1];
      break;
    case 'prime':
      if (
        ['primevideo.com', 'www.primevideo.com', 'app.primevideo.com'].includes(
          host,
        )
      ) {
        id = matchPath(
          path,
          '/(?:[a-z]{2}(?:-[a-z]{2})?/)?detail/(?:' +
            slug +
            '/)?([A-Z0-9]{10}|[A-Z0-9]{26}|amzn1\\.dv\\.gti\\.' +
            uuid +
            ')',
        )?.[1];
        if (
          !id &&
          path === '/detail' &&
          url.searchParams.getAll('gti').length === 1
        ) {
          const gti = url.searchParams.get('gti')!;
          if (new RegExp('^amzn1\\.dv\\.gti\\.' + uuid + '$').test(gti)) {
            id = gti;
            webUrl = 'https://www.primevideo.com/detail/' + gti;
          }
        }
      } else if (
        [
          'amazon.com',
          'www.amazon.com',
          'www.amazon.co.uk',
          'www.amazon.de',
          'www.amazon.co.jp',
        ].includes(host)
      ) {
        id = matchPath(
          path,
          '/(?:gp/video/detail|dp)/([A-Z0-9]{10}|[A-Z0-9]{26})',
        )?.[1];
        if (id) webUrl = `https://www.primevideo.com/detail/${id}`;
      }
      break;
    case 'max':
      if (
        ![
          'www.hbomax.com',
          'play.hbomax.com',
          'www.max.com',
          'play.max.com',
        ].includes(host)
      )
        return null;
      id = matchPath(
        path,
        '/(?:[a-z]{2}(?:/[a-z]{2})?/)?(?:movie|movies)/(?:' +
          slug +
          '/)?(' +
          uuid +
          ')',
      )?.[1];
      break;
    case 'youtube':
      if (
        ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host) &&
        path === '/watch' &&
        url.searchParams.getAll('v').length === 1
      ) {
        const videoId = url.searchParams.get('v')!;
        if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) id = videoId;
      } else if (host === 'youtu.be')
        id = matchPath(path, '/([A-Za-z0-9_-]{11})')?.[1];
      if (id) webUrl = `https://www.youtube.com/watch?v=${id}`;
      break;
    case 'disney':
      if (!['disneyplus.com', 'www.disneyplus.com'].includes(host)) return null;
      // "page-" IDs may describe a collection, so only individual entities qualify.
      id = matchPath(
        path,
        '/(?:[a-z]{2}(?:-[a-z]{2})?/)?browse/(entity-' + uuid + ')',
      )?.[1];
      if (!id)
        id = matchPath(
          path,
          '/(?:[a-z]{2}(?:-[a-z]{2})?/)?movies/' + slug + '/([A-Za-z0-9]{12})',
        )?.[1];
      break;
    case 'apple':
      if (host !== 'tv.apple.com') return null;
      id = matchPath(
        path,
        '/(?:[a-z]{2}/)?movie/(?:' + slug + '/)?(umc\\.cmc\\.[a-z0-9]{22,25})',
      )?.[1];
      if (url.searchParams.has('playableId')) {
        const playableId = url.searchParams.get('playableId')!;
        if (
          url.searchParams.getAll('playableId').length !== 1 ||
          !/^tvs\.sbd\.\d{2,12}:[A-Za-z0-9._~-]{1,128}$/.test(playableId)
        )
          return null;
        webUrl += `?playableId=${encodeURIComponent(playableId)}`;
      }
      break;
    case 'starz':
      if (!['starz.com', 'www.starz.com'].includes(host)) return null;
      id = matchPath(
        path,
        '/(?:[a-z]{2}/[a-z]{2}/)?movies/(?:' + slug + '-)?([1-9][0-9]{3,9})',
      )?.[1];
      break;
    case 'roku':
      if (host !== 'therokuchannel.roku.com') return null;
      id = matchPath(path, '/details/([0-9a-f]{32})')?.[1];
      break;
    case 'peacock':
      if (!['peacocktv.com', 'www.peacocktv.com'].includes(host)) return null;
      id = matchPath(
        path,
        '/(?:watch/asset|watch-online)/movies/' + slug + '/(' + uuid + ')',
      )?.[1];
      if (!id) {
        const movieSlug = matchPath(path, '/stream-movies/(' + slug + ')')?.[1];
        if (movieSlug) id = 'movies/' + movieSlug;
      }
      if (id && path.startsWith('/watch/asset/movies/')) {
        // Peacock's public title page keeps the same movie asset ID and slug,
        // without sending mobile browsers straight into its web player.
        webUrl =
          'https://www.peacocktv.com' +
          path.replace('/watch/asset/', '/watch-online/');
      }
      break;
    case 'amc':
      if (!['amcplus.com', 'www.amcplus.com'].includes(host)) return null;
      id = matchPath(path, '/movies/' + slug + '--([1-9][0-9]{3,12})')?.[1];
      break;
    case 'paramount':
      if (!['paramountplus.com', 'www.paramountplus.com'].includes(host))
        return null;
      id = matchPath(
        path,
        '/(?:[a-z]{2}/)?(?:movies|shows)/video/([A-Za-z0-9_-]{20,64})',
      )?.[1];
      break;
  }
  return id ? { providerContentId: id, webUrl, nativeUrl } : null;
}

/** Apple channel links need their own playable offer, not the store's rental offer. */
export function destinationForRouteFromUrl(
  route: SubscriptionRoute,
  value: unknown,
): ProviderDestination | null {
  const adapter = adapterForRoute(route);
  if (!adapter) return null;
  const destination = destinationFromUrl(adapter.provider, value);
  if (!destination) return null;
  if (route.subscriptionCategory === 'apple_tv_channels') {
    const playableId = new URL(destination.webUrl).searchParams.get(
      'playableId',
    );
    if (!playableId || !route.addonIds.includes(playableId.split(':')[0]))
      return null;
  }
  return destination;
}

/** Only documented identifier formats can produce a URL without an API link. */
export function destinationFromWikidataValue(
  provider: StreamingProvider,
  property: string,
  value: string,
): ProviderDestination | null {
  let url: string;
  switch (property) {
    case 'P1874':
      url = `https://www.netflix.com/title/${value}`;
      break;
    case 'P6466':
      url = `https://www.hulu.com/movie/${value}`;
      break;
    case 'P8055':
      url = `https://www.amazon.com/gp/video/detail/${value}`;
      break;
    case 'P14462':
    case 'P14440':
      url = `https://www.primevideo.com/detail/${value}`;
      break;
    case 'P8298':
      url = `https://play.hbomax.com/${value}`;
      break;
    case 'P13902':
      url = `https://www.disneyplus.com/browse/${value}`;
      break;
    case 'P9586':
      url = `https://tv.apple.com/movie/${value}`;
      break;
    case 'P11815':
      url = `https://www.peacocktv.com/stream-${value}`;
      break;
    case 'P13147':
      url = `https://www.paramountplus.com/shows/video/${value}/`;
      break;
    // Full-work URLs are useful for services without a dedicated movie property.
    // Deliberately do not accept P1651 (YouTube video ID): it can be a trailer.
    case 'P953':
      url = value;
      break;
    default:
      return null;
  }
  return destinationFromUrl(provider, url);
}
