import { readFile, writeFile, rename } from "node:fs/promises";
import { loadEnvFile } from "node:process";

/* ============================================================
 * t00ns rarity calculator — OpenSea edition
 *
 * This version avoids downloading 5,000 files from public IPFS
 * gateways. It retrieves up to 200 NFTs per OpenSea API request.
 *
 * Requirements:
 *   Node.js 22+
 *
 *   .env:
 *   OPENSEA_API_KEY=your_key
 *
 * Run:
 *   node rarity.mjs
 *
 * Outputs:
 *   t00ns-rank-index.json
 *   t00ns-by-id.csv
 *   t00ns-by-rank.csv
 *   t00ns-rarity-full.json
 *   t00ns-opensea-cache.json
 * ============================================================
 */

/* ============================================================
 * Load .env
 * ============================================================
 */

try {
  loadEnvFile(".env");
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }

  console.error("Could not find .env in this directory.");
  process.exit(1);
}

/* ============================================================
 * Configuration
 * ============================================================
 */

const OPENSEA_API_KEY =
  process.env.OPENSEA_API_KEY?.trim();

const COLLECTION_SLUG =
  process.env.OPENSEA_COLLECTION_SLUG?.trim() ||
  "just-t00ns-ethereum";

const CONTRACT_ADDRESS =
  "0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9";

const EXPECTED_COLLECTION_SIZE = Number(
  process.env.COLLECTION_SIZE ?? 5000,
);

const PAGE_SIZE = Math.min(
  200,
  Math.max(
    1,
    Number(process.env.OPENSEA_PAGE_SIZE ?? 200),
  ),
);

const REQUEST_DELAY_MS = Math.max(
  0,
  Number(process.env.REQUEST_DELAY_MS ?? 300),
);

const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000),
);

const MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.MAX_ATTEMPTS ?? 10),
);

const INCLUDE_TRAIT_COUNT =
  process.env.INCLUDE_TRAIT_COUNT !== "false";

const CACHE_FILE =
  "./t00ns-opensea-cache.json";

const RANK_INDEX_FILE =
  "./t00ns-rank-index.json";

const BY_ID_CSV_FILE =
  "./t00ns-by-id.csv";

const BY_RANK_CSV_FILE =
  "./t00ns-by-rank.csv";

const FULL_RESULTS_FILE =
  "./t00ns-rarity-full.json";

const MISSING_VALUE = "__NONE__";

if (!OPENSEA_API_KEY) {
  console.error(
    "OPENSEA_API_KEY is missing from your .env file.",
  );

  console.error(
    "Expected: OPENSEA_API_KEY=your_real_key",
  );

  process.exit(1);
}

if (
  !Number.isInteger(EXPECTED_COLLECTION_SIZE) ||
  EXPECTED_COLLECTION_SIZE <= 0
) {
  throw new Error(
    "COLLECTION_SIZE must be a positive integer.",
  );
}

/* ============================================================
 * Utilities
 * ============================================================
 */

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function randomJitter(maximum = 250) {
  return Math.floor(Math.random() * maximum);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(
    0,
    Math.floor(milliseconds / 1000),
  );

  const hours = Math.floor(totalSeconds / 3600);

  const minutes = Math.floor(
    (totalSeconds % 3600) / 60,
  );

  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function retryAfterMilliseconds(value) {
  if (!value) {
    return 0;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);

  if (Number.isNaN(date)) {
    return 0;
  }

  return Math.max(0, date - Date.now());
}

function csvEscape(value) {
  const text = String(value ?? "");

  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n")
  ) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function normalizeTraitType(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTraitValue(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return MISSING_VALUE;
  }

  return String(value).trim();
}

/* ============================================================
 * OpenSea cache
 * ============================================================
 */

function createEmptyCache() {
  return {
    version: 1,
    collectionSlug: COLLECTION_SLUG,
    contractAddress: CONTRACT_ADDRESS,
    expectedCollectionSize:
      EXPECTED_COLLECTION_SIZE,
    next: null,
    started: false,
    complete: false,
    updatedAt: null,
    nfts: {},
  };
}

async function loadCache() {
  try {
    const contents = await readFile(
      CACHE_FILE,
      "utf8",
    );

    const parsed = JSON.parse(contents);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "Cache is not a valid JSON object.",
      );
    }

    if (
      parsed.collectionSlug &&
      parsed.collectionSlug !== COLLECTION_SLUG
    ) {
      throw new Error(
        `Cache belongs to collection "${parsed.collectionSlug}", not "${COLLECTION_SLUG}".`,
      );
    }

    return {
      ...createEmptyCache(),
      ...parsed,
      nfts:
        parsed.nfts &&
        typeof parsed.nfts === "object"
          ? parsed.nfts
          : {},
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createEmptyCache();
    }

    console.error(
      `Could not load ${CACHE_FILE}: ${error.message}`,
    );

    console.error(
      `Delete it and restart: rm -f ${CACHE_FILE}`,
    );

    process.exit(1);
  }
}

async function saveCache(cache) {
  const temporaryFile = `${CACHE_FILE}.tmp`;

  cache.updatedAt = new Date().toISOString();

  await writeFile(
    temporaryFile,
    JSON.stringify(cache),
    "utf8",
  );

  await rename(
    temporaryFile,
    CACHE_FILE,
  );
}

/* ============================================================
 * OpenSea API
 * ============================================================
 */

async function fetchOpenSeaPage(nextCursor = null) {
  const url = new URL(
    `https://api.opensea.io/api/v2/collection/${encodeURIComponent(
      COLLECTION_SLUG,
    )}/nfts`,
  );

  url.searchParams.set(
    "limit",
    String(PAGE_SIZE),
  );

  if (nextCursor) {
    url.searchParams.set(
      "next",
      nextCursor,
    );
  }

  let lastError = new Error(
    "Unknown OpenSea API error.",
  );

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt += 1
  ) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        url.toString(),
        {
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "x-api-key": OPENSEA_API_KEY,
            "user-agent":
              "t00ns-rarity-calculator/4.0",
          },
        },
      );

      const bodyText = await response.text();

      let data = {};

      try {
        data = bodyText
          ? JSON.parse(bodyText)
          : {};
      } catch {
        throw new Error(
          `OpenSea returned invalid JSON: ${bodyText.slice(
            0,
            250,
          )}`,
        );
      }

      if (response.ok) {
        return {
          data,
          rateLimit: {
            limit:
              response.headers.get(
                "x-ratelimit-limit",
              ),
            remaining:
              response.headers.get(
                "x-ratelimit-remaining",
              ),
            reset:
              response.headers.get(
                "x-ratelimit-reset",
              ),
          },
        };
      }

      const message =
        data?.detail ??
        data?.message ??
        data?.error ??
        response.statusText;

      lastError = new Error(
        `OpenSea HTTP ${response.status}: ${message}`,
      );

      if (
        response.status === 401 ||
        response.status === 403
      ) {
        throw lastError;
      }

      if (response.status === 404) {
        throw new Error(
          `OpenSea collection "${COLLECTION_SLUG}" was not found. Set OPENSEA_COLLECTION_SLUG correctly in .env.`,
        );
      }

      if (response.status === 429) {
        const retryAfter =
          retryAfterMilliseconds(
            response.headers.get(
              "retry-after",
            ),
          );

        const delay = Math.max(
          retryAfter,
          3_000 * attempt,
        );

        console.log(
          `OpenSea rate limited the request. Retrying in ${Math.ceil(
            delay / 1000,
          )} seconds...`,
        );

        await sleep(
          delay + randomJitter(),
        );

        continue;
      }

      if (response.status >= 500) {
        const delay = Math.min(
          20_000,
          1_000 * 2 ** (attempt - 1),
        );

        console.log(
          `OpenSea server error. Attempt ${attempt}/${MAX_ATTEMPTS}; retrying...`,
        );

        await sleep(
          delay + randomJitter(),
        );

        continue;
      }

      throw lastError;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        lastError = new Error(
          `OpenSea request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        );
      } else {
        lastError =
          error instanceof Error
            ? error
            : new Error(String(error));
      }

      if (
        lastError.message.includes(
          "collection",
        ) ||
        lastError.message.includes(
          "HTTP 401",
        ) ||
        lastError.message.includes(
          "HTTP 403",
        )
      ) {
        throw lastError;
      }

      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(
          15_000,
          750 * 2 ** (attempt - 1),
        );

        console.log(
          `Request failed: ${lastError.message}`,
        );

        console.log(
          `Retrying attempt ${attempt + 1}/${MAX_ATTEMPTS}...`,
        );

        await sleep(
          delay + randomJitter(),
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    `OpenSea request failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`,
  );
}

/* ============================================================
 * NFT parsing
 * ============================================================
 */

function extractTokenId(nft) {
  const candidates = [
    nft?.identifier,
    nft?.token_id,
    nft?.tokenId,
    nft?.id,
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

function extractContract(nft) {
  const candidates = [
    nft?.contract,
    nft?.contract_address,
    nft?.contractAddress,
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

function extractRawTraits(nft) {
  const candidates = [
    nft?.traits,
    nft?.attributes,
    nft?.metadata?.attributes,
    nft?.metadata?.traits,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function extractTraitType(attribute) {
  return (
    attribute?.trait_type ??
    attribute?.traitType ??
    attribute?.type ??
    ""
  );
}

function extractTraitValue(attribute) {
  return (
    attribute?.value ??
    attribute?.trait_value ??
    attribute?.traitValue ??
    null
  );
}

function normalizeNft(nft) {
  const tokenId = extractTokenId(nft);

  if (!tokenId) {
    return null;
  }

  const contract = extractContract(nft);

  if (
    contract &&
    contract !== CONTRACT_ADDRESS.toLowerCase()
  ) {
    return null;
  }

  const rawTraits = extractRawTraits(nft);

  const attributes = rawTraits
    .map((attribute) => {
      const traitType = normalizeTraitType(
        extractTraitType(attribute),
      );

      if (!traitType) {
        return null;
      }

      return {
        trait_type: traitType,
        value: normalizeTraitValue(
          extractTraitValue(attribute),
        ),
      };
    })
    .filter(Boolean);

  return {
    tokenId,
    name:
      nft?.name ??
      `t00ns #${tokenId}`,
    attributes,
    openseaUrl:
      nft?.opensea_url ??
      nft?.openseaUrl ??
      `https://opensea.io/item/ethereum/${CONTRACT_ADDRESS}/${tokenId}`,
  };
}

/* ============================================================
 * Download all collection pages
 * ============================================================
 */

const startTime = Date.now();
const cache = await loadCache();

console.log("");
console.log(
  "t00ns rarity calculator — OpenSea mode",
);

console.log(
  `Collection: ${COLLECTION_SLUG}`,
);

console.log(
  `Contract: ${CONTRACT_ADDRESS}`,
);

console.log(
  `Page size: ${PAGE_SIZE}`,
);

console.log(
  `Cached: ${Object.keys(cache.nfts).length}/${EXPECTED_COLLECTION_SIZE}`,
);

console.log("");

let pageNumber = 0;

if (!cache.complete) {
  while (true) {
    pageNumber += 1;

    const currentCount =
      Object.keys(cache.nfts).length;

    console.log(
      `Requesting page ${pageNumber} — currently ${currentCount}/${EXPECTED_COLLECTION_SIZE}...`,
    );

    const response = await fetchOpenSeaPage(
      cache.started ? cache.next : null,
    );

    const pageNfts = Array.isArray(
      response.data?.nfts,
    )
      ? response.data.nfts
      : [];

    if (pageNfts.length === 0) {
      if (!response.data?.next) {
        cache.complete = true;
        await saveCache(cache);
        break;
      }

      throw new Error(
        "OpenSea returned an empty page with another cursor.",
      );
    }

    let added = 0;
    let ignored = 0;

    for (const rawNft of pageNfts) {
      const nft = normalizeNft(rawNft);

      if (!nft) {
        ignored += 1;
        continue;
      }

      if (!cache.nfts[nft.tokenId]) {
        added += 1;
      }

      cache.nfts[nft.tokenId] = nft;
    }

    cache.started = true;
    cache.next =
      response.data?.next ?? null;

    const totalCount =
      Object.keys(cache.nfts).length;

    if (
      !cache.next ||
      totalCount >= EXPECTED_COLLECTION_SIZE
    ) {
      cache.complete = true;
    }

    await saveCache(cache);

    console.log(
      `Page ${pageNumber}: received ${pageNfts.length}, added ${added}, ignored ${ignored}.`,
    );

    console.log(
      `Progress: ${totalCount}/${EXPECTED_COLLECTION_SIZE}`,
    );

    if (
      response.rateLimit?.remaining !== null &&
      response.rateLimit?.remaining !==
        undefined
    ) {
      console.log(
        `OpenSea requests remaining: ${response.rateLimit.remaining}`,
      );
    }

    console.log("");

    if (cache.complete) {
      break;
    }

    await sleep(REQUEST_DELAY_MS);
  }
} else {
  console.log(
    "OpenSea cache is already marked complete.",
  );
}

/* ============================================================
 * Validate downloaded NFTs
 * ============================================================
 */

const downloadedNfts =
  Object.values(cache.nfts);

console.log(
  `Downloaded unique NFTs: ${downloadedNfts.length}`,
);

if (downloadedNfts.length === 0) {
  console.error("OpenSea returned no NFTs.");
  process.exit(1);
}

if (
  downloadedNfts.length <
  EXPECTED_COLLECTION_SIZE
) {
  console.warn("");
  console.warn(
    `OpenSea currently exposes ${downloadedNfts.length}/${EXPECTED_COLLECTION_SIZE} NFTs.`
  );
  console.warn(
    `Rarity will be calculated using the ${downloadedNfts.length} currently indexed NFTs.`
  );
  console.warn("");
}

const selectedNfts = downloadedNfts.sort(
  (left, right) =>
    Number(left.tokenId) -
    Number(right.tokenId),
);

const withoutTraits = selectedNfts.filter(
  (nft) =>
    !Array.isArray(nft.attributes) ||
    nft.attributes.length === 0,
);

if (withoutTraits.length > 0) {
  console.error("");
  console.error(
    `${withoutTraits.length} NFTs contain no traits in the OpenSea response.`,
  );

  console.error(
    "Example missing IDs:",
  );

  console.error(
    withoutTraits
      .slice(0, 20)
      .map((nft) => `#${nft.tokenId}`)
      .join(", "),
  );

  console.error("");
  console.error(
    "Rarity was not calculated because missing trait data would create invalid ranks.",
  );

  process.exit(1);
}

/* ============================================================
 * Convert traits into Maps
 * ============================================================
 */

const tokens = selectedNfts.map(
  (nft) => {
    const traits = new Map();

    for (const attribute of nft.attributes) {
      const traitType =
        normalizeTraitType(
          attribute.trait_type,
        );

      if (!traitType) {
        continue;
      }

      traits.set(
        traitType,
        normalizeTraitValue(
          attribute.value,
        ),
      );
    }

    return {
      tokenId: Number(nft.tokenId),
      name:
        nft.name ??
        `t00ns #${nft.tokenId}`,
      explicitTraitCount:
        traits.size,
      traits,
      openseaUrl:
        nft.openseaUrl,
    };
  },
);

/* ============================================================
 * Discover trait categories
 * ============================================================
 */

const traitTypes = [
  ...new Set(
    tokens.flatMap((token) => [
      ...token.traits.keys(),
    ]),
  ),
].sort();

console.log("");
console.log(
  `Detected ${traitTypes.length} trait categories:`,
);

console.log(
  traitTypes.join(", "),
);

/* ============================================================
 * Count trait occurrences
 * ============================================================
 */

function incrementCount(
  counts,
  traitType,
  traitValue,
) {
  if (!counts.has(traitType)) {
    counts.set(
      traitType,
      new Map(),
    );
  }

  const values = counts.get(traitType);

  values.set(
    traitValue,
    (values.get(traitValue) ?? 0) + 1,
  );
}

const effectiveTraitTypes =
  INCLUDE_TRAIT_COUNT
    ? [
        ...traitTypes,
        "__trait_count__",
      ]
    : [...traitTypes];

const counts = new Map();

for (const token of tokens) {
  for (const traitType of traitTypes) {
    const traitValue =
      token.traits.get(traitType) ??
      MISSING_VALUE;

    incrementCount(
      counts,
      traitType,
      traitValue,
    );
  }

  if (INCLUDE_TRAIT_COUNT) {
    incrementCount(
      counts,
      "__trait_count__",
      String(token.explicitTraitCount),
    );
  }
}

/* ============================================================
 * Calculate scores
 * ============================================================
 */

console.log("");
console.log("Calculating rarity scores...");

const collectionSize = tokens.length;

const rankedTokens = tokens.map(
  (token) => {
    let informationScore = 0;
    let traditionalScore = 0;

    const traitBreakdown = [];

    for (
      const traitType of effectiveTraitTypes
    ) {
      const traitValue =
        traitType === "__trait_count__"
          ? String(
              token.explicitTraitCount,
            )
          : token.traits.get(traitType) ??
            MISSING_VALUE;

      const count = counts
        .get(traitType)
        .get(traitValue);

      const frequency =
        count / collectionSize;

      const traitInformationScore =
        -Math.log2(frequency);

      const traitTraditionalScore =
        collectionSize / count;

      informationScore +=
        traitInformationScore;

      traditionalScore +=
        traitTraditionalScore;

      traitBreakdown.push({
        traitType,
        traitValue,
        count,
        percentage:
          frequency * 100,
        informationScore:
          traitInformationScore,
        traditionalScore:
          traitTraditionalScore,
      });
    }

    traitBreakdown.sort(
      (left, right) =>
        left.percentage -
          right.percentage ||
        left.traitType.localeCompare(
          right.traitType,
        ),
    );

    return {
      tokenId: token.tokenId,
      name: token.name,
      traitCount:
        token.explicitTraitCount,
      informationScore,
      traditionalScore,
      traits: traitBreakdown,
      openseaUrl:
        token.openseaUrl,
    };
  },
);

/* ============================================================
 * Sort and assign ranks
 * ============================================================
 */

rankedTokens.sort(
  (left, right) =>
    right.informationScore -
      left.informationScore ||
    right.traditionalScore -
      left.traditionalScore ||
    left.tokenId -
      right.tokenId,
);

let previousInformationScore = null;
let previousTraditionalScore = null;
let currentRank = 0;

for (
  let index = 0;
  index < rankedTokens.length;
  index += 1
) {
  const token = rankedTokens[index];

  const tied =
    previousInformationScore !== null &&
    previousTraditionalScore !== null &&
    Math.abs(
      token.informationScore -
        previousInformationScore,
    ) < 1e-12 &&
    Math.abs(
      token.traditionalScore -
        previousTraditionalScore,
    ) < 1e-12;

  if (!tied) {
    currentRank = index + 1;
  }

  token.rank = currentRank;

  token.topPercent =
    (currentRank / collectionSize) *
    100;

  previousInformationScore =
    token.informationScore;

  previousTraditionalScore =
    token.traditionalScore;
}

/* ============================================================
 * Build lookup index
 * ============================================================
 */

const rankIndex = {};

for (const token of rankedTokens) {
  rankIndex[token.tokenId] = {
    tokenId: token.tokenId,
    name: token.name,
    rank: token.rank,
    outOf: collectionSize,
    topPercent:
      token.topPercent,
    informationScore:
      token.informationScore,
    traditionalScore:
      token.traditionalScore,
    traitCount:
      token.traitCount,
    openseaUrl:
      token.openseaUrl,
    rarestTraits:
      token.traits
        .filter(
          (trait) =>
            trait.traitType !==
            "__trait_count__",
        )
        .slice(0, 5),
  };
}

/* ============================================================
 * CSV output
 * ============================================================
 */

const csvHeader = [
  "token_id",
  "rank",
  "out_of",
  "top_percent",
  "information_score",
  "traditional_score",
  "trait_count",
  "name",
  "opensea_url",
].join(",");

function tokenCsvRow(token) {
  return [
    token.tokenId,
    token.rank,
    collectionSize,
    token.topPercent.toFixed(6),
    token.informationScore.toFixed(12),
    token.traditionalScore.toFixed(12),
    token.traitCount,
    csvEscape(token.name),
    csvEscape(token.openseaUrl),
  ].join(",");
}

const tokensById = [
  ...rankedTokens,
].sort(
  (left, right) =>
    left.tokenId - right.tokenId,
);

/* ============================================================
 * Save outputs
 * ============================================================
 */

await Promise.all([
  writeFile(
    RANK_INDEX_FILE,
    JSON.stringify(
      rankIndex,
      null,
      2,
    ),
    "utf8",
  ),

  writeFile(
    BY_ID_CSV_FILE,
    `${csvHeader}\n${tokensById
      .map(tokenCsvRow)
      .join("\n")}\n`,
    "utf8",
  ),

  writeFile(
    BY_RANK_CSV_FILE,
    `${csvHeader}\n${rankedTokens
      .map(tokenCsvRow)
      .join("\n")}\n`,
    "utf8",
  ),

  writeFile(
    FULL_RESULTS_FILE,
    JSON.stringify(
      {
        contractAddress:
          CONTRACT_ADDRESS,
        collectionSlug:
          COLLECTION_SLUG,
        collectionSize,
        generatedAt:
          new Date().toISOString(),
        dataSource:
          "OpenSea API v2",
        algorithm: {
          primary:
            "summed_information_content",
          informationFormula:
            "-log2(trait_frequency)",
          traditionalFormula:
            "collection_size / trait_occurrence_count",
          includesMissingTraits:
            true,
          includesTraitCount:
            INCLUDE_TRAIT_COUNT,
        },
        tokens:
          rankedTokens,
      },
      null,
      2,
    ),
    "utf8",
  ),
]);

/* ============================================================
 * Final report
 * ============================================================
 */

console.log("");
console.log("Top 20 rarest t00ns:");

console.table(
  rankedTokens
    .slice(0, 20)
    .map((token) => ({
      id: `#${token.tokenId}`,
      rank: `#${token.rank}`,
      top:
        `${token.topPercent.toFixed(
          2,
        )}%`,
      score:
        token.informationScore.toFixed(
          6,
        ),
      traits:
        token.traitCount,
    })),
);

console.log("");
console.log("Generated files:");

console.log(
  `  ${RANK_INDEX_FILE}`,
);

console.log(
  `  ${BY_ID_CSV_FILE}`,
);

console.log(
  `  ${BY_RANK_CSV_FILE}`,
);

console.log(
  `  ${FULL_RESULTS_FILE}`,
);

console.log(
  `  ${CACHE_FILE}`,
);

console.log("");
console.log(
  `Finished in ${formatDuration(
    Date.now() - startTime,
  )}.`,
);

console.log("");
console.log(
  "You can now run:",
);

console.log(
  "  node lookup.mjs 2254",
);

console.log(
  "  node live-cheapest.mjs",
);