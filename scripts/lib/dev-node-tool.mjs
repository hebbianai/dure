import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NODE_VERSION = /^\d+\.\d+\.\d+$/;
const PIN_FILES = [".node-version", ".nvmrc"];

function normalizeVersion(value) {
  const version = String(value).trim().replace(/^v/, "");
  if (!NODE_VERSION.test(version)) {
    throw new Error("dev Node runtime pin is invalid");
  }
  return version;
}

export function readPinnedDevNodeRuntime(root) {
  const pins = PIN_FILES.flatMap((relativePath) => {
    const pathname = join(root, relativePath);
    return existsSync(pathname)
      ? [{ relativePath, version: normalizeVersion(readFileSync(pathname, "utf8")) }]
      : [];
  });
  if (pins.length === 0) return null;
  if (pins.some(({ version }) => version !== pins[0].version)) {
    throw new Error(
      `cold_bootstrap_required: dev Node runtime pins disagree (${pins
        .map(({ relativePath, version }) => `${relativePath}=${version}`)
        .join(", ")})`,
    );
  }
  return Object.freeze({ version: pins[0].version, sources: pins.map((pin) => pin.relativePath) });
}

function candidateBinDirectories(home, version, currentExecutable) {
  return [...new Set([
    dirname(currentExecutable),
    join(home, ".nvm", "versions", "node", `v${version}`, "bin"),
    join(home, ".local", "share", "mise", "installs", "node", version, "bin"),
    join(home, ".asdf", "installs", "nodejs", version, "bin"),
    join(home, ".volta", "tools", "image", "node", version, "bin"),
  ])];
}

export function resolvePinnedDevNodeTool({
  root,
  home = homedir(),
  currentExecutable = process.execPath,
  run = execFileSync,
  pathExists = existsSync,
} = {}) {
  const pin = readPinnedDevNodeRuntime(root);
  const version = pin?.version ?? normalizeVersion(process.version);
  for (const binDirectory of candidateBinDirectories(home, version, currentExecutable)) {
    const nodeExecutable = join(binDirectory, "node");
    if (!pathExists(nodeExecutable)) continue;
    try {
      const observed = normalizeVersion(
        run(nodeExecutable, ["--version"], {
          encoding: "utf8",
          timeout: 5_000,
        }),
      );
      if (observed === version) {
        return Object.freeze({
          version,
          binDirectory,
          nodeExecutable,
        });
      }
    } catch {}
  }
  throw new Error(
    `dev_node_runtime_unavailable: install Node ${version} for the target worktree`,
  );
}
