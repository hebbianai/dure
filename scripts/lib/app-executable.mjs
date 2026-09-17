import { join } from "node:path";

export const APP_EXECUTABLE_NAME = "dure";
export const LEGACY_APP_EXECUTABLE_NAMES = Object.freeze(["agent-ide"]);
export const APP_EXECUTABLE_NAMES = Object.freeze([
  APP_EXECUTABLE_NAME,
  ...LEGACY_APP_EXECUTABLE_NAMES,
]);

const executableAlternation = APP_EXECUTABLE_NAMES.join("|");
const debugAppPattern = new RegExp(
  `^\\s*(?:(?:\\/.*\\/)|(?:src-tauri\\/))?target\\/debug\\/(?:${executableAlternation})(?:\\s|$)`,
);
const bundledAppPattern = new RegExp(
  `^\\s*\\/(?:[^/]+\\/)*(?:Dure|Hebbian)(?: Dev [^/]*)?\\.app\\/Contents\\/MacOS\\/(?:${executableAlternation})(?:\\s|$)`,
);
const absoluteDebugAppPattern = new RegExp(
  `^\\s*(\\/.*?)\\/(?:src-tauri\\/)?target\\/debug\\/(?:${executableAlternation})(?:\\s|$)`,
);
const absoluteBundledDebugAppPattern = new RegExp(
  `^\\s*(\\/.*?)\\/(?:src-tauri\\/)?target\\/debug\\/(?:[^/]+\\/)*Dure(?: Dev [^\\/]*)?\\.app\\/Contents\\/MacOS\\/(?:${executableAlternation})(?:\\s|$)`,
);

/**
 * Tauri dev app executable only. A bare `dure` must stay false because the
 * public CLI intentionally has the same canonical command name.
 */
export function isDebugAppProcessCommand(command) {
  return typeof command === "string" && debugAppPattern.test(command);
}

export function isBundledAppProcessCommand(command) {
  return typeof command === "string" && bundledAppPattern.test(command);
}

export function isAppProcessCommand(command) {
  return (
    isBundledAppProcessCommand(command) || isDebugAppProcessCommand(command)
  );
}

/** Absolute worktree root embedded in a debug executable command, if present. */
export function debugAppRootFromCommand(command) {
  if (typeof command !== "string") return undefined;
  return (
    command.match(absoluteDebugAppPattern)?.[1] ??
    command.match(absoluteBundledDebugAppPattern)?.[1]
  );
}

/** Canonical binary first, followed by migration-only legacy candidates. */
export function debugAppBinaryPaths(root) {
  return APP_EXECUTABLE_NAMES.map((name) =>
    join(root, "src-tauri", "target", "debug", name),
  );
}
