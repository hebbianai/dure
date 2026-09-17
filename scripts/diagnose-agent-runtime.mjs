#!/usr/bin/env node

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agentRuntimeConvergenceExitCode,
  collectAgentRuntimeConvergence,
  formatAgentRuntimeConvergence,
} from "../cli/lib/agent-runtime-convergence.mjs";
import {
  loadBackendProfiles,
  selectBackendProfile,
} from "../cli/lib/backend-profiles.mjs";
import { resolveBackendSshReferencesFromEnvironment } from "../cli/lib/backend-ssh-references.mjs";
import { loadSessionClientProjection } from "../cli/lib/session-query.mjs";
import {
  resolveAppChannel,
  validateAppChannel,
} from "./lib/app-channel.mjs";
import { appRoot } from "./lib/dure-home.mjs";

const USAGE =
  "Usage: pnpm diagnose:agent-runtime -- --agent <agent-id|agent:agent-id> " +
  "--source-session <pre-switch-session-id> " +
  "--credential <credential-id> --conversation <conversation-id> " +
  "[--backend <profile-id>] [--channel <app-channel>] [--json]";

function valueAfter(args, option) {
  const value = args.shift();
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function normalizeAgentId(value) {
  return value.startsWith("agent:") ? value.slice("agent:".length) : value;
}

export function parseAgentRuntimeDiagnosticArgs(argv, environment = process.env) {
  const args = [...argv];
  const parsed = {
    agentId: null,
    sourceSessionId: null,
    expectedCredentialId: null,
    expectedConversationId: null,
    backendId: undefined,
    channel: resolveAppChannel(environment),
    json: false,
  };
  while (args.length > 0) {
    const option = args.shift();
    if (option === "--") {
      continue;
    } else if (option === "--agent") {
      parsed.agentId = normalizeAgentId(valueAfter(args, option));
    } else if (option === "--source-session") {
      parsed.sourceSessionId = valueAfter(args, option);
    } else if (option === "--credential") {
      parsed.expectedCredentialId = valueAfter(args, option);
    } else if (option === "--conversation") {
      parsed.expectedConversationId = valueAfter(args, option);
    } else if (option === "--backend") {
      parsed.backendId = valueAfter(args, option);
    } else if (option === "--channel") {
      parsed.channel = validateAppChannel(valueAfter(args, option));
    } else if (option === "--json") {
      parsed.json = true;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  if (
    !parsed.agentId ||
    !parsed.sourceSessionId ||
    !parsed.expectedCredentialId ||
    !parsed.expectedConversationId
  ) {
    throw new Error(USAGE);
  }
  return parsed;
}

function registryPath(channel, environment = process.env) {
  const root = appRoot(environment);
  const controlDirectory =
    channel === "stable" ? root : join(root, "channels", channel);
  return join(controlDirectory, "agents.json");
}

async function runAgentRuntimeDiagnostic(
  options,
  {
    environment = process.env,
    loadProfiles = loadBackendProfiles,
    selectProfile = selectBackendProfile,
    collect = collectAgentRuntimeConvergence,
  } = {},
) {
  const { profile } = selectProfile(loadProfiles({ environment }), {
    explicitId: options.backendId,
    environment,
  });
  const registry = loadSessionClientProjection({
    registryPath: registryPath(options.channel, environment),
    clientId: `app-channel:${options.channel}`,
  });
  return collect({
    agentId: options.agentId,
    sourceSessionId: options.sourceSessionId,
    expectedCredentialId: options.expectedCredentialId,
    expectedConversationId: options.expectedConversationId,
    profile,
    registry,
    transportOptions: {
      resolveSshReferences: (references) =>
        resolveBackendSshReferencesFromEnvironment(references, environment),
    },
  });
}

async function main() {
  const options = parseAgentRuntimeDiagnosticArgs(process.argv.slice(2));
  const report = await runAgentRuntimeDiagnostic(options);
  process.stdout.write(
    `${options.json ? JSON.stringify(report, null, 2) : formatAgentRuntimeConvergence(report)}\n`,
  );
  process.exitCode = agentRuntimeConvergenceExitCode(report);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
