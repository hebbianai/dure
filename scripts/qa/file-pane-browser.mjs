// Run with: node scripts/run-with-build-storage.mjs frontend -- node scripts/qa/file-pane-browser.mjs
// Source CLI -> isolated HTTP transport -> real frontend dispatcher/opener and
// renderers. Native file I/O and window routing are fixture boundaries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { scriptTestEnvironment } from "../lib/script-test-environment.mjs";

const output = resolve("output/playwright/file-pane", `run-${Date.now()}`);
await mkdir(output, { recursive: true });
const isolated = await realpath(await mkdtemp(join(tmpdir(), "dure-file-pane-")));
// FILE_PANE_BROWSER=webkit runs the same flow in WebKit, the engine of the macOS app's webview.
const engine = process.env.FILE_PANE_BROWSER === "webkit" ? webkit : chromium;
const executablePath = engine.executablePath();
process.env.HOME = join(isolated, "home");
process.env.DURE_HOME = join(isolated, "home", ".dure");
process.env.HMUX_DISCOVERY_ROOT = join(isolated, "hmux-discovery");
await mkdir(process.env.DURE_HOME, { recursive: true });
await mkdir(process.env.HMUX_DISCOVERY_ROOT, { recursive: true });
const server = await createServer({ root: process.cwd(), cacheDir: join(output, "node_modules/.vite"),
  optimizeDeps: { entries: ["scripts/qa/file-pane.fixture.html"] },
  logLevel: "warn", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
const cliPath = resolve("cli/dure.mjs");
const files = {
  [join(isolated, "report notes.md")]: "# Review report\n\nRendered **Markdown** from the GUI viewer.\n",
  // An agent-made report: a chart image beside it, in-page and web links, and scripts the preview must not run.
  [join(isolated, "page.html")]: '<!doctype html><html><head><title>Report</title></head><body><h1>Local HTML report</h1>'
    + '<img src="charts/a.png" alt="Chart" width="160" height="80"><p><a href="#details">Jump to details</a> · '
    + '<a href="details.html">Next page</a> · <a href="https://example.com/docs">Web docs</a></p>'
    + '<button onclick="parent.__FILE_SCRIPT_RAN__ = true">Inline handler</button>'
    + '<div style="height:2000px"></div><h2 id="details">Details</h2><script>parent.__FILE_SCRIPT_RAN__ = true;</script></body></html>',
  [join(isolated, "charts/a.png")]: { image: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGMwTjuDFTFQTwIApPwsoW75XWsAAAAASUVORK5CYII=" },
  [join(isolated, "design/mockups/review/Report/default.html")]: '<h1>Static HTML preview</h1><button onclick="parent.__FILE_SCRIPT_RAN__ = true">Sandboxed button</button><script>parent.__FILE_SCRIPT_RAN__ = true;</script>',
  // A page much taller than the pane: the preview must scroll to its end.
  [join(isolated, "design/mockups/review/Report/tall.html")]: '<!doctype html><html><head><title>tall</title></head><body><h1>Tall mockup top</h1><div style="width:640px;height:3000px;background:linear-gradient(#36c,#c63)"></div><h2>Tall mockup bottom</h2></body></html>',
};
let browser;
let page;
let client;
const errors = [];
const requests = [];
const popups = [];
async function cli(path) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cliPath, "client", "pane", "open", "file", path, "--space-id", "review", "--json"], {
      cwd: isolated, env: scriptTestEnvironment({ HOME: process.env.HOME, DURE_HOME: process.env.DURE_HOME, HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      try { assert.equal(code, 0, stderr); done(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}
try {
  await server.listen();
  browser = await engine.launch({ executablePath });
  page = await browser.newPage({ viewport: { width: 1440, height: 800 }, colorScheme: "dark" });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("popup", (popup) => popups.push(popup.url()));
  await page.addInitScript((documents) => {
    window.__FILE_READS__ = [];
    window.__FILE_SCRIPT_RAN__ = false;
    window.__FILE_DOCUMENTS__ = documents;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command.startsWith("plugin:event|")) return 1;
        if (command === "find_file_candidates") return [];
        if (command !== "read_file") throw new Error(`Unexpected native command: ${command}`);
        window.__FILE_READS__.push(args.path);
        const content = window.__FILE_DOCUMENTS__[args.path];
        if (content === undefined) throw new Error("No such file (fixture)");
        const name = args.path.split("/").pop();
        if (typeof content === "object") return { name, path: args.path, kind: "image", mime: "image/png", content: content.image, size: content.image.length, truncated: false };
        return { name, path: args.path, kind: args.path.endsWith(".md") ? "markdown" : "text", content, size: content.length, truncated: false };
      },
    };
  }, files);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/qa/file-pane.fixture.html`);
  await page.waitForFunction(() => window.__FILE_PANE_FIXTURE__?.ready());
  await page.screenshot({ path: join(output, "before.png") });
  client = createHttpServer(async (incoming, response) => {
    try {
      assert.equal(incoming.url, "/pane/open");
      assert.equal(incoming.headers.authorization, "Bearer fixture-only");
      let text = "";
      for await (const chunk of incoming) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      const receipt = await page.evaluate((params) => window.__FILE_PANE_FIXTURE__.open(params), body);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(receipt));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ ok: false, error: { message: String(error) } })); }
  });
  await new Promise((done) => client.listen(0, "127.0.0.1", done));
  await writeFile(join(process.env.DURE_HOME, "server.json"), JSON.stringify({ schemaVersion: 1, apiVersion: 1, port: client.address().port, token: "fixture-only", capabilities: ["file_pane.open_v1"] }));
  const markdown = await cli("report notes.md");
  await page.getByRole("heading", { name: "Review report", exact: true }).waitFor();
  await page.screenshot({ path: join(output, "markdown.png") });
  await page.getByRole("button", { name: "Edit source", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.fill("# Unsaved report draft");
  const repeated = await cli("report notes.md");
  assert.equal(repeated.pane.panelId, markdown.pane.panelId);
  assert.equal(repeated.pane.reused, true);
  assert.equal(await editor.innerText(), "# Unsaved report draft");
  const html = await cli("page.html");
  assert.equal(html.pane.component, "fileviewer");
  const htmlFrameElement = page.locator('iframe[title="page.html"]');
  const htmlFrame = page.frameLocator('iframe[title="page.html"]');
  await htmlFrame.getByRole("heading", { name: "Local HTML report" }).waitFor();
  assert.equal(await htmlFrameElement.getAttribute("sandbox"), "allow-same-origin");
  await page.getByText("Scripts don't run in this preview, so interactive parts may not work", { exact: true }).waitFor();
  const htmlView = () => page.evaluate(() => {
    const doc = document.querySelector('iframe[title="page.html"]').contentDocument;
    const image = doc.querySelector('img[alt="Chart"]');
    return { url: doc.URL, heading: doc.querySelector("h1")?.textContent, scrollTop: doc.scrollingElement.scrollTop,
      image: { complete: image.complete, width: image.naturalWidth, inline: image.src.startsWith("data:image/png;base64,") } };
  });
  await page.waitForFunction(() => {
    const image = document.querySelector('iframe[title="page.html"]')?.contentDocument?.querySelector('img[alt="Chart"]');
    return Boolean(image?.complete && image.naturalWidth > 0);
  }, undefined, { timeout: 5000 });
  const htmlLoaded = await htmlView();
  assert.deepEqual(htmlLoaded.image, { complete: true, width: 8, inline: true });
  await htmlFrame.getByRole("button", { name: "Inline handler" }).click();
  assert.equal(await page.evaluate(() => window.__FILE_SCRIPT_RAN__), false);
  await page.screenshot({ path: join(output, "html-preview.png") });
  // Links work without scripts in the frame: a fragment scrolls the page, and
  // any other link is refused by the sandbox instead of loading into the pane.
  await htmlFrame.getByRole("link", { name: "Jump to details" }).click();
  await page.waitForFunction(() => document.querySelector('iframe[title="page.html"]').contentDocument.scrollingElement.scrollTop > 1000, undefined, { timeout: 5000 });
  const htmlAfterFragment = await htmlView();
  assert.equal(htmlAfterFragment.url, "about:srcdoc#details");
  assert.equal(await htmlFrame.getByRole("link", { name: "Web docs" }).getAttribute("title"), "https://example.com/docs");
  await page.evaluate(() => { document.querySelector('iframe[title="page.html"]').contentDocument.documentElement.dataset.qaSameDocument = "1"; });
  await htmlFrame.getByRole("link", { name: "Next page" }).click({ force: true });
  await htmlFrame.getByRole("link", { name: "Web docs" }).click({ force: true });
  await page.waitForTimeout(500);
  const htmlAfterLinks = await htmlView();
  assert.equal(htmlAfterLinks.url, htmlAfterFragment.url, "links never navigate the preview frame");
  assert.equal(htmlAfterLinks.heading, "Local HTML report");
  assert.equal(await page.evaluate(() => document.querySelector('iframe[title="page.html"]').contentDocument.documentElement.dataset.qaSameDocument), "1");
  assert.deepEqual(popups, []);
  assert.equal(await page.evaluate(() => window.__FILE_SCRIPT_RAN__), false);
  // An agent revises the page and opens it again: the pane without unsaved
  // edits shows the new file instead of the copy it read first.
  const pagePath = join(isolated, "page.html");
  await page.evaluate((path) => {
    window.__FILE_DOCUMENTS__[path] = window.__FILE_DOCUMENTS__[path].replace("Local HTML report", "Revised HTML report");
  }, pagePath);
  const htmlReopened = await cli("page.html");
  assert.equal(htmlReopened.pane.panelId, html.pane.panelId);
  assert.equal(htmlReopened.pane.reused, true);
  await htmlFrame.getByRole("heading", { name: "Revised HTML report" }).waitFor();
  const htmlPane = page.locator(".dv-groupview").filter({ has: htmlFrameElement });
  await htmlPane.getByRole("button", { name: "Edit source", exact: true }).click();
  await page.locator(".cm-content").filter({ hasText: "Revised HTML report" }).waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  await page.screenshot({ path: join(output, "html-source.png") });
  const mockup = await cli("design/mockups/review/Report/default.html");
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "Static HTML preview" }).waitFor();
  assert.equal(mockup.pane.component, "mockup");
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-same-origin");
  await frame.getByRole("button", { name: "Sandboxed button" }).click();
  assert.equal(await page.evaluate(() => window.__FILE_SCRIPT_RAN__), false);
  await page.screenshot({ path: join(output, "html-sandbox.png") });
  const tall = await cli("design/mockups/review/Report/tall.html");
  assert.equal(tall.pane.component, "mockup");
  const tallFrameElement = page.locator('iframe[title="Report · tall"]');
  const tallFrame = await (await tallFrameElement.elementHandle()).contentFrame();
  await tallFrame.getByRole("heading", { name: "Tall mockup top" }).waitFor();
  const tallScroll = () => tallFrame.evaluate(() => {
    const root = document.scrollingElement;
    return { top: root.scrollTop, height: root.scrollHeight, view: root.clientHeight };
  });
  const tallBefore = await tallScroll();
  assert.ok(tallBefore.height > tallBefore.view * 2, `tall mockup overflows the pane: ${JSON.stringify(tallBefore)}`);
  await tallFrameElement.hover();
  await page.mouse.wheel(0, 5000);
  await page.waitForFunction(() => {
    const frame = document.querySelector('iframe[title="Report · tall"]');
    const root = frame?.contentDocument?.scrollingElement;
    return Boolean(root && root.scrollTop + root.clientHeight >= root.scrollHeight - 1);
  }, undefined, { timeout: 5000 });
  const tallScrolled = await tallScroll();
  await page.screenshot({ path: join(output, "mockup-scrolled.png") });
  // Zoom like browser zoom: the toolbar steps it, the preview document scales
  // and scrolls further, element picking still lands, and a rebuilt document
  // (theme toggle) keeps the zoom.
  const tallPane = page.locator('[data-pane-surface="own"]').filter({ has: page.locator('iframe[title="Report · tall"]') });
  await tallPane.getByRole("button", { name: "Zoom in", exact: true }).click();
  await tallPane.getByRole("button", { name: "Zoom in", exact: true }).click();
  await tallPane.getByRole("button", { name: "156%", exact: true }).waitFor();
  const tallZoomed = await tallFrame.evaluate(() => {
    document.scrollingElement.scrollTop = 0;
    return { zoom: document.documentElement.style.zoom, height: document.scrollingElement.scrollHeight };
  });
  assert.equal(tallZoomed.zoom, "1.5625");
  assert.ok(tallZoomed.height > tallBefore.height * 1.5, `zoomed mockup grows: ${JSON.stringify(tallZoomed)}`);
  await page.screenshot({ path: join(output, "mockup-zoomed.png") });
  await tallPane.getByRole("button", { name: "Pick an element and ask an agent to change it", exact: true }).click();
  const frameBox = await tallFrameElement.boundingBox();
  const headingBox = await tallFrame.evaluate(() => {
    const rect = document.querySelector("h1").getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.click(frameBox.x + 24, frameBox.y + headingBox.y + headingBox.height - 4);
  await tallPane.getByText(/^html(\.dark)? > body > h1 — "Tall mockup top"$/).waitFor();
  await tallPane.getByRole("button", { name: "Cancel", exact: true }).click();
  await tallFrame.evaluate(() => { document.documentElement.dataset.qaPreviousBuild = "1"; });
  await tallPane.getByRole("button", { name: /^Preview in (light|dark) theme$/ }).click();
  await page.waitForFunction(() => {
    const root = document.querySelector('iframe[title="Report · tall"]')?.contentDocument?.documentElement;
    return Boolean(root && !root.dataset.qaPreviousBuild && root.querySelector("h1") && root.style.zoom === "1.5625");
  }, undefined, { timeout: 5000 });
  await tallPane.getByRole("button", { name: "156%", exact: true }).click();
  await page.waitForFunction(() => {
    const root = document.querySelector('iframe[title="Report · tall"]')?.contentDocument?.documentElement;
    return root?.style.zoom === "";
  }, undefined, { timeout: 5000 });
  await tallPane.getByRole("button", { name: "100%", exact: true }).waitFor();
  const missing = await cli("missing.md");
  assert.equal(missing.pane.mounted, true);
  await page.getByText("Error: No such file (fixture)", { exact: true }).waitFor();
  const snapshot = await page.evaluate(() => window.__FILE_PANE_FIXTURE__.snapshot());
  assert.equal(snapshot.panes.length, 5);
  assert.deepEqual(errors, []);
  await writeFile(join(output, "evidence.json"), JSON.stringify({ source: `headless ${engine.name()} + source CLI + real frontend, fixture native I/O and window routing`, markdown, repeated, html, htmlLoaded, htmlAfterFragment, htmlAfterLinks, popups, htmlReopened, mockup, tall, tallBefore, tallScrolled, tallZoomed, missing, snapshot, requests, errors }, null, 2));
  console.log(`PASS (${engine.name()}) local file CLI, Markdown, preserved draft, HTML preview with images, in-place links, blocked scripts and reload on reopen, HTML source, static sandbox, tall mockup scroll and zoom, and read error: ${output}`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") });
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), errors, requests, reads: await page?.evaluate(() => window.__FILE_READS__) }, null, 2));
  console.error(`File pane browser fixture failed: ${output}`, errors);
  throw error;
} finally {
  if (client) await new Promise((done) => client.close(done));
  await browser?.close();
  await server.close();
  await rm(isolated, { recursive: true, force: true });
}
