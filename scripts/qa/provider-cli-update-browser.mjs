// Production update feedback, synthetic diagnostics; no native commands or sessions.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const output = resolve("output/playwright/provider-cli-update", `run-${Date.now()}`);
await mkdir(output, { recursive: true });
const isolated = await mkdtemp(join(tmpdir(), "dure-update-browser-"));
const executablePath = chromium.executablePath();
process.env.HOME = join(isolated, "home");
process.env.DURE_HOME = join(isolated, "home", ".dure");
process.env.HMUX_DISCOVERY_ROOT = join(isolated, "hmux-discovery");
await mkdir(process.env.DURE_HOME, { recursive: true });
await mkdir(process.env.HMUX_DISCOVERY_ROOT, { recursive: true });
const server = await createServer({ root: process.cwd(), cacheDir: join(output, "cache"),
  optimizeDeps: { entries: ["scripts/qa/provider-cli-update.fixture.html"] },
  logLevel: "warn", server: { host: "127.0.0.1", port: 0, hmr: false } });
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 980, height: 700 }, colorScheme: "dark" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/qa/provider-cli-update.fixture.html`);
  await page.getByText("CLI updated to 0.160.0.", { exact: false }).waitFor();
  const failure = page.getByRole("region", { name: "Failed update" });
  assert.equal(await failure.locator("pre").isVisible(), false);
  await page.screenshot({ path: join(output, "collapsed.png") });
  await failure.locator("summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await failure.locator("pre").isVisible(), true);
  assert.match(await failure.locator("pre").textContent(), /outdated\.\nUpdate/);
  await page.screenshot({ path: join(output, "expanded.png") });
  await page.setViewportSize({ width: 390, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: join(output, "narrow.png") });
  assert.deepEqual(errors, []);
  await writeFile(join(output, "evidence.json"), JSON.stringify({ native: false, input: "headless Chromium keyboard", diagnostics: "synthetic", keyboardDetails: true, narrowOverflow: false, errors }, null, 2));
  console.log(`PASS update guidance, warning, keyboard details, narrow layout: ${output}`);
} finally {
  await browser?.close();
  await server.close();
  await rm(isolated, { recursive: true, force: true });
}
