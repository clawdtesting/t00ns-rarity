import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";

/*
 * Load .env locally.
 * Render provides environment variables directly, so .env
 * will normally not exist in production.
 */
try {
  loadEnvFile(".env");
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

const PORT = Number(process.env.PORT ?? 10000);
const HOST = "0.0.0.0";

const OPENSEA_API_KEY =
  process.env.OPENSEA_API_KEY?.trim();

const COLLECTION_SLUG =
  process.env.OPENSEA_COLLECTION_SLUG?.trim() ||
  "just-t00ns-ethereum";

const CONTRACT_ADDRESS =
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
  5_000,
  Number(process.env.REQUEST_TIMEOUT_MS ?? 20_000),
);

if (!OPENSEA_API_KEY) {
  throw new Error(
    "OPENSEA_API_KEY environment variable is missing.",
  );
}

/* ============================================================
 * Load local rarity index
 * ============================================================
 */

let rankIndex;

try {
  rankIndex = JSON.parse(
    await readFile(RANK_INDEX_FILE, "utf8"),
  );
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
 * Utility functions
 * ============================================================
 */

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });

  response.end(
    JSON.stringify(data, null, 2),
  );
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });

  response.end(html);
}

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
  return [
    ...new Set(
      (String(value ?? "").match(/#?\d+/g) ?? [])
        .map((item) =>
          Number(item.replace("#", "")),
        )
        .filter(
          (item) =>
            Number.isSafeInteger(item) &&
            item >= 0,
        ),
    ),
  ].slice(0, 100);
}

function rarityTier(topPercent) {
  const value = Number(topPercent);

  if (!Number.isFinite(value)) {
    return "Unknown";
  }

  if (value <= 1) {
    return "Legendary";
  }

  if (value <= 5) {
    return "Epic";
  }

  if (value <= 15) {
    return "Rare";
  }

  if (value <= 30) {
    return "Uncommon";
  }

  return "Common";
}

function formatUnits(value, decimals) {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;

  if (decimals === 0) {
    return `${negative ? "-" : ""}${absolute}`;
  }

  const divisor = 10n ** BigInt(decimals);
  const whole = absolute / divisor;

  const fraction = String(
    absolute % divisor,
  )
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  const result = fraction
    ? `${whole}.${fraction}`
    : String(whole);

  return negative ? `-${result}` : result;
}

function extractTokenId(listing) {
  const candidates = [
    listing?.asset?.identifier,
    listing?.asset?.token_id,
    listing?.asset?.tokenId,

    listing?.nft?.identifier,
    listing?.nft?.token_id,
    listing?.nft?.tokenId,

    listing?.protocol_data?.parameters
      ?.offer?.[0]?.identifierOrCriteria,

    listing?.protocolData?.parameters
      ?.offer?.[0]?.identifierOrCriteria,

    listing?.protocol_data?.parameters
      ?.offer?.[0]?.identifier_or_criteria,
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

    listing?.protocol_data?.parameters
      ?.offer?.[0]?.token,

    listing?.protocolData?.parameters
      ?.offer?.[0]?.token,
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
  const current =
    listing?.price?.current ??
    listing?.price ??
    {};

  const rawValue =
    current?.value ??
    current?.amount ??
    listing?.current_price ??
    listing?.currentPrice ??
    listing?.protocol_data?.parameters
      ?.consideration?.[0]?.startAmount ??
    listing?.protocolData?.parameters
      ?.consideration?.[0]?.startAmount;

  if (
    rawValue === undefined ||
    rawValue === null
  ) {
    return null;
  }

  const decimals = Number(
    current?.decimals ??
      listing?.price?.decimals ??
      18,
  );

  const currencyValue =
    current?.currency ??
    current?.symbol ??
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
          Number.isInteger(decimals)
            ? decimals
            : 18,
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
 * OpenSea fetching
 * ============================================================
 */

const liveCache = new Map();

async function fetchOpenSea(url) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "x-api-key": OPENSEA_API_KEY,
        "user-agent": "t00ns-rarity-render/1.0",
      },
    });

    const text = await response.text();

    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `OpenSea returned invalid JSON: ${text.slice(
          0,
          200,
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

async function getCheapestListings(limit) {
  const cacheKey = String(limit);
  const cached = liveCache.get(cacheKey);

  if (
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return {
      ...cached.data,
      cache: "hit",
    };
  }

  const uniqueListings = new Map();

  const pageSize = Math.min(
    200,
    Math.max(50, limit * 4),
  );

  let next = null;
  let pagesFetched = 0;

  while (
    uniqueListings.size < limit &&
    pagesFetched < 5
  ) {
    pagesFetched += 1;

    const url = new URL(
      `https://api.opensea.io/api/v2/listings/collection/${encodeURIComponent(
        COLLECTION_SLUG,
      )}/best`,
    );

    url.searchParams.set(
      "limit",
      String(pageSize),
    );

    url.searchParams.set(
      "include_private_listings",
      "false",
    );

    if (next) {
      url.searchParams.set("next", next);
    }

    const data = await fetchOpenSea(
      url.toString(),
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
        uniqueListings.set(tokenId, {
          tokenId,
          price,
          orderHash:
            listing?.order_hash ??
            listing?.orderHash ??
            null,
        });
      }
    }

    next =
      data?.next ??
      data?.next_cursor ??
      null;

    if (!next || listings.length === 0) {
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
        rankIndex[listing.tokenId] ??
        null;

      const topPercent =
        rarity?.topPercent !== undefined
          ? Number(rarity.topPercent)
          : null;

      return {
        cheapestPosition: index + 1,
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
          rarity?.outOf ?? indexedCount,

        topPercent,

        tier:
          rarityTier(topPercent),

        rarityScore:
          rarity?.informationScore ?? null,

        traitCount:
          rarity?.traitCount ?? null,

        rarestTraits:
          rarity?.rarestTraits ?? [],

        openseaUrl:
          `https://opensea.io/item/ethereum/${CONTRACT_ADDRESS}/${listing.tokenId}`,
      };
    });

  const data = {
    collection: COLLECTION_SLUG,
    contract: CONTRACT_ADDRESS,
    indexedSupply: indexedCount,
    requestedLimit: limit,
    resultCount: results.length,
    pagesFetched,
    retrievedAt:
      new Date().toISOString(),
    results,
  };

  liveCache.set(cacheKey, {
    expiresAt:
      Date.now() +
      LIVE_CACHE_SECONDS * 1000,
    data,
  });

  return {
    ...data,
    cache: "miss",
  };
}

/* ============================================================
 * Lookup
 * ============================================================
 */

function lookupTokens(ids) {
  const found = [];
  const missing = [];

  for (const id of ids) {
    const item =
      rankIndex[String(id)];

    if (!item) {
      missing.push(id);
      continue;
    }

    found.push({
      ...item,
      tier:
        rarityTier(item.topPercent),

      openseaUrl:
        `https://opensea.io/item/ethereum/${CONTRACT_ADDRESS}/${id}`,
    });
  }

  return {
    requested: ids,
    found,
    missing,
  };
}

/* ============================================================
 * Browser dashboard
 * ============================================================
 */

const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >
  <title>t00ns Rarity Scanner</title>

  <style>
    :root {
      color-scheme: dark;
      font-family:
        Inter, ui-sans-serif, system-ui, sans-serif;
    }

    body {
      margin: 0;
      background: #0c0d10;
      color: #f4f4f5;
    }

    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 18px 80px;
    }

    h1 {
      margin-bottom: 4px;
    }

    .muted {
      color: #a1a1aa;
    }

    .panel {
      margin-top: 24px;
      padding: 18px;
      border: 1px solid #29292f;
      border-radius: 14px;
      background: #15161a;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    input,
    button {
      border: 1px solid #3f3f46;
      border-radius: 8px;
      padding: 10px 12px;
      background: #09090b;
      color: white;
      font: inherit;
    }

    button {
      cursor: pointer;
      background: #6d28d9;
      border-color: #7c3aed;
    }

    table {
      width: 100%;
      margin-top: 16px;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 10px 8px;
      border-bottom: 1px solid #29292f;
      text-align: left;
      white-space: nowrap;
    }

    th {
      color: #a1a1aa;
    }

    a {
      color: #c4b5fd;
    }

    .table-wrap {
      overflow-x: auto;
    }

    .error {
      color: #fca5a5;
      white-space: pre-wrap;
    }

    .lookup-result {
      margin-top: 14px;
      white-space: pre-wrap;
      line-height: 1.6;
    }
  </style>
</head>

<body>
  <main>
    <h1>t00ns Rarity Scanner</h1>

    <div class="muted">
      Live OpenSea listings combined with local rarity ranks.
    </div>

    <section class="panel">
      <h2>Cheapest listings</h2>

      <div class="controls">
        <input
          id="limit"
          type="number"
          min="1"
          max="100"
          value="${DEFAULT_LIMIT}"
        >

        <button id="refresh">
          Refresh listings
        </button>
      </div>

      <p id="status" class="muted"></p>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cheapest</th>
              <th>ID</th>
              <th>Price</th>
              <th>Rank</th>
              <th>Top</th>
              <th>Tier</th>
              <th>OpenSea</th>
            </tr>
          </thead>

          <tbody id="listings"></tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Rarity lookup</h2>

      <div class="controls">
        <input
          id="lookupIds"
          size="40"
          placeholder="2179, 2350, 1737"
        >

        <button id="lookupButton">
          Look up
        </button>
      </div>

      <div
        id="lookupResult"
        class="lookup-result"
      ></div>
    </section>
  </main>

  <script>
    const listingsBody =
      document.getElementById("listings");

    const status =
      document.getElementById("status");

    const limitInput =
      document.getElementById("limit");

    function appendCell(row, text) {
      const cell =
        document.createElement("td");

      cell.textContent = text;
      row.appendChild(cell);

      return cell;
    }

    async function loadListings() {
      const limit =
        Number(limitInput.value || ${DEFAULT_LIMIT});

      status.textContent =
        "Loading live listings...";

      listingsBody.replaceChildren();

      try {
        const response = await fetch(
          "/api/cheapest?limit=" +
            encodeURIComponent(limit),
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error || "Request failed",
          );
        }

        for (const item of data.results) {
          const row =
            document.createElement("tr");

          appendCell(
            row,
            String(item.cheapestPosition),
          );

          appendCell(
            row,
            "#" + item.tokenId,
          );

          appendCell(
            row,
            item.price + " " + item.currency,
          );

          appendCell(
            row,
            item.rarityRank === null
              ? "N/A"
              : "#" +
                item.rarityRank +
                " / " +
                item.rarityOutOf,
          );

          appendCell(
            row,
            item.topPercent === null
              ? "N/A"
              : Number(
                  item.topPercent,
                ).toFixed(2) + "%",
          );

          appendCell(
            row,
            item.tier,
          );

          const linkCell =
            document.createElement("td");

          const link =
            document.createElement("a");

          link.href = item.openseaUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "View";

          linkCell.appendChild(link);
          row.appendChild(linkCell);
          listingsBody.appendChild(row);
        }

        status.textContent =
          "Updated " +
          new Date(
            data.retrievedAt,
          ).toLocaleString() +
          " · " +
          data.resultCount +
          " unique listings · cache " +
          data.cache;
      } catch (error) {
        status.textContent =
          "Error: " + error.message;

        status.className = "error";
      }
    }

    async function lookup() {
      const ids =
        document
          .getElementById("lookupIds")
          .value;

      const output =
        document.getElementById(
          "lookupResult",
        );

      output.textContent = "Loading...";

      try {
        const response = await fetch(
          "/api/lookup?ids=" +
            encodeURIComponent(ids),
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error || "Lookup failed",
          );
        }

        const lines = [];

        for (const item of data.found) {
          lines.push(
            "#" +
              item.tokenId +
              " — rank #" +
              item.rank +
              " / " +
              item.outOf +
              " — top " +
              Number(
                item.topPercent,
              ).toFixed(2) +
              "% — " +
              item.tier,
          );
        }

        if (data.missing.length) {
          lines.push(
            "Not found: " +
              data.missing
                .map((id) => "#" + id)
                .join(", "),
          );
        }

        output.textContent =
          lines.join("\\n");
      } catch (error) {
        output.textContent =
          "Error: " + error.message;

        output.className =
          "lookup-result error";
      }
    }

    document
      .getElementById("refresh")
      .addEventListener(
        "click",
        loadListings,
      );

    document
      .getElementById("lookupButton")
      .addEventListener(
        "click",
        lookup,
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
      const url = new URL(
        request.url,
        `http://${request.headers.host ?? "localhost"}`,
      );

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        sendHtml(
          response,
          dashboardHtml,
        );

        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        sendJson(response, 200, {
          status: "ok",
          indexedCount,
          timestamp:
            new Date().toISOString(),
        });

        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/lookup"
      ) {
        const ids = extractTokenIds(
          url.searchParams.get("ids"),
        );

        if (ids.length === 0) {
          sendJson(response, 400, {
            error:
              "Provide token IDs using ?ids=2179,2350",
          });

          return;
        }

        sendJson(
          response,
          200,
          lookupTokens(ids),
        );

        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/cheapest"
      ) {
        const limit = clampLimit(
          url.sems.get("limit"),
        );

        const data =
          await getCheapestListings(limit);

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
