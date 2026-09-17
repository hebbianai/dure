#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withHttpTimeout } from "./qa/lib/http-client.mjs";

const defaultOrigin = "https://docs.dureai.dev";
const configPath = new URL("../docs/public/docs.json", import.meta.url);
const latestMacDownload = "https://www.dureai.dev/download/mac/";

function isDownloadUrl(url) {
  return url.pathname.endsWith(".dmg") || url.href === latestMacDownload;
}

function downloadContract(config, origin) {
  const base = new URL(origin);
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username || base.password || base.search || base.hash ||
    base.pathname !== "/"
  ) {
    throw new Error("Provide a documentation origin without credentials, path or query");
  }

  const download = new URL(config?.navbar?.primary?.href);
  if (
    download.protocol !== "https:" || download.username || download.password ||
    !isDownloadUrl(download)
  ) {
    throw new Error("docs.json navbar.primary.href must be an HTTPS DMG or the official latest Mac download");
  }

  const languages = config?.navigation?.languages;
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error("docs.json must declare installation languages");
  }
  const routes = languages.map(({ language, groups }) => {
    const pages = (groups ?? []).flatMap((group) => group.pages ?? []);
    const installs = pages.filter(
      (page) => typeof page === "string" && page.endsWith("/install"),
    );
    if (
      !/^[a-z][a-z0-9-]*$/.test(language) || installs.length !== 1 ||
      installs[0] !== `${language}/install`
    ) {
      throw new Error(`Expected one installation route for language ${language}`);
    }
    return installs[0];
  });
  if (new Set(routes).size !== routes.length) {
    throw new Error("Duplicate installation routes");
  }
  return { origin: base.origin, expectedDownload: download.href, routes };
}

function installationSection(text, source) {
  const sections = [...text.matchAll(/^Source: (https?:\/\/\S+)\r?$/gm)];
  const matching = sections.filter((entry) => entry[1] === source);
  if (matching.length !== 1) {
    throw new Error(`Expected one aggregate section for ${source}`);
  }
  const entry = matching[0];
  const next = sections[sections.indexOf(entry) + 1];
  return text.slice(entry.index + entry[0].length, next?.index ?? text.length);
}

function downloadUrls(text) {
  return [...new Set((text.match(/https?:\/\/[^\s<>"'()[\]`]+/g) ?? [])
    .filter((value) => isDownloadUrl(new URL(value))))];
}

// This audits delivery, not release approval, installer safety or search indexing.
export async function checkPublicDocsDownloads(config, {
  origin = defaultOrigin,
  timeoutMs = 5_000,
} = {}) {
  const contract = downloadContract(config, origin);
  const targets = contract.routes.map((route) => ({ path: `/${route}.md` }));
  // Mintlify's root aggregate represents the first configured language.
  targets.push({
    path: "/llms-full.txt",
    source: `${contract.origin}/${contract.routes[0]}`,
  });
  const checks = await Promise.all(targets.map(async ({ path, source }) => {
    const url = `${contract.origin}${path}`;
    const result = { url, ok: false };
    try {
      await withHttpTimeout(url, async (signal) => {
        const response = await fetch(url, { method: "GET", redirect: "manual", signal });
        result.status = response.status;
        result.cache = Object.fromEntries(
          ["date", "cf-cache-status", "age", "cache-control", "last-modified", "cf-ray"]
            .map((name) => [name, response.headers.get(name)]),
        );
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}; redirects are not followed`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!/^text\/(?:plain|markdown)(?:;|$)/i.test(contentType)) {
          await response.body?.cancel();
          throw new Error(`Expected Markdown/text, received ${contentType || "no content type"}`);
        }
        const text = await response.text();
        result.downloads = downloadUrls(source ? installationSection(text, source) : text);
        if (
          result.downloads.length !== 1 ||
          result.downloads[0] !== contract.expectedDownload
        ) {
          throw new Error(`Installation downloads do not match ${contract.expectedDownload}`);
        }
        result.ok = true;
      }, timeoutMs);
    } catch (error) {
      result.error = error.message;
    }
    return result;
  }));
  return {
    ok: checks.every((check) => check.ok),
    expectedDownload: contract.expectedDownload,
    checks,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log([
      "Usage: pnpm docs:check-downloads [origin]",
      "Read-only check of installation Markdown and the ordinary AI aggregate against docs.json.",
      "No DMG download, cache invalidation, retries or indexing claim.",
    ].join("\n"));
  } else {
    try {
      if (args.length > 1) throw new Error("Usage: pnpm docs:check-downloads [origin]");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const report = await checkPublicDocsDownloads(config, { origin: args[0] });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
