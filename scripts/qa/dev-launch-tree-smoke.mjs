import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDescriptor, requestDevLaunchRestart } from "../lib/dev-launch-client.mjs";
import { launchRetired } from "../lib/dev-launch-retirement.mjs";
import { observeProcessMembers } from "../lib/process-identity.mjs";
import { stageDevDeployExecutor } from "../lib/dev-deploy-executor.mjs";
import { devTreeEnvironment } from "./lib/dev-tree-environment.mjs";

const fixture = fileURLToPath(new URL("./fixtures/dev-launch-tree.mjs", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "dure-dev-tree-")));
const treePath = join(root, "tree.json");
const legacy = process.argv.includes("--legacy-observation");
const options = { home: root, root, worktreeRoot: root, channel: "dev-tree-fixture" };
const environment = devTreeEnvironment(root, options.channel);
const staged = process.argv.includes("--staged-executor")
  ? stageDevDeployExecutor({ queueDirectory: join(root, "executor") }) : null;
const supervisorModule = staged
  ? [pathToFileURL(join(dirname(staged.entrypoint), "lib/dev-launch-supervisor.mjs")).href] : [];
const child = spawn(process.execPath, [fixture, legacy ? "legacy" : "supervisor", root, ...supervisorModule], {
  cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"],
});
let outcome;
let diagnostics = "";
const appendDiagnostics = (chunk) => { diagnostics = (diagnostics + chunk).slice(-16_384); };
child.stdout.on("data", appendDiagnostics);
child.stderr.on("data", appendDiagnostics);
child.once("error", (error) => { outcome = { error: error.message }; });
child.once("exit", (code, signal) => { outcome = { code, signal }; });

async function waitFor(observe, { expectChild = true, timeoutMs = 20_000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (expectChild && outcome) {
      throw new Error(`fixture exited before observation: ${JSON.stringify(outcome)}\n${diagnostics}`);
    }
    const value = await observe();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`fixture observation timed out\n${diagnostics}`);
}

function tree() {
  try {
    return JSON.parse(readFileSync(treePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function liveMembers(members) {
  const observation = await observeProcessMembers({
    kind: "point", pids: members.map(({ pid }) => pid),
  });
  assert.equal(observation.status, "complete");
  return observation.members.filter((member) => member.state !== "zombie" &&
    members.some((owned) => owned.processIdentity === member.processIdentity));
}

function launchMembers(launch) {
  return launch ? [launch, ...(launch.processGroup ? [launch.processGroup.witness] : [])] : [];
}

const observed = [];
try {
  const first = await waitFor(tree);
  observed.push(...first.members);
  if (legacy) {
    writeFileSync(join(root, "exit-leader"), "exit\n");
    await waitFor(() => outcome, { expectChild: false });
    const leader = first.members.find(({ pid }) => pid === child.pid);
    assert.ok(leader);
    let retired = false;
    let refusal;
    try {
      retired = await launchRetired({
        child, detached: false, exited: true, launch: { ...leader, generation: "a".repeat(64) },
      });
    } catch (error) {
      assert.equal(error.code, "DEV_LAUNCH_OBSERVATION_UNAVAILABLE");
      refusal = error.code;
    }
    const remainingDescendants = (await liveMembers(first.members)).length;
    if (process.platform === "win32") {
      assert.equal(retired, false, "A missing Job cannot prove descendant retirement.");
      assert.equal(remainingDescendants, 2);
    }
    console.log(JSON.stringify({
      schemaVersion: 1, platform: process.platform, observation: "legacy_leader_only",
      retirementAccepted: retired, refusal, remainingDescendants,
    }));
  } else {
    const firstDescriptor = await waitFor(() => {
      const value = readDescriptor(options).value;
      return value.state === "ready" ? value : null;
    });
    observed.push(...launchMembers(firstDescriptor.launch), ...launchMembers(firstDescriptor.frontend));
    const frontend = JSON.parse(readFileSync(join(root, "frontend-tree.json"), "utf8"));
    observed.push(...frontend.members);
    await requestDevLaunchRestart({ ...options, timeoutMs: 5_000, settlementTimeoutMs: 20_000 });
    const second = await waitFor(() => {
      const current = tree();
      return current && current.generation !== first.generation ? current : null;
    });
    observed.push(...second.members);
    assert.equal(second.predecessorRetired, true);
    assert.deepEqual(await liveMembers([...first.members, ...launchMembers(firstDescriptor.launch)]), []);
    const secondDescriptor = await waitFor(() => {
      const value = readDescriptor(options).value;
      return value.state === "ready" && value.launch.generation === second.generation ? value : null;
    });
    const successors = [...second.members, ...frontend.members,
      ...launchMembers(secondDescriptor.launch), ...launchMembers(secondDescriptor.frontend)];
    observed.push(...successors);
    // On Windows this is an actual abrupt native termination, not a JS signal simulation.
    assert.equal(child.kill("SIGTERM"), true);
    await waitFor(() => outcome, { expectChild: false });
    await waitFor(async () => (await liveMembers(successors)).length === 0,
      { expectChild: false });
    console.log(JSON.stringify({
      schemaVersion: 1, platform: process.platform,
      start: "verified", restartWithoutOverlap: "verified", signalTreeCleanup: "verified",
      preparationTreeCleanup: "verified", frontendTreeCleanup: "verified", stagedExecutor: Boolean(staged),
      launchAndWitnessCleanup: "verified",
    }));
  }
} finally {
  // Failed assertions must not leave fixture descendants or touch a real channel.
  writeFileSync(join(root, "release"), "release\n");
  await waitFor(() => outcome, { expectChild: false });
  const lastTree = tree();
  if (lastTree) observed.push(...lastTree.members);
  for (const name of readdirSync(root)) {
    if (/^member-\d+\.json$/.test(name)) {
      observed.push(JSON.parse(readFileSync(join(root, name), "utf8")));
    }
  }
  if (observed.length > 0) {
    await waitFor(async () => (await liveMembers(observed)).length === 0, { expectChild: false });
  }
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith("dure-dev-tree-"));
  rmSync(root, { recursive: true });
}
