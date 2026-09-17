import { createHash } from "node:crypto";
import { PROVIDERS } from "./contracts/provider-catalog.mjs";
import { inspectCliIdentity } from "./runtime-diagnostics.mjs";

export const PROVIDER_CAPABILITIES_API_VERSION = "dure.provider-capabilities/v1";

const HELP = `Usage: dure providers capabilities [--json]

Print the bundled provider catalog as dure.provider-capabilities/v1 JSON.
This read-only command does not inspect an app, backend, credentials or provider.
Declarations describe product adapters; they do not certify a live runtime tuple.
Use dure version or diagnostics separately to compare installed runtime builds.`;

/** Project declarations only. Backend admission owns actual route availability. */
export function projectProviderCapabilities(catalog = PROVIDERS) {
  return Object.keys(catalog).sort().map((id) => {
    const spec = catalog[id];
    return {
      id,
      label: spec.label,
      command: spec.cmd,
      core: spec.core === true,
      resume: typeof spec.resumeId === "function" ? "exact" : spec.resumeCmd ? "latest_only" : "none",
      conversationList: spec.conversationList ?? "none",
      conversationFork: spec.conversationFork ?? "none",
      accountProfiles: Boolean(spec.configEnv),
      structuredChat: spec.structuredChat === true,
      workflowDelegation: spec.workflowDelegate === true,
    };
  });
}

export function providerCapabilitiesReport(scriptPath) {
  // Only the adjacent source/package identity is relevant. Avoid PATH launcher
  // resolution, which belongs to runtime diagnostics rather than this export.
  const identity = inspectCliIdentity({ scriptPath, environment: { PATH: "" } });
  const providers = projectProviderCapabilities();
  return {
    schemaVersion: 1,
    apiVersion: PROVIDER_CAPABILITIES_API_VERSION,
    kind: "dure.provider_capabilities",
    source: {
      kind: "bundled_catalog",
      packageVersion: identity.packageVersion,
      buildId: identity.buildId,
      installation: identity.installation,
    },
    runtimeObservation: "not_performed",
    catalogFingerprint: `sha256:${createHash("sha256").update(JSON.stringify(providers)).digest("hex")}`,
    providers,
  };
}

export function runProviderCapabilitiesCommand(args, scriptPath) {
  if (args.length === 0 || args.some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (args[0] !== "capabilities" || args.length > 2 || (args[1] !== undefined && args[1] !== "--json")) {
    const error = { code: "provider_capabilities_arguments_invalid", message: HELP };
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, apiVersion: PROVIDER_CAPABILITIES_API_VERSION, error })}\n`);
    } else {
      process.stderr.write(`${HELP}\n`);
    }
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(providerCapabilitiesReport(scriptPath), null, args.includes("--json") ? undefined : 2)}\n`);
}
