// Install current provider tooling in disposable QA data. Codex receives its
// entry per invocation; Claude uses the project scope. Its Host owns runtime installation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { mutateOrchestrationIntegrations } from "../../cli/lib/orchestration-integration.mjs";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const guardianRoot = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
const root = fs.realpathSync(config.root);
assert(root.startsWith(`${guardianRoot}${path.sep}`));
const provider = config.provider ?? "codex";
assert(["codex", "claude"].includes(provider));
const workspace = provider === "claude" ? fs.realpathSync(config.workspace) : undefined;
if (workspace) assert(workspace.startsWith(`${root}${path.sep}`));
const homeDirectory = path.join(root, "provider-install");
fs.mkdirSync(homeDirectory, { mode: 0o700 });
const [receipt] = mutateOrchestrationIntegrations({
  action: "install",
  provider,
  cliScriptPath: fileURLToPath(new URL("../../cli/dure.mjs", import.meta.url)),
  channel: "goal-qa",
  homeDirectory,
  global: provider === "codex",
  workspaceRoot: workspace,
  approval: true,
});
assert.equal(receipt.status, "current");
const nativeConfig = fs.readFileSync(receipt.nativeConfigPath, "utf8");
const installed = provider === "codex" ? parse(nativeConfig) : JSON.parse(nativeConfig);
const entry = (installed.mcp_servers ?? installed.mcpServers)["dure-orchestration"];
const backendHome = path.join(root, "backend-client");
const unrelatedHome = path.join(root, "unrelated-client");
const profile = {
  id: "local", default: false,
  transport: { kind: "local", endpoint: { kind: "unix_socket", path: config.endpoint } },
  auth: { kind: "peer" }, trust: { kind: "local_peer" }, expected: config.expected,
};
const unrelated = {
  ...profile, id: "unrelated", default: true,
  transport: { kind: "local", endpoint: { kind: "unix_socket", path: path.join(root, "unrelated.sock") } },
};
for (const [directory, profiles] of [[backendHome, [profile, unrelated]], [unrelatedHome, [unrelated]]]) {
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "backend-profiles.json"), JSON.stringify({
    schemaVersion: 1, kind: "dure.backend_profiles", profiles,
  }), { mode: 0o600, flag: "wx" });
}
// These deliberately wrong ambient values must lose to the managed route.
entry.env = {
  DURE_HOME: unrelatedHome,
  DURE_BACKEND_PROFILE: "unrelated",
  DURE_ORCHESTRATION_ENDPOINT: "backend-profile:unrelated",
};

if (provider === "claude") {
  fs.writeFileSync(receipt.nativeConfigPath, JSON.stringify(installed), { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, ".claude", "settings.local.json"), JSON.stringify({
    enabledMcpjsonServers: ["dure-orchestration"],
  }), { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ backendHome, digest: receipt.digest, installRoot: receipt.installRoot })}\n`);
  process.exit(0);
}

function inlineToml(value) {
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${inlineToml(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
const executable = path.join(root, "codex-installed-goal");
const override = `mcp_servers=${inlineToml({ "dure-orchestration": entry })}`;
const instructions = `developer_instructions=${inlineToml("This disposable QA conversation must include CONFIG_PRESERVED in its first response. Keep this instruction when Dure adds its conversation context.")}`;
fs.writeFileSync(
  executable,
  `#!/bin/sh\nexec ${shellQuote(config.codex)} -c ${shellQuote(override)} -c ${shellQuote(instructions)} "$@"\n`,
  { mode: 0o700, flag: "wx" },
);
process.stdout.write(
  `${JSON.stringify({ executable, backendHome, digest: receipt.digest, installRoot: receipt.installRoot })}\n`,
);
