
import { getMedia } from "../core/anilist.js";
import { extractFlixcloud } from "../extractors/index.js";
import {
  buildTitleSearchQueries,
  buildTitles,
} from "../core/new-provider-utils.js";
import {
  get as cacheGet,
  set as cacheSet,
  isFresh as cacheIsFresh,
  SHOW_IDENTITY_TTL,
} from "../core/smartcache.js";

const BASE = "https://reanime.to";
const FLIX = "https://flixcloud.cc";
const ANIZIP2 = "https://api.ani.zip/mappings";

const UA5 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const H = {
  "User-Agent": UA5,
  Accept: "application/json, */*",
};

// Search Reanime
async function searchReanime(query, genre = null) {
  const params = new URLSearchParams({
    q: query,
    limit: "10",
  });

  if (genre) params.set("genre", genre);

  const response = await fetch(
    `${BASE}/api/v1/search?${params}`,
    { headers: H }
  );

  const raw = await response.text();

  if (!response.ok) {
    const error = new Error(
      `Reanime search ${response.status}`
    );
    error.rawBody = raw;
    throw error;
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid JSON returned by Reanime search"
    );
  }

  return Array.isArray(data?.results)
    ? data.results
    : [];
}

// Diagnostic search: logs successful and failed requests.
// This helps identify Render network or Reanime API errors.
async function searchReanimeDebug(query, genre = null) {
  try {
    const results = await searchReanime(query, genre);

    console.log(
      `[ep:reanime] Search "${query}" returned ${results.length} results`
    );

    if (results.length > 0) {
      console.log(
        "[ep:reanime] Candidates:",
        results.slice(0, 5).map((item) => ({
          anime_id: item.anime_id,
          title:
            item.title?.english ||
            item.title?.romaji ||
            null,
          anilist_id: item.anilist_id ?? null,
          mal_id: item.mal_id ?? null,
          cover_image: item.cover_image ?? null,
        }))
      );
    }

    return results;
  } catch (error) {
    console.error(
      `[ep:reanime] Search failed "${query}":`,
      error.message,
      error.rawBody?.slice(0, 300) || ""
    );

    return [];
  }
}

// Fetch anime detail
async function fetchAnimeDetail(animeId) {
  const response = await fetch(
    `${BASE}/api/v1/anime/${encodeURIComponent(animeId)}`,
    { headers: H }
  );

  if (!response.ok) {
    console.error(
      `[ep:reanime] Detail failed ${animeId}: HTTP ${response.status}`
    );
    return null;
  }

  return response.json().catch(() => null);
}

// Extract AniList ID from cover image
function extractAnilistIdFromCover(coverImage) {
  const urls = [
    coverImage?.extra_large,
    coverImage?.large,
    coverImage?.medium,
  ].filter(Boolean);

  for (const url of urls) {
    const match = url.match(/anilist\.co\/.*\/bx(\d+)-/);

    if (match) return Number(match[1]);
  }

  return null;
}

// Resolve anime
async function resolveSeries(anilistId, ctx = {}) {
  const numericId = Number(anilistId);

  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new Error(
      `Invalid AniList ID: ${anilistId}`
    );
  }

  const cacheKey = `np:match2:reanime:${numericId}`;
  const cached = cacheGet(cacheKey);

  if (cacheIsFresh(cached)) {
    console.log(
      `[ep:reanime] Cache hit for AniList ${numericId}`
    );
    return cached.data;
  }

  const media = ctx.media ?? await getMedia(numericId);

  if (!media) {
    throw new Error(
      `AniList media not found: ${numericId}`
    );
  }

  const malId = media?.idMal ?? null;

  const queries = buildTitleSearchQueries(
    buildTitles(media, ctx.anizip),
    16
  );

  console.log(
    `[ep:reanime] Resolving AniList ${numericId}`,
    {
      title: media.title?.english || media.title?.romaji,
      malId,
      queries,
    }
  );

  const searchRequests = queries.map((query) =>
    searchReanimeDebug(query)
  );

  if (media?.genres?.includes("Hentai")) {
    searchRequests.push(
      ...queries.map((query) =>
        searchReanimeDebug(query, "Hentai")
      )
    );
  }

  const candidates = new Map();

  await Promise.all(
    searchRequests.map(async (request) => {
      const results = await request;

      for (const result of results) {
        if (
          result?.anime_id &&
          !candidates.has(result.anime_id)
        ) {
          candidates.set(result.anime_id, result);
        }
      }
    })
  );

  console.log(
    `[ep:reanime] Total unique candidates for AniList ${numericId}: ${candidates.size}`
  );

  // First: direct AniList ID match from search results.
  for (const [id, result] of candidates) {
    if (Number(result.anilist_id) === numericId) {
      const data = {
        animeId: id,
        title:
          result.title?.english ||
          result.title?.romaji ||
          id,
        anilistId: numericId,
        malId: result.mal_id ?? malId,
        subbed: Number.isFinite(result.subbed)
          ? result.subbed
          : null,
        dubbed: Number.isFinite(result.dubbed)
          ? result.dubbed
          : null,
        episodesCount: Number.isFinite(result.episodes)
          ? result.episodes
          : null,
        matchType: "anilist_search",
        matchScore: 1,
      };

      console.log(
        `[ep:reanime] Matched AniList ${numericId} by search: ${id}`
      );

      cacheSet(cacheKey, data, SHOW_IDENTITY_TTL);
      return data;
    }
  }

  // Second: AniList ID from the cover image.
  for (const [id, result] of candidates) {
    const coverId = extractAnilistIdFromCover(
      result.cover_image
    );

    if (coverId === numericId) {
      const data = {
        animeId: id,
        title:
          result.title?.english ||
          result.title?.romaji ||
          id,
        anilistId: numericId,
        malId: result.mal_id ?? malId,
        subbed: Number.isFinite(result.subbed)
          ? result.subbed
          : null,
        dubbed: Number.isFinite(result.dubbed)
          ? result.dubbed
          : null,
        episodesCount: Number.isFinite(result.episodes)
          ? result.episodes
          : null,
        matchType: "cover_image",
        matchScore: 1,
      };

      console.log(
        `[ep:reanime] Matched AniList ${numericId} by cover: ${id}`
      );

      cacheSet(cacheKey, data, SHOW_IDENTITY_TTL);
      return data;
    }
  }

  // Third: check candidate detail pages.
  const needsDetail = [...candidates.keys()].filter(
    (id) =>
      extractAnilistIdFromCover(
        candidates.get(id)?.cover_image
      ) === null
  );

  console.log(
    `[ep:reanime] Checking ${needsDetail.length} detail pages`
  );

  const details = await Promise.all(
    needsDetail.map(async (id) => ({
      id,
      detail: await fetchAnimeDetail(id).catch((error) => {
        console.error(
          `[ep:reanime] Detail error ${id}:`,
          error.message
        );
        return null;
      }),
    }))
  );

  for (const { id, detail } of details) {
    if (
      Number(detail?.anilist_id) === numericId
    ) {
      const data = {
        animeId: id,
        title:
          detail.title?.english ||
          detail.title?.romaji ||
          candidates.get(id)?.title?.english ||
          id,
        anilistId: numericId,
        malId: detail.mal_id || malId,
        subbed: Number.isFinite(detail.subbed)
          ? detail.subbed
          : null,
        dubbed: Number.isFinite(detail.dubbed)
          ? detail.dubbed
          : null,
        episodesCount: Number.isFinite(detail.episodes)
          ? detail.episodes
          : null,
        matchType: "anilist",
        matchScore: 1,
      };

      console.log(
        `[ep:reanime] Matched AniList ${numericId} by detail: ${id}`
      );

      cacheSet(cacheKey, data, SHOW_IDENTITY_TTL);
      return data;
    }
  }

  // Fourth: MyAnimeList ID fallback.
  if (malId) {
    for (const { id, detail } of details) {
      if (
        detail?.mal_id &&
        Number(detail.mal_id) === Number(malId)
      ) {
        const data = {
          animeId: id,
          title:
            detail.title?.english ||
            detail.title?.romaji ||
            id,
          anilistId: numericId,
          malId: Number(detail.mal_id),
          subbed: Number.isFinite(detail.subbed)
            ? detail.subbed
            : null,
          dubbed: Number.isFinite(detail.dubbed)
            ? detail.dubbed
            : null,
          episodesCount: Number.isFinite(detail.episodes)
            ? detail.episodes
            : null,
          matchType: "mal",
          matchScore: 0.9,
        };

        console.log(
          `[ep:reanime] Matched AniList ${numericId} by MAL: ${id}`
        );

        cacheSet(cacheKey, data, SHOW_IDENTITY_TTL);
        return data;
      }
    }
  }

  console.error(
    `[ep:reanime] No match for AniList ${numericId}. Candidate IDs:`,
    [...candidates.keys()]
  );

  throw new Error(
    `No confirmed reanime match for AniList ${numericId}`
  );
}

// Fetch episodes
async function fetchEpisodesList(animeId, limit = 2000) {
  const params = new URLSearchParams({
    limit: String(limit),
  });

  const response = await fetch(
    `${BASE}/api/v1/anime/${encodeURIComponent(animeId)}/episodes?${params}`,
    { headers: H }
  );

  const raw = await response.text();

  if (!response.ok) {
    const error = new Error(
      `Reanime episodes ${response.status}`
    );
    error.rawBody = raw;
    throw error;
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid JSON returned by Reanime episodes"
    );
  }

  return Array.isArray(data?.data) ? data.data : [];
}

// Fetch AniZip metadata
async function fetchAnizip(anilistId) {
  return fetch(
    `${ANIZIP2}?anilist_id=${anilistId}`
  )
    .then((response) => response.json())
    .catch(() => null);
}

// Merge episode information
function mergeEpisode(anilistId, ep, meta, audio) {
  const number = ep.episode_number;

  return {
    id: `watch/reanime/${anilistId}/${audio}/reanime-${number}`,
    number,
    title:
      meta?.title?.en ||
      meta?.title?.["x-jat"] ||
      ep.title ||
      `Episode ${number}`,
    titleJapanese:
      meta?.title?.ja ||
      ep.title_japanese ||
      null,
    titleRomanji:
      meta?.title?.["x-jat"] ||
      ep.title_romanji ||
      null,
    image:
      meta?.image ||
      ep.thumbnail ||
      null,
    airDate:
      meta?.airdate ||
      ep.aired ||
      null,
    duration: meta?.runtime
      ? meta.runtime * 60
      : ep.duration
        ? ep.duration * 60
        : null,
    score: null,
    filler: ep.is_filler ?? meta?.filler ?? false,
    recap: ep.is_recap ?? false,
    description:
      meta?.overview ||
      ep.description ||
      null,
    audio,
  };
}

// JSON response
function json3(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// Handle episodes
async function handleEpisodes3(anilistId, url) {
  const series = await resolveSeries(anilistId);

  const [reanimeEps, anizip] = await Promise.all([
    fetchEpisodesList(series.animeId),
    fetchAnizip(anilistId),
  ]);

  if (!reanimeEps.length) {
    return json3({
      error: `No Reanime episodes found for AniList ID ${anilistId} (slug ${series.animeId})`,
    }, 404);
  }

  const episodes = reanimeEps
    .map((ep) => {
      const meta =
        anizip?.episodes?.[String(ep.episode_number)] ?? null;

      return mergeEpisode(anilistId, ep, meta, "sub");
    })
    .sort((a, b) => a.number - b.number);

  return json3({
    anime: series.title,
    anilistId: Number(anilistId),
    malId: series.malId,
    animeId: series.animeId,
    episodes,
    pagination: {
      currentPage: 1,
      lastPage: 1,
      hasNextPage: false,
    },
  });
}

// Resolve video streams
async function resolveStream3(anilistId, audio, ep) {
  const series = await resolveSeries(anilistId);

  const title = series.title;
  const slug = series.animeId;

  const order = {
    "HD-2": 0,
    "HD-1": 1,
  };

  const byPrio = (arr) =>
    arr.slice().sort(
      (a, b) =>
        (order[a.serverName] ?? 9) -
        (order[b.serverName] ?? 9)
    );

  const [watchRes, flixRes] = await Promise.allSettled([
    fetch(`${BASE}/api/watch/${slug}/${ep}`, {
      headers: H,
    }).then(async (response) => {
      const raw = await response.text();

      if (!response.ok) {
        const error = new Error(`Watch ${response.status}`);
        error.rawBody = raw;
        throw error;
      }

      return JSON.parse(raw);
    }),

    fetch(`${BASE}/api/flix/${anilistId}/${ep}`, {
      headers: H,
    }).then(async (response) => {
      const raw = await response.text();

      if (!response.ok) {
        const error = new Error(`Flix ${response.status}`);
        error.rawBody = raw;
        throw error;
      }

      return JSON.parse(raw);
    }),
  ]);

  const watchData =
    watchRes.status === "fulfilled"
      ? watchRes.value
      : null;

  const flixData =
    flixRes.status === "fulfilled"
      ? flixRes.value
      : null;

  const links = [
    ...(watchData?.episode_links ?? []),
  ];

  if (flixData?.success && flixData?.servers) {
    const seen = new Set(
      links.map((server) => server["$id"])
    );

    for (const server of flixData.servers) {
      if (!seen.has(server["$id"])) {
        links.push(server);
      }
    }
  }

  const audioTypes =
    audio === "sub"
      ? ["sub", "s-sub"]
      : ["dub", "s-dub"];

  const servers = byPrio(
    links.filter((server) =>
      audioTypes.includes(server.dataType)
    )
  );

  if (!servers.length) {
    throw Object.assign(
      new Error(`No ${audio} servers for "${title}" ep ${ep}`),
      { status: 404 }
    );
  }

  const seenServers = new Set();

  const uniqueServers = servers.filter((server) => {
    const key =
      `${server.serverName}:${server.dataType}:${server.dataLink}`;

    if (seenServers.has(key)) return false;

    seenServers.add(key);
    return true;
  });

  const decrypted = await Promise.all(
    uniqueServers.map(async (server, index) => {
      try {
        const embedResponse = await fetch(server.dataLink, {
          headers: {
            ...H,
            Referer: `${BASE}/`,
          },
        });

        if (!embedResponse.ok) {
          throw new Error(
            `Embed fetch failed: ${embedResponse.status}`
          );
        }

        const stream = await extractFlixcloud(
          await embedResponse.text(),
          {
            apiBase: FLIX,
            headers: H,
            referer: `${BASE}/`,
          }
        );

        return {
          server,
          stream,
          index,
        };
      } catch (error) {
        return {
          server,
          error: error.message,
          index,
        };
      }
    })
  );

  const streams = decrypted.filter(
    (item) => item.stream?.url
  );

  if (!streams.length) {
    const error =
      decrypted.find((item) => item.error)?.error ||
      "No decrypted streams";

    throw Object.assign(
      new Error(error),
      { status: 502 }
    );
  }

  return {
    title,
    slug,
    watchData,
    stream: streams[0].stream,
    server: streams[0].server.serverName,
    servers: uniqueServers,
    streams,
    failedServers: decrypted.filter(
      (item) => item.error
    ),
  };
}

// Handle watch
async function handleWatch3(anilistId, audio, epNum, origin) {
  if (audio !== "sub" && audio !== "dub") {
    return json3({
      error: "audio must be sub or dub",
    }, 400);
  }

  const ep = parseInt(epNum, 10);

  if (isNaN(ep)) {
    return json3({
      error: `Invalid episode: ${epNum}`,
    }, 400);
  }

  let resolved;

  try {
    resolved = await resolveStream3(
      anilistId,
      audio,
      ep
    );
  } catch (error) {
    return json3({
      error: error.message,
      "Raw-ERROR": error.rawBody ?? null,
      stack: error.stack,
    }, error.status ?? 500);
  }

  const {
    title,
    slug,
    watchData,
    stream,
    server,
    servers,
    streams,
    failedServers,
  } = resolved;

  const seenStreamUrls = new Set();

  const cleanStreams = streams
    .map(({ server: source, stream: item, index }) => ({
      server: source.serverName,
      audio: source.dataType,
      index,
      url: item.url,
      type: "hls",
      embed: source.dataLink,
      key: item.key ?? null,
      playlist_key: item.playlist_key ?? item.key ?? null,
      subtitles: item.subtitles ?? [],
      thumbnails_vtt: item.thumbnails_vtt ?? null,
      video_title: item.video_title ?? null,
      intro: item.intro_chapter ?? null,
      outro: item.outro_chapter ?? null,
    }))
    .filter((item) => {
      if (seenStreamUrls.has(item.url)) return false;

      seenStreamUrls.add(item.url);
      return true;
    });

  const embeds = servers.map((server) => ({
    name: server.serverName,
    type: server.dataType,
    url: server.dataLink,
  }));

  return json3({
    anime: title,
    slug,
    ep: Number(ep),
    audio,
    server,
    stream_url: stream.url,
    streams: cleanStreams,
    subtitles: stream.subtitles,
    thumbnails_vtt: stream.thumbnails_vtt,
    video_title: stream.video_title,
    intro: stream.intro_chapter,
    outro: stream.outro_chapter,
    intro_start: watchData?.intro_start ?? null,
    intro_end: watchData?.intro_end ?? null,
    outro_start: watchData?.outro_start ?? null,
    outro_end: watchData?.outro_end ?? null,
    embeds,
    allServers: servers.map((server) => ({
      name: server.serverName,
      type: server.dataType,
      embed: server.dataLink,
    })),
    failedServers: failedServers.map((item) => ({
      name: item.server.serverName,
      type: item.server.dataType,
      error: item.error,
    })),
  });
}

// Handle stream redirect
async function handleStream3(anilistId, audio, epNum) {
  if (audio !== "sub" && audio !== "dub") {
    return json3({
      error: "audio must be sub or dub",
    }, 400);
  }

  const ep = parseInt(epNum, 10);

  if (isNaN(ep)) {
    return json3({
      error: `Invalid episode: ${epNum}`,
    }, 400);
  }

  let resolved;

  try {
    resolved = await resolveStream3(
      anilistId,
      audio,
      ep
    );
  } catch (error) {
    return json3({
      error: error.message,
      "Raw-ERROR": error.rawBody ?? null,
      stack: error.stack,
    }, error.status ?? 500);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: resolved.stream.url,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

// API router
const reanime_default = {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    try {
      let match;

      if (path === "/healthz") {
        return json3({
          status: "ok",
          provider: "reanime",
        });
      }

      match = path.match(/^\/episodes\/(\d+)$/);

      if (match) {
        return await handleEpisodes3(match[1], url);
      }

      match = path.match(
        /^\/watch\/(\d+)\/(sub|dub)\/(\d+)$/
      );

      if (match) {
        return await handleWatch3(
          match[1],
          match[2],
          match[3],
          url.origin
        );
      }

      match = path.match(
        /^\/stream\/(\d+)\/(sub|dub)\/(\d+)$/
      );

      if (match) {
        return await handleStream3(
          match[1],
          match[2],
          match[3]
        );
      }

      return json3({
        error: "Not found",
        routes: [
          "GET /episodes/:anilistId",
          "GET /watch/:anilistId/sub|dub/:ep",
          "GET /stream/:anilistId/sub|dub/:ep",
        ],
      }, 404);
    } catch (error) {
      return json3({
        error: error.message,
        "Raw-ERROR": error.rawBody ?? null,
        ...(error.debug ? { debug: error.debug } : {}),
        stack: error.stack,
      }, 500);
    }
  },
};

// Provider episode function
async function getEpisodes3(anilistId, ctx = {}) {
  const series = await resolveSeries(anilistId, ctx);

  const anizip =
    ctx.anizip !== undefined
      ? ctx.anizip
      : await fetchAnizip(anilistId);

  const reanimeEps = await fetchEpisodesList(
    series.animeId
  );

  if (!reanimeEps.length) {
    throw new Error(
      `No Reanime episodes found for AniList ${anilistId} (slug ${series.animeId})`
    );
  }

  const hasSub =
    series.subbed == null || series.subbed > 0;

  const dubCount = series.dubbed ?? 0;

  const sub = [];
  const dub = [];

  for (const ep of reanimeEps) {
    const meta =
      anizip?.episodes?.[String(ep.episode_number)] ?? null;

    if (hasSub) {
      sub.push(
        mergeEpisode(anilistId, ep, meta, "sub")
      );
    }

    if (
      dubCount > 0 &&
      ep.episode_number <= dubCount
    ) {
      dub.push(
        mergeEpisode(anilistId, ep, meta, "dub")
      );
    }
  }

  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);

  return {
    meta: {
      title: series.title,
      malId: series.malId,
      animeId: series.animeId,
    },
    episodes: {
      sub,
      dub,
    },
  };
}

export default reanime_default;
export { getEpisodes3 as getEpisodes };
