#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startBrowserViewerChannel } from "./lib/browser-viewer-channel.mjs";

const [fixture, engine, chromium, mode, ...extra] = process.argv.slice(2);
const osIme = mode === "--os-ime";
const interaction = mode === "--interaction";
if (!fixture || !engine || !chromium || (mode && !osIme && !interaction) || extra.length || process.platform !== "darwin") {
  throw new Error("usage: browser-panel-smoke.mjs <compiled-browser_cli-test> <agent-browser> <chromium-executable> [--os-ime|--interaction]");
}
if (osIme && process.env.HEBBIAN_QA_ALLOW_FOCUS_STEAL !== "1") {
  throw new Error("OS IME QA requires an explicit foreground maintenance window");
}
const channel = await startBrowserViewerChannel();
try {
  const runner = osIme ? "hmux-exclusive-focus-runner.sh" : "tauri-app-runner.sh";
  const child = spawn("node", ["scripts/run-with-build-storage.mjs", "qa", "--", "sh", `scripts/qa/lib/${runner}`], {
    stdio: "inherit",
    env: {
      ...process.env,
      DURE_BROWSER_PANEL_FIXTURE: resolve(fixture),
      DURE_BROWSER_TEST_BINARY: resolve(engine),
      DURE_BROWSER_TEST_CHROMIUM: resolve(chromium),
      DURE_QA_CLIENT: resolve("scripts/qa/browser-panel-client.mjs"),
      DURE_QA_NAME: "native Pro Browser panel",
      DURE_QA_ARTIFACT_NAME: "browser-panel",
      DURE_QA_LAYER: osIme ? "exclusive_focus_browser_ime" : "background",
      DURE_BROWSER_PANEL_OS_IME: osIme ? "1" : "0",
      DURE_BROWSER_PANEL_INTERACTION: interaction ? "1" : "0",
      VITE_DURE_BROWSER_QA_OS_IME: osIme ? "1" : "0",
      ...(osIme ? { HEBBIAN_QA_REQUIRE_EXECUTION: "1", DURE_QA_REQUIRE_EXECUTION: "1" } : {}),
      DURE_QA_UNIQUE_APP_CHANNEL: "1",
      DURE_QA_WINDOW_URL: "index.html?qaWindowSmokeController=1&qaBrowserPanel=1",
      DURE_QA_WINDOW_PLAN_JSON: JSON.stringify([{
        label: "main", title: "Dure Browser Panel QA",
        url: "index.html?qaWindowSmokeController=1&qaBrowserPanel=1",
        width: 1100, height: 900, x: osIme ? 80 : -4000, y: osIme ? 80 : -2000,
        visible: true, focus: false, focusable: osIme,
      }]),
      VITE_DURE_BROWSER_QA_CHANNEL: channel.url,
      VITE_DURE_BROWSER_QA_TOKEN: channel.token,
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await channel.close();
}
