import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appControlDirectory, devHmuxToolPaths } from "./app-channel.mjs";
import { coldBootstrapSessionName } from "./dev-cold-bootstrap-operation.mjs";
import {
  DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  PARENT_RELOAD_CAPABILITY,
  parentGenerationFrame,
} from "./dev-launch-contract.mjs";
import {
  DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY,
  DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
  DEV_HMUX_STANDALONE_OPERATION_MODE,
  DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY,
  DEV_HMUX_STANDALONE_RETIRE_CAPABILITY,
} from "./dev-hmux-operation-contract.mjs";
import { targetDevHmuxBuildId } from "./dev-hmux-tool.mjs";
import { HMUX_DEV_RUNTIME_INPUTS } from "./hmux-dev-build-inputs.mjs";
import { resolvePinnedDevNodeTool } from "./dev-node-tool.mjs";
import {
  DEV_CHAIN_RESTART_STATE,
  executeDevChainColdBootstrap,
  executeDevChainRetirementAcknowledgement,
  executeDevChainRestart,
  executeDevParentReload,
  gitWorktreeRootForPath,
  hasOwnedDevLaunchProcess,
  inspectDevChainState,
  ownedAppPid,
  supportsDevChainColdBootstrap,
} from "./dev-chain-recovery.mjs";
import { startDevLaunchEndpointFixture } from "./dev-launch-test-support.mjs";
import { processIdentity } from "./process-identity.mjs";
import { rustToolchainTestEnvironment } from "./rust-toolchain-test-environment.mjs";
import { prepareDevLaunchCheckout } from "./dev-launch-checkout.mjs";
import {
  PACKAGE_SCRIPT_SHELL_ENV,
  POSIX_SHELL_EXECUTABLE_ENV,
  resolveUnixDevChainTools,
} from "./unix-process-tools.mjs";

const TEST_BOOTSTRAP_COMMAND = Object.freeze([
  "node",
  "scripts/run-dev-app.mjs",
]);
const TEST_BOOTSTRAP_TERMINAL_SIZE = Object.freeze({
  initialRows: 31,
  initialColumns: 97,
});
const TEST_UNIX_BIN = "/nix/store/dure-tools/bin";
const TEST_UNIX_TOOL_PATHS = Object.freeze({
  ps: `${TEST_UNIX_BIN}/ps`,
  lsof: `${TEST_UNIX_BIN}/lsof`,
  env: `${TEST_UNIX_BIN}/env`,
  sh: `${TEST_UNIX_BIN}/sh`,
});
const TEST_UNIX_TOOL_CAPABILITY = resolveUnixDevChainTools({
  platform: "linux",
  environment: { PATH: TEST_UNIX_BIN },
  resolveExecutablePath: (pathname) =>
    Object.values(TEST_UNIX_TOOL_PATHS).includes(pathname) ? pathname : null,
});
const TEST_UNIX_OBSERVATION_CAPABILITY = resolveUnixDevChainTools({
  platform: "linux",
  environment: { PATH: TEST_UNIX_BIN },
  resolveExecutablePath: (pathname) =>
    pathname === TEST_UNIX_TOOL_PATHS.ps ||
    pathname === TEST_UNIX_TOOL_PATHS.lsof
      ? pathname
      : null,
});

function fixtureWorktreeRoot(pathname) {
  const linked = pathname?.match(/^\/repo\/\.worktrees\/[^/]+/)?.[0];
  if (linked) return linked;
  if (pathname === "/repo" || pathname?.startsWith("/repo/")) return "/repo";
  return null;
}

describe("executeDevChainColdBootstrap", () => {
  beforeAll(() => {
    for (const [key, value] of Object.entries(rustToolchainTestEnvironment())) {
      vi.stubEnv(key, value);
    }
  });
  afterAll(() => vi.unstubAllEnvs());
  it("derives fresh-create support from one resolved tool capability", () => {
    expect(supportsDevChainColdBootstrap(TEST_UNIX_TOOL_CAPABILITY)).toBe(
      true,
    );
    expect(
      supportsDevChainColdBootstrap(
        resolveUnixDevChainTools({ platform: "win32" }),
      ),
    ).toBe(false);
  });

  it.each([
    {
      label: "process census",
      available: [
        TEST_UNIX_TOOL_PATHS.lsof,
        TEST_UNIX_TOOL_PATHS.env,
        TEST_UNIX_TOOL_PATHS.sh,
      ],
      missing: "process census (ps)",
    },
    {
      label: "process cwd and port census",
      available: [
        TEST_UNIX_TOOL_PATHS.ps,
        TEST_UNIX_TOOL_PATHS.env,
        TEST_UNIX_TOOL_PATHS.sh,
      ],
      missing: "process cwd (lsof), port census (lsof)",
    },
    {
      label: "environment launch",
      available: [
        TEST_UNIX_TOOL_PATHS.ps,
        TEST_UNIX_TOOL_PATHS.lsof,
        TEST_UNIX_TOOL_PATHS.sh,
      ],
      missing: "environment launch (env)",
    },
    {
      label: "POSIX shell",
      available: [
        TEST_UNIX_TOOL_PATHS.ps,
        TEST_UNIX_TOOL_PATHS.lsof,
        TEST_UNIX_TOOL_PATHS.env,
      ],
      missing: "POSIX shell (sh)",
    },
  ])("does not mutate a fresh create without $label", async ({
    available,
    missing,
  }) => {
    const executablePaths = new Set(available);
    const toolCapability = resolveUnixDevChainTools({
      platform: "linux",
      environment: { PATH: TEST_UNIX_BIN },
      resolveExecutablePath: (pathname) =>
        executablePaths.has(pathname) ? pathname : null,
    });
    const calls = [];
    const result = await executeDevChainColdBootstrap(
      {
        root: "/repo/.worktrees/live",
        channel: "dev-live-1234567890",
        port: 1420,
        sourceGeneration: "a".repeat(64),
        requestGeneration: "b".repeat(32),
        operationId: "1".repeat(64),
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        onOperationSubmitted: () => calls.push("submitted"),
        timeoutMs: 1_000,
      },
      {
        resolveTools: () => toolCapability,
        prepare: () => calls.push("prepared"),
        create: () => calls.push("created"),
      },
    );

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
      attempted: false,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      reason: `dev_launch_cold_bootstrap_unavailable: required Unix tools are unavailable: ${missing}`,
    });
  });

  it("observes an existing chain without requiring the fresh-launch tool", () => {
    const calls = [];
    const result = inspectDevChainState(
      {
        root: "/repo/.worktrees/live",
        port: 1420,
        toolCapability: TEST_UNIX_OBSERVATION_CAPABILITY,
      },
      {
        execute: (command, arguments_) => {
          calls.push({ command, arguments_ });
          if (command === TEST_UNIX_TOOL_PATHS.ps) {
            return "41 node scripts/run-dev-app.mjs\n";
          }
          if (command === TEST_UNIX_TOOL_PATHS.lsof) {
            return "p41\nfcwd\nn/repo/.worktrees/other\n";
          }
          throw new Error(`unexpected executable: ${command}`);
        },
        resolveWorktreeRoot: (pathname) => pathname,
        spawn: (command, arguments_) => {
          calls.push({ command, arguments_ });
          return { status: 1 };
        },
      },
    );

    expect(result).toMatchObject({ state: "absent" });
    expect(calls).toEqual([
      {
        command: TEST_UNIX_TOOL_PATHS.ps,
        arguments_: ["-Ao", "pid=,command="],
      },
      {
        command: TEST_UNIX_TOOL_PATHS.lsof,
        arguments_: ["-nP", "-a", "-p", "41", "-d", "cwd", "-Fn"],
      },
      {
        command: TEST_UNIX_TOOL_PATHS.lsof,
        arguments_: ["-nP", "-iTCP:1420", "-sTCP:LISTEN"],
      },
    ]);
  });

  it("submits one prepared receipt-bound Hmux operation", async () => {
    const root = "/repo/.worktrees/live";
    const channel = "dev-live-1234567890";
    const sourceGeneration = "a".repeat(64);
    const requestGeneration = "b".repeat(32);
    const operationId = "1".repeat(64);
    const calls = [];
    const parentGeneration = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      type: "parent_generation_receipt",
      worktreeRoot: root,
      channel,
      sourceGeneration,
      supervisor: {
        pid: 41,
        processIdentity: "fixture-supervisor",
        generation: "c".repeat(64),
      },
      launch: {
        pid: 42,
        processIdentity: "fixture-launch",
        generation: "d".repeat(64),
      },
      observedAtMs: 10,
    };

    const result = await executeDevChainColdBootstrap(
      {
        root,
        channel,
        port: 1420,
        sourceGeneration,
        requestGeneration,
        operationId,
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        onOperationSubmitted: (submitted, command) =>
          calls.push(["submit", submitted, command]),
        timeoutMs: 1_000,
      },
      {
        resolveTools: () => TEST_UNIX_TOOL_CAPABILITY,
        prepare: (request) => {
          request.command = TEST_BOOTSTRAP_COMMAND;
          calls.push(["prepare", request]);
        },
        create: (request) => {
          calls.push(["create", request]);
          return {
            outcome: "created",
            sessionName: request.sessionName,
            sessionId: "session-cold-bootstrap",
            workspaceId: "workspace-cold-bootstrap",
          };
        },
        awaitParent: async (request) => {
          calls.push(["parent", request]);
          return parentGeneration;
        },
      },
    );

    expect(calls.map(([kind]) => kind)).toEqual([
      "prepare",
      "submit",
      "create",
      "parent",
    ]);
    expect(calls[0][1].unixTools.shellExecutable).toBe(
      TEST_UNIX_TOOL_PATHS.sh,
    );
    expect(calls[1]).toEqual([
      "submit",
      operationId,
      TEST_BOOTSTRAP_COMMAND,
    ]);
    expect(result).toMatchObject({
      kind: "cold_bootstrap",
      state: DEV_CHAIN_RESTART_STATE.RESTARTED,
      attempted: true,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: true,
      reason: "dev_launch_cold_bootstrap_receipt_verified",
      receipt: {
        schemaVersion: 1,
        type: "cold_bootstrap_receipt",
        requestGeneration,
        hmux: {
          sessionId: "session-cold-bootstrap",
          workspaceId: "workspace-cold-bootstrap",
        },
        parentGeneration,
      },
    });
  });

  it("keeps one operation-scoped recipe name across replay and changes it for a successor", async () => {
    const root = "/repo/.worktrees/live";
    const channel = "dev-live-1234567890";
    const sourceGeneration = "a".repeat(64);
    const sessionNames = [];
    const parentIdentities = [];

    const attempts = [
      { requestGeneration: "b".repeat(32), operationId: "1".repeat(64) },
      { requestGeneration: "c".repeat(32), operationId: "1".repeat(64) },
      { requestGeneration: "d".repeat(32), operationId: "2".repeat(64) },
    ];
    for (const { requestGeneration, operationId } of attempts) {
      const result = await executeDevChainColdBootstrap(
        {
          root,
          channel,
          port: 1420,
          sourceGeneration,
          requestGeneration,
          operationId,
          ...TEST_BOOTSTRAP_TERMINAL_SIZE,
          timeoutMs: 1_000,
        },
        {
          resolveTools: () => TEST_UNIX_TOOL_CAPABILITY,
          prepare: (request) => {
            request.command = TEST_BOOTSTRAP_COMMAND;
          },
          create: (request) => {
            sessionNames.push(request.sessionName);
            return {
              outcome: "created",
              sessionName: request.sessionName,
              sessionId: `session-${requestGeneration}`,
              workspaceId: "workspace-cold-bootstrap",
            };
          },
          awaitParent: async (request) => {
            parentIdentities.push(request.hmuxProviderIdentity);
            throw new Error("fixture app launch did not become ready");
          },
        },
      );

      expect(result).toMatchObject({
        kind: "cold_bootstrap",
        state: DEV_CHAIN_RESTART_STATE.PENDING,
        relaunchDispatched: true,
        reason:
          "dev_launch_cold_bootstrap_parent_unavailable: fixture app launch did not become ready",
        receipt: {
          type: "cold_bootstrap_dispatched",
          requestGeneration,
        },
      });
    }

    expect(sessionNames[0]).toBe(sessionNames[1]);
    expect(sessionNames[2]).not.toBe(sessionNames[1]);
    expect(parentIdentities).toEqual([
      {
        sessionId: `session-${"b".repeat(32)}`,
        workspaceId: "workspace-cold-bootstrap",
      },
      {
        sessionId: `session-${"c".repeat(32)}`,
        workspaceId: "workspace-cold-bootstrap",
      },
      {
        sessionId: `session-${"d".repeat(32)}`,
        workspaceId: "workspace-cold-bootstrap",
      },
    ]);
  });

  it("defers a pending exact Hmux operation and converges on its replay", async () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), "dure-dev-cold-home-"));
    const root = mkdtempSync(join(tmpdir(), "dure-dev-cold-root-"));
    const capture = join(fixtureHome, "hmux-invocation.json");
    const reconcileCapability = join(
      fixtureHome,
      "hmux-reconcile-capability",
    );
    const retireCapability = join(fixtureHome, "hmux-retire-capability");
    const channel = "dev-live-cold-fixture";
    const sourceGeneration = "e".repeat(64);
    const operationId = "3".repeat(64);
    mkdirSync(join(root, "hmux"), { recursive: true });
    mkdirSync(join(root, "crates", "hebbian-process-sampler"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "hmux", "Cargo.toml"),
      '[workspace.package]\nversion = "0.1.4"\n',
    );
    writeFileSync(join(root, "hmux", "fixture.rs"), "fixture\n");
    writeFileSync(
      join(root, "crates", "hebbian-process-sampler", "fixture.rs"),
      "fixture\n",
    );
    for (const input of HMUX_DEV_RUNTIME_INPUTS) {
      if (input.recursive) continue;
      const pathname = join(root, input.path);
      mkdirSync(dirname(pathname), { recursive: true });
      writeFileSync(
        pathname,
        input.path === "rust-toolchain.toml"
          ? readFileSync("rust-toolchain.toml")
          : `${input.path}\n`,
      );
    }
    const paths = devHmuxToolPaths(fixtureHome, channel);
    const buildId = targetDevHmuxBuildId({ root, home: fixtureHome });
    const version = join(paths.installRoot, "versions", buildId);
    const hmux = join(version, "bin", "hmux");
    const hmuxRuntime = join(version, "bin", "hmux-runtime");
    mkdirSync(join(version, "bin"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(version, "install.json"),
      `${JSON.stringify({ schemaVersion: 1, buildId })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      hmux,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "capabilities") {
  process.stdout.write(JSON.stringify({
    schemaVersion: 2,
    buildInfo: { buildId: ${JSON.stringify(buildId)}, source: "hmux_cli" },
    capabilities: [
      ${JSON.stringify(DEV_HMUX_STANDALONE_OPERATION_CAPABILITY)},
      ...(fs.existsSync(${JSON.stringify(reconcileCapability)})
        ? [${JSON.stringify(DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY)}]
        : []),
      ...(fs.existsSync(${JSON.stringify(retireCapability)})
        ? [${JSON.stringify(DEV_HMUX_STANDALONE_RETIRE_CAPABILITY)}]
        : []),
    ],
  }));
  process.exit(0);
}
const frame = fs.readFileSync(0);
const length = frame.readUInt32BE(0);
if (length < 1 || frame.length !== length + 4) process.exit(2);
const request = JSON.parse(frame.subarray(4).toString("utf8"));
const invocation = {
  args,
  request,
  cwd: process.cwd(),
  home: process.env.HOME,
  claudeCode: process.env.CLAUDECODE ?? null,
  hmuxDiscoveryRoot: process.env.HMUX_DISCOVERY_ROOT ?? null,
};
const previous = fs.existsSync(${JSON.stringify(capture)})
  ? JSON.parse(fs.readFileSync(${JSON.stringify(capture)}, "utf8"))
  : { calls: [] };
const calls = [...previous.calls, invocation];
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ calls }));
if (request.mode === ${JSON.stringify(
  DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
)}) {
  const payload = Buffer.from(JSON.stringify({
    outcome: "retired",
    schemaVersion: 1,
    operationId: request.operationId,
    sessionName: request.sessionName,
    sessionId: "standalone_" + request.operationId,
    workspaceId: "workspace-system-cold-bootstrap",
  }));
  const response = Buffer.allocUnsafe(payload.length + 4);
  response.writeUInt32BE(payload.length);
  payload.copy(response, 4);
  process.stdout.write(response);
  process.exit(0);
}
if (calls.length === 1) process.exit(7);
if (calls.length === 2) {
  process.stdout.write(Buffer.from([0, 0, 0, 1, 123]));
  process.exit(0);
}
const payload = Buffer.from(JSON.stringify({
  outcome: calls.length === 3 ? "pending" : "created",
  schemaVersion: 1,
  operationId: request.operationId,
  ...(calls.length === 3
    ? { errorCode: "hmux_standalone_recovery_target_unavailable" }
    : {
        sessionName: request.sessionName,
        sessionId: "standalone_" + request.operationId,
        workspaceId: "workspace-system-cold-bootstrap",
      }),
}));
const response = Buffer.allocUnsafe(payload.length + 4);
response.writeUInt32BE(payload.length);
payload.copy(response, 4);
process.stdout.write(response);
`,
      { mode: 0o700 },
    );
    writeFileSync(
      hmuxRuntime,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  buildId: ${JSON.stringify(buildId)},
  source: "hmux_runtime",
}));
`,
      { mode: 0o700 },
    );
    chmodSync(hmux, 0o700);
    chmodSync(hmuxRuntime, 0o700);
    const previousClaudeCode = process.env.CLAUDECODE;
    const previousDiscoveryRoot = process.env.HMUX_DISCOVERY_ROOT;
    const previousDureHome = process.env.DURE_HOME;
    process.env.DURE_HOME = join(fixtureHome, "portable-app-home");
    process.env.CLAUDECODE = "agent-parent";
    process.env.HMUX_DISCOVERY_ROOT = "/tmp/request-pane-catalog";
    try {
      const options = {
        root,
        channel,
        port: 1420,
        sourceGeneration,
        requestGeneration: "f".repeat(32),
        operationId,
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        timeoutMs: 5_000,
        home: fixtureHome,
      };
      const adapter = {
        resolveTools: () => TEST_UNIX_TOOL_CAPABILITY,
        awaitParent: ({ requestGeneration }) => ({
          schemaVersion: 1,
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          type: "parent_generation_receipt",
          worktreeRoot: root,
          channel,
          sourceGeneration,
          supervisor: {
            pid: 51,
            processIdentity: requestGeneration,
            generation: "1".repeat(64),
          },
          launch: {
            pid: 52,
            processIdentity: "fixture-launch",
            generation: "2".repeat(64),
          },
        }),
      };
      const unsupportedReconciliation = await executeDevChainColdBootstrap(
        {
          ...options,
          mode:
            DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
          command: TEST_BOOTSTRAP_COMMAND,
        },
        adapter,
      );
      expect(unsupportedReconciliation).toMatchObject({
        state: DEV_CHAIN_RESTART_STATE.FAILED,
        attempted: false,
        reason: expect.stringContaining(
          "development Hmux target build is not self-consistent",
        ),
      });
      const nonzero = await executeDevChainColdBootstrap(options, adapter);
      const malformed = await executeDevChainColdBootstrap(options, adapter);
      const pending = await executeDevChainColdBootstrap(options, adapter);
      for (const ambiguous of [nonzero, malformed, pending]) {
        expect(ambiguous).toMatchObject({
          state: DEV_CHAIN_RESTART_STATE.PENDING,
          attempted: true,
          relaunchDispatched: true,
        });
      }
      expect(pending.reason).toContain(
        "hmux_standalone_recovery_target_unavailable",
      );

      const result = await executeDevChainColdBootstrap(options, adapter);
      expect(result.state).toBe(DEV_CHAIN_RESTART_STATE.RESTARTED);
      const { calls } = JSON.parse(readFileSync(capture, "utf8"));
      expect(calls).toHaveLength(4);
      expect(calls.map(({ request }) => request)).toEqual([
        calls[0].request,
        calls[0].request,
        calls[0].request,
        calls[0].request,
      ]);
      const invocation = calls[3];
      const node = resolvePinnedDevNodeTool({ root, home: fixtureHome });

      const discoveryRoot = join(
        fixtureHome,
        ".dure",
        "state",
        "dev-launch-hosts",
      );
      expect(invocation.cwd).toBe(realpathSync(root));
      expect(invocation.home).toBe(fixtureHome);
      expect(invocation.claudeCode).toBeNull();
      expect(invocation.hmuxDiscoveryRoot).toBeNull();
      expect(invocation.args).toEqual([
        "--discovery-root",
        discoveryRoot,
        "internal-standalone-create-operation",
      ]);
      expect(invocation.request).toEqual({
        schemaVersion: 1,
        operationId,
        sessionName: result.receipt.hmux.sessionName,
        command: [
          TEST_UNIX_TOOL_PATHS.env,
          "-u",
          "HMUX_DISCOVERY_ROOT",
          `DURE_HOME=${join(fixtureHome, "portable-app-home")}`,
          `PATH=${node.binDirectory}:${process.env.PATH ?? ""}`,
          "DURE_DEV_PORT=1420",
          `${POSIX_SHELL_EXECUTABLE_ENV}=${TEST_UNIX_TOOL_PATHS.sh}`,
          `${PACKAGE_SCRIPT_SHELL_ENV}=${TEST_UNIX_TOOL_PATHS.sh}`,
          node.nodeExecutable,
          join(root, "scripts", "run-dev-app.mjs"),
        ],
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
      });

      writeFileSync(reconcileCapability, "enabled\n");
      const reconciled = await executeDevChainColdBootstrap(
        {
          ...options,
          mode:
            DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
          command: invocation.request.command,
          hmuxBuildId: buildId,
        },
        adapter,
      );
      expect(reconciled).toMatchObject({
        state: DEV_CHAIN_RESTART_STATE.RESTARTED,
        hmuxOutcome: "created",
        receipt: {
          type: "cold_bootstrap_receipt",
          hmux: {
            sessionName: result.receipt.hmux.sessionName,
            sessionId: `standalone_${operationId}`,
            workspaceId: "workspace-system-cold-bootstrap",
          },
        },
      });
      const reconciledCalls = JSON.parse(readFileSync(capture, "utf8")).calls;
      expect(reconciledCalls).toHaveLength(5);
      expect(reconciledCalls[4].request).toEqual({
        ...invocation.request,
        mode:
          DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
      });

      writeFileSync(retireCapability, "enabled\n");
      writeFileSync(join(root, "hmux", "fixture.rs"), "successor fixture\n");
      expect(targetDevHmuxBuildId({ root, home: fixtureHome })).not.toBe(
        buildId,
      );
      const explicitlyRetired = await executeDevChainColdBootstrap(
        {
          ...options,
          mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
          command: invocation.request.command,
          hmuxBuildId: buildId,
        },
        adapter,
      );
      expect(explicitlyRetired).toMatchObject({
        state: DEV_CHAIN_RESTART_STATE.PENDING,
        hmuxOutcome: "retired",
      });
      const retireCalls = JSON.parse(readFileSync(capture, "utf8")).calls;
      expect(retireCalls).toHaveLength(6);
      expect(retireCalls[5].request).toEqual({
        ...invocation.request,
        mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
      });
    } finally {
      if (previousDureHome === undefined) delete process.env.DURE_HOME;
      else process.env.DURE_HOME = previousDureHome;
      if (previousClaudeCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = previousClaudeCode;
      if (previousDiscoveryRoot === undefined) {
        delete process.env.HMUX_DISCOVERY_ROOT;
      } else {
        process.env.HMUX_DISCOVERY_ROOT = previousDiscoveryRoot;
      }
      rmSync(fixtureHome, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replays a submitted operation without reinterpreting chain presence", async () => {
    let creates = 0;
    const result = await executeDevChainColdBootstrap(
      {
        root: "/repo/.worktrees/live",
        channel: "dev-live-1234567890",
        port: 1420,
        sourceGeneration: "a".repeat(64),
        requestGeneration: "b".repeat(32),
        operationId: "4".repeat(64),
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        timeoutMs: 1_000,
      },
      {
        resolveTools: () => TEST_UNIX_TOOL_CAPABILITY,
        prepare: (request) => {
          request.command = TEST_BOOTSTRAP_COMMAND;
        },
        inspect: () => {
          throw new Error("replay must not inspect replaceable chain state");
        },
        create: () => {
          creates += 1;
          return {
            outcome: "pending",
            errorCode: "hmux_standalone_recovery_target_unavailable",
          };
        },
      },
    );

    expect(creates).toBe(1);
    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.PENDING,
      hmuxOutcome: "pending",
    });
  });

  it("leaves retirement acknowledgement to its dedicated action", async () => {
    let adapterCalls = 0;
    const result = await executeDevChainColdBootstrap(
      {
        root: "/repo/.worktrees/live",
        channel: "dev-live-1234567890",
        requestGeneration: "b".repeat(32),
        operationId: "4".repeat(64),
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        mode:
          DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
        timeoutMs: 1_000,
      },
      {
        prepare: () => {
          adapterCalls += 1;
        },
        create: () => {
          adapterCalls += 1;
          return { outcome: "acknowledged" };
        },
      },
    );

    expect(adapterCalls).toBe(0);
    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
      attempted: false,
      reason: expect.stringContaining(
        "retirement acknowledgement is not a cold-bootstrap action",
      ),
    });
  });

  it.each([
    DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
    DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
  ])("requires the saved command before a %s replay", async (mode) => {
    let adapterCalls = 0;
    const result = await executeDevChainColdBootstrap(
      {
        root: "/repo/.worktrees/live",
        channel: "dev-live-1234567890",
        port: 1420,
        sourceGeneration: "a".repeat(64),
        requestGeneration: "b".repeat(32),
        operationId: "4".repeat(64),
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        mode,
        timeoutMs: 1_000,
      },
      {
        prepare: () => {
          adapterCalls += 1;
        },
        create: () => {
          adapterCalls += 1;
          return { outcome: "pending" };
        },
      },
    );

    expect(adapterCalls).toBe(0);
    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
      attempted: false,
      reason: expect.stringContaining(
        "replay requires the saved standalone operation command",
      ),
    });
  });

  it.each([
    DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
    DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
  ])("carries the saved shell into %s replay preparation", async (mode) => {
    let preparedRequest;
    await executeDevChainColdBootstrap(
      {
        root: "/repo/.worktrees/live",
        channel: "dev-live-1234567890",
        port: 1420,
        sourceGeneration: "a".repeat(64),
        requestGeneration: "b".repeat(32),
        operationId: "4".repeat(64),
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        mode,
        command: [
          `${POSIX_SHELL_EXECUTABLE_ENV}=${TEST_UNIX_TOOL_PATHS.sh}`,
          ...TEST_BOOTSTRAP_COMMAND,
        ],
        timeoutMs: 1_000,
      },
      {
        resolveTools: () => {
          throw new Error("saved-command replay resolved ambient tools");
        },
        prepare: (request) => {
          preparedRequest = request;
        },
        create: () => ({ outcome: "pending" }),
      },
    );

    expect(preparedRequest.shellExecutable).toBe(TEST_UNIX_TOOL_PATHS.sh);
  });

  it("repairs a missing replay helper with the saved shell", async () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), "dure-replay-shell-home-"));
    const root = mkdtempSync(join(tmpdir(), "dure-replay-shell-root-"));
    const channel = "dev-replay-shell-1234567890";
    const buildId = "0.1.4+dev.replay-shell";
    const paths = devHmuxToolPaths(fixtureHome, channel);
    const version = join(paths.installRoot, "versions", buildId);
    const hmuxExecutable = join(version, "bin", "hmux");
    const selectedShell = join(root, "selected", "sh");
    const poisonDirectory = join(root, "poison");
    const poisonShell = join(poisonDirectory, "sh");
    const poisonReceipt = join(root, "ambient-shell-used");
    const capabilities = JSON.stringify({
      schemaVersion: 2,
      buildInfo: { buildId, source: "hmux_cli" },
      capabilities: [DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY],
    });
    mkdirSync(dirname(selectedShell), { recursive: true });
    mkdirSync(poisonDirectory, { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(selectedShell, '#!/bin/sh\nexec /bin/sh "$@"\n', {
      mode: 0o700,
    });
    writeFileSync(
      poisonShell,
      `#!/bin/sh\nprintf used >${JSON.stringify(poisonReceipt)}\nexit 97\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(root, "scripts", "run-with-build-storage.mjs"),
      `import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
if (process.argv[4] !== ${JSON.stringify(selectedShell)}) process.exit(61);
if (process.env.DURE_POSIX_SHELL !== ${JSON.stringify(selectedShell)}) process.exit(62);
mkdirSync(${JSON.stringify(join(version, "bin"))}, { recursive: true, mode: 0o700 });
writeFileSync(${JSON.stringify(join(version, "install.json"))}, ${JSON.stringify(`${JSON.stringify({ schemaVersion: 1, buildId })}\n`)}, { mode: 0o600 });
writeFileSync(${JSON.stringify(hmuxExecutable)}, ${JSON.stringify(`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(capabilities)});\n`)}, { mode: 0o700 });
chmodSync(${JSON.stringify(hmuxExecutable)}, 0o700);
`,
    );

    const previousPath = process.env.PATH;
    process.env.PATH = [
      poisonDirectory,
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(":");
    try {
      let preparedExecutable;
      const result = await executeDevChainColdBootstrap(
        {
          root,
          home: fixtureHome,
          channel,
          port: 1420,
          sourceGeneration: "a".repeat(64),
          requestGeneration: "b".repeat(32),
          operationId: "4".repeat(64),
          ...TEST_BOOTSTRAP_TERMINAL_SIZE,
          mode:
            DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
          command: [
            `${POSIX_SHELL_EXECUTABLE_ENV}=${selectedShell}`,
            ...TEST_BOOTSTRAP_COMMAND,
          ],
          hmuxBuildId: buildId,
          timeoutMs: 5_000,
        },
        {
          create: (request) => {
            preparedExecutable = request.hmuxExecutable;
            return {
              outcome: "pending",
              errorCode: "fixture_reconciliation_pending",
            };
          },
        },
      );

      expect(result).toMatchObject({
        state: DEV_CHAIN_RESTART_STATE.PENDING,
        hmuxErrorCode: "fixture_reconciliation_pending",
      });
      expect(preparedExecutable).toBe(realpathSync(hmuxExecutable));
      expect(existsSync(poisonReceipt)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(fixtureHome, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a caller-composed command for a fresh create", async () => {
    let adapterCalls = 0;
    const result = await executeDevChainColdBootstrap(
      {
        root: "/repo/.worktrees/live",
        channel: "dev-live-1234567890",
        port: 1420,
        sourceGeneration: "a".repeat(64),
        requestGeneration: "b".repeat(32),
        operationId: "4".repeat(64),
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        command: TEST_BOOTSTRAP_COMMAND,
        timeoutMs: 1_000,
      },
      {
        resolveTools: () => {
          adapterCalls += 1;
          return TEST_UNIX_TOOL_CAPABILITY;
        },
        prepare: () => {
          adapterCalls += 1;
        },
        create: () => {
          adapterCalls += 1;
        },
      },
    );

    expect(adapterCalls).toBe(0);
    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
      attempted: false,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      reason: expect.stringContaining(
        "fresh create command must be composed from resolved target tools",
      ),
    });
  });

  it("keeps ordinary reconciliation non-destructive for an active target", async () => {
    const operationId = "5".repeat(64);
    let targetActive = true;
    const result = await executeDevChainColdBootstrap(
      {
        root: "/repo/.worktrees/live",
        channel: "dev-live-1234567890",
        port: 1420,
        sourceGeneration: "a".repeat(64),
        requestGeneration: "b".repeat(32),
        operationId,
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
        command: TEST_BOOTSTRAP_COMMAND,
        timeoutMs: 1_000,
      },
      {
        resolveTools: () => {
          throw new Error("saved-command reconciliation resolved fresh tools");
        },
        prepare: () => {},
        create: (request) => {
          if (
            request.mode ===
            DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET
          ) {
            targetActive = false;
          }
          return {
            outcome: "created",
            sessionName: request.sessionName,
            sessionId: `standalone_${operationId}`,
            workspaceId: "workspace-active-target",
          };
        },
        awaitParent: (request) => ({
          schemaVersion: 1,
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          type: "parent_generation_receipt",
          worktreeRoot: request.root,
          channel: request.channel,
          sourceGeneration: request.sourceGeneration,
          supervisor: {
            pid: 51,
            processIdentity: "fixture-supervisor",
            generation: "c".repeat(64),
          },
          launch: {
            pid: 52,
            processIdentity: "fixture-launch",
            generation: "d".repeat(64),
          },
        }),
      },
    );

    expect(targetActive).toBe(true);
    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.RESTARTED,
      hmuxOutcome: "created",
      destructiveBoundaryCrossed: false,
    });
  });

  it("retries the exact retirement binding and preserves its terminal proof", async () => {
    const operationId = "5".repeat(64);
    const options = {
      root: "/repo/.worktrees/live",
      channel: "dev-live-1234567890",
      sourceGeneration: () => {
        throw new Error("retirement must not read parent source generation");
      },
      requestGeneration: "b".repeat(32),
      operationId,
      ...TEST_BOOTSTRAP_TERMINAL_SIZE,
      mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
      command: TEST_BOOTSTRAP_COMMAND,
      timeoutMs: 1_000,
    };
    const requests = [];
    const adapter = {
      resolveTools: () => {
        throw new Error("saved-command retirement resolved fresh tools");
      },
      prepare: () => {},
      create: (request) => {
        requests.push({
          operationId: request.operationId,
          sessionName: request.sessionName,
          command: request.command,
          initialRows: request.initialRows,
          initialColumns: request.initialColumns,
          mode: request.mode,
        });
        if (requests.length === 1) {
          throw new Error("retirement response was lost");
        }
        return {
          outcome: "retired",
          schemaVersion: 1,
          operationId,
          sessionName: request.sessionName,
          sessionId: `standalone_${operationId}`,
          workspaceId: "workspace-retired-target",
        };
      },
    };

    const pending = await executeDevChainColdBootstrap(options, adapter);
    const result = await executeDevChainColdBootstrap(options, adapter);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(pending).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.PENDING,
      destructiveBoundaryCrossed: null,
      relaunchDispatched: false,
      hmuxOutcome: "pending",
    });

    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.PENDING,
      destructiveBoundaryCrossed: true,
      relaunchDispatched: false,
      hmuxOutcome: "retired",
      reason: "dev_launch_cold_bootstrap_target_retired",
      receipt: {
        schemaVersion: 1,
        type: "cold_bootstrap_target_retired",
        requestGeneration: "b".repeat(32),
        hmux: {
          outcome: "retired",
          schemaVersion: 1,
          operationId,
          sessionName: expect.any(String),
          sessionId: `standalone_${operationId}`,
          workspaceId: "workspace-retired-target",
        },
      },
    });
  });

  it.each([
    {
      label: "refused",
      outcome: {
        outcome: "refused",
        errorCode: "hmux_standalone_recovery_name_conflict",
      },
      hmuxOutcome: "refused",
    },
    {
      label: "invalid created",
      outcome: {
        outcome: "created",
        sessionName: "must-not-create",
        sessionId: "standalone_must-not-create",
        workspaceId: "workspace-must-not-create",
      },
      hmuxOutcome: undefined,
    },
  ])("fails an explicitly retired target on $label output", async ({
    outcome,
    hmuxOutcome,
  }) => {
    const result = await executeDevChainColdBootstrap(
      {
        root: "/repo/.worktrees/live",
        channel: "dev-live-1234567890",
        port: 1420,
        sourceGeneration: "a".repeat(64),
        requestGeneration: "b".repeat(32),
        operationId: "7".repeat(64),
        ...TEST_BOOTSTRAP_TERMINAL_SIZE,
        mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
        command: TEST_BOOTSTRAP_COMMAND,
        timeoutMs: 1_000,
      },
      {
        prepare: () => {},
        create: () => outcome,
      },
    );

    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.FAILED,
      relaunchDispatched: false,
      ...(hmuxOutcome ? { hmuxOutcome } : {}),
    });
  });
});

describe("executeDevChainRetirementAcknowledgement", () => {
  const root = "/repo/.worktrees/live";
  const channel = "dev-live-1234567890";
  const operationId = "6".repeat(64);
  const hmuxBuildId = "0.1.4+dev.0123456789abcdef.0123456789ab";
  const binding = {
    operationId,
    sessionName: coldBootstrapSessionName({ root, channel, operationId }),
    command: TEST_BOOTSTRAP_COMMAND,
    ...TEST_BOOTSTRAP_TERMINAL_SIZE,
  };

  it("carries the saved shell into acknowledgement preparation", async () => {
    let preparedRequest;
    await executeDevChainRetirementAcknowledgement(
      {
        root,
        channel,
        requestGeneration: "b".repeat(32),
        binding: {
          ...binding,
          command: [
            `${POSIX_SHELL_EXECUTABLE_ENV}=${TEST_UNIX_TOOL_PATHS.sh}`,
            ...binding.command,
          ],
        },
        timeoutMs: 1_000,
      },
      {
        resolveTools: () => {
          throw new Error("acknowledgement resolved ambient tools");
        },
        prepare: (request) => {
          preparedRequest = request;
        },
        create: () => ({ outcome: "pending" }),
      },
    );

    expect(preparedRequest.shellExecutable).toBe(TEST_UNIX_TOOL_PATHS.sh);
  });

  it("dispatches one acknowledge-only operation without creating or awaiting", async () => {
    const calls = [];
    const result = await executeDevChainRetirementAcknowledgement(
      {
        root,
        channel,
        requestGeneration: "b".repeat(32),
        binding,
        hmuxBuildId,
        timeoutMs: 1_000,
      },
      {
        resolveTools: () => {
          throw new Error("acknowledgement resolved fresh tools");
        },
        prepare: (request) =>
          calls.push([
            "prepare",
            request.mode,
            request.initialRows,
            request.initialColumns,
            request.hmuxBuildId,
          ]),
        create: (request) => {
          calls.push([
            "create",
            request.mode,
            request.initialRows,
            request.initialColumns,
            request.hmuxBuildId,
          ]);
          return {
            outcome: "acknowledged",
            schemaVersion: 1,
            operationId,
          };
        },
        awaitParent: () => {
          throw new Error("acknowledgement must not await a parent");
        },
      },
    );

    expect(DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY).toBe(
      "standalone_create_operation_retirement_acknowledge_v1",
    );
    expect(calls).toEqual([
      [
        "prepare",
        DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
        TEST_BOOTSTRAP_TERMINAL_SIZE.initialRows,
        TEST_BOOTSTRAP_TERMINAL_SIZE.initialColumns,
        hmuxBuildId,
      ],
      [
        "create",
        DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
        TEST_BOOTSTRAP_TERMINAL_SIZE.initialRows,
        TEST_BOOTSTRAP_TERMINAL_SIZE.initialColumns,
        hmuxBuildId,
      ],
    ]);
    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.CONVERGED,
      hmuxOutcome: "acknowledged",
      receipt: {
        type: "cold_bootstrap_retirement_acknowledged",
        hmux: { outcome: "acknowledged", operationId },
      },
    });
  });

  it.each([
    {
      outcome: {
        outcome: "pending",
        errorCode: "hmux_standalone_recovery_target_unavailable",
      },
      state: DEV_CHAIN_RESTART_STATE.PENDING,
    },
    {
      outcome: {
        outcome: "refused",
        errorCode: "hmux_standalone_recovery_name_conflict",
      },
      state: DEV_CHAIN_RESTART_STATE.FAILED,
    },
    {
      outcome: {
        outcome: "created",
        sessionName: binding.sessionName,
        sessionId: `standalone_${operationId}`,
        workspaceId: "must-not-create",
      },
      state: DEV_CHAIN_RESTART_STATE.PENDING,
    },
  ])("keeps $outcome.outcome from clearing the acknowledgement", async ({
    outcome,
    state,
  }) => {
    const result = await executeDevChainRetirementAcknowledgement(
      {
        root,
        channel,
        requestGeneration: "b".repeat(32),
        binding,
        timeoutMs: 1_000,
      },
      {
        prepare: () => {},
        create: () => outcome,
      },
    );

    expect(result.state).toBe(state);
    expect(result.hmuxOutcome).not.toBe("acknowledged");
  });
});

describe("executeDevChainRestart", () => {
  it("exact launcher supervisor에만 restart를 요청하고 receipt를 검증한다", async () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), "dure-dev-restart-"));
    const worktreeRoot = "/repo/.worktrees/live";
    const channel = "dev-live-1234567890";
    const controlDirectory = appControlDirectory(fixtureHome, channel);
    const socketPath = join(fixtureHome, "supervisor.sock");
    const descriptorPath = join(
      controlDirectory,
      "dev-launch-supervisor-v1.json",
    );
    const supervisor = {
      pid: process.pid,
      processIdentity: processIdentity(process.pid),
      generation: "a".repeat(64),
    };
    const launch = {
      pid: 4321,
      processIdentity: "fixture-child-one",
      generation: "c".repeat(64),
    };
    const capability = "b".repeat(64);
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    const requests = [];
    const server = createServer((connection) => {
      let body = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk) => {
        body += chunk;
        const newline = body.indexOf("\n");
        if (newline === -1) return;
        const request = JSON.parse(body.slice(0, newline));
        requests.push(request);
        if (request.type === "restart_ack") {
          connection.end(
            `${JSON.stringify({
              schemaVersion: 1,
              protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
              type: "restart_acknowledged",
              requestId: request.requestId,
              worktreeRoot,
              channel,
              supervisor,
            })}\n`,
          );
          return;
        }
        connection.end(
          `${JSON.stringify({
            schemaVersion: 1,
            protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
            type: "restart_receipt",
            requestId: request.requestId,
            worktreeRoot,
            channel,
            supervisor,
            previousLaunch: launch,
            launch: {
              pid: 5432,
              processIdentity: "fixture-child-two",
              generation: "d".repeat(64),
            },
            restartedAtMs: Date.now(),
          })}\n`,
        );
      });
    });

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      chmodSync(socketPath, 0o600);
      writeFileSync(
        descriptorPath,
        `${JSON.stringify({
          schemaVersion: 1,
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          state: "ready",
          worktreeRoot,
          channel,
          socketPath,
          capability,
          supervisor,
          launch,
        })}\n`,
        { mode: 0o600 },
      );

      const result = await executeDevChainRestart({
        root: worktreeRoot,
        channel,
        home: fixtureHome,
        timeoutMs: 2_000,
      });

      expect(requests.map(({ type }) => type)).toEqual([
        "restart",
        "restart_ack",
      ]);
      expect(requests[0]).toMatchObject({
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        type: "restart",
        worktreeRoot,
        channel,
        capability,
        supervisor,
        expectedLaunch: launch,
      });
      expect(result).toMatchObject({
        state: DEV_CHAIN_RESTART_STATE.RESTARTED,
        attempted: true,
        destructiveBoundaryCrossed: true,
        relaunchDispatched: true,
        restartRequestId: requests[0].requestId,
        receipt: {
          worktreeRoot,
          channel,
          supervisor,
          previousLaunch: launch,
          launch: { generation: "d".repeat(64) },
        },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(fixtureHome, { recursive: true, force: true });
    }
  });

  it.each([false, true, null])(
    "projects restart failure boundary %s with its operation id",
    async (destructiveBoundaryCrossed) => {
      const fixtureHome = mkdtempSync(join(tmpdir(), "dure-dev-restart-failure-"));
      const worktreeRoot = "/repo/.worktrees/live";
      const channel = "dev-live-failure-1234567890";
      const controlDirectory = appControlDirectory(fixtureHome, channel);
      const socketPath = join(fixtureHome, "supervisor.sock");
      const descriptorPath = join(
        controlDirectory,
        "dev-launch-supervisor-v1.json",
      );
      const supervisor = {
        pid: process.pid,
        processIdentity: processIdentity(process.pid),
        generation: "e".repeat(64),
      };
      const launch = {
        pid: 6543,
        processIdentity: "fixture-child",
        generation: "f".repeat(64),
      };
      const capability = "a".repeat(64);
      let requestId;
      mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
      chmodSync(controlDirectory, 0o700);
      const server = createServer((connection) => {
        let body = "";
        connection.setEncoding("utf8");
        connection.on("data", (chunk) => {
          body += chunk;
          const newline = body.indexOf("\n");
          if (newline === -1) return;
          const request = JSON.parse(body.slice(0, newline));
          requestId = request.requestId;
          connection.end(
            `${JSON.stringify({
              schemaVersion: 1,
              protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
              type: "restart_rejected",
              requestId,
              reason: "fixture restart failure",
              destructiveBoundaryCrossed,
            })}\n`,
          );
        });
      });

      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        chmodSync(socketPath, 0o600);
        writeFileSync(
          descriptorPath,
          `${JSON.stringify({
            schemaVersion: 1,
            protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
            state: "ready",
            worktreeRoot,
            channel,
            socketPath,
            capability,
            supervisor,
            launch,
            publishedAtMs: Date.now(),
          })}\n`,
          { mode: 0o600 },
        );

        await expect(
          executeDevChainRestart({
            root: worktreeRoot,
            channel,
            home: fixtureHome,
            timeoutMs: 2_000,
          }),
        ).resolves.toMatchObject({
          state: DEV_CHAIN_RESTART_STATE.FAILED,
          attempted: true,
          destructiveBoundaryCrossed,
          relaunchDispatched: false,
          restartRequestId: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(requestId).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        rmSync(fixtureHome, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      label: "managed ordinary terminal",
      session: {
        session_id: "ordinary-terminal",
        workspace_id: "workspace-current",
        session_class: "managed",
        providerConversationIdentity: null,
      },
    },
    {
      label: "managed Codex conversation",
      session: {
        session_id: "managed-conversation",
        workspace_id: "workspace-current",
        session_class: "managed",
        providerConversationIdentity: {
          provider_id: "codex",
          conversation_id: "conversation-current",
        },
      },
    },
    {
      label: "standalone Hmux terminal",
      session: {
        session_id: "standalone-terminal",
        workspace_id: "workspace-current",
        session_class: "standalone",
      },
    },
  ])("$label은 dev-launch authority가 아니므로 입력하지 않는다", ({ session }) => {
    const calls = [];
    const result = executeDevChainRestart({
      session,
      command: "cd '/repo/worktree' && corepack pnpm app:dev",
      wait: () => {},
      sendKeys: (keys) => calls.push(keys),
    });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
      attempted: false,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      reason: expect.stringContaining("dev_launch_supervisor_authority_unavailable"),
    });
  });
});

describe("executeDevParentReload", () => {
  it("converges through the authenticated parent generation when the target is already active", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dure-parent-active-fixture-"));
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-parent-active-1234567890";
    const sourceGeneration = "e".repeat(64);
    mkdirSync(worktreeRoot, { recursive: true });
    const fixture = await startDevLaunchEndpointFixture({
      fixtureRoot,
      home: fixtureHome,
      worktreeRoot,
      channel,
      capabilities: [
        "child_restart",
        "parent_reload",
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ],
      sourceGeneration,
      frontendIdentity: {
        pid: 6_543,
        processIdentity: "fixture-frontend",
        generation: "f".repeat(64),
      },
      onRequest({ request, connection, descriptorPath }) {
        if (request.type !== "parent_generation_probe") {
          connection.destroy(new Error("unexpected parent reload request"));
          return;
        }
        const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
        connection.end(`${JSON.stringify(parentGenerationFrame(descriptor))}\n`);
      },
    });
    try {
      await expect(
        executeDevParentReload({
          root: worktreeRoot,
          channel,
          home: fixtureHome,
          sourceGeneration,
          timeoutMs: 2_000,
        }),
      ).resolves.toMatchObject({
        kind: "parent_reload",
        state: "converged",
        attempted: false,
        destructiveBoundaryCrossed: false,
        relaunchDispatched: false,
        reason: "dev_launch_parent_generation_already_active",
        receipt: {
          type: "parent_generation_receipt",
          sourceGeneration,
        },
      });
      expect(fixture.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
      ]);
    } finally {
      await fixture.close();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("requires a cold bootstrap for a target Node runtime pin before IPC", async () => {
    const authorityAccessed = () => {
      throw new Error("cold bootstrap attempted to read IPC authority");
    };
    await expect(
      executeDevParentReload({
        parentStrategy: "cold_bootstrap",
        get root() {
          return authorityAccessed();
        },
        get channel() {
          return authorityAccessed();
        },
        get sourceGeneration() {
          return authorityAccessed();
        },
      }),
    ).resolves.toMatchObject({
      kind: "parent_reload",
      attempted: false,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      reason: expect.stringMatching(/^cold_bootstrap_required:/),
    });
  });
});

describe("prepareDevLaunchCheckout", () => {
  const request = {
    root: "/repo/.worktrees/live",
    channel: "dev-live-1234567890",
    home: "/fixture/home",
    port: 1420,
    parentStrategy: "exec_handoff",
    allowColdBootstrap: true,
    timeoutMs: 1_000,
  };
  const preparingParent = (overrides = {}) => ({
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    state: "preparing",
    sourceGeneration: "a".repeat(64),
    capabilities: [
      "child_restart",
      PARENT_RELOAD_CAPABILITY,
      DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
    ],
    launch: { generation: "b".repeat(64) },
    frontend: { generation: "c".repeat(64) },
    ...overrides,
  });

  it("admits an exact current parent without consulting bootstrap state", async () => {
    const calls = [];
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async (value) => calls.push(["observe", value]),
        resolveTools: () => {
          throw new Error("current parent resolved cold-bootstrap tools");
        },
        inspect: () => calls.push(["inspect"]),
      }),
    ).resolves.toEqual({ admitted: true });
    expect(calls.map(([kind]) => kind)).toEqual(["observe"]);
    expect(calls[0][1]).toMatchObject({
      requireParentReloadAuthority: true,
      requireFrontendAuthority: true,
    });
    expect(calls[0][1]).not.toHaveProperty("sourceGeneration");
  });

  it("repairs one exact preparing parent before considering cold bootstrap", async () => {
    const calls = [];
    let ready = false;
    const preparing = preparingParent();
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async () => {
          calls.push("observe");
          if (!ready) throw new Error("parent projection is preparing");
        },
        observeRestart: async () => {
          calls.push("observeRestart");
          return preparing;
        },
        restart: async (options) => {
          calls.push("restart");
          expect(options.expectedAuthority).toBe(preparing);
          ready = true;
          return {
            kind: "child_restart",
            state: DEV_CHAIN_RESTART_STATE.RESTARTED,
            attempted: true,
            destructiveBoundaryCrossed: true,
            relaunchDispatched: true,
            reason: "dev_launch_supervisor_restart_receipt_verified",
          };
        },
        resolveTools: () => {
          throw new Error("exact repair resolved cold-bootstrap tools");
        },
        inspect: () => {
          throw new Error("exact repair inspected process census");
        },
      }),
    ).resolves.toMatchObject({
      admitted: true,
      recoveryTransition: {
        kind: "child_restart",
        state: DEV_CHAIN_RESTART_STATE.RESTARTED,
        destructiveBoundaryCrossed: true,
      },
    });
    expect(calls).toEqual([
      "observe",
      "observeRestart",
      "restart",
      "observe",
    ]);
  });

  it("accepts a concurrent repair after its observed restart binding goes stale", async () => {
    const calls = [];
    const preparing = preparingParent();
    let ready = false;
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async () => {
          calls.push("observe");
          if (!ready) throw new Error("parent projection is preparing");
        },
        observeRestart: async () => {
          calls.push("observeRestart");
          return preparing;
        },
        restart: async (options) => {
          calls.push("restart");
          expect(options.expectedAuthority).toBe(preparing);
          ready = true;
          return {
            kind: "child_restart",
            state: DEV_CHAIN_RESTART_STATE.FAILED,
            attempted: true,
            destructiveBoundaryCrossed: false,
            relaunchDispatched: false,
            reason: "dev_launch_supervisor_restart_failed: stale binding",
          };
        },
        resolveTools: () => {
          throw new Error("concurrent repair resolved cold-bootstrap tools");
        },
        inspect: () => {
          throw new Error("concurrent repair inspected process census");
        },
      }),
    ).resolves.toMatchObject({
      admitted: true,
      recoveryTransition: {
        kind: "child_restart",
        state: DEV_CHAIN_RESTART_STATE.FAILED,
        destructiveBoundaryCrossed: false,
      },
    });
    expect(calls).toEqual([
      "observe",
      "observeRestart",
      "restart",
      "observe",
    ]);
  });

  it("reports a failed child repair through the parent preparation contract", async () => {
    const recovery = {
      kind: "child_restart",
      state: DEV_CHAIN_RESTART_STATE.FAILED,
      attempted: true,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      reason: "dev_launch_supervisor_restart_failed: fixture failure",
    };
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async () => {
          throw new Error("parent projection is preparing");
        },
        observeRestart: async () => preparingParent(),
        restart: async () => recovery,
      }),
    ).resolves.toEqual({
      admitted: false,
      transition: {
        kind: "parent_reload",
        state: DEV_CHAIN_RESTART_STATE.FAILED,
        attempted: true,
        destructiveBoundaryCrossed: false,
        relaunchDispatched: false,
        reason: recovery.reason,
        recoveryTransition: recovery,
      },
    });
  });

  it("preserves a completed repair when parent observation still fails", async () => {
    const recovery = {
      kind: "child_restart",
      state: DEV_CHAIN_RESTART_STATE.RESTARTED,
      attempted: true,
      destructiveBoundaryCrossed: true,
      relaunchDispatched: true,
      reason: "dev_launch_supervisor_restart_receipt_verified",
      restartRequestId: "d".repeat(64),
      receipt: { type: "restart_receipt", requestId: "d".repeat(64) },
    };
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async () => {
          throw new Error("parent endpoint remained unavailable");
        },
        observeRestart: async () => preparingParent(),
        restart: async () => recovery,
      }),
    ).resolves.toEqual({
      admitted: false,
      transition: {
        kind: "parent_reload",
        state: DEV_CHAIN_RESTART_STATE.FAILED,
        attempted: true,
        destructiveBoundaryCrossed: true,
        relaunchDispatched: true,
        reason:
          "dev_launch_parent_authority_unavailable: parent endpoint remained unavailable",
        recoveryTransition: recovery,
      },
    });
  });

  it("does not restart a ready parent after an endpoint observation failure", async () => {
    let restarted = false;
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async () => {
          throw new Error("parent endpoint did not answer");
        },
        observeRestart: async () => ({
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          state: "ready",
          sourceGeneration: "a".repeat(64),
          capabilities: [
            "child_restart",
            PARENT_RELOAD_CAPABILITY,
            DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
          ],
          launch: { generation: "b".repeat(64) },
          frontend: { generation: "c".repeat(64) },
        }),
        restart: async () => {
          restarted = true;
          throw new Error("ready parent must not restart");
        },
        resolveTools: () => TEST_UNIX_TOOL_CAPABILITY,
        inspect: () => ({
          state: "present",
          reason: "an owned dev launch is still present",
        }),
      }),
    ).resolves.toMatchObject({
      admitted: false,
      transition: {
        state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
        attempted: false,
      },
    });
    expect(restarted).toBe(false);
  });

  it("admits cold bootstrap only after exact chain absence", async () => {
    const calls = [];
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async () => {
          calls.push(["observe"]);
          throw new Error("legacy parent");
        },
        resolveTools: () => TEST_UNIX_TOOL_CAPABILITY,
        inspect: (value) => {
          calls.push(["inspect", value]);
          return { state: "absent" };
        },
      }),
    ).resolves.toEqual({
      admitted: true,
      coldBootstrapToolCapability: TEST_UNIX_TOOL_CAPABILITY,
    });
    expect(calls.map(([kind]) => kind)).toEqual(["observe", "inspect"]);
    expect(calls[1][1]).toMatchObject({
      discoveryRoot: join(
        request.home,
        ".dure",
        "state",
        "dev-launch-hosts",
      ),
      toolCapability: TEST_UNIX_TOOL_CAPABILITY,
    });
  });

  it("rejects unavailable tools after proving exact chain absence", async () => {
    let inspected = false;
    const toolCapability = resolveUnixDevChainTools({
      platform: "linux",
      environment: { PATH: TEST_UNIX_BIN },
      resolveExecutablePath: (pathname) =>
        pathname === TEST_UNIX_TOOL_PATHS.ps ||
        pathname === TEST_UNIX_TOOL_PATHS.lsof
          ? pathname
          : null,
    });
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async () => {
          throw new Error("legacy parent");
        },
        resolveTools: () => toolCapability,
        inspect: () => {
          inspected = true;
          return { state: "absent" };
        },
      }),
    ).resolves.toMatchObject({
      admitted: false,
      transition: {
        state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
        attempted: false,
        destructiveBoundaryCrossed: false,
        relaunchDispatched: false,
        reason: expect.stringContaining("environment launch (env)"),
      },
    });
    expect(inspected).toBe(true);
  });

  it("admits an exact submitted operation replay without a second absence check", async () => {
    let inspected = false;
    await expect(
      prepareDevLaunchCheckout(
        { ...request, coldBootstrapReplay: true },
        {
          observe: async () => {
            throw new Error("legacy parent");
          },
          resolveTools: () => {
            throw new Error("submitted replay resolved fresh tools");
          },
          inspect: () => {
            inspected = true;
            return { state: "present" };
          },
        },
      ),
    ).resolves.toEqual({ admitted: true });
    expect(inspected).toBe(false);
  });

  it("rejects a legacy parent while an owned chain is still present", async () => {
    await expect(
      prepareDevLaunchCheckout(request, {
        observe: async () => {
          throw new Error("legacy parent");
        },
        resolveTools: () => TEST_UNIX_TOOL_CAPABILITY,
        inspect: () => ({
          state: "present",
          reason: "an owned dev launch is still present",
        }),
      }),
    ).resolves.toMatchObject({
      admitted: false,
      transition: {
        kind: "parent_reload",
        state: DEV_CHAIN_RESTART_STATE.NOT_STARTED,
        attempted: false,
        destructiveBoundaryCrossed: false,
        relaunchDispatched: false,
        reason: expect.stringMatching(
          /legacy parent.*owned dev launch is still present/,
        ),
      },
    });
  });
});

describe("hasOwnedDevLaunchProcess", () => {
  const root = "/repo/.worktrees/mine";
  const processes = [
    { pid: 10, command: "node scripts/run-dev-app.mjs" },
    { pid: 11, command: "node ./node_modules/@tauri-apps/cli/tauri.js dev --config {}" },
    { pid: 12, command: "node scripts/run-dev-app.mjs" },
  ];

  it("실제 run-dev-app·tauri CLI 형태를 같은 worktree launch로 본다", () => {
    expect(
      hasOwnedDevLaunchProcess(
        processes,
        root,
        (pid) =>
          pid === 10 || pid === 11 ? root : "/repo/.worktrees/other",
        fixtureWorktreeRoot,
      ),
    ).toBe(true);
  });

  it("다른 worktree의 동명 launcher는 제외한다", () => {
    expect(
      hasOwnedDevLaunchProcess(
        processes,
        root,
        () => "/repo/.worktrees/other",
        fixtureWorktreeRoot,
      ),
    ).toBe(false);
  });

  it("main root 아래 sibling worktree launcher도 main 소유로 오인하지 않는다", () => {
    expect(
      hasOwnedDevLaunchProcess(
        [{ pid: 13, command: "node scripts/run-dev-app.mjs" }],
        "/repo",
        () => "/repo/.worktrees/other",
        fixtureWorktreeRoot,
      ),
    ).toBe(false);
  });

  it("Vite와 비슷한 일반 node 프로세스는 launch가 아니다", () => {
    expect(
      hasOwnedDevLaunchProcess(
        [{ pid: 20, command: "node vite --host localhost" }],
        root,
        () => root,
      ),
    ).toBe(false);
  });
});

describe("gitWorktreeRootForPath", () => {
  it("main 아래 linked worktree의 가장 가까운 .git 경계를 반환한다", () => {
    const main = mkdtempSync(join(tmpdir(), "dure-worktree-owner-"));
    const linked = join(main, ".worktrees", "other");
    const cwd = join(linked, "src-tauri");
    try {
      mkdirSync(join(main, ".git"));
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(linked, ".git"), "gitdir: ../../.git/worktrees/other\n");

      expect(gitWorktreeRootForPath(cwd)).toBe(realpathSync(linked));
      expect(gitWorktreeRootForPath(main)).toBe(realpathSync(main));
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});

describe("ownedAppPid", () => {
  const root = "/repo/.worktrees/mine";
  const noCwd = () => undefined;

  it("절대경로로 뜬 앱은 경로만으로 소유를 판정한다", () => {
    expect(
      ownedAppPid(
        [{ pid: 11, command: `${root}/src-tauri/target/debug/dure` }],
        root,
        noCwd,
        fixtureWorktreeRoot,
      ),
    ).toBe(11);
  });

  // 2026-07-30 실기: tauri dev가 워크트리 안에서 띄우면 ps -o comm=이 상대경로를
  // 준다. 절대경로만 보던 구현은 이 형태를 놓쳐 자동 복구가 항상 물러났다.
  it("상대경로로 뜬 앱을 cwd로 찾아낸다", () => {
    expect(
      ownedAppPid(
        [{ pid: 22, command: "target/debug/dure" }],
        root,
        () => `${root}/src-tauri`,
        fixtureWorktreeRoot,
      ),
    ).toBe(22);
  });

  it("cwd가 워크트리 루트 자체여도 소유로 본다", () => {
    expect(
      ownedAppPid(
        [{ pid: 23, command: "target/debug/dure" }],
        root,
        () => root,
        fixtureWorktreeRoot,
      ),
    ).toBe(23);
  });

  it("macOS 개발용 Dure.app wrapper도 같은 worktree 앱으로 찾는다", () => {
    const command = `${root}/src-tauri/target/debug/.dure-dev/dev-mine-a1b2c3d4/Dure.app/Contents/MacOS/dure`;

    expect(
      ownedAppPid(
        [{ pid: 24, command }],
        root,
        noCwd,
        fixtureWorktreeRoot,
      ),
    ).toBe(24);
  });

  it("installed Dure.app은 cwd가 우연히 worktree여도 dev 소유로 보지 않는다", () => {
    expect(
      ownedAppPid(
        [{ pid: 25, command: "/Applications/Dure.app/Contents/MacOS/dure" }],
        root,
        () => `${root}/src-tauri`,
        fixtureWorktreeRoot,
      ),
    ).toBeNull();
  });

  // 남의 워크트리 앱도 같은 상대경로로 뜬다 — cwd 확인을 건너뛰면 그 앱을 죽인다.
  it("다른 워크트리의 앱은 소유가 아니다", () => {
    expect(
      ownedAppPid(
        [{ pid: 33, command: "target/debug/dure" }],
        root,
        () => "/repo/.worktrees/other/src-tauri",
        fixtureWorktreeRoot,
      ),
    ).toBeNull();
  });

  it("main root 아래 sibling worktree 앱도 main 소유로 오인하지 않는다", () => {
    expect(
      ownedAppPid(
        [{ pid: 34, command: "target/debug/dure" }],
        "/repo",
        () => "/repo/.worktrees/other/src-tauri",
        fixtureWorktreeRoot,
      ),
    ).toBeNull();
  });

  it("main root 아래 sibling의 절대경로 앱도 main 소유가 아니다", () => {
    expect(
      ownedAppPid(
        [
          {
            pid: 35,
            command:
              "/repo/.worktrees/other/src-tauri/target/debug/dure",
          },
        ],
        "/repo",
        noCwd,
        fixtureWorktreeRoot,
      ),
    ).toBeNull();
  });

  it("비슷한 이름의 다른 프로세스는 세지 않는다", () => {
    expect(
      ownedAppPid(
        [
          { pid: 41, command: "target/debug/dure-helper" },
          { pid: 43, command: "/Users/me/.local/bin/dure" },
          { pid: 42, command: "node scripts/run-dev-app.mjs" },
        ],
        root,
        () => root,
        fixtureWorktreeRoot,
      ),
    ).toBeNull();
  });

  // 모호하면 아무것도 하지 않는다 — 어느 쪽을 재기동해야 하는지 알 수 없다.
  it("소유 후보가 둘 이상이면 물러난다", () => {
    expect(
      ownedAppPid(
        [
          { pid: 51, command: "target/debug/dure" },
          { pid: 52, command: `${root}/src-tauri/target/debug/agent-ide` },
        ],
        root,
        () => root,
        fixtureWorktreeRoot,
      ),
    ).toBeNull();
  });

  it("cwd를 못 읽으면 소유로 보지 않는다", () => {
    expect(
      ownedAppPid(
        [{ pid: 61, command: "target/debug/dure" }],
        root,
        noCwd,
        fixtureWorktreeRoot,
      ),
    ).toBeNull();
  });

  it("migration 중인 agent-ide dev 앱도 계속 찾는다", () => {
    expect(
      ownedAppPid(
        [{ pid: 71, command: "target/debug/agent-ide" }],
        root,
        () => `${root}/src-tauri`,
        fixtureWorktreeRoot,
      ),
    ).toBe(71);
  });
});
