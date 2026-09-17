#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node;
if (process.versions.node !== nodeVersion) {
  throw new Error(`Dure packaging requires Node ${nodeVersion}`);
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: root });
const untrackedPayload = execFileSync("git", [
  "ls-files", "--others", "--exclude-standard", "--", "cli",
  "orchestration/integration", "crates/dure-app/control-plane/provider-drivers/claude",
], { cwd: root, encoding: "utf8" });
if (untrackedPayload.trim()) throw new Error("Dure packaging requires tracked payload sources");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
const target = process.env.CARGO_BUILD_TARGET || host;
if (!target?.endsWith("-apple-darwin") || target !== host || process.platform !== "darwin") {
  throw new Error("packaged Dure CLI staging currently requires a native macOS target");
}
const dependencies = execFileSync("/usr/bin/otool", ["-L", process.execPath], { encoding: "utf8" });
for (const line of dependencies.split("\n").slice(1).filter((line) => line.trim())) {
  if (!/^\s+\/(?:usr\/lib|System\/Library)\//.test(line)) {
    throw new Error("packaged Node must depend only on macOS system libraries");
  }
}
const resources = join(root, "src-tauri", "resources");
mkdirSync(resources, { recursive: true });
const temporary = mkdtempSync(join(resources, ".dure-cli-stage-"));
const destination = join(resources, "dure-cli");
try {
  const environment = { ...process.env };
  delete environment.CARGO_BUILD_TARGET;
  for (const key of Object.keys(environment)) {
    if (/^(DURE_CLI_|HEBBIAN_IDE_CLI_|DURE_HMUX_|HMUX_BUILD_ID$|DURE_CONTROL_PLANE_BIN$|DURE_CLAUDE_PROCESS_RELAY_BIN$)/.test(key)) {
      delete environment[key];
    }
  }
  execFileSync(process.execPath, [
    join(root, "scripts", "install-dure-cli.mjs"), "--bundle", join(temporary, "payload"),
  ], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...environment,
      DURE_APP_CHANNEL: "stable",
      DURE_CLI_SOURCE_REVISION: revision,
      DURE_HMUX_BIN: join(root, "src-tauri", "binaries", `hmux-${target}`),
      DURE_HMUX_RUNTIME_BIN: join(root, "src-tauri", "binaries", `hmux-runtime-${target}`),
      DURE_HMUX_BUILD_ID: `release-${revision}`,
    },
  });
  // Only this generated resource directory belongs to this staging operation.
  if (existsSync(destination)) rmSync(destination, { recursive: true });
  renameSync(join(temporary, "payload"), destination);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
