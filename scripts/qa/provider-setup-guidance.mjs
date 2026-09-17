#!/usr/bin/env node

// Bounded browser interaction proof. The existing fixtures supply all backend
// data; the actual dialog, form, disclosure and copy handler run unchanged.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(repo, "output/playwright/provider-setup-guidance");
await mkdir(output, { recursive: true });
const runRoot = await mkdtemp(resolve(output, "run-"));
const server = await createServer({
  root: repo, configFile: resolve(repo, "vite.config.ts"), logLevel: "warn",
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});
let browser;
const startedAt = Date.now();
const report = { kind: "dure.provider-setup-guidance.browser-fixture/v1", runRoot, passed: false };
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(await readFile(resolve(repo, "scripts/qa/tauri-mock.js"), "utf8"));
  const url = `http://127.0.0.1:${address.port}/provider-setup-guidance.html`;
  const html = await server.transformIndexHtml(url, '<html><body><div id="root"></div><script type="module" src="/scripts/qa/fixtures/provider-setup-guidance.tsx"></script></body></html>');
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: html }));
  // Fixture pages must not make an external request, including installer downloads.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/, (route) => route.abort());
  await page.goto(url);
  await page.waitForFunction(() => window.__DURE_PROVIDER_GUIDE__);
  const { labels, command } = await page.evaluate(() => window.__DURE_PROVIDER_GUIDE__);
  const submit = page.getByRole("button", { name: labels.submit, exact: true });
  const retry = page.getByRole("button", { name: labels.retry, exact: true });
  const guide = page.locator("summary").filter({ hasText: labels.guide });
  await submit.click();
  await page.getByText(labels.failure, { exact: false }).waitFor({ state: "visible", timeout: 5000 });
  report.failureObserved = true;
  await guide.waitFor({ state: "visible", timeout: 5000 });
  await guide.click();
  const copy = page.getByRole("button", { name: labels.copy, exact: true });
  await copy.waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: labels.provider, exact: true }).selectOption("codex");
  await copy.click();
  await page.waitForFunction(() => window.__DURE_PROVIDER_GUIDE__.receipt.copied.length === 1);
  await guide.focus();
  await page.keyboard.press("Enter");
  assert.equal(await copy.isVisible(), false);
  await page.keyboard.press("Space");
  assert.equal(await copy.isVisible(), true);
  await page.screenshot({ path: resolve(runRoot, "guide.png") });
  await retry.click();
  await page.waitForFunction(() => window.__DURE_PROVIDER_GUIDE__.receipt.applies.length === 2);
  await guide.waitFor({ state: "visible" });
  const receipt = await page.evaluate(() => window.__DURE_PROVIDER_GUIDE__.receipt);
  assert.equal(receipt.closed, 0);
  assert.deepEqual(receipt.copied, [command]);
  assert.equal(receipt.previews.length, 2);
  assert.deepEqual(receipt.previews[1], receipt.previews[0]);
  assert.deepEqual(receipt.applies[1], receipt.applies[0]);
  assert.equal(receipt.previews[1].providerId, "claude");
  assert.equal(await page.getByRole("combobox", { name: labels.provider, exact: true }).inputValue(), "codex");
  await page.evaluate(() => { window.__DURE_PROVIDER_GUIDE__.receipt.reasonCode = "provider_executable_lookup_failed"; });
  await retry.click();
  await page.waitForFunction(() => window.__DURE_PROVIDER_GUIDE__.receipt.applies.length === 3);
  await guide.waitFor({ state: "detached" });
  const commands = await page.evaluate(() => window.__DURE_PROVIDER_GUIDE__.receipt.commands);
  assert.equal(commands.some((command) => /^(hmux_|run_shell|provider_preflight)/.test(command)), false);
  assert.deepEqual(errors, []);
  Object.assign(report, { passed: true, copiedCommand: command, sameRequest: receipt.applies[0], checks: ["disclosure", "copy", "keyboard", "retained-form", "same-run-retry", "unknown-is-not-missing", "no-native-launch"] });
} catch (error) {
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  report.durationMs = Date.now() - startedAt;
  await writeFile(resolve(runRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
