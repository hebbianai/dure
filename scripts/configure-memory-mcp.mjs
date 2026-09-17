import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { openCodexClient } from "./lib/codex-stdio-client.mjs";
import { applyMemoryEntry, planMemoryEntry, readUserConfig, verifiedMemoryRelay } from "./lib/memory-mcp-integration.mjs";

const { values } = parseArgs({ options: {
  codex: { type: "string" }, "codex-home": { type: "string" },
  bundle: { type: "string" }, server: { type: "string", default: "memory" },
  apply: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} });
if (values.help) {
  console.log("Usage: pnpm mcp:memory:configure --codex /absolute/codex --codex-home /absolute/.codex --bundle /installed/versions/build-id [--server memory] [--apply]\nPreview is read-only. Apply affects subsequent Agent launches, not existing connections. A private previous-entry.json is retained for version-checked recovery.");
  process.exit(0);
}
for (const name of ["codex", "codex-home", "bundle"]) {
  if (!values[name] || !path.isAbsolute(values[name])) throw new Error(`--${name} requires an absolute path`);
}
const home = fs.realpathSync(values["codex-home"]);
const configPath = path.join(home, "config.toml");
const relay = verifiedMemoryRelay(values.bundle);
const client = await openCodexClient({ executable: values.codex, cwd: home, env: { ...process.env, CODEX_HOME: home } });
try {
  const profile = await readUserConfig(client.call, configPath, home);
  const entry = planMemoryEntry(profile.config.mcp_servers?.[values.server], relay);
  const outcome = values.apply ? await applyMemoryEntry({
    call: client.call, profile, configPath, name: values.server, entry, backupRoot: home,
  }) : { preview: true };
  const after = await readUserConfig(client.call, configPath, home);
  if (values.apply && !isDeepStrictEqual(after.config.mcp_servers[values.server], entry)) {
    throw new Error(`Configuration changed after apply; inspect the current entry and recovery copy ${outcome.backup ?? "(unchanged)"}`);
  }
  console.log(JSON.stringify({ ...outcome, server: values.server, relay, idleMs: 300_000, nextAgentLaunchOnly: true }));
} finally {
  await client.close();
}
