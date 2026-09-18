import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";
import {
  DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
  attachDevDeployAttemptExecutor,
  beginDevDeployAttempt,
  cancelDevDeploy,
  enqueueDevDeploy,
  reconcileDevDeployAttempt,
  recordDevDeployAttemptPhase,
  recordDevDeployColdBootstrapSubmission,
  settleDevDeployAttempt as settleDevDeployAttemptState,
} from "./lib/dev-deploy-queue.mjs";
import { DevDeployQueueStore } from "./lib/dev-deploy-queue-store.mjs";
import { processIdentity } from "./lib/process-identity.mjs";
import {
  appControlDirectory,
  devHmuxToolPaths,
  resolveDevServer,
  worktreeDevIdentity,
} from "./lib/app-channel.mjs";
import { parseColdBootstrapOperationId } from "./lib/dev-cold-bootstrap-operation.mjs";
import {
  DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY,
  DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
  DEV_HMUX_STANDALONE_OPERATION_MODE,
  DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY,
  DEV_HMUX_STANDALONE_RETIRE_CAPABILITY,
} from "./lib/dev-hmux-operation-contract.mjs";
import { targetDevHmuxBuildId } from "./lib/dev-hmux-tool.mjs";
import { resolvePinnedDevNodeTool } from "./lib/dev-node-tool.mjs";
import { COREPACK_EXECUTABLE_ENV } from "./lib/corepack-install.mjs";
import {
  PACKAGE_SCRIPT_SHELL_ENV,
  POSIX_SHELL_EXECUTABLE_ENV,
  resolveCorepackExecutable,
  resolvePosixShellExecutable,
} from "./lib/unix-process-tools.mjs";
import { persistDevServerProfile } from "./lib/dev-server-profile.mjs";
import {
  DEV_DEPLOY_EXECUTOR_FILES,
  devDeployQueueEntrypoint,
  stageDevDeployExecutor,
} from "./lib/dev-deploy-executor.mjs";
import {
  DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
} from "./lib/dev-launch-contract.mjs";
import {
  DEV_PARENT_SOURCE_PATHS,
  devParentSourceGeneration,
} from "./lib/dev-launch-impact.mjs";
import { HMUX_DEV_RUNTIME_INPUTS } from "./lib/hmux-dev-build-inputs.mjs";
import { checkpointWorktree } from "./lib/worktree-wip.mjs";
import { startConvergentDevLaunchParentFixture } from "./lib/dev-launch-test-support.mjs";

const script = fileURLToPath(
  new URL("./queue-dev-app-deploy.mjs", import.meta.url),
);
const repositoryRoot = dirname(dirname(script));
const controlPlaneInstallerFixture = fileURLToPath(
  new URL(
    "./fixtures/install-dev-control-plane-payload.mjs",
    import.meta.url,
  ),
);
const fixtureEnvironment = scriptTestEnvironment({
  CARGO_HOME: process.env.CARGO_HOME,
  RUSTUP_HOME: process.env.RUSTUP_HOME,
});
const TEST_TARGET = "a".repeat(40);
const NEXT_TEST_TARGET = "b".repeat(40);
const TEST_EXECUTOR_GENERATION = "c".repeat(64);
const HMUX_FIXTURE_CAPABILITIES = Object.freeze([
  DEV_HMUX_STANDALONE_OPERATION_CAPABILITY,
  DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY,
  DEV_HMUX_STANDALONE_RETIRE_CAPABILITY,
  DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY,
]);
const REFUSING_HMUX_FIXTURE_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const args = process.argv.slice(2);
const version = path.dirname(path.dirname(fs.realpathSync(__filename)));
const buildId = JSON.parse(
  fs.readFileSync(path.join(version, "install.json"), "utf8"),
).buildId;
if (args[0] === "capabilities") {
  process.stdout.write(fs.readFileSync(path.join(version, "capabilities.json")));
  process.exit(0);
}
const frame = fs.readFileSync(0);
const length = frame.readUInt32BE(0);
if (length < 1 || frame.length !== length + 4) process.exit(2);
const request = JSON.parse(frame.subarray(4).toString("utf8"));
const acknowledgeMode = ${JSON.stringify(
  DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
)};
const capture = path.join(process.env.HOME, "hmux-queue-capture.json");
const previous = fs.existsSync(capture)
  ? JSON.parse(fs.readFileSync(capture, "utf8"))
  : { calls: [] };
fs.writeFileSync(capture, JSON.stringify({
  calls: [...previous.calls, {
    args,
    cwd: process.cwd(),
    home: process.env.HOME,
    request,
    buildId,
    head: childProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim(),
  }],
}));
const outcomePath = path.join(process.env.HOME, "hmux-queue-outcome");
const outcome = request.mode === acknowledgeMode
  ? "acknowledged"
  : fs.existsSync(outcomePath)
    ? fs.readFileSync(outcomePath, "utf8").trim()
    : "pending";
const responseBody = outcome === "acknowledged"
  ? {
      outcome,
      schemaVersion: 1,
      operationId: request.operationId,
    }
  : outcome === "retired"
  ? {
      outcome,
      schemaVersion: 1,
      operationId: request.operationId,
      sessionName: request.sessionName,
      sessionId: \`standalone_\${request.operationId}\`,
      workspaceId: "workspace-retired-target",
    }
  : {
      outcome,
      schemaVersion: 1,
      operationId: request.operationId,
      errorCode: outcome === "pending"
        ? "hmux_queue_operation_fixture_pending"
        : "hmux_queue_operation_fixture_refused",
    };
const payload = Buffer.from(JSON.stringify(responseBody));
const response = Buffer.allocUnsafe(payload.length + 4);
response.writeUInt32BE(payload.length);
payload.copy(response, 4);
process.stdout.write(response);
`;
const HMUX_RUNTIME_FIXTURE_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const version = path.dirname(path.dirname(fs.realpathSync(__filename)));
const { buildId } = JSON.parse(
  fs.readFileSync(path.join(version, "install.json"), "utf8"),
);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  buildId,
  source: "hmux_runtime",
}));
`;

function controlPlaneActivationProof(sourceRevision = TEST_TARGET) {
  return {
    schemaVersion: 1,
    sourceRevision,
    cliArtifactDigest: "1".repeat(64),
    controlPlaneExecutableSha256: "2".repeat(64),
    claudePayloadDigest: "3".repeat(64),
    backendId: "dure-local",
    backendGeneration: `local-v1-${"4".repeat(32)}`,
  };
}

function hmuxActivationProof(worktree, sourceRevision = TEST_TARGET) {
  return {
    schemaVersion: 1,
    sourceRevision,
    channel: worktreeDevIdentity(realpathSync(worktree)).channel,
    buildId: "0.1.4+dev.fixture.activation",
  };
}

function testTransaction(
  targetHead = TEST_TARGET,
  entrypoint =
    `/tmp/executors-v1/${TEST_EXECUTOR_GENERATION}/scripts/deploy-dev-app.mjs`,
) {
  return {
    schemaVersion: 1,
    targetHead,
    targetAuthority: "origin/main",
    executor: {
      generation: TEST_EXECUTOR_GENERATION,
      entrypoint,
    },
  };
}

function completeImpact(impact) {
  if (!impact) return impact;
  return {
    ...impact,
    backendChanged:
      impact.backendChanged ?? impact.kind === "backend_rebuild",
    changedPathCount: impact.changedPathCount ?? 1,
    ...(impact.kind === "parent_reload" && !impact.parentStrategy
      ? { parentStrategy: "exec_handoff" }
      : {}),
  };
}

function settleDevDeployAttempt(state, input) {
  const receipt = input.receipt
    ? {
        ...input.receipt,
        liveWorktree: input.receipt.liveWorktree ?? state.worktree,
        transaction:
          input.receipt.transaction ?? state.activeAttempt.transaction,
        ...(input.receipt.impact
          ? { impact: completeImpact(input.receipt.impact) }
          : {}),
        ...(input.receipt.action === "deploy" &&
        input.receipt.verification?.status === "ok" &&
        input.receipt.liveVerified === undefined
          ? { liveVerified: true }
          : {}),
      }
    : input.receipt;
  return settleDevDeployAttemptState(state, { ...input, receipt });
}

let workspace;
let home;
const ownedDevLaunchFixtures = [];

function git(cwd, args) {
  return execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "gpg.format=openpgp", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...fixtureEnvironment,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    },
  ).trim();
}

function commit(cwd, message) {
  return commitContents(cwd, `${message}\n`, message);
}

function commitContents(cwd, contents, message) {
  const file = join(cwd, "file.txt");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  git(cwd, ["add", "file.txt"]);
  git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function commitPath(cwd, relativePath, contents, message) {
  const file = join(cwd, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  git(cwd, ["add", relativePath]);
  git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function run(args, extraEnv = {}, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...fixtureEnvironment,
      HOME: home,
      DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
      DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
      ...extraEnv,
    },
  });
}

function runQueueScript(entrypoint, args, extraEnv = {}, cwd) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...fixtureEnvironment,
      HOME: home,
      DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
      ...extraEnv,
    },
  });
}

function copyDeployExecutorSources(destination) {
  for (const relativePath of DEV_DEPLOY_EXECUTOR_FILES) {
    const targetPath = join(destination, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(join(repositoryRoot, relativePath)));
  }
}

function startOwnedDevLaunchFixture(live) {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)", "scripts/run-dev-app.mjs"],
    {
      cwd: live,
      env: fixtureEnvironment,
      stdio: "ignore",
    },
  );
  ownedDevLaunchFixtures.push(child);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return child;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function unboundTcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function withTcpListener(port, action) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  try {
    return await action();
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function statePath() {
  return join(home, ".dure", "dev-deploy", "queue-v2.json");
}

function coordinationPath() {
  return join(home, ".dure", "dev-deploy", "coordination-v1.sqlite");
}

function readState() {
  return JSON.parse(readFileSync(statePath(), "utf8"));
}

function enqueuePending(store, live, {
  nowMs = Date.now(),
  transaction = testTransaction(),
} = {}) {
  const worktree = realpathSync(live);
  return store.mutate(() =>
    enqueueDevDeploy({
      worktree,
      attemptArgs: ["--live-worktree", worktree],
      transaction,
      executionEnvironment: { HOME: home, PATH: process.env.PATH },
      receipt: { action: "defer", targetHead: transaction.targetHead },
      nowMs,
      maxWaitMs: 60_000,
      pollMs: 10,
    }),
  );
}

function persistLiveDevServer(live, port) {
  const worktreeRoot = realpathSync(live);
  const { channel } = worktreeDevIdentity(worktreeRoot);
  return persistDevServerProfile({
    home,
    channel,
    worktreeRoot,
    devServer: resolveDevServer(worktreeRoot, String(port)),
  });
}

function installRefusingColdBootstrapHmux(live, homeDirectory = home) {
  const { channel } = worktreeDevIdentity(realpathSync(live));
  const paths = devHmuxToolPaths(homeDirectory, channel);
  const buildId = targetDevHmuxBuildId({ root: live, home: homeDirectory });
  const version = join(paths.installRoot, "versions", buildId);
  const executable = join(version, "bin", "hmux");
  const runtime = join(version, "bin", "hmux-runtime");
  mkdirSync(join(version, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(paths.commandDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(version, "install.json"),
    `${JSON.stringify({ schemaVersion: 1, buildId })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(version, "capabilities.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      buildInfo: { buildId, source: "hmux_cli" },
      capabilities: HMUX_FIXTURE_CAPABILITIES,
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(executable, REFUSING_HMUX_FIXTURE_SOURCE, { mode: 0o700 });
  writeFileSync(runtime, HMUX_RUNTIME_FIXTURE_SOURCE, { mode: 0o700 });
  chmodSync(executable, 0o700);
  chmodSync(runtime, 0o700);
  symlinkSync(`versions/${buildId}`, join(paths.installRoot, "current"));
  symlinkSync(
    join(paths.installRoot, "current", "bin", "hmux"),
    paths.hmuxCommand,
  );
  return buildId;
}

async function startRuntimeFixture(live, generation) {
  const root = realpathSync(live);
  const binaryDirectory = join(root, "src-tauri", "target", "debug");
  const binaryPath = join(binaryDirectory, "dure");
  mkdirSync(binaryDirectory, { recursive: true });
  symlinkSync(process.execPath, binaryPath);
  const child = spawn(
    binaryPath,
    [
      "-e",
      `
        const http = require("node:http");
        const fs = require("node:fs");
        const childProcess = require("node:child_process");
        const server = http.createServer((request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.url.startsWith("/__dure_dev_deploy_hmr_status")) {
            const lock = JSON.parse(fs.readFileSync(process.env.FIXTURE_DEPLOY_LOCK, "utf8"));
            response.end(JSON.stringify({
              schemaVersion: 1,
              fenced: true,
              generation: lock.generation,
              observedAtUnixMs: Date.now(),
              suppressedCount: 0,
            }));
            return;
          }
          if (request.url.startsWith("/__app_build_info")) {
            const sourceRevision = childProcess.execFileSync(
              "git",
              ["rev-parse", "--short=12", "HEAD"],
              { cwd: process.cwd(), encoding: "utf8" },
            ).trim();
            response.end(JSON.stringify({
              schemaVersion: 1,
              buildId: "0.0.0+fixture",
              sourceRevision,
              worktreeOverlay: "clean",
              backendRuntimeFingerprint: null,
            }));
            return;
          }
          response.setHeader("content-type", "text/javascript");
          response.end("export {};");
        });
        server.listen(0, () => process.send({ port: server.address().port }));
        process.on("SIGTERM", () => server.close(() => process.exit(0)));
      `,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        FIXTURE_DEPLOY_LOCK: join(home, ".dure", "dev-deploy.lock"),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const [message] = await once(child, "message");
  const { channel } = worktreeDevIdentity(root);
  const controlDirectory = appControlDirectory(home, channel);
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  persistLiveDevServer(live, message.port);
  writeFileSync(
    join(controlDirectory, "server.json"),
    `${JSON.stringify({
      port: message.port,
      token: "fixture-control-token",
      startedAtUnixMs: Date.now(),
      processId: child.pid,
      buildId: "fixture-build",
      generation,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    child,
    stop: async () => {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    },
  };
}

async function startParentGenerationFixture(
  live,
  sourceGeneration,
) {
  const root = realpathSync(live);
  const { channel } = worktreeDevIdentity(root);
  const frontend = {
    pid: 6_432,
    processIdentity: "fixture-frontend-one",
    generation: "d".repeat(64),
  };
  return startConvergentDevLaunchParentFixture({
    fixtureRoot: workspace,
    home,
    worktreeRoot: root,
    channel,
    capabilities: [
      "child_restart",
      "parent_reload",
      DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
    ],
    sourceGeneration,
    frontendIdentity: frontend,
  });
}

function persistStaleParentFailure(live, activatedHead, targetHead) {
  const root = realpathSync(live);
  const nowMs = Date.now();
  const store = new DevDeployQueueStore({ homeDirectory: home });
  store.mutate(() => {
    const parentImpact = completeImpact({ kind: "parent_reload" });
    const pending = enqueueDevDeploy({
      worktree: root,
      attemptArgs: ["--force", "--live-worktree", root],
      transaction: {
        ...testTransaction(targetHead),
        selection: { sourceHead: activatedHead, impact: parentImpact },
      },
      executionEnvironment: { HOME: home, PATH: process.env.PATH },
      receipt: {
        currentHead: activatedHead,
        targetHead,
        pendingCommits: 1,
        impact: parentImpact,
      },
      nowMs,
      maxWaitMs: 60_000,
      pollMs: 5_000,
    });
    const failed = settleDevDeployAttempt(
      beginDevDeployAttempt(pending, nowMs),
      {
        attemptGeneration: pending.generation,
        exitCode: 1,
        receipt: {
          action: "deploy",
          deployed: true,
          currentHead: activatedHead,
          targetHead,
          impact: parentImpact,
          expectedParentSourceGeneration: devParentSourceGeneration(root),
          verification: { status: "skew" },
        },
        nowMs: nowMs + 1,
        pollMs: 5_000,
      },
    );
    return {
      ...failed,
      lastSuccessfulDeployment: {
        sourceHead: activatedHead,
        backendHead: activatedHead,
        hmuxActivation: hmuxActivationProof(live, activatedHead),
        verifiedAtMs: nowMs - 1,
      },
    };
  });
  store.close();
}

function installParentSourceFixture(upstream) {
  for (const relativePath of [
    ...DEV_PARENT_SOURCE_PATHS,
    "src-tauri/tauri.conf.json",
  ]) {
    const targetPath = join(upstream, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(join(repositoryRoot, relativePath)));
  }
}

function installHmuxBuildIdentityFixture(upstream) {
  for (const [relativePath, contents] of [
    ["hmux/Cargo.toml", '[workspace.package]\nversion = "0.1.4"\n'],
    ["hmux/fixture-source.rs", "pub const FIXTURE: &str = \"hmux\";\n"],
    [
      "crates/hebbian-process-sampler/fixture-source.rs",
      "pub const FIXTURE: &str = \"sampler\";\n",
    ],
    [
      "scripts/run-with-build-storage.mjs",
      `import { spawnSync } from "node:child_process";
const separator = process.argv.indexOf("--");
const result = spawnSync(process.argv[separator + 1], process.argv.slice(separator + 2), {
  env: process.env,
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
`,
    ],
    [
      "scripts/stage-hmux-remote-resources.sh",
      `#!/bin/sh
set -eu
: "\${DURE_HMUX_STAGE_DEPLOY_AUTHORIZATION:?}"
test "$1" = debug
`,
    ],
    [
      "scripts/stage-hmux-runtime.sh",
      `#!/bin/sh
set -eu
: "\${DURE_HMUX_STAGE_DEPLOY_AUTHORIZATION:?}"
hmux_fixture_build_id=\$(node scripts/hmux-dev-build-id.mjs)
HMUX_DEV_BUILD_ID="\$hmux_fixture_build_id" node scripts/install-hmux-fixture.mjs
printf 'DURE_HMUX_ACTIVATION_V1 %s\\n' "\$hmux_fixture_build_id"
`,
    ],
    [
      "scripts/prepare-hmux-dev-tools.sh",
      "#!/bin/sh\nset -eu\nexec node scripts/install-hmux-fixture.mjs\n",
    ],
    [
      "scripts/install-hmux-fixture.mjs",
      `import fs from "node:fs";
import path from "node:path";

const home = process.env.HOME;
const channel = process.env.HMUX_DEV_CHANNEL;
const buildId = process.env.HMUX_DEV_BUILD_ID;
const installRoot = path.join(home, ".local", "share", "hmux", "channels", channel);
const version = path.join(installRoot, "versions", buildId);
const executable = path.join(version, "bin", "hmux");
const runtime = path.join(version, "bin", "hmux-runtime");
const capabilities = path.join(version, "capabilities.json");
fs.mkdirSync(path.join(version, "bin"), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(version, "install.json"),
  JSON.stringify({ schemaVersion: 1, buildId }) + "\\n",
  { mode: 0o600 },
);
fs.writeFileSync(
  capabilities,
  JSON.stringify({
    schemaVersion: 2,
    buildInfo: { buildId, source: "hmux_cli" },
    capabilities: ${JSON.stringify(HMUX_FIXTURE_CAPABILITIES)},
  }),
  { mode: 0o600 },
);
fs.writeFileSync(executable, ${JSON.stringify(REFUSING_HMUX_FIXTURE_SOURCE)}, {
  mode: 0o700,
});
fs.writeFileSync(runtime, ${JSON.stringify(HMUX_RUNTIME_FIXTURE_SOURCE)}, {
  mode: 0o700,
});
const current = path.join(installRoot, "current");
fs.rmSync(current, { force: true, recursive: false });
fs.symlinkSync(path.join("versions", buildId), current);
fs.writeFileSync(path.join(home, "prepared-hmux-build-id"), buildId + "\\n");
`,
    ],
  ]) {
    const targetPath = join(upstream, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents);
  }
  for (const input of HMUX_DEV_RUNTIME_INPUTS) {
    if (input.recursive) continue;
    const targetPath = join(upstream, input.path);
    if (existsSync(targetPath)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(
      targetPath,
      input.path === "rust-toolchain.toml"
        ? readFileSync(join(repositoryRoot, input.path))
        : `${input.path}\n`,
    );
  }
}

function prepareCheckedOutParentTarget() {
  const upstream = join(workspace, "upstream");
  const live = join(workspace, "live");
  const activatedHead = git(live, ["rev-parse", "HEAD"]);
  installParentSourceFixture(upstream);
  const parentPath = join(upstream, "scripts/run-dev-app.mjs");
  writeFileSync(parentPath, "console.log('checked-out parent target');\n");
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "--quiet", "-m", "checked-out parent target"]);
  const targetHead = git(upstream, ["rev-parse", "HEAD"]);
  git(live, ["fetch", "origin", "main", "--quiet"]);
  git(live, ["merge", "--ff-only", "--quiet", targetHead]);
  return { activatedHead, live, targetHead };
}

function createUserWipFixture(live) {
  const trackedPath = join(live, "file.txt");
  const untrackedPath = join(live, "preserved-user-wip.txt");
  writeFileSync(trackedPath, "preserved tracked user WIP\n");
  writeFileSync(untrackedPath, "preserved untracked user WIP\n");
  const status = git(live, ["status", "--porcelain=v1", "-uall"]);
  const tracked = readFileSync(trackedPath);
  const untracked = readFileSync(untrackedPath);
  return () => {
    expect(git(live, ["status", "--porcelain=v1", "-uall"])).toBe(status);
    expect(readFileSync(trackedPath)).toEqual(tracked);
    expect(readFileSync(untrackedPath)).toEqual(untracked);
  };
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "deploy-queue-"));
  home = mkdtempSync(join(tmpdir(), "deploy-queue-home-"));
  mkdirSync(join(home, ".dure"), { recursive: true });

  const upstream = join(workspace, "upstream");
  execFileSync("git", ["init", "--quiet", "-b", "main", upstream], {
    env: fixtureEnvironment,
  });
  commit(upstream, "base");
  for (const relativePath of DEV_DEPLOY_EXECUTOR_FILES) {
    const targetPath = join(upstream, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(join(repositoryRoot, relativePath)));
  }
  symlinkSync(
    controlPlaneInstallerFixture,
    join(upstream, "scripts", "install-dure-cli.mjs"),
  );
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "--quiet", "-m", "deploy executor baseline"]);
  const live = join(workspace, "live");
  // Git transport tolerates auto-maintenance repacking the source during clone.
  execFileSync("git", ["clone", "--no-local", "--quiet", upstream, live], {
    env: fixtureEnvironment,
  });
  git(live, ["checkout", "--quiet", "-B", "main", "origin/main"]);
});

afterEach(async () => {
  for (const child of ownedDevLaunchFixtures.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await closed;
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("queued daily-driver deploy command", () => {
  it.each(["portable", "relative", "unset", "empty", "legacy"])("replays the requested %s app home instead of the runner app home", (selection) => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const requestedHome = selection === "portable" ? join(home, "portable-a")
      : selection === "relative" ? join(realpathSync(workspace), "portable-relative") : "";
    const requestedValue = selection === "relative" ? "portable-relative" : requestedHome;
    const runnerHome = join(home, "portable-b");
    const capturePath = join(workspace, "deploy-environment.json");
    const sourcePath = join(upstream, "scripts", "deploy-dev-app.mjs");
    startOwnedDevLaunchFixture(live);
    commitPath(upstream, "scripts/deploy-dev-app.mjs", `
import * as qaEnvironmentFs from "node:fs";
qaEnvironmentFs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  dureHome: process.env.DURE_HOME ?? "",
  discoveryRoot: process.env.HMUX_DISCOVERY_ROOT ?? null,
}));
${readFileSync(sourcePath, "utf8").replace(/^#![^\n]*\n/, "")}`, "record queued app-home selection");
    const lockRoots = [join(home, ".dure"), ...(requestedHome ? [requestedHome] : []),
      ...(selection === "relative" ? [join(live, "portable-relative")] : [])];
    for (const root of lockRoots) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "dev-deploy.lock"), `${process.pid}\n`);
    }
    const requested = run(["--live-worktree", live, "--json", "--force"], {
      ...(selection === "unset" || selection === "legacy" ? {} : { DURE_HOME: requestedValue }),
    }, workspace);
    expect(requested.status, requested.stderr).toBe(0);
    expect(readState().status).toBe("pending");
    for (const root of lockRoots) unlinkSync(join(root, "dev-deploy.lock"));
    const store = new DevDeployQueueStore({ homeDirectory: home });
    store.mutate((current) => {
      const executionEnvironment = { ...current.request.executionEnvironment };
      if (selection === "legacy") delete executionEnvironment.DURE_HOME;
      return {
        ...current,
        request: { ...current.request, executionEnvironment },
        nextAttemptAtMs: Date.now() - 1,
      };
    });
    store.close();

    const executor = readState().request.transaction.executor;
    const runnerEntrypoint = devDeployQueueEntrypoint(executor);
    const resumed = runQueueScript(runnerEntrypoint, [
      "--internal-runner", "--once",
      "--internal-runner-executor-generation", executor.generation,
    ], {
      DURE_HOME: runnerHome,
      HMUX_DISCOVERY_ROOT: join(home, "runner-pane-catalog"),
    }, dirname(runnerEntrypoint));
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
      dureHome: selection === "legacy" ? runnerHome : requestedHome || join(home, ".dure"),
      discoveryRoot: null,
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readState().request.executionEnvironment.DURE_HOME).toBe(
      selection === "legacy" ? undefined : requestedHome,
    );
    expect(existsSync(join(runnerHome, "dev-deploy"))).toBe(false);
  });
  it("rejects the ambiguous legacy worktree selector before reserving a deploy", () => {
    const live = join(workspace, "live");
    const result = run(["--worktree", live, "--json", "--no-verify"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--worktree is ambiguous/);
    expect(result.stderr).toMatch(/--live-worktree/);
    expect(existsSync(statePath())).toBe(false);
  });

  it("refuses a different checkout while the verified daily-driver runtime is alive", () => {
    const live = join(workspace, "live");
    const liveRoot = realpathSync(live);
    const other = join(workspace, "other");
    const upstream = join(workspace, "upstream");
    execFileSync("git", ["clone", "--no-local", "--quiet", upstream, other], {
      env: fixtureEnvironment,
    });
    const identity = processIdentity(process.pid);
    expect(identity).toBeTruthy();
    const request = enqueueDevDeploy({
      worktree: liveRoot,
      attemptArgs: ["--live-worktree", liveRoot],
      transaction: testTransaction(),
      executionEnvironment: { HOME: home, PATH: process.env.PATH },
      receipt: { action: "defer", targetHead: TEST_TARGET },
      nowMs: 1_000,
      maxWaitMs: 60_000,
      pollMs: 5_000,
    });
    const verified = settleDevDeployAttempt(
      beginDevDeployAttempt(request, 2_000),
      {
        attemptGeneration: request.generation,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TEST_TARGET,
          impact: { kind: "frontend_reload" },
          verification: { status: "ok" },
          runtime: {
            pid: process.pid,
            processIdentity: identity,
            observedAtMs: 2_500,
          },
        },
        nowMs: 3_000,
        pollMs: 5_000,
      },
    );
    const store = new DevDeployQueueStore({ homeDirectory: home });
    store.mutate(() => verified);
    store.close();
    const before = readFileSync(statePath(), "utf8");

    const result = run([
      "--live-worktree",
      other,
      "--json",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/live_worktree_mismatch/);
    expect(result.stderr).toContain(liveRoot);
    expect(readFileSync(statePath(), "utf8")).toBe(before);
  });

  it("--help는 deploy request를 만들거나 기존 queue 상태를 덮어쓰지 않는다", () => {
    const emptyStatus = run(["--queue-status", "--json"]);
    expect(emptyStatus.status).toBe(0);
    expect(JSON.parse(emptyStatus.stdout).queue.status).toBe("empty");
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(coordinationPath())).toBe(false);

    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).toContain("pnpm app:dev:deploy:resume");
    expect(existsSync(statePath())).toBe(false);

    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "queued-before-help");
    expect(run(["--live-worktree", live, "--json", "--no-verify"]).status).toBe(0);
    expect(readState().generation).toBe(1);
    const before = readFileSync(statePath(), "utf8");
    expect(run(["--help"]).status).toBe(0);
    expect(readFileSync(statePath(), "utf8")).toBe(before);
  });

  it("persists a policy deferral and exposes status", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const target = commit(upstream, "one");
    const request = run(["--live-worktree", live, "--json", "--no-verify"]);
    expect(request.status).toBe(0);
    const queued = JSON.parse(request.stdout);
    expect(queued.action).toBe("defer");
    expect(queued.queued).toBe(true);
    expect(queued.queueSchemaVersion).toBe(DEV_DEPLOY_QUEUE_SCHEMA_VERSION);
    expect(queued.queue).toMatchObject({
      status: "pending",
      generation: 1,
      liveWorktree: realpathSync(live),
      impact: { kind: "frontend_reload" },
    });
    expect(readState().request.observed.targetHead).toBe(target);

    const status = run(["--queue-status", "--json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).queue).toMatchObject({
      status: "pending",
      worker: { alive: false },
      runnerLease: { active: false },
    });
  });

  it.runIf(process.platform !== "win32")(
    "hands a live schema-v4 runner lease to the staged schema-v5 executor",
    async () => {
      const live = join(workspace, "live");
      const liveRoot = realpathSync(live);
      const port = await unboundTcpPort();
      const targetHead = git(live, ["rev-parse", "HEAD"]);
      const store = new DevDeployQueueStore({ homeDirectory: home });
      const executor = stageDevDeployExecutor({
        queueDirectory: store.paths.directory,
        sourceRoot: live,
        sourceHead: targetHead,
      });
      const nowMs = Date.now();
      const pending = enqueueDevDeploy({
        worktree: liveRoot,
        attemptArgs: [
          "--port",
          String(port),
          "--live-worktree",
          liveRoot,
        ],
        transaction: {
          ...testTransaction(targetHead, executor.entrypoint),
          executor,
        },
        executionEnvironment: { HOME: home, PATH: process.env.PATH },
        receipt: { action: "defer", targetHead },
        nowMs,
        maxWaitMs: 60_000,
        pollMs: 10,
      });
      pending.schemaVersion = 4;
      pending.nextAttemptAtMs = nowMs + 2_000;
      delete pending.request.coldBootstrapInitialRows;
      delete pending.request.coldBootstrapInitialColumns;
      writeFileSync(statePath(), `${JSON.stringify(pending, null, 2)}\n`, {
        mode: 0o600,
      });
      store.close();

      const legacyRunner = join(workspace, "frozen-v4-runner.mjs");
      const legacySupervisor = join(workspace, "frozen-v4-supervisor.mjs");
      const legacyLaunches = join(workspace, "frozen-v4-launches");
      const storeModule = pathToFileURL(
        join(repositoryRoot, "scripts", "lib", "dev-deploy-queue-store.mjs"),
      ).href;
      writeFileSync(
        legacyRunner,
        `import { readFileSync, writeFileSync } from "node:fs";
import { DevDeployQueueStore } from ${JSON.stringify(storeModule)};
const home = process.argv[2];
const statePath = process.argv[3];
const store = new DevDeployQueueStore({ homeDirectory: home });
const owner = store.acquireRunner();
if (!owner) process.exit(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.worker = {
  pid: owner.pid,
  startedAtMs: owner.startedAtMs,
  processIdentity: owner.processIdentity,
};
writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
`,
      );
      writeFileSync(
        legacySupervisor,
        `import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [runner, home, statePath, launches] = process.argv.slice(2);
for (;;) {
  appendFileSync(launches, "launch\\n");
  spawnSync(process.execPath, [runner, home, statePath], {
    env: process.env,
    stdio: "inherit",
  });
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.schemaVersion !== 4) process.exit(0);
}
`,
      );

      const legacy = spawn(
        process.execPath,
        [legacySupervisor, legacyRunner, home, statePath(), legacyLaunches],
        {
          env: { ...fixtureEnvironment, HOME: home },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const legacyCompleted = waitForChild(legacy);
      let migrator;
      let staged;
      let stagedCompleted;
      try {
        const attachedDeadline = Date.now() + 5_000;
        let legacyWorker;
        while (Date.now() < attachedDeadline) {
          const state = readState();
          if (state.worker?.pid && !state.worker.executorGeneration) {
            legacyWorker = state.worker;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(legacyWorker).toMatchObject({
          pid: expect.any(Number),
          processIdentity: expect.any(String),
        });
        expect(readState().schemaVersion).toBe(4);

        migrator = new DevDeployQueueStore({ homeDirectory: home });
        const migrated = migrator.mutate((current) => ({
          ...current,
          nextAttemptAtMs: Date.now() + 5_000,
        }));
        expect(migrated.schemaVersion).toBe(DEV_DEPLOY_QUEUE_SCHEMA_VERSION);
        const queueEntrypoint = devDeployQueueEntrypoint(executor);
        staged = spawn(
          process.execPath,
          [
            queueEntrypoint,
            "--internal-runner-supervisor",
            "--internal-runner-executor-generation",
            executor.generation,
          ],
          {
            env: {
              ...fixtureEnvironment,
              HOME: home,
              DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        stagedCompleted = waitForChild(staged);

        const handoffDeadline = Date.now() + 5_000;
        let successor;
        while (Date.now() < handoffDeadline) {
          successor = migrator.activeRunnerFor(executor.generation);
          const worker = readState().worker;
          if (
            successor &&
            worker?.pid === successor.pid &&
            worker.executorGeneration === executor.generation
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(successor).toMatchObject({
          pid: expect.any(Number),
          executorGeneration: executor.generation,
        });
        expect(successor.pid).not.toBe(legacyWorker.pid);
        expect(readState().worker).toMatchObject({
          pid: successor.pid,
          executorGeneration: executor.generation,
        });

        migrator.mutate((current) => cancelDevDeploy(current, Date.now()));
        migrator.close();
        const [legacyResult, stagedResult] = await Promise.all([
          legacyCompleted,
          stagedCompleted,
        ]);
        expect(legacyResult.code, legacyResult.stderr).toBe(0);
        expect(stagedResult.code, stagedResult.stderr).toBe(0);
        expect(readFileSync(legacyLaunches, "utf8")).toBe("launch\n");
      } finally {
        migrator?.close();
        if (legacy.exitCode === null && legacy.signalCode === null) {
          legacy.kill("SIGTERM");
          await legacyCompleted;
        }
        if (
          staged &&
          staged.exitCode === null &&
          staged.signalCode === null
        ) {
          staged.kill("SIGTERM");
          await stagedCompleted;
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "upgrades a v4 cold-bootstrap operation and acknowledges it before starting its successor",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      installParentSourceFixture(upstream);
      installHmuxBuildIdentityFixture(upstream);
      writeFileSync(join(upstream, ".nvmrc"), `${process.versions.node}\n`);
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "--quiet", "-m", "parent source fixture"]);
      git(live, ["fetch", "origin", "main", "--quiet"]);
      git(live, ["merge", "--ff-only", "--quiet", "origin/main"]);
      writeFileSync(
        join(upstream, "hmux", "fixture-source.rs"),
        "pub const FIXTURE: &str = \"hmux-target\";\n",
      );
      git(upstream, ["add", "hmux/fixture-source.rs"]);
      git(upstream, ["commit", "--quiet", "-m", "change Hmux runtime"]);
      const targetHead = git(upstream, ["rev-parse", "HEAD"]);
      const port = await unboundTcpPort();
      const deployLock = join(home, ".dure", "dev-deploy.lock");
      writeFileSync(deployLock, `${process.pid}\n`);
      const queued = run([
        "--live-worktree",
        live,
        "--port",
        String(port),
        "--json",
        "--force",
        "--no-verify",
      ]);
      expect(queued.status, queued.stderr).toBe(0);
      expect(readState()).toMatchObject({
        schemaVersion: DEV_DEPLOY_QUEUE_SCHEMA_VERSION,
        status: "pending",
        request: {
          coldBootstrapOperationId: expect.stringMatching(/^[a-f0-9]{64}$/),
          transaction: {
            targetHead,
            selection: {
              impact: {
                kind: "backend_rebuild",
                backendChanged: true,
              },
            },
          },
        },
      });
      unlinkSync(deployLock);

      const capturePath = join(home, "hmux-queue-capture.json");
      const outcomePath = join(home, "hmux-queue-outcome");
      const oldBuildId = installRefusingColdBootstrapHmux(live);
      const pendingRunner = run(["--internal-runner", "--once"]);

      expect(pendingRunner.status, pendingRunner.stderr).toBe(0);
      const pending = readState();
      expect(pending.status).toBe("pending");
      expect(pending.lastAttempt.receipt.action).toBe("defer");
      expect(pending.lastAttempt.coldBootstrap.mode).toBe(
        DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
      );
      expect(pending.lastAttempt.coldBootstrap.hmuxBuildId).toBeTruthy();
      expect(
        beginDevDeployAttempt(pending, pending.nextAttemptAtMs).activeAttempt
          .coldBootstrap,
      ).toMatchObject({
        submittedAtMs: expect.any(Number),
        command: expect.any(Array),
      });
      expect(
        existsSync(capturePath),
        `${pendingRunner.stderr}\n${JSON.stringify(pending, null, 2)}`,
      ).toBe(true);
      const operationId = parseColdBootstrapOperationId(
        pending.request.coldBootstrapOperationId,
      );
      pending.schemaVersion = 4;
      delete pending.request.coldBootstrapInitialRows;
      delete pending.request.coldBootstrapInitialColumns;
      delete pending.lastAttempt.coldBootstrap.initialRows;
      delete pending.lastAttempt.coldBootstrap.initialColumns;
      delete pending.lastAttempt.coldBootstrap.mode;
      delete pending.lastAttempt.coldBootstrap.hmuxBuildId;
      pending.firstQueuedAtMs = Date.now() - 60_000;
      pending.expiresAtMs = Date.now() - 1;
      pending.nextAttemptAtMs = Date.now() + 2_000;
      writeFileSync(statePath(), `${JSON.stringify(pending, null, 2)}\n`);

      const readyToReconcile = readState();
      readyToReconcile.nextAttemptAtMs = Date.now() - 1;
      writeFileSync(
        statePath(),
        `${JSON.stringify(readyToReconcile, null, 2)}\n`,
      );
      writeFileSync(outcomePath, "retired\n");
      const missingCorepackPreload = join(home, "missing-replay-corepack.cjs");
      writeFileSync(
        missingCorepackPreload,
        `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { basename } = require("node:path");
const realpathSync = fs.realpathSync;
fs.realpathSync = function hideCorepack(pathname, ...args) {
  if (typeof pathname === "string" && basename(pathname) === "corepack") {
    const error = new Error("replay fixture hid " + pathname);
    error.code = "ENOENT";
    throw error;
  }
  return Reflect.apply(realpathSync, this, [pathname, ...args]);
};
syncBuiltinESMExports();
`,
      );
      const reconciledRunner = run(
        ["--internal-runner", "--once"],
        {
          NODE_OPTIONS: [
            fixtureEnvironment.NODE_OPTIONS,
            `--require=${missingCorepackPreload}`,
          ]
            .filter(Boolean)
            .join(" "),
        },
      );
      expect(reconciledRunner.status, reconciledRunner.stderr).toBe(0);
      const state = readState();
      const { calls } = JSON.parse(readFileSync(capturePath, "utf8"));
      expect(calls).toHaveLength(2);
      expect(calls[0].request.operationId).toBe(operationId);
      expect(calls[1].request.operationId).toBe(operationId);
      expect(calls[0].request.mode).toBeUndefined();
      expect(calls[1].request.mode).toBe(
        DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
      );
      expect(calls[0].request).toMatchObject({
        initialRows: 24,
        initialColumns: 80,
      });
      expect(calls[1].request).toMatchObject({
        initialRows: calls[0].request.initialRows,
        initialColumns: calls[0].request.initialColumns,
      });
      const invocation = calls[1];
      const preparedBuildId = readFileSync(
        join(home, "prepared-hmux-build-id"),
        "utf8",
      ).trim();
      expect(preparedBuildId).toBe(
        targetDevHmuxBuildId({ root: live, home }),
      );
      expect(preparedBuildId).not.toBe(oldBuildId);
      expect(invocation.buildId).toBe(preparedBuildId);
      expect(invocation.cwd).toBe(realpathSync(live));
      const node = resolvePinnedDevNodeTool({ root: live, home });
      const corepack = resolveCorepackExecutable({
        environment: fixtureEnvironment,
      });
      const shell = resolvePosixShellExecutable({
        environment: fixtureEnvironment,
      });
      expect(invocation.request.command).toEqual([
        "/usr/bin/env",
        "-u",
        "HMUX_DISCOVERY_ROOT",
        `DURE_HOME=${join(home, ".dure")}`,
        `PATH=${node.binDirectory}:${fixtureEnvironment.PATH ?? ""}`,
        `DURE_DEV_PORT=${port}`,
        `${POSIX_SHELL_EXECUTABLE_ENV}=${shell}`,
        `${PACKAGE_SCRIPT_SHELL_ENV}=${shell}`,
        `${COREPACK_EXECUTABLE_ENV}=${corepack}`,
        node.nodeExecutable,
        join(realpathSync(live), "scripts", "run-dev-app.mjs"),
      ]);
      expect(pending.lastAttempt.coldBootstrap).toMatchObject({
        operationId,
        submittedAtMs: expect.any(Number),
      });
      expect(state.request.coldBootstrapOperationId).not.toBe(operationId);
      expect(state.firstQueuedAtMs).toBeGreaterThan(pending.firstQueuedAtMs);
      expect(state.requestedAtMs).toBeGreaterThan(pending.requestedAtMs);
      expect(state.expiresAtMs).toBeGreaterThan(pending.expiresAtMs);
      expect(state.schemaVersion).toBe(DEV_DEPLOY_QUEUE_SCHEMA_VERSION);
      expect(state.lastAttempt.coldBootstrap.hmuxBuildId).toBe(
        preparedBuildId,
      );
      expect(state.status).toBe("pending");
      expect(state.activeAttempt).toBeUndefined();
      expect(
        state.request.coldBootstrapRetirementAcknowledgement,
      ).toMatchObject({
        operationId,
        sessionName: calls[1].request.sessionName,
        command: calls[1].request.command,
        initialRows: calls[1].request.initialRows,
        initialColumns: calls[1].request.initialColumns,
        retirement: { outcome: "retired", operationId },
      });

      const acknowledgementHome = join(workspace, "acknowledgement-home");
      installRefusingColdBootstrapHmux(live, acknowledgementHome);
      state.request.executionEnvironment.HOME = acknowledgementHome;
      const successorTransaction = structuredClone(state.request.transaction);
      const frozenExecutorGeneration = "0".repeat(64);
      state.request.transaction = {
        ...state.request.transaction,
        executor: {
          generation: frozenExecutorGeneration,
          entrypoint: join(
            workspace,
            "frozen",
            "executors-v1",
            frozenExecutorGeneration,
            "scripts",
            "deploy-dev-app.mjs",
          ),
        },
      };
      const interruptedAcknowledgement = beginDevDeployAttempt(
        state,
        Date.now(),
      );
      writeFileSync(
        statePath(),
        `${JSON.stringify(interruptedAcknowledgement, null, 2)}\n`,
      );
      const recoveredAcknowledgementRunner = run([
        "--internal-runner",
        "--once",
      ]);
      expect(
        recoveredAcknowledgementRunner.status,
        recoveredAcknowledgementRunner.stderr,
      ).toBe(0);
      const recoveredAcknowledgement = readState();
      expect(recoveredAcknowledgement).toMatchObject({
        status: "pending",
        request: {
          coldBootstrapRetirementAcknowledgement: { operationId },
        },
      });
      expect(
        JSON.parse(readFileSync(capturePath, "utf8")).calls,
      ).toHaveLength(2);

      recoveredAcknowledgement.nextAttemptAtMs = Date.now() - 1;
      writeFileSync(
        statePath(),
        `${JSON.stringify(recoveredAcknowledgement, null, 2)}\n`,
      );
      const acknowledgementRunner = run(["--internal-runner", "--once"]);
      expect(
        acknowledgementRunner.status,
        acknowledgementRunner.stderr,
      ).toBe(0);
      const acknowledgementState = readState();
      const acknowledgementCapturePath = join(
        acknowledgementHome,
        "hmux-queue-capture.json",
      );
      const acknowledgementCalls = JSON.parse(
        readFileSync(acknowledgementCapturePath, "utf8"),
      ).calls;
      expect(acknowledgementHome).not.toBe(home);
      expect(acknowledgementCalls).toHaveLength(1);
      expect(acknowledgementCalls[0]).toMatchObject({
        home: acknowledgementHome,
        request: {
          operationId,
          sessionName: calls[1].request.sessionName,
          command: calls[1].request.command,
          initialRows: calls[1].request.initialRows,
          initialColumns: calls[1].request.initialColumns,
          mode:
            DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
        },
      });
      expect(
        JSON.parse(readFileSync(capturePath, "utf8")).calls,
      ).toHaveLength(2);
      expect(acknowledgementState.request.executionEnvironment.HOME).toBe(
        acknowledgementHome,
      );
      expect(
        acknowledgementState.request
          .coldBootstrapRetirementAcknowledgement,
      ).toBeUndefined();
      expect(acknowledgementState.request.coldBootstrapOperationId).toBe(
        state.request.coldBootstrapOperationId,
      );

      writeFileSync(outcomePath, "pending\n");
      acknowledgementState.request.executionEnvironment.HOME = home;
      acknowledgementState.request.transaction = successorTransaction;
      acknowledgementState.nextAttemptAtMs = Date.now() - 1;
      writeFileSync(
        statePath(),
        `${JSON.stringify(acknowledgementState, null, 2)}\n`,
      );
      const successorRunner = run(["--internal-runner", "--once"]);
      expect(successorRunner.status, successorRunner.stderr).toBe(0);
      const successorCalls = JSON.parse(
        readFileSync(capturePath, "utf8"),
      ).calls;
      expect(successorCalls).toHaveLength(3);
      expect(successorCalls[2].request.operationId).toBe(
        state.request.coldBootstrapOperationId,
      );
      expect(successorCalls[2].request).toMatchObject({
        initialRows: state.request.coldBootstrapInitialRows,
        initialColumns: state.request.coldBootstrapInitialColumns,
      });
      expect(successorCalls[2].request.mode).toBeUndefined();
    },
  );

  it.runIf(process.platform !== "win32")(
    "retires a completed target before checking out and creating its successor",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      installParentSourceFixture(upstream);
      installHmuxBuildIdentityFixture(upstream);
      writeFileSync(
        join(upstream, ".node-version"),
        `${process.versions.node}\n`,
      );
      writeFileSync(join(upstream, ".nvmrc"), `${process.versions.node}\n`);
      const buildIdEntrypoint = join(
        upstream,
        "scripts",
        "hmux-dev-build-id.mjs",
      );
      const buildIdSource = readFileSync(buildIdEntrypoint, "utf8");
      const legacyBuildIdSource = buildIdSource.replace(
        `    readHmuxDevRustcVersion({
      repositoryRoot: canonicalRepositoryRoot,
      environment,
      run,
      timeoutMs: rustcTimeoutMs,
    });`,
        `    (() => {
      if (process.cwd() !== canonicalRepositoryRoot) {
        throw new Error("legacy compiler probe inherited the wrong cwd");
      }
      return run("rustc", ["-vV"], {
        encoding: "utf8",
        env: environment,
      }).trim();
    })();`,
      );
      expect(legacyBuildIdSource).not.toBe(buildIdSource);
      writeFileSync(buildIdEntrypoint, legacyBuildIdSource);
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "--quiet", "-m", "retirement fixture base"]);
      const completedTarget = git(upstream, ["rev-parse", "HEAD"]);
      git(live, ["fetch", "origin", "main", "--quiet"]);
      git(live, ["merge", "--ff-only", "--quiet", completedTarget]);
      installRefusingColdBootstrapHmux(live);

      const port = await unboundTcpPort();
      const liveRoot = realpathSync(live);
      const store = new DevDeployQueueStore({ homeDirectory: home });
      const executor = stageDevDeployExecutor({
        queueDirectory: store.paths.directory,
        sourceRoot: liveRoot,
        sourceHead: completedTarget,
      });
      const seededAtMs = Date.now() - 10_000;
      const impact = completeImpact({ kind: "frontend_reload" });
      const transaction = {
        ...testTransaction(completedTarget, executor.entrypoint),
        executor,
        selection: { sourceHead: completedTarget, impact },
      };
      const queued = enqueueDevDeploy({
        worktree: liveRoot,
        attemptArgs: [
          "--force",
          "--no-verify",
          "--port",
          String(port),
          "--live-worktree",
          liveRoot,
        ],
        transaction,
        executionEnvironment: { HOME: home, PATH: fixtureEnvironment.PATH },
        receipt: {
          action: "skip",
          currentHead: completedTarget,
          targetHead: completedTarget,
          pendingCommits: 0,
          impact,
        },
        nowMs: seededAtMs,
        maxWaitMs: 60_000,
        pollMs: 10,
      });
      const begun = beginDevDeployAttempt(queued, seededAtMs + 1);
      const binding = {
        attemptId: begun.activeAttempt.attemptId,
        attemptGeneration: begun.activeAttempt.generation,
        transaction: begun.activeAttempt.transaction,
      };
      const attached = attachDevDeployAttemptExecutor(begun, {
        ...binding,
        executor: {
          pid: process.pid,
          processIdentity: processIdentity(process.pid),
          observedAtMs: seededAtMs + 2,
        },
      });
      const applied = recordDevDeployAttemptPhase(attached, {
        ...binding,
        observedAtMs: seededAtMs + 3,
      });
      const command = ["/usr/bin/env", "node", "app:dev"];
      const predecessorHmuxBuildId = targetDevHmuxBuildId({
        root: liveRoot,
        home,
      });
      const submitted = recordDevDeployColdBootstrapSubmission(applied, {
        ...binding,
        operationId: applied.activeAttempt.coldBootstrap.operationId,
        command,
        hmuxBuildId: predecessorHmuxBuildId,
        submittedAtMs: seededAtMs + 4,
      });
      const succeeded = settleDevDeployAttempt(submitted, {
        attemptGeneration: submitted.generation,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          dispatchAccepted: true,
          currentHead: completedTarget,
          targetHead: completedTarget,
          impact,
          verification: {
            status: "ok",
            activatedAppServerGeneration: "seeded-app-generation",
          },
          runtime: {
            pid: process.pid,
            processIdentity: processIdentity(process.pid),
            generation: "seeded-app-generation",
            observedAtMs: seededAtMs + 5,
          },
        },
        nowMs: seededAtMs + 6,
        pollMs: 10,
      });
      expect(succeeded).toMatchObject({
        status: "succeeded",
        lastAttempt: {
          coldBootstrap: {
            mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
            command,
            hmuxBuildId: predecessorHmuxBuildId,
          },
        },
      });
      const legacySucceeded = structuredClone(succeeded);
      delete legacySucceeded.lastAttempt.coldBootstrap.mode;
      delete legacySucceeded.lastAttempt.coldBootstrap.hmuxBuildId;
      store.mutate(() => legacySucceeded);
      store.close();

      commit(upstream, "successor target");
      const buildInputsRelativePath =
        "scripts/lib/hmux-dev-build-inputs.mjs";
      const buildInputsPath = join(upstream, buildInputsRelativePath);
      const successorOnlyInput = "successor-hmux-input.txt";
      writeFileSync(
        buildInputsPath,
        readFileSync(buildInputsPath, "utf8").replace(
          /\]\);\s*$/,
          `  Object.freeze({ path: ${JSON.stringify(successorOnlyInput)}, recursive: false }),\n]);\n`,
        ),
      );
      writeFileSync(join(upstream, successorOnlyInput), "successor only\n");
      git(upstream, ["add", buildInputsRelativePath, successorOnlyInput]);
      git(upstream, [
        "commit",
        "--quiet",
        "-m",
        "change successor Hmux build inputs",
      ]);
      const successorTarget = git(upstream, ["rev-parse", "HEAD"]);
      const outcomePath = join(home, "hmux-queue-outcome");
      const capturePath = join(home, "hmux-queue-capture.json");
      writeFileSync(outcomePath, "retired\n");
      const retirement = run([
        "--live-worktree",
        live,
        "--port",
        String(port),
        "--json",
        "--force",
        "--no-verify",
      ]);
      expect(retirement.status, retirement.stderr).toBe(0);
      const retired = readState();
      const predecessorOperationId =
        succeeded.request.coldBootstrapOperationId;
      expect(retired).toMatchObject({
        status: "pending",
        lastAttempt: {
          transaction: { targetHead: successorTarget },
          coldBootstrap: {
            operationId: predecessorOperationId,
            mode:
              DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
            command,
            hmuxBuildId: predecessorHmuxBuildId,
          },
        },
        request: {
          coldBootstrapRetirementAcknowledgement: {
            operationId: predecessorOperationId,
            hmuxBuildId: predecessorHmuxBuildId,
          },
        },
      });
      expect(git(live, ["rev-parse", "HEAD"])).toBe(completedTarget);
      let calls = JSON.parse(readFileSync(capturePath, "utf8")).calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        head: completedTarget,
        request: {
          operationId: predecessorOperationId,
          mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
          command,
        },
      });
      expect(calls[0].buildId).toBe(predecessorHmuxBuildId);

      retired.nextAttemptAtMs = Date.now() - 1;
      writeFileSync(statePath(), `${JSON.stringify(retired, null, 2)}\n`);
      const acknowledgement = run(["--internal-runner", "--once"]);
      expect(acknowledgement.status, acknowledgement.stderr).toBe(0);
      const acknowledged = readState();
      expect(
        acknowledged.request.coldBootstrapRetirementAcknowledgement,
      ).toBeUndefined();
      expect(git(live, ["rev-parse", "HEAD"])).toBe(completedTarget);
      calls = JSON.parse(readFileSync(capturePath, "utf8")).calls;
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({
        head: completedTarget,
        request: {
          operationId: predecessorOperationId,
          mode:
            DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
          command,
        },
      });
      expect(calls[1].buildId).toBe(predecessorHmuxBuildId);

      writeFileSync(outcomePath, "pending\n");
      acknowledged.nextAttemptAtMs = Date.now() - 1;
      writeFileSync(
        statePath(),
        `${JSON.stringify(acknowledged, null, 2)}\n`,
      );
      const successor = run(["--internal-runner", "--once"]);
      expect(successor.status, successor.stderr).toBe(0);
      const successorState = readState();
      expect(successorState.lastAttempt.coldBootstrap).toMatchObject({
        operationId: acknowledged.request.coldBootstrapOperationId,
        mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
        submittedAtMs: expect.any(Number),
      });
      expect(git(live, ["rev-parse", "HEAD"])).toBe(successorTarget);
      calls = JSON.parse(readFileSync(capturePath, "utf8")).calls;
      expect(calls).toHaveLength(3);
      expect(calls[2]).toMatchObject({
        head: successorTarget,
        request: {
          operationId: acknowledged.request.coldBootstrapOperationId,
        },
      });
      expect(calls[2].request.mode).toBeUndefined();
      expect(calls[2].buildId).not.toBe(predecessorHmuxBuildId);
    },
  );

  it.runIf(process.platform !== "win32")(
    "settles an exact current target when its owned dev chain is present",
    async () => {
      const live = join(workspace, "live");
      const targetHead = git(live, ["rev-parse", "HEAD"]);
      const port = await unboundTcpPort();
      startOwnedDevLaunchFixture(live);

      const result = run([
        "--live-worktree",
        live,
        "--port",
        String(port),
        "--json",
        "--force",
        "--no-verify",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const state = readState();
      expect(state).toMatchObject({
        status: "succeeded",
        lastAttempt: {
          receipt: {
            action: "skip",
            currentHead: targetHead,
            targetHead,
          },
        },
      });
      expect(state.lastAttempt.receipt.dispatchAccepted).toBeUndefined();
      expect(existsSync(join(home, "hmux-queue-capture.json"))).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "replays a submitted current-target bootstrap after its port becomes occupied",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      installParentSourceFixture(upstream);
      installHmuxBuildIdentityFixture(upstream);
      writeFileSync(
        join(upstream, ".node-version"),
        `${process.versions.node}\n`,
      );
      writeFileSync(join(upstream, ".nvmrc"), `${process.versions.node}\n`);
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "--quiet", "-m", "bootstrap fixture base"]);
      git(live, ["fetch", "origin", "main", "--quiet"]);
      git(live, ["merge", "--ff-only", "--quiet", "origin/main"]);
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      installRefusingColdBootstrapHmux(live);
      const parentSourcePath = join(
        upstream,
        "scripts",
        "lib",
        "daily-driver.mjs",
      );
      writeFileSync(
        parentSourcePath,
        `${readFileSync(parentSourcePath, "utf8")}\n// queued bootstrap replay target\n`,
      );
      git(upstream, ["add", "scripts/lib/daily-driver.mjs"]);
      git(upstream, ["commit", "--quiet", "-m", "bootstrap replay target"]);
      const targetHead = git(upstream, ["rev-parse", "HEAD"]);
      const port = await unboundTcpPort();
      const capturePath = join(home, "hmux-queue-capture.json");

      const first = run([
        "--live-worktree",
        live,
        "--port",
        String(port),
        "--json",
        "--force",
        "--no-verify",
      ]);

      const pending = readState();
      expect(first.status, `${first.stderr}\n${JSON.stringify(pending, null, 2)}`).toBe(0);
      expect(pending).toMatchObject({
        status: "pending",
        request: {
          coldBootstrapOperationId: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        lastAttempt: {
          coldBootstrap: {
            mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
            submittedAtMs: expect.any(Number),
            command: expect.any(Array),
          },
          receipt: {
            action: "defer",
            currentHead: sourceHead,
            targetHead,
            plannedTransition: {
              kind: "cold_bootstrap",
              state: "pending",
              attempted: true,
            },
          },
        },
      });
      const firstCapture = JSON.parse(readFileSync(capturePath, "utf8"));
      expect(firstCapture.calls).toHaveLength(1);

      await withTcpListener(port, async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        const replay = run(["--internal-runner", "--once"]);
        expect(replay.status, replay.stderr).toBe(0);
      });

      const replayed = readState();
      const capture = JSON.parse(readFileSync(capturePath, "utf8"));
      expect(replayed.status).toBe("pending");
      expect(capture.calls).toHaveLength(2);
      expect(capture.calls[1].request.operationId).toBe(
        capture.calls[0].request.operationId,
      );
      expect(capture.calls[1].request.command).toEqual(
        capture.calls[0].request.command,
      );
      expect(capture.calls[1].request.mode).toBe(
        DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
      );
      expect(replayed.lastAttempt.coldBootstrap.mode).toBe(
        DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
      );
      expect(replayed.request.coldBootstrapOperationId).toBe(
        capture.calls[0].request.operationId,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not start a first bootstrap for an already-current target",
    async () => {
      const live = join(workspace, "live");
      const targetHead = git(live, ["rev-parse", "HEAD"]);
      const port = await unboundTcpPort();
      await withTcpListener(port, async () => {
        const result = run([
          "--live-worktree",
          live,
          "--port",
          String(port),
          "--json",
          "--force",
          "--no-verify",
        ]);

        expect(result.status, result.stderr).toBe(0);
        const state = readState();
        expect(state).toMatchObject({
          status: "succeeded",
          lastAttempt: {
            coldBootstrap: {
              mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
            },
            receipt: {
              action: "skip",
              currentHead: targetHead,
              targetHead,
            },
          },
        });
        expect(state.lastAttempt.coldBootstrap).toEqual({
          operationId: state.request.coldBootstrapOperationId,
          initialRows: state.request.coldBootstrapInitialRows,
          initialColumns: state.request.coldBootstrapInitialColumns,
          mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
        });
        expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
      });
      expect(existsSync(join(home, "hmux-queue-capture.json"))).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "retries the same CREATE after target application precedes submission",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      installParentSourceFixture(upstream);
      installHmuxBuildIdentityFixture(upstream);
      writeFileSync(join(upstream, ".nvmrc"), "0.0.1\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "--quiet", "-m", "bootstrap crash base"]);
      git(live, ["fetch", "origin", "main", "--quiet"]);
      git(live, ["merge", "--ff-only", "--quiet", "origin/main"]);
      const sourceHead = git(live, ["rev-parse", "HEAD"]);
      writeFileSync(
        join(upstream, ".nvmrc"),
        `${process.versions.node}\n`,
      );
      git(upstream, ["add", ".nvmrc"]);
      git(upstream, [
        "commit",
        "--quiet",
        "-m",
        "cold bootstrap crash target",
      ]);
      const targetHead = git(upstream, ["rev-parse", "HEAD"]);
      const port = await unboundTcpPort();
      const deployLock = join(home, ".dure", "dev-deploy.lock");
      writeFileSync(deployLock, `${process.pid}\n`);
      const queued = run([
        "--live-worktree",
        live,
        "--port",
        String(port),
        "--json",
        "--force",
        "--no-verify",
      ]);
      expect(queued.status, queued.stderr).toBe(0);
      unlinkSync(deployLock);

      git(live, ["fetch", "origin", "main", "--quiet"]);
      git(live, ["merge", "--ff-only", "--quiet", targetHead]);
      installRefusingColdBootstrapHmux(live);
      const pending = readState();
      const startedAtMs = Date.now() - 1_000;
      const begun = beginDevDeployAttempt(pending, startedAtMs);
      const operationId = begun.activeAttempt.coldBootstrap.operationId;
      const binding = {
        attemptId: begun.activeAttempt.attemptId,
        attemptGeneration: begun.activeAttempt.generation,
        transaction: begun.activeAttempt.transaction,
      };
      const crashedExecutor = spawn(
        process.execPath,
        ["-e", "process.send('ready'); setInterval(() => {}, 1_000)"],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await once(crashedExecutor, "message");
      const crashedExecutorIdentity = processIdentity(crashedExecutor.pid);
      expect(crashedExecutorIdentity).toBeTruthy();
      const crashedExecutorClosed = once(crashedExecutor, "close");
      crashedExecutor.kill("SIGTERM");
      await crashedExecutorClosed;
      const attached = attachDevDeployAttemptExecutor(begun, {
        ...binding,
        executor: {
          pid: crashedExecutor.pid,
          processIdentity: crashedExecutorIdentity,
          observedAtMs: startedAtMs + 1,
        },
      });
      const crashed = recordDevDeployAttemptPhase(attached, {
        ...binding,
        observedAtMs: startedAtMs + 2,
      });
      const store = new DevDeployQueueStore({ homeDirectory: home });
      store.mutate(() => crashed);
      store.close();

      const recovered = run(["--internal-runner", "--once"]);
      expect(recovered.status, recovered.stderr).toBe(0);
      const retryable = readState();
      expect(retryable).toMatchObject({
        status: "pending",
        priorFailure: {
          failure: { code: "deploy_attempt_interrupted" },
        },
        lastAttempt: {
          phase: { kind: "target_applied", targetHead },
          coldBootstrap: {
            operationId,
            mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
          },
        },
      });
      expect(retryable.lastAttempt.coldBootstrap.submittedAtMs).toBeUndefined();
      expect(existsSync(join(home, "hmux-queue-capture.json"))).toBe(false);

      retryable.nextAttemptAtMs = Date.now() - 1;
      writeFileSync(statePath(), `${JSON.stringify(retryable, null, 2)}\n`);
      const retried = run(["--internal-runner", "--once"]);
      const submitted = readState();
      expect(retried.status, `${retried.stderr}\n${JSON.stringify(submitted, null, 2)}`).toBe(0);
      expect(submitted).toMatchObject({
        status: "pending",
        lastAttempt: {
          coldBootstrap: {
            operationId,
            mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
            submittedAtMs: expect.any(Number),
            hmuxBuildId: expect.any(String),
          },
          receipt: {
            action: "defer",
            currentHead: sourceHead,
            targetHead,
          },
        },
      });
      const capture = JSON.parse(
        readFileSync(join(home, "hmux-queue-capture.json"), "utf8"),
      );
      expect(capture.calls).toHaveLength(1);
      expect(capture.calls[0].request.operationId).toBe(operationId);
      expect(capture.calls[0].request.mode).toBeUndefined();
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    },
  );

  it("reports a live runner lease independently of stale worker history", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    expect(run(["--live-worktree", live, "--json", "--no-verify"]).status).toBe(
      0,
    );
    const blocker = new DevDeployQueueStore({ homeDirectory: home });
    const lease = blocker.acquireRunner();
    expect(lease).toBeTruthy();
    try {
      const status = run(["--queue-status", "--json"]);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout).queue).toMatchObject({
        worker: { alive: false },
        runnerLease: {
          active: true,
          pid: process.pid,
          liveness: "active",
          processIdentity: processIdentity(process.pid),
          processGeneration: {
            schemaVersion: 1,
            processIdentity: processIdentity(process.pid),
          },
        },
      });
    } finally {
      blocker.releaseRunner(lease);
      blocker.close();
    }
  });

  it("resume is a read-only no-op when the exact runner lease is live", () => {
    const live = join(workspace, "live");
    const store = new DevDeployQueueStore({ homeDirectory: home });
    enqueuePending(store, live);
    const lease = store.acquireRunner();
    const stateBefore = readFileSync(statePath());
    const coordinationBefore = readFileSync(coordinationPath());
    try {
      const result = run(["--resume", "--json"]);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "queue-unchanged",
        reason: "the exact queue runner lease is already live",
        queue: {
          generation: 1,
          runnerLease: { active: true, liveness: "active" },
        },
      });
      expect(readFileSync(statePath())).toEqual(stateBefore);
      expect(readFileSync(coordinationPath())).toEqual(coordinationBefore);
    } finally {
      store.releaseRunner(lease);
      store.close();
    }
  });

  it("reports an unsupported live runner generation without taking it over", () => {
    const live = join(workspace, "live");
    const store = new DevDeployQueueStore({ homeDirectory: home });
    enqueuePending(store, live);
    const lease = store.acquireRunner();
    store.close();
    const database = new DatabaseSync(coordinationPath());
    database
      .prepare("UPDATE runner_lease SET owner_json = ? WHERE singleton = 1")
      .run(JSON.stringify({
        ...lease,
        processGeneration: {
          schemaVersion: 2,
          processIdentity: "future-process-generation",
        },
      }));
    database.close();
    const stateBefore = readFileSync(statePath());
    const coordinationBefore = readFileSync(coordinationPath());

    const status = run(["--queue-status", "--json"]);
    const resume = run(["--resume", "--json"]);

    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).queue.runnerLease).toMatchObject({
      active: true,
      liveness: "incompatible",
      processGeneration: { schemaVersion: 2 },
    });
    expect(resume.status, resume.stderr).toBe(0);
    expect(JSON.parse(resume.stdout)).toMatchObject({
      action: "queue-unchanged",
      reason: "queue runner lease is incompatible; takeover is blocked",
      queue: { generation: 1 },
    });
    expect(readFileSync(statePath())).toEqual(stateBefore);
    expect(readFileSync(coordinationPath())).toEqual(coordinationBefore);
  });

  it("concurrent resume controls run the existing generation at most once", async () => {
    const live = join(workspace, "live");
    const invoked = join(workspace, "resume-executor-invoked");
    const executorSource = join(workspace, "resume-executor-source");
    copyDeployExecutorSources(executorSource);
    const executorEntrypoint = join(
      executorSource,
      "scripts",
      "deploy-dev-app.mjs",
    );
    writeFileSync(
      executorEntrypoint,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(invoked)}, "invoked\\n", { flag: "a" });\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);\nprocess.exitCode = 7;\n`,
    );
    const queuedAtMs = Date.now();
    const store = new DevDeployQueueStore({ homeDirectory: home });
    const executor = stageDevDeployExecutor({
      queueDirectory: store.paths.directory,
      sourceRoot: executorSource,
    });
    enqueuePending(store, live, {
      nowMs: queuedAtMs,
      transaction: {
        ...testTransaction(TEST_TARGET, executor.entrypoint),
        executor,
      },
    });
    store.close();
    const spawnResume = () =>
      waitForChild(
        spawn(process.execPath, [script, "--resume", "--json"], {
          env: {
            ...fixtureEnvironment,
            HOME: home,
            DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );

    const results = await Promise.all([spawnResume(), spawnResume()]);
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).queue.generation).toBe(1);
    }
    await waitUntil(() => readState().status === "failed");
    await waitUntil(() => {
      const observer = new DevDeployQueueStore({ homeDirectory: home });
      try {
        return observer.runnerLeaseObservation().liveness === "stale";
      } finally {
        observer.close();
      }
    });
    expect(readState()).toMatchObject({
      generation: 1,
      attempts: 1,
      status: "failed",
    });
    expect(readFileSync(invoked, "utf8").trim().split("\n")).toEqual([
      "invoked",
    ]);
  });

  it("resume does not create an empty deploy generation", () => {
    const result = run(["--resume", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "queue-unchanged",
      reason: "deploy queue is empty",
      queue: { status: "empty" },
    });
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(coordinationPath())).toBe(false);
  });

  it("status retains the last verified source/backend and rechecks its runtime identity", () => {
    const live = join(workspace, "live");
    const identity = processIdentity(process.pid);
    expect(identity).toBeTruthy();
    const baseRequest = {
      worktree: live,
      attemptArgs: ["--live-worktree", live],
      transaction: testTransaction(TEST_TARGET),
      executionEnvironment: { HOME: home, PATH: process.env.PATH },
      receipt: { action: "defer", targetHead: TEST_TARGET },
      nowMs: 1_000,
      maxWaitMs: 60_000,
      pollMs: 5_000,
    };
    const verified = settleDevDeployAttempt(
      beginDevDeployAttempt(enqueueDevDeploy(baseRequest), 2_000),
      {
        attemptGeneration: 1,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          targetHead: TEST_TARGET,
          backendChanged: true,
          impact: { kind: "backend_rebuild" },
          verification: {
            status: "ok",
            controlPlaneActivation: controlPlaneActivationProof(),
          },
          runtime: {
            pid: process.pid,
            processIdentity: identity,
            observedAtMs: 2_500,
          },
        },
        nowMs: 3_000,
        pollMs: 5_000,
      },
    );
    const next = enqueueDevDeploy({
      ...baseRequest,
      existing: verified,
      transaction: testTransaction(NEXT_TEST_TARGET),
      receipt: { action: "defer", targetHead: NEXT_TEST_TARGET },
      nowMs: 4_000,
    });
    const interrupted = reconcileDevDeployAttempt(
      beginDevDeployAttempt(next, 4_000),
      { executorLiveness: "stale", nowMs: 5_000, pollMs: 5_000 },
    );
    const store = new DevDeployQueueStore({ homeDirectory: home });
    store.mutate(() => interrupted);
    store.close();

    const status = run(["--queue-status", "--json"]);
    expect(status.status).toBe(1);
    expect(JSON.parse(status.stdout).queue).toMatchObject({
      status: "failed",
      failure: { code: "deploy_attempt_interrupted" },
      lastSuccessfulDeployment: {
        sourceHead: TEST_TARGET,
        backendHead: TEST_TARGET,
        runtime: {
          pid: process.pid,
          processIdentity: identity,
          alive: true,
          liveness: "active",
        },
      },
    });
  });

  it("coalesces repeated requests onto the latest observed main", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    run(["--live-worktree", live, "--json", "--no-verify"]);
    const first = readState();
    const target = commit(upstream, "two");
    const secondRequest = run([
      "--live-worktree",
      live,
      "--json",
      "--no-verify",
    ]);
    expect(secondRequest.status).toBe(0);
    const second = readState();
    expect(second.generation).toBe(2);
    expect(second.firstQueuedAtMs).toBe(first.firstQueuedAtMs);
    expect(second.request.observed.targetHead).toBe(target);
  });

  it("cancels pending work without touching the live worktree", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const before = git(live, ["rev-parse", "HEAD"]);
    commit(upstream, "one");
    run(["--live-worktree", live, "--json", "--no-verify"]);
    const canceled = run(["--cancel-pending", "--json"]);
    expect(canceled.status).toBe(0);
    expect(JSON.parse(canceled.stdout).queue.status).toBe("canceled");
    expect(git(live, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("does not queue dry runs", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--dry-run",
      "--no-verify",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe("defer");
    expect(() => readState()).toThrow();
  });

  it("gives the explicit worktree precedence over the legacy environment", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");

    const result = run(
      ["--live-worktree", live, "--json", "--no-verify"],
      {
        DURE_DEV_LIVE_WORKTREE: "",
        HEBBIAN_DEV_WORKTREE: join(workspace, "legacy"),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readState().worktree).toBe(realpathSync(live));
  });

  it("refuses to replace another active live-worktree queue", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const other = join(workspace, "other");
    commit(upstream, "one");
    execFileSync("git", ["clone", "--no-local", "--quiet", upstream, other], {
      env: fixtureEnvironment,
    });
    git(other, ["reset", "--hard", "HEAD~1"]);
    run(["--live-worktree", live, "--json", "--no-verify"]);
    const before = git(other, ["rev-parse", "HEAD"]);
    const result = run([
      "--live-worktree",
      other,
      "--json",
      "--force",
      "--no-verify",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already owns/);
    expect(readState().worktree).toBe(
      execFileSync("realpath", [live], { encoding: "utf8" }).trim(),
    );
    expect(git(other, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("persists the canonical DURE port and staged executor for replay", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    const result = run(
      [
        "--live-worktree",
        "live",
        "--json",
        "--no-verify",
      ],
      {
        DURE_DEV_PORT: "46363",
        HEBBIAN_DEV_PORT: "1420",
        HMUX_DISCOVERY_ROOT: join(home, "hosting-pane-catalog"),
      },
      workspace,
    );
    expect(result.status, result.stderr).toBe(0);
    const state = readState();
    const canonical = execFileSync("realpath", [live], { encoding: "utf8" }).trim();
    expect(state.worktree).toBe(canonical);
    expect(state.request.attemptArgs).toContain(canonical);
    expect(state.request.attemptArgs).toEqual(
      expect.arrayContaining([
        "--port",
        "46363",
      ]),
    );
    expect(state.request.executionEnvironment).toMatchObject({
      HOME: home,
    });
    expect(state.request.executionEnvironment).not.toHaveProperty(
      "HMUX_DISCOVERY_ROOT",
    );
    expect(state.request.transaction.executor.entrypoint).toMatch(
      new RegExp(`^${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`),
    );
  });

  it("reuses an exact verified target while its recorded runtime is alive", async () => {
    const live = realpathSync(join(workspace, "live"));
    const targetHead = git(live, ["rev-parse", "HEAD"]);
    const executor = stageDevDeployExecutor({
      queueDirectory: join(home, ".dure", "dev-deploy"),
      sourceRoot: live,
      sourceHead: targetHead,
    });
    const runtime = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      const runtimeIdentity = processIdentity(runtime.pid);
      expect(runtimeIdentity).toBeTruthy();
      const nowMs = Date.now();
      const impact = completeImpact({
        kind: "frontend_reload",
        changedPathCount: 0,
      });
      const transaction = {
        ...testTransaction(targetHead, executor.entrypoint),
        executor,
        selection: { sourceHead: targetHead, impact },
      };
      const pending = enqueueDevDeploy({
        worktree: live,
        attemptArgs: ["--live-worktree", live],
        transaction,
        executionEnvironment: { HOME: home, PATH: process.env.PATH, DURE_HOME: "" },
        receipt: {
          currentHead: targetHead,
          targetHead,
          pendingCommits: 0,
          impact,
        },
        nowMs,
        maxWaitMs: 60_000,
        pollMs: 5_000,
      });
      const succeeded = settleDevDeployAttempt(
        beginDevDeployAttempt(pending, nowMs),
        {
          attemptGeneration: pending.generation,
          exitCode: 0,
          receipt: {
            action: "deploy",
            deployed: true,
            currentHead: targetHead,
            targetHead,
            impact,
            verification: { status: "ok" },
            runtime: {
              pid: runtime.pid,
              processIdentity: runtimeIdentity,
              observedAtMs: nowMs,
            },
          },
          nowMs: nowMs + 1,
          pollMs: 5_000,
        },
      );
      const store = new DevDeployQueueStore({ homeDirectory: home });
      store.mutate(() => succeeded);
      store.close();

      const result = run([
        "--live-worktree",
        live,
        "--target-commit",
        targetHead,
        "--json",
        "--no-verify",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "deploy",
        targetHead,
        liveVerified: true,
      });
      expect(readState()).toEqual(succeeded);
    } finally {
      const closed = once(runtime, "close");
      runtime.kill("SIGTERM");
      await closed;
    }
  });

  it.each([false, true])("reselects a coalesced target from the latest verified deployment (runtime and control payload: %s)", (runtimeAndControlPayload) => {
    const upstream = join(workspace, "upstream");
    const live = realpathSync(join(workspace, "live"));
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const backendPath = join(upstream, "src-tauri", "src", "lib.rs");
    mkdirSync(dirname(backendPath), { recursive: true });
    writeFileSync(backendPath, "pub fn coalesced_backend() {}\n");
    git(upstream, ["add", "src-tauri/src/lib.rs"]);
    git(upstream, ["commit", "--quiet", "-m", "coalesced backend"]);
    const backendHead = git(upstream, ["rev-parse", "HEAD"]);
    if (runtimeAndControlPayload) {
      commitPath(
        upstream,
        "hmux/crates/hmux-runtime/src/lib.rs",
        "pub fn coalesced_runtime() {}\n",
        "runtime followup",
      );
      commitPath(
        upstream,
        "cli/lib/agent-spawn-query.mjs",
        "export const coalescedPayload = true;\n",
        "control payload followup",
      );
    }
    const frontendPath = join(
      upstream,
      "src",
      "components",
      "panels",
      "CoalescedFixture.tsx",
    );
    mkdirSync(dirname(frontendPath), { recursive: true });
    writeFileSync(frontendPath, "export const coalescedFixture = true;\n");
    git(upstream, ["add", "src/components/panels/CoalescedFixture.tsx"]);
    git(upstream, ["commit", "--quiet", "-m", "coalesced frontend"]);
    const targetHead = git(upstream, ["rev-parse", "HEAD"]);
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", backendHead]);

    const executor = stageDevDeployExecutor({
      queueDirectory: join(home, ".dure", "dev-deploy"),
      sourceRoot: live,
      sourceHead: targetHead,
    });
    const staleImpact = completeImpact({
      kind: "backend_rebuild",
      changedPathCount: 2,
    });
    const nowMs = Date.now();
    const pending = enqueueDevDeploy({
      worktree: live,
      attemptArgs: ["--live-worktree", live, "--no-verify"],
      transaction: {
        ...testTransaction(targetHead, executor.entrypoint),
        executor,
        selection: { sourceHead, impact: staleImpact },
      },
      executionEnvironment: { HOME: home, PATH: process.env.PATH },
      receipt: {
        currentHead: backendHead,
        targetHead,
        pendingCommits: 1,
        impact: staleImpact,
      },
      nowMs,
      maxWaitMs: 60_000,
      pollMs: 5_000,
    });
    const store = new DevDeployQueueStore({ homeDirectory: home });
    store.mutate(() => ({
      ...pending,
      lastSuccessfulDeployment: {
        sourceHead: backendHead,
        backendHead,
        hmuxActivation: hmuxActivationProof(live, backendHead),
        verifiedAtMs: nowMs - 1,
      },
    }));
    store.close();
    writeFileSync(join(home, ".dure", "dev-deploy.lock"), `${process.pid}\n`);

    const result = run(["--internal-runner", "--once"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readState()).toMatchObject({
      status: "pending",
      lastAttempt: {
        transaction: {
          targetHead,
          selection: {
            sourceHead: backendHead,
            impact: {
              kind: runtimeAndControlPayload
                ? "backend_rebuild"
                : "frontend_reload",
              backendChanged: runtimeAndControlPayload,
              changedPathCount: runtimeAndControlPayload ? 3 : 1,
              ...(runtimeAndControlPayload
                ? {
                    hmuxRuntimeChanged: true,
                    controlPlanePayloadChanged: true,
                  }
                : {}),
            },
          },
        },
      },
    });
  });

  it("recovers an immutable CLI change omitted by an older source deployment", () => {
    const upstream = join(workspace, "upstream");
    const live = realpathSync(join(workspace, "live"));
    const payloadSourceHead = git(live, ["rev-parse", "HEAD"]);
    const cliHead = commitPath(
      upstream,
      "cli/lib/agent-spawn-query.mjs",
      "export const acceptsLaunchPromptReceipt = true;\n",
      "CLI payload",
    );
    const targetHead = commitPath(
      upstream,
      "src/components/CliPayloadFollowup.tsx",
      "export const cliPayloadFollowup = true;\n",
      "frontend followup",
    );
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", cliHead]);

    const executor = stageDevDeployExecutor({
      queueDirectory: join(home, ".dure", "dev-deploy"),
      sourceRoot: live,
      sourceHead: targetHead,
    });
    const staleImpact = completeImpact({ kind: "frontend_reload" });
    const nowMs = Date.now();
    const pending = enqueueDevDeploy({
      worktree: live,
      attemptArgs: ["--live-worktree", live, "--no-verify"],
      transaction: {
        ...testTransaction(targetHead, executor.entrypoint),
        executor,
        selection: { sourceHead: payloadSourceHead, impact: staleImpact },
      },
      executionEnvironment: { HOME: home, PATH: process.env.PATH },
      receipt: {
        currentHead: cliHead,
        targetHead,
        pendingCommits: 1,
        impact: staleImpact,
      },
      nowMs,
      maxWaitMs: 60_000,
      pollMs: 5_000,
    });
    const store = new DevDeployQueueStore({ homeDirectory: home });
    store.mutate(() => ({
      ...pending,
      lastSuccessfulDeployment: {
        sourceHead: cliHead,
        backendHead: payloadSourceHead,
        hmuxActivation: hmuxActivationProof(live, payloadSourceHead),
        verifiedAtMs: nowMs - 1,
      },
    }));
    store.close();
    writeFileSync(join(home, ".dure", "dev-deploy.lock"), `${process.pid}\n`);

    const result = run(["--internal-runner", "--once"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readState()).toMatchObject({
      status: "pending",
      lastAttempt: {
        transaction: {
          targetHead,
          selection: {
            sourceHead: cliHead,
            impact: {
              kind: "frontend_reload",
              backendChanged: false,
              controlPlanePayloadChanged: true,
              changedPathCount: 2,
            },
          },
        },
      },
    });
  });

  it("carries an unproven application backend receipt into the next selection", () => {
    const upstream = join(workspace, "upstream");
    const live = realpathSync(join(workspace, "live"));
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const frontendPath = join(upstream, "src", "UnprovenBackendFixture.tsx");
    mkdirSync(dirname(frontendPath), { recursive: true });
    writeFileSync(frontendPath, "export const fixture = true;\n");
    git(upstream, ["add", "src/UnprovenBackendFixture.tsx"]);
    git(upstream, ["commit", "--quiet", "-m", "frontend target"]);
    const targetHead = git(upstream, ["rev-parse", "HEAD"]);
    git(live, ["fetch", "origin", "main", "--quiet"]);

    const executor = stageDevDeployExecutor({
      queueDirectory: join(home, ".dure", "dev-deploy"),
      sourceRoot: live,
      sourceHead: targetHead,
    });
    const staleImpact = completeImpact({ kind: "frontend_reload" });
    const nowMs = Date.now();
    const pending = enqueueDevDeploy({
      worktree: live,
      attemptArgs: ["--live-worktree", live, "--no-verify"],
      transaction: {
        ...testTransaction(targetHead, executor.entrypoint),
        executor,
        selection: { sourceHead: targetHead, impact: staleImpact },
      },
      executionEnvironment: { HOME: home, PATH: process.env.PATH },
      receipt: {
        currentHead: sourceHead,
        targetHead,
        pendingCommits: 1,
        impact: staleImpact,
      },
      nowMs,
      maxWaitMs: 60_000,
      pollMs: 5_000,
    });
    const store = new DevDeployQueueStore({ homeDirectory: home });
    store.mutate(() => ({
      ...pending,
      lastSuccessfulDeployment: {
        sourceHead,
        backendHead: sourceHead,
        appliedAtMs: nowMs - 1,
      },
    }));
    store.close();
    writeFileSync(join(home, ".dure", "dev-deploy.lock"), `${process.pid}\n`);

    const result = run(["--internal-runner", "--once"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readState()).toMatchObject({
      status: "pending",
      lastAttempt: {
        transaction: {
          selection: {
            sourceHead,
            impact: {
              kind: "backend_rebuild",
              backendChanged: true,
            },
          },
        },
      },
    });
  });

  it("does not execute an unbound request persisted by a schema-v2 queue", () => {
    const live = realpathSync(join(workspace, "live"));
    const capturePath = join(workspace, "legacy-environment.txt");
    const executorPath = join(workspace, "legacy-executor.mjs");
    writeFileSync(
      executorPath,
      'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.DURE_TEST_CAPTURE_ENV, `${process.env.HMUX_DISCOVERY_ROOT ?? "<unset>"}\\n`);\nprocess.stdout.write(JSON.stringify({ action: "skip", currentHead: "same", targetHead: "same", pendingCommits: 0 }));\n',
    );
    const nowMs = Date.now();
    const legacy = {
      schemaVersion: 2,
      generation: 1,
      worktree: live,
      status: "pending",
      firstQueuedAtMs: nowMs,
      requestedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
      attempts: 0,
      nextAttemptAtMs: nowMs,
      request: {
        attemptArgs: ["--live-worktree", live],
        executorPath,
        executionEnvironment: {
          HOME: home,
          PATH: process.env.PATH,
          HMUX_DISCOVERY_ROOT: join(home, "legacy-hosting-pane-catalog"),
        },
        observed: { targetHead: TEST_TARGET },
      },
    };
    const store = new DevDeployQueueStore({ homeDirectory: home });
    store.mutate(() => legacy);
    store.close();

    const runner = run(["--internal-runner", "--once"], {
      DURE_TEST_CAPTURE_ENV: capturePath,
      HMUX_DISCOVERY_ROOT: join(home, "runner-hosting-pane-catalog"),
    });

    expect(runner.status).toBe(1);
    expect(runner.stderr).toMatch(/schema-v2 deploy.*cannot execute/);
    expect(existsSync(capturePath)).toBe(false);
    expect(readState().status).toBe("pending");
  });

  it("replays one exact local candidate through the staged executor", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    startOwnedDevLaunchFixture(live);
    git(live, ["checkout", "--quiet", "-b", "reviewed-candidate"]);
    const candidate = commit(live, "reviewed local candidate");
    git(live, ["checkout", "--quiet", "main"]);
    const movedMain = commit(upstream, "main moved independently");
    git(live, [
      "remote",
      "set-url",
      "origin",
      join(workspace, "unavailable-origin"),
    ]);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);

    const queued = run(
      [
        "--live-worktree",
        live,
        "--json",
        "--force",
        "--target-commit",
        candidate,
        "--no-verify",
      ],
      { DURE_DEV_PORT: "1437", HEBBIAN_DEV_PORT: "1420" },
    );

    expect(queued.status, queued.stderr).toBe(0);
    expect(JSON.parse(queued.stdout)).toMatchObject({
      action: "defer",
      queued: true,
    });
    const pending = readState();
    expect(pending.request.attemptArgs).toEqual(
      expect.arrayContaining(["--port", "1437"]),
    );
    expect(pending.request.attemptArgs).not.toContain("--target-commit");
    expect(pending.request.transaction).toMatchObject({
      targetHead: candidate,
      targetAuthority: "exact-local-candidate",
    });
    expect(pending.request.attemptArgs).not.toContain("1420");
    expect(pending.request.transaction.executor.entrypoint).not.toBe(script);
    unlinkSync(deployLock);

    const runner = run(["--internal-runner", "--once"]);

    expect(runner.status, runner.stderr).toBe(0);
    expect(readState()).toMatchObject({
      status: "succeeded",
      lastAttempt: {
        receipt: {
          action: "deploy",
          currentHead,
          targetHead: candidate,
          targetAuthority: "exact-local-candidate",
        },
      },
      lastSuccessfulDeployment: { sourceHead: candidate },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(candidate);
    expect(
      git(live, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ).toBe("");
    expect(git(live, ["rev-parse", "origin/main"])).toBe(currentHead);
    expect(git(upstream, ["rev-parse", "HEAD"])).toBe(movedMain);
  });

  it.each([
    [
      "a second target input",
      (candidate) => ["--target-commit", candidate],
      /cannot be combined with --target-commit/,
    ],
    [
      "a head transition",
      () => ["--adopt-integrated-target"],
      /exact-local queued deploy transaction cannot use a head transition/,
    ],
  ])("rejects %s in a staged exact-local transaction", (_label, injected, reason) => {
    const live = join(workspace, "live");
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    git(live, ["checkout", "--quiet", "-b", "reviewed-candidate"]);
    const candidate = commit(live, "reviewed local candidate");
    git(live, ["checkout", "--quiet", "main"]);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);
    const queued = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--target-commit",
      candidate,
      "--no-verify",
    ]);
    expect(queued.status, queued.stderr).toBe(0);
    const state = readState();
    expect(state.request.transaction.targetAuthority).toBe(
      "exact-local-candidate",
    );
    state.request.attemptArgs.push(...injected(candidate));
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
    unlinkSync(deployLock);

    const runner = run(["--internal-runner", "--once"]);

    expect(runner.status).toBe(1);
    expect(readState()).toMatchObject({
      status: "failed",
      failure: {
        code: "deploy_attempt_failed",
        reason: expect.stringMatching(reason),
      },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(
      git(live, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ).toBe("");
  });

  it.each([
    [
      "an invalid target identity",
      () => ["--target-commit", "refs/heads/reviewed-candidate"],
    ],
    [
      "a duplicate target identity",
      (head) => ["--target-commit", head, "--target-commit", head],
    ],
    [
      "an exact target combined with restart-only",
      (head) => ["--target-commit", head, "--restart-only"],
    ],
    [
      "an exact target combined with a head transition",
      (head) => ["--target-commit", head, "--adopt-integrated-target"],
    ],
  ])("rejects %s before changing the queue journal", (_label, targetArgs) => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    commit(upstream, "queued before invalid replacement");
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);
    const initial = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-verify",
    ]);
    expect(initial.status, initial.stderr).toBe(0);
    const before = readFileSync(statePath(), "utf8");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      ...targetArgs(currentHead),
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target-commit/);
    expect(readFileSync(statePath(), "utf8")).toBe(before);
  });

  it("rejects a full tag-object SHA that peels to a different commit", () => {
    const live = join(workspace, "live");
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    git(live, ["tag", "-a", "reviewed-tag", "-m", "reviewed tag"]);
    const requested = git(live, ["rev-parse", "reviewed-tag"]);
    expect(git(live, ["rev-parse", `${requested}^{commit}`])).toBe(currentHead);
    expect(requested).not.toBe(currentHead);

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--target-commit",
      requested,
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target does not resolve to its exact commit/);
    expect(() => readState()).toThrow();
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
  });

  it("accepts a full 64-hex identity at the queue boundary", () => {
    const live = join(workspace, "live");
    const requested = "f".repeat(64);

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--target-commit",
      requested,
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not resolve to its exact commit/);
    expect(() => readState()).toThrow();
  });

  it("rejects a non-fast-forward exact target in the staged executor", () => {
    const live = join(workspace, "live");
    const base = git(live, ["rev-parse", "HEAD"]);
    git(live, ["checkout", "--quiet", "-b", "reviewed-candidate"]);
    const candidate = commit(live, "reviewed sibling candidate");
    git(live, ["checkout", "--quiet", "main"]);
    const currentHead = commit(live, "live moved independently");
    expect(git(live, ["merge-base", currentHead, candidate])).toBe(base);

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--target-commit",
      candidate,
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/fast-forward of the live head/);
    expect(readState().status).toBe("failed");
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
  });

  it("rechecks exact-target ancestry after an older attempt moves the live head", () => {
    const live = join(workspace, "live");
    git(live, ["checkout", "--quiet", "-b", "older-candidate"]);
    const olderCandidate = commit(live, "older in-flight candidate");
    git(live, ["checkout", "--quiet", "main"]);
    git(live, ["checkout", "--quiet", "-b", "newer-candidate"]);
    const newerCandidate = commit(live, "newer queued candidate");
    git(live, ["checkout", "--quiet", "main"]);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);

    const queued = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--target-commit",
      newerCandidate,
      "--no-verify",
    ]);
    expect(queued.status, queued.stderr).toBe(0);
    expect(readState().status).toBe("pending");

    git(live, ["merge", "--ff-only", "--quiet", olderCandidate]);
    unlinkSync(deployLock);
    const runner = run(["--internal-runner", "--once"]);

    expect(runner.status).toBe(1);
    expect(readState()).toMatchObject({
      status: "failed",
      failure: { reason: expect.stringMatching(/fast-forward of the live head/) },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(olderCandidate);
  });

  it("rejects a dirty exact-target worktree before fast-forwarding", () => {
    const live = join(workspace, "live");
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    git(live, ["checkout", "--quiet", "-b", "reviewed-candidate"]);
    const candidate = commit(live, "reviewed clean candidate");
    git(live, ["checkout", "--quiet", "main"]);
    writeFileSync(join(live, "untracked-private.txt"), "preserve me\n");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--target-commit",
      candidate,
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/exact local deploy requires a clean worktree/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(readFileSync(join(live, "untracked-private.txt"), "utf8")).toBe(
      "preserve me\n",
    );
  });

  it("preserves an ignored local artifact that collides with the exact target", () => {
    const live = join(workspace, "live");
    writeFileSync(join(live, ".gitignore"), "private.txt\n");
    git(live, ["add", ".gitignore"]);
    git(live, ["commit", "--quiet", "-m", "ignore local artifact"]);
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    git(live, ["checkout", "--quiet", "-b", "reviewed-candidate"]);
    writeFileSync(join(live, "private.txt"), "reviewed target bytes\n");
    git(live, ["add", "--force", "private.txt"]);
    git(live, ["commit", "--quiet", "-m", "track reviewed artifact"]);
    const candidate = git(live, ["rev-parse", "HEAD"]);
    git(live, ["checkout", "--quiet", "main"]);
    writeFileSync(join(live, "private.txt"), "private local bytes\n");
    expect(
      git(live, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ).toBe("");

    const result = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--target-commit",
      candidate,
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target path collision.*private\.txt/);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(readFileSync(join(live, "private.txt"), "utf8")).toBe(
      "private local bytes\n",
    );
  });

  it("persists the target worktree's 1437 profile instead of ambient 1420", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    persistLiveDevServer(live, 1437);

    const result = run(
      ["--live-worktree", live, "--json", "--no-verify"],
      { HEBBIAN_DEV_PORT: "1420" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readState().request.attemptArgs).toEqual(
      expect.arrayContaining(["--port", "1437"]),
    );
    expect(readState().request.attemptArgs).not.toContain("1420");
  });

  it("fails closed when an explicit port conflicts with the persisted profile", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    persistLiveDevServer(live, 1437);

    const result = run([
      "--live-worktree",
      live,
      "--port",
      "1420",
      "--json",
      "--no-verify",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/explicit port 1420 conflicts.*1437/);
    expect(existsSync(statePath())).toBe(false);
  });

  it("foreground runner completes a queued force request and records receipt", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const target = commit(upstream, "one");
    startOwnedDevLaunchFixture(live);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);
    const queued = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-verify",
    ]);
    expect(JSON.parse(queued.stdout)).toMatchObject({
      action: "defer",
      queued: true,
    });
    unlinkSync(deployLock);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

    const observerBin = join(workspace, "observer-bin");
    mkdirSync(observerBin);
    if (process.platform === "linux") {
      const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).trim();
      symlinkSync(python, join(observerBin, "python3"));
    }
    expect(spawnSync("git", ["--version"], { env: { PATH: observerBin } }).error?.code).toBe("ENOENT");
    const runner = run(
      ["--internal-runner", "--once"],
      { PATH: observerBin },
    );
    expect(runner.status, `${runner.stderr}\n${JSON.stringify(readState(), null, 2)}`).toBe(0);
    const state = readState();
    expect(
      state,
      `${runner.stderr}\n${JSON.stringify(state, null, 2)}`,
    ).toMatchObject({
      status: "succeeded",
      lastAttempt: { receipt: { action: "deploy", targetHead: target } },
      lastSuccessfulDeployment: { sourceHead: target },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(target);
  });

  it("binds a deferred target to the executor generation that selected it", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const port = await unboundTcpPort();
    startOwnedDevLaunchFixture(live);
    const targetA = commit(upstream, "target A");
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);
    const queued = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-recover",
      "--no-verify",
      "--port",
      String(port),
    ]);
    expect(queued.status, queued.stderr).toBe(0);
    expect(JSON.parse(queued.stdout)).toMatchObject({
      action: "defer",
      queued: true,
    });

    const classifierPath = join(
      upstream,
      "scripts/lib/dev-launch-impact.mjs",
    );
    writeFileSync(
      classifierPath,
      `${readFileSync(classifierPath, "utf8")}\n// executor generation B\n`,
    );
    git(upstream, ["add", "scripts/lib/dev-launch-impact.mjs"]);
    git(upstream, ["commit", "--quiet", "-m", "classifier generation B"]);
    const targetB = git(upstream, ["rev-parse", "HEAD"]);
    unlinkSync(deployLock);

    const runner = run(["--internal-runner", "--once"]);

    expect(runner.status).toBe(0);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(targetA);
    expect(git(live, ["rev-parse", "HEAD"])).not.toBe(targetB);
    const state = readState();
    expect(state).toMatchObject({
      status: "succeeded",
      request: {
        transaction: {
          targetHead: targetA,
          executor: {
            generation: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        },
      },
      lastAttempt: { receipt: { targetHead: targetA } },
      lastSuccessfulDeployment: { sourceHead: targetA },
    });
  });

  it("preserves dirty live WIP while deploying only the bound origin/main target", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const port = await unboundTcpPort();
    startOwnedDevLaunchFixture(live);
    const targetA = commit(upstream, "bound target A");
    const trackedPath = join(live, "scripts/deploy-dev-app.mjs");
    const untrackedPath = join(live, "local-private.bin");
    const trackedWip = Buffer.concat([
      readFileSync(trackedPath),
      Buffer.from("\n// local live WIP\n"),
    ]);
    const untrackedWip = Buffer.from([0x00, 0xff, 0x0a, 0x41, 0x80]);
    writeFileSync(trackedPath, trackedWip);
    writeFileSync(untrackedPath, untrackedWip);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);

    const queued = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-recover",
      "--no-verify",
      "--port",
      String(port),
    ]);

    expect(queued.status, queued.stderr).toBe(0);
    expect(readState().request.transaction).toMatchObject({
      targetHead: targetA,
      targetAuthority: "origin/main",
    });

    const classifierPath = join(
      upstream,
      "scripts/lib/dev-launch-impact.mjs",
    );
    writeFileSync(
      classifierPath,
      `${readFileSync(classifierPath, "utf8")}\n// later classifier B\n`,
    );
    git(upstream, ["add", "scripts/lib/dev-launch-impact.mjs"]);
    git(upstream, ["commit", "--quiet", "-m", "later classifier B"]);
    const targetB = git(upstream, ["rev-parse", "HEAD"]);
    unlinkSync(deployLock);

    const runner = run(["--internal-runner", "--once"]);

    expect(runner.status).toBe(0);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(targetA);
    expect(git(live, ["rev-parse", "HEAD"])).not.toBe(targetB);
    expect(readFileSync(trackedPath)).toEqual(trackedWip);
    expect(readFileSync(untrackedPath)).toEqual(untrackedWip);
    expect(readState()).toMatchObject({
      status: "succeeded",
      lastAttempt: {
        receipt: {
          targetHead: targetA,
          targetAuthority: "origin/main",
        },
      },
      lastSuccessfulDeployment: { sourceHead: targetA },
    });
  });

  it("refuses an overlapping bound fast-forward and recovers on a fresh attempt", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const port = await unboundTcpPort();
    startOwnedDevLaunchFixture(live);
    const relativePath = "scripts/lib/dev-deploy-policy.mjs";
    const upstreamPath = join(upstream, relativePath);
    const livePath = join(live, relativePath);
    const originalBytes = readFileSync(livePath);
    const targetBytes = Buffer.concat([
      readFileSync(upstreamPath),
      Buffer.from("\n// bound target bytes\n"),
    ]);
    writeFileSync(upstreamPath, targetBytes);
    git(upstream, ["add", relativePath]);
    git(upstream, ["commit", "--quiet", "-m", "overlapping bound target"]);
    const target = git(upstream, ["rev-parse", "HEAD"]);
    const currentHead = git(live, ["rev-parse", "HEAD"]);
    const trackedWip = Buffer.concat([
      originalBytes,
      Buffer.from("\n// conflicting live WIP\n"),
    ]);
    const untrackedPath = join(live, "local-recovery.bin");
    const untrackedWip = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]);
    writeFileSync(livePath, trackedWip);
    writeFileSync(untrackedPath, untrackedWip);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);

    const queued = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-recover",
      "--no-verify",
      "--port",
      String(port),
    ]);
    expect(queued.status, queued.stderr).toBe(0);
    expect(readState().request.transaction).toMatchObject({
      targetHead: target,
      targetAuthority: "origin/main",
    });
    unlinkSync(deployLock);

    const refused = run(["--internal-runner", "--once"]);

    expect(refused.status).toBe(1);
    expect(readState()).toMatchObject({
      status: "failed",
      failure: {
        code: "deploy_attempt_failed",
        reason: expect.stringMatching(/live fast-forward is not admissible/i),
      },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(readFileSync(livePath)).toEqual(trackedWip);
    expect(readFileSync(untrackedPath)).toEqual(untrackedWip);

    writeFileSync(livePath, originalBytes);
    const recovered = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--no-recover",
      "--no-verify",
      "--port",
      String(port),
    ]);

    expect(
      recovered.status,
      `${recovered.stderr}\n${JSON.stringify(readState(), null, 2)}`,
    ).toBe(0);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(target);
    expect(readFileSync(livePath)).toEqual(targetBytes);
    expect(readFileSync(untrackedPath)).toEqual(untrackedWip);
    expect(readState()).toMatchObject({
      request: {
        transaction: {
          targetHead: target,
          targetAuthority: "origin/main",
        },
      },
      status: "succeeded",
      lastSuccessfulDeployment: { sourceHead: target },
    });
  });

  it("replays integrated-target adoption through the staged queue executor", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = commitContents(live, "integrated\n", "local task");
    startOwnedDevLaunchFixture(live);
    const targetHead = commitContents(
      upstream,
      "integrated\n",
      "coordinator reconstruction",
    );
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);

    const queued = run([
      "--live-worktree",
      live,
      "--json",
      "--force",
      "--adopt-integrated-target",
      "--no-verify",
    ]);
    expect(queued.status).toBe(0);
    expect(JSON.parse(queued.stdout)).toMatchObject({
      action: "defer",
      queued: true,
    });
    expect(readState().request.attemptArgs).toContain(
      "--adopt-integrated-target",
    );
    unlinkSync(deployLock);

    const runner = run(["--internal-runner", "--once"]);

    expect(runner.status, runner.stderr).toBe(0);
    expect(readState()).toMatchObject({
      status: "succeeded",
      lastAttempt: {
        receipt: {
          action: "deploy",
          headTransition: "adopt-integrated-target",
          headTransitionTransactionId: expect.stringMatching(/^[0-9a-f]{64}$/),
          previousHead: currentHead,
          targetHead,
        },
      },
      lastSuccessfulDeployment: { sourceHead: targetHead },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
  });

  it("replays an exact unrelated source through the preserved-head coordinator", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = commit(live, "retained source");
    startOwnedDevLaunchFixture(live);
    writeFileSync(join(live, "preserved-wip.txt"), "preserved WIP\n");
    const checkpoint = checkpointWorktree(live);
    const reviewed = join(workspace, "reviewed-source");
    git(live, ["clone", "--no-local", "--quiet", upstream, reviewed]);
    git(reviewed, ["checkout", "--quiet", "--orphan", "reviewed"]);
    const targetHead = commit(reviewed, "reviewed independent source");
    git(live, ["fetch", "--quiet", reviewed, "reviewed"]);
    const originHead = git(live, ["rev-parse", "origin/main"]);
    const originUrl = git(live, ["remote", "get-url", "origin"]);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);
    const reason = "adopt reviewed independent source";
    const evidence = "preserved original source and WIP";
    const queued = run([
      "--live-worktree", live, "--json", "--force", "--target-commit", targetHead,
      "--retire-preserved-live-head", "--retire-reason", reason,
      "--retire-evidence", evidence, "--retire-wip-ref", checkpoint.ref, "--no-verify",
    ]);
    expect(queued.status, queued.stderr).toBe(0);
    expect(readState()).toMatchObject({ status: "pending", request: { transaction: {
      targetHead, targetAuthority: "exact-local-candidate",
    } } });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(currentHead);
    commit(upstream, "unselected upstream moved after admission");
    unlinkSync(deployLock);

    const runner = run(["--internal-runner", "--once"]);

    expect(runner.status, runner.stderr).toBe(0);
    expect(readState()).toMatchObject({ status: "succeeded", lastAttempt: { receipt: {
      targetHead, targetAuthority: "exact-local-candidate", previousHead: currentHead,
      headTransition: "retire-preserved-live-head", headTransitionReason: reason,
      headTransitionEvidence: evidence, wipCheckpoint: { object: checkpoint.object },
    } }, lastSuccessfulDeployment: { sourceHead: targetHead } });
    const retained = readState().lastAttempt.receipt.retainedRef;
    expect(git(live, ["rev-parse", retained])).toBe(currentHead);
    expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    expect(git(live, ["rev-parse", checkpoint.ref])).toBe(checkpoint.object);
    expect(git(live, ["rev-parse", "origin/main"])).toBe(originHead);
    expect(git(live, ["remote", "get-url", "origin"])).toBe(originUrl);
  });

  it("persists and replays every preserved-head retirement identity with the 1437 profile", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const currentHead = commitContents(
      live,
      "local conflicting head\n",
      "local conflicting head",
    );
    startOwnedDevLaunchFixture(live);
    writeFileSync(join(live, "preserved-wip.txt"), "preserved WIP\n");
    const checkpoint = checkpointWorktree(live);
    const targetHead = commitContents(
      upstream,
      "target conflicting head\n",
      "target conflicting head",
    );
    persistLiveDevServer(live, 1437);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);
    const reason = "retire reviewed conflicting live head";
    const evidence = "WIP and current head independently preserved";

    const queued = run(
      [
        "--live-worktree",
        live,
        "--json",
        "--force",
        "--retire-preserved-live-head",
        "--retire-reason",
        reason,
        "--retire-evidence",
        evidence,
        "--retire-wip-ref",
        checkpoint.ref,
        "--no-verify",
      ],
      { HEBBIAN_DEV_PORT: "1420" },
    );

    expect(queued.status, queued.stderr).toBe(0);
    expect(JSON.parse(queued.stdout)).toMatchObject({
      action: "defer",
      queued: true,
    });
    expect(readState().request.attemptArgs).toEqual(
      expect.arrayContaining([
        "--retire-preserved-live-head",
        "--retire-reason",
        reason,
        "--retire-evidence",
        evidence,
        "--retire-wip-ref",
        checkpoint.ref,
        "--port",
        "1437",
      ]),
    );
    expect(readState().request.attemptArgs).not.toContain("1420");
    unlinkSync(deployLock);

    const runner = run(["--internal-runner", "--once"]);

    expect(runner.status, runner.stderr).toBe(0);
    expect(readState()).toMatchObject({
      status: "succeeded",
      lastAttempt: {
        receipt: {
          headTransition: "retire-preserved-live-head",
          headTransitionReason: reason,
          headTransitionEvidence: evidence,
          previousHead: currentHead,
          targetHead,
          wipCheckpoint: {
            ref: checkpoint.ref,
            object: checkpoint.object,
            base: currentHead,
          },
        },
      },
      lastSuccessfulDeployment: { sourceHead: targetHead },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
  });

  it("detached runner finishes without another request", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const target = commit(upstream, "one");
    startOwnedDevLaunchFixture(live);
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);
    const queued = run(
      ["--live-worktree", live, "--json", "--force", "--no-verify"],
      { DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "0" },
    );
    expect(queued.status).toBe(0);
    expect(JSON.parse(queued.stdout)).toMatchObject({
      action: "defer",
      queued: true,
    });
    unlinkSync(deployLock);

    // 부하 걸린 러너에서 detached 완주가 5s를 넘겨 attempting을 최종
    // 관측했다(na9u). 성공 즉시 탈출하는 폴링이라 여유 데드라인은 무비용.
    const deadline = Date.now() + 30_000;
    let state = readState();
    while (
      (state.status === "pending" || state.status === "attempting") &&
      Date.now() < deadline
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      state = readState();
    }
    expect(state).toMatchObject({
      status: "succeeded",
      lastAttempt: { receipt: { action: "deploy", targetHead: target } },
      lastSuccessfulDeployment: { sourceHead: target },
    });
    expect(git(live, ["rev-parse", "HEAD"])).toBe(target);
  });

  it.runIf(process.platform !== "win32")(
    "staged supervisor replaces a lost runner after its source checkout is deleted",
    async () => {
      const upstream = join(workspace, "upstream");
      const live = join(workspace, "live");
      const port = await unboundTcpPort();
      const caller = join(workspace, "disposable-caller");
      const fixtureCalls = join(home, "deleted-source-executor-calls");
      const fixtureCwds = join(home, "deleted-source-executor-cwds");
      const firstRunnerKilled = join(home, "deleted-source-runner-killed");
      copyDeployExecutorSources(caller);
      writeFileSync(
        join(upstream, "scripts", "deploy-dev-app.mjs"),
        `import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const transactionIndex = args.indexOf("--queued-deploy-transaction");
const transaction = JSON.parse(args[transactionIndex + 1]);
const worktreeIndex = args.indexOf("--live-worktree");
const liveWorktree = args[worktreeIndex + 1];
const callsPath = ${JSON.stringify(fixtureCalls)};
const calls = existsSync(callsPath) ? Number(readFileSync(callsPath, "utf8")) : 0;
writeFileSync(callsPath, String(calls + 1));
const cwdProbe = spawnSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
  encoding: "utf8",
});
if (cwdProbe.status !== 0) throw cwdProbe.error ?? new Error(cwdProbe.stderr);
appendFileSync(${JSON.stringify(fixtureCwds)}, JSON.stringify({
  deploy: process.cwd(),
  inheritedChild: cwdProbe.stdout,
}) + "\\n");
if (calls === 0) {
  process.stdout.write(JSON.stringify({
    deployReceiptVersion: 2,
    action: "defer",
    reason: "fixture schedules a replacement attempt",
    liveWorktree,
    targetHead: transaction.targetHead,
    transaction,
  }) + "\\n");
} else if (calls === 1) {
  writeFileSync(${JSON.stringify(firstRunnerKilled)}, String(process.ppid));
  process.kill(process.ppid, "SIGKILL");
  setTimeout(() => process.exit(0), 50);
} else {
  process.stderr.write("staged replacement reached\\n");
  process.exitCode = 7;
}
`,
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "--quiet", "-m", "replacement fixture"]);
      const targetHead = git(upstream, ["rev-parse", "HEAD"]);
      startOwnedDevLaunchFixture(live);

      const disposableEntrypoint = join(
        caller,
        "scripts",
        "queue-dev-app-deploy.mjs",
      );
      const queued = runQueueScript(
        disposableEntrypoint,
        [
          "--live-worktree",
          live,
          "--json",
          "--force",
          "--no-verify",
          "--port",
          String(port),
        ],
        {
          DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "0",
          DURE_DEV_DEPLOY_QUEUE_POLL_MS: "500",
        },
        caller,
      );
      const runnerLog = join(home, ".dure", "dev-deploy", "runner-v1.log");
      expect(
        queued.status,
        `${queued.stderr}\n${existsSync(runnerLog) ? readFileSync(runnerLog, "utf8") : ""}`,
      ).toBe(0);
      expect(JSON.parse(queued.stdout)).toMatchObject({
        action: "defer",
        queued: true,
      });
      const stagedExecutor = readState().request.transaction.executor;
      expect(devDeployQueueEntrypoint(stagedExecutor)).toContain(
        join(home, ".dure", "dev-deploy", "executors-v1"),
      );

      rmSync(caller, { recursive: true, force: true });

      const deadline = Date.now() + 20_000;
      let state = readState();
      while (
        (state.status === "pending" || state.status === "attempting") &&
        Date.now() < deadline
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        state = readState();
      }
      expect(existsSync(caller)).toBe(false);
      expect(existsSync(firstRunnerKilled)).toBe(true);
      const killedRunnerPid = Number(readFileSync(firstRunnerKilled, "utf8"));
      expect(state).toMatchObject({
        status: "failed",
        attempts: 2,
        failure: { code: "deploy_attempt_interrupted" },
        worker: { executorGeneration: stagedExecutor.generation },
        lastAttempt: {
          exitCode: 1,
          transaction: { targetHead },
        },
      });
      expect(state.worker.pid).not.toBe(killedRunnerPid);
      const cwdObservations = readFileSync(fixtureCwds, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(cwdObservations.length).toBeGreaterThanOrEqual(2);
      expect(cwdObservations).toEqual(
        cwdObservations.map(() => ({
          deploy: realpathSync(live),
          inheritedChild: realpathSync(live),
        })),
      );
    },
  );

  it("fails closed when a prior runner vanished mid-attempt", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    run(["--live-worktree", live, "--json", "--no-verify"]);
    const state = readState();
    state.schemaVersion = 3;
    state.status = "attempting";
    state.activeAttempt = {
      generation: state.generation,
      startedAtMs: Date.now() - 1_000,
      transaction: state.request.transaction,
    };
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);

    const runner = run(["--internal-runner", "--once"]);
    expect(runner.status).toBe(1);
    expect(readState()).toMatchObject({
      status: "failed",
      failure: { code: "deploy_attempt_interrupted" },
    });
  });

  it("one replacement runner safely retries an exact attempt without a new generation", async () => {
    if (process.platform === "win32") return;
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const liveRoot = realpathSync(live);
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const port = await unboundTcpPort();
    const impact = completeImpact({ kind: "frontend_reload" });
    const nowMs = Date.now();
    const firstRunnerKilled = join(workspace, "first-runner-killed");
    writeFileSync(
      join(upstream, "scripts", "deploy-dev-app.mjs"),
      `import { existsSync, writeFileSync } from "node:fs";
if (!existsSync(${JSON.stringify(firstRunnerKilled)})) {
  writeFileSync(${JSON.stringify(firstRunnerKilled)}, "killed\\n");
  process.kill(process.ppid, "SIGKILL");
  setTimeout(() => process.exit(0), 50);
} else {
  process.stderr.write("fixture retry reached\\n");
  process.exitCode = 7;
}
`,
    );
    commit(upstream, "receiptless runner target");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "--quiet", "-m", "runner loss executor"]);
    const targetHead = git(upstream, ["rev-parse", "HEAD"]);
    const store = new DevDeployQueueStore({ homeDirectory: home });
    const executor = stageDevDeployExecutor({
      queueDirectory: store.paths.directory,
      sourceRoot: upstream,
      sourceHead: targetHead,
    });
    const pending = enqueueDevDeploy({
      worktree: liveRoot,
      attemptArgs: [
        "--port",
        String(port),
        "--live-worktree",
        liveRoot,
      ],
      transaction: {
        ...testTransaction(targetHead, executor.entrypoint),
        executor,
        selection: { sourceHead, impact },
      },
      executionEnvironment: { HOME: home, PATH: process.env.PATH },
      receipt: {
        currentHead: sourceHead,
        targetHead,
        pendingCommits: 1,
        impact,
      },
      nowMs,
      maxWaitMs: 60_000,
      pollMs: 10,
    });
    store.mutate(() => pending);
    store.close();

    const runner = runQueueScript(devDeployQueueEntrypoint(executor), [
      "--internal-runner-supervisor",
      "--internal-runner-executor-generation",
      executor.generation,
    ]);

    expect(runner.status, runner.stderr).toBe(1);
    expect(existsSync(firstRunnerKilled)).toBe(true);
    expect(readState()).toMatchObject({
      generation: pending.generation,
      status: "failed",
      attempts: 2,
      request: { transaction: { targetHead } },
      priorFailure: {
        failure: { code: "deploy_attempt_interrupted" },
        evidence: { attemptId: expect.stringMatching(/^[a-f0-9]{32}$/) },
      },
      lastAttempt: {
        generation: pending.generation,
        exitCode: 7,
        stderr: "fixture retry reached",
      },
    });
    expect(readState().activeAttempt).toBeUndefined();
  });

  it("reconciles an exact durable result after its queue runner vanished", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    installParentSourceFixture(upstream);
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "--quiet", "-m", "parent source baseline"]);
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", "origin/main"]);
    const targetHead = commit(upstream, "post-boundary target");
    const deployLock = join(home, ".dure", "dev-deploy.lock");
    writeFileSync(deployLock, `${process.pid}\n`);
    run(["--live-worktree", live, "--json", "--no-verify"]);
    unlinkSync(deployLock);
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", targetHead]);

    const expectedParentSourceGeneration = devParentSourceGeneration(live);
    const parent = await startParentGenerationFixture(
      live,
      expectedParentSourceGeneration,
    );
    const runtime = await startRuntimeFixture(
      live,
      "recovered-app-generation",
    );
    const executorChild = spawn(
      process.execPath,
      [
        "-e",
        "process.send('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    await once(executorChild, "message");
    const executor = {
      pid: executorChild.pid,
      processIdentity: processIdentity(executorChild.pid),
      observedAtMs: Date.now(),
    };
    const executorClosed = once(executorChild, "close");
    executorChild.kill("SIGTERM");
    await executorClosed;

    const state = readState();
    const observedAtMs = Date.now();
    state.lastSuccessfulDeployment = {
      sourceHead: state.request.observed.currentHead,
      verifiedAtMs: observedAtMs - 2_000,
      runtime: {
        pid: runtime.child.pid,
        processIdentity: processIdentity(runtime.child.pid),
        observedAtMs: observedAtMs - 2_000,
        buildId: "fixture-build",
        generation: "recovered-app-generation",
      },
      parentGeneration: {
        sourceGeneration: expectedParentSourceGeneration,
        supervisor: parent.supervisor,
        launch: parent.launch,
        ...(parent.frontend ? { frontend: parent.frontend } : {}),
      },
    };
    state.status = "attempting";
    state.activeAttempt = {
      generation: state.generation,
      attemptId: "1".repeat(32),
      startedAtMs: observedAtMs - 1_000,
      transaction: state.request.transaction,
      executor,
      phase: {
        kind: "target_applied",
        targetHead,
        observedAtMs,
      },
      result: {
        completedAtMs: observedAtMs,
        exitCode: 0,
        receipt: {
          action: "deploy",
          deployed: true,
          currentHead: state.request.observed.currentHead,
          targetHead,
          targetAuthority: "origin/main",
          impact: completeImpact({ kind: "frontend_reload" }),
          verification: { status: "ok" },
          liveVerified: true,
          liveWorktree: realpathSync(live),
          transaction: state.request.transaction,
          runtime: {
            pid: runtime.child.pid,
            processIdentity: processIdentity(runtime.child.pid),
            observedAtMs,
            buildId: "fixture-build",
            generation: "recovered-app-generation",
          },
        },
      },
    };
    const completedState = `${JSON.stringify(state, null, 2)}\n`;
    writeFileSync(statePath(), completedState);
    const { channel } = worktreeDevIdentity(realpathSync(live));
    const runtimeDescriptorPath = join(
      appControlDirectory(home, channel),
      "server.json",
    );
    const runtimeDescriptor = JSON.parse(
      readFileSync(runtimeDescriptorPath, "utf8"),
    );
    const parentDescriptor = JSON.parse(
      readFileSync(parent.descriptorPath, "utf8"),
    );
    const runReacquirer = () =>
      waitForChild(
        spawn(
          process.execPath,
          [script, "--internal-runner", "--once"],
          {
            env: {
              ...fixtureEnvironment,
              HOME: home,
              DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
              DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );

    try {
      const activeAttemptBeforeContention = readState().activeAttempt;
      writeFileSync(deployLock, `${process.pid}\n`, { mode: 0o600 });
      const contended = await runReacquirer();
      expect(contended.code).toBe(0);
      expect(readState()).toMatchObject({
        status: "attempting",
        attempts: 1,
        activeAttempt: activeAttemptBeforeContention,
      });
      unlinkSync(deployLock);

      writeFileSync(
        runtimeDescriptorPath,
        `${JSON.stringify({
          ...runtimeDescriptor,
          generation: "advanced-app-generation",
        })}\n`,
        { mode: 0o600 },
      );
      const staleReceipt = await runReacquirer();
      expect(staleReceipt.code).toBe(1);
      expect(readState()).toMatchObject({
        status: "failed",
        attempts: 1,
        failure: {
          code: "deploy_attempt_recovery_authority_mismatch",
        },
        lastAttempt: {
          attemptId: "1".repeat(32),
          executor,
          phase: { kind: "target_applied", targetHead },
        },
      });
      expect(() => process.kill(runtime.child.pid, 0)).not.toThrow();

      writeFileSync(statePath(), completedState, { mode: 0o600 });
      writeFileSync(
        runtimeDescriptorPath,
        `${JSON.stringify(runtimeDescriptor)}\n`,
        { mode: 0o600 },
      );
      parent.writeDescriptor({
        ...parentDescriptor,
        supervisor: {
          ...parentDescriptor.supervisor,
          generation: "9".repeat(64),
        },
        publishedAtMs: Date.now(),
      });
      const replacedParent = await runReacquirer();
      expect(replacedParent.code).toBe(1);
      expect(readState()).toMatchObject({
        status: "failed",
        attempts: 1,
        failure: {
          code: "deploy_attempt_recovery_authority_mismatch",
        },
      });

      writeFileSync(statePath(), completedState, { mode: 0o600 });
      parent.writeDescriptor(parentDescriptor);
      const reacquirer = await runReacquirer();

      expect(
        reacquirer.code,
        `${reacquirer.stderr}\n${JSON.stringify(readState(), null, 2)}`,
      ).toBe(0);
      expect(readState()).toMatchObject({
        status: "succeeded",
        attempts: 1,
        finalReceipt: {
          action: "deploy",
          targetHead,
        },
        lastAttempt: {
          attemptId: "1".repeat(32),
          executor,
          phase: { kind: "target_applied", targetHead },
        },
        lastSuccessfulDeployment: {
          runtime: {
            pid: runtime.child.pid,
            generation: "recovered-app-generation",
          },
        },
      });
      expect(parent.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
        "parent_generation_probe",
        "parent_generation_probe",
      ]);
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);

      const authorityOnlyState = JSON.parse(completedState);
      delete authorityOnlyState.lastSuccessfulDeployment.parentGeneration;
      writeFileSync(
        statePath(),
        `${JSON.stringify(authorityOnlyState, null, 2)}\n`,
        { mode: 0o600 },
      );
      rmSync(join(live, "scripts", "lib", "dev-node-tool.mjs"));
      const authorityOnlyReacquirer = await runReacquirer();
      expect(
        authorityOnlyReacquirer.code,
        `${authorityOnlyReacquirer.stderr}\n${JSON.stringify(readState(), null, 2)}`,
      ).toBe(0);
      expect(readState()).toMatchObject({
        status: "succeeded",
        lastSuccessfulDeployment: {
          runtime: {
            pid: runtime.child.pid,
            generation: "recovered-app-generation",
          },
        },
      });
      expect(parent.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
        "parent_generation_probe",
        "parent_generation_probe",
        "parent_generation_probe",
      ]);
    } finally {
      await runtime.stop();
      await parent.close();
    }
  });

  it("settles the exact executor result after its owned runner dies post-boundary", async () => {
    if (process.platform === "win32") return;
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    installParentSourceFixture(upstream);
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "--quiet", "-m", "parent source baseline"]);
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", "origin/main"]);
    const liveRoot = realpathSync(live);
    const sourceHead = git(live, ["rev-parse", "HEAD"]);
    const targetHead = commit(upstream, "runner disappearance target");
    git(live, ["fetch", "origin", "main", "--quiet"]);
    const parent = await startParentGenerationFixture(
      live,
      devParentSourceGeneration(live),
    );
    const runtime = await startRuntimeFixture(
      live,
      "runner-loss-app-generation",
    );
    const executor = stageDevDeployExecutor({
      queueDirectory: join(home, ".dure", "dev-deploy"),
      sourceRoot: live,
      sourceHead: targetHead,
    });
    const impact = completeImpact({ kind: "frontend_reload" });
    const store = new DevDeployQueueStore({ homeDirectory: home });
    store.mutate(() =>
      enqueueDevDeploy({
        worktree: liveRoot,
        attemptArgs: [
          "--force",
          "--no-recover",
          "--verify-timeout",
          "10",
          "--live-worktree",
          liveRoot,
        ],
        transaction: {
          ...testTransaction(targetHead, executor.entrypoint),
          executor,
          selection: { sourceHead, impact },
        },
        executionEnvironment: { HOME: home, PATH: process.env.PATH },
        receipt: {
          currentHead: sourceHead,
          targetHead,
          pendingCommits: 1,
          impact,
        },
        nowMs: Date.now(),
        maxWaitMs: 60_000,
        pollMs: 10,
      }),
    );
    store.close();

    const runner = spawn(
      process.execPath,
      [script, "--internal-runner", "--once"],
      {
        env: {
          ...fixtureEnvironment,
          HOME: home,
          DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
          DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const runnerCompleted = waitForChild(runner);
    let stopped = false;
    try {
      const attachDeadline = Date.now() + 30_000;
      let attempting;
      while (Date.now() < attachDeadline) {
        attempting = readState();
        if (attempting.activeAttempt?.executor) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(attempting?.activeAttempt?.executor).toBeTruthy();
      expect(runner.kill("SIGSTOP")).toBe(true);
      stopped = true;

      const resultDeadline = Date.now() + 30_000;
      let completed;
      while (Date.now() < resultDeadline) {
        completed = readState();
        if (completed.activeAttempt?.result) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(completed?.activeAttempt).toMatchObject({
        phase: { kind: "target_applied", targetHead },
        result: {
          exitCode: 0,
          receipt: {
            deployReceiptVersion: 3,
            action: "deploy",
            targetHead,
            dispatchAccepted: true,
          },
        },
      });
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);

      expect(runner.kill("SIGKILL")).toBe(true);
      stopped = false;
      await runnerCompleted;

      const reacquirer = await waitForChild(
        spawn(
          process.execPath,
          [script, "--internal-runner", "--once"],
          {
            env: {
              ...fixtureEnvironment,
              HOME: home,
              DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
              DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );

      expect(
        reacquirer.code,
        `${reacquirer.stderr}\n${JSON.stringify(readState(), null, 2)}`,
      ).toBe(0);
      expect(readState()).toMatchObject({
        status: "succeeded",
        attempts: 1,
        lastAttempt: {
          attemptId: completed.activeAttempt.attemptId,
          executor: completed.activeAttempt.executor,
          phase: { kind: "target_applied", targetHead },
          exitCode: 0,
          receipt: { action: "deploy", targetHead },
        },
      });
      expect(readState().activeAttempt).toBeUndefined();
      expect(parent.requests.map(({ type }) => type)).toEqual([]);
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
    } finally {
      if (stopped) {
        runner.kill("SIGKILL");
        await runnerCompleted;
      }
      await runtime.stop();
      await parent.close();
    }
  });

  it("status observes an overdue request without settling it", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    run(["--live-worktree", live, "--json", "--no-verify"]);
    const state = readState();
    state.firstQueuedAtMs = Date.now() - 2_000;
    state.expiresAtMs = Date.now() - 1;
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    const stateBefore = readFileSync(statePath());
    const coordinationBefore = readFileSync(coordinationPath());

    const status = run(["--queue-status", "--json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).queue).toMatchObject({
      status: "pending",
      generation: state.generation,
    });
    expect(readFileSync(statePath())).toEqual(stateBefore);
    expect(readFileSync(coordinationPath())).toEqual(coordinationBefore);
  });

  it("keeps status read-only across a queued legacy executor", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    run(["--live-worktree", live, "--json", "--no-verify"]);

    const invoked = join(workspace, "legacy-executor-invoked");
    const legacyExecutor = join(workspace, "legacy-deploy-executor.mjs");
    writeFileSync(
      legacyExecutor,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(invoked)}, process.argv.slice(2).join("\\n"));\nprocess.exitCode = 1;\n`,
    );
    const queued = readState();
    queued.nextAttemptAtMs = Date.now() - 1;
    queued.request.attemptArgs = ["--status"];
    queued.request.executorPath = legacyExecutor;
    delete queued.worker;
    writeFileSync(statePath(), `${JSON.stringify(queued, null, 2)}\n`, {
      mode: 0o600,
    });
    const stateBefore = readFileSync(statePath());
    const coordinationBefore = readFileSync(coordinationPath());

    const status = run(["--queue-status", "--json"], {
      DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "0",
    });

    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).action).toBe("queue-status");
    expect(readFileSync(statePath())).toEqual(stateBefore);
    expect(readFileSync(coordinationPath())).toEqual(coordinationBefore);
    expect(existsSync(invoked)).toBe(false);
  });

  it("parses legacy --status before reserving a deploy generation", () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    run(["--live-worktree", live, "--json", "--no-verify"]);
    const stateBefore = readFileSync(statePath());
    const coordinationBefore = readFileSync(coordinationPath());

    const status = run(["--status", "--json"], {
      DURE_DEV_LIVE_WORKTREE: live,
    });

    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).action).toBe("queue-status");
    expect(readFileSync(statePath())).toEqual(stateBefore);
    expect(readFileSync(coordinationPath())).toEqual(coordinationBefore);
  });

  it("a concurrent cancel releases the original waiting requester", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    commit(upstream, "one");
    const blocker = new DevDeployQueueStore({ homeDirectory: home });
    const lease = blocker.acquireRunner();
    try {
      const child = spawn(
        process.execPath,
        [script, "--live-worktree", live, "--json", "--no-verify"],
        {
          encoding: "utf8",
          env: {
            ...fixtureEnvironment,
            HOME: home,
            DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
            DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const completed = waitForChild(child);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          if (readState().status === "pending") break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(readState().status).toBe("pending");
      const canceled = run(["--cancel-pending", "--json"]);
      expect(canceled.status).toBe(0);
      const result = await completed;
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/canceled before execution/);
    } finally {
      blocker.releaseRunner(lease);
      blocker.close();
    }
  });

  it("keeps Hmux backend activation debt after HEAD reaches the target", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const liveRoot = realpathSync(live);
    const backendHead = git(live, ["rev-parse", "HEAD"]);
    const backendRelativePath = "hmux/crates/hmux-runtime/src/lib.rs";
    const backendPath = join(upstream, backendRelativePath);
    mkdirSync(dirname(backendPath), { recursive: true });
    writeFileSync(backendPath, "pub fn coalesced_target() {}\n");
    git(upstream, ["add", backendRelativePath]);
    git(upstream, ["commit", "--quiet", "-m", "descendant Hmux target"]);
    const descendantTarget = git(upstream, ["rev-parse", "HEAD"]);
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", descendantTarget]);
    const queuedAtMs = Date.now();
    const blocker = new DevDeployQueueStore({ homeDirectory: home });
    blocker.mutate(() => {
      const pending = enqueueDevDeploy({
        worktree: liveRoot,
        attemptArgs: ["--force", "--live-worktree", liveRoot],
        transaction: testTransaction(descendantTarget),
        executionEnvironment: { HOME: home, PATH: process.env.PATH },
        receipt: {
          currentHead: descendantTarget,
          targetHead: descendantTarget,
          pendingCommits: 0,
          impact: completeImpact({ kind: "frontend_reload" }),
        },
        nowMs: queuedAtMs,
        maxWaitMs: 60_000,
        pollMs: 5_000,
      });
      return {
        ...pending,
        lastSuccessfulDeployment: {
          sourceHead: descendantTarget,
          backendHead,
          verifiedAtMs: queuedAtMs - 1,
        },
      };
    });
    const lease = blocker.acquireRunner();
    expect(lease).toBeTruthy();
    let leaseReleased = false;
    try {
      const child = spawn(
        process.execPath,
        [script, "--live-worktree", live, "--json", "--no-verify"],
        {
          encoding: "utf8",
          env: {
            ...fixtureEnvironment,
            HOME: home,
            DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
            DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const completed = waitForChild(child);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          if (readState().generation === 2) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(readState()).toMatchObject({
        generation: 2,
        request: {
          attemptArgs: expect.arrayContaining(["--force"]),
          transaction: {
            targetHead: descendantTarget,
            selection: {
              sourceHead: descendantTarget,
              impact: {
                kind: "backend_rebuild",
                backendChanged: true,
                changedPathCount: 1,
                hmuxRuntimeChanged: true,
              },
            },
          },
          observed: {
            currentHead: descendantTarget,
            targetHead: descendantTarget,
            pendingCommits: 0,
            impact: {
              kind: "backend_rebuild",
              backendChanged: true,
              changedPathCount: 1,
              hmuxRuntimeChanged: true,
            },
          },
        },
      });
      blocker.mutate((current) => ({
        ...current,
        nextAttemptAtMs: queuedAtMs + 50_000,
        request: {
          ...current.request,
          transaction: {
            ...current.request.transaction,
            selection: {
              ...current.request.transaction.selection,
              sourceHead: backendHead,
            },
          },
        },
      }));
      blocker.releaseRunner(lease);
      leaseReleased = true;

      const runner = run(["--internal-runner", "--once"]);
      expect(runner.status, runner.stderr).toBe(0);
      expect(readState().request.transaction.selection.sourceHead).toBe(
        descendantTarget,
      );
      expect(run(["--cancel-pending", "--json"]).status).toBe(0);
      expect((await completed).code).toBe(1);
    } finally {
      if (!leaseReleased) blocker.releaseRunner(lease);
      blocker.close();
    }
  });

  it("settles an already-active checked-out target without replaying its parent writer", async () => {
    const { activatedHead, live, targetHead } = prepareCheckedOutParentTarget();
    const expectedSourceGeneration = devParentSourceGeneration(live);
    persistStaleParentFailure(live, activatedHead, targetHead);
    const parent = await startParentGenerationFixture(
      live,
      expectedSourceGeneration,
    );
    const runtime = await startRuntimeFixture(live, "active-app-generation");
    const assertUserWipPreserved = createUserWipFixture(live);
    try {
      const child = spawn(
        process.execPath,
        [script, "--live-worktree", live, "--json", "--force"],
        {
          env: {
            ...fixtureEnvironment,
            HOME: home,
            DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
            DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const result = await waitForChild(child);
      expect(
        result.code,
        `${result.stderr}\n${JSON.stringify(readState(), null, 2)}`,
      ).toBe(0);
      const state = readState();
      expect(state).toMatchObject({
        generation: 2,
        status: "succeeded",
        attempts: 1,
        finalReceipt: {
          action: "skip",
          currentHead: targetHead,
          targetHead,
          plannedTransition: { state: "converged" },
        },
        lastSuccessfulDeployment: {
          sourceHead: targetHead,
          backendHead: activatedHead,
          parentGeneration: { sourceGeneration: expectedSourceGeneration },
        },
      });
      expect(parent.requests.map(({ type }) => type)).toEqual([
        "parent_generation_probe",
      ]);
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
      assertUserWipPreserved();
      expect(() => process.kill(runtime.child.pid, 0)).not.toThrow();
    } finally {
      await runtime.stop();
      await parent.close();
    }
  });

  it("reloads a stale parent when the target is already applied", async () => {
    const { activatedHead, live, targetHead } = prepareCheckedOutParentTarget();
    persistStaleParentFailure(live, activatedHead, targetHead);
    const parent = await startParentGenerationFixture(live, "f".repeat(64));
    const runtime = await startRuntimeFixture(live, "reloaded-app-generation");
    const assertUserWipPreserved = createUserWipFixture(live);

    try {
      const child = spawn(
        process.execPath,
        [script, "--live-worktree", live, "--json", "--force"],
        {
          env: {
            ...fixtureEnvironment,
            HOME: home,
            DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
            DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const result = await waitForChild(child);
      expect(
        result.code,
        `${result.stderr}\n${JSON.stringify(readState(), null, 2)}`,
      ).toBe(0);
      expect(
        parent.requests.map(({ type }) => type),
        `${result.stderr}\n${JSON.stringify(readState(), null, 2)}`,
      ).toEqual([
        "parent_generation_probe",
        "parent_reload",
        "parent_generation_probe",
      ]);
      expect(readState()).toMatchObject({
        generation: 2,
        status: "succeeded",
        attempts: 1,
        finalReceipt: {
          action: "skip",
          currentHead: targetHead,
          targetHead,
          plannedTransition: { state: "restarted" },
        },
        lastSuccessfulDeployment: {
          sourceHead: targetHead,
          backendHead: activatedHead,
          parentGeneration: {
            sourceGeneration: devParentSourceGeneration(live),
          },
        },
        request: {
          observed: { currentHead: targetHead, targetHead },
          transaction: {
            selection: {
              sourceHead: activatedHead,
              impact: { kind: "parent_reload" },
            },
          },
        },
      });
      expect(git(live, ["rev-parse", "HEAD"])).toBe(targetHead);
      assertUserWipPreserved();
    } finally {
      await runtime.stop();
      await parent.close();
    }
  });

  it("keeps the activation baseline separate from the checked-out HEAD", async () => {
    const upstream = join(workspace, "upstream");
    const live = join(workspace, "live");
    const liveRoot = realpathSync(live);
    const activatedHead = git(live, ["rev-parse", "HEAD"]);
    installParentSourceFixture(upstream);
    const parentPath = join(upstream, "scripts/run-dev-app.mjs");
    mkdirSync(dirname(parentPath), { recursive: true });
    writeFileSync(parentPath, "console.log('parent target');\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "--quiet", "-m", "parent target"]);
    const failedTarget = git(upstream, ["rev-parse", "HEAD"]);
    git(live, ["fetch", "origin", "main", "--quiet"]);
    git(live, ["merge", "--ff-only", "--quiet", failedTarget]);
    const nextTarget = commit(upstream, "frontend descendant");
    const queuedAtMs = Date.now();
    const blocker = new DevDeployQueueStore({ homeDirectory: home });
    blocker.mutate(() => {
      const pending = enqueueDevDeploy({
        worktree: liveRoot,
        attemptArgs: ["--force", "--live-worktree", liveRoot],
        transaction: {
          ...testTransaction(failedTarget),
          selection: {
            sourceHead: activatedHead,
            impact: completeImpact({ kind: "parent_reload" }),
          },
        },
        executionEnvironment: { HOME: home, PATH: process.env.PATH },
        receipt: {
          currentHead: activatedHead,
          targetHead: failedTarget,
          pendingCommits: 1,
          impact: completeImpact({ kind: "parent_reload" }),
        },
        nowMs: queuedAtMs,
        maxWaitMs: 60_000,
        pollMs: 5_000,
      });
      const failed = settleDevDeployAttempt(
        beginDevDeployAttempt(pending, queuedAtMs),
        {
          attemptGeneration: pending.generation,
          exitCode: 1,
          receipt: {
            action: "deploy",
            deployed: true,
            currentHead: activatedHead,
            targetHead: failedTarget,
            impact: { kind: "parent_reload" },
            expectedParentSourceGeneration: "e".repeat(64),
            verification: { status: "skew" },
          },
          nowMs: queuedAtMs + 1,
          pollMs: 5_000,
        },
      );
      return {
        ...failed,
        lastSuccessfulDeployment: {
          sourceHead: activatedHead,
          backendHead: activatedHead,
          hmuxActivation: hmuxActivationProof(live, activatedHead),
          verifiedAtMs: queuedAtMs - 1,
        },
      };
    });
    const lease = blocker.acquireRunner();
    expect(lease).toBeTruthy();
    try {
      const child = spawn(
        process.execPath,
        [script, "--live-worktree", live, "--json", "--no-verify"],
        {
          encoding: "utf8",
          env: {
            ...fixtureEnvironment,
            HOME: home,
            DURE_DEV_DEPLOY_QUEUE_DISABLE_AUTOSTART: "1",
            DURE_DEV_DEPLOY_QUEUE_POLL_MS: "10",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const completed = waitForChild(child);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          if (readState().generation === 2) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(readState()).toMatchObject({
        generation: 2,
        request: {
          transaction: {
            targetHead: nextTarget,
            selection: {
              sourceHead: activatedHead,
              impact: {
                kind: "parent_reload",
                backendChanged: false,
              },
            },
          },
          reconciliation: {
            kind: "parent_generation",
            targetHead: failedTarget,
          },
          observed: {
            currentHead: failedTarget,
            targetHead: nextTarget,
            pendingCommits: 1,
          },
        },
      });
      expect(
        readState().request.transaction.selection.impact.changedPathCount,
      ).toBeGreaterThan(1);
      expect(run(["--cancel-pending", "--json"]).status).toBe(0);
      expect((await completed).code).toBe(1);
    } finally {
      blocker.releaseRunner(lease);
      blocker.close();
    }
  });

  it("rejects conflicting queue control modes", () => {
    const result = run(["--queue-status", "--cancel-pending", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });

  it("accepts pnpm's explicit argument separator", () => {
    const result = run(["--queue-status", "--", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).queue.status).toBe("empty");
  });
});
