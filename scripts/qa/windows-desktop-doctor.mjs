import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { requireWindowsProcessIdentitySupport } from "../lib/windows-process-identity-support.mjs";

const REQUIRED_COMMANDS = [
  "node",
  "pnpm",
  "cargo",
  "rustc",
  "git",
  "bash",
  "cscript.exe",
];
const WINDOWS_RUST_HOST = "x86_64-pc-windows-msvc";

export function rustHostFromVerboseVersion(output) {
  return output
    .split(/\r?\n/u)
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length);
}

export function assessWindowsDesktopHost({
  platform,
  architecture,
  tauriConfig,
  commandAvailable,
  rustHost,
}) {
  const problems = [];
  if (platform !== "win32") {
    problems.push(`platform:${platform}`);
  }
  if (architecture !== "x64") {
    problems.push(`architecture:${architecture}`);
  }
  if (tauriConfig) {
    problems.push("environment:TAURI_CONFIG");
  }
  for (const command of REQUIRED_COMMANDS) {
    if (!commandAvailable(command)) {
      problems.push(`command:${command}`);
    }
  }
  if (rustHost !== WINDOWS_RUST_HOST) {
    problems.push(`rust-host:${rustHost || "unavailable"}`);
  }
  return problems;
}

function commandAvailable(command) {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function rustHost() {
  const result = spawnSync("rustc", ["-vV"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  return rustHostFromVerboseVersion(result.stdout);
}

export function runWindowsDesktopDoctor({
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
} = {}) {
  const problems = assessWindowsDesktopHost({
    platform,
    architecture,
    tauriConfig: environment.TAURI_CONFIG,
    commandAvailable,
    rustHost: rustHost(),
  });
  if (problems.length > 0) {
    throw new Error(
      `Windows desktop prerequisites are incomplete: ${problems.join(", ")}`,
    );
  }
  return WINDOWS_RUST_HOST;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void (async () => {
    const target = runWindowsDesktopDoctor();
    await requireWindowsProcessIdentitySupport();
    console.log(`windows desktop prerequisites ready: target=${target}`);
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
