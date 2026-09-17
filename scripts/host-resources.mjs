#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_HOST_RESOURCE_POLICY,
  hostResourcePolicyPath,
  hostResourceStatus,
  waitForHostResources,
  writeHostResourcePolicy,
} from "./lib/host-resource-admission.mjs";

const HELP = `Usage: node scripts/host-resources.mjs <status|set|wait> [options]
  status                        Print JSON pressure, policy and admission decision
  set --enabled true|false      Replace policy (omitted thresholds use defaults)
      --max-load-per-core N     Default: 2 (one-minute load / logical cores)
      --memory-ceiling normal|warning  Default: normal; critical always waits
      --poll-ms N               Default: 10000 (1000..60000)
  wait --max-wait-ms N          Wait for resources; 0 (default) waits until cancelled
  --policy /absolute/file.json  Explicit alternative policy (also inherited via
                               DURE_HOST_RESOURCE_POLICY by build/QA commands)
No existing work is stopped. This is a prelaunch pressure check, not a job-slot
reservation or an OS-wide resource cap. Memory observation currently needs macOS.
Example: node scripts/host-resources.mjs wait && <heavy-command>
`;

export async function runHostResourcesCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean" }, policy: { type: "string" }, enabled: { type: "string" },
    "max-load-per-core": { type: "string" }, "memory-ceiling": { type: "string" },
    "poll-ms": { type: "string" }, "max-wait-ms": { type: "string" },
  } });
  if (values.help) return { help: HELP };
  const action = positionals[0];
  if (positionals.length !== 1 || !["status", "set", "wait"].includes(action)) throw new Error(HELP);
  const allowed = action === "set" ? ["enabled", "max-load-per-core", "memory-ceiling", "poll-ms"] :
    action === "wait" ? ["max-wait-ms"] : [];
  if (Object.keys(values).some((key) => !["policy", ...allowed].includes(key))) throw new Error(HELP);
  const policyPath = hostResourcePolicyPath(values.policy ? { DURE_HOST_RESOURCE_POLICY: values.policy } : process.env);
  if (action === "set") {
    if (!["true", "false"].includes(values.enabled)) throw new Error("set requires --enabled true|false");
    if (values.enabled === "true" && process.platform !== "darwin") {
      throw new Error("Enabled host resource admission currently requires the macOS memory-pressure observer");
    }
    const policy = writeHostResourcePolicy({
      ...DEFAULT_HOST_RESOURCE_POLICY,
      enabled: values.enabled === "true",
      maxLoadPerCore: values["max-load-per-core"] === undefined ? 2 : Number(values["max-load-per-core"]),
      memoryPressureCeiling: values["memory-ceiling"] ?? "normal",
      pollIntervalMs: values["poll-ms"] === undefined ? 10_000 : Number(values["poll-ms"]),
    }, policyPath);
    return { policyPath, policy };
  }
  if (action === "status") return hostResourceStatus({ policyPath });
  return waitForHostResources({ policyPath, maxWaitMs: Number(values["max-wait-ms"] ?? 0) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHostResourcesCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(result.help ?? `${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
