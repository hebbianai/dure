// Run with: node scripts/run-with-build-storage.mjs frontend -- node scripts/qa/file-presentation-browser.mjs
// Source CLI and MCP -> isolated HTTP transport -> real frontend dispatcher,
// presenter, window opener, presentation window root and file viewer. Tauri
// window/event IPC, native file reads and the native presented-media route are
// fixture boundaries: this runner stands in for the route with the same
// contract (one grant, byte ranges, 4 MiB per response, 404 once revoked), so
// it proves the frontend streams through it, not the Rust route or OS focus.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { handleMcpRequest } from "../../cli/lib/orchestration-mcp-server.mjs";
import { scriptTestEnvironment } from "../lib/script-test-environment.mjs";

const output = resolve("output/playwright/file-presentation", `run-${Date.now()}`);
await mkdir(output, { recursive: true });
const isolated = await realpath(await mkdtemp(join(tmpdir(), "dure-file-presentation-")));
// FILE_PRESENTATION_BROWSER=webkit runs WebKit, the macOS app's engine; =chrome uses an installed Chrome.
const browserChoice = process.env.FILE_PRESENTATION_BROWSER;
const engine = browserChoice === "webkit" ? webkit : chromium;
const launchOptions = browserChoice === "chrome" ? { channel: "chrome" } : { executablePath: engine.executablePath() };
process.env.HOME = join(isolated, "home");
process.env.DURE_HOME = join(isolated, "home", ".dure");
process.env.HMUX_DISCOVERY_ROOT = join(isolated, "hmux-discovery");
await mkdir(process.env.DURE_HOME, { recursive: true });
await mkdir(process.env.HMUX_DISCOVERY_ROOT, { recursive: true });

// A four-minute 720p screen recording, well past the old 25 MB inline cap.
// Its index (moov) is written last, as a plain recorder leaves it, so playback
// must range-read the end of the file before the first frame.
const RECORDING_SECONDS = 240;
const recordingPath = join(isolated, "long screen recording.mp4");
const encoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
  `testsrc2=duration=${RECORDING_SECONDS}:size=1280x720:rate=30`, "-c:v", "libx264", "-preset", "ultrafast",
  "-b:v", "2500k", "-pix_fmt", "yuv420p", recordingPath], { stdio: ["ignore", "ignore", "pipe"] });
assert.equal(encoded.status, 0, `ffmpeg could not encode the recording: ${encoded.stderr}`);
const recordingSize = (await stat(recordingPath)).size;
assert.ok(recordingSize > 40 * 1024 * 1024, `recording is larger than the old cap: ${recordingSize}`);
const pdfPath = join(isolated, "report.pdf");
await writeFile(pdfPath, "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj "
  + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const streamed = async (kind, mime, file) => ({ kind, mime, file, size: (await stat(file)).size });
const documents = {
  [join(isolated, "shot.png")]: { kind: "image", mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGMwTjuDFTFQTwIApPwsoW75XWsAAAAASUVORK5CYII=" },
  [recordingPath]: await streamed("video", "video/mp4", recordingPath),
  [pdfPath]: await streamed("pdf", "application/pdf", pdfPath),
  [join(isolated, "notes.md")]: { kind: "markdown", text: "# Release notes\n\nRendered **Markdown** in the presentation window.\n" },
};

// Stand-in for the native presented-media route: one grant, single byte
// ranges capped at 4 MiB per response, 404 for any other token.
const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
let grant;
const mediaRequests = [];
const mediaServer = createHttpServer(async (incoming, response) => {
  const token = decodeURIComponent(incoming.url.split("/").pop());
  const range = incoming.headers.range;
  if (!grant || token !== grant.token) {
    mediaRequests.push({ token, range, status: 404, bytes: 0 });
    response.writeHead(404, { "Cache-Control": "no-store" }).end();
    return;
  }
  const { size } = await stat(grant.file);
  const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
  let start = 0;
  let end = size - 1;
  if (match && match[1] === "" && match[2] !== "") start = Math.max(0, size - Number(match[2]));
  else if (match) { start = Number(match[1]); if (match[2] !== "") end = Math.min(Number(match[2]), size - 1); }
  if (match) end = Math.min(end, start + RANGE_CHUNK_BYTES - 1);
  const length = end - start + 1;
  const handle = await open(grant.file);
  const body = Buffer.alloc(length);
  await handle.read(body, 0, length, start);
  await handle.close();
  mediaRequests.push({ token, range, status: match ? 206 : 200, start, bytes: length });
  response.writeHead(match ? 206 : 200, { "Content-Type": grant.mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
    "Content-Length": length, ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
  response.end(incoming.method === "HEAD" ? undefined : body);
});
await new Promise((done) => mediaServer.listen(0, "127.0.0.1", done));
const mediaPort = mediaServer.address().port;
const fetchToken = async (token) => (await fetch(`http://127.0.0.1:${mediaPort}/dure-media/${token}`, { headers: { Range: "bytes=0-1" } })).status;
// A 3024x1964 Retina display whose menu bar takes the top 76 physical pixels.
const monitor = { name: "QA display", scaleFactor: 2, position: { x: 0, y: 0 }, size: { width: 3024, height: 1964 },
  workArea: { position: { x: 0, y: 76 }, size: { width: 3024, height: 1888 } } };

const server = await createServer({ root: process.cwd(), cacheDir: join(output, "node_modules/.vite"),
  optimizeDeps: { entries: ["scripts/qa/file-presentation.fixture.html"] },
  logLevel: "warn", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
const cliPath = resolve("cli/dure.mjs");
let browser;
let page;
let client;
const errors = [];
const requests = [];
const environment = scriptTestEnvironment({ HOME: process.env.HOME, DURE_HOME: process.env.DURE_HOME,
  HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT, HMUX_SESSION_ID: "qa-session", HMUX_WORKSPACE_ID: "qa-workspace" });
async function cli(path) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cliPath, "client", "pane", "open", "file", path, "--window", "--json"], {
      cwd: isolated, env: environment, stdio: ["ignore", "pipe", "pipe"],
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
const windowCalls = () => page.evaluate(() => window.__WINDOW_CALLS__.splice(0));
const viewerText = () => page.locator("main, #root").first().innerText();
try {
  await server.listen();
  browser = await engine.launch({ ...launchOptions, headless: true });
  page = await browser.newPage({ viewport: { width: 1361, height: 850 }, colorScheme: "dark" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.exposeFunction("__grantPresentedMedia", (file, mime) => {
    grant = { token: randomBytes(16).toString("hex"), file, mime };
    return grant.token;
  });
  await page.exposeFunction("__revokePresentedMedia", () => { grant = undefined; });
  await page.addInitScript(({ documents, monitor, mediaPort }) => {
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 1;
    window.__FILE_DOCUMENTS__ = documents;
    window.__FILE_READS__ = [];
    window.__WINDOW_CALLS__ = [];
    window.__OPEN_WINDOWS__ = ["main"];
    const deliver = (event, payload) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      convertFileSrc: (token, protocol) => `http://127.0.0.1:${mediaPort}/${protocol}/${encodeURIComponent(token)}`,
      transformCallback: (callback) => { const id = nextId++; callbacks.set(id, callback); return id; },
      unregisterCallback: (id) => callbacks.delete(id),
      invoke: async (command, args = {}) => {
        if (command === "plugin:event|listen") { const id = nextId++; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
        if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
        if (command === "plugin:event|emit" || command === "plugin:event|emit_to") { setTimeout(() => deliver(args.event, args.payload)); return null; }
        if (command === "webview_storage_options") return {};
        if (command === "plugin:window|current_monitor") return monitor;
        if (command === "plugin:window|get_all_windows") return [...window.__OPEN_WINDOWS__];
        if (command === "plugin:webview|create_webview_window") {
          window.__WINDOW_CALLS__.push({ command: "create", options: args.options });
          window.__OPEN_WINDOWS__.push(args.options.label);
          setTimeout(() => window.__FILE_PRESENTATION_FIXTURE__.mountWindow());
          return null;
        }
        if (["plugin:window|show", "plugin:window|unminimize", "plugin:window|set_focus"].includes(command)
          && args.label === "win-presentation") {
          window.__WINDOW_CALLS__.push({ command: command.slice("plugin:window|".length) });
          return null;
        }
        if (command === "find_file_candidates") return [];
        if (command === "read_file" || command === "read_presented_file") {
          window.__FILE_READS__.push({ command, path: args.path });
          const document = window.__FILE_DOCUMENTS__[args.path];
          const name = args.path.split("/").pop();
          if (command === "read_presented_file") {
            if (document?.file) {
              const stream = await window.__grantPresentedMedia(document.file, document.mime);
              return { name, path: args.path, kind: document.kind, mime: document.mime, content: "", size: document.size,
                truncated: false, stream };
            }
            await window.__revokePresentedMedia();
          }
          if (!document || document.file) throw new Error("No such file (fixture)");
          const content = document.text ?? document.base64;
          return { name, path: args.path, kind: document.kind, ...(document.mime ? { mime: document.mime } : {}),
            content, size: content.length, truncated: false };
        }
        if (command.startsWith("plugin:")) return null;
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  }, { documents, monitor, mediaPort });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/qa/file-presentation.fixture.html`);
  await page.waitForFunction(() => window.__FILE_PRESENTATION_FIXTURE__?.ready());
  client = createHttpServer(async (incoming, response) => {
    try {
      assert.equal(incoming.url, "/pane/open");
      assert.equal(incoming.headers.authorization, "Bearer fixture-only");
      let text = "";
      for await (const chunk of incoming) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      const receipt = await page.evaluate((params) => window.__FILE_PRESENTATION_FIXTURE__.present(params), body);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(receipt));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ ok: false, error: { message: String(error) } })); }
  });
  await new Promise((done) => client.listen(0, "127.0.0.1", done));
  await writeFile(join(process.env.DURE_HOME, "server.json"), JSON.stringify({ schemaVersion: 1, apiVersion: 1,
    port: client.address().port, token: "fixture-only", capabilities: ["file_pane.open_v1", "file_window.present_v1"] }));

  // First presentation creates one large, focused window over most of the display.
  const image = await cli("shot.png");
  assert.deepEqual(image.window, { label: "win-presentation", file: { source: "local", path: join(isolated, "shot.png") },
    reused: false, presenter: { agentId: "agent-qa", name: "QA reviewer" } });
  assert.deepEqual(requests[0], { tool: "file", path: join(isolated, "shot.png"), placement: "window", presenterSessionId: "qa-session" });
  const created = await windowCalls();
  assert.equal(created[0].command, "create");
  assert.deepEqual(
    (({ url, width, height, x, y, focus, minWidth, minHeight }) => ({ url, width, height, x, y, focus, minWidth, minHeight }))(created[0].options),
    { url: "index.html?panel=presentation", width: 1361, height: 850, x: 76, y: 85, focus: true, minWidth: 480, minHeight: 360 },
  );
  assert.deepEqual(created.slice(1).map(({ command }) => command), ["show", "unminimize", "set_focus"]);
  await page.getByText("Presented by QA reviewer", { exact: true }).waitFor();
  await page.getByText("shot.png", { exact: true }).waitFor();
  await page.locator('img[src^="data:image/png;base64,"]').waitFor();
  await page.screenshot({ path: join(output, "image.png") });

  // A second presentation replaces the file in the same window and raises it
  // again. The long recording streams by range instead of being read inline.
  const recording = await cli("long screen recording.mp4");
  assert.equal(recording.window.reused, true);
  assert.deepEqual((await windowCalls()).map(({ command }) => command), ["show", "unminimize", "set_focus"]);
  const video = page.locator("video");
  await video.waitFor();
  assert.equal(await video.getAttribute("controls"), "");
  const recordingToken = grant.token;
  assert.equal(await video.getAttribute("src"), `http://127.0.0.1:${mediaPort}/dure-media/${recordingToken}`);
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 1, undefined, { timeout: 30000 });
  await page.getByText(/^video · \d+\.\d MB$/).waitFor();
  assert.equal(await page.getByText("Larger than the 25 MB preview cap", { exact: false }).count(), 0);
  const played = await page.evaluate(async (seconds) => {
    const element = document.querySelector("video");
    const settle = (event) => new Promise((done) => element.addEventListener(event, done, { once: true }));
    const seeked = settle("seeked");
    element.currentTime = seconds - 10;
    await seeked;
    await element.play();
    await new Promise((done) => setTimeout(done, 1500));
    return { duration: element.duration, currentTime: element.currentTime, paused: element.paused };
  }, RECORDING_SECONDS);
  assert.ok(Math.abs(played.duration - RECORDING_SECONDS) < 1, `full duration: ${JSON.stringify(played)}`);
  assert.ok(played.currentTime > RECORDING_SECONDS - 10 && !played.paused, `plays near the end: ${JSON.stringify(played)}`);
  const recordingRequests = mediaRequests.filter(({ token }) => token === recordingToken);
  const servedBytes = recordingRequests.reduce((total, { bytes }) => total + bytes, 0);
  assert.ok(recordingRequests.length > 1 && recordingRequests.every(({ status, range }) => status === 206 && range),
    `ranged reads only: ${JSON.stringify(recordingRequests)}`);
  assert.ok(recordingRequests.some(({ start }) => start > 25 * 1024 * 1024), "reads past the old 25 MB cap");
  assert.ok(servedBytes < recordingSize / 2, `reads part of the file, not all of it: ${servedBytes} of ${recordingSize}`);
  const reads = await page.evaluate(() => window.__FILE_READS__.splice(0));
  assert.deepEqual(reads.filter(({ path }) => path === recordingPath), [{ command: "read_presented_file", path: recordingPath }]);
  await page.screenshot({ path: join(output, "video.png") });

  // The PDF replaces the recording; the recording's grant ends.
  const pdfReceipt = await cli("report.pdf");
  assert.equal(pdfReceipt.window.reused, true);
  const pdfToken = grant.token;
  assert.notEqual(pdfToken, recordingToken);
  await page.locator(`object[type="application/pdf"][data="http://127.0.0.1:${mediaPort}/dure-media/${pdfToken}"]`).waitFor();
  assert.equal(await fetchToken(recordingToken), 404, "the recording's token is revoked");
  await page.screenshot({ path: join(output, "pdf.png") });

  const markdown = await cli("notes.md");
  await page.getByRole("heading", { name: "Release notes", exact: true }).waitFor();
  assert.equal(grant, undefined, "an inline file ends the media grant");
  assert.equal(await fetchToken(pdfToken), 404, "the PDF's token is revoked");
  await page.screenshot({ path: join(output, "markdown.png") });
  // The agent revises the file and presents it again: the window shows the new version.
  await page.evaluate((path) => {
    window.__FILE_DOCUMENTS__[path].text = "# Revised release notes\n";
  }, join(isolated, "notes.md"));
  const repeated = await cli("notes.md");
  assert.equal(repeated.window.reused, true);
  await page.getByRole("heading", { name: "Revised release notes", exact: true }).waitFor();
  await windowCalls();

  // Closing the window and presenting again reopens it.
  await page.evaluate(() => {
    window.__OPEN_WINDOWS__ = window.__OPEN_WINDOWS__.filter((label) => label !== "win-presentation");
    window.__FILE_PRESENTATION_FIXTURE__.unmountWindow();
  });
  const mcp = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "app_file_present", arguments: { path: join(isolated, "shot.png") } } }, { ...environment });
  assert.equal(mcp.isError, false, JSON.stringify(mcp.structuredContent));
  assert.deepEqual(mcp.structuredContent.window, { label: "win-presentation", file: { source: "local", path: join(isolated, "shot.png") },
    reused: false, presenter: { agentId: "agent-qa", name: "QA reviewer" } });
  assert.deepEqual((await windowCalls()).map(({ command }) => command), ["create", "show", "unminimize", "set_focus"]);
  await page.locator('img[src^="data:image/png;base64,"]').waitFor();
  await page.getByText("Presented by QA reviewer", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "reopened.png") });
  assert.deepEqual(errors, []);
  await writeFile(join(output, "evidence.json"), JSON.stringify({
    source: `headless ${engine.name()} + source CLI and MCP + real frontend; fixture Tauri window/event IPC and file reads`,
    image, created, recording: { receipt: recording, size: recordingSize, played, servedBytes, requests: recordingRequests },
    pdfReceipt, markdown, repeated, mcp: mcp.structuredContent, requests, mediaRequests, errors,
    page: await viewerText(),
  }, null, 2));
  console.log(`PASS (${engine.name()}) presentation window: CLI and MCP presenter receipts, one large focused window, reuse, `
    + `PNG, a ${(recordingSize / 1024 / 1024).toFixed(1)} MB ${RECORDING_SECONDS}s recording streamed by range `
    + `(${(servedBytes / 1024 / 1024).toFixed(1)} MB read to play its last seconds), streamed PDF, `
    + `grant revocation, Markdown with reload on re-present, and reopen after close: ${output}`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") });
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), errors, requests, mediaRequests }, null, 2));
  console.error(`File presentation browser fixture failed: ${output}`, errors);
  throw error;
} finally {
  if (client) await new Promise((done) => client.close(done));
  await browser?.close();
  mediaServer.closeAllConnections();
  await new Promise((done) => mediaServer.close(done));
  await server.close();
  await rm(isolated, { recursive: true, force: true });
}
