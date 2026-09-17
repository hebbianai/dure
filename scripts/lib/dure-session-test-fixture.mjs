import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FUNCTIONAL_DEADLINE_MS } from "./dure-cli-ssh-fixture.mjs";

export { installRemoteBackendFixture } from "./dure-cli-ssh-fixture.mjs";

const cliPath = fileURLToPath(new URL("../../cli/dure.mjs", import.meta.url));

export function hostGeneration(overrides = {}) {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    runnerPrincipal: "runner",
    runnerInstance: "runner-1",
    channelEpoch: "7",
    hostInstanceId: "host-1",
    terminalEpoch: "terminal-1",
    ...overrides,
  };
}

export function hmuxSession(index = 1, overrides = {}) {
  const sessionId = `session-${index}`;
  const workspaceId = `workspace-${index}`;
  return {
    schema_version: 1,
    session_id: sessionId,
    session_name: `agent-${index}`,
    workspace_id: workspaceId,
    session_class: "managed",
    lifecycle: "ready",
    provider_id: "codex",
    runtime_host: null,
    worktree_alias: null,
    branch: `agent/session-${index}`,
    launch_program: "codex",
    runner_principal: "runner",
    runner_instance: "runner-1",
    channel_epoch: "7",
    host_instance_id: "host-1",
    terminal_epoch: "terminal-1",
    output_seq: "12",
    host_build_version: "0.1.0",
    supported_protocol: {
      minimum: { major: 1, minor: 0 },
      maximum: { major: 1, minor: 0 },
    },
    capabilities: ["provider_conversation_identity_v1"],
    retirement_policy: null,
    host_process: { process_id: 101, start_marker: "host-start-1" },
    provider_process: { process_id: 202, start_marker: "provider-start-1" },
    endpoint: { kind: "unix_socket", address: "/private/runtime.sock" },
    created_unix_ms: "1000",
    lifecycle_changed_unix_ms: "2000",
    exit: null,
    manifestLifecycle: "ready",
    effectiveLifecycle: "ready",
    health: "healthy",
    recoverability: "live_attach",
    workingDirectory: {
      terminal_epoch: "terminal-1",
      observed_through_output_seq: "11",
      path: "/repo/worktree",
      source: "process_inspection",
    },
    providerConversationIdentity: {
      session_id: sessionId,
      workspace_id: workspaceId,
      runner_principal: "runner",
      runner_instance: "runner-1",
      channel_epoch: "7",
      host_instance_id: "host-1",
      terminal_epoch: "terminal-1",
      revision: "3",
      observed_through_output_seq: "11",
      provider_id: "codex",
      conversation_id: "conversation-1",
      source: "provider_event",
    },
    recoveredPresentation: null,
    ...overrides,
  };
}

export function installHmuxStub(
  root,
  payload,
  {
    capabilities = ["bounded_session_catalog_query_v1"],
    status = 0,
    probeBatchStatus = status,
    probeStatuses = {},
    requiredArguments = [],
    markerPath = null,
  } = {},
) {
  const stub = join(root, "hmux-stub.mjs");
  writeFileSync(
    stub,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const markerPath = ${JSON.stringify(markerPath)};
if (markerPath !== null) writeFileSync(markerPath, "executed");
if (args.includes("capabilities")) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 2,
    capabilities: ${JSON.stringify(capabilities)},
  }) + "\\n");
} else {
if (!args.includes("--json") || !args.includes("session")) process.exit(71);
const required = ${JSON.stringify(requiredArguments)};
if (required.some((argument) => !args.includes(argument))) process.exit(72);
const payload = ${JSON.stringify(payload)};
if (args.includes("probe-batch")) {
  const targetsIndex = args.indexOf("--targets-json");
  const targets = JSON.parse(args[targetsIndex + 1]);
  const overrides = ${JSON.stringify(probeStatuses)};
  const results = targets.map((target) => {
    const session = Array.isArray(payload)
      ? payload.find(
          (candidate) =>
            candidate.session_id === target.sessionId &&
            candidate.workspace_id === target.workspaceId,
        )
      : null;
    if (!session) {
      return { ...target, liveness: "dead", status: "not_found" };
    }
    const probeStatus = overrides[target.sessionId] ?? session.health;
    const liveness =
      probeStatus === "healthy"
        ? "alive"
        : ["stale_transport", "incompatible_protocol", "exited"].includes(
              probeStatus,
            )
          ? "dead"
          : "unknown";
    const result = { ...target, liveness, status: probeStatus };
    if (probeStatus !== "unprobed") {
      Object.assign(result, {
        runnerPrincipal: session.runner_principal,
        runnerInstance: session.runner_instance,
        channelEpoch: session.channel_epoch,
        hostInstanceId: session.host_instance_id,
        terminalEpoch: session.terminal_epoch,
      });
    }
    return result;
  });
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      complete: results.every((result) => result.liveness !== "unknown"),
      results,
    }) + "\\n",
    () => process.exit(${probeBatchStatus}),
  );
} else if (
  args.includes("list") &&
  args.includes("--catalog-query-json") &&
  Array.isArray(payload)
) {
  const queryIndex = args.indexOf("--catalog-query-json");
  const query = JSON.parse(args[queryIndex + 1]);
  const identity = (session) =>
    session.workspace_id + "\\u0000" + session.session_id;
  const sessionsByIdentity = new Map(
    payload.map((session) => [identity(session), session]),
  );
  const prioritized = [];
  const prioritizedIdentities = new Set();
  for (const target of query.prioritized) {
    const key = target.workspaceId + "\\u0000" + target.sessionId;
    const session = sessionsByIdentity.get(key);
    if (session) {
      prioritized.push(session);
      prioritizedIdentities.add(key);
    }
  }
  const remaining = payload
    .filter((session) => !prioritizedIdentities.has(identity(session)))
    .sort((left, right) =>
      identity(left) < identity(right) ? -1 : identity(left) > identity(right) ? 1 : 0,
    );
  const selected = [...prioritized, ...remaining].slice(0, query.maxItems);
  const serialize = () =>
    JSON.stringify({
      schemaVersion: 1,
      complete: true,
      prioritizedItems: prioritized.length,
      sessions: selected,
      truncation: {
        items: selected.length < payload.length,
        omittedCount: payload.length - selected.length,
      },
    });
  let document = serialize();
  while (
    Buffer.byteLength(document + "\\n", "utf8") > query.maxOutputBytes &&
    selected.length > prioritized.length
  ) {
    selected.pop();
    document = serialize();
  }
  if (Buffer.byteLength(document + "\\n", "utf8") > query.maxOutputBytes) {
    process.exit(73);
  }
  process.stdout.write(document + "\\n", () => process.exit(${status}));
} else process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)}, () => {
  process.exit(${status});
});
}
`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

export function writeRegistry(root, agents, clientPresentation) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "agents.json"),
    JSON.stringify({ version: 3, updatedAt: Date.now() - 25, agents, clientPresentation }),
    { mode: 0o600 },
  );
}

/** Functional process fixtures keep product defaults covered by pure tests and
 * use an explicit deadline so unrelated full-suite children cannot consume it. */
export function runSessionCli(root, hmux, args, extraEnvironment = {}) {
  const boundedArgs = args.includes("--deadline-ms")
    ? args
    : [...args, "--deadline-ms", String(FUNCTIONAL_DEADLINE_MS)];
  return spawnSync(process.execPath, [cliPath, ...boundedArgs], {
    encoding: "utf8",
    env: {
      PATH: extraEnvironment.PATH ?? process.env.PATH,
      DURE_APP_CHANNEL: "stable",
      DURE_HOME: root,
      DURE_HMUX_BIN: hmux,
      ...extraEnvironment,
    },
  });
}
