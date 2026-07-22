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
 * Dashboard
 * ============================================================
 */

const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <meta
    name="theme-color"
    content="#09090b"
  >

  <title>t00ns Rarity Scanner</title>

  <style>
    :root {
      color-scheme: dark;

      --background: #08090c;
      --panel: #131419;
      --panel-hover: #181a20;
      --input: #0c0d11;

      --border: #292b33;
      --border-strong: #3a3d48;

      --text: #f7f7f8;
      --muted: #a0a3ad;

      --accent: #7c3aed;
      --accent-hover: #8b5cf6;

      --green: #41d998;
      --red: #ff767d;

      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;

      background:
        radial-gradient(
          circle at 10% -10%,
          rgba(124, 58, 237, 0.18),
          transparent 30%
        ),
        #08090c;

      color: var(--text);
    }

    button,
    input {
      font: inherit;
    }

    button {
      cursor: pointer;
    }

    a {
      color: inherit;
    }

    .page {
      width: min(1380px, 100%);
      margin: 0 auto;
      padding: 24px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;

      margin-bottom: 30px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .logo {
      display: grid;
      place-items: center;

      width: 48px;
      height: 48px;

      border: 1px solid
        rgba(139, 92, 246, 0.45);

      border-radius: 15px;

      background:
        linear-gradient(
          145deg,
          rgba(139, 92, 246, 0.35),
          rgba(124, 58, 237, 0.08)
        );

      color: #c4b5fd;
      font-size: 22px;
      font-weight: 800;
    }

    h1 {
      margin: 0;
      font-size: clamp(
        25px,
        4vw,
        38px
      );
      letter-spacing: -0.04em;
    }

    .subtitle {
      margin: 7px 0 0;
      color: var(--muted);
    }

    .status-pill {
      display: flex;
      align-items: center;
      gap: 8px;

      padding: 9px 13px;

      border: 1px solid
        rgba(65, 217, 152, 0.25);

      border-radius: 999px;

      background:
        rgba(65, 217, 152, 0.08);

      color: #7ce8b8;
      font-size: 14px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow:
        0 0 14px
        rgba(65, 217, 152, 0.8);
    }

    .metrics {
      display: grid;
      grid-template-columns:
        repeat(3, minmax(0, 1fr));
      gap: 14px;

      margin-bottom: 18px;
    }

    .metric {
      padding: 18px;

      border: 1px solid var(--border);
      border-radius: 18px;

      background:
        rgba(19, 20, 25, 0.78);

      backdrop-filter: blur(16px);
    }

    .metric-label {
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .metric-value {
      margin-top: 7px;
      font-size: 25px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }

    .layout {
      display: grid;
      grid-template-columns:
        minmax(0, 1.6fr)
        minmax(320px, 0.7fr);
      gap: 18px;
      align-items: start;
    }

    .panel {
      border: 1px solid var(--border);
      border-radius: 22px;

      background:
        rgba(19, 20, 25, 0.82);

      backdrop-filter: blur(18px);
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;

      padding: 20px;

      border-bottom:
        1px solid var(--border);
    }

    .panel-title {
      margin: 0;
      font-size: 19px;
    }

    .panel-description {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    input {
      width: 100%;
      min-width: 0;

      padding: 11px 13px;

      border:
        1px solid var(--border-strong);

      border-radius: 11px;

      background: var(--input);
      color: var(--text);

      outline: none;
    }

    input:focus {
      border-color: var(--accent-hover);

      box-shadow:
        0 0 0 3px
        rgba(124, 58, 237, 0.15);
    }

    #limit {
      width: 85px;
    }

    button {
      padding: 11px 15px;

      border:
        1px solid
        rgba(139, 92, 246, 0.5);

      border-radius: 11px;

      background: var(--accent);
      color: white;

      font-weight: 650;
      white-space: nowrap;

      transition:
        transform 150ms ease,
        background 150ms ease;
    }

    button:hover {
      background:
        var(--accent-hover);

      transform:
        translateY(-1px);
    }

    button:disabled {
      cursor: wait;
      opacity: 0.6;
      transform: none;
    }

    .message {
      min-height: 21px;
      margin: 0;
      padding: 14px 20px 0;
      color: var(--muted);
      font-size: 14px;
    }

    .message.error {
      color: var(--red);
    }

    .table-wrap {
      width: 100%;
      overflow-x: auto;
      padding: 10px 20px 20px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 13px 10px;
      border-bottom:
        1px solid var(--border);

      text-align: left;
      white-space: nowrap;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
    }

    td {
      font-size: 14px;
    }

    tbody tr {
      transition:
        background 150ms ease;
    }

    tbody tr:hover {
      background:
        rgba(255, 255, 255, 0.025);
    }

    .rank {
      font-weight: 700;
    }

    .tier {
      display: inline-flex;
      padding: 5px 9px;

      border:
        1px solid var(--border);

      border-radius: 999px;

      background:
        rgba(255, 255, 255, 0.035);

      font-size: 12px;
      font-weight: 650;
    }

    .opensea-link {
      color: #bca8ff;
      font-weight: 650;
    }

    .lookup-body {
      padding: 20px;
    }

    .lookup-controls {
      display: flex;
      gap: 10px;
    }

    .lookup-results {
      display: grid;
      gap: 11px;
      margin-top: 18px;
    }

    .token-card {
      padding: 15px;

      border:
        1px solid var(--border);

      border-radius: 14px;

      background:
        rgba(255, 255, 255, 0.025);
    }

    .token-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .token-id {
      font-size: 17px;
      font-weight: 750;
    }

    .token-stats {
      display: grid;
      grid-template-columns:
        repeat(2, minmax(0, 1fr));
      gap: 10px;

      margin-top: 13px;
    }

    .token-stat {
      padding: 10px;

      border-radius: 10px;
      background:
        rgba(255, 255, 255, 0.025);
    }

    .token-stat-label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .token-stat-value {
      margin-top: 4px;
      font-weight: 650;
    }

    .empty {
      padding: 26px;
      color: var(--muted);
      text-align: center;
    }

    @media (
      max-width: 920px
    ) {
      .layout {
        grid-template-columns: 1fr;
      }

      .metrics {
        grid-template-columns:
          repeat(2, minmax(0, 1fr));
      }
    }

    @media (
      max-width: 620px
    ) {
      .page {
        padding: 15px;
      }

      .header {
        align-items: flex-start;
      }

      .status-pill {
        display: none;
      }

      .metrics {
        grid-template-columns: 1fr;
      }

      .panel-header,
      .controls,
      .lookup-controls {
        align-items: stretch;
        flex-direction: column;
      }

      #limit {
        width: 100%;
      }
    }
  </style>
</head>

<body>
  <main class="page">
    <header class="header">
      <div class="brand">
        <div class="logo">
          t0
        </div>

        <div>
          <h1>
            t00ns Rarity Scanner
          </h1>

          <p class="subtitle">
            Live marketplace intelligence powered by OpenSea and local rarity data.
          </p>
        </div>
      </div>

      <div class="status-pill">
        <span class="status-dot"></span>
        API online
      </div>
    </header>

    <section class="metrics">
      <div class="metric">
        <div class="metric-label">
          Indexed supply
        </div>

        <div
          id="indexedSupply"
          class="metric-value"
        >
          ${indexedCount.toLocaleString()}
        </div>
      </div>

      <div class="metric">
        <div class="metric-label">
          Live results
        </div>

        <div
          id="liveResults"
          class="metric-value"
        >
          —
        </div>
      </div>

      <div class="metric">
        <div class="metric-label">
          Last update
        </div>

        <div
          id="lastUpdate"
          class="metric-value"
        >
          —
        </div>
      </div>
    </section>

    <section class="layout">
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">
              Cheapest listings
            </h2>

            <p class="panel-description">
              Floor listings enriched with local rarity rankings.
            </p>
          </div>

          <div class="controls">
            <input
              id="limit"
              type="number"
              min="1"
              max="100"
              value="${DEFAULT_LIMIT}"
              aria-label="Number of listings"
            >

            <button
              id="refreshButton"
              type="button"
            >
              Refresh
            </button>
          </div>
        </div>

        <p
          id="listingStatus"
          class="message"
          aria-live="polite"
        >
          Loading listings…
        </p>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Floor</th>
                <th>Token</th>
                <th>Price</th>
                <th>Rarity rank</th>
                <th>Top</th>
                <th>Tier</th>
                <th>Market</th>
              </tr>
            </thead>

            <tbody id="listingsBody"></tbody>
          </table>
        </div>
      </div>

      <aside class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">
              Rarity lookup
            </h2>

            <p class="panel-description">
              Compare one or several token IDs.
            </p>
          </div>
        </div>

        <div class="lookup-body">
          <div class="lookup-controls">
            <input
              id="lookupInput"
              type="text"
              value="2350, 1737"
              placeholder="Example: 2179, 2350"
              aria-label="Token IDs"
            >

            <button
              id="lookupButton"
              type="button"
            >
              Look up
            </button>
          </div>

          <p
            id="lookupStatus"
            class="message"
            aria-live="polite"
          ></p>

          <div
            id="lookupResults"
            class="lookup-results"
          ></div>
        </div>
      </aside>
    </section>
  </main>

  <script>
    const limitInput =
      document.getElementById(
        "limit",
      );

    const refreshButton =
      document.getElementById(
        "refreshButton",
      );

    const listingStatus =
      document.getElementById(
        "listingStatus",
      );

    const listingsBody =
      document.getElementById(
        "listingsBody",
      );

    const liveResults =
      document.getElementById(
        "liveResults",
      );

    const lastUpdate =
      document.getElementById(
        "lastUpdate",
      );

    const lookupInput =
      document.getElementById(
        "lookupInput",
      );

    const lookupButton =
      document.getElementById(
        "lookupButton",
      );

    const lookupStatus =
      document.getElementById(
        "lookupStatus",
      );

    const lookupResults =
      document.getElementById(
        "lookupResults",
      );

    function setMessage(
      element,
      message,
      isError = false,
    ) {
      element.textContent = message;

      element.className = isError
        ? "message error"
        : "message";
    }

    function createCell(
      row,
      value,
      className = "",
    ) {
      const cell =
        document.createElement("td");

      cell.textContent = value;

      if (className) {
        cell.className = className;
      }

      row.appendChild(cell);

      return cell;
    }

    async function loadListings() {
      refreshButton.disabled = true;

      setMessage(
        listingStatus,
        "Loading live OpenSea listings…",
      );

      listingsBody.replaceChildren();

      const requestedLimit =
        Number(limitInput.value) ||
        ${DEFAULT_LIMIT};

      try {
        const response = await fetch(
          "/api/cheapest?limit=" +
            encodeURIComponent(
              requestedLimit,
            ),
        );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.error ||
              "Unable to load listings.",
          );
        }

        if (!data.results.length) {
          listingsBody.innerHTML =
            '<tr><td colspan="7" class="empty">No active listings were returned.</td></tr>';
        }

        for (
          const item of data.results
        ) {
          const row =
            document.createElement(
              "tr",
            );

          createCell(
            row,
            "#" +
              item.cheapestPosition,
          );

          createCell(
            row,
            "#" + item.tokenId,
            "rank",
          );

          createCell(
            row,
            item.price +
              " " +
              item.currency,
          );

          createCell(
            row,
            item.rarityRank === null
              ? "N/A"
              : "#" +
                  item.rarityRank +
                  " / " +
                  item.rarityOutOf,
          );

          createCell(
            row,
            item.topPercent === null
              ? "N/A"
              : Number(
                  item.topPercent,
                ).toFixed(2) + "%",
          );

          const tierCell =
            document.createElement(
              "td",
            );

          const tier =
            document.createElement(
              "span",
            );

          tier.className = "tier";
          tier.textContent =
            item.tier;

          tierCell.appendChild(tier);
          row.appendChild(tierCell);

          const linkCell =
            document.createElement(
              "td",
            );

          const link =
            document.createElement(
              "a",
            );

          link.href =
            item.openseaUrl;

          link.target = "_blank";
          link.rel =
            "noopener noreferrer";

          link.className =
            "opensea-link";

          link.textContent = "View ↗";

          linkCell.appendChild(link);
          row.appendChild(linkCell);

          listingsBody.appendChild(
            row,
          );
        }

        liveResults.textContent =
          String(data.resultCount);

        lastUpdate.textContent =
          new Date(
            data.retrievedAt,
          ).toLocaleTimeString(
            [],
            {
              hour: "2-digit",
              minute: "2-digit",
            },
          );

        setMessage(
          listingStatus,
          data.resultCount +
            " unique listings loaded · cache " +
            data.cache,
        );
      } catch (error) {
        setMessage(
          listingStatus,
          "Error: " + error.message,
          true,
        );

        listingsBody.innerHTML =
          '<tr><td colspan="7" class="empty">Listings unavailable.</td></tr>';
      } finally {
        refreshButton.disabled = false;
      }
    }

    async function lookupTokens() {
      const ids =
        lookupInput.value.trim();

      lookupResults.replaceChildren();

      if (!ids) {
        setMessage(
          lookupStatus,
          "Enter at least one token ID.",
          true,
        );

        return;
      }

      lookupButton.disabled = true;

      setMessage(
        lookupStatus,
        "Looking up rarity data…",
      );

      try {
        const response = await fetch(
          "/api/lookup?ids=" +
            encodeURIComponent(ids),
        );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.error ||
              "Lookup failed.",
          );
        }

        for (
          const item of data.found
        ) {
          const card =
            document.createElement(
              "article",
            );

          card.className =
            "token-card";

          const top =
            document.createElement(
              "div",
            );

          top.className =
            "token-card-top";

          const tokenId =
            document.createElement(
              "div",
            );

          tokenId.className =
            "token-id";

          tokenId.textContent =
            "#" + item.tokenId;

          const tier =
            document.createElement(
              "span",
            );

          tier.className = "tier";
          tier.textContent =
            item.tier;

          top.append(
            tokenId,
            tier,
          );

          const stats =
            document.createElement(
              "div",
            );

          stats.className =
            "token-stats";

          const rankStat =
            document.createElement(
              "div",
            );

          rankStat.className =
            "token-stat";

          rankStat.innerHTML =
            '<div class="token-stat-label">Rank</div>' +
            '<div class="token-stat-value">#' +
            item.rank +
            " / " +
            item.outOf +
            "</div>";

          const topStat =
            document.createElement(
              "div",
            );

          topStat.className =
            "token-stat";

          topStat.innerHTML =
            '<div class="token-stat-label">Top</div>' +
            '<div class="token-stat-value">' +
            Number(
              item.topPercent,
            ).toFixed(2) +
            "%</div>";

          stats.append(
            rankStat,
            topStat,
          );

          const link =
            document.createElement(
              "a",
            );

          link.href =
            item.openseaUrl;

          link.target = "_blank";
          link.rel =
            "noopener noreferrer";

          link.className =
            "opensea-link";

          link.textContent =
            "Open on OpenSea ↗";

          link.style.display =
            "inline-block";

          link.style.marginTop =
            "13px";

          card.append(
            top,
            stats,
            link,
          );

          lookupResults.appendChild(
            card,
          );
        }

        if (data.missing.length) {
          const missing =
            document.createElement(
              "div",
            );

          missing.className =
            "token-card";

          missing.textContent =
            "Not indexed: " +
            data.missing
              .map(
                (id) => "#" + id,
              )
              .join(", ");

          lookupResults.appendChild(
            missing,
          );
        }

        setMessage(
          lookupStatus,
          data.found.length +
            " token" +
            (
              data.found.length === 1
                ? ""
                : "s"
            ) +
            " found.",
        );
      } catch (error) {
        setMessage(
          lookupStatus,
          "Error: " + error.message,
          true,
        );
      } finally {
        lookupButton.disabled = false;
      }
    }

    refreshButton.addEventListener(
      "click",
      loadListings,
    );

    lookupButton.addEventListener(
      "click",
      lookupTokens,
    );

    lookupInput.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") {
          lookupTokens();
        }
      },
    );

    loadListings();
  </script>
</body>
</html>`;

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