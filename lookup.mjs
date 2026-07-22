import { readFile } from "node:fs/promises";

const INDEX_FILE = "./t00ns-rank-index.json";

function extractTokenIds(text) {
  return [
    ...new Set(
      (String(text).match(/#?\d+/g) ?? [])
        .map((value) => Number(value.replace("#", "")))
        .filter(
          (value) =>
            Number.isSafeInteger(value) &&
            value >= 0,
        ),
    ),
  ];
}

function displayTraitValue(value) {
  return value === "__NONE__" ? "None" : String(value);
}

let rankIndex;

try {
  rankIndex = JSON.parse(
    await readFile(INDEX_FILE, "utf8"),
  );
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error(`Could not find ${INDEX_FILE}.`);
    console.error("Run rarity.mjs successfully first.");
    process.exit(1);
  }

  throw error;
}

const input = process.argv.slice(2).join(" ");
const requestedIds = extractTokenIds(input);

if (requestedIds.length === 0) {
  console.log("Usage:");
  console.log("  node lookup.mjs 2179");
  console.log("  node lookup.mjs 2179 2254 3132");
  process.exit(1);
}

const found = [];
const missing = [];

for (const tokenId of requestedIds) {
  const result = rankIndex[String(tokenId)];

  if (result) {
    found.push(result);
  } else {
    missing.push(tokenId);
  }
}

if (found.length === 1) {
  const item = found[0];

  console.log("");
  console.log(item.name ?? `t00ns #${item.tokenId}`);
  console.log(`Token ID:       #${item.tokenId}`);
  console.log(`Rarity rank:    #${item.rank} / ${item.outOf}`);
  console.log(
    `Top percentage: ${Number(item.topPercent).toFixed(2)}%`,
  );
  console.log(
    `Rarity score:   ${Number(item.informationScore).toFixed(6)}`,
  );
  console.log(`Trait count:    ${item.traitCount}`);

  if (
    Array.isArray(item.rarestTraits) &&
    item.rarestTraits.length > 0
  ) {
    console.log("\nRarest traits:");

    for (const trait of item.rarestTraits) {
      console.log(
        `  ${trait.traitType}: ${displayTraitValue(
          trait.traitValue,
        )}`,
      );

      console.log(
        `    ${trait.count}/${item.outOf} NFTs — ${Number(
          trait.percentage,
        ).toFixed(2)}%`,
      );
    }
  }

  console.log(
    `\nOpenSea: https://opensea.io/item/ethereum/0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9/${item.tokenId}`,
  );
}

if (found.length > 1) {
  console.table(
    found.map((item) => ({
      id: `#${item.tokenId}`,
      rank: `#${item.rank}`,
      outOf: item.outOf,
      top: `${Number(item.topPercent).toFixed(2)}%`,
      score: Number(item.informationScore).toFixed(6),
      traits: item.traitCount,
    })),
  );

  console.log("\nSorted from rarest to most common:");

  console.table(
    [...found]
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          left.tokenId - right.tokenId,
      )
      .map((item) => ({
        id: `#${item.tokenId}`,
        rank: `#${item.rank}`,
        top: `${Number(item.topPercent).toFixed(2)}%`,
      })),
  );
}

if (missing.length > 0) {
  console.warn(
    `\nNot found in the rarity index: ${missing
      .map((id) => `#${id}`)
      .join(", ")}`,
  );
}
