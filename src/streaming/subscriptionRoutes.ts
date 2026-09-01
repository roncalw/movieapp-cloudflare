/**
 * Subscription identity is separate from the app that plays the movie.
 * Keep this file identical in MovieApp and the Worker. Only IDs supplied by
 * TMDB for the current movie become visible rows; this catalog adds no availability.
 */
export type PlaybackPlatform =
  | 'netflix'
  | 'hulu'
  | 'prime'
  | 'max'
  | 'youtube'
  | 'disney'
  | 'apple'
  | 'peacock'
  | 'amc'
  | 'paramount'
  | 'starz'
  | 'roku';

export const subscriptionCategories = [
  { key: 'direct', label: 'Direct', playbackPlatform: null },
  {
    key: 'prime_video_channels',
    label: 'Prime Video Channels',
    playbackPlatform: 'prime',
  },
  { key: 'disney_plus', label: 'Disney+', playbackPlatform: 'disney' },
  {
    key: 'apple_tv_channels',
    label: 'Apple TV Channels',
    playbackPlatform: 'apple',
  },
  { key: 'roku_channels', label: 'The Roku Channel', playbackPlatform: 'roku' },
] as const;
export type SubscriptionCategory =
  (typeof subscriptionCategories)[number]['key'];
export type SubscriptionRoute = {
  tmdbProviderId: number;
  providerKey: string;
  displayServiceName: string;
  subscriptionCategory: SubscriptionCategory;
  playbackPlatform: PlaybackPlatform | null;
  /** Exact Movie of the Night add-on IDs. An empty array never matches an add-on. */
  addonIds: readonly string[];
};

type RouteEntry = readonly [
  number,
  string,
  SubscriptionCategory,
  PlaybackPlatform,
  (readonly string[])?,
];

// Verified against TMDB's US provider catalog and Movie of the Night's US
// add-on catalog. Extend this table when a new exact provider ID is introduced.
const routeEntries: readonly RouteEntry[] = [
  [8, 'Netflix', 'direct', 'netflix'],
  [1796, 'Netflix Standard with Ads', 'direct', 'netflix'],
  [15, 'Hulu', 'direct', 'hulu'],
  [9, 'Amazon Prime Video', 'direct', 'prime'],
  [119, 'Amazon Prime Video', 'direct', 'prime'],
  [2100, 'Amazon Prime Video with Ads', 'direct', 'prime'],
  [1899, 'HBO Max', 'direct', 'max'],
  [192, 'YouTube', 'direct', 'youtube'],
  [337, 'Disney+', 'direct', 'disney'],
  [350, 'Apple TV+', 'direct', 'apple'],
  [387, 'Peacock Premium', 'direct', 'peacock'],
  [388, 'Peacock Premium Plus', 'direct', 'peacock'],
  [526, 'AMC+', 'direct', 'amc'],
  [531, 'Paramount+', 'direct', 'paramount'],
  [43, 'STARZ', 'direct', 'starz'],
  [196, 'AcornTV', 'prime_video_channels', 'prime', ['acorn']],
  [
    197,
    'BritBox',
    'prime_video_channels',
    'prime',
    ['britbox', 'britboxpremierus'],
  ],
  [199, 'Fandor', 'prime_video_channels', 'prime', ['fandor']],
  [201, 'MUBI', 'prime_video_channels', 'prime', ['mubi']],
  [202, 'Screambox', 'prime_video_channels', 'prime', ['screambox']],
  [
    204,
    'Shudder',
    'prime_video_channels',
    'prime',
    ['shuddertv', 'shuddertvus'],
  ],
  [205, 'Sundance Now', 'prime_video_channels', 'prime', ['docclub']],
  [287, 'BFI Player', 'prime_video_channels', 'prime'],
  [289, 'Cinemax', 'prime_video_channels', 'prime', ['cinemax']],
  [290, 'Hallmark+', 'prime_video_channels', 'prime', ['hallmark']],
  [291, 'MZ Choice', 'prime_video_channels', 'prime'],
  [293, 'PBS Kids', 'prime_video_channels', 'prime', ['pbskids']],
  [294, 'PBS Masterpiece', 'prime_video_channels', 'prime', ['masterpiece']],
  [295, 'RetroCrush', 'prime_video_channels', 'prime', ['viewster']],
  [528, 'AMC+', 'prime_video_channels', 'prime', ['amcplus']],
  [
    582,
    'Paramount+',
    'prime_video_channels',
    'prime',
    ['paramountpremium', 'cbsaacf'],
  ],
  [583, 'MGM+', 'prime_video_channels', 'prime', ['epix']],
  [584, 'Discovery+', 'prime_video_channels', 'prime', ['discoveryplus']],
  [597, 'Full Moon', 'prime_video_channels', 'prime', ['fullmoon']],
  [600, 'Shout! Factory', 'prime_video_channels', 'prime'],
  [602, 'FilmBox Live', 'prime_video_channels', 'prime'],
  [
    603,
    'CuriosityStream',
    'prime_video_channels',
    'prime',
    ['curiositystreamstandard'],
  ],
  [633, 'Paramount+', 'roku_channels', 'roku', ['paramountplus']],
  [634, 'STARZ', 'roku_channels', 'roku', ['starz']],
  [635, 'AMC+', 'roku_channels', 'roku', ['amcplus']],
  [636, 'MGM+', 'roku_channels', 'roku', ['epix']],
  [642, 'STUDIOCANAL PRESENTS', 'apple_tv_channels', 'apple'],
  [688, 'ShortsTV', 'prime_video_channels', 'prime', ['shortstvus']],
  [1746, 'Hallmark TV', 'prime_video_channels', 'prime'],
  [1794, 'STARZ', 'prime_video_channels', 'prime', ['starzSub']],
  [1811, 'Cohen Media', 'prime_video_channels', 'prime'],
  [
    1825,
    'HBO Max',
    'prime_video_channels',
    'prime',
    ['maxliveeventsus', 'hbomaxus'],
  ],
  [1852, 'BritBox', 'apple_tv_channels', 'apple', ['tvs.sbd.1000294']],
  [1853, 'Paramount+', 'apple_tv_channels', 'apple', ['tvs.sbd.1000230']],
  [1854, 'AMC+', 'apple_tv_channels', 'apple', ['tvs.sbd.1000383']],
  [1855, 'STARZ', 'apple_tv_channels', 'apple', ['tvs.sbd.1000231']],
  [1866, 'ViX Premium', 'prime_video_channels', 'prime', ['vixplusus']],
  [1968, 'Crunchyroll', 'prime_video_channels', 'prime', ['crunchyrollus']],
  [
    2033,
    'A&E Crime Central',
    'apple_tv_channels',
    'apple',
    ['tvs.sbd.1000332'],
  ],
  [2034, 'Acorn TV', 'apple_tv_channels', 'apple', ['tvs.sbd.1000212']],
  [2036, 'ALLBLK', 'apple_tv_channels', 'apple', ['tvs.sbd.1000214']],
  [2037, 'ARD Plus', 'apple_tv_channels', 'apple'],
  [2038, 'Arthaus+', 'apple_tv_channels', 'apple'],
  [2039, 'BBC Select', 'apple_tv_channels', 'apple', ['tvs.sbd.1000415']],
  [2041, 'BFI Player', 'apple_tv_channels', 'apple'],
  [2042, 'Carnegie Hall+', 'apple_tv_channels', 'apple', ['tvs.sbd.1000473']],
  [2044, 'OUTtv', 'apple_tv_channels', 'apple', ['tvs.sbd.1000266']],
  [
    2045,
    'UP Faith & Family',
    'apple_tv_channels',
    'apple',
    ['tvs.sbd.1000257'],
  ],
  [2047, 'Tastemade', 'apple_tv_channels', 'apple', ['tvs.sbd.1000211']],
  [2048, 'Sundance Now', 'apple_tv_channels', 'apple', ['tvs.sbd.1000208']],
  [2049, 'Shudder', 'apple_tv_channels', 'apple', ['tvs.sbd.1000206']],
  [2050, 'ScreenPix', 'apple_tv_channels', 'apple', ['tvs.sbd.1000464']],
  [2052, 'Love Nature', 'apple_tv_channels', 'apple'],
  [2053, 'Lionsgate Play', 'apple_tv_channels', 'apple'],
  [
    2055,
    'Lifetime Movie Club',
    'apple_tv_channels',
    'apple',
    ['tvs.sbd.1000229'],
  ],
  [2056, 'IFC Films Unlimited', 'apple_tv_channels', 'apple'],
  [
    2057,
    'HISTORY Vault',
    'apple_tv_channels',
    'apple',
    ['tvs.sbd.1000228', 'tvs.sbd.10920'],
  ],
  [2058, 'Hallmark+', 'apple_tv_channels', 'apple', ['tvs.sbd.1000362']],
  [2059, 'Eros Now Select', 'apple_tv_channels', 'apple', ['tvs.sbd.1000301']],
  [2060, 'CuriosityStream', 'apple_tv_channels', 'apple', ['tvs.sbd.1000227']],
  [2061, 'Cinemax', 'apple_tv_channels', 'apple', ['tvs.sbd.1000244']],
  [2064, 'ALLBLK', 'prime_video_channels', 'prime', ['umc']],
  [
    2066,
    'UP Faith & Family',
    'prime_video_channels',
    'prime',
    ['upfaithfamily'],
  ],
  [2068, 'Tastemade', 'prime_video_channels', 'prime', ['tastemade']],
  [2069, 'ScreenPix', 'prime_video_channels', 'prime', ['screenpix']],
  [
    2071,
    'Carnegie Hall+',
    'prime_video_channels',
    'prime',
    ['carnegiehallplusus'],
  ],
  [2073, 'HISTORY Vault', 'prime_video_channels', 'prime', ['historyvault']],
  [
    2089,
    'Lifetime Movie Club',
    'prime_video_channels',
    'prime',
    ['lifetimemovieclub'],
  ],
  [2107, 'Adrenalina Pura', 'apple_tv_channels', 'apple'],
  [2142, 'MGM+', 'apple_tv_channels', 'apple', ['tvs.sbd.1000185']],
  [2164, 'Gaia', 'prime_video_channels', 'prime', ['gaia']],
  [
    2174,
    'Strand Releasing',
    'prime_video_channels',
    'prime',
    ['strandreleasing'],
  ],
  [2243, 'Apple TV+', 'prime_video_channels', 'prime', ['appletvus']],
  [2266, 'Qello Concerts by Stingray', 'prime_video_channels', 'prime'],
  [
    2273,
    'Stingray Classica',
    'prime_video_channels',
    'prime',
    ['stingrayclassica'],
  ],
  [2274, 'Stingray Djazz', 'prime_video_channels', 'prime', ['stingraydjazz']],
  [
    2275,
    'Stingray Karaoke',
    'prime_video_channels',
    'prime',
    ['stingraykaraoke'],
  ],
  [2296, 'Viaplay', 'prime_video_channels', 'prime', ['viaplayus']],
  [2314, 'Acaciatv', 'prime_video_channels', 'prime', ['acaciatv']],
  [2316, 'Alchemiya', 'prime_video_channels', 'prime'],
  [2317, 'All warrior network', 'prime_video_channels', 'prime'],
  [2318, 'Amebatv', 'prime_video_channels', 'prime'],
  [2320, 'Aspire TV', 'prime_video_channels', 'prime', ['aspireTVus']],
  [2321, 'BeFit', 'prime_video_channels', 'prime', ['befit']],
  [2323, 'Best of British Tv', 'prime_video_channels', 'prime'],
  [2324, 'Baeble', 'prime_video_channels', 'prime'],
  [
    2325,
    'Best Westerns Ever',
    'prime_video_channels',
    'prime',
    ['bestwesternsever'],
  ],
  [2326, 'Broadway HD', 'prime_video_channels', 'prime', ['broadwayhd']],
  [2327, 'Brown Sugar', 'prime_video_channels', 'prime'],
  [2358, 'Lionsgate+', 'prime_video_channels', 'prime', ['lionsgateplusus']],
  [
    2366,
    'The Coda Collection',
    'prime_video_channels',
    'prime',
    ['codacollection'],
  ],
  [2367, 'Midnight Pulp', 'prime_video_channels', 'prime', ['contv']],
  [2369, 'Daring Docs', 'prime_video_channels', 'prime', ['daringdocs']],
  [2371, 'Dekkoo', 'prime_video_channels', 'prime', ['dekkoo']],
  [2376, 'DocCom', 'prime_video_channels', 'prime'],
  [2377, 'DocuramaFilms', 'prime_video_channels', 'prime'],
  [2378, 'Dove', 'prime_video_channels', 'prime'],
  [2379, 'Dox', 'prime_video_channels', 'prime', ['dox']],
  [2390, 'Hidive', 'prime_video_channels', 'prime', ['hidiveus']],
  [2392, 'Echoboom', 'prime_video_channels', 'prime'],
  [2394, 'Fear Factory', 'prime_video_channels', 'prime', ['fearfactory']],
  [
    2395,
    'Film Movement Plus',
    'prime_video_channels',
    'prime',
    ['filmmovementus'],
  ],
  [2396, 'Fitfusion', 'prime_video_channels', 'prime'],
  [2398, 'Food Matters', 'prime_video_channels', 'prime'],
  [2400, 'France Channel', 'prime_video_channels', 'prime', ['france_channel']],
  [2401, 'Fuse+', 'prime_video_channels', 'prime', ['fuse']],
  [2403, 'Hi-YAH', 'prime_video_channels', 'prime', ['hiyah']],
  [2404, 'Indie Club', 'prime_video_channels', 'prime', ['indieclub']],
  [2405, 'IndieFlix Shorts', 'prime_video_channels', 'prime'],
  [2406, 'Here TV', 'prime_video_channels', 'prime', ['heretv']],
  [2407, 'IndiePix Unlimited', 'prime_video_channels', 'prime', ['indiepix']],
  [2408, 'Doki', 'prime_video_channels', 'prime', ['jedge']],
  [2414, 'Kartoon Channel', 'prime_video_channels', 'prime', ['kidgenius']],
  [2415, 'Kidstream', 'prime_video_channels', 'prime', ['kidstream']],
  [
    2418,
    'Magnolia Selects',
    'prime_video_channels',
    'prime',
    ['magnoliaselects'],
  ],
  [2419, 'Monsters and Nightmares', 'prime_video_channels', 'prime', ['mandn']],
  [2420, 'Marquee TV', 'prime_video_channels', 'prime', ['marqueetvus']],
  [2427, 'Passionflix', 'prime_video_channels', 'prime', ['passionflix']],
  [2428, 'Pinoy Box Office', 'prime_video_channels', 'prime', ['pbo']],
  [2430, 'PBS Documentaries', 'prime_video_channels', 'prime', ['pbsdoc']],
  [2431, 'PBS Living', 'prime_video_channels', 'prime', ['pbsliving']],
  [2432, 'PixL', 'prime_video_channels', 'prime', ['pixl']],
  [
    2433,
    'Great American Pure Flix',
    'prime_video_channels',
    'prime',
    ['pureflixus1'],
  ],
  [2435, 'Revry', 'prime_video_channels', 'prime', ['revry']],
  [
    2436,
    'Ryan and Friends Plus',
    'prime_video_channels',
    'prime',
    ['ryanfriends'],
  ],
  [2438, 'Sensical', 'prime_video_channels', 'prime', ['sensicalus']],
  [
    2439,
    'ZenLIFE by Stingray',
    'prime_video_channels',
    'prime',
    ['stingrayzenlifeus'],
  ],
  [
    2442,
    'Demand Africa',
    'prime_video_channels',
    'prime',
    ['theafricachannelus'],
  ],
  [
    2443,
    'The Surf Network',
    'prime_video_channels',
    'prime',
    ['thesurfnetwork'],
  ],
  [2444, 'Toku', 'prime_video_channels', 'prime', ['toku']],
  [2445, 'MovieSphere+', 'prime_video_channels', 'prime', ['tribecashortlist']],
  [2446, 'True Royalty', 'prime_video_channels', 'prime', ['trueroyalty']],
  [2448, 'FUEL TV+', 'prime_video_channels', 'prime', ['vaporvue']],
  [2452, 'Dreamscape Kids', 'prime_video_channels', 'prime'],
  [2454, 'Green Planet Stream', 'prime_video_channels', 'prime'],
  [2462, 'Yoga and Fitness TV', 'prime_video_channels', 'prime'],
  [2464, 'Young Hollywood', 'prime_video_channels', 'prime'],
  [2465, 'Vemox Cine', 'prime_video_channels', 'prime', ['vemoxcine']],
  [2466, 'Warriors and Gangsters', 'prime_video_channels', 'prime'],
  [2467, 'Xive TV Documentaries', 'prime_video_channels', 'prime', ['xivetv']],
  [2468, 'XLTV', 'prime_video_channels', 'prime', ['xltv']],
  [2470, 'Yipee Kids TV', 'prime_video_channels', 'prime'],
  [
    2553,
    'Peacock Premium Plus',
    'prime_video_channels',
    'prime',
    ['peacockus', 'peacockholdoutus', 'peacockadsus'],
  ],
  [
    2668,
    'Wonder Project',
    'prime_video_channels',
    'prime',
    ['wonderprojectus'],
  ],
  [2704, 'Cineverse', 'prime_video_channels', 'prime', ['cineverseus']],
  [2745, 'Sony Pictures Core', 'prime_video_channels', 'prime', ['spcoreus']],
  [2754, 'Howdy', 'prime_video_channels', 'prime', ['howdyus']],
];

export const subscriptionRoutes: readonly SubscriptionRoute[] =
  routeEntries.map(
    ([
      tmdbProviderId,
      displayServiceName,
      subscriptionCategory,
      playbackPlatform,
      addonIds,
    ]) => ({
      tmdbProviderId,
      // The exact TMDB ID keeps same-named routes and future preferences distinct.
      providerKey: `tmdb_${tmdbProviderId}`,
      displayServiceName,
      subscriptionCategory,
      playbackPlatform,
      addonIds: addonIds ?? [],
    }),
  );

/**
 * The API represents this add-on explicitly, but TMDB currently has no separate
 * provider ID for it. It is a template, not live availability. Tests bind a
 * fictional ID; production must wait for a verified TMDB route before binding it.
 */
export const huluDisneyRouteTemplate: Omit<
  SubscriptionRoute,
  'tmdbProviderId'
> = {
  providerKey: 'hulu_disney_plus',
  displayServiceName: 'Hulu',
  subscriptionCategory: 'disney_plus',
  playbackPlatform: 'disney',
  addonIds: ['hulu'],
};

export function subscriptionRouteForProviderId(
  id: number,
  routes: readonly SubscriptionRoute[] = subscriptionRoutes,
): SubscriptionRoute | undefined {
  return routes.find(route => route.tmdbProviderId === id);
}

/** Unknown providers stay visible, but cannot launch until their ID is mapped. */
export function unconfiguredSubscriptionRoute(
  id: number,
  name: string,
): SubscriptionRoute {
  const suffixes: [RegExp, SubscriptionCategory][] = [
    [/\s+Amazon Channels?\s*$/i, 'prime_video_channels'],
    [/\s+Apple TV channel\s*$/i, 'apple_tv_channels'],
    [/\s+Roku Premium Channel\s*$/i, 'roku_channels'],
  ];
  const match = suffixes.find(([pattern]) => pattern.test(name));
  return {
    tmdbProviderId: id,
    providerKey: `tmdb_${id}`,
    displayServiceName: match ? name.replace(match[0], '').trim() : name,
    subscriptionCategory: match?.[1] ?? 'direct',
    playbackPlatform: null,
    addonIds: [],
  };
}

export function subscriptionRouteLabel(route: SubscriptionRoute): string {
  if (route.subscriptionCategory === 'direct') return route.displayServiceName;
  const category = subscriptionCategories.find(
    value => value.key === route.subscriptionCategory,
  )!;
  return `${route.displayServiceName} through ${category.label}`;
}
