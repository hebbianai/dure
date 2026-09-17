#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startBrowserViewerChannel } from "./lib/browser-viewer-channel.mjs";

const [binary, chrome] = process.argv.slice(2);
if (!binary || !chrome || process.platform !== "darwin") {
  throw new Error(
    "usage (macOS): browser-viewer-smoke.mjs <agent-browser-v0.36.0> <chromium-executable>",
  );
}
const channel = await startBrowserViewerChannel();
try {
  const child = spawn(
    "node",
    [
      "scripts/run-with-build-storage.mjs",
      "qa",
      "--",
      "sh",
      "scripts/qa/lib/tauri-app-runner.sh",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DURE_BROWSER_QA_BINARY: resolve(binary),
        DURE_BROWSER_QA_CHROME: resolve(chrome),
        DURE_QA_CLIENT: resolve("scripts/qa/browser-runtime-smoke.mjs"),
        DURE_QA_NAME: "Browser viewer smoke",
        DURE_QA_ARTIFACT_NAME: "browser-viewer",
        DURE_QA_LAYER: "background",
        DURE_QA_UNIQUE_APP_CHANNEL: "1",
        DURE_QA_WINDOW_TITLE: "Dure Browser Runtime QA",
        DURE_QA_WINDOW_URL: "index.html?qaBrowserRuntime=1",
        DURE_QA_WINDOW_PLAN_JSON: JSON.stringify([
          {
            label: "browser-runtime",
            title: "Dure Browser Runtime QA",
            url: "index.html?qaBrowserRuntime=1",
            width: 1100,
            height: 900,
            x: -4000,
            y: -2000,
            visible: true,
            focus: false,
            focusable: false,
          },
        ]),
        VITE_DURE_BROWSER_RUNTIME_QA: "1",
        VITE_DURE_BROWSER_QA_CHANNEL: channel.url,
        VITE_DURE_BROWSER_QA_TOKEN: channel.token,
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await channel.close();
}
