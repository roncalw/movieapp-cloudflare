import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "..");
const defaultUrlFilePath = resolve(projectRoot, "data/cacheSearchURL.jsonc");
const urlFilePath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : defaultUrlFilePath;

function stripJsoncComments(fileText) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < fileText.length; index += 1) {
    const char = fileText[index];
    const nextChar = fileText[index + 1];

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && nextChar === "/") {
      while (index < fileText.length && fileText[index] !== "\n") {
        index += 1;
      }

      result += "\n";
      continue;
    }

    result += char;
  }

  return result;
}

function getCacheStatus(response) {
  const movieAppCacheStatus = response.headers.get("x-movieapp-cache");
  const cloudflareCacheStatus = response.headers.get("cf-cache-status");

  return {
    movieAppCacheStatus,
    cloudflareCacheStatus,
    status: movieAppCacheStatus ?? cloudflareCacheStatus ?? "UNKNOWN",
  };
}

async function readCacheUrls() {
  const fileText = await readFile(urlFilePath, "utf8");
  const cacheUrls = JSON.parse(stripJsoncComments(fileText));

  if (!Array.isArray(cacheUrls)) {
    throw new Error("cacheSearchURL.jsonc must contain an array.");
  }

  return cacheUrls.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      typeof entry.url !== "string"
    ) {
      throw new Error(
        `cacheSearchURL.jsonc entry ${index + 1} must have name and url strings.`,
      );
    }

    return entry;
  });
}

async function requestUrl(url) {
  const startedAt = performance.now();
  const response = await fetch(url);
  const elapsedMs = performance.now() - startedAt;
  await response.arrayBuffer();

  return {
    httpStatus: response.status,
    elapsedMs,
    ...getCacheStatus(response),
  };
}

function formatElapsedMs(elapsedMs) {
  return `${elapsedMs.toFixed(0)}ms`;
}

function logResult(prefix, result) {
  const headers = [
    `cache=${result.status}`,
    `http=${result.httpStatus}`,
    `time=${formatElapsedMs(result.elapsedMs)}`,
  ];

  if (result.cloudflareCacheStatus) {
    headers.push(`cf=${result.cloudflareCacheStatus}`);
  }

  if (result.movieAppCacheStatus) {
    headers.push(`movieapp=${result.movieAppCacheStatus}`);
  }

  console.log(`${prefix}: ${headers.join(" ")}`);
}

async function main() {
  const cacheUrls = await readCacheUrls();

  console.log(`Reading cache URLs from: ${urlFilePath}`);
  console.log(`Total URLs: ${cacheUrls.length}`);
  console.log("Running serially. The next URL waits for the previous URL.\n");

  for (const [index, entry] of cacheUrls.entries()) {
    console.log(`${index + 1}. ${entry.name}`);
    console.log(entry.url);

    const firstResult = await requestUrl(entry.url);
    logResult("first", firstResult);

    if (firstResult.status === "MISS") {
      const secondResult = await requestUrl(entry.url);
      logResult("retry", secondResult);
    }

    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
