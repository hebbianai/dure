import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appControlDirectory,
  devHmuxToolPaths,
  worktreeDevIdentity,
} from "./lib/app-channel.mjs";
import { coldBootstrapSessionName } from "./lib/dev-cold-bootstrap-operation.mjs";
import { headTransitionTransactionId } from "./lib/dev-deploy-head-transition-journal.mjs";
import {
  attachDevDeployAttemptExecutor,
  beginDevDeployAttempt,
  enqueueDevDeploy,
  recordDevDeployAttemptPhase,
  recordDevDeployColdBootstrapSubmission,
  settleDevDeployAttempt,
} from "./lib/dev-deploy-queue.mjs";
import { DevDeployQueueStore } from "./lib/dev-deploy-queue-store.mjs";
import {
  DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
  DEV_HMUX_STANDALONE_OPERATION_MODE,
  DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY,
  DEV_HMUX_STANDALONE_RETIRE_CAPABILITY,
} from "./lib/dev-hmux-operation-contract.mjs";
import { targetDevHmuxBuildId } from "./lib/dev-hmux-tool.mjs";
import {
  DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
  parentGenerationFrame,
} from "./lib/dev-launch-contract.mjs";
import {
  DEV_PARENT_SOURCE_PATHS,
  devParentSourceGeneration,
} from "./lib/dev-launch-impact.mjs";
import { HMUX_DEV_RUNTIME_INPUTS } from "./lib/hmux-dev-build-inputs.mjs";
import {
  startConvergentDevLaunchParentFixture,
  startDevLaunchEndpointFixture,
} from "./lib/dev-launch-test-support.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";
import { rustToolchainTestEnvironment } from "./lib/rust-toolchain-test-environment.mjs";
import { checkpointWorktree } from "./lib/worktree-wip.mjs";

const script = fileURLToPath(new URL("./deploy-dev-app.mjs", import.meta.url));
const controlPlaneInstallerFixture = fileURLToPath(
  new URL(
    "./fixtures/install-dev-control-plane-payload.mjs",
    import.meta.url,
  ),
);
const fixtureEnvironment = scriptTestEnvironment();
beforeAll(() => {
  for (const [key, value] of Object.entries(rustToolchainTestEnvironment())) {
    vi.stubEnv(key, value);
  }
});
afterAll(() => vi.unstubAllEnvs());

let workspace;
let home;

const retirementReason = "replace the preserved divergent daily-driver head";
const retirementEvidence = "reviewed WIP checkpoint and retained current head";

function git(cwd, args) {
  // 픽스처 커밋은 서명 금지 — 1Password op-ssh-sign이 잠겨 있으면 머신
  // 전체 git commit이 실패한다 (AGENTS.md, incidents 2026-07-29).
  // 훅(pre-push) 아래에서 실행되면 GIT_DIR 등이 물려 들어와 픽스처 git이
  // "실제 리포"를 조작한다 — 2026-07-30 실측: verify 중 픽스처 커밋이 작업
  // 브랜치에 박혔다. AGENTS.md Git hooks 규칙 그대로 스크럽한다.
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "gpg.format=openpgp", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...fixtureEnvironment,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function commit(cwd, message) {
  return commitPath(cwd, "file.txt", `${message}\n`, message);
}

function commitPath(cwd, relativePath, contents, message) {
  mkdirSync(dirname(join(cwd, relativePath)), { recursive: true });
  writeFileSync(join(cwd, relativePath), contents);
  git(cwd, ["add", relativePath]);
  git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function createIntegratedDivergence() {
  const upstream = join(workspace, "upstream");
  const live = join(workspace, "live");
  const currentHead = commitPath(
    live,
    "file.txt",
    "integrated patch\n",
    "local task commit",
  );
  const targetHead = commitPath(
    upstream,
    "file.txt",
    "integrated patch\n",
    "coordinator reconstruction",
  );
  return { currentHead, live, targetHead };
}

function createConflictingRetirement() {
  const upstream = join(workspace, "upstream");
  const live = join(workspace, "live");
  const currentHead = commitPath(
    live,
    "file.txt",
    "local conflicting head\n",
    "local conflicting head",
  );
  writeFileSync(join(live, "preserved-wip.txt"), "preserved WIP\n");
  const checkpoint = checkpointWorktree(live);
  const targetHead = commitPath(
    upstream,
    "file.txt",
    "target conflicting head\n",
    "target conflicting head",
  );
  return { checkpoint, currentHead, live, targetHead };
}

function retireArguments(live, checkpoint, overrides = {}) {
  const values = {
    evidence: retirementEvidence,
    reason: retirementReason,
    wipRef: checkpoint?.ref,
    ...overrides,
  };
  return [
    "--live-worktree",
    live,
    "--json",
    "--force",
    "--retire-preserved-live-head",
    "--retire-reason",
    values.reason,
    "--retire-evidence",
    values.evidence,
    "--retire-wip-ref",
    values.wipRef,
    "--no-verify",
  ];
}

function withoutOption(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return args;
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function retainedRefFor(live, currentHead) {
  const { channel } = worktreeDevIdentity(realpathSync(live));
  return `refs/dure-dev-deploy/retained-v1/${channel}/${currentHead}`;
}

function adoptionTransaction({ live, currentHead, targetHead }) {
  git(live, ["fetch", "origin", "main", "--quiet"]);
  const root = realpathSync(live);
  const { channel } = worktreeDevIdentity(root);
  const mergeTree = git(live, [
    "merge-tree",
    "--write-tree",
    currentHead,
    targetHead,
  ]);
  const retainedRef = retainedRefFor(live, currentHead);
  const transactionId = createHash("sha256")
    .update(
      [root, channel, currentHead, targetHead, mergeTree, retainedRef].join("\0"),
    )
    .digest("hex");
  return {
    schemaVersion: 1,
    state: "planned",
    transactionId,
    root,
    channel,
    currentHead,
    targetHead,
    mergeTree,
    retainedRef,
  };
}

function retirementTransaction({ checkpoint, currentHead, live, targetHead }) {
  git(live, ["fetch", "origin", "main", "--quiet"]);
  const root = realpathSync(live);
  const { channel } = worktreeDevIdentity(root);
  const retainedRef = retainedRefFor(live, currentHead);
  const plan = {
    mode: "retire_preserved_head",
    reason: retirementReason,
    evidence: retirementEvidence,
    root,
    channel,
    currentHead,
    targetHead,
    retainedRef,
    wipCheckpoint: {
      ref: checkpoint.ref,
      object: checkpoint.object,
      base: checkpoint.base,
      worktree: checkpoint.worktree,
      operationId: checkpoint.ref.split("/").at(-1),
    },
  };
  return {
    schemaVersion: 2,
    state: "planned",
    ...plan,
    transactionId: headTransitionTransactionId(plan),
  };
}

function writeAdoptionJournal(transaction) {
  const directory = appControlDirectory(home, transaction.channel);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pathname = adoptionJournalPath(transaction);
  writeFileSync(pathname, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
  return pathname;
}

function adoptionJournalPath(transaction) {
  return join(
    appControlDirectory(home, transaction.channel),
    "dev-deploy-head-adoption-v1.json",
  );
}

function refExists(cwd, ref) {
  return (
    spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
      cwd,
      env: fixtureEnvironment,
    }).status === 0
  );
}

/** HOME을 격리해 잠금 파일이 실제 ~/.dure를 건드리지 않게 한다. */
function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...fixtureEnvironment, HOME: home, ...extraEnv },
  });
}

async function runAsync(args, extraEnv = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...fixtureEnvironment, HOME: home, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [status, signal] = await once(child, "close");
  return { status, signal, stdout, stderr };
}

function hiddenUnixToolsEnvironment(names) {
  const preload = join(workspace, `missing-${names.join("-")}.cjs`);
  writeFileSync(
    preload,
    `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { basename } = require("node:path");
const realpathSync = fs.realpathSync;
const hidden = new Set(${JSON.stringify(names)});
fs.realpathSync = function unavailableUnixTool(pathname, ...args) {
  if (
    typeof pathname === "string" &&
    hidden.has(basename(pathname))
  ) {
    const error = new Error("test fixture hid " + pathname);
    error.code = "ENOENT";
    throw error;
  }
  return Reflect.apply(realpathSync, this, [pathname, ...args]);
};
syncBuiltinESMExports();
`,
    { mode: 0o600 },
  );
  return {
    NODE_OPTIONS: [
      fixtureEnvironment.NODE_OPTIONS,
      `--require=${preload}`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function missingUnixProcessToolsEnvironment() {
  return hiddenUnixToolsEnvironment(["ps", "lsof", "env", "sh"]);
}

function alternateShellEnvironment() {
  const directory = join(workspace, "alternate-shell", "bin");
  const executable = join(directory, "sh");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'if [ -n "${DURE_TEST_SELECTED_SHELL_RECEIPT:-}" ]; then',
      '  printf "%s\\n" "${1:-}" >>"$DURE_TEST_SELECTED_SHELL_RECEIPT"',
      "fi",
      'exec /bin/sh "$@"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  return {
    executable,
    environment: {
      PATH: `${directory}:${fixtureEnvironment.PATH}`,
    },
  };
}

function addColdBootstrapBuildInputs(upstream, live) {
  mkdirSync(join(upstream, "hmux"), { recursive: true });
  writeFileSync(
    join(upstream, "hmux", "Cargo.toml"),
    '[workspace.package]\nversion = "0.1.4"\n',
  );
  writeFileSync(join(upstream, "hmux", "fixture.rs"), "fixture\n");
  mkdirSync(join(upstream, "crates", "hebbian-process-sampler"), {
    recursive: true,
  });
  writeFileSync(
    join(upstream, "crates", "hebbian-process-sampler", "fixture.rs"),
    "fixture\n",
  );
  for (const input of HMUX_DEV_RUNTIME_INPUTS) {
    if (input.recursive) continue;
    const pathname = join(upstream, input.path);
    if (existsSync(pathname)) continue;
    mkdirSync(dirname(pathname), { recursive: true });
    writeFileSync(
      pathname,
      input.path === "rust-toolchain.toml"
        ? readFileSync("rust-toolchain.toml")
        : `${input.path}\n`,
    );
  }
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "--quiet", "-m", "cold bootstrap inputs"]);
  git(live, ["pull", "--ff-only", "--quiet"]);
}

function installColdBootstrapHmuxFixture(live, outcomes) {
  const root = realpathSync(live);
  const { channel } = worktreeDevIdentity(root);
  const capture = join(home, "cold-bootstrap-hmux-calls.json");
  const paths = devHmuxToolPaths(home, channel);
  const buildId = targetDevHmuxBuildId({ root, home });
  const version = join(paths.installRoot, "versions", buildId);
  const hmux = join(version, "bin", "hmux");
  const runtime = join(version, "bin", "hmux-runtime");
  mkdirSync(join(version, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(version, "install.json"),
    `${JSON.stringify({ schemaVersion: 1, buildId })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    hmux,
    `#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "capabilities") {
  process.stdout.write(JSON.stringify({
    schemaVersion: 2,
    buildInfo: { buildId: ${JSON.stringify(buildId)}, source: "hmux_cli" },
    capabilities: [
      ${JSON.stringify(DEV_HMUX_STANDALONE_OPERATION_CAPABILITY)},
      ${JSON.stringify(DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY)},
      ${JSON.stringify(DEV_HMUX_STANDALONE_RETIRE_CAPABILITY)},
    ],
  }));
  process.exit(0);
}
const frame = fs.readFileSync(0);
const length = frame.readUInt32BE(0);
if (length < 1 || frame.length !== length + 4) process.exit(2);
const request = JSON.parse(frame.subarray(4).toString("utf8"));
const previous = fs.existsSync(${JSON.stringify(capture)})
  ? JSON.parse(fs.readFileSync(${JSON.stringify(capture)}, "utf8"))
  : { calls: [] };
const calls = [...previous.calls, {
  request,
  head: childProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim(),
}];
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ calls }));
const outcomes = ${JSON.stringify(outcomes)};
const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
const response = outcome === "retired"
  ? {
      outcome,
      schemaVersion: 1,
      operationId: request.operationId,
      sessionName: request.sessionName,
      sessionId: "standalone_" + request.operationId,
      workspaceId: "workspace-active-predecessor",
    }
  : {
      outcome,
      schemaVersion: 1,
      operationId: request.operationId,
      errorCode: outcome === "refused"
        ? "hmux_standalone_recovery_name_conflict"
        : "hmux_standalone_reconciliation_pending",
    };
const payload = Buffer.from(JSON.stringify(response));
const encoded = Buffer.allocUnsafe(payload.length + 4);
encoded.writeUInt32BE(payload.length);
payload.copy(encoded, 4);
process.stdout.write(encoded);
`,
    { mode: 0o700 },
  );
  writeFileSync(
    runtime,
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
  chmodSync(runtime, 0o700);
  return { capture, channel };
}

function createQueuedColdBootstrapRetry({
  live,
  sourceHead,
  targetHead,
  port,
  impact = {
    kind: "frontend_reload",
    backendChanged: false,
    changedPathCount: 1,
  },
  submitted = true,
}) {
  const root = realpathSync(live);
  const generation = "8".repeat(64);
  const entrypoint = join(
    workspace,
    "executors-v1",
    generation,
    "scripts",
    "deploy-dev-app.mjs",
  );
  mkdirSync(dirname(entrypoint), { recursive: true });
  symlinkSync(script, entrypoint);
  const transaction = {
    schemaVersion: 1,
    targetHead,
    targetAuthority: "origin/main",
    executor: { generation, entrypoint },
    selection: { sourceHead, impact },
  };
  const command = ["node", "scripts/run-dev-app.mjs"];
  let state = enqueueDevDeploy({
    worktree: root,
    attemptArgs: [
      "--live-worktree",
      root,
      "--port",
      String(port),
      "--force",
      "--no-verify",
    ],
    transaction,
    executionEnvironment: {
      HOME: home,
      PATH: fixtureEnvironment.PATH,
    },
    receipt: {
      action: "defer",
      currentHead: sourceHead,
      targetHead,
      impact,
    },
    nowMs: 1_000,
    maxWaitMs: 60_000,
    pollMs: 5_000,
  });
  state = beginDevDeployAttempt(state, 2_000);
  if (submitted) {
    const binding = {
      attemptId: state.activeAttempt.attemptId,
      attemptGeneration: state.generation,
      transaction,
    };
    state = attachDevDeployAttemptExecutor(state, {
      ...binding,
      executor: {
        pid: process.pid,
        processIdentity: "fixture-initial-executor",
        observedAtMs: 2_100,
      },
    });
    state = recordDevDeployAttemptPhase(state, {
      ...binding,
      observedAtMs: 2_101,
    });
    state = recordDevDeployColdBootstrapSubmission(state, {
      ...binding,
      operationId: state.activeAttempt.coldBootstrap.operationId,
      command,
      hmuxBuildId: targetDevHmuxBuildId({ root, home }),
      submittedAtMs: 2_102,
    });
    state = settleDevDeployAttempt(state, {
      attemptGeneration: state.generation,
      exitCode: 0,
      receipt: {
        deployReceiptVersion: 2,
        action: "defer",
        liveWorktree: root,
        transaction,
        currentHead: sourceHead,
        targetHead,
        impact,
      },
      nowMs: 3_000,
      pollMs: 5_000,
    });
    state = beginDevDeployAttempt(state, 8_000);
  }
  const store = new DevDeployQueueStore({ homeDirectory: home });
  store.mutate(() => state);
  store.close();
  const coldBootstrap = state.activeAttempt.coldBootstrap;
  return {
    state,
    transaction,
    queuedAttempt: {
      schemaVersion: 1,
      attemptId: state.activeAttempt.attemptId,
      generation: state.generation,
      coldBootstrapOperationId: coldBootstrap.operationId,
      coldBootstrapInitialRows: coldBootstrap.initialRows,
      coldBootstrapInitialColumns: coldBootstrap.initialColumns,
      coldBootstrapMode: coldBootstrap.mode,
      ...(coldBootstrap.submittedAtMs === undefined
        ? {}
        : {
            coldBootstrapCommand: coldBootstrap.command,
            coldBootstrapHmuxBuildId: coldBootstrap.hmuxBuildId,
          }),
    },
  };
}

function createFreshQueuedColdBootstrap(options) {
  return createQueuedColdBootstrapRetry({ ...options, submitted: false });
}

function queuedColdBootstrapArguments(live, port, queued, extra = []) {
  return [
    "--live-worktree",
    live,
    "--port",
    String(port),
    "--json",
    "--force",
    "--no-verify",
    ...extra,
    "--queued-deploy-transaction",
    JSON.stringify(queued.transaction),
    "--queued-deploy-attempt",
    JSON.stringify(queued.queuedAttempt),
  ];
}

function expectFreshColdBootstrapToolRejection({
  hiddenTools,
  port,
  relativePath,
  reason,
}) {
  const upstream = join(workspace, "upstream");
  const live = join(workspace, "live");
  const sourceHead = git(live, ["rev-parse", "HEAD"]);
  const targetHead = commitPath(
    upstream,
    relativePath,
    "export const toolBoundaryTarget = true;\n",
    "frontend target requiring cold bootstrap tools",
  );
  git(live, ["fetch", "origin", "main", "--quiet"]);
  const queued = createFreshQueuedColdBootstrap({
    live,
    sourceHead,
    targetHead,
    port,
  });

  const result = run(
    queuedColdBootstrapArguments(live, port, queued),
    hiddenUnixToolsEnvironment(hiddenTools),
  );

  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({
    action: "deploy",
    currentHead: sourceHead,
    targetHead,
    deployed: false,
    impact: queued.transaction.selection.impact,
    plannedTransition: {
      kind: "cold_bootstrap",
      state: "not_started",
      attempted: false,
      destructiveBoundaryCrossed: false,
      relaunchDispatched: false,
      reason: expect.stringMatching(reason),
    },
  });
  expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);

  const recorded = readQueuedDeployState();
  expect(recorded.activeAttempt).not.toHaveProperty("phase");
  expect(recorded.activeAttempt.coldBootstrap).not.toHaveProperty(
    "submittedAtMs",
  );
  expect(recorded.activeAttempt.result).toMatchObject({
    exitCode: 1,
    receipt: {
      targetHead,
      deployed: false,
      plannedTransition: { relaunchDispatched: false },
    },
  });
}

function readQueuedDeployState() {
  const store = new DevDeployQueueStore({ homeDirectory: home });
  const state = store.read();
  store.close();
  return state;
}

async function startChildRestartAuthority(live, options = {}) {
  const worktreeRoot = realpathSync(live);
  const { channel } = worktreeDevIdentity(worktreeRoot);
  const appRuntime = await startAppRuntimeFixture();
  let runtimeTimer;
  const publishRuntime = (targetHead, startedAtUnixMs = Date.now()) => {
    const packageVersion = JSON.parse(
      readFileSync(join(live, "package.json"), "utf8"),
    ).version;
    const buildId = `${packageVersion}+${targetHead.slice(0, 12)}`;
    const generation = `runtime-${targetHead.slice(0, 16)}`;
    appRuntime.publish({
      buildId,
      channel,
      generation,
      packageVersion,
      sourceRevision: targetHead.slice(0, 12),
      startedAtUnixMs,
    });
    const controlDirectory = options.dureHome
      ? join(options.dureHome, "channels", channel)
      : appControlDirectory(home, channel);
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(controlDirectory, "server.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        apiVersion: 1,
        packageVersion,
        buildId,
        port: appRuntime.port,
        token: "runtime-token",
        channel,
        generation,
        processId: appRuntime.child.pid,
        startedAtUnixMs,
      })}\n`,
      { mode: 0o600 },
    );
  };
  if (options.publishStaleRuntime) {
    publishRuntime(git(live, ["rev-parse", "HEAD"]), Date.now() - 1_000);
  }
  const fixture = await startDevLaunchEndpointFixture({
    fixtureRoot: workspace,
    home,
    worktreeRoot,
    channel,
    capabilities: options.capabilities ?? ["child_restart"],
    sourceGeneration: options.sourceGeneration,
    frontendIdentity: options.frontendIdentity,
    onRequest({
      request,
      connection,
      supervisor,
      launch,
      frontend,
      replacement,
      replacementFrontend,
      descriptorPath,
    }) {
      if (request.type === "parent_generation_probe") {
        const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
        connection.end(
          `${JSON.stringify(parentGenerationFrame(descriptor))}\n`,
        );
        return;
      }
      if (request.type === "restart") {
        const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
        writeFileSync(
          descriptorPath,
          `${JSON.stringify({
            ...descriptor,
            launch: replacement,
            ...(frontend ? { frontend: replacementFrontend } : {}),
            publishedAtMs: Date.now(),
          })}\n`,
          { mode: 0o600 },
        );
        if (options.publishRuntime !== false) {
          const publish = () =>
            publishRuntime(git(live, ["rev-parse", "HEAD"]));
          if (options.runtimeDelayMs) {
            runtimeTimer = setTimeout(publish, options.runtimeDelayMs);
          } else {
            publish();
          }
        }
        options.onRestartRequest?.();
        connection.end(
          `${JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 2,
            type: "restart_receipt",
            requestId: request.requestId,
            worktreeRoot,
            channel,
            supervisor,
            previousLaunch: launch,
            ...(frontend ? { previousFrontend: frontend } : {}),
            launch: replacement,
            ...(frontend ? { frontend: replacementFrontend } : {}),
            restartedAtMs: Date.now(),
          })}\n`,
        );
        return;
      }
      if (request.type === "restart_ack") {
        connection.end(
          `${JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 2,
            type: "restart_acknowledged",
            requestId: request.requestId,
            worktreeRoot,
            channel,
            supervisor,
          })}\n`,
        );
        return;
      }
      connection.destroy(new Error("unexpected dev launch fixture request"));
    },
  });
  return {
    ...fixture,
    runtimeRequestsPath: appRuntime.requestsPath,
    close: async () => {
      if (runtimeTimer) clearTimeout(runtimeTimer);
      await fixture.close();
      await appRuntime.close();
    },
  };
}

async function startAppRuntimeFixture() {
  const statePath = join(workspace, "app-runtime-state.json");
  const requestsPath = join(workspace, "app-runtime-requests.jsonl");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
        const fs = require("node:fs");
        const http = require("node:http");
        const [statePath, requestsPath] = process.argv.slice(1);
        const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
        const server = http.createServer((request, response) => {
          const current = state();
          fs.appendFileSync(
            requestsPath,
            JSON.stringify({ url: request.url, buildId: current.buildId }) + "\\n",
          );
          if (request.headers.authorization !== "Bearer runtime-token") {
            response.statusCode = 401;
            response.end("{}");
            return;
          }
          response.setHeader("Content-Type", "application/json");
          if (request.url === "/ping") {
            response.end(JSON.stringify({
              ok: true,
              channel: current.channel,
              generation: current.generation,
              processId: process.pid,
            }));
            return;
          }
          if (request.method === "POST" && request.url === "/diagnostics") {
            response.end(JSON.stringify({
              ok: true,
              schemaVersion: 1,
              compatibility: {
                mode: "current",
                comparisonBasis: "runtime-fingerprint",
                frontendBuildId: current.buildId,
                frontendSourceRevision: current.sourceRevision,
                frontendWorktreeOverlay: "clean",
                frontendRuntimeFingerprint: "git-object-v1:" + "a".repeat(40),
                backend: {
                  name: "dure-backend",
                  packageVersion: current.packageVersion,
                  protocolVersion: 1,
                  buildId: current.buildId,
                  runtimeFingerprint: "git-object-v1:" + "a".repeat(40),
                  features: [],
                },
                missingFeatures: [],
              },
            }));
            return;
          }
          response.statusCode = 404;
          response.end("{}");
        });
        server.listen(0, "127.0.0.1", () => {
          process.send({ port: server.address().port });
        });
        process.on("SIGTERM", () => server.close(() => process.exit(0)));
      `,
      statePath,
      requestsPath,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const [message] = await once(child, "message");
  return {
    child,
    port: message.port,
    requestsPath,
    publish: (state) => writeFileSync(statePath, JSON.stringify(state)),
    close: async () => {
      if (child.exitCode !== null) return;
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    },
  };
}

async function startFrontendTransitionServer(observationPath, dureHome = join(home, ".dure")) {
  const lockPath = join(dureHome, "dev-deploy.lock");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
        const fs = require("node:fs");
        const http = require("node:http");
        const [lockPath, observationPath] = process.argv.slice(1);
        const observation = {
          statusRequests: 0,
          reloadRequests: 0,
          reloadLease: null,
          sourceEventAtUnixMs: null,
          suppressHmr: [],
          unexpectedRequests: [],
        };
        const persist = () => fs.writeFileSync(
          observationPath,
          JSON.stringify(observation),
        );
        const server = http.createServer((request, response) => {
          if (request.url === "/__dure_dev_deploy_hmr_status") {
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            observation.statusRequests += 1;
            observation.suppressHmr.push(lock.suppressHmr);
            observation.sourceEventAtUnixMs ??= Date.now();
            persist();
            if (request.headers.authorization !== "Bearer " + lock.token) {
              response.statusCode = 403;
              response.end("forbidden");
              return;
            }
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
              schemaVersion: 1,
              fenced: true,
              generation: lock.generation,
              suppressedCount: 3,
              lastSuppressedAtUnixMs: observation.sourceEventAtUnixMs,
              observedAtUnixMs: Date.now(),
            }));
            return;
          }
          if (
            request.method === "POST" &&
            request.url === "/webview/reload" &&
            request.headers.authorization === "Bearer control-token"
          ) {
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            observation.reloadRequests += 1;
            observation.reloadLease = {
              generation: lock.generation,
              suppressHmr: lock.suppressHmr,
            };
            persist();
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ ok: true, reloaded: ["main"] }));
            return;
          }
          observation.unexpectedRequests.push(
            request.method + " " + request.url,
          );
          persist();
          response.statusCode = 418;
          response.end("unexpected request");
        });
        server.listen(0, () => {
          persist();
          process.send({ port: server.address().port });
        });
        process.on("SIGTERM", () => server.close(() => process.exit(0)));
      `,
      lockPath,
      observationPath,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const [message] = await once(child, "message");
  return { child, port: message.port };
}

async function stopFrontendTransitionServer(child) {
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await closed;
}

function publishFrontendControlDescriptor(live, server, dureHome) {
  const root = realpathSync(live);
  const { channel } = worktreeDevIdentity(root);
  const controlDirectory = dureHome
    ? join(dureHome, "channels", channel)
    : appControlDirectory(home, channel);
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(controlDirectory, "server.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      apiVersion: 1,
      port: server.port,
      token: "control-token",
      channel,
      generation: "fixture-generation",
      processId: server.child.pid,
      startedAtUnixMs: 1,
    })}\n`,
    { mode: 0o600 },
  );
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "deploy-dev-"));
  home = mkdtempSync(join(tmpdir(), "deploy-home-"));
  execFileSync("mkdir", ["-p", join(home, ".dure")]);

  const upstream = join(workspace, "upstream");
  execFileSync("git", ["init", "--quiet", "-b", "main", upstream], {
    env: fixtureEnvironment,
  });
  writeFileSync(join(upstream, "file.txt"), "base\n");
  writeFileSync(
    join(upstream, "package.json"),
    `${JSON.stringify({ name: "dure-deploy-fixture", version: "0.1.4" })}\n`,
  );
  const fixtureLock = "lockfileVersion: '9.0'\n";
  writeFileSync(join(upstream, "pnpm-lock.yaml"), fixtureLock);
  for (const relativePath of DEV_PARENT_SOURCE_PATHS) {
    const pathname = join(upstream, relativePath);
    mkdirSync(dirname(pathname), { recursive: true });
    writeFileSync(pathname, `${relativePath}\n`);
  }
  mkdirSync(join(upstream, "src-tauri"), { recursive: true });
  writeFileSync(join(upstream, "src-tauri", "tauri.conf.json"), "{}\n");
  writeFileSync(
    join(upstream, "scripts", "stage-hmux-runtime.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      'if [ -n "${DURE_TEST_HMUX_STAGE_FAIL:-}" ]; then',
      '  printf "%s\\n" "$DURE_TEST_HMUX_STAGE_FAIL" >&2',
      "  exit 1",
      "fi",
      'if [ -n "${DURE_TEST_HMUX_STAGE_RECEIPT:-}" ]; then',
      '  printf "%s\\n%s" "${1:-}" "${DURE_POSIX_SHELL:-}" >"$DURE_TEST_HMUX_STAGE_RECEIPT"',
      "fi",
      'printf "DURE_HMUX_ACTIVATION_V1 %s\\n" "${HMUX_BUILD_ID:-0.1.4+dev.fixture}"',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(upstream, "scripts", "stage-hmux-remote-resources.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      'if [ -n "${DURE_TEST_REMOTE_HMUX_STAGE_FAIL:-}" ]; then',
      '  printf "%s\\n" "$DURE_TEST_REMOTE_HMUX_STAGE_FAIL" >&2',
      "  exit 1",
      "fi",
      'if [ -n "${DURE_TEST_REMOTE_HMUX_STAGE_RECEIPT:-}" ]; then',
      '  printf "%s\\n%s" "${1:-}" "${DURE_POSIX_SHELL:-}" >"$DURE_TEST_REMOTE_HMUX_STAGE_RECEIPT"',
      "fi",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(upstream, "scripts", "stage-remote-git-checkout-helper.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      'if [ -n "${DURE_TEST_CHECKOUT_HELPER_STAGE_FAIL:-}" ]; then',
      '  printf "%s\\n" "$DURE_TEST_CHECKOUT_HELPER_STAGE_FAIL" >&2',
      "  exit 1",
      "fi",
      'if [ -n "${DURE_TEST_CHECKOUT_HELPER_STAGE_RECEIPT:-}" ]; then',
      '  git rev-parse HEAD >"$DURE_TEST_CHECKOUT_HELPER_STAGE_RECEIPT"',
      "fi",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(upstream, "scripts", "run-with-build-storage.mjs"),
    `
    import { spawnSync } from "node:child_process";
    import assert from "node:assert/strict";
    assert.equal(process.argv[2], "full");
    assert.equal(process.argv[3], "--");
    const result = spawnSync(process.argv[4], process.argv.slice(5), { stdio: "inherit" });
    process.exit(result.status ?? 1);
  `,
  );
  symlinkSync(
    controlPlaneInstallerFixture,
    join(upstream, "scripts", "install-dure-cli.mjs"),
  );
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "--quiet", "-m", "base"]);

  const live = join(workspace, "live");
  execFileSync("git", ["clone", "--quiet", upstream, live], {
    env: fixtureEnvironment,
  });
  git(live, ["checkout", "--quiet", "-B", "main", "origin/main"]);
  writeFileSync(join(live, ".git", "info", "exclude"), "node_modules/\n");
  mkdirSync(join(live, "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(live, "node_modules", ".pnpm", "lock.yaml"), fixtureLock);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("deploy-dev-app", () => {
  it("rejects the ambiguous legacy selector before reading or moving the checkout", () => {
    const live = join(workspace, "live");
    const before = git(live, ["rev-parse", "HEAD"]);
    const result = run(["--worktree", live, "--json", "--no-verify"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--worktree is ambiguous/);
    expect(result.stderr).toMatch(/--live-worktree/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("rejects restart-only dry-runs before restart authority is consulted", () => {
    const live = join(workspace, "live");
    const before = git(live, ["rev-parse", "HEAD"]);
    const result = run([
      "--live-worktree",
      live,
      "--restart-only",
      "--dry-run",
      "--json",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /--restart-only cannot be combined with --dry-run/,
    );
    expect(result.stdout).toBe("");
    expect(git(live, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("uses the canonical DURE port even when the legacy alias is valid", () => {
    const live = join(workspace, "live");
    const result = run(
      ["--live-worktree", live, "--json", "--no-verify"],
      {
        DURE_DEV_PORT: "not-a-port",
        HEBBIAN_DEV_PORT: "1420",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/DURE_DEV_PORT/);
  });

  it("이미 최신이면 워크트리를 건드리지 않는다 — 무의미한 재빌드를 만들지 않는다", () => {
    const live = join(workspace, "live");
    const before = git(live, ["rev-parse", "HEAD"]);
    const result = run(["--live-worktree", live, "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "skip",
      liveWorktree: realpathSync(live),
      currentHead: before,
      targetHead: before,
    });
    expect(JSON.parse(result.stdout).verification).toBeUndefined();
    expect(git(live, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("--force는 밀린 커밋을 ff-only로 한 번에 옮긴다", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    const target = commit(upstream, "two");

    const result = run(["--live-worktree", live, "--json", "--force", "--no-verify"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.action).toBe("deploy");
    expect(report.liveWorktree).toBe(realpathSync(live));
    expect(report.targetHead).toBe(target);
    // 두 커밋이 배포 1회로 접힌다 — 커밋당 재빌드를 없애는 핵심 성질.
    expect(report.pendingCommits).toBe(2);
    expect(report.dependencyInstallRequired).toBe(false);
    expect(report.impact.kind).toBe("frontend_reload");
    expect(report.plannedTransition).toBeUndefined();
    expect(git(live, ["rev-parse", "HEAD"])).toBe(target);
  });

  it("stages an immutable CLI change without restarting the app child", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const stageReceipt = join(workspace, "cli-payload-stage.receipt");
    const target = commitPath(
      upstream,
      "cli/lib/agent-spawn-query.mjs",
      "export const acceptsLaunchPromptReceipt = true;\n",
      "CLI payload target",
    );

    const result = run(
      ["--live-worktree", live, "--json", "--force", "--no-verify"],
      { DURE_TEST_CONTROL_PLANE_STAGE_RECEIPT: stageReceipt },
    );

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(readFileSync(stageReceipt, "utf8")).toBe(target);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "deploy",
      targetHead: target,
      impact: {
        kind: "frontend_reload",
        backendChanged: false,
        controlPlanePayloadChanged: true,
      },
      controlPlanePayloadStaged: true,
      controlPlaneActivation: { sourceRevision: target },
      dispatchAccepted: true,
    });
    expect(JSON.parse(result.stdout).plannedTransition).toBeUndefined();
  });

  it.each(["default", "portable"])("suppresses a frontend file burst and dispatches one authenticated WebView transition (%s app home)", async (appHome) => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    mkdirSync(join(upstream, "src"), { recursive: true });
    writeFileSync(
      join(upstream, "src", "main.tsx"),
      'import "./index.css";\n',
    );
    writeFileSync(join(upstream, "src", "index.css"), "body {}\n");
    writeFileSync(join(upstream, "src", "App.tsx"), "export const App = 1;\n");
    git(upstream, ["add", "src/main.tsx", "src/index.css", "src/App.tsx"]);
    git(upstream, ["commit", "--quiet", "-m", "frontend target"]);
    const targetHead = git(upstream, ["rev-parse", "HEAD"]);
    const observationPath = join(workspace, "frontend-transition.json");
    const dureHome = appHome === "portable" ? join(home, "portable-app") : undefined;
    const server = await startFrontendTransitionServer(observationPath, dureHome);
    publishFrontendControlDescriptor(live, server, dureHome);

    try {
      const result = run([
        "--live-worktree",
        live,
        "--port",
        String(server.port),
        "--json",
        "--force",
      ], dureHome ? { DURE_HOME: dureHome } : {});
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        deployReceiptVersion: 3,
        targetHead,
        dispatchAccepted: true,
        frontendTransition: {
          status: "dispatched",
          suppressedUpdates: 3,
          reloaded: ["main"],
        },
      });
      expect(report).not.toHaveProperty("verification");
      expect(report).not.toHaveProperty("liveVerified");
    } finally {
      await stopFrontendTransitionServer(server.child);
    }

    const observation = JSON.parse(readFileSync(observationPath, "utf8"));
    expect(observation.statusRequests).toBeGreaterThan(0);
    expect(observation.suppressHmr).toEqual(
      Array(observation.statusRequests).fill(true),
    );
    expect(observation.reloadRequests).toBe(1);
    expect(observation.reloadLease).toMatchObject({
      generation: expect.stringMatching(/^[a-f0-9]{32}$/),
      suppressHmr: true,
    });
    expect(observation.unexpectedRequests).toEqual([]);
  });

  it("fails closed when a frontend source transition has no app control descriptor", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const targetHead = commitPath(
      upstream,
      "src/main.tsx",
      "export const frontendTarget = true;\n",
      "frontend target without control authority",
    );

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      targetHead,
      dispatchAccepted: false,
      frontendTransition: {
        status: "failed",
        reason: expect.stringMatching(/control descriptor/i),
      },
    });
  });

  it("leaves a mixed source and non-source checkout on ordinary Vite handling", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    mkdirSync(join(upstream, "src"), { recursive: true });
    mkdirSync(join(upstream, "docs"), { recursive: true });
    writeFileSync(
      join(upstream, "src", "main.tsx"),
      "export const mixedTarget = true;\n",
    );
    writeFileSync(join(upstream, "docs", "note.md"), "mixed target\n");
    git(upstream, ["add", "src/main.tsx", "docs/note.md"]);
    git(upstream, ["commit", "--quiet", "-m", "mixed target"]);

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("frontendTransition");
  });

  it("does not claim an advanced backend target without child activation authority", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const previousHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "src-tauri/src/lib.rs",
      "pub fn advanced_backend_target() {}\n",
      "backend target",
    );

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "deploy",
      deployed: false,
      targetHead,
      impact: { kind: "backend_rebuild", backendChanged: true },
      plannedTransition: {
        kind: "child_restart",
        relaunchDispatched: false,
      },
      dispatchAccepted: false,
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(previousHead);
  });

  it.each(["default", "portable"])("waits past a stale descriptor for the exact backend replacement (%s app home)", async (appHome) => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const targetHead = commitPath(
      upstream,
      "src-tauri/src/lib.rs",
      "pub fn activated_backend_target() {}\n",
      "activated backend target",
    );
    const dureHome = appHome === "portable" ? join(home, "portable-app") : undefined;
    const fixture = await startChildRestartAuthority(live, {
      publishStaleRuntime: true,
      runtimeDelayMs: 150,
      dureHome,
    });

    try {
      const result = await runAsync([
        "--live-worktree",
        live,
        "--json",
        "--force",
        "--no-verify",
      ], dureHome ? { DURE_HOME: dureHome } : {});

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "deploy",
        deployed: true,
        targetHead,
        impact: { kind: "backend_rebuild", backendChanged: true },
        plannedTransition: {
          kind: "child_restart",
          state: "restarted",
          relaunchDispatched: true,
          receipt: { type: "restart_receipt" },
        },
        runtime: {
          state: "ready",
          targetHead,
          buildId: `0.1.4+${targetHead.slice(0, 12)}`,
          launch: fixture.replacement,
          compatibility: { state: "available", mode: "current" },
        },
        dispatchAccepted: true,
      });
      expect(fixture.requests.map(({ type }) => type)).toEqual([
        "restart",
        "restart_ack",
      ]);
      const runtimeRequests = readFileSync(
        fixture.runtimeRequestsPath,
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        runtimeRequests.some(({ buildId }) =>
          buildId.includes(targetHead.slice(0, 12)),
        ),
      ).toBe(true);
      expect(runtimeRequests[0].buildId).not.toContain(targetHead.slice(0, 12));
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    } finally {
      await fixture.close();
    }
  }, 150_000);

  it("explicitly adopts a divergent head only when its merge tree is the exact target tree", () => {
    const { currentHead, live, targetHead } = createIntegratedDivergence();
    const transaction = adoptionTransaction({ live, currentHead, targetHead });

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      action: "deploy",
      headTransition: "adopt-integrated-target",
      headTransitionTransactionId: transaction.transactionId,
      previousHead: currentHead,
      targetHead,
      mergeTree: git(live, ["rev-parse", `${targetHead}^{tree}`]),
    });
    expect(report.retainedRef).toBe(retainedRefFor(live, currentHead));
    expect(git(live, ["rev-parse", report.retainedRef])).toBe(currentHead);
    const journalPath = adoptionJournalPath(transaction);
    expect(JSON.parse(readFileSync(journalPath, "utf8"))).toMatchObject({
      state: "verified",
      transactionId: transaction.transactionId,
    });
    expect(lstatSync(journalPath).mode & 0o077).toBe(0);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    expect(git(live, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
  });

  it("ordinary --force leaves an integrated divergent head untouched", () => {
    const { currentHead, live } = createIntegratedDivergence();

    const result = run(["--live-worktree", live, "--json", "--force", "--no-verify"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/fast-forward|ff-only/i);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it.each([
    ["tracked", (live) => writeFileSync(join(live, "file.txt"), "dirty\n")],
    ["untracked", (live) => writeFileSync(join(live, "untracked.txt"), "dirty\n")],
  ])("rejects a %s dirty worktree before retaining or resetting", (_kind, dirty) => {
    const { currentHead, live } = createIntegratedDivergence();
    dirty(live);

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires a clean worktree/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it("rejects a clean merge whose resulting tree contains live-only content", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = commitPath(live, "local.txt", "local\n", "local-only");
    commitPath(upstream, "target.txt", "target\n", "target-only");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/merge tree .* differs from target tree/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it("rejects a conflicting merge-tree without retaining or resetting", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = commitPath(live, "file.txt", "local\n", "local conflict");
    commitPath(upstream, "file.txt", "target\n", "target conflict");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/merge-tree failed/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it("fails closed when the retained ref identity already exists", () => {
    const { currentHead, live } = createIntegratedDivergence();
    const retainedRef = retainedRefFor(live, currentHead);
    git(live, ["update-ref", retainedRef, currentHead]);

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/retained ref collision/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(git(live, ["rev-parse", retainedRef])).toBe(currentHead);
  });

  it("rejects adoption when the current head can fast-forward normally", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    commit(upstream, "target");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/only valid for a non-fast-forward head/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it("rejects adoption when the live and target heads are already identical", () => {
    const live = join(workspace, "live");
    const currentHead = git(live, ["rev-parse", "HEAD"]);

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires distinct heads/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it.each([
    ["before update-ref", "planned", false, false],
    ["after update-ref", "planned", true, false],
    ["before head adoption", "retained", true, false],
    ["after head adoption", "retained", true, true],
  ])(
    "resumes the exact adoption transaction %s",
    (_boundary, state, retain, adoptHead) => {
      const { currentHead, live, targetHead } = createIntegratedDivergence();
      const transaction = { ...adoptionTransaction({ live, currentHead, targetHead }), state };
      const journalPath = writeAdoptionJournal(transaction);
      if (retain) git(live, ["update-ref", transaction.retainedRef, currentHead]);
      if (adoptHead) {
        execFileSync(
          "git",
          ["-C", live, "reset", "--merge", "--quiet", targetHead],
          { cwd: live, env: fixtureEnvironment },
        );
      }

      const result = run([
        "--live-worktree",
        live,
        "--json",
        "--force",
        "--adopt-integrated-target",
        "--no-verify",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        headTransition: "adopt-integrated-target",
        headTransitionTransactionId: transaction.transactionId,
      });
      expect(JSON.parse(readFileSync(journalPath, "utf8"))).toMatchObject({
        state: "verified",
        transactionId: transaction.transactionId,
      });
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    },
  );

  it("refuses to resume a nonterminal journal for a different target identity", () => {
    const { currentHead, live, targetHead } = createIntegratedDivergence();
    const transaction = adoptionTransaction({ live, currentHead, targetHead });
    writeAdoptionJournal(transaction);
    commit(join(workspace, "upstream"), "new target");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unfinished integrated target transaction/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, transaction.retainedRef)).toBe(false);
  });

  it("rejects an ignored local path that the target begins tracking", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commitPath(upstream, ".gitignore", "ignored.txt\n", "ignore local data");
    git(live, ["pull", "--ff-only", "--quiet"]);
    const currentHead = commitPath(
      live,
      "file.txt",
      "integrated patch\n",
      "local task commit",
    );
    commitPath(
      upstream,
      "file.txt",
      "integrated patch\n",
      "coordinator reconstruction",
    );
    writeFileSync(join(upstream, "ignored.txt"), "target bytes\n");
    git(upstream, ["add", "--force", "ignored.txt"]);
    git(upstream, ["commit", "--quiet", "-m", "track ignored path"]);
    writeFileSync(join(live, "ignored.txt"), "local private bytes\n");
    expect(git(live, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target path collision.*ignored\.txt/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(readFileSync(join(live, "ignored.txt"), "utf8")).toBe(
      "local private bytes\n",
    );
  });

  it("retires a conflicting live head only after preserving its exact WIP checkpoint", () => {
    const { checkpoint, currentHead, live, targetHead } =
      createConflictingRetirement();

    const integrated = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);
    expect(integrated.status).toBe(1);
    expect(integrated.stderr).toMatch(/merge-tree failed/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);

    const result = run(retireArguments(live, checkpoint));

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      action: "deploy",
      headTransition: "retire-preserved-live-head",
      headTransitionMode: "retire_preserved_head",
      headTransitionReason: retirementReason,
      headTransitionEvidence: retirementEvidence,
      previousHead: currentHead,
      targetHead,
      retainedRef: retainedRefFor(live, currentHead),
      wipCheckpoint: {
        ref: checkpoint.ref,
        object: checkpoint.object,
        base: currentHead,
        worktree: realpathSync(live),
      },
    });
    expect(report.mergeTree).toBeUndefined();
    expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    expect(git(live, ["rev-parse", report.retainedRef])).toBe(currentHead);
    expect(git(live, ["rev-parse", checkpoint.ref])).toBe(checkpoint.object);
    expect(git(live, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
    const journalPath = adoptionJournalPath({
      channel: worktreeDevIdentity(realpathSync(live)).channel,
    });
    expect(JSON.parse(readFileSync(journalPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      state: "verified",
      mode: "retire_preserved_head",
      reason: retirementReason,
      evidence: retirementEvidence,
      wipCheckpoint: report.wipCheckpoint,
    });
  });

  it.each([
    ["--retire-reason", /retire reason/i],
    ["--retire-evidence", /retire evidence/i],
    ["--retire-wip-ref", /WIP ref/i],
  ])("requires %s before reserving a retirement", (option, message) => {
    const { checkpoint, currentHead, live } = createConflictingRetirement();

    const result = run(withoutOption(retireArguments(live, checkpoint), option));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it.each(["reason", "evidence"])(
    "rejects oversized retirement %s before retaining the live head",
    (field) => {
      const { checkpoint, currentHead, live } = createConflictingRetirement();
      const result = run(
        retireArguments(live, checkpoint, { [field]: "x".repeat(4_097) }),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/exceeds 4096 bytes/i);
      expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
      expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
    },
  );

  it("keeps --restart-only mutually exclusive with retirement", () => {
    const { checkpoint, currentHead, live } = createConflictingRetirement();
    const result = run([...retireArguments(live, checkpoint), "--restart-only"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/restart-only.*head transition/i);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it("rejects a WIP checkpoint owned by another worktree", () => {
    const { checkpoint, currentHead, live } = createConflictingRetirement();
    const other = join(workspace, "other");
    execFileSync("git", ["clone", "--quiet", join(workspace, "upstream"), other], {
      env: fixtureEnvironment,
    });
    writeFileSync(join(other, "other-wip.txt"), "other WIP\n");
    const otherCheckpoint = checkpointWorktree(other);

    const result = run(
      retireArguments(live, checkpoint, { wipRef: otherCheckpoint.ref }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/owner|worktree/i);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
  });

  it("rejects a missing or released WIP checkpoint ref", () => {
    const { checkpoint, currentHead, live } = createConflictingRetirement();
    git(live, ["update-ref", "-d", checkpoint.ref, checkpoint.object]);

    const result = run(retireArguments(live, checkpoint));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/WIP checkpoint|resolve WIP/i);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it("rejects a WIP checkpoint whose metadata base is not the current head", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    writeFileSync(join(live, "preserved-wip.txt"), "older WIP\n");
    const checkpoint = checkpointWorktree(live);
    const currentHead = commitPath(
      live,
      "file.txt",
      "local conflicting head\n",
      "local conflicting head",
    );
    commitPath(
      upstream,
      "file.txt",
      "target conflicting head\n",
      "target conflicting head",
    );

    const result = run(retireArguments(live, checkpoint));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/WIP checkpoint base.*current head/i);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
  });

  it("rejects a WIP ref whose checkpoint object was replaced after planning", () => {
    const { checkpoint, currentHead, live, targetHead } =
      createConflictingRetirement();
    const transaction = retirementTransaction({
      checkpoint,
      currentHead,
      live,
      targetHead,
    });
    writeAdoptionJournal(transaction);
    writeFileSync(join(live, "replacement-wip.txt"), "replacement WIP\n");
    const replacement = checkpointWorktree(live);
    git(live, [
      "update-ref",
      checkpoint.ref,
      replacement.object,
      checkpoint.object,
    ]);

    const result = run(retireArguments(live, checkpoint));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/WIP|owner|identity/i);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, transaction.retainedRef)).toBe(false);
  });

  it("never interprets a schema-v1 integrated journal as a retirement", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = commitPath(
      live,
      "file.txt",
      "integrated patch\n",
      "local task commit",
    );
    writeFileSync(join(live, "preserved-wip.txt"), "preserved WIP\n");
    const checkpoint = checkpointWorktree(live);
    const targetHead = commitPath(
      upstream,
      "file.txt",
      "integrated patch\n",
      "coordinator reconstruction",
    );
    const transaction = adoptionTransaction({ live, currentHead, targetHead });
    writeAdoptionJournal(transaction);

    const result = run(retireArguments(live, checkpoint));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unfinished.*transaction.*does not match/i);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, transaction.retainedRef)).toBe(false);
  });

  it("rejects retirement when the post-checkpoint worktree is dirty", () => {
    const { checkpoint, currentHead, live } = createConflictingRetirement();
    writeFileSync(join(live, "new-dirty.txt"), "not checkpointed\n");

    const result = run(retireArguments(live, checkpoint));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/clean worktree/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, retainedRefFor(live, currentHead))).toBe(false);
  });

  it.each([
    ["before retained ref", "planned", false, false],
    ["after retained ref", "planned", true, false],
    ["before head transition", "retained", true, false],
    ["after head transition", "retained", true, true],
  ])(
    "resumes an exact preserved-head retirement %s",
    (_boundary, state, retain, moveHead) => {
      const { checkpoint, currentHead, live, targetHead } =
        createConflictingRetirement();
      const transaction = {
        ...retirementTransaction({ checkpoint, currentHead, live, targetHead }),
        state,
      };
      const journalPath = writeAdoptionJournal(transaction);
      if (retain) git(live, ["update-ref", transaction.retainedRef, currentHead]);
      if (moveHead) {
        execFileSync(
          "git",
          ["-C", live, "reset", "--merge", "--quiet", targetHead],
          { cwd: live, env: fixtureEnvironment },
        );
      }

      const result = run(retireArguments(live, checkpoint));

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        headTransition: "retire-preserved-live-head",
        headTransitionTransactionId: transaction.transactionId,
        wipCheckpoint: transaction.wipCheckpoint,
      });
      expect(JSON.parse(readFileSync(journalPath, "utf8"))).toMatchObject({
        state: "verified",
        transactionId: transaction.transactionId,
      });
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
      expect(git(live, ["rev-parse", checkpoint.ref])).toBe(checkpoint.object);
    },
  );

  it("refuses to resume retirement when origin/main changed", () => {
    const { checkpoint, currentHead, live, targetHead } =
      createConflictingRetirement();
    const transaction = retirementTransaction({
      checkpoint,
      currentHead,
      live,
      targetHead,
    });
    writeAdoptionJournal(transaction);
    commitPath(join(workspace, "upstream"), "next.txt", "next\n", "next target");

    const result = run(retireArguments(live, checkpoint));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unfinished.*transaction.*does not match/i);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(refExists(live, transaction.retainedRef)).toBe(false);
  });

  it("preserves an ignored local path that the retirement target begins tracking", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commitPath(upstream, ".gitignore", "ignored.txt\n", "ignore local data");
    git(live, ["pull", "--ff-only", "--quiet"]);
    const currentHead = commitPath(
      live,
      "file.txt",
      "local conflicting head\n",
      "local conflicting head",
    );
    writeFileSync(join(live, "preserved-wip.txt"), "preserved WIP\n");
    const checkpoint = checkpointWorktree(live);
    commitPath(
      upstream,
      "file.txt",
      "target conflicting head\n",
      "target conflicting head",
    );
    writeFileSync(join(upstream, "ignored.txt"), "target bytes\n");
    git(upstream, ["add", "--force", "ignored.txt"]);
    git(upstream, ["commit", "--quiet", "-m", "track ignored path"]);
    writeFileSync(join(live, "ignored.txt"), "local private bytes\n");

    const result = run(retireArguments(live, checkpoint));

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target path collision.*ignored\.txt/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(readFileSync(join(live, "ignored.txt"), "utf8")).toBe(
      "local private bytes\n",
    );
  });

  it("rejects an unavailable parent before checkout even without boot verification", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "scripts/run-dev-app.mjs",
      "console.log('new launcher');\n",
      "launcher",
    );

    const result = run(["--live-worktree", live, "--json", "--force", "--no-verify"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.impact.kind).toBe("parent_reload");
    expect(report.targetHead).toBe(targetHead);
    expect(report.deployed).toBe(false);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
    // Without an explicit dev-launch supervisor receipt, it must retreat
    // before checkout mutation or terminal input.
    expect(report.plannedTransition.attempted).toBe(false);
    expect(report.plannedTransition.reason).toMatch(
      /dev_launch_parent_authority_unavailable/,
    );
  });

  it("requires cold bootstrap for a Node runtime pin without contacting a supervisor", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const targetHead = commitPath(
      upstream,
      ".node-version",
      "99.0.0\n",
      "node runtime pin",
    );

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-verify",
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      targetHead,
      impact: {
        kind: "parent_reload",
        parentStrategy: "cold_bootstrap",
      },
      plannedTransition: {
        kind: "parent_reload",
        attempted: false,
        destructiveBoundaryCrossed: false,
        relaunchDispatched: false,
        reason: expect.stringMatching(/^cold_bootstrap_required:/),
      },
    });
  });

  it.skipIf(process.platform === "win32")(
    "queued fresh cold bootstrap rejects missing Unix tools before checkout or submission",
    () => {
      expectFreshColdBootstrapToolRejection({
        hiddenTools: ["ps", "lsof", "env", "sh"],
        port: 59_127,
        relativePath: "src/missing-tools-target.ts",
        reason:
          /required Unix tools are unavailable.*authenticated dev chain unavailable/,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "queued fresh cold bootstrap rejects a missing POSIX shell before checkout",
    () => {
      expectFreshColdBootstrapToolRejection({
        hiddenTools: ["sh"],
        port: 59_129,
        relativePath: "src/missing-shell-target.ts",
        reason: /POSIX shell \(sh\).*authenticated dev chain unavailable/,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "queued fresh cold bootstrap accepts an authenticated parent without bootstrap tools or Corepack",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      const targetHead = commitPath(
        upstream,
        "src/authenticated-parent-target.ts",
        "export const authenticatedParentTarget = true;\n",
        "frontend target with authenticated parent",
      );
      git(live, ["fetch", "origin", "main", "--quiet"]);
      const parent = await startChildRestartAuthority(live, {
        sourceGeneration: devParentSourceGeneration(live),
      });
      let transitionServer;
      try {
        transitionServer = await startFrontendTransitionServer(
          join(workspace, "authenticated-parent-frontend-transition.json"),
        );
        publishFrontendControlDescriptor(live, transitionServer);
        const queued = createFreshQueuedColdBootstrap({
          live,
          sourceHead,
          targetHead,
          port: transitionServer.port,
        });

        const result = await runAsync(
          queuedColdBootstrapArguments(
            live,
            transitionServer.port,
            queued,
          ),
          hiddenUnixToolsEnvironment(["ps", "lsof", "env", "sh", "corepack"]),
        );

        expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
        const receipt = JSON.parse(result.stdout);
        expect(receipt).toMatchObject({
          action: "deploy",
          currentHead: sourceHead,
          targetHead,
          deployed: true,
          impact: queued.transaction.selection.impact,
          frontendTransition: {
            status: "dispatched",
            reloaded: ["main"],
          },
          dispatchAccepted: true,
        });
        expect(receipt).not.toHaveProperty("plannedTransition");
        expect(parent.requests.map(({ type }) => type)).toEqual([
          "parent_generation_probe",
        ]);
        expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);

        const recorded = readQueuedDeployState();
        expect(recorded.activeAttempt.phase).toMatchObject({
          kind: "target_applied",
          targetHead,
        });
        expect(recorded.activeAttempt.coldBootstrap).not.toHaveProperty(
          "submittedAtMs",
        );
        expect(recorded.activeAttempt.result).toMatchObject({
          exitCode: 0,
          receipt: { targetHead, deployed: true, dispatchAccepted: true },
        });
      } finally {
        try {
          if (transitionServer) {
            await stopFrontendTransitionServer(transitionServer.child);
          }
        } finally {
          await parent.close();
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not treat a matching process name as live dev-chain authority",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      const targetHead = commitPath(
        upstream,
        "src/process-presence-target.ts",
        "export const processPresenceTarget = true;\n",
        "process presence frontend target",
      );
      git(live, ["fetch", "origin", "main", "--quiet"]);
      const observationPath = join(workspace, "process-presence-transition.json");
      const server = await startFrontendTransitionServer(observationPath);
      publishFrontendControlDescriptor(live, server);
      const queued = createFreshQueuedColdBootstrap({
        live,
        sourceHead,
        targetHead,
        port: server.port,
      });
      const decoy = spawn(
        process.execPath,
        [
          "-e",
          "process.title='node scripts/run-dev-app.mjs'; process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
        ],
        { cwd: live, stdio: "ignore" },
      );
      await once(decoy, "spawn");

      let result;
      try {
        result = run(
          queuedColdBootstrapArguments(live, server.port, queued),
        );
      } finally {
        const closed = once(decoy, "close");
        decoy.kill("SIGTERM");
        await closed;
        await stopFrontendTransitionServer(server.child);
      }

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "deploy",
        currentHead: sourceHead,
        targetHead,
        deployed: true,
        dispatchAccepted: false,
        reason: expect.stringMatching(/parent.*authority/i),
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "queued fresh cold bootstrap rejects unavailable at-target reconciliation before stage or submission",
    () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      addColdBootstrapBuildInputs(upstream, live);
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      const targetHead = commitPath(
        upstream,
        "hmux/crates/hmux-runtime/src/at-target.rs",
        "pub fn at_target_reconciliation() {}\n",
        "at-target Hmux runtime change",
      );
      git(live, ["fetch", "origin", "main", "--quiet"]);
      const queued = createFreshQueuedColdBootstrap({
        live,
        sourceHead,
        targetHead,
        port: 59_128,
        impact: {
          kind: "backend_rebuild",
          backendChanged: true,
          changedPathCount: 1,
        },
      });
      git(live, ["merge", "--ff-only", "--quiet", targetHead]);
      const stageReceipt = join(workspace, "at-target-hmux-stage.receipt");

      const result = run(
        queuedColdBootstrapArguments(live, 59_128, queued, [
          "--reconcile-parent-target",
          targetHead,
        ]),
        {
          ...missingUnixProcessToolsEnvironment(),
          DURE_TEST_HMUX_STAGE_RECEIPT: stageReceipt,
        },
      );

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "skip",
        currentHead: targetHead,
        targetHead,
        deployed: false,
        impact: queued.transaction.selection.impact,
        plannedTransition: {
          kind: "cold_bootstrap",
          state: "not_started",
          attempted: false,
          destructiveBoundaryCrossed: false,
          relaunchDispatched: false,
        },
      });
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
      expect(existsSync(stageReceipt)).toBe(false);

      const recorded = readQueuedDeployState();
      expect(recorded.activeAttempt).not.toHaveProperty("phase");
      expect(recorded.activeAttempt.coldBootstrap).not.toHaveProperty(
        "submittedAtMs",
      );
      expect(recorded.activeAttempt.result).toMatchObject({
        exitCode: 1,
        receipt: {
          currentHead: targetHead,
          targetHead,
          deployed: false,
          plannedTransition: { relaunchDispatched: false },
        },
      });
    },
  );

  it("retires the exact queued predecessor before changing the checkout", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    addColdBootstrapBuildInputs(upstream, live);
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n",
      "retirement target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    const hmux = installColdBootstrapHmuxFixture(live, ["retired"]);
    const queued = createQueuedColdBootstrapRetry({
      live,
      sourceHead,
      targetHead,
      port: 59_123,
    });

    const result = run(
      [
        "--live-worktree",
        live,
        "--port",
        "59123",
        "--json",
        "--force",
        "--queued-deploy-transaction",
        JSON.stringify(queued.transaction),
        "--queued-deploy-attempt",
        JSON.stringify({
          ...queued.queuedAttempt,
          coldBootstrapMode:
            DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
        }),
      ],
      hiddenUnixToolsEnvironment(["corepack"]),
    );

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({
      action: "defer",
      currentHead: sourceHead,
      targetHead,
      deployed: false,
      dispatchAccepted: false,
      plannedTransition: {
        kind: "cold_bootstrap",
        state: "pending",
        destructiveBoundaryCrossed: true,
        relaunchDispatched: false,
        hmuxOutcome: "retired",
        receipt: {
          type: "cold_bootstrap_target_retired",
          hmux: {
            operationId:
              queued.queuedAttempt.coldBootstrapOperationId,
          },
        },
      },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
    const { calls } = JSON.parse(readFileSync(hmux.capture, "utf8"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      head: sourceHead,
      request: {
        schemaVersion: 1,
        operationId: queued.queuedAttempt.coldBootstrapOperationId,
        sessionName: coldBootstrapSessionName({
          root: realpathSync(live),
          channel: hmux.channel,
          operationId: queued.queuedAttempt.coldBootstrapOperationId,
        }),
        command: queued.queuedAttempt.coldBootstrapCommand,
        initialRows: queued.queuedAttempt.coldBootstrapInitialRows,
        initialColumns: queued.queuedAttempt.coldBootstrapInitialColumns,
        mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
      },
    });

    const store = new DevDeployQueueStore({ homeDirectory: home });
    const recorded = store.read();
    store.close();
    const settled = settleDevDeployAttempt(recorded, {
      attemptGeneration: recorded.generation,
      exitCode: recorded.activeAttempt.result.exitCode,
      receipt: recorded.activeAttempt.result.receipt,
      nowMs: recorded.activeAttempt.result.completedAtMs + 1,
      pollMs: 5_000,
    });
    expect(settled.request.coldBootstrapOperationId).not.toBe(
      queued.queuedAttempt.coldBootstrapOperationId,
    );
    expect(
      settled.request.coldBootstrapRetirementAcknowledgement,
    ).toMatchObject({
      operationId: queued.queuedAttempt.coldBootstrapOperationId,
    });
  });

  it("checks checkout admissibility before retiring the queued predecessor", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    addColdBootstrapBuildInputs(upstream, live);
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "file.txt",
      "target replacement\n",
      "conflicting retirement target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    const hmux = installColdBootstrapHmuxFixture(live, ["retired"]);
    const queued = createQueuedColdBootstrapRetry({
      live,
      sourceHead,
      targetHead,
      port: 59_126,
    });
    writeFileSync(join(live, "file.txt"), "preserved local edit\n");

    const result = run([
      "--live-worktree",
      live,
      "--port",
      "59126",
      "--json",
      "--force",
      "--queued-deploy-transaction",
      JSON.stringify(queued.transaction),
      "--queued-deploy-attempt",
      JSON.stringify({
        ...queued.queuedAttempt,
        coldBootstrapMode:
          DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/live fast-forward is not admissible/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
    expect(readFileSync(join(live, "file.txt"), "utf8")).toBe(
      "preserved local edit\n",
    );
    expect(existsSync(hmux.capture)).toBe(false);
  });

  it("defers an in-progress explicit retirement without moving HEAD", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    addColdBootstrapBuildInputs(upstream, live);
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "src/pending-retirement-target.ts",
      "export const pendingRetirementTarget = true;\n",
      "pending retirement target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    installColdBootstrapHmuxFixture(live, ["pending"]);
    const queued = createQueuedColdBootstrapRetry({
      live,
      sourceHead,
      targetHead,
      port: 59_124,
    });

    const result = run([
      "--live-worktree",
      live,
      "--port",
      "59124",
      "--json",
      "--force",
      "--queued-deploy-transaction",
      JSON.stringify(queued.transaction),
      "--queued-deploy-attempt",
      JSON.stringify({
        ...queued.queuedAttempt,
        coldBootstrapMode:
          DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
      }),
    ]);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "defer",
      currentHead: sourceHead,
      targetHead,
      deployed: false,
      plannedTransition: {
        state: "pending",
        destructiveBoundaryCrossed: null,
        relaunchDispatched: false,
        hmuxOutcome: "pending",
      },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
  });

  it("rejects contradictory legacy and typed cold-bootstrap actions", () => {
    const live = join(workspace, "live");
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    const generation = "9".repeat(64);
    const entrypoint = join(
      workspace,
      "executors-v1",
      generation,
      "scripts",
      "deploy-dev-app.mjs",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    symlinkSync(script, entrypoint);
    const transaction = {
      schemaVersion: 1,
      targetHead: currentHead,
      targetAuthority: "origin/main",
      executor: { generation, entrypoint },
    };

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--queued-deploy-transaction",
      JSON.stringify(transaction),
      "--queued-deploy-attempt",
      JSON.stringify({
        schemaVersion: 1,
        attemptId: "a".repeat(32),
        generation: 1,
        coldBootstrapOperationId: "b".repeat(64),
        coldBootstrapInitialRows: 24,
        coldBootstrapInitialColumns: 80,
        coldBootstrapCommand: ["node", "scripts/run-dev-app.mjs"],
        coldBootstrapReplay: true,
        coldBootstrapMode:
          DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/queued deploy attempt is invalid/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
  });

  it("rejects a retirement action whose saved operation binding changed", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    addColdBootstrapBuildInputs(upstream, live);
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "src/tampered-retirement-target.ts",
      "export const tamperedRetirementTarget = true;\n",
      "tampered retirement target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    const queued = createQueuedColdBootstrapRetry({
      live,
      sourceHead,
      targetHead,
      port: 59_125,
    });

    const result = run([
      "--live-worktree",
      live,
      "--port",
      "59125",
      "--json",
      "--force",
      "--queued-deploy-transaction",
      JSON.stringify(queued.transaction),
      "--queued-deploy-attempt",
      JSON.stringify({
        ...queued.queuedAttempt,
        coldBootstrapCommand: ["node", "scripts/another-app.mjs"],
        coldBootstrapMode:
          DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/submitted binding no longer matches/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
  });

  it("rejects an unavailable parent before waiting or duplicate recovery", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    commitPath(
      upstream,
      "scripts/lib/app-channel.mjs",
      "export const changed = true;\n",
      "channel",
    );

    const result = run(["--live-worktree", live, "--json", "--force"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.deployed).toBe(false);
    expect(report.verification).toBeUndefined();
    expect(report.plannedTransition.reason).toMatch(
      /dev_launch_parent_authority_unavailable/,
    );
    expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
  });

  it("accepts the running parent authority when the target adds a new parent input", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const addedParentInput = "scripts/lib/dev-node-tool.mjs";
    git(upstream, ["rm", "--quiet", addedParentInput]);
    git(upstream, ["commit", "--quiet", "-m", "legacy parent inputs"]);
    git(live, ["pull", "--ff-only", "--quiet"]);
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      addedParentInput,
      "export const targetOnlyParentInput = true;\n",
      "add parent input",
    );
    const root = realpathSync(live);
    const { channel } = worktreeDevIdentity(root);
    const parent = await startConvergentDevLaunchParentFixture({
      fixtureRoot: workspace,
      home,
      worktreeRoot: root,
      channel,
      capabilities: [
        "child_restart",
        "parent_reload",
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ],
      sourceGeneration: "1".repeat(64),
      frontendIdentity: {
        pid: 6_432,
        processIdentity: "fixture-frontend-one",
        generation: "2".repeat(64),
      },
    });
    try {
      const result = await runAsync([
        "--live-worktree",
        live,
        "--json",
        "--force",
        "--no-verify",
      ]);

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "deploy",
        currentHead: sourceHead,
        targetHead,
        deployed: true,
        plannedTransition: {
          kind: "parent_reload",
          state: "restarted",
        },
      });
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    } finally {
      await parent.close();
    }
  });

  it("--dry-run은 배포할 상황에서도 워크트리를 옮기지 않는다", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const before = git(live, ["rev-parse", "HEAD"]);
    commit(upstream, "one");

    const result = run(["--live-worktree", live, "--json", "--force", "--dry-run", "--no-verify"]);
    expect(JSON.parse(result.stdout).action).toBe("deploy");
    expect(git(live, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("activates a queued native selection after an older attempt already moved HEAD", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "src-tauri/src/lib.rs",
      "pub fn queued_native_activation() {}\n",
      "native target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", targetHead]);

    const generation = "f".repeat(64);
    const entrypoint = join(
      workspace,
      "executors-v1",
      generation,
      "scripts",
      "deploy-dev-app.mjs",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    symlinkSync(script, entrypoint);
    const transaction = {
      schemaVersion: 1,
      targetHead,
      targetAuthority: "origin/main",
      executor: { generation, entrypoint },
      selection: {
        sourceHead,
        impact: {
          kind: "backend_rebuild",
          backendChanged: true,
          changedPathCount: 1,
        },
      },
    };

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-verify",
      "--queued-deploy-transaction",
      JSON.stringify(transaction),
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "deploy",
      currentHead: sourceHead,
      targetHead,
      impact: transaction.selection.impact,
      plannedTransition: { kind: "child_restart" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a missing staging shell before changing the checkout",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      const stageReceipt = join(workspace, "missing-shell-stage.receipt");
      commitPath(
        upstream,
        "hmux/crates/hmux-runtime/src/missing-shell.rs",
        "pub fn missing_shell_target() {}\n",
        "Hmux runtime target requiring a shell",
      );
      const fixture = await startChildRestartAuthority(live);
      try {
        const result = await runAsync(
          ["--live-worktree", live, "--json", "--force", "--no-verify"],
          {
            ...hiddenUnixToolsEnvironment(["sh"]),
            DURE_TEST_HMUX_STAGE_RECEIPT: stageReceipt,
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/POSIX shell.*unavailable/i);
        expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
        expect(existsSync(stageReceipt)).toBe(false);
        expect(fixture.requests).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects missing Corepack before a fresh bootstrap that must repair dependencies",
    () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      const targetHead = commitPath(
        upstream,
        "src/fresh-bootstrap-dependency-repair.ts",
        "export const dependencyRepairTarget = true;\n",
        "frontend target with missing installed dependencies",
      );
      git(live, ["fetch", "origin", "main", "--quiet"]);
      rmSync(join(live, "node_modules", ".pnpm", "lock.yaml"));
      const queued = createFreshQueuedColdBootstrap({
        live,
        sourceHead,
        targetHead,
        port: 59_130,
      });

      const result = run(
        queuedColdBootstrapArguments(live, 59_130, queued),
        hiddenUnixToolsEnvironment(["corepack"]),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Corepack.*unavailable/i);
      expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects missing Corepack before a backend checkout needs payload staging",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      commitPath(
        upstream,
        "hmux/crates/hmux-runtime/src/missing-corepack.rs",
        "pub fn missing_corepack_target() {}\n",
        "backend target requiring Corepack",
      );
      const fixture = await startChildRestartAuthority(live);
      try {
        const result = await runAsync(
          ["--live-worktree", live, "--json", "--force", "--no-verify"],
          hiddenUnixToolsEnvironment(["corepack"]),
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Corepack.*unavailable/i);
        expect(git(live, ["rev-parse", "HEAD"])).toBe(sourceHead);
        expect(fixture.requests).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "binds the selected shell to a dependency install",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      const shell = alternateShellEnvironment();
      const corepack = join(dirname(shell.executable), "corepack");
      const installReceipt = join(workspace, "dependency-install.receipt");
      writeFileSync(
        corepack,
        [
          "#!/bin/sh",
          'printf "%s\\n%s\\n%s\\n" "$*" "$DURE_POSIX_SHELL" "$npm_config_script_shell" >"$DURE_TEST_DEPENDENCY_INSTALL_RECEIPT"',
          "mkdir -p node_modules/.pnpm",
          "cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(corepack, 0o700);
      const targetHead = commitPath(
        upstream,
        "pnpm-lock.yaml",
        "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n",
        "dependency target",
      );
      const fixture = await startChildRestartAuthority(live);
      try {
        const result = await runAsync(
          ["--live-worktree", live, "--json", "--force", "--no-verify"],
          {
            ...shell.environment,
            DURE_TEST_DEPENDENCY_INSTALL_RECEIPT: installReceipt,
          },
        );

        expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
        expect(readFileSync(installReceipt, "utf8").trim().split("\n")).toEqual([
          "pnpm install --frozen-lockfile --force",
          shell.executable,
          shell.executable,
        ]);
        expect(JSON.parse(result.stdout)).toMatchObject({
          targetHead,
          dependencyInstallRequired: true,
          plannedTransition: { kind: "child_restart", state: "restarted" },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reestablishes exact Hmux activation while reconciling the staged backend proof",
    () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      addColdBootstrapBuildInputs(upstream, live);
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      const targetHead = commitPath(
        upstream,
        "hmux/crates/hmux-runtime/src/replay.rs",
        "pub fn replay_target() {}\n",
        "backend replay target",
      );
      git(live, ["fetch", "origin", "main", "--quiet"]);
      git(live, ["merge", "--ff-only", "--quiet", targetHead]);
      const root = realpathSync(live);
      const { channel } = worktreeDevIdentity(root);
      const cliRoot = join(
        home,
        ".local",
        "share",
        "hebbian-ide-cli",
        "channels",
        channel,
      );
      execFileSync(process.execPath, [controlPlaneInstallerFixture], {
        cwd: root,
        env: {
          ...fixtureEnvironment,
          HOME: home,
          DURE_APP_CHANNEL: channel,
          DURE_CLI_INSTALL_ROOT: cliRoot,
          DURE_CLI_SOURCE_REVISION: targetHead,
        },
      });
      installColdBootstrapHmuxFixture(live, ["pending"]);
      const queued = createQueuedColdBootstrapRetry({
        live,
        sourceHead,
        targetHead,
        port: 59_131,
        impact: {
          kind: "backend_rebuild",
          backendChanged: true,
          changedPathCount: 1,
        },
      });
      const stageReceipt = join(workspace, "replay-hmux-stage.receipt");

      const result = run(
        queuedColdBootstrapArguments(live, 59_131, queued),
        {
          ...hiddenUnixToolsEnvironment(["corepack"]),
          DURE_TEST_HMUX_STAGE_RECEIPT: stageReceipt,
        },
      );

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "defer",
        targetHead,
        backendChanged: true,
        hmuxRuntimeStaged: true,
        hmuxActivation: {
          sourceRevision: targetHead,
          channel,
          buildId: expect.stringMatching(/^0\.1\.4\+dev\./),
        },
        controlPlaneActivation: { sourceRevision: targetHead },
        plannedTransition: {
          kind: "cold_bootstrap",
          state: "pending",
        },
      });
      expect(existsSync(stageReceipt)).toBe(true);
    },
  );

  it("stages changed Hmux runtime with one selected shell before dispatching the backend restart", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const stageReceipt = join(workspace, "hmux-stage.receipt");
    const remoteStageReceipt = join(workspace, "remote-hmux-stage.receipt");
    const controlPlaneStageReceipt = join(
      workspace,
      "control-plane-stage.receipt",
    );
    const shellInvocationReceipt = join(
      workspace,
      "selected-shell-invocations.receipt",
    );
    const shell = alternateShellEnvironment();
    let toolsStagedBeforeRestart = false;
    const targetHead = commitPath(
      upstream,
      "hmux/crates/hmux-runtime/src/lib.rs",
      "pub fn changed_runtime() {}\n",
      "hmux runtime target",
    );
    const fixture = await startChildRestartAuthority(live, {
      onRestartRequest() {
        toolsStagedBeforeRestart =
          existsSync(stageReceipt) &&
          !existsSync(remoteStageReceipt) &&
          existsSync(controlPlaneStageReceipt);
      },
    });
    try {
      const result = await runAsync(
        ["--live-worktree", live, "--json", "--force", "--no-verify"],
        {
          ...shell.environment,
          DURE_TEST_HMUX_STAGE_RECEIPT: stageReceipt,
          DURE_TEST_REMOTE_HMUX_STAGE_RECEIPT: remoteStageReceipt,
          DURE_TEST_CONTROL_PLANE_STAGE_RECEIPT:
            controlPlaneStageReceipt,
          DURE_TEST_SELECTED_SHELL_RECEIPT: shellInvocationReceipt,
        },
      );

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(toolsStagedBeforeRestart).toBe(true);
      expect(readFileSync(stageReceipt, "utf8")).toBe(
        `debug\n${shell.executable}`,
      );
      expect(readFileSync(shellInvocationReceipt, "utf8").split("\n")).toContain(
        join(realpathSync(live), "scripts", "stage-hmux-runtime.sh"),
      );
      expect(existsSync(remoteStageReceipt)).toBe(false);
      expect(readFileSync(shellInvocationReceipt, "utf8").split("\n")).not.toContain(
        join(realpathSync(live), "scripts", "stage-hmux-remote-resources.sh"),
      );
      expect(readFileSync(controlPlaneStageReceipt, "utf8")).toBe(targetHead);
      expect(JSON.parse(result.stdout)).toMatchObject({
        targetHead,
        impact: { kind: "backend_rebuild", backendChanged: true },
        hmuxRuntimeStaged: true,
        hmuxActivation: {
          schemaVersion: 1,
          sourceRevision: targetHead,
          channel: worktreeDevIdentity(realpathSync(live)).channel,
          buildId: expect.stringMatching(/^0\.1\.4\+dev\./),
        },
        controlPlanePayloadStaged: true,
        controlPlaneActivation: {
          sourceRevision: targetHead,
          controlPlaneExecutableSha256: expect.stringMatching(
            /^[a-f0-9]{64}$/,
          ),
          claudePayloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        plannedTransition: {
          kind: "child_restart",
          state: "restarted",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it.each([
    "crates/dure-app/session-runtime/src/host_command.rs",
    "hmux/crates/hmux-runtime/src/lib.rs",
  ])("keeps remote artifacts independent when deploying %s", async (sourcePath) => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const receipt = join(workspace, "checkout-helper-stage.receipt");
    const targetHead = commitPath(
      upstream,
      sourcePath,
      "pub fn reconcile_managed_close() {}\n",
      "checkout helper protocol target",
    );
    const remoteArtifacts = join(live, "src-tauri", "resources", "hmux-remote");
    mkdirSync(remoteArtifacts, { recursive: true });
    const manifest = join(remoteArtifacts, "install.json");
    const retainedManifest = '{"buildId":"previous-remote-build"}\n';
    writeFileSync(manifest, retainedManifest);
    writeFileSync(
      join(live, ".git", "info", "exclude"),
      "node_modules/\nsrc-tauri/resources/\n",
    );
    let helperStagedAtRestart;
    const fixture = await startChildRestartAuthority(live, {
      onRestartRequest() {
        helperStagedAtRestart = existsSync(receipt);
      },
    });
    try {
      const result = await runAsync(
        ["--live-worktree", live, "--json", "--force", "--no-verify"],
        { DURE_TEST_CHECKOUT_HELPER_STAGE_RECEIPT: receipt },
      );
      expect(result.status, result.stderr + "\n" + result.stdout).toBe(0);
      expect(helperStagedAtRestart).toBe(false);
      expect(existsSync(receipt)).toBe(false);
      expect(readFileSync(manifest, "utf8")).toBe(retainedManifest);
      expect(JSON.parse(result.stdout)).toMatchObject({
        targetHead,
        backendChanged: true,
        hmuxRuntimeStaged: sourcePath.startsWith("hmux/"),
        plannedTransition: { kind: "child_restart", state: "restarted" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("deploys locally when the Linux checkout helper build is unavailable", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commitPath(
      upstream,
      "crates/dure-app/session-runtime/src/host_command.rs",
      "pub fn reconcile_managed_close() {}\n",
      "checkout helper protocol target",
    );
    let restartRequests = 0;
    const fixture = await startChildRestartAuthority(live, {
      onRestartRequest() {
        restartRequests += 1;
      },
    });
    try {
      const result = await runAsync(
        ["--live-worktree", live, "--json", "--force", "--no-verify"],
        { DURE_TEST_CHECKOUT_HELPER_STAGE_FAIL: "checkout helper build failed" },
      );
      expect(result.status, result.stderr + "\n" + result.stdout).toBe(0);
      expect(restartRequests).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        deployed: true,
        plannedTransition: { kind: "child_restart", state: "restarted" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("deploys locally when the Linux Hmux build is unavailable", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commitPath(
      upstream,
      "hmux/crates/hmux-runtime/src/lib.rs",
      "pub fn changed() {}\n",
      "remote runtime target",
    );
    let restartRequests = 0;
    const fixture = await startChildRestartAuthority(live, {
      onRestartRequest() {
        restartRequests += 1;
      },
    });
    try {
      const result = await runAsync(
        ["--live-worktree", live, "--json", "--force", "--no-verify"],
        { DURE_TEST_REMOTE_HMUX_STAGE_FAIL: "Linux runtime build failed" },
      );
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(restartRequests).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        deployed: true,
        hmuxRuntimeStaged: true,
        plannedTransition: { kind: "child_restart", state: "restarted" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps the stage's own diagnostic when Hmux staging fails", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const targetHead = commitPath(
      upstream,
      "hmux/crates/hmux-runtime/src/lib.rs",
      "pub fn diagnosed_runtime() {}\n",
      "hmux runtime diagnostic target",
    );
    const fixture = await startChildRestartAuthority(live);
    try {
      const result = await runAsync(
        ["--live-worktree", live, "--json", "--force", "--no-verify"],
        {
          DURE_TEST_HMUX_STAGE_FAIL:
            "installed Hmux CLI did not report the activated build",
        },
      );

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
      // The queue records only the thrown message as the attempt's failure
      // reason, so the stage's last words have to travel inside it.
      expect(result.stderr).toContain(
        "Hmux stage exited 1: installed Hmux CLI did not report the activated build",
      );
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    } finally {
      await fixture.close();
    }
  });

  it("defers instead of advancing when the exact control-plane payload is delayed", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const previousHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "crates/dure-app/control-plane/src/lib.rs",
      "pub fn delayed_payload_target() {}\n",
      "delayed control-plane payload",
    );
    let restartRequests = 0;
    const fixture = await startChildRestartAuthority(live, {
      onRestartRequest() {
        restartRequests += 1;
      },
    });
    try {
      const result = await runAsync(
        ["--live-worktree", live, "--json", "--force", "--no-verify"],
        {
          DURE_TEST_CONTROL_PLANE_STAGED_SOURCE_REVISION: previousHead,
        },
      );

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "defer",
        targetHead,
        deployed: true,
        backendChanged: true,
        controlPlanePayloadStaged: true,
        controlPlaneTransition: {
          status: "pending",
          reason: expect.stringMatching(/exact control-plane payload/),
        },
        dispatchAccepted: false,
      });
      expect(restartRequests).toBe(0);
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    } finally {
      await fixture.close();
    }
  });

  it("refuses parent reconciliation without live parent authority", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commitPath(
      upstream,
      "scripts/run-dev-app.mjs",
      "console.log('cold-booted target');\n",
      "parent target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", targetHead]);

    const generation = "e".repeat(64);
    const entrypoint = join(
      workspace,
      "executors-v1",
      generation,
      "scripts",
      "deploy-dev-app.mjs",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    symlinkSync(script, entrypoint);
    const transaction = {
      schemaVersion: 1,
      targetHead,
      targetAuthority: "origin/main",
      executor: { generation, entrypoint },
      selection: {
        sourceHead,
        impact: {
          kind: "parent_reload",
          backendChanged: true,
          changedPathCount: 1,
          parentStrategy: "exec_handoff",
        },
      },
    };

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-verify",
      "--reconcile-parent-target",
      targetHead,
      "--queued-deploy-transaction",
      JSON.stringify(transaction),
    ]);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "skip",
      currentHead: targetHead,
      targetHead,
      dispatchAccepted: false,
      plannedTransition: {
        kind: "parent_reload",
        state: "not_started",
      },
    });
  });

  it("finishes selected child lifecycle after parent reconciliation converges", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const targetHead = commitPath(
      upstream,
      "src-tauri/src/lib.rs",
      "pub fn reconciled_native_target() {}\n",
      "reconciled native target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", targetHead]);

    const generation = "e".repeat(64);
    const entrypoint = join(
      workspace,
      "executors-v1",
      generation,
      "scripts",
      "deploy-dev-app.mjs",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    symlinkSync(script, entrypoint);
    const transaction = {
      schemaVersion: 1,
      targetHead,
      targetAuthority: "origin/main",
      executor: { generation, entrypoint },
      selection: {
        sourceHead: targetHead,
        impact: {
          kind: "backend_rebuild",
          backendChanged: true,
          changedPathCount: 1,
        },
      },
    };
    const fixture = await startChildRestartAuthority(live, {
      capabilities: [
        "child_restart",
        "parent_reload",
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ],
      sourceGeneration: devParentSourceGeneration(live),
      frontendIdentity: {
        pid: 6_432,
        processIdentity: "fixture-frontend",
        generation: "f".repeat(64),
      },
    });
    try {
      const result = await runAsync([
        "--live-worktree",
        live,
        "--json",
        "--force",
        "--no-verify",
        "--reconcile-parent-target",
        targetHead,
        "--queued-deploy-transaction",
        JSON.stringify(transaction),
      ]);

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "skip",
        targetHead,
        plannedTransition: { kind: "parent_reload", state: "converged" },
        residualTransition: { kind: "child_restart", state: "restarted" },
        dispatchAccepted: true,
      });
      expect(fixture.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
        "restart",
        "restart_ack",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("replays a failed frontend transition after parent convergence", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const coldBootedHead = commitPath(
      upstream,
      "scripts/run-dev-app.mjs",
      "console.log('cold-booted parent');\n",
      "cold-booted parent",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", coldBootedHead]);
    const sourceGeneration = devParentSourceGeneration(live);
    const targetHead = commitPath(
      upstream,
      "src/main.tsx",
      'import "./index.css";\n',
      "newer frontend target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);

    const generation = "c".repeat(64);
    const entrypoint = join(
      workspace,
      "executors-v1",
      generation,
      "scripts",
      "deploy-dev-app.mjs",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    symlinkSync(script, entrypoint);
    const transaction = {
      schemaVersion: 1,
      targetHead,
      targetAuthority: "origin/main",
      executor: { generation, entrypoint },
      selection: {
        sourceHead: coldBootedHead,
        impact: {
          kind: "frontend_reload",
          backendChanged: false,
          changedPathCount: 1,
        },
      },
    };
    const fixture = await startChildRestartAuthority(live, {
      capabilities: [
        "child_restart",
        "parent_reload",
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ],
      sourceGeneration,
      frontendIdentity: {
        pid: 6_432,
        processIdentity: "fixture-frontend",
        generation: "e".repeat(64),
      },
    });
    let transitionServer;
    try {
      const failed = await runAsync([
        "--live-worktree",
        live,
        "--port",
        "65534",
        "--json",
        "--force",
        "--no-verify",
        "--reconcile-parent-target",
        coldBootedHead,
        "--queued-deploy-transaction",
        JSON.stringify(transaction),
      ]);

      expect(failed.status, `${failed.stderr}\n${failed.stdout}`).toBe(1);
      expect(failed.stdout, failed.stderr).not.toBe("");
      expect(JSON.parse(failed.stdout)).toMatchObject({
        action: "deploy",
        currentHead: coldBootedHead,
        targetHead,
        plannedTransition: { kind: "parent_reload", state: "converged" },
        frontendTransition: { status: "failed" },
        dispatchAccepted: false,
      });

      transitionServer = await startFrontendTransitionServer(
        join(workspace, "cumulative-frontend-transition.json"),
      );
      publishFrontendControlDescriptor(live, transitionServer);
      const result = await runAsync([
        "--live-worktree",
        live,
        "--port",
        String(transitionServer.port),
        "--json",
        "--force",
        "--no-verify",
        "--reconcile-parent-target",
        targetHead,
        "--queued-deploy-transaction",
        JSON.stringify(transaction),
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "skip",
        currentHead: targetHead,
        targetHead,
        impact: transaction.selection.impact,
        plannedTransition: {
          kind: "parent_reload",
          state: "converged",
          attempted: false,
          relaunchDispatched: false,
          receipt: {
            type: "parent_generation_receipt",
            sourceGeneration,
          },
        },
        frontendTransition: {
          status: "dispatched",
          reloaded: ["main"],
        },
      });
      expect(fixture.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
        "parent_generation_probe",
        "parent_generation_probe",
        "parent_generation_probe",
      ]);
    } finally {
      await fixture.close();
      if (transitionServer) {
        await stopFrontendTransitionServer(transitionServer.child);
      }
    }
  });

  it("reconciles carried parent debt after a descendant target is already checked out", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const parentHead = commitPath(
      upstream,
      "scripts/run-dev-app.mjs",
      "console.log('carried parent');\n",
      "carried parent target",
    );
    const targetHead = commitPath(
      upstream,
      "src/main.tsx",
      'import "./index.css";\n',
      "descendant frontend target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", targetHead]);

    const generation = "c".repeat(64);
    const entrypoint = join(
      workspace,
      "executors-v1",
      generation,
      "scripts",
      "deploy-dev-app.mjs",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    symlinkSync(script, entrypoint);
    const transaction = {
      schemaVersion: 1,
      targetHead,
      targetAuthority: "origin/main",
      executor: { generation, entrypoint },
      selection: {
        sourceHead: parentHead,
        impact: {
          kind: "frontend_reload",
          backendChanged: false,
          changedPathCount: 1,
        },
      },
    };
    const fixture = await startChildRestartAuthority(live, {
      capabilities: [
        "child_restart",
        "parent_reload",
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ],
      sourceGeneration: devParentSourceGeneration(live),
      frontendIdentity: {
        pid: 6_432,
        processIdentity: "fixture-frontend",
        generation: "d".repeat(64),
      },
    });
    const transitionServer = await startFrontendTransitionServer(
      join(workspace, "checked-out-descendant-frontend-transition.json"),
    );
    publishFrontendControlDescriptor(live, transitionServer);
    try {
      const result = await runAsync([
        "--live-worktree",
        live,
        "--port",
        String(transitionServer.port),
        "--json",
        "--force",
        "--no-verify",
        "--reconcile-parent-target",
        parentHead,
        "--queued-deploy-transaction",
        JSON.stringify(transaction),
      ]);

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "skip",
        currentHead: targetHead,
        targetHead,
        plannedTransition: {
          kind: "parent_reload",
          state: "converged",
        },
        frontendTransition: { status: "dispatched", reloaded: ["main"] },
        dispatchAccepted: true,
      });
      expect(fixture.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
        "parent_generation_probe",
      ]);
    } finally {
      await fixture.close();
      await stopFrontendTransitionServer(transitionServer.child);
    }
  });

  it("restarts cumulative backend debt after parent convergence at an already checked-out target", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    commitPath(
      upstream,
      "scripts/run-dev-app.mjs",
      "console.log('cumulative parent');\n",
      "cumulative parent target",
    );
    const reconciliationHead = commitPath(
      upstream,
      "src-tauri/src/lib.rs",
      "pub fn cumulative_backend_target() {}\n",
      "cumulative backend target",
    );
    const targetHead = commitPath(
      upstream,
      "src/main.tsx",
      'import "./index.css";\n',
      "newer frontend target",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", targetHead]);

    const generation = "b".repeat(64);
    const entrypoint = join(
      workspace,
      "executors-v1",
      generation,
      "scripts",
      "deploy-dev-app.mjs",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    symlinkSync(script, entrypoint);
    const transaction = {
      schemaVersion: 1,
      targetHead,
      targetAuthority: "origin/main",
      executor: { generation, entrypoint },
      selection: {
        sourceHead,
        impact: {
          kind: "parent_reload",
          backendChanged: true,
          changedPathCount: 3,
          parentStrategy: "exec_handoff",
          childRestartRequired: true,
        },
      },
    };
    const fixture = await startChildRestartAuthority(live, {
      capabilities: [
        "child_restart",
        "parent_reload",
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ],
      sourceGeneration: devParentSourceGeneration(live),
      frontendIdentity: {
        pid: 6_432,
        processIdentity: "fixture-frontend",
        generation: "c".repeat(64),
      },
    });
    try {
      const result = await runAsync([
        "--live-worktree",
        live,
        "--json",
        "--force",
        "--no-verify",
        "--reconcile-parent-target",
        reconciliationHead,
        "--queued-deploy-transaction",
        JSON.stringify(transaction),
      ]);

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "skip",
        currentHead: targetHead,
        targetHead,
        impact: transaction.selection.impact,
        plannedTransition: { kind: "parent_reload", state: "converged" },
        residualTransition: { kind: "child_restart", state: "restarted" },
        dispatchAccepted: true,
      });
      expect(fixture.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
        "restart",
        "restart_ack",
      ]);
    } finally {
      await fixture.close();
    }
  });

  async function expectResidualChildRestart(
    _caseName,
    relativePath,
    contents,
    commitMessage,
  ) {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const activeParentHead = commitPath(
      upstream,
      "scripts/run-dev-app.mjs",
      "console.log('active parent');\n",
      "active parent",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", activeParentHead]);
    const sourceGeneration = devParentSourceGeneration(live);
    const targetHead = commitPath(
      upstream,
      relativePath,
      contents,
      commitMessage,
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);

    const generation = "7".repeat(64);
    const entrypoint = join(
      workspace,
      "executors-v1",
      generation,
      "scripts",
      "deploy-dev-app.mjs",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    symlinkSync(script, entrypoint);
    const transaction = {
      schemaVersion: 1,
      targetHead,
      targetAuthority: "origin/main",
      executor: { generation, entrypoint },
      selection: {
        sourceHead,
        impact: {
          kind: "parent_reload",
          backendChanged: true,
          changedPathCount: 2,
          parentStrategy: "exec_handoff",
        },
      },
    };
    const fixture = await startChildRestartAuthority(live, {
      capabilities: [
        "child_restart",
        "parent_reload",
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ],
      sourceGeneration,
      frontendIdentity: {
        pid: 6_432,
        processIdentity: "fixture-frontend",
        generation: "e".repeat(64),
      },
    });
    try {
      const result = await runAsync([
        "--live-worktree",
        live,
        "--json",
        "--force",
        "--no-verify",
        "--queued-deploy-transaction",
        JSON.stringify(transaction),
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "deploy",
        currentHead: sourceHead,
        targetHead,
        impact: transaction.selection.impact,
        plannedTransition: {
          kind: "parent_reload",
          state: "converged",
          receipt: {
            type: "parent_generation_receipt",
            sourceGeneration,
          },
        },
        residualTransition: {
          kind: "child_restart",
          state: "restarted",
          receipt: { type: "restart_receipt" },
        },
      });
      expect(fixture.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
        "parent_generation_probe",
        "restart",
        "restart_ack",
      ]);
    } finally {
      await fixture.close();
    }
  }

  it.each([
    [
      "child preparation",
      "hmux/crates/hmux-client/src/lib.rs",
      "pub fn residual_child_restart() {}\n",
      "newer child target",
    ],
    [
      "backend rebuild",
      "src-tauri/src/lib.rs",
      "pub fn residual_backend_restart() {}\n",
      "newer backend target",
    ],
  ])(
    "executes a residual child restart after the cumulative parent generation is already active (%s)",
    expectResidualChildRestart,
  );

  it("살아 있는 소유자의 잠금이 있으면 배포하지 않는다 — 머신 단일 writer", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const before = git(live, ["rev-parse", "HEAD"]);
    commit(upstream, "one");
    // 이 테스트 프로세스를 살아 있는 소유자로 세운다.
    writeFileSync(join(home, ".dure", "dev-deploy.lock"), `${process.pid}\n`);

    const result = run(["--live-worktree", live, "--json", "--force", "--no-verify"]);
    expect(JSON.parse(result.stdout).action).toBe("defer");
    expect(JSON.parse(result.stdout).reason).toMatch(/lock/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("죽은 소유자의 잠금은 회수한다 — 중단된 배포가 이후를 영구히 막지 않는다", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const target = commit(upstream, "one");
    // 존재할 수 없는 pid: 절대 살아 있지 않다.
    writeFileSync(join(home, ".dure", "dev-deploy.lock"), "2147483646\n");

    const result = run(["--live-worktree", live, "--json", "--force", "--no-verify"]);
    expect(JSON.parse(result.stdout).action).toBe("deploy");
    expect(git(live, ["rev-parse", "HEAD"])).toBe(target);
  });

  it("daily deploy ends after applying the target without runtime verification", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const target = commit(upstream, "one");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      // A persisted request from the old queue may still carry this option.
      // It must be a compatibility no-op, not a verification switch.
      "--verify-timeout",
      "0",
      "--port",
      "59999",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "deploy",
      deployed: true,
      targetHead: target,
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("verification");
    expect(JSON.parse(result.stdout)).not.toHaveProperty("liveVerified");
    expect(git(live, ["rev-parse", "HEAD"])).toBe(target);
  });

  it("워크트리를 지정하지 않으면 조용히 넘어가지 않고 실패한다", () => {
    const result = run(["--json"], { DURE_DEV_LIVE_WORKTREE: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/live dev worktree is required/);
  });

  it("legacy worktree environment cannot silently select a deploy target", () => {
    const live = join(workspace, "live");
    const result = run(["--json"], {
      DURE_DEV_LIVE_WORKTREE: "",
      HEBBIAN_DEV_WORKTREE: live,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/HEBBIAN_DEV_WORKTREE is ambiguous/);
    expect(result.stderr).toMatch(/DURE_DEV_LIVE_WORKTREE/);
  });

  it("prefers the canonical worktree environment over the legacy variable", () => {
    const live = join(workspace, "live");
    const result = run(["--json", "--no-verify"], {
      DURE_DEV_LIVE_WORKTREE: live,
      HEBBIAN_DEV_WORKTREE: join(workspace, "legacy"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).liveWorktree).toBe(realpathSync(live));
  });

  it("rejects a valueless live worktree argument instead of using the environment", () => {
    const live = join(workspace, "live");
    const result = run(["--live-worktree"], {
      DURE_DEV_LIVE_WORKTREE: live,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--live-worktree requires a value/);
  });

  it("--restart-only는 ff 없이 재기동 dispatch만 한다", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const before = git(live, ["rev-parse", "HEAD"]);
    // 올릴 커밋이 있어도 무시해야 한다 — 이 모드는 배포가 아니다.
    commit(upstream, "one");
    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--restart-only",
      "--port",
      "59999",
      "--verify-timeout",
      "1",
    ]);
    const report = JSON.parse(result.stdout);
    expect(report.action).toBe("restart-only");
    expect(report.currentHead).toBe(before);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(before);
    // Supervisor authority가 없으니 mutation 전에 물러난다.
    expect(report.recovery.attempted).toBe(false);
    expect(report.recovery.reason).toMatch(
      /dev_launch_supervisor_authority_unavailable/,
    );
    expect(report.dispatched).toBe(false);
    expect(report).not.toHaveProperty("verification");
    expect(result.status).toBe(1);
  });

  it("legacy --no-verify does not change restart dispatch failure", () => {
    const live = join(workspace, "live");
    const result = run(["--live-worktree", live, "--json", "--restart-only", "--no-verify"]);
    const report = JSON.parse(result.stdout);
    expect(report.action).toBe("restart-only");
    expect(report).not.toHaveProperty("verification");
    expect(result.status).toBe(1);
  });

  it("--restart-only 텍스트 보고는 실제 재기동 결과를 숨기지 않는다", () => {
    const live = join(workspace, "live");
    const result = run(["--live-worktree", live, "--restart-only", "--no-verify"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(
      /restart-only: .*dev_launch_supervisor_authority_unavailable/,
    );
  });
});
