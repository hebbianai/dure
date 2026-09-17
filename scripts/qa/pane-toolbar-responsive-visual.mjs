#!/usr/bin/env node

// Runtime-free visual probe for the real AgentPanel secondary toolbar. It
// resizes a Dockview group instead of the app window, so the measured width is
// the pane width the user controls and the daily-driver app is never touched.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import {
  assertPaneToolbarSnapshot,
  assertChatComposerSnapshot,
  PANE_TOOLBAR_WIDTHS,
} from "./pane-toolbar-responsive-contract.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "../..");
const allowedOutputRoot = resolve(
  repoRoot,
  "output/playwright/pane-toolbar-responsive",
);
const runId = `run-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}-${process.pid}`;
const outputRoot = resolve(
  process.env.PANE_TOOLBAR_VISUAL_OUT ?? resolve(allowedOutputRoot, runId),
);
const outputRelative = relative(allowedOutputRoot, outputRoot);

if (
  outputRoot === allowedOutputRoot ||
  outputRelative === "" ||
  outputRelative.startsWith("..") ||
  isAbsolute(outputRelative)
) {
  throw new Error(
    "PANE_TOOLBAR_VISUAL_OUT must name a run directory below output/playwright/pane-toolbar-responsive",
  );
}

await mkdir(outputRoot, { recursive: true });

const server = await createServer({
  root: repoRoot,
  cacheDir: resolve(outputRoot, "node_modules/.vite"),
  configFile: resolve(repoRoot, "vite.config.ts"),
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});
let browser;

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("isolated Vite server did not expose a TCP port");
  }

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(String(error.stack ?? error.message).slice(0, 2_000));
  });

  await page.goto(
    `http://127.0.0.1:${address.port}/scripts/qa/pane-toolbar-responsive.fixture.html`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => window.__PANE_TOOLBAR_FIXTURE__?.dock);
  const pane = page.locator(".dv-groupview").filter({ has: page.locator("[data-toolbar-fixture-pane]") });
  await pane.locator("[data-agent-panel-toolbar]").waitFor();

  const snapshots = {};
  const screenshots = {};
  for (const paneWidth of PANE_TOOLBAR_WIDTHS) {
    await page.evaluate((width) => {
      const panel = window.__PANE_TOOLBAR_FIXTURE__.dock.getPanel("toolbar");
      panel.group.api.setSize({ width, height: panel.group.api.height });
    }, paneWidth);
    await page.waitForFunction((width) => {
      const group = document.querySelector("[data-toolbar-fixture-pane]").closest(".dv-groupview");
      return Math.abs(group.getBoundingClientRect().width - width) <= 1;
    }, paneWidth);

    const snapshot = await pane.evaluate((group, requestedWidth) => {
      const elementRect = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          visible:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0 &&
            rect.width > 0 &&
            rect.height > 0,
        };
      };
      const toolbar = group.querySelector("[data-agent-panel-toolbar]");
      const credential = toolbar?.querySelector("[data-credential-state]");
      const diff = toolbar?.querySelector('[data-agent-pane-status="diff"]');
      const branch = toolbar?.querySelector('[data-agent-pane-status="branch"]');
      if (!toolbar || !credential || !diff || !branch) {
        throw new Error("responsive toolbar fixture is incomplete");
      }
      const summary = (action) => ({
        ...elementRect(action),
        text: action.textContent,
      });
      const selectors = ["Model", "Reasoning effort", "View"].map((name) => {
        const trigger = toolbar.querySelector(`[role="combobox"][aria-label="${name}"]`);
        if (!trigger) throw new Error(`missing ${name} selector`);
        const rect = elementRect(trigger);
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { ...rect, name, operable: !trigger.disabled && trigger.contains(hit) };
      });
      return {
        paneWidth: requestedWidth,
        paneRect: elementRect(group),
        toolbar: {
          rect: elementRect(toolbar),
          clientWidth: toolbar.clientWidth,
          scrollWidth: toolbar.scrollWidth,
        },
        credential: elementRect(credential),
        selectors,
        diff: summary(diff),
        branch: summary(branch),
      };
    }, paneWidth);
    snapshots[paneWidth] = snapshot;
    await writeFile(resolve(outputRoot, `${paneWidth}px.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    const screenshotFile = resolve(outputRoot, `${paneWidth}px.png`);
    await pane.screenshot({ path: screenshotFile, animations: "disabled" });
    screenshots[paneWidth] = {
      file: relative(repoRoot, screenshotFile),
      sha256: await sha256(screenshotFile),
    };
    assertPaneToolbarSnapshot(snapshot);

    // Geometry alone cannot catch tooltip/menu focus conflicts on reopening.
    for (const name of ["Model", "Reasoning effort", "View"]) {
      const trigger = pane.getByRole("combobox", { name, exact: true });
      for (let open = 0; open < 2; open += 1) {
        await trigger.click();
        await page.getByRole("listbox").waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("listbox").waitFor({ state: "detached" });
        await page.waitForFunction((element) => document.activeElement === element,
          await trigger.elementHandle(), { timeout: 2_000 });
      }
    }
  }

  const model = pane.getByRole("combobox", { name: "Model", exact: true });
  await model.click();
  await page.getByRole("option", { name: "GPT-5.6 Luna", exact: true }).click();
  await page.waitForFunction(() => window.__PANE_TOOLBAR_FIXTURE__.selections === 1);
  await pane.getByRole("combobox", { name: "View", exact: true }).click();
  await page.getByRole("option", { name: "Chat", exact: true }).click();
  await page.waitForFunction(() => window.__PANE_TOOLBAR_FIXTURE__.switches === 1);
  const form = page.getByRole("combobox", { name: "Tab order", exact: true });
  await form.click();
  await page.getByRole("option", { name: "Name", exact: true }).click();
  assert.equal(await form.textContent(), "Name");

  const chat = page.locator("[data-chat-fixture-pane]");
  await chat.getByRole("textbox").fill("Toolbar layout probe");
  const chatSnapshots = {};
  for (const width of PANE_TOOLBAR_WIDTHS) {
    await page.evaluate((width) => {
      const panel = window.__PANE_TOOLBAR_FIXTURE__.dock.getPanel("chat");
      panel.group.api.setSize({ width, height: panel.group.api.height });
    }, width);
    await page.waitForFunction((width) =>
      Math.abs(document.querySelector("[data-chat-fixture-pane]").getBoundingClientRect().width - width) <= 1, width);
    const snapshot = await chat.locator("form").evaluate((form) => {
      const rect = (element) => ({ ...element.getBoundingClientRect().toJSON(), visible: element.getBoundingClientRect().width > 0 });
      const actions = ["Model", "Reasoning effort", "Permissions", "Send"].map((name) => {
        const button = form.querySelector(`button[aria-label="${name}"], button[title="${name}"]`);
        if (!button) throw new Error(`missing chat ${name}`);
        const bounds = rect(button);
        return { ...bounds, name, operable: !button.disabled && button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)) };
      });
      return { rect: rect(form), clientWidth: form.clientWidth, scrollWidth: form.scrollWidth, actions };
    });
    chatSnapshots[width] = snapshot;
    await writeFile(resolve(outputRoot, `chat-${width}px.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    await chat.locator("form").screenshot({ path: resolve(outputRoot, `chat-${width}px.png`), animations: "disabled" });
    assertChatComposerSnapshot(snapshot);
    for (const name of ["Model", "Reasoning effort", "Permissions"]) {
      const trigger = chat.getByRole("combobox", { name, exact: true });
      await trigger.click();
      await page.getByRole("listbox").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("listbox").waitFor({ state: "detached" });
      await page.waitForFunction((element) => document.activeElement === element,
        await trigger.elementHandle(), { timeout: 2_000 });
    }
  }

  assert.deepEqual(pageErrors, [], "fixture emitted uncaught page errors");
  const report = {
    schemaVersion: 1,
    fixture: "pane-toolbar-responsive",
    appUrl: `http://127.0.0.1:${address.port}`,
    widths: PANE_TOOLBAR_WIDTHS,
    snapshots,
    chatSnapshots,
    screenshots,
    pageErrors,
  };
  const reportFile = resolve(outputRoot, "report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      output: relative(repoRoot, outputRoot),
      report: relative(repoRoot, reportFile),
      screenshots,
    })}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
