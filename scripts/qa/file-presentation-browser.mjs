// Run with: node scripts/run-with-build-storage.mjs frontend -- node scripts/qa/file-presentation-browser.mjs
// Source CLI and MCP -> isolated HTTP transport -> real frontend dispatcher,
// presenter, window opener, presentation window root and file viewer. Tauri
// window/event IPC and native file reads are fixture boundaries: this proves
// the wiring and rendering, not native window focus.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

function encodeVideo(name, codec) {
  const path = join(isolated, name);
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "testsrc=duration=3:size=320x240:rate=15", ...codec, path], { stdio: ["ignore", "ignore", "pipe"] });
  assert.equal(result.status, 0, `ffmpeg could not encode ${name}: ${result.stderr}`);
  return path;
}
const webmPath = encodeVideo("screen recording.webm", ["-c:v", "libvpx-vp9", "-b:v", "200k"]);
const mp4Path = encodeVideo("demo.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj "
  + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
const media = (kind, mime, base64) => ({ kind, mime, base64 });
const documents = {
  [join(isolated, "shot.png")]: media("image", "image/png", "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGMwTjuDFTFQTwIApPwsoW75XWsAAAAASUVORK5CYII="),
  [webmPath]: media("video", "video/webm", (await readFile(webmPath)).toString("base64")),
  [mp4Path]: media("video", "video/mp4", (await readFile(mp4Path)).toString("base64")),
  [join(isolated, "report.pdf")]: media("pdf", "application/pdf", Buffer.from(pdf).toString("base64")),
  [join(isolated, "notes.md")]: { kind: "markdown", text: "# Release notes\n\nRendered **Markdown** in the presentation window.\n" },
};
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
  await page.addInitScript(({ documents, monitor }) => {
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 1;
    window.__FILE_DOCUMENTS__ = documents;
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
        if (command === "read_file") {
          const document = window.__FILE_DOCUMENTS__[args.path];
          if (!document) throw new Error("No such file (fixture)");
          const name = args.path.split("/").pop();
          const content = document.text ?? document.base64;
          return { name, path: args.path, kind: document.kind, ...(document.mime ? { mime: document.mime } : {}),
            content, size: content.length, truncated: false };
        }
        if (command.startsWith("plugin:")) return null;
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  }, { documents, monitor });
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

  // A second presentation replaces the file in the same window and raises it again.
  const recording = await cli("screen recording.webm");
  assert.equal(recording.window.reused, true);
  assert.deepEqual((await windowCalls()).map(({ command }) => command), ["show", "unminimize", "set_focus"]);
  const video = page.locator("video");
  await video.waitFor();
  assert.equal(await video.getAttribute("controls"), "");
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 1, undefined, { timeout: 10000 });
  const played = await page.evaluate(async () => {
    const element = document.querySelector("video");
    await element.play();
    await new Promise((done) => setTimeout(done, 800));
    return { duration: element.duration, currentTime: element.currentTime, paused: element.paused };
  });
  assert.ok(played.duration > 2 && played.currentTime > 0 && !played.paused, `video plays: ${JSON.stringify(played)}`);
  await page.screenshot({ path: join(output, "video.png") });

  const mp4 = await cli("demo.mp4");
  assert.equal(mp4.window.reused, true);
  await page.locator('video[controls][src^="data:video/mp4;base64,"]').waitFor();
  const pdfReceipt = await cli("report.pdf");
  assert.equal(pdfReceipt.window.reused, true);
  await page.locator('object[type="application/pdf"][data^="data:application/pdf;base64,"]').waitFor();
  await page.screenshot({ path: join(output, "pdf.png") });

  const markdown = await cli("notes.md");
  await page.getByRole("heading", { name: "Release notes", exact: true }).waitFor();
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
    image, created, recording, played, mp4, pdfReceipt, markdown, repeated, mcp: mcp.structuredContent, requests, errors,
    page: await viewerText(),
  }, null, 2));
  console.log(`PASS (${engine.name()}) presentation window: CLI and MCP presenter receipts, one large focused window, reuse, `
    + `PNG, playing WebM, MP4 and PDF elements, Markdown with reload on re-present, and reopen after close: ${output}`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") });
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), errors, requests }, null, 2));
  console.error(`File presentation browser fixture failed: ${output}`, errors);
  throw error;
} finally {
  if (client) await new Promise((done) => client.close(done));
  await browser?.close();
  await server.close();
  await rm(isolated, { recursive: true, force: true });
}
