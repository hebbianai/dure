#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import {
  appChannelFromProcessEnvironment,
  dailyDriverSafety,
  isHebbianAppProcess,
  parseProcessRows,
} from "./lib/daily-driver.mjs";
import { readProcessCwd } from "./lib/unix-process-tools.mjs";

const EXPECTED_IDENTIFIER = "io.hebbian.ade";
// 리브랜딩(Dure) 과도기: 새 설치본(Dure.app)을 우선 찾고, 아직 설치본이
// 구명(Hebbian.app)이면 그대로 쓴다. identifier는 io.hebbian.ade로 동일.
const installedAppPath =
  process.env.HEBBIAN_DAILY_APP_PATH ||
  ["/Applications/Dure.app", "/Applications/Hebbian.app"].find(existsSync) ||
  "/Applications/Dure.app";

function readDefaults(key) {
  return execFileSync(
    "/usr/bin/defaults",
    ["read", join(installedAppPath, "Contents", "Info"), key],
    { encoding: "utf8" },
  ).trim();
}

function inspectInstalledApp() {
  if (!existsSync(installedAppPath)) {
    throw new Error(
      `installed daily driver is missing: ${installedAppPath}\n` +
        "Install the dogfood release before using app:daily:start.",
    );
  }
  const metadata = lstatSync(installedAppPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("installed daily driver must be a real application directory");
  }
  const identifier = readDefaults("CFBundleIdentifier");
  if (identifier !== EXPECTED_IDENTIFIER) {
    throw new Error(
      `installed app identifier is ${identifier}; expected ${EXPECTED_IDENTIFIER}`,
    );
  }
  const executableName = readDefaults("CFBundleExecutable");
  const executablePath = join(
    realpathSync(installedAppPath),
    "Contents",
    "MacOS",
    executableName,
  );
  if (!existsSync(executablePath) || lstatSync(executablePath).isSymbolicLink()) {
    throw new Error("installed daily-driver executable is missing or symlinked");
  }
  return {
    path: realpathSync(installedAppPath),
    identifier,
    version: readDefaults("CFBundleShortVersionString"),
    executablePath,
  };
}

function processAppChannel(pid) {
  try {
    const processEnvironment = execFileSync(
      "/bin/ps",
      ["eww", "-p", String(pid), "-o", "command="],
      { encoding: "utf8" },
    );
    return appChannelFromProcessEnvironment(processEnvironment);
  } catch {
    return undefined;
  }
}

function inspectProcesses(appPath) {
  const rows = parseProcessRows(
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    }),
  )
    .filter((process) => isHebbianAppProcess(process.command))
    .map((process) => ({
      ...process,
      cwd: readProcessCwd(process.pid),
      appChannel: processAppChannel(process.pid),
    }));
  return dailyDriverSafety(rows, appPath);
}

function status() {
  const installed = inspectInstalledApp();
  const processes = inspectProcesses(installed.path);
  return {
    schemaVersion: 1,
    safe: processes.unsafeDevelopment.length === 0,
    installed,
    processes,
  };
}

const command = process.argv[2] || "status";
try {
  const report = status();
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.safe) process.exitCode = 2;
  } else if (command === "start") {
    if (!report.safe) {
      const details = report.processes.unsafeDevelopment
        .map(
          (process) =>
            `  pid=${process.pid} cwd=${process.cwd ?? "unknown"}`,
        )
        .join("\n");
      throw new Error(
        "an unisolated worktree Tauri dev app is still running:\n" +
          `${details}\n` +
          "Quit that app once, then use `corepack pnpm app:dev` for development.",
      );
    }
    if (report.processes.stable.length > 0) {
      process.stdout.write(
        `Daily driver is already running (pid ${report.processes.stable[0].pid}).\n`,
      );
    } else {
      const launched = spawnSync(
        "/usr/bin/open",
        [report.installed.path],
        { stdio: "inherit" },
      );
      if (launched.status !== 0) {
        throw new Error(`open exited with status ${launched.status}`);
      }
      process.stdout.write(`Started ${report.installed.path}.\n`);
    }
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`daily-driver: ${error.message}\n`);
  process.exitCode = 1;
}
