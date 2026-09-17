import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseMetadata } from "../../cli/lib/dure-cli-channel-launcher.mjs";

const workerHash = fs.readFileSync(new URL("../../cli/lib/mcp-memory-worker.sha256", import.meta.url), "utf8").trim();

export function verifiedMemoryRelay(versionRoot) {
  const metadata = parseMetadata(fs.realpathSync(versionRoot));
  if (metadata.bundle.app.schemaVersion !== 2) {
    throw new Error("Memory idle cleanup requires a source-bound installed bundle");
  }
  if (!metadata.bundle.controlPlane.capabilities.includes("mcp_memory_idle_worker_v1")) {
    throw new Error("Installed bundle does not support Memory idle cleanup");
  }
  return path.join(fs.realpathSync(versionRoot), "bin", metadata.controlPlaneCommand);
}

export function planMemoryEntry(entry, relay) {
  if (!entry || entry.enabled === false || entry.url || entry.experimental_environment) {
    throw new Error("An enabled local Memory stdio entry is required");
  }
  const graph = entry.env?.MEMORY_FILE_PATH;
  if (typeof graph !== "string" || !path.isAbsolute(graph) || entry.env_vars?.includes("MEMORY_FILE_PATH")) {
    throw new Error("Memory needs an explicit, unambiguous absolute data file");
  }
  if (entry.env?.NODE_OPTIONS || entry.env_vars?.includes("NODE_OPTIONS") || process.env.NODE_OPTIONS) {
    throw new Error("Node preloads need a separate restart contract");
  }
  let node = entry.command;
  let worker = entry.args?.[0];
  if (entry.args?.[0] === "mcp-memory-relay") {
    if (entry.args.length !== 7 || entry.args[1] !== "--node" || entry.args[3] !== "--worker" || entry.args[5] !== "--memory-file" || entry.args[6] !== graph) {
      throw new Error("Existing Memory relay entry has an unsupported shape");
    }
    verifiedMemoryRelay(path.dirname(path.dirname(entry.command)));
    node = entry.args[2];
    worker = entry.args[4];
  } else if (entry.args?.length !== 1) {
    throw new Error("Only a direct, pinned Memory entry is supported");
  }
  if (![node, worker, relay].every((value) => typeof value === "string" && path.isAbsolute(value))) {
    throw new Error("Memory executable paths must be absolute");
  }
  if (!/^node(?:\.exe)?$/.test(path.basename(node))) throw new Error("Memory must use a direct Node executable");
  fs.accessSync(node, fs.constants.X_OK);
  if (createHash("sha256").update(fs.readFileSync(worker)).digest("hex") !== workerHash) {
    throw new Error("Unsupported Memory worker source; configuration was not changed");
  }
  return {
    ...entry,
    command: relay,
    args: ["mcp-memory-relay", "--node", node, "--worker", worker, "--memory-file", graph],
  };
}

export async function readUserConfig(call, configPath, cwd) {
  const read = await call("config/read", { includeLayers: true, cwd });
  const layers = read.layers?.filter((layer) => layer.name.type === "user");
  if (layers?.length !== 1 || fs.realpathSync(layers[0].name.file) !== fs.realpathSync(configPath) || !layers[0].version) {
    throw new Error("Codex did not resolve the requested user configuration layer");
  }
  return layers[0];
}

export async function applyMemoryEntry({ call, profile, configPath, name, entry, backupRoot }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Unsupported MCP server key");
  if (isDeepStrictEqual(profile.config.mcp_servers[name], entry)) return { changed: false };
  // Recover only this entry through the same version-checked owner. Never
  // restore an entire old config over intervening user/account changes.
  const backup = fs.mkdtempSync(path.join(backupRoot, "memory-integration-"));
  fs.chmodSync(backup, 0o700);
  fs.writeFileSync(path.join(backup, "previous-entry.json"), JSON.stringify({
    schemaVersion: 1, configPath, name, expectedVersion: profile.version,
    entry: profile.config.mcp_servers[name],
  }), { mode: 0o600, flag: "wx" });
  try {
    const written = await call("config/batchWrite", {
      expectedVersion: profile.version, reloadUserConfig: false,
      edits: [{ keyPath: `mcp_servers.${name}`, value: entry, mergeStrategy: "replace" }],
    });
    if (fs.realpathSync(written.filePath) !== fs.realpathSync(configPath)) throw new Error("Codex wrote an unexpected config layer");
    return { changed: true, backup };
  } catch (error) {
    throw new Error(`Memory config outcome must be read before retry; recovery entry: ${backup}`, { cause: error });
  }
}
