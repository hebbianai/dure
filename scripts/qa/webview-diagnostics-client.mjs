import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
assert.equal(home, path.join(root, "home"));
assert.equal(process.env.DURE_HOME, path.join(home, ".dure"));
assert.equal(
  fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT),
  path.join(root, "hmux-discovery"),
);
assert(path.basename(root).startsWith("dure-webview-diagnostics."));
await waitForQaLogReceipt(
  "webview-diagnostics", process.env.DURE_QA_WEBVIEW_DIAGNOSTICS_PROOF,
);
const file = path.join(
  path.dirname(process.env.DURE_QA_SERVER_DESCRIPTOR),
  "hmux-connection-diagnostics.json",
);
const windows = ["main", "win-195-1"];
const sources = ["console", "render_boundary", "window_error", "unhandled_rejection"];
const deadline = Date.now() + 30_000;
let events = [];
while (Date.now() < deadline) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assert(!raw.includes("diagnostic-fixture-secret"), "private canary reached the native journal");
  events = raw ? JSON.parse(raw).webviewEvents ?? [] : [];
  if (windows.every((label) => sources.every((source) =>
    events.some((event) => event.windowLabel === label && event.source === source)))) break;
  await delay(250);
}
assert(events.length <= 256);
for (const label of windows) {
  const rows = events.filter((event) => event.windowLabel === label);
  assert(rows.length > 0, `no persisted native diagnostics for ${label}`);
  for (const source of sources) {
    assert(rows.some((event) => event.source === source), `missing ${source} for ${label}`);
  }
  assert(rows.some((event) => event.code === "client_space_window_changed"));
  assert(rows.every((event) => event.count > 0 && event.lastSeenMs >= event.firstSeenMs));
}
const metadata = fs.statSync(file);
assert.equal(metadata.mode & 0o777, 0o600);
assert(metadata.size < 128 * 1024);
fs.writeFileSync(
  path.join(root, "evidence", "webview-diagnostics.json"),
  JSON.stringify({ result: "passed", windows, events, nativeFileBytes: metadata.size }, null, 2),
);
console.log("WebView diagnostics: two native windows persisted redacted console, runtime, rejection and render failure records.");
