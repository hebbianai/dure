// Production schedule form in a headless browser; no native IPC or app state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const output = resolve("output/playwright/schedule-workspace");
await mkdir(output, { recursive: true });
await writeFile(join(output, "AutomationFlow.before.tsx"), execFileSync("git", ["show", "HEAD:src/components/automations/AutomationFlow.tsx"]));
const isolated = await mkdtemp(join(tmpdir(), "dure-schedule-browser-"));
const executablePath = chromium.executablePath();
process.env.HOME = join(isolated, "home");
process.env.DURE_HOME = join(isolated, "dure");
process.env.HMUX_DISCOVERY_ROOT = join(isolated, "discovery");
await Promise.all([process.env.HOME, process.env.DURE_HOME, process.env.HMUX_DISCOVERY_ROOT].map((path) => mkdir(path, { recursive: true })));
const server = await createServer({ root: process.cwd(), cacheDir: join(output, "cache"), optimizeDeps: { entries: ["scripts/qa/schedule-workspace.fixture.html"] }, logLevel: "warn", server: { host: "127.0.0.1", port: 0, hmr: false } });
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: "dark" });
  page.on("pageerror", (error) => errors.push(String(error)));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/qa/schedule-workspace.fixture.html`;
  await page.goto(`${url}?before`);
  await page.getByText("Each run uses a separate Git worktree.", { exact: false }).waitFor();
  await page.screenshot({ path: join(output, "before.png") });
  await page.goto(url);
  const workspace = page.getByRole("combobox", { name: "Workspace", exact: true });
  await workspace.waitFor();
  await workspace.click();
  await page.getByRole("option", { name: "Project folder (no worktree)", exact: true }).click();
  assert.equal(await page.getByLabel("Saved workspace policy").textContent(), "project_root");
  await page.getByText("Runs share the registered project folder.", { exact: false }).waitFor();
  await page.screenshot({ path: join(output, "project-root.png") });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await workspace.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "narrow.png") });
  await workspace.click();
  await page.getByRole("option", { name: "Isolated Git worktree (default)", exact: true }).click();
  assert.equal(await page.getByLabel("Saved workspace policy").textContent(), "dedicated");
  assert.deepEqual(errors, []);
  await writeFile(join(output, "evidence.json"), JSON.stringify({ native: false, backend: "none", browser: "headless Chromium", policies: ["dedicated", "project_root", "dedicated"], narrowOverflow: false, errors }, null, 2));
  console.log(`PASS schedule workspace policy interaction, before/after screenshots, narrow layout: ${output}`);
} finally {
  await browser?.close();
  await server.close();
  await rm(isolated, { recursive: true, force: true });
}
