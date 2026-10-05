// Headless browser evidence for the real menu/Store/Dockview. Uses the same
// isolated Vite fixture pattern as pane-toolbar-responsive-visual.mjs.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const output = resolve("output/playwright/space-pane-controls", `run-${Date.now()}`);
await mkdir(output, { recursive: true });
const isolated = await mkdtemp(join(tmpdir(), "dure-space-browser-"));
const originalBrowserPath = chromium.executablePath();
// No process/session mutations or native bridge. Still isolate filesystem roots.
process.env.HOME = join(isolated, "home");
process.env.DURE_HOME = join(isolated, "home", ".dure");
process.env.HMUX_DISCOVERY_ROOT = join(isolated, "hmux-discovery");
await mkdir(process.env.DURE_HOME, { recursive: true });
await mkdir(process.env.HMUX_DISCOVERY_ROOT, { recursive: true });
const server = await createServer({ root: process.cwd(), cacheDir: join(output, "cache"),
  optimizeDeps: { entries: ["scripts/qa/space-pane-controls.fixture.html"] },
  logLevel: "warn", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
let browser;
let page;
const errors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ executablePath: originalBrowserPath });
  page = await browser.newPage({ viewport: { width: 1360, height: 780 }, colorScheme: "dark" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/scripts/qa/space-pane-controls.fixture.html`);
  await page.getByRole("textbox", { name: "source-stay", exact: true }).waitFor();
  const state = () => page.evaluate(() => window.__SPACE_PANE_FIXTURE__.snapshot());
  const before = await state();
  const working = page.getByRole("textbox", { name: "source-stay", exact: true });
  await working.fill("Keep this draft and keyboard focus");
  await working.focus();
  const created = await page.evaluate(() => window.__SPACE_PANE_FIXTURE__.create(false));
  assert.equal(created.space.mounted, false);
  assert.equal((await state()).activeSpaceId, before.activeSpaceId);
  assert.equal(await working.evaluate((element) => element === document.activeElement), true);
  await page.screenshot({ path: join(output, "before.png") });
  await page.getByRole("button", { name: "Pane menu", exact: true }).click();
  const submenu = page.getByRole("menuitem", { name: "Move to Space", exact: true });
  await submenu.hover();
  await page.getByRole("menuitem", { name: "Review", exact: true }).waitFor();
  await page.screenshot({ path: join(output, "menu.png") });
  await page.getByRole("menuitem", { name: "Review", exact: true }).click();
  await page.waitForFunction(() => window.__SPACE_PANE_FIXTURE__.snapshot().panes.target.ids.includes("moving"));
  const moved = await state();
  assert.deepEqual(moved.panes.source.ids, ["source-stay"]);
  assert.deepEqual(moved.panes.target.ids.sort(), ["moving", "target-stay"]);
  assert.equal(moved.panes.source.active, "source-stay");
  assert.equal(moved.panes.target.active, "target-stay");
  assert.equal(moved.activeSpaceId, "source");
  assert.equal(await working.inputValue(), "Keep this draft and keyboard focus");
  const repeated = await page.evaluate(() => window.__SPACE_PANE_FIXTURE__.move("moving", "source", "target"));
  assert.equal(repeated.moved, false);
  await working.focus();
  await page.evaluate(() => window.__SPACE_PANE_FIXTURE__.move("moving", "target", "source"));
  assert.equal(await working.evaluate((element) => element === document.activeElement), true);
  const returned = await state();
  assert.deepEqual(returned.panes.source.ids.sort(), ["moving", "source-stay"]);
  await page.screenshot({ path: join(output, "after.png") });
  assert.deepEqual(errors, []);
  await writeFile(join(output, "evidence.json"), JSON.stringify({ input: "headless-chromium-pointer-menu", native: false, before, created, moved, repeated, returned, errors }, null, 2));
  console.log(`PASS Space creation, real menu move, repeated move, preserved draft/focus: ${output}`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") });
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), errors, html: await page?.content() }, null, 2));
  console.error(`Browser fixture failed: ${output}`, errors);
  throw error;
} finally {
  await browser?.close();
  await server.close();
  await rm(isolated, { recursive: true, force: true });
}
