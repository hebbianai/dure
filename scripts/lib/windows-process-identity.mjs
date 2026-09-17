import { fileURLToPath } from "node:url";

const WINDOWS_PROCESS_BOUNDARY = fileURLToPath(
  new URL("../native/windows-process-boundary.js", import.meta.url),
);
const WINDOWS_PROCESS_IDENTITY_PATTERN =
  /^windows:([1-9]\d{0,9}):([1-9]\d{0,15})$/u;

export function windowsProcessBoundary() {
  return {
    file: "cscript.exe",
    prefix: ["//E:JScript", "//NoLogo", WINDOWS_PROCESS_BOUNDARY],
  };
}

export function parseWindowsProcessIdentity(value) {
  const match = typeof value === "string"
    ? value.match(WINDOWS_PROCESS_IDENTITY_PATTERN)
    : null;
  const pid = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const startedAtUnixMicroseconds = match[2];
  return Object.freeze({
    pid,
    processIdentity: `windows:${pid}:${startedAtUnixMicroseconds}`,
    startedAtUnixMicroseconds,
  });
}

export function parseWindowsBoundaryMembers(output, scope) {
  if (scope.kind !== "point") return null;
  const requested = new Set(scope.requestedPids);
  const members = [];
  const observed = new Set();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^M (\d+) (live) (\S+) (\d+)$/u);
    const pid = Number(match?.[1]);
    const identity = parseWindowsProcessIdentity(match?.[3]);
    const startedAtUnixSeconds = Number(match?.[4]);
    const identityMicroseconds = Number(identity?.startedAtUnixMicroseconds);
    if (
      !match ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !requested.has(pid) ||
      observed.has(pid) ||
      identity?.pid !== pid ||
      !Number.isSafeInteger(identityMicroseconds) ||
      Math.floor(identityMicroseconds / 1_000_000) !== startedAtUnixSeconds ||
      !Number.isSafeInteger(startedAtUnixSeconds) ||
      startedAtUnixSeconds <= 0
    ) {
      return null;
    }
    observed.add(pid);
    members.push({
      pid,
      state: match[2],
      processIdentity: identity.processIdentity,
      startedAtUnixSeconds,
    });
  }
  return members.sort((left, right) => left.pid - right.pid);
}
