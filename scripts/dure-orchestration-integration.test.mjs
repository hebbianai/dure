import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvedOrchestrationIntegrationRefreshProviders,
  inspectOrchestrationIntegrations,
  mutateOrchestrationIntegrations,
  orchestrationPayloadIdentity,
} from "../cli/lib/orchestration-integration.mjs";
import { ORCHESTRATION_PAYLOAD_NAMES } from "../cli/lib/orchestration-integration-bundle.mjs";
import {
  checkpointCursor,
  createOrchestrationRequest,
  loadCursor,
  managedSessionEnrollmentIdempotencyKey,
  requestOrchestration,
  resumeDurableInbox,
} from "../cli/lib/orchestration-client.mjs";
import { requestOrchestrationThroughBackendProfile } from "../cli/lib/orchestration-backend-transport.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import {
  parseOrchestrationInvoke,
  runOrchestrationInvokeFromCli,
} from "../cli/lib/orchestration-command.mjs";
import {
  lifecycleContext,
  lifecycleHookPayload,
  resolveCurrentDispatchContext,
  resolveLifecycleHookPayload,
} from "../cli/lib/orchestration-lifecycle.mjs";
import { handleMcpRequest } from "../cli/lib/orchestration-mcp-server.mjs";
import { artifactDigest } from "../cli/lib/dure-cli-channel-launcher.mjs";
import { parseNextWorkCandidates } from "../cli/lib/orchestration-next-work.mjs";

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../cli/dure.mjs",
);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-orchestration-integration-"));
  roots.push(root);
  return root;
}

function currentMcpContextFixture(root) {
  const receiptPath = path.join(root, "install-receipt.json");
  const capabilities = ["event_cursor_v1", "idempotent_delivery_receipt_v1"];
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      provider: "codex",
      version: "fixture-v1",
      digest: "a".repeat(64),
      channel: "test",
      capabilities,
    }),
  );
  const environment = {
    DURE_HOME: root,
    DURE_BACKEND_PROFILE: "local",
    DURE_ORCHESTRATION_AUTHORIZATION: "Bearer fixture",
    HMUX_SESSION_ID: "worker-session",
    HMUX_WORKSPACE_ID: "runtime-workspace",
    HMUX_RUNNER_PRINCIPAL: "runner-principal",
    HMUX_RUNNER_INSTANCE: "runner-instance",
    HMUX_CHANNEL_EPOCH: "2",
    HMUX_HOST_INSTANCE_ID: "host-instance",
    HMUX_TERMINAL_EPOCH: "terminal-epoch",
  };
  const target = {
    authority: { workspaceId: "runtime-workspace" },
    runId: "run-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    generation: 1,
  };
  const endpointFence = {
    endpointRef: "endpoint-worker",
    sessionIdentity: "session-identity",
    generation: 1,
    deliveryCapability: "capability-delivery",
    acknowledgementCapability: "capability-acknowledgement",
  };
  return {
    receiptPath,
    environment,
    context: {
      schemaVersion: 1,
      target,
      dispatchRevision: 1,
      participant: "participant-worker",
      interactionCapability: "capability-interaction",
      completionCapability: "capability-completion",
      deliveryCapability: "capability-delivery",
      acknowledgementCapability: "capability-acknowledgement",
      endpointFence,
      coordinatorGrant: {
        membershipRef: "membership-owner",
        participant: "participant-owner",
        roles: ["coordinator"],
        capabilities: ["capability-reply"],
        deliveryCapability: "capability-reply",
      },
      coordinatorReplyCapability: "capability-reply",
      integrationReceipt: {
        installRootRef: "install-codex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version: "fixture-v1",
        digest: "a".repeat(64),
        channel: "test",
        capabilities,
      },
    },
  };
}

function completionBody(context, stem, overrides = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: stem,
    messageId: `${stem}-message`,
    target: context.target,
    expectedDispatchRevision: 1,
    completedBy: context.participant,
    endpointFence: context.endpointFence,
    audience: { grants: [context.coordinatorGrant] },
    completionCapability: context.completionCapability,
    title: "Reporting complete",
    resultMarkdown: "The completion is durable.",
    completedAtMs: 1_500,
    ...overrides,
  };
}

function mcpToolCall(name, body, nextWorkCandidates) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: {
        body,
        ...(nextWorkCandidates === undefined ? {} : { nextWorkCandidates }),
      },
    },
  };
}

function nextWorkCandidate(overrides = {}) {
  return {
    id: "unify-lifecycle",
    title: "Remove one lifecycle authority split",
    benefit: "Converge the remaining duplicate runtime writer.",
    concern: "Restart behavior still needs verification.",
    prerequisite: "Revalidate ownership and evidence before starting.",
    conflictSurface: "Session lifecycle.",
    ...overrides,
  };
}

function installedCliFixture(root, buildId = "0.1.4+remote-fixture") {
  const sourceDigest = "b".repeat(64);
  const versionRoot = path.join(root, "cli-payload", "versions", buildId);
  const bin = path.join(versionRoot, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(CLI, path.join(bin, "dure.mjs"));
  fs.cpSync(path.join(path.dirname(CLI), "lib"), path.join(bin, "lib"), {
    recursive: true,
  });
  fs.cpSync(
    path.resolve(path.dirname(CLI), "../orchestration/integration"),
    path.join(bin, "orchestration-integration"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(versionRoot, "install.json"),
    `${JSON.stringify({ schemaVersion: 3, buildId, sourceDigest })}\n`,
  );
  return {
    buildId,
    cli: path.join(bin, "dure.mjs"),
    sourceDigest,
  };
}

function idleWorkerCliFixture(root, buildId, channel = "test") {
  const installed = installedCliFixture(root, buildId);
  const bin = path.dirname(installed.cli);
  const versionRoot = path.dirname(bin);
  fs.cpSync(path.join(path.dirname(CLI), "skills"), path.join(bin, "skills"), { recursive: true });
  const controlPlaneCommand = process.platform === "win32" ? "dure-control-plane.exe" : "dure-control-plane";
  const executable = path.join(bin, controlPlaneCommand);
  fs.writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const catalogue = spawnSync(process.execPath, [path.join(bin, "lib/orchestration-mcp-server.mjs"), "--catalogue"], {
    env: {}, encoding: "utf8", timeout: 10_000,
  });
  expect(catalogue.status, catalogue.stderr).toBe(0);
  fs.writeFileSync(path.join(bin, "orchestration-mcp-catalogue.json"), catalogue.stdout);
  const digest = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  fs.writeFileSync(path.join(versionRoot, "install.json"), JSON.stringify({
    schemaVersion: 3, buildId: installed.buildId, packageVersion: "0.1.4", sourceDigest: installed.sourceDigest,
    command: "dure", controlPlaneCommand,
    compatibilityCommands: ["hebbian-ade", "hebbian-ide"],
    bundle: {
      schemaVersion: 2,
      artifactDigest: artifactDigest(versionRoot),
      app: { schemaVersion: 1, channel },
      controlPlane: { apiVersion: "dure.control-plane/v1", buildId: "dure-control-plane/v1-fixture", digest, capabilities: ["mcp_stdio_idle_worker_v1"] },
      orchestration: orchestrationPayloadIdentity(installed.cli),
      hmux: {
        schemaVersion: 1, channel, buildId: "hmux-fixture",
        executablePath: executable, runtimeExecutablePath: executable,
        executableDigest: digest, runtimeExecutableDigest: digest,
      },
    },
  }));
  // The launcher owns the complete immutable bundle contract, including its
  // bound executable hashes; the fixture never executes a real backend.
  return { ...installed, cli: fs.realpathSync(installed.cli), executable: fs.realpathSync(executable) };
}

function sshWorkerFixture(
  root,
  {
    capabilities = ["orchestration.invoke"],
    observedGeneration = "remote-generation-1",
    remoteError,
    deliveryFileDelta = 0,
  } = {},
) {
  const localHome = path.join(root, "local-home");
  const remoteHome = path.join(root, "remote-home");
  const bin = path.join(root, "bin");
  const disconnectMarker = path.join(root, "disconnect-once");
  const remoteLog = path.join(root, "remote-result.json");
  const sshLog = path.join(root, "ssh-argv.jsonl");
  const knownHostsFile = path.join(root, "known-hosts");
  fs.mkdirSync(localHome, { recursive: true });
  fs.mkdirSync(remoteHome, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "ssh"),
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
appendFileSync(process.env.DURE_TEST_SSH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const trustOption = process.argv.find(value => value.startsWith("UserKnownHostsFile="));
const trustPath = trustOption.slice("UserKnownHostsFile=".length);
if (readFileSync(trustPath, "utf8") !== "worker.example.test ssh-ed25519 fixture\\n") {
  process.exit(91);
}
const input = readFileSync(0);
const source = input.toString("utf8");
if (source.trimStart().startsWith("{")) {
  const request = JSON.parse(source);
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    apiVersion: "dure.backend-transport/v1",
    kind: ${JSON.stringify(remoteError ? "dure.backend.error" : "dure.backend.response")},
    requestId: request.requestId,
    backend: {
      id: "dure-remote",
      generation: ${JSON.stringify(observedGeneration)},
      protocol: { major: 1, minor: 0 },
      capabilities: ${JSON.stringify(capabilities)},
      observedAtMs: Date.now(),
    },
    ...${JSON.stringify(remoteError ? { error: remoteError } : { result: { schemaVersion: 1, status: "ready" } })},
  }));
  process.exit(0);
}
const bootstrapInput = ${deliveryFileDelta} === 0 ? input : Buffer.from(source.replace(
  "if (archive?.schemaVersion",
  (${deliveryFileDelta} < 0 ? "archive.files.pop();" : "archive.files.push({ path: 'unexpected', content: '' });") + "\\nif (archive?.schemaVersion",
));
const result = spawnSync("/bin/sh", ["-s"], {
  input: bootstrapInput,
  env: { ...process.env, HOME: process.env.DURE_TEST_REMOTE_HOME },
  maxBuffer: 1024 * 1024,
});
writeFileSync(process.env.DURE_TEST_REMOTE_LOG, JSON.stringify({
  status: result.status,
  stdout: result.stdout?.toString(),
  stderr: result.stderr?.toString(),
}));
if (result.stderr?.length) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(process.env.DURE_TEST_DISCONNECT_MARKER)) {
  writeFileSync(process.env.DURE_TEST_DISCONNECT_MARKER, "applied\\n");
  process.exit(41);
}
process.stdout.write(result.stdout);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    knownHostsFile,
    "worker.example.test ssh-ed25519 fixture\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(root, "backend-profiles.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "dure.backend_profiles",
        profiles: [
          {
            id: "ssh-worker",
            default: true,
            transport: {
              kind: "ssh",
              host: "worker.example.test",
              port: 22,
              user: "worker",
              endpoint: { kind: "tcp", host: "127.0.0.1", port: 4317 },
              batchMode: true,
              strictHostKeyChecking: "yes",
              connectTimeoutMs: 1_000,
            },
            auth: { kind: "ssh_agent" },
            trust: {
              kind: "known_hosts",
              reference: "known-hosts-profile:ssh-worker",
            },
            expected: {
              backendId: "dure-remote",
              generation: "remote-generation-1",
              protocol: {
                minimum: { major: 1, minor: 0 },
                maximum: { major: 1, minor: 0 },
              },
              capabilities,
            },
            deadlineMs: 10_000,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return {
    disconnectMarker,
    localHome,
    remoteHome,
    environment: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: localHome,
      DURE_HOME: root,
      DURE_APP_CHANNEL: "stable",
      DURE_BACKEND_SSH_REFERENCE_PROFILE: "ssh-worker",
      DURE_BACKEND_KNOWN_HOSTS_FILE: knownHostsFile,
      DURE_TEST_REMOTE_HOME: remoteHome,
      DURE_TEST_DISCONNECT_MARKER: disconnectMarker,
      DURE_TEST_REMOTE_LOG: remoteLog,
      DURE_TEST_SSH_LOG: sshLog,
    },
    remoteLog,
    sshLog,
  };
}

describe("immutable generic orchestration integration", () => {
  it.each(["codex", "claude"])("refreshes an intact older %s payload when the new bundle adds a file", (provider) => {
    const root = fixture();
    const legacy = installedCliFixture(root, "0.1.4+retained-worker");
    const candidate = idleWorkerCliFixture(root, "0.1.4+retained-upgrade");
    const options = {
      provider, homeDirectory: path.join(root, "provider-home"),
      global: true, channel: "dev-daily",
    };
    const installed = mutateOrchestrationIntegrations({
      ...options, action: "install", approval: true, cliScriptPath: legacy.cli,
    })[0];
    // This module was not part of the preceding payload. Recreate that exact
    // older file set and receipt, not an accidentally damaged current install.
    const retainedNames = ORCHESTRATION_PAYLOAD_NAMES.filter(
      (name) => name !== "dure-cli-channel-launcher.mjs",
    );
    fs.unlinkSync(path.join(installed.installRoot, "dure-cli-channel-launcher.mjs"));
    const digest = createHash("sha256");
    for (const name of retainedNames) {
      digest.update(`${name}\0`).update(fs.readFileSync(path.join(installed.installRoot, name))).update("\0");
    }
    const receiptPath = path.join(installed.installRoot, "install-receipt.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const previousDigest = receipt.digest;
    receipt.digest = digest.digest("hex");
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    if (provider === "codex") {
      fs.writeFileSync(installed.nativeConfigPath,
        fs.readFileSync(installed.nativeConfigPath, "utf8").replace(`# digest: ${previousDigest}`, `# digest: ${receipt.digest}`));
    }
    const upgrade = { ...options, cliScriptPath: candidate.cli };
    expect(inspectOrchestrationIntegrations(upgrade)[0].status).toBe("outdated");
    expect(approvedOrchestrationIntegrationRefreshProviders(upgrade)).toEqual([provider]);
    mutateOrchestrationIntegrations({ ...upgrade, action: "refresh" });
    expect(inspectOrchestrationIntegrations(upgrade)[0].status).toBe("current");

    // A file missing from a receipt that did include it is still damage. Do
    // not turn the legacy-layout correction into permission to auto-repair it.
    fs.unlinkSync(path.join(installed.installRoot, "orchestration-client.mjs"));
    expect(approvedOrchestrationIntegrationRefreshProviders(upgrade)).toEqual([]);
    expect(() => mutateOrchestrationIntegrations({ ...upgrade, action: "refresh" }))
      .toThrow("not safe to refresh automatically");
  });

  it.each(["codex", "claude"])("offers an approved %s idle-worker upgrade without development-channel update churn", (provider) => {
    const root = fixture();
    const legacy = installedCliFixture(root, "0.1.4+legacy-worker");
    const candidate = idleWorkerCliFixture(root, "0.1.4+idle-upgrade");
    const nextCandidate = idleWorkerCliFixture(root, "0.1.4+idle-later");
    const options = {
      provider, homeDirectory: path.join(root, "provider-home"),
      global: true, channel: "dev-daily",
    };
    mutateOrchestrationIntegrations({ ...options, action: "install", approval: true, cliScriptPath: legacy.cli });
    expect(inspectOrchestrationIntegrations({ ...options, cliScriptPath: candidate.cli })[0].status)
      .toBe("outdated");
    mutateOrchestrationIntegrations({ ...options, action: "refresh", cliScriptPath: candidate.cli });
    expect(inspectOrchestrationIntegrations({ ...options, cliScriptPath: candidate.cli })[0].status)
      .toBe("current");
    // Once the transport supports idle retirement, another compatible dev
    // bundle must not demand a replacement just because its version differs.
    for (const installed of [legacy, nextCandidate]) {
      expect(inspectOrchestrationIntegrations({ ...options, channel: "dev-other", cliScriptPath: installed.cli })[0].status)
        .toBe("current");
    }
  });

  it("refuses malformed installed worker capability metadata before changing provider configuration", () => {
    const root = fixture();
    const installed = idleWorkerCliFixture(root, "0.1.4+idle-metadata");
    const options = {
      provider: "codex", homeDirectory: path.join(root, "provider-home"),
      global: true, approval: true, channel: "test", cliScriptPath: installed.cli,
    };
    mutateOrchestrationIntegrations({ ...options, action: "install" });
    const configPath = path.join(options.homeDirectory, ".codex/config.toml");
    const before = fs.readFileSync(configPath);
    const metadataPath = path.join(path.dirname(path.dirname(installed.cli)), "install.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    for (const capabilities of ["mcp_stdio_idle_worker_v1", null, ["mcp_stdio_idle_worker_v1", 3]]) {
      metadata.bundle.controlPlane.capabilities = capabilities;
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      expect(() => mutateOrchestrationIntegrations({ ...options, action: "update" }))
        .toThrow("MCP worker capabilities are invalid");
      expect(fs.readFileSync(configPath)).toEqual(before);
    }
  });

  it.each(["codex", "claude"])("keeps %s idle-worker code and receipts version-bound across updates", (provider) => {
    const root = fixture();
    const first = idleWorkerCliFixture(root, "0.1.4+idle-one");
    const second = idleWorkerCliFixture(root, "0.1.4+idle-two");
    const homeDirectory = path.join(root, "provider-home");
    fs.mkdirSync(path.join(homeDirectory, ".codex"), { recursive: true });
    const configPath = provider === "codex"
      ? path.join(homeDirectory, ".codex/config.toml")
      : path.join(homeDirectory, ".claude.json");
    const unrelated = provider === "codex"
      ? '[mcp_servers.keep]\ncommand = "untouched"\nargs = []\n'
      : JSON.stringify({ mcpServers: { keep: { command: "untouched", args: [] } } });
    fs.writeFileSync(configPath, unrelated);
    const options = { provider, homeDirectory, global: true, approval: true, channel: "test" };
    const readEntry = () => {
      const source = fs.readFileSync(configPath, "utf8");
      if (provider === "claude") return JSON.parse(source).mcpServers["dure-orchestration"];
      const block = source.split("# BEGIN DURE ORCHESTRATION MCP")[1];
      return {
        command: JSON.parse(/^command = (.*)$/mu.exec(block)[1]),
        args: JSON.parse(/^args = (.*)$/mu.exec(block)[1]),
      };
    };
    mutateOrchestrationIntegrations({ ...options, action: "install", cliScriptPath: first.cli });
    const original = readEntry();
    expect(original.command).toBe(first.executable);
    expect(original.args[0]).toBe("mcp-stdio-relay");
    const argument = (entry, key) => entry.args[entry.args.indexOf(key) + 1];
    expect(argument(original, "--worker")).toBe(path.join(path.dirname(first.cli), "lib/orchestration-mcp-server.mjs"));
    expect(JSON.parse(argument(original, "--receipt-json")).version).toBe(first.buildId);
    const originalWorker = fs.readFileSync(argument(original, "--worker"));
    mutateOrchestrationIntegrations({ ...options, action: "update", cliScriptPath: second.cli });
    const updated = readEntry();
    expect(updated.command).toBe(second.executable);
    expect(JSON.parse(argument(updated, "--receipt-json")).version).toBe(second.buildId);
    expect(fs.readFileSync(argument(original, "--worker"))).toEqual(originalWorker);
    expect(inspectOrchestrationIntegrations({ ...options, cliScriptPath: second.cli })[0].status).toBe("current");
    if (provider === "codex") expect(fs.readFileSync(configPath, "utf8")).toContain(unrelated);
    else expect(JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers.keep).toEqual({ command: "untouched", args: [] });

    const before = fs.readFileSync(configPath);
    fs.appendFileSync(argument(updated, "--catalogue"), "\n");
    expect(() => mutateOrchestrationIntegrations({ ...options, action: "update", cliScriptPath: second.cli })).toThrow("immutable bundle digest");
    expect(fs.readFileSync(configPath)).toEqual(before);

    // Removing the integration does not need to execute its damaged bundle,
    // remove retained worker versions, or touch an unrelated MCP server.
    mutateOrchestrationIntegrations({ ...options, action: "uninstall", cliScriptPath: second.cli });
    if (provider === "codex") {
      expect(fs.readFileSync(configPath, "utf8").trim()).toBe(unrelated.trim());
    } else {
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers).toEqual({
        keep: { command: "untouched", args: [] },
      });
    }
    expect(fs.readFileSync(argument(original, "--worker"))).toEqual(originalWorker);
    expect(fs.existsSync(argument(updated, "--worker"))).toBe(true);
  });

  it("keeps managed Session enrollment identity stable across app and payload clients", () => {
    const session = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      providerId: "codex",
      runnerPrincipal: "runner",
      runnerInstance: "instance",
      channelEpoch: "channel",
      hostInstanceId: "host",
      terminalEpoch: "terminal",
    };
    const receipt = {
      installRootRef: `install-codex-${"a".repeat(32)}`,
      version: "0.1.4+fixture",
      digest: "a".repeat(64),
      channel: "test",
      capabilities: [
        "event_cursor_v1",
        "idempotent_delivery_receipt_v1",
        "interaction_message_v1",
        "interaction_decision_v1",
        "mcp_stdio_v1",
      ],
    };
    const initial = managedSessionEnrollmentIdempotencyKey(session, receipt);
    const successor = managedSessionEnrollmentIdempotencyKey(session, receipt, {
      dispatchId: "dispatch.completed-1",
      generation: 1,
    });

    expect(initial).toBe(
      "run-da02bbe437b6a8a7ac9901bbcaaca0891e375c78fc0955185e6eab7a88cbe18b",
    );
    expect(successor).not.toBe(initial);
  });

  it("reports provider-specific lifecycle actions for the settings UI", () => {
    const root = fixture();
    const output = spawnSync(process.execPath, [CLI, "doctor", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        DURE_HOME: path.join(root, ".dure"),
        DURE_APP_CHANNEL: "test",
      },
    });
    expect(output.status, output.stderr).toBe(0);
    const report = JSON.parse(output.stdout);
    const integration = report.dependencies.find(
      (dependency) => dependency.id === "orchestration-integration",
    );
    expect(integration.details).toHaveLength(2);
    for (const detail of integration.details) {
      expect(detail.installRootRef).toBeNull();
      expect(detail.fixCommand).toBe(
        `dure integration install --global --provider ${detail.provider} --approve-global-config`,
      );
      expect(detail.updateCommand).toBe(
        `dure integration update --global --provider ${detail.provider} --approve-global-config`,
      );
      expect(detail.uninstallCommand).toBe(
        `dure integration uninstall --global --provider ${detail.provider} --approve-global-config`,
      );
      expect(detail.refreshCommand).toBeNull();
    }
  });

  it("shares one compatible global integration across development channels", () => {
    const root = fixture();
    const installedCli = installedCliFixture(root);
    mutateOrchestrationIntegrations({
      action: "install",
      cliScriptPath: installedCli.cli,
      channel: "dev-newer",
      homeDirectory: root,
      global: true,
      approval: true,
    });
    const installIdentityPath = path.join(
      path.dirname(path.dirname(installedCli.cli)),
      "install.json",
    );
    fs.writeFileSync(
      installIdentityPath,
      `${JSON.stringify({
        schemaVersion: 3,
        buildId: installedCli.buildId,
        sourceDigest: "c".repeat(64),
      })}\n`,
    );

    const status = inspectOrchestrationIntegrations({
      cliScriptPath: installedCli.cli,
      channel: "dev-daily",
      homeDirectory: root,
      global: true,
    });

    expect(status.every((receipt) => receipt.status === "current")).toBe(true);
  });

  it("refreshes an exact stable integration without repeated approval", () => {
    const root = fixture();
    const installedCli = idleWorkerCliFixture(root, undefined, "stable");
    const environment = {
      ...process.env,
      HOME: root,
      DURE_HOME: path.join(root, ".dure"),
      DURE_APP_CHANNEL: "stable",
    };
    const installed = spawnSync(
      process.execPath,
      [
        installedCli.cli,
        "integration",
        "install",
        "--global",
        "--provider",
        "codex",
        "--approve-global-config",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: environment },
    );
    expect(installed.status, installed.stderr).toBe(0);

    const installIdentityPath = path.join(
      path.dirname(path.dirname(installedCli.cli)),
      "install.json",
    );
    fs.writeFileSync(
      installIdentityPath,
      `${JSON.stringify({
        ...JSON.parse(fs.readFileSync(installIdentityPath, "utf8")),
        sourceDigest: "c".repeat(64),
      })}\n`,
    );

    const doctor = spawnSync(process.execPath, [installedCli.cli, "doctor", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });
    expect(doctor.status, doctor.stderr).toBe(0);
    const detail = JSON.parse(doctor.stdout)
      .dependencies.find((dependency) => dependency.id === "orchestration-integration")
      .details.find((candidate) => candidate.provider === "codex");
    expect(detail).toMatchObject({
      status: "outdated",
      refreshCommand: "dure integration refresh --global --provider codex",
    });

    const refreshed = spawnSync(
      process.execPath,
      [
        installedCli.cli,
        "integration",
        "refresh",
        "--global",
        "--provider",
        "codex",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: environment },
    );
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(JSON.parse(refreshed.stdout).receipts[0]).toMatchObject({
      provider: "codex",
      status: "current",
      version: installedCli.buildId,
      cliDigest: "c".repeat(64),
      globalConfigurationApproved: true,
    });
  });

  it("refuses approved refresh after provider configuration ownership changes", () => {
    const root = fixture();
    const installedCli = idleWorkerCliFixture(root);
    const environment = {
      ...process.env,
      HOME: root,
      DURE_HOME: path.join(root, ".dure"),
      DURE_APP_CHANNEL: "test",
    };
    const installed = spawnSync(
      process.execPath,
      [
        installedCli.cli,
        "integration",
        "install",
        "--global",
        "--provider",
        "codex",
        "--approve-global-config",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: environment },
    );
    expect(installed.status, installed.stderr).toBe(0);
    const configPath = path.join(root, ".codex", "config.toml");
    const changed = fs
      .readFileSync(configPath, "utf8")
      .replace("orchestration-mcp-server.mjs", "unowned-server.mjs");
    fs.writeFileSync(configPath, changed);
    const payloadPath = path.join(root, ".codex", "dure", "orchestration", "mcp.json");
    const payloadBefore = fs.readFileSync(payloadPath);

    const refreshed = spawnSync(
      process.execPath,
      [
        installedCli.cli,
        "integration",
        "refresh",
        "--global",
        "--provider",
        "codex",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: environment },
    );
    expect(refreshed.status).not.toBe(0);
    expect(refreshed.stderr).toContain("previously approved integration");
    expect(fs.readFileSync(configPath, "utf8")).toBe(changed);
    expect(fs.readFileSync(payloadPath)).toEqual(payloadBefore);
  });

  it("does not reuse approval across channel or capability boundaries", () => {
    const root = fixture();
    const [installed] = mutateOrchestrationIntegrations({
      action: "install",
      cliScriptPath: CLI,
      channel: "stable",
      homeDirectory: root,
      global: true,
      approval: true,
      provider: "claude",
    });
    const payloadPath = path.join(installed.installRoot, "mcp.json");
    const payloadBefore = fs.readFileSync(payloadPath);

    expect(() =>
      mutateOrchestrationIntegrations({
        action: "refresh",
        cliScriptPath: CLI,
        channel: "replacement-channel",
        homeDirectory: root,
        global: true,
        approval: false,
        provider: "claude",
      }),
    ).toThrow(/previously approved integration/);

    const receiptPath = path.join(installed.installRoot, "install-receipt.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    receipt.capabilities = receipt.capabilities.slice(0, -1);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() =>
      mutateOrchestrationIntegrations({
        action: "refresh",
        cliScriptPath: CLI,
        channel: "stable",
        homeDirectory: root,
        global: true,
        approval: false,
        provider: "claude",
      }),
    ).toThrow(/previously approved integration/);
    expect(fs.readFileSync(payloadPath)).toEqual(payloadBefore);
  });

  it("requires approval before any global provider mutation", () => {
    const root = fixture();
    expect(() =>
      mutateOrchestrationIntegrations({
        action: "install",
        cliScriptPath: CLI,
        channel: "test",
        homeDirectory: root,
        global: true,
        approval: false,
      }),
    ).toThrow(/approve-global-config/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("provisions one shared payload through Codex and Claude adapters with typed receipts", () => {
    const root = fixture();
    const receipts = mutateOrchestrationIntegrations({
      action: "install",
      cliScriptPath: CLI,
      channel: "dev-pane",
      homeDirectory: root,
      global: true,
      approval: true,
      transportRef: "authenticated-control-channel:test",
    });
    expect(receipts.map((receipt) => receipt.provider)).toEqual(["claude", "codex"]);
    expect(new Set(receipts.map((receipt) => receipt.digest)).size).toBe(1);
    expect(receipts.every((receipt) => receipt.status === "current")).toBe(true);
    expect(receipts.every((receipt) => receipt.globalConfigurationApproved)).toBe(true);
    expect(receipts.every((receipt) => receipt.channel === "dev-pane")).toBe(true);
    expect(
      receipts.every(
        (receipt) => receipt.transportRef === "authenticated-control-channel:test",
      ),
    ).toBe(true);
    expect(receipts.every((receipt) => !("adapter" in receipt))).toBe(true);
    for (const receipt of receipts) {
      expect(receipt.installRoot.startsWith(fs.realpathSync(root))).toBe(true);
      expect(receipt.installRootRef).toMatch(
        new RegExp(`^install-${receipt.provider}-[a-f0-9]{32}$`),
      );
      expect(receipt.version).toBe("source");
      expect(receipt.capabilities).toContain("event_cursor_v1");
      expect(fs.readFileSync(path.join(receipt.installRoot, "mcp.json"), "utf8")).toContain(
        "dure.orchestration/v1",
      );
      expect(
        fs.existsSync(path.join(receipt.installRoot, "orchestration-lifecycle.mjs")),
      ).toBe(true);
      expect(fs.readFileSync(path.join(receipt.skillRoot, "SKILL.md"), "utf8")).toContain(
        "never infer it from terminal text",
      );
      const installedClient = spawnSync(process.execPath, [
        "--input-type=module", "--eval", `
          import { pathToFileURL } from "node:url";
          const client = await import(pathToFileURL(process.argv[1]));
          const request = client.createOrchestrationRequest({
            method: "events.read", body: { after: 14, limit: 10 },
          });
          const response = await client.requestOrchestration("fixture", request, {
            transportImplementation: async (_endpoint, value) => ({
              apiVersion: value.apiVersion, method: value.method,
              receipt: { after: value.body.after },
            }),
          });
          process.stdout.write(JSON.stringify(response.receipt));
        `,
        path.join(receipt.installRoot, "orchestration-client.mjs"),
      ], { cwd: root, encoding: "utf8" });
      expect(installedClient.status, installedClient.stderr).toBe(0);
      expect(JSON.parse(installedClient.stdout)).toEqual({ after: 14 });
      const installedServer = spawnSync(process.execPath, [
        path.join(receipt.installRoot, "orchestration-mcp-server.mjs"),
      ], { cwd: root, encoding: "utf8", input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n` });
      expect(installedServer.status, installedServer.stderr).toBe(0);
      expect(JSON.parse(installedServer.stdout).result.tools.map((tool) => tool.name)).toContain("app_pane_act");
    }
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(root, ".claude.json"), "utf8"));
    expect(claudeConfig.mcpServers["dure-orchestration"].args[0]).toBe(
      path.join(receipts[0].installRoot, "orchestration-mcp-server.mjs"),
    );
    expect(fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8")).toContain(
      `[mcp_servers.dure-orchestration]\ncommand = ${JSON.stringify(process.execPath)}`,
    );
    for (const provider of ["claude", "codex"]) {
      const hookFile = provider === "claude" ? "settings.json" : "hooks.json";
      const hooks = JSON.parse(
        fs.readFileSync(path.join(root, `.${provider}`, hookFile), "utf8"),
      );
      expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
        "orchestration-lifecycle.mjs",
      );
    }
    expect(
      inspectOrchestrationIntegrations({
        cliScriptPath: CLI,
        channel: "dev-pane",
        homeDirectory: root,
        global: true,
      }).every((receipt) => receipt.status === "current"),
    ).toBe(true);
    expect(
      inspectOrchestrationIntegrations({
        cliScriptPath: CLI,
        channel: "dev-pane",
        homeDirectory: root,
        global: true,
        transportRef: "authenticated-control-channel:replacement",
      }).every((receipt) => receipt.status === "outdated"),
    ).toBe(true);
  });

  it.each(["source", "installed", "repaired"])("runs installed lifecycle and MCP entrypoints from the %s CLI", (source) => {
    const root = fixture();
    const cliScriptPath = source === "source" ? CLI : installedCliFixture(root).cli;
    const options = {
      cliScriptPath,
      channel: "test",
      homeDirectory: root,
      global: true,
      approval: true,
    };
    let receipts = mutateOrchestrationIntegrations({ ...options, action: "install" });
    if (source === "repaired") {
      for (const receipt of receipts) {
        for (const name of ["backend-capabilities.mjs", "backend-capability-limit.json"]) {
          fs.unlinkSync(path.join(receipt.installRoot, name));
        }
        expect(() => mutateOrchestrationIntegrations({
          ...options, action: "refresh", provider: receipt.provider, approval: false,
        })).toThrow(/previously approved integration/);
      }
      receipts = mutateOrchestrationIntegrations({ ...options, action: "update" });
    }
    for (const receipt of receipts) {
      const environment = {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        CODEX_HOME: path.join(root, ".codex"),
        DURE_HOME: path.join(root, ".dure"),
        DURE_APP_CHANNEL: "test",
        HMUX_DISCOVERY_ROOT: path.join(root, "discovery"),
        DURE_ORCHESTRATION_PARTICIPANT: "participant-fixture",
        DURE_ORCHESTRATION_ENDPOINT_REF: "endpoint-fixture",
        DURE_ORCHESTRATION_SESSION_IDENTITY: "session-fixture",
        DURE_ORCHESTRATION_GENERATION: "1",
        DURE_ORCHESTRATION_CHECKPOINT: path.join(root, "cursor.json"),
      };
      const hook = spawnSync(process.execPath, [
        path.join(receipt.installRoot, "orchestration-lifecycle.mjs"),
        "--event", "session_start",
      ], {
        cwd: root,
        env: environment,
        encoding: "utf8",
        input: JSON.stringify({ hook_event_name: "SessionStart" }),
      });
      expect(hook.status, hook.stderr).toBe(0);
      expect(JSON.parse(hook.stdout)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: expect.stringContaining("participant-fixture"),
        },
      });

      const server = spawnSync(process.execPath, [
        path.join(receipt.installRoot, "orchestration-mcp-server.mjs"),
      ], {
        cwd: root,
        env: environment,
        encoding: "utf8",
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
      });
      expect(server.status, server.stderr).toBe(0);
      expect(JSON.parse(server.stdout)).toMatchObject({
        id: 1,
        result: { serverInfo: { name: "dure-orchestration" } },
      });
    }
  });

  it("installs one newcomer-readable completion report contract for every provider", () => {
    const root = fixture();
    const receipts = mutateOrchestrationIntegrations({
      action: "install",
      cliScriptPath: CLI,
      channel: "dev-pane",
      homeDirectory: root,
      global: true,
      approval: true,
    });
    const installedSkills = receipts.map((receipt) =>
      fs.readFileSync(path.join(receipt.skillRoot, "SKILL.md"), "utf8"),
    );

    expect(new Set(installedSkills).size).toBe(1);
    const [skill] = installedSkills;
    expect(skill).toContain("Write for someone who did not follow the work");
    expect(skill).toContain("Before any heading or list");
    expect(skill).toContain("user- or operator-visible outcome");
    expect(skill).toContain("Never lead with an issue ID");

    const outcome = skill.indexOf("What changed and how to use it");
    const evidence = skill.indexOf("Verification, with source-labeled evidence");
    const risk = skill.indexOf("Honest limitations, remaining risk");
    const nextWork = skill.indexOf("Prioritized next work when useful");
    expect(outcome).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(outcome);
    expect(risk).toBeGreaterThan(evidence);
    expect(nextWork).toBeGreaterThan(risk);
    const normalizedSkill = skill.replaceAll(/\s+/gu, " ");
    expect(normalizedSkill).toContain(
      "Collaboration subagents return recommendations to that coordinator",
    );
    expect(normalizedSkill).toContain(
      "commit the user's choice with `orchestration_decision_answer`",
    );
    expect(normalizedSkill).toContain(
      "If the user selects `stop`, do not claim or start more work",
    );
  });

  it("uninstalls only its owned payload and provider entry", () => {
    const root = fixture();
    const [installed] = mutateOrchestrationIntegrations({
      action: "install",
      cliScriptPath: CLI,
      channel: "stable",
      homeDirectory: root,
      global: true,
      approval: true,
      provider: "codex",
    });
    const configPath = path.join(root, ".codex", "config.toml");
    fs.appendFileSync(configPath, '\n[mcp_servers.unrelated]\ncommand = "other"\n');
    const [removed] = mutateOrchestrationIntegrations({
      action: "uninstall",
      cliScriptPath: CLI,
      channel: "stable",
      homeDirectory: root,
      global: true,
      approval: true,
      provider: "codex",
    });
    expect(removed.status).toBe("removed");
    expect(removed.scope).toBe("global");
    expect(removed.globalConfigurationApproved).toBe(true);
    expect(fs.existsSync(installed.installRoot)).toBe(false);
    const remaining = fs.readFileSync(configPath, "utf8");
    expect(remaining).toContain("[mcp_servers.unrelated]");
    expect(remaining).not.toContain("[mcp_servers.dure-orchestration]");
  });

  it("refuses provider ownership conflicts without changing payload or config", () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    const configPath = path.join(root, ".codex", "config.toml");
    const original = '[mcp_servers.dure-orchestration]\ncommand = "unrelated"\n';
    fs.writeFileSync(configPath, original);
    expect(() =>
      mutateOrchestrationIntegrations({
        action: "install",
        cliScriptPath: CLI,
        channel: "stable",
        homeDirectory: root,
        global: true,
        approval: true,
        provider: "codex",
      }),
    ).toThrow(/already owned/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(root, ".codex", "dure", "orchestration"))).toBe(false);
  });

  it("stages the identical payload at an explicit worker root and preserves cursor recovery", () => {
    const root = fixture();
    const workerRoot = path.join(root, "worker-payload");
    const [receipt] = mutateOrchestrationIntegrations({
      action: "install",
      cliScriptPath: CLI,
      channel: "stable",
      homeDirectory: root,
      workspaceRoot: root,
      installRoot: workerRoot,
      provider: "codex",
      global: false,
      approval: false,
      transportRef: "reverse-forwarded-loopback:test",
    });
    expect(receipt.installRoot).toBe(
      fs.realpathSync(path.join(workerRoot, "payloads", "codex")),
    );
    expect(receipt.transportRef).toBe("reverse-forwarded-loopback:test");
    expect(fs.existsSync(path.join(root, ".codex", "config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".claude.json"))).toBe(false);
    expect(
      fs.existsSync(path.join(workerRoot, "provider", "codex", "mcp-servers.json")),
    ).toBe(true);

    const checkpoint = path.join(root, "state", "cursor.json");
    expect(loadCursor(checkpoint)).toBe(0);
    checkpointCursor(checkpoint, 14, "delivery-14");
    expect(loadCursor(checkpoint)).toBe(14);
    expect(() => checkpointCursor(checkpoint, 13, "delivery-13")).toThrow(/move backwards/);
    expect(
      createOrchestrationRequest({
        method: "events.read",
        body: {
          schemaVersion: 1,
          authority: { workspaceId: "workspace-1" },
          participant: "participant-worker",
          endpointFence: {
            sessionIdentity: "session-1",
            generation: 7,
            deliveryCapability: "capability-delivery",
            acknowledgementCapability: "capability-ack",
          },
          after: loadCursor(checkpoint),
          limit: 10,
        },
      }),
    ).toMatchObject({
      apiVersion: "dure.orchestration/v1",
      method: "events.read",
      body: { after: 14 },
    });
  });

  it("routes managed goal tools to the executing backend and preserves an explicit CLI target", async () => {
    const home = fixture();
    const ambientHome = fixture();
    const local = {
      id: "local", default: false,
      transport: { kind: "local", endpoint: { kind: "unix_socket", path: path.join(home, "local.sock") } },
      auth: { kind: "peer" }, trust: { kind: "local_peer" },
      expected: {
        backendId: "dure-local", generation: "generation-local",
        protocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
        capabilities: ["orchestration.invoke"],
      },
    };
    const unrelated = { ...local, id: "unrelated", default: true };
    for (const [root, profiles] of [[home, [local, unrelated]], [ambientHome, [unrelated]]]) {
      fs.writeFileSync(path.join(root, "backend-profiles.json"), JSON.stringify({
        schemaVersion: 1, kind: "dure.backend_profiles", profiles,
      }), { mode: 0o600 });
    }
    const environment = {
      DURE_ORCHESTRATION_HOME: home, DURE_HOME: ambientHome,
      DURE_BACKEND_PROFILE: "unrelated",
      DURE_ORCHESTRATION_ENDPOINT: "https://ambient.example.invalid/orchestration",
    };
    const observed = [];
    const request = (endpoint, semantic, options) => requestOrchestrationThroughBackendProfile(endpoint, semantic, {
      ...options,
      performRequest: async (profile, operation) => {
        observed.push({ profile: profile.id, method: operation.body.method });
        return { result: { receipt: { schemaVersion: 1, goal: null } } };
      },
    });
    await handleMcpRequest({
      jsonrpc: "2.0", method: "tools/call", params: {
        name: "agent_goal_get", arguments: { body: { schemaVersion: 1, agentId: "agent-here" } },
      },
    }, environment, { request });
    for (const backend of [undefined, "unrelated"]) {
      await runOrchestrationInvokeFromCli({
        arguments_: ["agent_goal.get", JSON.stringify({ schemaVersion: 1, agentId: "agent-here" })],
        environment, backend, backendSpecified: backend !== undefined, request, output: () => {},
      });
    }
    expect(observed).toEqual([
      { profile: "local", method: "agent_goal.get" },
      { profile: "local", method: "agent_goal.get" },
      { profile: "unrelated", method: "agent_goal.get" },
    ]);
  });

  it("carries the identical semantic request over local and SSH backend profiles", async () => {
    const root = fixture();
    const semantic = createOrchestrationRequest({
      method: "events.read",
      body: {
        schemaVersion: 1,
        authority: { workspaceId: "workspace-1" },
        participant: "participant-worker",
        deliveryCapability: "capability-delivery",
        after: 0,
        limit: 10,
      },
    });
    fs.writeFileSync(
      path.join(root, "backend-profiles.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "dure.backend_profiles",
        profiles: [
          {
            id: "local",
            default: true,
            transport: {
              kind: "local",
              endpoint: {
                kind: "unix_socket",
                path: path.join(root, "control-plane.sock"),
              },
            },
            auth: { kind: "peer" },
            trust: { kind: "local_peer" },
            expected: {
              backendId: "dure-local",
              generation: "local-generation-1",
              protocol: {
                minimum: { major: 1, minor: 0 },
                maximum: { major: 1, minor: 0 },
              },
              capabilities: ["orchestration.invoke"],
            },
            deadlineMs: 1_000,
          },
          {
            id: "ssh-worker",
            default: false,
            transport: {
              kind: "ssh",
              host: "worker.example.test",
              port: 22,
              user: "worker",
              endpoint: { kind: "tcp", host: "127.0.0.1", port: 4317 },
              batchMode: true,
              strictHostKeyChecking: "yes",
              connectTimeoutMs: 1_000,
            },
            auth: {
              kind: "identity_file",
              reference: "credential-profile:worker",
            },
            trust: {
              kind: "known_hosts",
              reference: "known-hosts-profile:worker",
            },
            expected: {
              backendId: "dure-remote",
              generation: "remote-generation-1",
              protocol: {
                minimum: { major: 1, minor: 0 },
                maximum: { major: 1, minor: 0 },
              },
              capabilities: [
                "backend.transport.ssh_gateway",
                "orchestration.invoke",
              ],
            },
            deadlineMs: 1_000,
          },
        ],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const observed = [];
    for (const endpoint of ["backend-profile:local", "backend-profile:ssh-worker"]) {
      await expect(
        requestOrchestrationThroughBackendProfile(endpoint, semantic, {
          environment: { DURE_HOME: root },
          performRequest: async (profile, transportRequest) => {
            observed.push({ profile, transportRequest });
            return { result: {
              apiVersion: "dure.orchestration/v1",
              method: semantic.method,
              receipt: { events: [], deliveries: [], nextCursor: 0 },
            } };
          },
        }),
      ).resolves.toMatchObject({ receipt: { nextCursor: 0 } });
    }
    expect(observed.map(({ transportRequest }) => transportRequest)).toEqual([
      {
        operation: "orchestration.invoke",
        body: semantic,
        requiredCapabilities: ["orchestration.invoke"],
      },
      {
        operation: "orchestration.invoke",
        body: semantic,
        requiredCapabilities: ["orchestration.invoke"],
      },
    ]);
    expect(observed.map(({ profile }) => profile.transport.kind)).toEqual([
      "local",
      "ssh",
    ]);
  });

  it("keeps the Dure CLI a thin client of the selected canonical authority", async () => {
    const observed = [];
    const output = [];
    const receipt = await runOrchestrationInvokeFromCli({
      arguments_: [
        "events.read",
        JSON.stringify({
          authority: { workspaceId: "workspace-1" },
          participant: "participant-worker",
          deliveryCapability: "capability-delivery",
          after: 4,
          limit: 10,
        }),
      ],
      backend: "ssh-worker",
      backendSpecified: true,
      environment: {},
      json: true,
      output: (source) => output.push(source),
      request: async (endpoint, request, options) => {
        observed.push({ endpoint, request, options });
        return {
          apiVersion: "dure.orchestration/v1",
          method: request.method,
          receipt: { events: [], deliveries: [], nextCursor: 4 },
        };
      },
    });

    expect(receipt.receipt.nextCursor).toBe(4);
    expect(observed).toMatchObject([
      {
        endpoint: "backend-profile:ssh-worker",
        request: {
          apiVersion: "dure.orchestration/v1",
          method: "events.read",
          body: { after: 4 },
        },
      },
    ]);
    expect(JSON.parse(output.join(""))).toEqual(receipt);
    expect(() => parseOrchestrationInvoke(["events.read", "[]"])).toThrow(
      /JSON object/,
    );
  });

  it("prepares the selected backend authority before the first local request", async () => {
    const observed = [];
    await runOrchestrationInvokeFromCli({
      arguments_: ["events.read", JSON.stringify({ after: 0, limit: 1 })],
      environment: {},
      output: () => {},
      prepareBackendProfile: async (explicitId) => {
        observed.push({ explicitId });
        return { profile: { id: "local" } };
      },
      request: async (endpoint, request) => {
        observed.push({ endpoint, request });
        return {
          apiVersion: "dure.orchestration/v1",
          method: request.method,
          receipt: { events: [], deliveries: [], nextCursor: 0 },
        };
      },
    });

    expect(observed).toEqual([
      { explicitId: undefined },
      {
        endpoint: "backend-profile:local",
        request: {
          apiVersion: "dure.orchestration/v1",
          method: "events.read",
          body: { after: 0, limit: 1 },
        },
      },
    ]);
  });

  it("prints sanitized backend rejection reasons from the real orchestration CLI", () => {
    const root = fixture();
    const remote = sshWorkerFixture(root, {
      remoteError: {
        code: "orchestration_state_conflict",
        message: "private backend diagnostic must not escape",
        details: {
          reasonCode: "dispatch_completed",
          disposition: "terminal",
          credential: "private-credential-fixture",
        },
      },
    });
    const result = spawnSync(process.execPath, [
      CLI, "orchestration", "invoke", "interaction.message.open.exact-session", "{}",
      "--backend", "ssh-worker", "--json",
    ], { cwd: root, encoding: "utf8", env: remote.environment });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: "backend_transport_remote_error",
      message: "the backend rejected the request",
      remoteCode: "orchestration_state_conflict",
      reasonCode: "dispatch_completed",
      disposition: "terminal",
    });
    expect(result.stderr).not.toContain("private");
  });

  it("refuses an unauthenticated cleartext hosted carrier", async () => {
    const request = createOrchestrationRequest({
      method: "events.read",
      body: { schemaVersion: 1 },
    });
    await expect(
      requestOrchestration("http://control.example.test/events", request, {
        fetchImplementation: async () => {
          throw new Error("cleartext carrier must not be reached");
        },
      }),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      requestOrchestration("https://control.example.test/events", request, {
        fetchImplementation: async () => {
          throw new Error("unauthenticated carrier must not be reached");
        },
      }),
    ).rejects.toThrow(/authentication/);

    const observed = [];
    await expect(
      requestOrchestration("https://control.example.test/events", request, {
        authorization: "Bearer hosted-test",
        fetchImplementation: async (endpoint, init) => {
          observed.push({ endpoint: endpoint.href, init });
          return {
            ok: true,
            json: async () => ({
              apiVersion: "dure.orchestration/v1",
              method: "events.read",
              receipt: { events: [], deliveries: [], nextCursor: 0 },
            }),
          };
        },
      }),
    ).resolves.toMatchObject({ receipt: { nextCursor: 0 } });
    expect(observed).toMatchObject([
      {
        endpoint: "https://control.example.test/events",
        init: {
          method: "POST",
          headers: { authorization: "Bearer hosted-test" },
        },
      },
    ]);
  });

  it("stages both providers at one worker root without sharing provider state", () => {
    const root = fixture();
    const workerRoot = path.join(root, "worker-payload");
    const receipts = mutateOrchestrationIntegrations({
      action: "install",
      cliScriptPath: CLI,
      channel: "stable",
      homeDirectory: root,
      workspaceRoot: root,
      installRoot: workerRoot,
      global: false,
      approval: false,
      transportRef: "authenticated-ssh-control:test",
    });
    expect(receipts.map((receipt) => receipt.provider)).toEqual(["claude", "codex"]);
    expect(new Set(receipts.map((receipt) => receipt.digest)).size).toBe(1);
    for (const provider of ["claude", "codex"]) {
      expect(
        fs.existsSync(path.join(workerRoot, "provider", provider, "mcp-servers.json")),
      ).toBe(true);
    }
  });

  it.each([-1, 1])("rejects a delivery file-count mismatch before installing: %s", (deliveryFileDelta) => {
    const root = fixture();
    const remote = sshWorkerFixture(root, { deliveryFileDelta });
    const installed = idleWorkerCliFixture(root);
    const result = spawnSync(process.execPath, [installed.cli, "integration", "install", "--remote", "--backend", "ssh-worker", "--global", "--provider", "codex", "--approve-global-config", "--json"], {
      cwd: root, encoding: "utf8", env: remote.environment,
    });
    expect(result.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(remote.remoteLog, "utf8")).status).toBe(70);
    expect(fs.existsSync(path.join(remote.remoteHome, ".codex", "dure", "orchestration"))).toBe(false);
  });

  it("retries an authenticated SSH worker install after losing the applied receipt", () => {
    const root = fixture();
    const remote = sshWorkerFixture(root);
    const installedCli = idleWorkerCliFixture(root);
    const command = [
      installedCli.cli,
      "integration",
      "install",
      "--remote",
      "--backend",
      "ssh-worker",
      "--global",
      "--provider",
      "codex",
      "--approve-global-config",
      "--json",
    ];

    const disconnected = spawnSync(process.execPath, command, {
      cwd: root,
      encoding: "utf8",
      env: remote.environment,
    });
    expect(disconnected.status).not.toBe(0);
    const receiptPath = path.join(
      remote.remoteHome,
      ".codex",
      "dure",
      "orchestration",
      "install-receipt.json",
    );
    expect(
      fs.existsSync(receiptPath),
      `${disconnected.stderr}\n${fs.existsSync(remote.remoteLog) ? fs.readFileSync(remote.remoteLog, "utf8") : "remote log missing"}`,
    ).toBe(true);
    const applied = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

    const retried = spawnSync(process.execPath, command, {
      cwd: root,
      encoding: "utf8",
      env: remote.environment,
    });
    expect(retried.status, retried.stderr).toBe(0);
    const [receipt] = JSON.parse(retried.stdout).receipts;
    expect(receipt).toMatchObject({
      provider: "codex",
      status: "current",
      scope: "global",
      version: installedCli.buildId,
      cliDigest: installedCli.sourceDigest,
      digest: applied.digest,
      transportRef: "ssh-profile:ssh-worker@remote-generation-1",
      globalConfigurationApproved: true,
    });
    expect(receipt.installRoot.startsWith(fs.realpathSync(remote.remoteHome))).toBe(true);
    expect(receipt.capabilities).toContain("event_cursor_v1");
    expect(fs.existsSync(path.join(remote.localHome, ".codex"))).toBe(false);
    const shellArgv = fs
      .readFileSync(remote.sshLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((argv) => argv.at(-1) === "/bin/sh -s");
    expect(shellArgv).toBeDefined();
    expect(shellArgv).toContain("-T");
    expect(shellArgv).toContain("BatchMode=yes");
    expect(shellArgv).toContain("StrictHostKeyChecking=yes");
    expect(shellArgv).not.toContain("-t");
    expect(shellArgv).not.toContain("-tt");
    const exchanges = fs.readFileSync(remote.sshLog, "utf8").trim().split("\n")
      .map(line => JSON.parse(line));
    const pinnedPaths = exchanges.map(argv => argv.find(value =>
      value.startsWith("UserKnownHostsFile=")).slice("UserKnownHostsFile=".length));
    expect(new Set(pinnedPaths).size).toBe(pinnedPaths.length);
    expect(pinnedPaths.every(file => !fs.existsSync(file))).toBe(true);


    const updated = spawnSync(
      process.execPath,
      command.map((argument) => (argument === "install" ? "update" : argument)),
      { cwd: root, encoding: "utf8", env: remote.environment },
    );
    expect(updated.status, updated.stderr).toBe(0);
    expect(
      fs.existsSync(
        path.join(
          path.dirname(path.dirname(installedCli.cli)),
          "install.json",
        ),
      ),
    ).toBe(true);
    expect(orchestrationPayloadIdentity(installedCli.cli).digest).toBe(
      applied.digest,
    );
    expect(JSON.parse(updated.stdout).receipts[0]).toMatchObject({
      status: "current",
      digest: applied.digest,
      transportRef: "ssh-profile:ssh-worker@remote-generation-1",
    });

    const status = spawnSync(
      process.execPath,
      [
        installedCli.cli,
        "integration",
        "status",
        "--remote",
        "--backend",
        "ssh-worker",
        "--global",
        "--provider",
        "codex",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: remote.environment },
    );
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).receipts[0]).toMatchObject({
      status: "current",
      digest: applied.digest,
      transportRef: "ssh-profile:ssh-worker@remote-generation-1",
    });

    const removed = spawnSync(
      process.execPath,
      [
        installedCli.cli,
        "integration",
        "uninstall",
        "--remote",
        "--backend",
        "ssh-worker",
        "--global",
        "--provider",
        "codex",
        "--approve-global-config",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: remote.environment },
    );
    expect(removed.status, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout).receipts[0]).toMatchObject({
      status: "removed",
      scope: "global",
      transportRef: "ssh-profile:ssh-worker@remote-generation-1",
      globalConfigurationApproved: true,
    });
    expect(fs.existsSync(path.dirname(receiptPath))).toBe(false);
  });

  it("rejects an SSH worker profile before delivery when capability is absent", () => {
    const root = fixture();
    const remote = sshWorkerFixture(root, { capabilities: [] });
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "integration",
        "status",
        "--remote",
        "--backend",
        "ssh-worker",
        "--global",
        "--provider",
        "codex",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: remote.environment },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "SSH worker profile does not provide orchestration.invoke",
    );
    expect(fs.existsSync(remote.remoteLog)).toBe(false);
    expect(fs.existsSync(path.join(remote.remoteHome, ".codex"))).toBe(false);
  });

  it("rejects a stale SSH worker generation before staging the payload", () => {
    const root = fixture();
    const remote = sshWorkerFixture(root, {
      observedGeneration: "remote-generation-2",
    });
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "integration",
        "status",
        "--remote",
        "--backend",
        "ssh-worker",
        "--global",
        "--provider",
        "codex",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env: remote.environment },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "backend generation does not match the selected profile",
    );
    expect(fs.existsSync(remote.remoteLog)).toBe(false);
    expect(fs.existsSync(path.join(remote.remoteHome, ".codex"))).toBe(false);
  });

  it("reconnects from the last acknowledged cursor after a disconnect", async () => {
    const root = fixture();
    const checkpoint = path.join(root, "cursor.json");
    const observed = [];
    let attempts = 0;
    const invoke = () =>
      resumeDurableInbox({
        endpoint: "https://control.invalid/events",
        checkpointPath: checkpoint,
        identity: { generation: 7, sessionIdentity: "session-1" },
        read: async ({ afterCursor }) => {
          attempts += 1;
          if (attempts === 1) {
            expect(afterCursor).toBe(0);
            return {
              events: [{ cursor: 9 }],
              deliveries: [{ eventCursor: 9, receiptId: "delivery-9", state: "observed" }],
            };
          }
          expect(afterCursor).toBe(9);
          return { events: [], deliveries: [] };
        },
        handle: async (event, delivery) => observed.push([event.cursor, delivery.receiptId]),
        acknowledge: async ({ throughCursor, deliveryReceiptId }) => ({
          acknowledgement: {
            through: throughCursor,
            delivery: {
              eventCursor: throughCursor,
              receiptId: deliveryReceiptId,
              state: "acknowledged",
            },
            idempotent: false,
          },
        }),
      });
    await expect(invoke()).resolves.toBe(9);
    expect(observed).toEqual([[9, "delivery-9"]]);
    expect(loadCursor(checkpoint)).toBe(9);
  });

  it("does not advance a cursor when handling disconnects before acknowledgement", async () => {
    const root = fixture();
    const checkpoint = path.join(root, "cursor.json");
    await expect(
      resumeDurableInbox({
        endpoint: "https://control.invalid/events",
        checkpointPath: checkpoint,
        identity: { generation: 7, sessionIdentity: "session-1" },
        read: async () => ({
          events: [{ cursor: 9 }],
          deliveries: [{ eventCursor: 9, receiptId: "delivery-9", state: "observed" }],
        }),
        handle: async () => undefined,
        acknowledge: async () => {
          throw new Error("disconnected");
        },
      }),
    ).rejects.toThrow("disconnected");
    expect(loadCursor(checkpoint)).toBe(0);
  });

  it("does not advance a cursor for a mismatched acknowledgement receipt", async () => {
    const root = fixture();
    const checkpoint = path.join(root, "cursor.json");
    await expect(
      resumeDurableInbox({
        endpoint: "https://control.invalid/events",
        checkpointPath: checkpoint,
        identity: { generation: 7, sessionIdentity: "session-1" },
        read: async () => ({
          events: [{ cursor: 9 }],
          deliveries: [{ eventCursor: 9, receiptId: "delivery-9", state: "observed" }],
        }),
        handle: async () => undefined,
        acknowledge: async () => ({
          acknowledgement: {
            through: 9,
            delivery: {
              eventCursor: 9,
              receiptId: "delivery-other",
              state: "acknowledged",
            },
          },
        }),
      }),
    ).rejects.toThrow(/does not match/);
    expect(loadCursor(checkpoint)).toBe(0);
  });

  it("offers one provider-neutral MCP tool contract", async () => {
    const result = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(result).toMatchObject({
      tools: [
        { name: "orchestration_context_get_current" },
        { name: "orchestration_interaction_open" },
        { name: "orchestration_interaction_get" },
        { name: "orchestration_events_read" },
        { name: "orchestration_decision_answer" },
        { name: "orchestration_dispatch_complete" },
        { name: "agent_goal_get" },
        { name: "agent_goal_put" },
        { name: "app_project_add" },
        { name: "app_observe" },
        { name: "app_pane_state" },
        { name: "app_pane_act" },
        { name: "app_workspace_open" },
        { name: "app_pane_split" },
        { name: "app_pane_open" },
        { name: "app_pane_create" },
        { name: "app_pane_close" },
      ],
    });
    const eventRead = result.tools.find(
      (tool) => tool.name === "orchestration_events_read",
    );
    expect(eventRead.inputSchema).toMatchObject({
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 128 },
        acknowledgement: {
          type: "object",
          required: ["through", "idempotencyKey"],
        },
      },
      additionalProperties: false,
    });
    expect(eventRead.inputSchema.properties).not.toHaveProperty("body");
  });

  it.each([undefined, "dispatch_completed"])("preserves a typed backend rejection at the MCP boundary: %s", async (reasonCode) => {
    const backendError = new BackendTransportError("backend_transport_remote_error", {
      details: {
        code: "orchestration_capability_denied",
        disposition: "terminal",
        ...(reasonCode ? { reasonCode } : {}),
      },
    });

    await expect(
      handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "orchestration_interaction_get",
            arguments: { body: {} },
          },
        },
        { DURE_BACKEND_PROFILE: "local" },
        {
          request: async () => {
            throw backendError;
          },
        },
      ),
    ).rejects.toMatchObject({
      message:
        `orchestration_capability_denied${reasonCode ? `: ${reasonCode}` : ""} (terminal): the backend rejected the request`,
      cause: backendError,
    });
  });

  it("enrolls a restarted MCP worker using its frozen integration receipt", async () => {
    const { environment, context, receiptPath } = currentMcpContextFixture(fixture());
    const integrationReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    fs.writeFileSync(receiptPath, JSON.stringify({ ...integrationReceipt, version: "replacement-v2" }));
    const request = vi.fn(async (_endpoint, operation) => {
      if (operation.method === "dispatch.context.get") {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: { disposition: "unassigned" },
        });
      }
      expect(operation.method).toBe("run.create");
      expect(operation.body.integrationReceipt.version).toBe("fixture-v1");
      return { receipt: { context } };
    });
    const result = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "orchestration_context_get_current" } },
      environment,
      { integrationReceipt, receiptPath, request },
    );
    expect(result.structuredContent.context).toEqual(context);
    expect(request.mock.calls.map((call) => call[1].method)).toEqual(["dispatch.context.get", "run.create"]);
  });

  it("completes without consulting a tracker or creating an unsolicited successor", async () => {
    const { environment, context, receiptPath } = currentMcpContextFixture(fixture());
    const receipt = {
      apiVersion: "dure.orchestration/v1",
      method: "dispatch.complete",
      receipt: { dispatchState: "completed", idempotent: false },
    };
    const request = vi.fn(async (_endpoint, operation) => {
      if (operation.method !== "dispatch.complete") {
        throw new Error("completion did not authorize another operation");
      }
      return receipt;
    });
    const result = await handleMcpRequest(
      mcpToolCall("orchestration_dispatch_complete", completionBody(context, "complete-only")),
      environment,
      { receiptPath, request },
    );

    expect(request.mock.calls.map((call) => call[1].method)).toEqual(["dispatch.complete"]);
    expect(result.structuredContent).toEqual(receipt);
    expect(JSON.parse(result.content[0].text)).toEqual(receipt);
  });

  it("completes without executing Beads or creating unsolicited successor work", async () => {
    const root = fixture();
    const { receiptPath, environment, context } = currentMcpContextFixture(root);
    const probe = path.join(root, "beads-called");
    fs.writeFileSync(
      path.join(root, "bd"),
      '#!/bin/sh\nprintf called > "$BEADS_TEST_PROBE"\nprintf "[]"\n',
      { mode: 0o755 },
    );
    const methods = [];
    // Permit the old successor path so an implicit tracker query is observed
    // at the process boundary instead of being masked by a transport rejection.
    const request = async (_endpoint, operation) => {
      methods.push(operation.method);
      let receipt;
      if (operation.method === "dispatch.complete") {
        receipt = { dispatchState: "completed", idempotent: false };
      } else if (operation.method === "dispatch.context.get") {
        receipt = { ...context, dispatchState: "completed" };
      } else if (operation.method === "run.create") {
        receipt = { context: { ...context, dispatchState: "active" } };
      } else if (operation.method === "interaction.get") {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: { code: "orchestration_record_not_found" },
        });
      } else {
        receipt = { interaction: operation.body.interaction };
      }
      return { apiVersion: "dure.orchestration/v1", method: operation.method, receipt };
    };
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("BEADS_TEST_PROBE", probe);
    try {
      const result = await handleMcpRequest(
        mcpToolCall(
          "orchestration_dispatch_complete",
          completionBody(context, "tracker-free-completion"),
        ),
        environment,
        { receiptPath, request, now: () => 1_500 },
      );
      expect(result.structuredContent.receipt.dispatchState).toBe("completed");
      expect(fs.existsSync(probe)).toBe(false);
      expect(methods).toEqual(["dispatch.complete"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("completes first, then opens one next-work Decision on a successor Dispatch", async () => {
    const root = fixture();
    const { receiptPath, environment, context } =
      currentMcpContextFixture(root);
    const successor = {
      ...context,
      dispatchState: "active",
      target: {
        ...context.target,
        runId: "run-successor",
        taskId: "task-successor",
        dispatchId: "dispatch-successor",
      },
    };
    const calls = [];
    let successorReplays = 0;
    const request = vi.fn(async (_endpoint, orchestrationRequest) => {
      calls.push(orchestrationRequest);
      if (orchestrationRequest.method === "dispatch.complete") {
        return {
          apiVersion: "dure.orchestration/v1",
          method: "dispatch.complete",
          receipt: { dispatchState: "completed", idempotent: false },
        };
      }
      if (orchestrationRequest.method === "dispatch.context.get") {
        return {
          apiVersion: "dure.orchestration/v1",
          method: "dispatch.context.get",
          receipt: {
            ...context,
            dispatchState: "completed",
            successorRequired: false,
          },
        };
      }
      if (orchestrationRequest.method === "run.create") {
        successorReplays += 1;
        return {
          apiVersion: "dure.orchestration/v1",
          method: "run.create",
          receipt: {
            context:
              successorReplays === 1
                ? successor
                : {
                    ...successor,
                    dispatchState: "blocked",
                    dispatchRevision: 2,
                  },
          },
        };
      }
      if (orchestrationRequest.method === "interaction.get") {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: {
            code: "orchestration_record_not_found",
            disposition: "retry_same",
          },
        });
      }
      expect(orchestrationRequest.method).toBe("interaction.open");
      return {
        apiVersion: "dure.orchestration/v1",
        method: "interaction.open",
        receipt: {
          dispatchState: "blocked",
          interaction: orchestrationRequest.body.interaction,
          idempotent: false,
        },
      };
    });
    const body = completionBody(context, "complete-reporting-cycle", {
      title: "Reporting cycle complete",
      resultMarkdown: "The requested change is live. CI passed at commit abc123.",
    });

    const result = await handleMcpRequest(
      mcpToolCall("orchestration_dispatch_complete", body, [nextWorkCandidate()]),
      environment,
      {
        receiptPath,
        request,
        now: () => 1_500,
      },
    );

    expect(result.structuredContent.receipt.dispatchState).toBe("completed");
    expect(calls[0].body).toEqual(body);
    expect(calls.map((call) => call.method)).toEqual([
      "dispatch.complete",
      "dispatch.context.get",
      "run.create",
      "interaction.get",
      "interaction.open",
      "dispatch.context.get",
      "run.create",
    ]);
    expect(calls[2].body.idempotencyKey).toMatch(/^run-/u);
    expect(calls[3].body.interactionId).toMatch(/^next-work-/u);
    expect(calls[4].body).toMatchObject({
      writeCapability: successor.interactionCapability,
      expectedDispatchRevision: successor.dispatchRevision,
      interaction: {
        kind: "decision",
        common: {
          target: successor.target,
          author: successor.participant,
          audience: { grants: [successor.coordinatorGrant] },
        },
        response: {
          kind: "select",
          minSelections: 1,
          maxSelections: 1,
          options: [
            {
              id: "unify-lifecycle",
              label: "unify-lifecycle — Remove one lifecycle authority split",
              descriptionMarkdown:
                "Benefit: Converge the remaining duplicate runtime writer.\n\n" +
                "Concern: Restart behavior still needs verification.\n\n" +
                "Prerequisite: Revalidate ownership and evidence before starting.\n\n" +
                "Likely conflict surface: Session lifecycle.",
            },
            { id: "stop" },
          ],
        },
        replyCapability: successor.coordinatorReplyCapability,
      },
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      completion: { receipt: { dispatchState: "completed" } },
      nextWork: {
        state: "opened",
        candidateIds: ["unify-lifecycle"],
        interaction: {
          kind: "decision",
          response: {
            options: [
              { id: "unify-lifecycle" },
              { id: "stop" },
            ],
          },
        },
        context: {
          dispatchState: "blocked",
          dispatchRevision: 2,
          target: successor.target,
        },
      },
    });
  });

  it("returns the committed completion when next-work publication fails", async () => {
    const root = fixture();
    const { receiptPath, environment, context } =
      currentMcpContextFixture(root);
    const methods = [];

    const result = await handleMcpRequest(
      mcpToolCall(
        "orchestration_dispatch_complete",
        completionBody(context, "complete-before-publication-failure", {
          messageId: "completion-before-publication-failure",
          completedAtMs: 1_600,
        }),
        [nextWorkCandidate()],
      ),
      environment,
      {
        receiptPath,
        request: async (_endpoint, orchestrationRequest) => {
          methods.push(orchestrationRequest.method);
          if (orchestrationRequest.method === "dispatch.complete") {
            return {
              apiVersion: "dure.orchestration/v1",
              method: "dispatch.complete",
              receipt: { dispatchState: "completed", idempotent: false },
            };
          }
          throw new Error("successor transport unavailable");
        },
      },
    );

    expect(methods).toEqual(["dispatch.complete", "dispatch.context.get"]);
    expect(result.structuredContent.receipt.dispatchState).toBe("completed");
    expect(JSON.parse(result.content[0].text).nextWork).toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("completion report committed"),
    });
  });

  it("reuses the completed generation and existing Decision across retries", async () => {
    const root = fixture();
    const { receiptPath, environment, context } =
      currentMcpContextFixture(root);
    const successor = {
      ...context,
      dispatchState: "active",
      target: {
        ...context.target,
        runId: "run-retry-successor",
        taskId: "task-retry-successor",
        dispatchId: "dispatch-retry-successor",
      },
    };
    const runKeys = [];
    let contextReads = 0;
    let openedInteraction;
    let openCount = 0;
    const request = async (_endpoint, orchestrationRequest) => {
      if (orchestrationRequest.method === "dispatch.complete") {
        return {
          apiVersion: "dure.orchestration/v1",
          method: "dispatch.complete",
          receipt: { dispatchState: "completed", idempotent: true },
        };
      }
      if (orchestrationRequest.method === "dispatch.context.get") {
        contextReads += 1;
        return {
          apiVersion: "dure.orchestration/v1",
          method: "dispatch.context.get",
          receipt:
            contextReads === 1
              ? {
                  ...context,
                  dispatchState: "completed",
                  successorRequired: false,
                }
              : {
                  ...successor,
                  dispatchState: "blocked",
                  dispatchRevision: 2,
                },
        };
      }
      if (orchestrationRequest.method === "run.create") {
        runKeys.push(orchestrationRequest.body.idempotencyKey);
        return {
          apiVersion: "dure.orchestration/v1",
          method: "run.create",
          receipt: {
            context:
              runKeys.length > 1
                ? {
                    ...successor,
                    dispatchState: "blocked",
                    dispatchRevision: 2,
                  }
                : successor,
            idempotent: runKeys.length > 1,
          },
        };
      }
      if (orchestrationRequest.method === "interaction.get") {
        if (openedInteraction) {
          return {
            apiVersion: "dure.orchestration/v1",
            method: "interaction.get",
            receipt: openedInteraction,
          };
        }
        throw new BackendTransportError("backend_transport_remote_error", {
          details: { code: "orchestration_record_not_found" },
        });
      }
      openCount += 1;
      openedInteraction = orchestrationRequest.body.interaction;
      return {
        apiVersion: "dure.orchestration/v1",
        method: "interaction.open",
        receipt: { interaction: openedInteraction, idempotent: false },
      };
    };
    const body = completionBody(context, "retry-completion", {
      resultMarkdown: "The same report is retried.",
      completedAtMs: 1_700,
    });
    const message = mcpToolCall("orchestration_dispatch_complete", body, [
      nextWorkCandidate(),
    ]);
    let clock = 2_000;
    const dependencies = {
      receiptPath,
      request,
      now: () => (clock += 1_000),
    };

    const first = await handleMcpRequest(message, environment, dependencies);
    const replay = await handleMcpRequest(
      mcpToolCall("orchestration_dispatch_complete", body, [
        nextWorkCandidate({ id: "later-recommendation" }),
      ]),
      environment,
      dependencies,
    );

    expect(runKeys).toHaveLength(3);
    expect(contextReads).toBe(3);
    expect(new Set(runKeys).size).toBe(1);
    expect(openCount).toBe(1);
    expect(JSON.parse(first.content[0].text).nextWork.state).toBe("opened");
    expect(JSON.parse(replay.content[0].text).nextWork).toMatchObject({
      state: "existing",
      context: { dispatchState: "blocked", dispatchRevision: 2 },
      interaction: {
        response: { options: [{ id: "unify-lifecycle" }, { id: "stop" }] },
      },
    });
  });

  it("normalizes caller recommendations once without changing their order or inventing evidence", () => {
    const proposed = [
      nextWorkCandidate({ title: "Ready\u0000 work", benefit: "🙂".repeat(160) }),
      nextWorkCandidate({ id: "other-source", prerequisite: "Ask the project owner." }),
    ];
    const candidates = parseNextWorkCandidates(proposed);

    expect(parseNextWorkCandidates(undefined)).toBeUndefined();
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "unify-lifecycle",
      "other-source",
    ]);
    expect(candidates[0].title).toBe("Ready work");
    expect(candidates[1]).toEqual(proposed[1]);
    expect(proposed[0].title).toBe("Ready\u0000 work");
    expect(Buffer.byteLength(candidates[0].benefit, "utf8")).toBeLessThanOrEqual(
      480,
    );
    expect(candidates[0].benefit).not.toContain("�");
  });

  it.each([
    ["null", null],
    ["empty", []],
    ["not an array", nextWorkCandidate()],
    ["invalid candidate", [null]],
    ["array candidate", [[]]],
    ["too many", ["one", "two", "three", "four"].map((id) => nextWorkCandidate({ id }))],
    ["duplicate IDs", [nextWorkCandidate(), nextWorkCandidate()]],
    ["reserved stop ID", [nextWorkCandidate({ id: "stop" })]],
    ["padded ID", [nextWorkCandidate({ id: " padded " })]],
    ["control ID", [nextWorkCandidate({ id: "bad\u0000id" })]],
    ["unbounded ID", [nextWorkCandidate({ id: "🙂".repeat(65) })]],
    ["missing concern", [nextWorkCandidate({ concern: undefined })]],
    ["empty text", [nextWorkCandidate({ title: "\n\u0000 " })]],
    ["non-text evidence", [nextWorkCandidate({ benefit: false })]],
    ["tracker-specific fields", [nextWorkCandidate({ status: "open" })]],
  ])(
    "rejects %s recommendations before committing completion",
    async (_label, candidates) => {
      const { environment, context, receiptPath } = currentMcpContextFixture(fixture());
      const request = vi.fn();

      await expect(
        handleMcpRequest(
          mcpToolCall(
            "orchestration_dispatch_complete",
            completionBody(context, "invalid-candidates"),
            candidates,
          ),
          environment,
          { receiptPath, request },
        ),
      ).rejects.toThrow(/nextWorkCandidates/u);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("gives an agent its exact current capability context without requiring an opaque body", async () => {
    const root = fixture();
    const { receiptPath, environment, context } =
      currentMcpContextFixture(root);

    await expect(
      handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "orchestration_context_get_current", arguments: {} },
        },
        environment,
        {
          receiptPath,
          request: async (_endpoint, request, options) => {
            expect(request.method).toBe("dispatch.context.get");
            expect(request.body).toEqual({
              schemaVersion: 1,
              session: expect.objectContaining({
                sessionId: "worker-session",
                terminalEpoch: "terminal-epoch",
              }),
            });
            expect(request.body).not.toHaveProperty("integrationReceipt");
            expect(options.authorization).toBe("Bearer fixture");
            return { receipt: context };
          },
        },
      ),
    ).resolves.toMatchObject({ structuredContent: { context } });
  });

  it("reads the current agent inbox without requiring an opaque authority body", async () => {
    const root = fixture();
    const { receiptPath, environment, context } =
      currentMcpContextFixture(root);
    const { target, endpointFence } = context;
    const calls = [];
    let eventReads = 0;
    const dependencies = {
      receiptPath,
      request: async (_endpoint, request) => {
        calls.push(request);
        if (request.method === "dispatch.context.get") {
          return { receipt: context };
        }
        eventReads += 1;
        const acknowledgement =
          eventReads === 1
            ? undefined
            : {
                through: 9,
                idempotencyKey: "acknowledge-event-9",
                acknowledgementCapability: "capability-acknowledgement",
              };
        expect(request).toEqual({
          apiVersion: "dure.orchestration/v1",
          method: "events.read",
          body: {
            schemaVersion: 1,
            authority: target.authority,
            target,
            participant: "participant-worker",
            deliveryCapability: "capability-delivery",
            endpointFence,
            after: eventReads === 1 ? 0 : 9,
            limit: 128,
            ...(acknowledgement ? { acknowledgement } : {}),
          },
        });
        return {
          apiVersion: "dure.orchestration/v1",
          method: "events.read",
          receipt:
            eventReads === 1
              ? {
                  events: [{ cursor: 9 }],
                  deliveries: [
                    {
                      receiptId: "delivery-9",
                      eventCursor: 9,
                      participant: "participant-worker",
                      state: "observed",
                    },
                  ],
                  nextCursor: 9,
                }
              : {
                  events: [],
                  deliveries: [],
                  nextCursor: 9,
                  acknowledgement: {
                    through: 9,
                    delivery: {
                      receiptId: "delivery-9",
                      eventCursor: 9,
                      participant: "participant-worker",
                      state: "acknowledged",
                    },
                  },
                },
        };
      },
    };

    await expect(
      handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "orchestration_events_read", arguments: {} },
        },
        environment,
        dependencies,
      ),
    ).resolves.toMatchObject({
      structuredContent: {
        method: "events.read",
        receipt: { nextCursor: 9 },
      },
    });
    expect(loadCursor(path.join(root, "orchestration/cursors/endpoint-worker.json"))).toBe(0);
    await expect(
      handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "orchestration_events_read",
            arguments: {
              acknowledgement: {
                through: 9,
                idempotencyKey: "acknowledge-event-9",
              },
            },
          },
        },
        environment,
        dependencies,
      ),
    ).resolves.toMatchObject({
      structuredContent: {
        receipt: { acknowledgement: { through: 9 } },
      },
    });
    expect(loadCursor(path.join(root, "orchestration/cursors/endpoint-worker.json"))).toBe(9);
    expect(calls.map((call) => call.method)).toEqual([
      "dispatch.context.get",
      "events.read",
      "dispatch.context.get",
      "events.read",
    ]);
  });

  it.each([
    { body: {} },
    { limit: 0 },
    { acknowledgement: { through: 1 } },
  ])("rejects malformed Event read intent before transport", async (arguments_) => {
    const request = vi.fn();
    await expect(
      handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "orchestration_events_read", arguments: arguments_ },
        },
        {},
        { request },
      ),
    ).rejects.toThrow("orchestration Event read intent is invalid");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps lifecycle hooks bounded to identity, checkpoint, and wakeup context", () => {
    const root = fixture();
    const checkpoint = path.join(root, "cursor.json");
    checkpointCursor(checkpoint, 21, "delivery-21");
    const environment = {
      DURE_ORCHESTRATION_PARTICIPANT: "participant-worker",
      DURE_ORCHESTRATION_ENDPOINT_REF: "endpoint-1",
      DURE_ORCHESTRATION_SESSION_IDENTITY: "session-1",
      DURE_ORCHESTRATION_GENERATION: "7",
      DURE_ORCHESTRATION_CHECKPOINT: checkpoint,
    };
    expect(lifecycleContext(environment, "wakeup")).toMatchObject({
      generation: 7,
      lastAcknowledgedCursor: 21,
    });
    expect(lifecycleHookPayload(environment).hookSpecificOutput.additionalContext).toContain(
      "resume after acknowledged Event cursor 21",
    );
    expect(lifecycleHookPayload({})).toEqual({});
  });

  it("negotiates an exact Session fence at startup without terminal input", async () => {
    const root = fixture();
    const receiptPath = path.join(root, "install-receipt.json");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        provider: "codex",
        version: "fixture-v1",
        digest: "a".repeat(64),
        channel: "test",
        capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
      }),
    );
    const environment = {
      DURE_HOME: root,
      DURE_BACKEND_PROFILE: "local",
      HMUX_SESSION_ID: "worker-session",
      HMUX_WORKSPACE_ID: "runtime-workspace",
      HMUX_RUNNER_PRINCIPAL: "runner-principal",
      HMUX_RUNNER_INSTANCE: "runner-instance",
      HMUX_CHANNEL_EPOCH: "2",
      HMUX_HOST_INSTANCE_ID: "host-instance",
      HMUX_TERMINAL_EPOCH: "terminal-epoch",
    };
    const payload = await resolveLifecycleHookPayload(environment, "session_start", {
      receiptPath,
      now: () => 1_000,
      request: async (endpoint, request) => {
        expect(endpoint).toBe("backend-profile:local");
        expect(request).toMatchObject({
          apiVersion: "dure.orchestration/v1",
          method: "dispatch.context.get",
          body: {
            session: {
              sessionId: "worker-session",
              providerId: "codex",
              terminalEpoch: "terminal-epoch",
            },
          },
        });
        return {
          apiVersion: "dure.orchestration/v1",
          method: "dispatch.context",
          receipt: {
            participant: "participant-worker",
            endpointFence: {
              endpointRef: "endpoint-worker",
              sessionIdentity: "session-identity",
              generation: 1,
            },
          },
        };
      },
    });
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "resume after acknowledged Event cursor 0",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Capability context",
    );
  });

  it("creates one retry-stable durable run when an exact Session has no context", async () => {
    const root = fixture();
    const receiptPath = path.join(root, "install-receipt.json");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        provider: "codex",
        version: "fixture-v1",
        digest: "b".repeat(64),
        channel: "test",
        capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
      }),
    );
    const environment = {
      DURE_HOME: root,
      DURE_BACKEND_PROFILE: "remote-team",
      HMUX_SESSION_ID: "worker-session",
      HMUX_WORKSPACE_ID: "runtime-workspace",
      HMUX_RUNNER_PRINCIPAL: "runner-principal",
      HMUX_RUNNER_INSTANCE: "runner-instance",
      HMUX_CHANNEL_EPOCH: "2",
      HMUX_HOST_INSTANCE_ID: "host-instance",
      HMUX_TERMINAL_EPOCH: "terminal-epoch",
    };
    const runRequests = [];
    let clock = 0;
    const request = async (endpoint, orchestrationRequest) => {
      expect(endpoint).toBe("backend-profile:remote-team");
      if (orchestrationRequest.method === "dispatch.context.get") {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: {
            code: "orchestration_record_not_found",
            disposition: "unassigned",
          },
        });
      }
      expect(orchestrationRequest).toMatchObject({
        method: "run.create",
        body: {
          workflowKindRef: "workflow.existing-session-reporting",
          runtimeRef: "runtime.hmux",
          targetReference: "orchestration.current-session",
          session: {
            sessionId: "worker-session",
            terminalEpoch: "terminal-epoch",
          },
        },
      });
      expect(orchestrationRequest.body).not.toHaveProperty("prompt");
      runRequests.push(orchestrationRequest.body);
      return {
        apiVersion: "dure.orchestration/v1",
        method: "run.create",
        receipt: {
          context: {
            participant: "participant-worker",
            endpointFence: {
              endpointRef: "endpoint-worker",
              sessionIdentity: "session-identity",
              generation: 1,
            },
          },
        },
      };
    };

    const first = await resolveLifecycleHookPayload(environment, "session_start", {
      receiptPath,
      now: () => (clock += 1_000),
      request,
    });
    const retried = await resolveLifecycleHookPayload(environment, "wakeup", {
      receiptPath,
      now: () => (clock += 1_000),
      request,
    });

    expect(first.hookSpecificOutput.additionalContext).toContain("endpoint endpoint-worker");
    expect(retried.hookSpecificOutput.additionalContext).toContain("endpoint endpoint-worker");
    expect(runRequests).toHaveLength(2);
    expect(runRequests[0].idempotencyKey).toBe(runRequests[1].idempotencyKey);
    expect(runRequests[0].createdAtMs).toBe(1_000);
    expect(runRequests[1].createdAtMs).toBe(2_000);
  });

  it("drains completion before creating one retry-stable successor", async () => {
    const root = fixture();
    const receiptPath = path.join(root, "install-receipt.json");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        provider: "codex",
        version: "fixture-v1",
        digest: "c".repeat(64),
        channel: "test",
        capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
      }),
    );
    const environment = {
      DURE_HOME: root,
      DURE_BACKEND_PROFILE: "local",
      HMUX_SESSION_ID: "worker-session",
      HMUX_WORKSPACE_ID: "runtime-workspace",
      HMUX_RUNNER_PRINCIPAL: "runner-principal",
      HMUX_RUNNER_INSTANCE: "runner-instance",
      HMUX_CHANNEL_EPOCH: "2",
      HMUX_HOST_INSTANCE_ID: "host-instance",
      HMUX_TERMINAL_EPOCH: "terminal-epoch",
    };
    const completedTarget = {
      authority: { workspaceId: "agent-workspace:worker" },
      runId: "run.completed",
      taskId: "task.completed",
      dispatchId: "dispatch.completed",
      generation: 1,
    };
    const completedIntegrationReceipt = {
      installRootRef: `install-codex-${"c".repeat(32)}`,
      version: "fixture-v1",
      digest: "c".repeat(64),
      channel: "test",
      capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
    };
    const successorContext = {
      dispatchState: "active",
      successorRequired: false,
      target: {
        ...completedTarget,
        runId: "run.successor",
        taskId: "task.successor",
        dispatchId: "dispatch.successor",
      },
      participant: "participant-worker",
      endpointFence: {
        endpointRef: "endpoint-successor",
        sessionIdentity: "session-identity",
        generation: 1,
      },
      integrationReceipt: completedIntegrationReceipt,
    };
    const runRequests = [];
    let clock = 0;
    let successorRequired = false;
    const request = async (_endpoint, orchestrationRequest) => {
      if (orchestrationRequest.method === "dispatch.context.get") {
        return {
          receipt: {
            dispatchState: "completed",
            successorRequired,
            target: completedTarget,
            integrationReceipt: completedIntegrationReceipt,
            participant: "participant-worker",
            endpointFence: {
              endpointRef: "endpoint-completed",
              sessionIdentity: "session-identity",
              generation: 1,
            },
          },
        };
      }
      expect(orchestrationRequest.method).toBe("run.create");
      runRequests.push(orchestrationRequest.body);
      return { receipt: { context: successorContext } };
    };

    const draining = await resolveCurrentDispatchContext(environment, {
      receiptPath,
      now: () => (clock += 1_000),
      request,
    });
    expect(draining).toMatchObject({
      dispatchState: "completed",
      successorRequired: false,
      target: completedTarget,
    });
    expect(runRequests).toHaveLength(0);

    successorRequired = true;
    const first = await resolveCurrentDispatchContext(environment, {
      receiptPath,
      now: () => (clock += 1_000),
      request,
    });
    const replay = await resolveCurrentDispatchContext(environment, {
      receiptPath,
      now: () => (clock += 1_000),
      request,
    });

    expect(first).toEqual(successorContext);
    expect(replay).toEqual(successorContext);
    expect(runRequests).toHaveLength(2);
    expect(runRequests[0].idempotencyKey).toBe(runRequests[1].idempotencyKey);
    expect(runRequests[0].idempotencyKey).toContain("run-");
    expect(runRequests[0].createdAtMs).toBe(2_000);
    expect(runRequests[1].createdAtMs).toBe(3_000);
  });

  it("does not create a second Run from a retryable context diagnostic", async () => {
    const root = fixture();
    const receiptPath = path.join(root, "install-receipt.json");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        provider: "codex",
        version: "fixture-v1",
        digest: "b".repeat(64),
        channel: "test",
        capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
      }),
    );
    const environment = {
      DURE_HOME: root,
      DURE_BACKEND_PROFILE: "remote-team",
      HMUX_SESSION_ID: "worker-session",
      HMUX_WORKSPACE_ID: "runtime-workspace",
      HMUX_RUNNER_PRINCIPAL: "runner-principal",
      HMUX_RUNNER_INSTANCE: "runner-instance",
      HMUX_CHANNEL_EPOCH: "2",
      HMUX_HOST_INSTANCE_ID: "host-instance",
      HMUX_TERMINAL_EPOCH: "terminal-epoch",
    };
    const request = vi.fn(async (_endpoint, orchestrationRequest) => {
      if (orchestrationRequest.method === "dispatch.context.get") {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: {
            code: "orchestration_record_not_found",
            disposition: "retry_same",
          },
        });
      }
      throw new Error("a retryable context lookup must not create a Run");
    });

    await expect(
      resolveLifecycleHookPayload(environment, "session_start", {
        receiptPath,
        now: () => 1_000,
        request,
      }),
    ).rejects.toMatchObject({
      details: { disposition: "retry_same" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
