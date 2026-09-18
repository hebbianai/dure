import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { handleMcpRequest } from "../../cli/lib/orchestration-mcp-server.mjs";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";

const deviceId = process.env.DURE_QA_MOBILE_DEVICE;
const artifactPath = process.env.DURE_QA_MOBILE_APP;
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
assert.ok(deviceId && artifactPath && evidence);
const target = { platform: "ios", deviceId };
const appId = "com.dure.mobile-simulator-qa";
const projectPath = dirname(artifactPath);
const transcript = [];
let sequence = 0;
function cli(args, code = 0) {
  const result = spawnSync(process.execPath, [resolve("cli/dure.mjs"), "client", ...args, "--json"], { env: process.env, encoding: "utf8", timeout: 65_000 });
  if (result.error) throw result.error;
  const receipt = JSON.parse(result.stdout || result.stderr);
  transcript.push({ args, code: result.status, receipt });
  writeFileSync(join(evidence, "agent-workflow.json"), JSON.stringify(transcript, null, 2));
  assert.equal(result.status, code, JSON.stringify(receipt));
  return receipt;
}
// Poll only observations. Mutations are issued once, never retried on timeout.
async function observe(label, read, accept, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((done) => setTimeout(done, 200));
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

const descriptor = JSON.parse(readFileSync(process.env.DURE_QA_SERVER_DESCRIPTOR, "utf8"));
await observe("frontend diagnostics ready", async () => {
  try {
    return await requestAppControl({ descriptor, path: "/diagnostics", body: {}, timeoutMs: 3000 });
  } catch (error) { return { error: String(error) }; }
}, (value) => !value.error, 90_000);
const opened = cli(["pane", "open", "mobile", "--space-id", "desk-1"]);
const paneId = opened.pane.panelId;
assert.equal(opened.pane.component, "mobileSimulator");
await observe("registered mobile actions", () => cli(["pane", "state", paneId]), (value) => value.pane.actions.includes("mobile.devices"));
const action = (name, args = {}, code = 0) => {
  const receipt = cli(["pane", "act", paneId, name, "--args-json", JSON.stringify(args), "--idempotency-key", `mobile-qa-${++sequence}`], code);
  return receipt.pane?.result ?? receipt;
};
const status = () => action("mobile.status").value;
const devices = action("mobile.devices").value;
assert.ok(devices.devices.some((device) => device.id === deviceId && device.state === "shutdown"));
action("mobile.select", target);
await observe("selected exact device", status, (state) => state.device?.id === deviceId);
const reused = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/call", params: { name: "app_pane_open", arguments: { tool: "mobile", spaceId: "desk-1" } } }, process.env);
assert.notEqual(reused.isError, true, JSON.stringify(reused));
assert.equal(reused.structuredContent.pane.panelId, paneId);
assert.equal(reused.structuredContent.pane.reused, true);
assert.equal(status().device.id, deviceId);
assert.equal(action("mobile.launch", { ...target, deviceId: "different-device", appId }, 2).error.code, "mobile_device_changed");

action("mobile.profile.save", { ...target, projectPath, appId, artifactPath: join(projectPath, "missing.app"), buildCommand: "printf mobile-agent-build" });
assert.equal(action("mobile.devices").value.devices.find((device) => device.id === deviceId).state, "shutdown", "Saving a profile must not boot a device");
assert.equal(action("mobile.run", { ...target, projectPath }).outcome, "pending");
const failed = await observe("invalid artifact run completed", status, (state) => !state.busy, 180_000);
assert.ok(failed.error, "The missing artifact must not be installed");
assert.match(failed.error, /No such file or directory/u, "Only the deliberately missing artifact may fail here");
assert.equal(failed.deviceState, "ready", `A failed post-boot operation must refresh device state: ${JSON.stringify(failed)}`);
for (const [name, args] of [["mobile.boot", {}], ["mobile.install", { path: artifactPath }]]) {
  assert.equal(action(name, { ...target, ...args }).outcome, "pending");
  const completed = await observe(`${name} completed`, status, (state) => !state.busy, 180_000);
  assert.ok(!completed.error, JSON.stringify(completed));
}
action("mobile.profile.save", { ...target, projectPath, appId, artifactPath, buildCommand: "printf mobile-agent-build", url: "mobileqa://home" });
assert.equal(action("mobile.run", { ...target, projectPath }).outcome, "pending");
const ran = await observe("profile completed", status, (state) => !state.busy, 180_000);
assert.ok(!ran.error, JSON.stringify(ran));
assert.match(ran.buildOutput, /mobile-agent-build/u);
assert.equal(ran.deviceState, "ready");
console.log("PASS: real app CLI/MCP open, reuse, discovery, selection, profile build/boot/install/launch");

const clipboard = () => execFileSync("/usr/bin/xcrun", ["simctl", "pbpaste", deviceId], { encoding: "utf8" });
execFileSync("/usr/bin/xcrun", ["simctl", "pbcopy", deviceId], { input: "qa clipboard sentinel" });
assert.equal(action("mobile.paste", { ...target, text: "must not write" }, 2).outcome, "failed");
assert.equal(clipboard(), "qa clipboard sentinel", "A missing live lease cannot change the clipboard");
action("mobile.preview", { ...target, mode: "live" });
await observe("live frames", status, (state) => state.preview.liveFrameReady);
const capture = () => action("mobile.capture", target).value;
const pixelSource = join(projectPath, "pixel.swift");
const pixelProgram = join(projectPath, "pixel");
writeFileSync(pixelSource, `import AppKit
if CommandLine.arguments[1] == "window" {
  let pid = Int(CommandLine.arguments[2])!
  let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]
  let window = windows.first {
    ($0[kCGWindowOwnerPID as String] as? Int) == pid &&
    ($0[kCGWindowName as String] as? String) == "Dure Mobile Simulator QA"
  }!
  print(window[kCGWindowNumber as String]!)
  exit(0)
}
let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))!
let x = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2])! : 0.5
let y = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3])! : 0.14
let color = bitmap.colorAt(x: Int(Double(bitmap.pixelsWide) * x), y: Int(Double(bitmap.pixelsHigh) * y))!
print([color.redComponent, color.greenComponent, color.blueComponent].map { Int(($0 * 255).rounded()) })
`);
execFileSync("/usr/bin/swiftc", [pixelSource, "-o", pixelProgram], { timeout: 60_000 });
// SDK acceptance does not mean the guest's confirmation is visible yet.
// Observe the light alert surface between the fixture's two white controls.
const first = await observe("deep-link confirmation visible", () => {
  const frame = capture();
  const pixel = JSON.parse(execFileSync(pixelProgram, [frame.path, "0.3", "0.5"], { encoding: "utf8" }));
  return { ...frame, pixel };
}, (frame) => Math.min(...frame.pixel) > 180 && Math.max(...frame.pixel) - Math.min(...frame.pixel) < 30);
copyFileSync(first.path, join(evidence, "deep-link-confirmation.png"));
const touchTarget = { ...target, width: first.width, height: first.height };
action("mobile.tap", { ...touchTarget, x: 0.67, y: 0.55 });
async function color(expected, label) {
  const frame = await observe(label, () => {
    const frame = capture();
    const pixel = JSON.parse(execFileSync(pixelProgram, [frame.path], { encoding: "utf8" }));
    return { ...frame, pixel };
  }, (frame) => expected.every((value, index) => Math.abs(frame.pixel[index] - value) <= 4));
  copyFileSync(frame.path, join(evidence, `${label}.png`));
}
await color([180, 100, 30], "deep-link");
action("mobile.tap", { ...touchTarget, x: 0.5, y: 370 * 3 / first.height });
await color([40, 150, 80], "tap");
action("mobile.tap", { ...touchTarget, x: 0.5, y: 470 * 3 / first.height });
action("mobile.type", { ...target, text: "Dure" });
await color([120, 60, 190], "typed");
const addon = { exports: {} };
process.dlopen(addon, new URL("./native/serve-sim-native.node", import.meta.resolve("serve-sim/middleware")).pathname);
const guestText = async () => {
  const nodes = JSON.parse(await addon.exports.axDescribe(deviceId));
  const find = (nodes) => { for (const node of nodes) { if (node.AXLabel === "QA input") return node.AXValue; const found = find(node.children ?? []); if (found !== undefined) return found; } };
  return find(nodes);
};
const pastedText = "\n한글 🙂\nsecond\tline\nhmux-pair://test?token=Exact%2BCharacters_0123456789";
assert.equal(action("mobile.paste", { ...target, text: pastedText }).outcome, "applied");
await observe("exact Unicode multiline paste", guestText, (value) => value === `Dure${pastedText}`);
assert.equal(clipboard(), pastedText);
for (const [text, outcome] of [["", "failed"], ["x".repeat(8193), "refused"], ["한".repeat(2731), "failed"], ["a\u0000b", "failed"]]) {
  assert.equal(action("mobile.paste", { ...target, text }, 2).outcome, outcome);
  assert.equal(clipboard(), pastedText, "Rejected paste cannot replace the clipboard");
}
assert.equal(await guestText(), `Dure${pastedText}`);
copyFileSync(capture().path, join(evidence, "pasted-unicode.png"));
console.log("PASS: exact iOS Unicode, emoji, multiline and URL paste; missing lease and invalid text leave clipboard unchanged");
const windowId = execFileSync(pixelProgram, ["window", String(descriptor.processId)], { encoding: "utf8" }).trim();
execFileSync("/usr/sbin/screencapture", ["-x", "-l", windowId, join(evidence, "dure-app.png")]);
action("mobile.rotate", { ...target, landscape: true });
const landscape = await observe("landscape", capture, (frame) => frame.width > frame.height);
copyFileSync(landscape.path, join(evidence, "landscape.png"));
assert.equal(action("mobile.tap", { ...touchTarget, x: 0.5, y: 0.5 }, 2).outcome, "failed", "The portrait capture must not authorize landscape touch");
action("mobile.tap", { ...target, width: landscape.width, height: landscape.height, x: 195 * 3 / landscape.width, y: 350 * 3 / landscape.height });
// Canvas exports use the WebView color space; require the green button state
// rather than comparing its encoded channels to the original SDK PNG profile.
const landscapeTap = await observe("landscape touch", () => {
  const frame = capture();
  const pixel = JSON.parse(execFileSync(pixelProgram, [frame.path], { encoding: "utf8" }));
  return { ...frame, pixel };
}, (frame) => frame.pixel[1] > frame.pixel[0] + 50 && frame.pixel[1] > frame.pixel[2] + 40);
copyFileSync(landscapeTap.path, join(evidence, "landscape-tap.png"));
action("mobile.rotate", { ...target, landscape: false });
await observe("portrait", capture, (frame) => frame.height > frame.width);
action("mobile.preview", { ...target, mode: "snapshot" });
await observe("snapshot", status, (state) => state.preview.frameReady && !state.preview.liveFrameReady);
action("mobile.preview", { ...target, mode: "live" });
await observe("reconnected live", status, (state) => state.preview.liveFrameReady);
console.log("PASS: CLI live preview, tap, typing, rotation and stop/reconnect changed actual iOS pixels");

const report = action("mobile.report.prepare", { ...target, appId }).value;
assert.ok(report.reportId && report.text.includes(appId));
assert.ok(readFileSync(report.screenshot.path).length > 1000);
assert.match(action("mobile.report.draft", { ...target, reportId: "stale", agentId: "unavailable" }, 2).error.message, /Report changed/u);
assert.deepEqual(action("mobile.report.agents").value, [], "Disposable app must not expose the user's agents");
action("mobile.profile.remove", { ...target, projectPath });
assert.deepEqual(status().profiles, []);
action("mobile.clear", target);
assert.equal(status().device, null);
console.log("PASS: editable report preparation, stale draft refusal, profile removal and selection clearing; no agent message submitted");

// Exercise the shared pane claim path with real Hmux terminal input as well.
// The existing client creates and closes only this runner's disposable sessions.
process.env.DURE_QA_TARGET_WINDOW_LABEL = "main";
await import("./cli-hmux-create-space-owner-client.mjs");
