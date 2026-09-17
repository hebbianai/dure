#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PHASES = [
  "host_starting_published",
  "before_provider_spawn",
  "provider_spawned",
  "host_ready_published",
  "test_body",
];
const POLL_MS = 20;
const MARKER_WAIT_MS = 15_000;
const CLEANUP_WAIT_MS = 25_000;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const runner = path.join(repositoryRoot, "scripts/run-hmux-tests.mjs");
const targetRoot = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repositoryRoot, "hmux/target");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const hmuxCli = path.join(targetRoot, `debug/hmux${executableSuffix}`);
const hmuxRuntime = path.join(
  targetRoot,
  `debug/hmux-runtime${executableSuffix}`,
);

export function guardianFaultEnvironmentForPhase(phase) {
  return phase === "test_body"
    ? {
        DURE_HMUX_FAULT_WRITE_BODY_MARKER: "1",
        DURE_QA_TEST_OWNER_LOSS_TERMINATION_FAILURE: "1",
      }
    : {};
}

function boundedDiagnostic(value) {
  return String(value instanceof Error ? value.message : value)
    .trim()
    .replaceAll(/\s+/gu, " ")
    .slice(0, 1_024);
}

function assertExecutable(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} is not a direct executable`);
  }
}

function runJson(args, environment = process.env) {
  const result = spawnSync(hmuxCli, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Hmux command failed: ${boundedDiagnostic(
        result.error ?? result.stderr ?? `exit ${result.status}`,
      )}`,
    );
  }
  return JSON.parse(result.stdout);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readPublishedFile(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitFor(condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return;
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  throw new Error(message);
}

function canonicalManifestFiles(root) {
  if (!fs.existsSync(root)) return [];
  const manifests = [];
  const queue = [root];
  let scanned = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      scanned += 1;
      if (scanned > 4_096) throw new Error("manifest scan limit exceeded");
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name === "manifest.json" &&
        path.basename(path.dirname(entryPath)).startsWith("s_") &&
        path.basename(path.dirname(path.dirname(entryPath))).startsWith("w_")
      ) {
        manifests.push(entryPath);
      }
    }
  }
  return manifests.sort();
}

function runtimePids() {
  const result = spawnSync("ps", ["-axo", "pid=,comm="], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("could not inspect runtime processes");
  const candidates = result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ command: match[2], pid: Number(match[1]) }));
  const expected = fs.realpathSync(hmuxRuntime);
  return candidates
    .filter(({ command, pid }) => {
      if (process.platform !== "linux") return command === expected;
      try {
        return fs.realpathSync(`/proc/${pid}/exe`) === expected;
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
        throw error;
      }
    })
    .map(({ pid }) => pid)
    .sort((left, right) => left - right);
}

export function unexpectedRuntimePids(expected, observed) {
  const allowed = new Set(expected);
  return observed.filter((pid) => !allowed.has(pid));
}

async function assertNoUnexpectedRuntimePids(expected, label) {
  let observed = [];
  await waitFor(
    () => {
      observed = runtimePids();
      return unexpectedRuntimePids(expected, observed).length === 0;
    },
    CLEANUP_WAIT_MS,
    `${label} left unexpected runtime generations: allowed=${expected.join(",")}; ` +
      `observed=${observed.join(",")}; ` +
      `unexpected=${unexpectedRuntimePids(expected, observed).join(",")}`,
  );
}

function manifestFence(envelope) {
  const common = envelope.manifest.common;
  return {
    channel_epoch: String(common.lifetime.channel_epoch),
    host_instance_id: common.host_instance_id,
    runner_instance: common.lifetime.runner_instance,
    runner_principal: common.lifetime.runner_principal,
    session_id: common.lifetime.session_id,
    terminal_epoch: envelope.manifest.terminal_epoch,
    workspace_id: common.lifetime.workspace_id,
  };
}

function processStatus(discoveryRoot, processProof) {
  return runJson([
    "--discovery-root",
    discoveryRoot,
    "--json",
    "process",
    "probe",
    String(processProof.process_id),
    processProof.start_marker,
  ]).status;
}

async function terminateControlSession(control) {
  const envelope = JSON.parse(fs.readFileSync(control.manifest, "utf8"));
  const common = envelope.manifest.common;
  runJson([
    "--discovery-root",
    control.discoveryRoot,
    "--json",
    "kill",
    common.lifetime.session_id,
    "--workspace",
    common.lifetime.workspace_id,
    "--expected-fence-json",
    JSON.stringify(manifestFence(envelope)),
    "--runtime",
    hmuxRuntime,
    "--timeout-ms",
    "10000",
  ]);
  await waitFor(
    () =>
      processStatus(control.discoveryRoot, common.host_process) === "absent" &&
      processStatus(control.discoveryRoot, envelope.manifest.provider_process) ===
        "absent",
    CLEANUP_WAIT_MS,
    "control standalone did not retire",
  );
}

function createControlSession(matrixRoot) {
  const root = path.join(matrixRoot, "control");
  const discoveryRoot = path.join(root, "discovery");
  const zshRoot = path.join(root, "zsh");
  fs.mkdirSync(discoveryRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(zshRoot, { mode: 0o700 });
  runJson(
    [
      "--discovery-root",
      discoveryRoot,
      "--json",
      "new",
      "--runtime",
      hmuxRuntime,
      "--name",
      "guardian-matrix-control",
      "/bin/sh",
    ],
    { ...process.env, ZDOTDIR: zshRoot },
  );
  const manifests = canonicalManifestFiles(discoveryRoot);
  if (manifests.length !== 1) {
    throw new Error("control standalone did not publish exactly one manifest");
  }
  return {
    discoveryRoot,
    manifest: manifests[0],
    manifestBytes: fs.readFileSync(manifests[0]),
  };
}

function assertControlUnchanged(control, phase) {
  const current = fs.readFileSync(control.manifest);
  if (!current.equals(control.manifestBytes)) {
    throw new Error(`${phase} changed the control standalone manifest/fence`);
  }
  const envelope = JSON.parse(current);
  if (
    processStatus(control.discoveryRoot, envelope.manifest.common.host_process) !==
      "live" ||
    processStatus(control.discoveryRoot, envelope.manifest.provider_process) !==
      "live"
  ) {
    throw new Error(`${phase} changed the control standalone process generation`);
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function runPhase(matrixRoot, phase, expectedRuntimePids) {
  const phaseRoot = path.join(matrixRoot, phase);
  fs.mkdirSync(phaseRoot, { mode: 0o700 });
  const stateCapture = path.join(phaseRoot, "state-root.txt");
  const phaseMarker = path.join(phaseRoot, "phase.marker");
  const output = path.join(phaseRoot, "guardian.log");
  const outputDescriptor = fs.openSync(output, "wx", 0o600);
  const debugPhase = phase === "test_body" ? undefined : phase;
  const command = [
    process.execPath,
    "-e",
    'const {spawnSync}=require("node:child_process");' +
      'const result=spawnSync(process.env.DURE_HMUX_FAULT_CLI,["--discovery-root",process.env.HMUX_DISCOVERY_ROOT,"--json","new","--runtime",process.env.DURE_HMUX_FAULT_RUNTIME,"--name","guardian-cut","/bin/sh"],{env:process.env,stdio:"inherit"});' +
      "if(result.status!==0||result.signal)process.exit(result.status??1);" +
      'if(process.env.DURE_HMUX_FAULT_WRITE_BODY_MARKER==="1")require("node:fs").writeFileSync(process.env.DURE_HMUX_FAULT_BODY_MARKER,"test_body\\n",{flag:"wx",mode:0o600});' +
      "setInterval(()=>{},300000);",
  ];
  const launcher = spawn(
    process.execPath,
    [runner, "--", ...command],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DURE_HMUX_FAULT_BODY_MARKER: phaseMarker,
        ...guardianFaultEnvironmentForPhase(phase),
        DURE_HMUX_FAULT_CLI: hmuxCli,
        DURE_HMUX_FAULT_RUNTIME: hmuxRuntime,
        DURE_HMUX_TEST_STATE_ROOT_CAPTURE: stateCapture,
        ...(debugPhase
          ? {
              HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER: phaseMarker,
              HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE: debugPhase,
            }
          : {}),
        NODE_ENV: "test",
      },
      stdio: ["ignore", outputDescriptor, outputDescriptor],
    },
  );
  fs.closeSync(outputDescriptor);
  let stateRoot;
  try {
    await waitFor(
      () =>
        readPublishedFile(stateCapture) !== undefined &&
        readPublishedFile(phaseMarker) !== undefined,
      MARKER_WAIT_MS,
      `${phase} did not reach its cut marker`,
    );
    stateRoot = readPublishedFile(stateCapture);
    const marker = readPublishedFile(phaseMarker);
    if (marker !== phase) {
      throw new Error(`${phase} published an unexpected marker: ${marker}`);
    }
    const lifecycle = canonicalManifestFiles(stateRoot).map((file) =>
      JSON.parse(fs.readFileSync(file, "utf8")).lifecycle,
    );
    if (
      phase === "host_ready_published" || phase === "test_body"
        ? !lifecycle.includes("ready")
        : !lifecycle.includes("starting")
    ) {
      throw new Error(`${phase} did not expose its expected manifest lifecycle`);
    }

    if (
      launcher.exitCode !== null ||
      launcher.signalCode !== null ||
      !launcher.kill("SIGKILL")
    ) {
      throw new Error(`${phase} launcher exited before the SIGKILL cut`);
    }
    const launcherExit = await waitForChild(launcher);
    if (launcherExit.signal !== "SIGKILL") {
      throw new Error(`${phase} launcher did not exit from the SIGKILL cut`);
    }
    await waitFor(
      () => !fs.existsSync(stateRoot),
      CLEANUP_WAIT_MS,
      `${phase} did not retire its guarded state root`,
    );
    await assertNoUnexpectedRuntimePids(expectedRuntimePids, phase);
  } catch (error) {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGKILL");
      await waitForChild(launcher).catch(() => {});
    }
    const diagnostic = fs.existsSync(output)
      ? fs.readFileSync(output, "utf8").slice(-4_096)
      : "no guardian log";
    throw new Error(
      `${boundedDiagnostic(error)}; guardian=${boundedDiagnostic(diagnostic)}; ` +
        `state_root=${stateRoot ?? "unpublished"}`,
    );
  }
}

async function main() {
  if (process.platform === "win32") {
    throw new Error("Hmux guardian fault matrix requires Unix process groups");
  }
  assertExecutable(hmuxCli, "Hmux CLI");
  assertExecutable(hmuxRuntime, "Hmux runtime");
  const matrixRoot = fs.mkdtempSync(
    path.join(fs.realpathSync("/tmp"), "dure-hmux-guardian-matrix."),
  );
  fs.chmodSync(matrixRoot, 0o700);
  const initialRuntimePids = runtimePids();
  let control;
  try {
    control = createControlSession(matrixRoot);
    const expectedRuntimePids = runtimePids();
    const controlEnvelope = JSON.parse(fs.readFileSync(control.manifest, "utf8"));
    const controlRuntimePid = Number(
      controlEnvelope.manifest.common.host_process.process_id,
    );
    if (
      initialRuntimePids.includes(controlRuntimePid) ||
      !expectedRuntimePids.includes(controlRuntimePid)
    ) {
      throw new Error("control standalone runtime was not independently observed");
    }
    for (const phase of PHASES) {
      await runPhase(matrixRoot, phase, expectedRuntimePids);
      assertControlUnchanged(control, phase);
    }
    await terminateControlSession(control);
    control = undefined;
    await assertNoUnexpectedRuntimePids(initialRuntimePids, "matrix completion");
    fs.rmSync(matrixRoot, { recursive: true });
    process.stdout.write(
      `${JSON.stringify({ phases: PHASES, schema: "dure-hmux-guardian-matrix/v1" })}\n`,
    );
  } catch (error) {
    if (control) {
      await terminateControlSession(control).catch(() => {});
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`hmux_guardian_matrix_failed: ${boundedDiagnostic(error)}`);
    process.exitCode = 1;
  });
}
