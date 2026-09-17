#!/usr/bin/env node

// Linux WebKitGTK fixture: production React/Markdown, disposable WebView data,
// and the repository's process supervisor. This does not launch the Dure app.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { ensureHeadroom } from "../lib/build-storage-admission.mjs";
import { supervise } from "./lib/owned-process-group.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const out = await fs.mkdtemp(path.join(os.tmpdir(), "dure-streaming-markdown-"));
console.log(`Artifacts: ${out}`);
assert.equal(process.platform, "linux", "This fixture requires Linux WebKitGTK 4.1 and Xvfb");
const sources = {};
for (const source of [
  "src/components/agents/chat/ChatMarkdown.tsx",
  "src/components/common/SafeMarkdown.tsx",
  "src/components/workspace/WorkspaceRuntimeContext.tsx",
]) {
  sources[source] = createHash("sha256").update(await fs.readFile(path.join(repo, source))).digest("hex");
}

const entry = `
import { createElement as h, Profiler } from "react";
import { createRoot, flushSync } from "react-dom/profiling";
import { ChatMarkdown } from "@/components/agents/chat/ChatMarkdown";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const container = document.getElementById("root");
const root = createRoot(container);
const paragraph = "A long answer with **Markdown**, inline " + String.fromCharCode(96) + "code" + String.fromCharCode(96) + ", and a [reference](https://example.com/docs). ";
const answer = size => Array.from({length: size}, (_, i) =>
  "## Section " + (i + 1) + "\\n\\n" + paragraph.repeat(4) +
  "\\n\\n| Item | Value |\\n| --- | --- |\\n| A | **B** |\\n\\n"
).join("");
const results = [];

async function hiddenWorkspaceSample() {
  const roles = new TerminalPresentationRoleStore();
  const markdown = answer(26);
  const render = (active, text, streaming, key = "live") => {
    container.style.contentVisibility = active ? "visible" : "hidden";
    container.style.visibility = active ? "visible" : "hidden";
    flushSync(() => root.render(h(WorkspaceRuntimeProvider, {
      desktopId: "hidden-chat-qa", active, frozen: !active,
      presentationRoleStore: roles, commitLayout: () => true,
    }, h(ChatMarkdown, {key, markdown: text, streaming}))));
  };
  render(true, markdown, true);
  render(true, markdown + "Pending before hide", true);
  render(false, markdown + "Pending before hide", true);
  window.markdownCalls = 0;
  for (let i = 1; i <= 20; i++) {
    render(false, markdown + "Hidden fragment " + i, true);
    await pause(50);
  }
  await pause(300);
  const hiddenCalls = window.markdownCalls;
  render(true, markdown + "Hidden fragment 20", true);
  const revealCalls = window.markdownCalls - hiddenCalls;
  const revealedLatest = container.textContent.endsWith("Hidden fragment 20");

  render(false, markdown + "Hidden fragment 20", true);
  window.markdownCalls = 0;
  // Completion replaces the live component with a durable transcript row.
  const finalText = markdown + "**Completed while hidden**";
  render(false, finalText, false, "completed-row");
  await pause(300);
  const completedHiddenCalls = window.markdownCalls;
  render(true, finalText, false, "completed-row");
  const completedRevealCalls = window.markdownCalls - completedHiddenCalls;
  const revealedFinal = container.textContent.endsWith("Completed while hidden");
  flushSync(() => root.render(null));
  return {bytes: new TextEncoder().encode(markdown).length, updates: 20,
    hiddenCalls, revealCalls, revealedLatest, completedHiddenCalls,
    completedRevealCalls, revealedFinal};
}

async function sample(mode, markdown, round) {
  const render = (text, streaming) => flushSync(() => root.render(h(Profiler, {
    id: mode, onRender: (_id, _phase, duration) => {
      durations.push(duration);
      if (window.markdownCalls > lastCalls) processedDurations.push(duration);
      lastCalls = window.markdownCalls;
    }
  }, h(ChatMarkdown, { key: mode + round + markdown.length, markdown: text, streaming: mode === "batched" && streaming }))));
  let durations = [], processedDurations = [], lastCalls = 0;
  window.markdownCalls = 0;
  render(markdown, true);
  await pause(300);
  durations = [];
  processedDurations = [];
  window.markdownCalls = 0;
  lastCalls = 0;
  let received = 0, advancedWhileStreaming = 0;
  const observer = new MutationObserver(() => {
    if (container.textContent.includes("Fragment ")) advancedWhileStreaming++;
  });
  observer.observe(container, { subtree: true, childList: true, characterData: true });
  const started = performance.now();
  // Feed the same 40 snapshots on separate tasks, including a sustained burst.
  for (let i = 1; i <= 40; i++) {
    received = i;
    render(markdown + "Fragment " + i, true);
    await pause(20);
  }
  await pause(300);
  const caughtUp = container.textContent.endsWith("Fragment " + received);
  const elapsedMs = performance.now() - started;
  const calls = window.markdownCalls;
  const renderMs = durations.reduce((sum, value) => sum + value, 0);
  const updateMedianMs = median(processedDurations);
  observer.disconnect();

  // A final rewrite must bypass the pending deadline and equal direct output.
  const finalText = markdown + "**Complete** [Final](https://example.com/final)";
  render(markdown + "Pending stale ending", true);
  render(finalText, false);
  const finalHtml = container.innerHTML;
  await pause(300);
  const stayedFinal = finalHtml === container.innerHTML;
  flushSync(() => root.render(h(ChatMarkdown, {markdown: finalText})));
  const finalExact = finalHtml === container.innerHTML;
  results.push({ mode, round, bytes: new TextEncoder().encode(markdown).length,
    received, calls, renderMs, updateMedianMs, elapsedMs, advancedWhileStreaming,
    caughtUp, stayedFinal, finalExact });
  flushSync(() => root.render(null));
}

(async () => {
  for (let round = 0; round < 3; round++) {
    for (const size of [66, 132]) {
      // Alternate order to limit warmup bias.
      for (const mode of round % 2 ? ["batched", "direct"] : ["direct", "batched"]) {
        await sample(mode, answer(size), round);
      }
    }
  }
  const hiddenWorkspace = await hiddenWorkspaceSample();
  root.unmount();
  window.webkit.messageHandlers.result.postMessage(JSON.stringify({results, hiddenWorkspace}));
})().catch(error => window.webkit.messageHandlers.result.postMessage(JSON.stringify({error: String(error.stack)})));
`;

// Count the real synchronous parser; retain its complete implementation.
const markdownProbe = `
import Markdown from ${JSON.stringify(require.resolve("react-markdown"))};
export default function MeasuredMarkdown(props) {
  window.markdownCalls = (window.markdownCalls || 0) + 1;
  return Markdown(props);
}`;
const admission = ensureHeadroom({cwd: repo, label: "Streaming Markdown fixture", requestedBytes: 128 * 1024 * 1024});
assert(admission.ok, admission.message);
let bundle;
try {
  bundle = await build({
    configFile: false,
    root: repo,
    logLevel: "warn",
    resolve: {alias: {"@": path.join(repo, "src")}},
    define: {"process.env.NODE_ENV": JSON.stringify("production")},
    plugins: [{
      name: "streaming-markdown-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id === "fixture") return "\0fixture";
        if (id === "react-markdown") return "\0markdown-probe";
      },
      load(id) {
        if (id === "\0fixture") return entry;
        if (id === "\0markdown-probe") return markdownProbe;
      },
    }],
    build: {write: false, minify: true, rollupOptions: {
      input: "fixture", output: {format: "iife", inlineDynamicImports: true},
    }},
  });
} finally {
  admission.reservation?.release();
}
const code = bundle.output.find(item => item.type === "chunk").code;
await fs.writeFile(path.join(out, "fixture.html"), `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.7 sans-serif}#root{max-width:768px;margin:auto}button{font:inherit}table{border-collapse:collapse}td,th{padding:4px}</style><div id="root"></div><script>${code.replaceAll("</script", "<\\/script")}</script>`);
await fs.writeFile(path.join(out, "webview.py"), `
import gi, json, pathlib, sys
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib
root = pathlib.Path(sys.argv[1])
context = WebKit2.WebContext.new_ephemeral()
view = WebKit2.WebView.new_with_context(context)
manager = view.get_user_content_manager()
def result(_manager, message):
    data = json.loads(message.get_js_value().to_string())
    data["engine"] = "WebKitGTK %s.%s.%s" % (WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version())
    (root / "result.json").write_text(json.dumps(data, indent=2))
    Gtk.main_quit()
manager.register_script_message_handler("result")
manager.connect("script-message-received::result", result)
window = Gtk.Window()
window.set_default_size(1100, 800)
window.add(view)
window.show_all()
view.load_html((root / "fixture.html").read_text(), "file://" + str(root) + "/")
def timeout():
    (root / "result.json").write_text(json.dumps({"error": "WebView fixture exceeded 120 seconds"}))
    Gtk.main_quit()
    return False
GLib.timeout_add_seconds(120, timeout)
Gtk.main()
window.destroy()
`);
const environment = {
  HOME: path.join(out, "home"),
  DURE_HOME: path.join(out, "dure"),
  HMUX_DISCOVERY_ROOT: path.join(out, "hmux"),
  XDG_CACHE_HOME: path.join(out, "cache"),
  XDG_CONFIG_HOME: path.join(out, "config"),
  XDG_DATA_HOME: path.join(out, "data"),
};
for (const directory of Object.values(environment)) await fs.mkdir(directory);
const status = await supervise(path.join(out, "webview-owner.json"), "/usr/bin/env", [
  ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
  "xvfb-run", "-a", "/usr/bin/python3", path.join(out, "webview.py"), out,
], {hardContainment: true, terminateDetachedOwnedGenerations: true});
assert.equal(status, 0, "WebView process cleanup failed");
const report = JSON.parse(await fs.readFile(path.join(out, "result.json"), "utf8"));
assert.equal(report.error, undefined, report.error);
report.sourceSha256 = sources;
report.node = process.version;
report.bundleSha256 = createHash("sha256").update(code).digest("hex");
await fs.writeFile(path.join(out, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(report.engine);
console.table(report.results);
console.log("Hidden workspace:", report.hiddenWorkspace);
assert.equal(report.hiddenWorkspace.hiddenCalls, 0, "Hidden streams must not parse Markdown");
assert.equal(report.hiddenWorkspace.completedHiddenCalls, 0, "Hidden completed rows must not parse Markdown");
assert.equal(report.hiddenWorkspace.revealCalls, 1, "Reveal must parse the latest snapshot once");
assert.equal(report.hiddenWorkspace.completedRevealCalls, 1, "Reveal must parse the completed row once");
assert(report.hiddenWorkspace.revealedLatest && report.hiddenWorkspace.revealedFinal,
  "Reveal must immediately display the latest live or final text");
for (const row of report.results) {
  assert(row.caughtUp && row.stayedFinal && row.finalExact, "Latest and final snapshots must be exact");
  if (row.mode !== "batched") {
    assert.equal(row.calls, row.received, "The unbatched control must process every snapshot");
    continue;
  }
  const before = report.results.find(other => other.mode === "direct" && other.round === row.round && other.bytes === row.bytes);
  assert(row.advancedWhileStreaming > 0, "Continuous output must advance before completion");
  assert(row.calls > 0, "The parser probe must observe streaming work");
  assert(row.calls <= before.calls / 2, "Long streams must process at most half the snapshots");
}
