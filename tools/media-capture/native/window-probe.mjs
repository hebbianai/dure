import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const helper = resolve(import.meta.dirname, "macos-window-probe.swift");

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`native window ${label} is invalid`);
  }
  return value;
}

export function normalizeWindowProbe(value, expectedOwnerPid) {
  if (
    value?.schemaVersion !== 1 ||
    value.ownerPid !== expectedOwnerPid ||
    !Array.isArray(value.windows)
  ) {
    throw new Error("native window probe returned an invalid envelope");
  }
  return {
    schemaVersion: 1,
    ownerPid: expectedOwnerPid,
    windows: value.windows.map((window) => {
      if (
        !Number.isSafeInteger(window?.windowId) ||
        window.windowId <= 0 ||
        window.ownerPid !== expectedOwnerPid ||
        typeof window.title !== "string" ||
        typeof window.ownerName !== "string" ||
        !Number.isInteger(window.layer) ||
        typeof window.onScreen !== "boolean" ||
        !Number.isInteger(window.sharingState)
      ) {
        throw new Error("native window probe returned an invalid window");
      }
      return {
        windowId: window.windowId,
        title: window.title,
        ownerName: window.ownerName,
        ownerPid: window.ownerPid,
        layer: window.layer,
        alpha: finiteNumber(window.alpha, "alpha"),
        onScreen: window.onScreen,
        sharingState: window.sharingState,
        bounds: {
          x: finiteNumber(window.bounds?.x, "bounds.x"),
          y: finiteNumber(window.bounds?.y, "bounds.y"),
          width: finiteNumber(window.bounds?.width, "bounds.width"),
          height: finiteNumber(window.bounds?.height, "bounds.height"),
        },
      };
    }),
  };
}

export class NativeWindowSetupError extends Error {
  constructor(identity, window) {
    super(`native window ${identity.label} reported a setup error`);
    this.name = "NativeWindowSetupError";
    this.identity = identity;
    this.window = window;
  }
}

function visibleWindow(window, identity) {
  if (
    !window.onScreen ||
    window.layer !== 0 ||
    window.alpha <= 0 ||
    window.bounds.width < 320 ||
    window.bounds.height < 240
  ) {
    throw new Error(
      `native window ${identity.label} is not a visible layer-zero surface`,
    );
  }
  return { ...window, desktopId: identity.id, label: identity.label };
}

function throwSetupErrors(probe, expectedErrors) {
  for (const identity of expectedErrors) {
    const failure = probe.windows.find(
      (window) => window.title === identity.title,
    );
    if (failure) throw new NativeWindowSetupError(identity, failure);
  }
}

export function matchingAvailableWindows(
  probe,
  expectedStates,
  expectedErrors = [],
) {
  throwSetupErrors(probe, expectedErrors);
  const byLabel = new Map();
  for (const identity of expectedStates) {
    const identities = byLabel.get(identity.label) ?? [];
    identities.push(identity);
    byLabel.set(identity.label, identities);
  }
  const available = [];
  for (const identities of byLabel.values()) {
    const titles = new Set(identities.map(({ title }) => title));
    const matches = probe.windows.filter((window) => titles.has(window.title));
    if (matches.length > 1) {
      throw new Error(
        `native window ${identities[0].label} has ambiguous observable states`,
      );
    }
    if (matches.length === 1) {
      available.push(visibleWindow(matches[0], identities[0]));
    }
  }
  return available;
}

export function matchingReadyWindows(probe, expected, expectedErrors = []) {
  throwSetupErrors(probe, expectedErrors);
  return expected.map((identity) => {
    const matches = probe.windows.filter(
      (window) => window.title === identity.title,
    );
    if (matches.length !== 1) {
      throw new Error(
        `native window ${identity.label} expected one exact ready title, observed ${matches.length}`,
      );
    }
    const window = matches[0];
    return visibleWindow(window, identity);
  });
}

export async function probeMacosWindows(processId) {
  if (process.platform !== "darwin") {
    throw new Error("native multi-window capture currently requires macOS");
  }
  const { stdout } = await execFileAsync("/usr/bin/swift", [helper, String(processId)], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("native window probe returned invalid JSON");
  }
  return normalizeWindowProbe(value, processId);
}

export async function waitForReadyWindows({
  expected,
  expectedErrors = [],
  processId,
  timeoutMs = 180_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const probe = await probeMacosWindows(processId);
      return {
        probe,
        windows: matchingReadyWindows(probe, expected, expectedErrors),
      };
    } catch (error) {
      if (error instanceof NativeWindowSetupError) throw error;
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  throw new Error(`timed out waiting for native media windows: ${String(lastError)}`);
}

export async function captureWindowPng(windowId, destination) {
  await execFileAsync(
    "/usr/sbin/screencapture",
    ["-x", "-o", "-l", String(windowId), destination],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000 },
  );
  await access(destination);
  const bytes = await readFile(destination);
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes.subarray(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error(`native window ${windowId} did not produce a valid PNG`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 320 || height < 240) {
    throw new Error(`native window ${windowId} produced an undersized PNG`);
  }
  return { bytes: bytes.length, width, height };
}
