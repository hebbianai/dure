import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { checkPublicDocsDownloads } from "./check-public-docs-downloads.mjs";

const config = JSON.parse(await readFile(new URL("../docs/public/docs.json", import.meta.url), "utf8"));
const cliPath = fileURLToPath(new URL("./check-public-docs-downloads.mjs", import.meta.url));
const expectedDownload = config.navbar.primary.href;
const languages = config.navigation.languages.map((entry) => entry.language);
const install = (download = expectedDownload) => `# Install\n\n[Download for macOS](${download})\n`;

async function fixture(context) {
  const requests = [];
  const responses = new Map(languages.map((locale) => [`/${locale}/install.md`, { body: install() }]));
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, cacheControl: request.headers["cache-control"] });
    const entry = responses.get(request.url);
    if (entry?.hang) {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.flushHeaders();
      return;
    }
    response.writeHead(entry?.status ?? 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "CF-Cache-Status": "HIT",
      Age: "72500",
      ...entry?.headers,
    });
    response.end(entry?.body ?? "missing fixture response");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.onTestFinished(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const aggregate = (body = install(), locale = languages[0]) => `# Install\nSource: ${origin}/${locale}/install\n\n${body}`;
  responses.set("/llms-full.txt", { body: aggregate() });
  return { origin, responses, requests, aggregate };
}

function runCli(origin) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, origin], (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, report: stdout ? JSON.parse(stdout) : null, stderr });
    });
  });
}

describe("public installation download delivery", () => {
  test("accepts the official current-beta endpoint without fetching an installer", async (context) => {
    const site = await fixture(context);
    const latest = structuredClone(config);
    latest.navbar.primary.href = "https://www.dureai.dev/download/mac/";
    for (const locale of languages) {
      site.responses.set(`/${locale}/install.md`, { body: install(latest.navbar.primary.href) });
    }
    site.responses.set("/llms-full.txt", { body: site.aggregate(install(latest.navbar.primary.href)) });
    const result = await checkPublicDocsDownloads(latest, site);
    expect(result.ok).toBe(true);
    expect(result.expectedDownload).toBe(latest.navbar.primary.href);
    expect(site.requests).toHaveLength(languages.length + 1);
    expect(site.requests.every(({ method, url }) => method === "GET" && !url.includes("download"))).toBe(true);
  });

  test("rejects a pinned installer even when current guidance also links the beta endpoint", async (context) => {
    const site = await fixture(context);
    const latest = structuredClone(config);
    latest.navbar.primary.href = "https://www.dureai.dev/download/mac/";
    const pinned = "https://github.com/hebbianai/hebbian-releases/releases/download/v0.2.18/Dure_0.2.18_aarch64.dmg";
    for (const locale of languages) {
      site.responses.set(`/${locale}/install.md`, { body: install(latest.navbar.primary.href) });
    }
    site.responses.set("/llms-full.txt", { body: site.aggregate(install(latest.navbar.primary.href)) });
    const path = `/${languages[0]}/install.md`;
    for (const body of [install(pinned), install(latest.navbar.primary.href) + install(pinned)]) {
      site.responses.set(path, { body });
      site.responses.set("/llms-full.txt", { body: site.aggregate(body) });
      const result = await checkPublicDocsDownloads(latest, site);
      expect(result.ok).toBe(false);
      expect(result.checks[0].ok).toBe(false);
      expect(result.checks.at(-1).ok).toBe(false);
    }
  });

  test("the same CLI rejects a stale HTTP-200 aggregate, then passes refreshed guidance", async (context) => {
    const site = await fixture(context);
    site.responses.set("/llms-full.txt", { body: site.aggregate("Open the official releases page. Current download: Hebbian v0.1.3.") });
    const red = await runCli(site.origin);
    expect(red.code).toBe(1);
    expect(red.report.ok).toBe(false);
    expect(red.report.checks.slice(0, -1).every((check) => check.ok)).toBe(true);
    expect(red.report.checks.at(-1)).toMatchObject({
      url: `${site.origin}/llms-full.txt`, status: 200, ok: false, downloads: [],
      cache: { "cf-cache-status": "HIT", age: "72500" },
    });
    site.responses.set("/llms-full.txt", { body: site.aggregate() });
    const green = await runCli(site.origin);
    expect(green.code).toBe(0);
    expect(green.report.ok).toBe(true);
    expect(green.report.checks).toHaveLength(languages.length + 1);
    expect(site.requests).toHaveLength((languages.length + 1) * 2);
    expect(site.requests.every(({ method, url, cacheControl }) => method === "GET" && !url.includes("?") && !cacheControl)).toBe(true);
  });

  test("rejects stale and conflicting localized downloads while reusing configured release and languages", async (context) => {
    const site = await fixture(context);
    const next = structuredClone(config);
    next.navbar.primary.href = "https://example.com/releases/v9.8.7/Dure.dmg";
    next.navigation.languages = [...next.navigation.languages].reverse();
    for (const locale of languages) site.responses.set(`/${locale}/install.md`, { body: install(next.navbar.primary.href) });
    site.responses.set("/llms-full.txt", { body: site.aggregate(install(next.navbar.primary.href), next.navigation.languages[0].language) });
    const healthy = await checkPublicDocsDownloads(next, site);
    expect(healthy.ok).toBe(true);
    const stalePath = `/${languages[1]}/install.md`;
    site.responses.set(stalePath, { body: install(next.navbar.primary.href) + install(expectedDownload) });
    const stale = await checkPublicDocsDownloads(next, site);
    expect(stale.checks.find((check) => check.url.endsWith(stalePath))).toMatchObject({ ok: false, downloads: [next.navbar.primary.href, expectedDownload] });
  });

  test("a current download elsewhere in the aggregate cannot hide a missing or duplicate installation section", async (context) => {
    const site = await fixture(context);
    for (const body of [
      `# Other\nSource: ${site.origin}/en/other\n\n${install()}`,
      site.aggregate() + "\n\n" + site.aggregate(),
      site.aggregate("Use the old releases page.") + `\n\n# Other\nSource: ${site.origin}/en/other\n\n${install()}`,
    ]) {
      site.responses.set("/llms-full.txt", { body });
      expect((await checkPublicDocsDownloads(config, site)).checks.at(-1).ok).toBe(false);
    }
  });

  test("reports HTTP failure, redirects and HTML responses without following or retrying them", async (context) => {
    const site = await fixture(context);
    const path = `/${languages[0]}/install.md`;
    for (const entry of [
      { status: 404 },
      { status: 503 },
      { status: 302, headers: { Location: "/login" } },
      { body: install(), headers: { "Content-Type": "text/html" } },
      { body: install(), headers: { "Content-Type": "Text/HTML; charset=utf-8" } },
      { body: install(), headers: { "Content-Type": "application/json" } },
    ]) {
      site.responses.set(path, entry);
      const result = await checkPublicDocsDownloads(config, site);
      expect(result.ok).toBe(false);
      expect(result.checks[0].error).toMatch(/HTTP|Expected Markdown/);
    }
    expect(site.requests).toHaveLength((languages.length + 1) * 6);
    expect(site.requests.some((request) => request.url === "/login")).toBe(false);
  });

  test("bounds the body read when an endpoint never finishes", async (context) => {
    const site = await fixture(context);
    site.responses.set("/llms-full.txt", { hang: true });
    const result = await checkPublicDocsDownloads(config, { origin: site.origin, timeoutMs: 250 });
    expect(result.checks.at(-1)).toMatchObject({ ok: false });
    expect(result.checks.at(-1).error).toMatch(/timed out|abort/i);
  });

  test("rejects incomplete configuration and cache-busting origins before network requests", async (context) => {
    const site = await fixture(context);
    const invalidConfigs = [
      {},
      { ...config, navbar: { primary: { href: "https://example.com/releases/latest" } } },
      { ...config, navbar: { primary: { href: "https://example.com/download/mac/" } } },
      { ...config, navbar: { primary: { href: "http://www.dureai.dev/download/mac/" } } },
      { ...config, navbar: { primary: { href: "https://www.dureai.dev/download/mac/?version=0.2.18" } } },
      { ...config, navbar: { primary: { href: "https://user:secret@www.dureai.dev/download/mac/" } } },
      { ...config, navigation: { languages: [] } },
      { ...config, navigation: { languages: [config.navigation.languages[0], config.navigation.languages[0]] } },
      { ...config, navigation: { languages: [{ language: "en", groups: [] }] } },
    ];
    for (const invalid of invalidConfigs) await expect(checkPublicDocsDownloads(invalid, site)).rejects.toThrow();
    for (const origin of [`${site.origin}/?cache-bust=1`, `${site.origin}/en`, `http://user:secret@127.0.0.1/`]) {
      await expect(checkPublicDocsDownloads(config, { origin })).rejects.toThrow(/origin/);
    }
    expect(site.requests).toEqual([]);
  });
});
