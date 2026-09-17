import { resolve } from "node:path";
import { isAppProcessCommand } from "./app-executable.mjs";

export function parseProcessRows(raw) {
  return raw
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      command: match[3],
    }));
}

export function appChannelFromProcessEnvironment(raw) {
  const canonical = raw.match(
    /(?:^|\s)DURE_APP_CHANNEL=(\S*)(?:\s|$)/,
  );
  if (canonical) {
    return /^[a-z0-9-]{1,64}$/.test(canonical[1])
      ? canonical[1]
      : undefined;
  }
  return raw.match(
    /(?:^|\s)HEBBIAN_APP_CHANNEL=([a-z0-9-]{1,64})(?:\s|$)/,
  )?.[1];
}

export function isHebbianAppProcess(command) {
  return isAppProcessCommand(command);
}

export function classifyHebbianProcess(
  process,
  installedAppPath = "/Applications/Dure.app",
) {
  const command = process.command.trim();
  const installedExecutableRoot = `${resolve(installedAppPath)}/Contents/MacOS/`;
  if (command.startsWith(installedExecutableRoot)) {
    return { ...process, kind: "stable" };
  }
  if (isAppProcessCommand(command)) {
    if (process.appChannel && process.appChannel !== "stable") {
      return { ...process, kind: "isolated-dev" };
    }
    return { ...process, kind: "worktree-dev" };
  }
  return { ...process, kind: "other" };
}

export function dailyDriverSafety(processes, installedAppPath) {
  const classified = processes.map((process) =>
    classifyHebbianProcess(process, installedAppPath),
  );
  return {
    stable: classified.filter((process) => process.kind === "stable"),
    unsafeDevelopment: classified.filter(
      (process) => process.kind === "worktree-dev",
    ),
    isolatedDevelopment: classified.filter(
      (process) => process.kind === "isolated-dev",
    ),
    other: classified.filter((process) => process.kind === "other"),
  };
}
