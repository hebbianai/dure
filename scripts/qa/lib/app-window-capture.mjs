import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The QA app's largest normal-layer window, by its CoreGraphics id. The app
 * is the process named in the runner's server descriptor. */
export function appWindowId({
  stateRoot = process.env.DURE_QA_STATE_ROOT,
  descriptorPath = process.env.DURE_QA_SERVER_DESCRIPTOR,
} = {}) {
  const { processId } = JSON.parse(readFileSync(descriptorPath, "utf8"));
  const source = join(stateRoot, "window-id.swift");
  writeFileSync(source, `import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]
let owned = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
let area = { (window: [String: Any]) -> Double in
  let bounds = window[kCGWindowBounds as String] as! [String: Double]
  return bounds["Width"]! * bounds["Height"]!
}
print(owned.max { area($0) < area($1) }![kCGWindowNumber as String]!)
`);
  return execFileSync("/usr/bin/swift", [source, String(processId)], {
    encoding: "utf8", timeout: 120_000,
  }).trim();
}

/** Capture one window to a PNG. Capturing by window id never raises the app,
 * so the background layer's focus guard holds. */
export function captureAppWindow(windowId, file) {
  execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", windowId, file]);
}
