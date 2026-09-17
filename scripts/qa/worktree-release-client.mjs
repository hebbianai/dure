import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadAppControlDescriptor } from "../../cli/lib/app-control-location.mjs";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";
import { appControlDirectory } from "../lib/app-channel.mjs";
import { readDescriptor } from "../lib/dev-launch-storage.mjs";
import { writeAtomicFile } from "../lib/durable-file.mjs";
import { processLivenessFromObservation, processMemberSnapshots } from "../lib/process-identity.mjs";
import { readWorktreeReleaseReceipt, worktreeReleasePlan } from "../lib/worktree-release.mjs";
import { assertIsolatedCleanupBoundary, collectIsolatedHmuxCleanupTargets } from "./lib/isolated-hmux-session-cleanup.mjs";

const stateRoot = process.env.DURE_QA_STATE_ROOT;
const discoveryRoot = process.env.HMUX_DISCOVERY_ROOT;
assertIsolatedCleanupBoundary(stateRoot, discoveryRoot);
const home = process.env.HOME;
const root = process.cwd();
assert.equal(home, join(stateRoot, "home"));
const plan = worktreeReleasePlan(root, process.env.HEBBIAN_DEV_INSTANCE, {
  app: { windows: [{}] },
});
assert.equal(process.env.DURE_APP_CHANNEL, plan.profile.sourceChannel);
const sourceDirectory = appControlDirectory(home, plan.profile.sourceChannel);
const releaseDirectory = appControlDirectory(home, plan.profile.targetChannel);
const receipt = readWorktreeReleaseReceipt(join(releaseDirectory, "worktree-release-build.json"), plan.profile, {
  artifactRoot: join(root, "src-tauri/target/worktree-release", plan.profile.targetChannel),
  productName: plan.productName,
  cliRoot: join(home, ".local/share/hebbian-ide-cli/channels", plan.profile.targetChannel),
});
const evidence = { schemaVersion: 1, sourceRevision: receipt.sourceRevision,
  bundleDigest: receipt.bundleDigest, phase: "source_ready", result: "running",
  startedAt: new Date().toISOString() };
const evidencePath = join(stateRoot, "evidence/worktree-release.json");

async function waitFor(label, operation) {
  const deadline = Date.now() + 60_000;
  let lastCode;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastCode = error.message ?? error.code;
    }
    await delay(250);
  }
  throw new Error(`${label} was not observed before the QA deadline (${lastCode ?? "pending"})`);
}

const post = (descriptor, path, body = {}) => requestAppControl({
  descriptor, path, body, timeoutMs: 10_000, maxResponseBytes: 17 * 1024 * 1024,
});
async function sourceValue(descriptor) {
  const response = await post(descriptor, "/worktree/presentation/export", {
    sourceChannel: plan.profile.sourceChannel,
  });
  assert.equal(response.sourceChannel, plan.profile.sourceChannel);
  assert.equal(typeof response.serializedValue, "string");
  return response.serializedValue;
}
const digest = (value) => createHash("sha256").update(value).digest("hex");

function liveRuntime() {
  const targets = collectIsolatedHmuxCleanupTargets(discoveryRoot);
  for (const target of targets) {
    assert.equal(target.lifecycle, "ready");
    for (const proof of [target.hostProcess, target.providerProcess]) {
      const probe = JSON.parse(execFileSync(process.env.DURE_QA_HMUX_CLI, [
        "--discovery-root", discoveryRoot, "--json", "process", "probe",
        String(proof.process_id), proof.start_marker,
      ], { encoding: "utf8", timeout: 7_000 }));
      assert.equal(probe.schemaVersion, 1);
      assert.equal(probe.status, "live");
      assert.equal(Number(probe.process?.process_id), proof.process_id);
      assert.equal(probe.process?.start_marker, proof.start_marker);
    }
  }
  return targets;
}

async function attachedPane(descriptor, paneId) {
  return waitFor(`attached pane ${paneId}`, async () => {
    const response = await post(descriptor, "/pane/state", { targetPanelId: paneId });
    return response.pane?.paneId === paneId && response.pane.status === "attached";
  });
}

try {
  const source = loadAppControlDescriptor(sourceDirectory);
  assert.equal(source.channel, plan.profile.sourceChannel);
  await waitFor("source frontend", () => post(source, "/diagnostics"));
  evidence.phase = "source_fixture";
  const fixtures = [];
  for (const name of ["Release migration A", "Release migration B"]) {
    const created = await post(source, "/space/create", { name });
    const space = created.space;
    assert.equal(space.name, name);
    const { pane } = await post(source, "/hmux/create", { spaceId: space.spaceId, cwd: stateRoot });
    await attachedPane(source, pane.panelId);
    fixtures.push({ name, spaceId: space.spaceId, paneId: pane.panelId,
      sessionId: pane.sessionId, workspaceId: pane.workspaceId });
  }
  const before = liveRuntime();
  for (const fixture of fixtures) assert(before.some((target) =>
    target.session_id === fixture.sessionId && target.workspace_id === fixture.workspaceId));
  let previous;
  const original = await waitFor("quiescent source presentation", async () => {
    const value = await sourceValue(source);
    const stable = value === previous;
    previous = value;
    return stable ? value : false;
  });
  evidence.sourceSha256 = digest(original);
  evidence.fixtures = fixtures;
  evidence.runtimeBefore = before;
  evidence.phase = "release_launch";
  writeAtomicFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const output = openSync(join(stateRoot, "release-launch.log"), "w", 0o600);
  const child = spawn(process.execPath, [join(root, "scripts/qa/worktree-release-app.mjs"), "start"], {
    cwd: root, env: process.env, stdio: ["ignore", output, output],
  });
  closeSync(output);
  let childFailure;
  child.once("error", (error) => { childFailure = error.message; });
  child.once("exit", (code, signal) => { childFailure = `launcher exited ${code ?? signal}`; });
  const ready = await waitFor("exact release supervisor readiness", () => {
    if (childFailure) throw new Error(childFailure);
    const { value } = readDescriptor({ home, channel: plan.profile.targetChannel, worktreeRoot: root });
    assert.equal(value.supervisor.pid, child.pid);
    if (value.state !== "ready") return false;
    const observation = processMemberSnapshots([value.supervisor.pid, value.launch.pid]);
    assert.equal(processLivenessFromObservation(value.supervisor, observation), "active");
    assert.equal(processLivenessFromObservation(value.launch, observation), "active");
    assert.equal(value.frontend ?? null, null, "release unexpectedly started a frontend process");
    return value;
  });
  const release = await waitFor("release frontend", async () => {
    const descriptor = loadAppControlDescriptor(releaseDirectory);
    assert.equal(descriptor.channel, plan.profile.targetChannel);
    assert.equal(descriptor.processId, ready.launch.pid);
    await post(descriptor, "/diagnostics");
    return descriptor;
  });
  evidence.releaseGeneration = release.generation;
  evidence.releaseProcess = { pid: ready.launch.pid, processIdentity: ready.launch.processIdentity };
  evidence.viteSupervisor = ready.frontend ?? null;
  evidence.phase = "restoration";
  for (const fixture of fixtures) {
    const activated = await post(release, "/space/activate", { spaceId: fixture.spaceId });
    assert.equal(activated.space.name, fixture.name);
    await attachedPane(release, fixture.paneId);
  }
  const after = liveRuntime();
  assert.deepEqual(after, before, "migration changed the exact Host/provider generations");
  assert.equal(digest(await sourceValue(source)), evidence.sourceSha256, "migration changed source presentation");
  const archived = JSON.parse(readFileSync(join(releaseDirectory, "worktree-presentation-v1.json.imported"), "utf8"));
  assert.equal(digest(archived.serializedValue), evidence.sourceSha256);
  evidence.runtimeAfter = after;
  evidence.phase = "dev_rollback";
  for (const fixture of fixtures) {
    const activated = await post(source, "/space/activate", { spaceId: fixture.spaceId });
    assert.equal(activated.space.name, fixture.name);
    await attachedPane(source, fixture.paneId);
  }
  assert.deepEqual(liveRuntime(), before);
  evidence.result = "passed";
  evidence.phase = "complete";
} catch (error) {
  evidence.result = "failed";
  evidence.error = error.message;
} finally {
  evidence.finishedAt = new Date().toISOString();
  writeAtomicFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
// The outer app runner owns freeze/reap/retirement, including the launcher's
// descendants. Do not terminate its supervisor before that coordinated handoff.
process.exit(evidence.result === "passed" ? 0 : 1);
