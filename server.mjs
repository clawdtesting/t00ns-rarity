import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";

/* ============================================================
 * Environment
 * ============================================================
 */

try {
  loadEnvFile(".env");
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT ?? 10000);

const OPENSEA_API_KEY =
  process.env.OPENSEA_API_KEY?.trim();

const COLLECTION_SLUG =
  process.env.OPENSEA_COLLECTION_SLUG?.trim() ||
  "just-t00ns-ethereum";

const CONTRACT_ADDRESS =
  process.env.CONTRACT_ADDRESS?.trim() ||
  "0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9";

const RANK_INDEX_FILE =
  process.env.RANK_INDEX_FILE?.trim() ||
  "./t00ns-rank-index.json";

const DEFAULT_LIMIT = Math.min(
  100,
  Math.max(
    1,
    Number(process.env.DEFAULT_LIMIT ?? 25),
  ),
);

const LIVE_CACHE_SECONDS = Math.max(
  5,
  Number(process.env.LIVE_CACHE_SECONDS ?? 30),
);

const REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.REQUEST_TIMEOUT_MS ?? 20000),
);

if (!OPENSEA_API_KEY) {
  throw new Error(
    "Missing OPENSEA_API_KEY environment variable.",
  );
}

/* ============================================================
 * Load rarity index
 * ============================================================
 */

let rankIndex;

try {
  const rawIndex = await readFile(
    RANK_INDEX_FILE,
    "utf8",
  );

  rankIndex = JSON.parse(rawIndex);
} catch (error) {
  throw new Error(
    `Could not load ${RANK_INDEX_FILE}: ${error.message}`,
  );
}

const indexedCount = Object.keys(rankIndex).length;

console.log(
  `Loaded rarity information for ${indexedCount} t00ns.`,
);


let dashboardHtml;

try {
  dashboardHtml = await readFile(
    "./public/index.html",
    "utf8",
  );
} catch (error) {
  throw new Error(
    `Could not load dashboard: ${error.message}`,
  );
}

/* ============================================================
 * HTTP response helpers
 * ============================================================
 */

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "content-type":
      "application/json; charset=utf-8",

    "cache-control": "no-store",

    "access-control-allow-origin": "*",

    "access-control-allow-methods":
      "GET, OPTIONS",

    "access-control-allow-headers":
      "content-type",
  });

  response.end(
    JSON.stringify(data, null, 2),
  );
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type":
      "text/html; charset=utf-8",

    "cache-control": "no-store",
  });

  response.end(html);
}

/* ============================================================
 * General helpers
 * ============================================================
 */

function clampLimit(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(
    100,
    Math.max(1, parsed),
  );
}

function extractTokenIds(value) {
  const matches =
    String(value ?? "").match(/#?\d+/g) ?? [];

  const tokenIds = matches
    .map((item) =>
      Number(item.replace("#", "")),
    )
    .filter(
      (item) =>
        Number.isSafeInteger(item) &&
        item >= 0,
    );

  return [...new Set(tokenIds)].slice(
    0,
    100,
  );
}

function rarityTier(topPercent) {
  const percent = Number(topPercent);

  if (!Number.isFinite(percent)) {
    return "Unknown";
  }

  if (percent <= 1) {
    return "Legendary";
  }

  if (percent <= 5) {
    return "Epic";
  }

  if (percent <= 15) {
    return "Rare";
  }

  if (percent <= 30) {
    return "Uncommon";
  }

  return "Common";
}

function formatUnits(value, decimals) {
  const amount = BigInt(value);
  const negative = amount < 0n;

  const absolute = negative
    ? -amount
    : amount;

  if (decimals === 0) {
    return `${
      negative ? "-" : ""
    }${absolute}`;
  }

  const divisor =
    10n ** BigInt(decimals);

  const whole =
    absolute / divisor;

  const fraction = String(
    absolute % divisor,
  )
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  const formatted = fraction
    ? `${whole}.${fraction}`
    : String(whole);

  return negative
    ? `-${formatted}`
    : formatted;
}

/* ============================================================
 * Listing parsing
 * ============================================================
 */

function extractTokenId(listing) {
  const candidates = [
    listing?.asset?.identifier,
    listing?.asset?.token_id,
    listing?.asset?.tokenId,

    listing?.nft?.identifier,
    listing?.nft?.token_id,
    listing?.nft?.tokenId,

    listing?.protocol_data
      ?.parameters
      ?.offer?.[0]
      ?.identifierOrCriteria,

    listing?.protocol_data
      ?.parameters
      ?.offer?.[0]
      ?.identifier_or_criteria,

    listing?.protocolData
      ?.parameters
      ?.offer?.[0]
      ?.identifierOrCriteria,
  ];

  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      candidate !== null &&
      /^\d+$/.test(String(candidate))
    ) {
      return String(candidate);
    }
  }

  return null;
}

function extractContract(listing) {
  const candidates = [
    listing?.asset?.contract,
    listing?.asset?.contract_address,
    listing?.asset?.contractAddress,

    listing?.nft?.contract,
    listing?.nft?.contract_address,
    listing?.nft?.contractAddress,

    listing?.protocol_data
      ?.parameters
      ?.offer?.[0]
      ?.token,

    listing?.protocolData
      ?.parameters
      ?.offer?.[0]
      ?.token,
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      candidate.startsWith("0x")
    ) {
      return candidate.toLowerCase();
    }
  }

  return null;
}

function extractPrice(listing) {
  const currentPrice =
    listing?.price?.current ??
    listing?.price ??
    {};

  const rawValue =
    currentPrice?.value ??
    currentPrice?.amount ??
    listing?.current_price ??
    listing?.currentPrice ??
    listing?.protocol_data
      ?.parameters
      ?.consideration?.[0]
      ?.startAmount ??
    listing?.protocolData
      ?.parameters
      ?.consideration?.[0]
      ?.startAmount;

  if (
    rawValue === undefined ||
    rawValue === null
  ) {
    return null;
  }

  const decimalsValue = Number(
    currentPrice?.decimals ??
      listing?.price?.decimals ??
      18,
  );

  const decimals =
    Number.isInteger(decimalsValue)
      ? decimalsValue
      : 18;

  const currencyValue =
    currentPrice?.currency ??
    currentPrice?.symbol ??
    listing?.price?.currency ??
    listing?.price?.symbol ??
    "ETH";

  const currency =
    typeof currencyValue === "object"
      ? currencyValue?.symbol ??
        currencyValue?.name ??
        "ETH"
      : String(currencyValue);

  const rawString = String(rawValue);

  let formatted;

  try {
    formatted = rawString.includes(".")
      ? rawString
      : formatUnits(
          rawString,
          decimals,
        );
  } catch {
    formatted = rawString;
  }

  const numeric = Number(formatted);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return {
    rawValue: rawString,
    formatted,
    numeric,
    decimals,
    currency,
  };
}

/* ============================================================
 * OpenSea API
 * ============================================================
 */

const liveCache = new Map();

async function fetchOpenSea(url) {
  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,

      headers: {
        accept: "application/json",
        "x-api-key": OPENSEA_API_KEY,
        "user-agent":
          "t00ns-rarity-render/1.0",
      },
    });

    const text =
      await response.text();

    let data;

    try {
      data = text
        ? JSON.parse(text)
        : {};
    } catch {
      throw new Error(
        `OpenSea returned invalid JSON: ${text.slice(
          0,
          250,
        )}`,
      );
    }

    if (!response.ok) {
      const message =
        data?.errors?.join?.(", ") ??
        data?.detail ??
        data?.message ??
        data?.error ??
        response.statusText;

      throw new Error(
        `OpenSea HTTP ${response.status}: ${message}`,
      );
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `OpenSea request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getCheapestListings(
  limit,
) {
  const cacheKey = String(limit);

  const cached =
    liveCache.get(cacheKey);

  if (
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return {
      ...cached.data,
      cache: "hit",
    };
  }

  const uniqueListings =
    new Map();

  const pageSize = Math.min(
    200,
    Math.max(50, limit * 4),
  );

  let nextCursor = null;
  let pagesFetched = 0;

  while (
    uniqueListings.size < limit &&
    pagesFetched < 5
  ) {
    pagesFetched += 1;

    const openSeaUrl = new URL(
      `https://api.opensea.io/api/v2/listings/collection/${encodeURIComponent(
        COLLECTION_SLUG,
      )}/best`,
    );

    openSeaUrl.searchParams.set(
      "limit",
      String(pageSize),
    );

    openSeaUrl.searchParams.set(
      "include_private_listings",
      "false",
    );

    if (nextCursor) {
      openSeaUrl.searchParams.set(
        "next",
        nextCursor,
      );
    }

    const data =
      await fetchOpenSea(
        openSeaUrl.toString(),
      );

    const listings = Array.isArray(
      data?.listings,
    )
      ? data.listings
      : [];

    for (const listing of listings) {
      if (
        listing?.status &&
        listing.status !== "ACTIVE"
      ) {
        continue;
      }

      const tokenId =
        extractTokenId(listing);

      if (!tokenId) {
        continue;
      }

      const contract =
        extractContract(listing);

      if (
        contract &&
        contract !==
          CONTRACT_ADDRESS.toLowerCase()
      ) {
        continue;
      }

      const price =
        extractPrice(listing);

      if (!price) {
        continue;
      }

      const existing =
        uniqueListings.get(tokenId);

      if (
        !existing ||
        price.numeric <
          existing.price.numeric
      ) {
        uniqueListings.set(
          tokenId,
          {
            tokenId,
            price,

            orderHash:
              listing?.order_hash ??
              listing?.orderHash ??
              null,
          },
        );
      }
    }

    nextCursor =
      data?.next ??
      data?.next_cursor ??
      null;

    if (
      !nextCursor ||
      listings.length === 0
    ) {
      break;
    }
  }

  const results = [
    ...uniqueListings.values(),
  ]
    .sort(
      (left, right) =>
        left.price.numeric -
          right.price.numeric ||
        Number(left.tokenId) -
          Number(right.tokenId),
    )
    .slice(0, limit)
    .map((listing, index) => {
      const rarity =
        rankIndex[
          String(listing.tokenId)
        ] ?? null;

      const topPercent =
        rarity?.topPercent !==
        undefined
          ? Number(
              rarity.topPercent,
            )
          : null;

      return {
        cheapestPosition:
          index + 1,

        tokenId:
          Number(listing.tokenId),

        price:
          listing.price.formatted,

        numericPrice:
          listing.price.numeric,

        currency:
          listing.price.currency,

        rarityRank:
          rarity?.rank ?? null,

        rarityOutOf:
          rarity?.outOf ??
          indexedCount,

        topPercent,

        tier:
          rarityTier(topPercent),

        rarityScore:
          rarity?.informationScore ??
          rarity?.score ??
          null,

        traitCount:
          rarity?.traitCount ??
          null,

        rarestTraits:
          rarity?.rarestTraits ??
          [],

        openseaUrl:
          `https://opensea.io/item/ethereum/${CONTRACT_ADDRESS}/${listing.tokenId}`,
      };
    });

  const responseData = {
    collection:
      COLLECTION_SLUG,

    contract:
      CONTRACT_ADDRESS,

    indexedSupply:
      indexedCount,

    requestedLimit:
      limit,

    resultCount:
      results.length,

    pagesFetched,

    retrievedAt:
      new Date().toISOString(),

    results,
  };

  liveCache.set(cacheKey, {
    expiresAt:
      Date.now() +
      LIVE_CACHE_SECONDS * 1000,

    data: responseData,
  });

  return {
    ...responseData,
    cache: "miss",
  };
}

/* ============================================================
 * Rarity lookup
 * ============================================================
 */

function lookupTokens(tokenIds) {
  const found = [];
  const missing = [];

  for (const tokenId of tokenIds) {
    const item =
      rankIndex[String(tokenId)];

    if (!item) {
      missing.push(tokenId);
      continue;
    }

    found.push({
      ...item,

      tokenId:
        item.tokenId ??
        tokenId,

      tier:
        rarityTier(
          item.topPercent,
        ),

      openseaUrl:
        `https://opensea.io/item/ethereum/${CONTRACT_ADDRESS}/${tokenId}`,
    });
  }

  found.sort(
    (left, right) =>
      Number(left.rank ?? Infinity) -
      Number(right.rank ?? Infinity),
  );

  return {
    requested: tokenIds,
    found,
    missing,
  };
}


/* ============================================================
 * HTTP server
 * ============================================================
 */

const server = createServer(
  async (request, response) => {
    try {
      if (
        request.method === "OPTIONS"
      ) {
        response.writeHead(204, {
          "access-control-allow-origin":
            "*",

          "access-control-allow-methods":
            "GET, OPTIONS",

          "access-control-allow-headers":
            "content-type",
        });

        response.end();
        return;
      }

      /*
       * Important:
       * This must be a real URL object.
       * Use requestUrl consistently below.
       */
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${
          request.headers.host ??
          "localhost"
        }`,
      );

      if (
        request.method === "GET" &&
        requestUrl.pathname === "/"
      ) {
        sendHtml(
          response,
          dashboardHtml,
        );

        return;
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname ===
          "/health"
      ) {
        sendJson(response, 200, {
          status: "ok",

          collection:
            COLLECTION_SLUG,

          indexedCount,

          timestamp:
            new Date().toISOString(),
        });

        return;
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname ===
          "/api/lookup"
      ) {
        const tokenIds =
          extractTokenIds(
            requestUrl.searchParams.get(
              "ids",
            ),
          );

        if (
          tokenIds.length === 0
        ) {
          sendJson(response, 400, {
            error:
              "Provide token IDs using ?ids=2179,2350",
          });

          return;
        }

        sendJson(
          response,
          200,
          lookupTokens(tokenIds),
        );

        return;
      }

      if (
        request.method === "GET" &&
        requestUrl.pathname ===
          "/api/cheapest"
      ) {
        const limit = clampLimit(
          requestUrl.searchParams.get(
            "limit",
          ),
        );

        const data =
          await getCheapestListings(
            limit,
          );

        sendJson(
          response,
          200,
          data,
        );

        return;
      }

      sendJson(response, 404, {
        error: "Route not found",
      });
    } catch (error) {
      console.error(error);

      sendJson(response, 500, {
        error:
          error instanceof Error
            ? error.message
            : String(error),

        stack:
          process.env.NODE_ENV ===
          "production"
            ? undefined
            : error instanceof Error
              ? error.stack
              : null,
      });
    }
  },
);

server.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `t00ns server listening on http://${HOST}:${PORT}`,
    );
  },
);