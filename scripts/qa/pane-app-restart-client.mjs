import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { loadAppControlDescriptor } from "../../cli/lib/app-control-location.mjs";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";
import { appControlDirectory } from "../lib/app-channel.mjs";
import { readDescriptor, requestDevLaunchRestart } from "../lib/dev-launch-client.mjs";
import { writeAtomicFile } from "../lib/durable-file.mjs";
import { observeProcessMembers } from "../lib/process-identity.mjs";
import { assertIsolatedCleanupBoundary, collectIsolatedHmuxCleanupTargets } from "./lib/isolated-hmux-session-cleanup.mjs";
import { exactOwnedProcessIdentity, readOwnedProcessGroup, readOwnedProcessLedger } from "./lib/owned-process-group.mjs";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";
import { runPaneAppClaimQa } from "./pane-app-claim-client.mjs";

function verifyWindow(receipt, proof, status) {
  assert.equal(receipt.proof, proof, "Receipt belongs to another QA run");
  assert.equal(receipt.status, status, receipt.error ?? "Unexpected QA phase");
  assert.equal(receipt.windowLabel, "main");
  assert.match(receipt.realm, /^[a-f\d-]{36}$/);
  assert.match(receipt.userAgent, /AppleWebKit/u);
  assert.doesNotMatch(receipt.userAgent, /Chrom(?:e|ium)/u);
}

function verifyPanePresentations(snapshot, terminals) {
  const { presentations, ...identity } = snapshot;
  assert.ok(Array.isArray(presentations), "Missing terminal presentation evidence");
  assert.deepEqual(presentations.map(({ paneId }) => paneId).sort(), terminals.map(({ paneId }) => paneId).sort(),
    "Missing or duplicate terminal presentation");
  for (const { paneId, terminalEpoch } of terminals) {
    const presentation = presentations.find((entry) => entry.paneId === paneId);
    assert.equal(presentation.state, "live", "Terminal presentation is not live");
    assert.equal(presentation.terminalEpoch, terminalEpoch, "Terminal presentation belongs to another epoch");
    assert.match(presentation.receivedSequence, /^\d+$/u, "No frame received");
    assert.match(presentation.presentedSequence, /^\d+$/u, "No frame presented");
    assert.ok(BigInt(presentation.presentedSequence) <= BigInt(presentation.receivedSequence), "Unobserved frame presented");
  }
  // Frames advance independently; every identity/layout field still compares exactly.
  return identity;
}

function verifyBefore(before) {
  const { fixture, snapshot } = before;
  assert.equal(before.schemaVersion, 1);
  assert.equal(before.phase, "prepared");
  assert.equal(snapshot.spaceId, fixture.spaceId);
  assert.equal(snapshot.activeSpaceId, fixture.spaceId);
  assert.equal(snapshot.activePaneId, fixture.convertedPaneId);
  assert.deepEqual(snapshot.layout, snapshot.durableLayout, "Prepared layout is not durable");
  assert.equal(fixture.terminals.length, 3);
  assert.equal(new Set(fixture.terminals.map(({ paneId }) => paneId)).size, 3);
  for (const paneId of [fixture.convertedPaneId, fixture.legacyPaneId]) {
    assert.ok(fixture.terminals.some((terminal) => terminal.paneId === paneId));
  }
  assert.equal(new Set(snapshot.panes.map(({ id }) => id)).size, snapshot.panes.length);
  assert.equal(snapshot.sessions.length, 3);
  assert.match(fixture.convertedPaneId, /^pane-[A-Za-z0-9_-]+$/);
  assert.match(fixture.launcherPaneId, /^pane-[A-Za-z0-9_-]+$/);
  assert.equal(fixture.legacyPaneId, `launcher:${before.proof}`);
  const launcher = snapshot.panes.find(({ id }) => id === fixture.launcherPaneId);
  assert.equal(launcher?.component, "launcher");
  assert.equal(launcher.params?.binding, undefined, "Unselected launcher has a runtime target");
  for (const [index, terminal] of fixture.terminals.entries()) {
    for (const key of ["paneId", "sessionId", "workspaceId", "terminalEpoch"]) {
      assert.equal(typeof terminal[key], "string");
      assert.ok(terminal[key].length, `Missing terminal ${key}`);
    }
    const pane = snapshot.panes.find(({ id }) => id === terminal.paneId);
    assert.equal(pane?.component, "terminal");
    assert.ok(["standalone", "managed"].includes(terminal.sessionClass));
    const { createIdempotencyKey, stopFence, ...binding } = pane.params.binding;
    assert.deepEqual(binding, {
      schemaVersion: 1, runtime: `hmux_${terminal.sessionClass}_v1`, source: "local", hostId: "local",
      sessionId: terminal.sessionId, workspaceId: terminal.workspaceId,
    });
    if (terminal.sessionClass === "managed") {
      assert.ok(typeof createIdempotencyKey === "string" && createIdempotencyKey.length > 0);
      assert.equal(stopFence?.terminalEpoch, terminal.terminalEpoch);
    } else {
      assert.equal(createIdempotencyKey, undefined);
      assert.equal(stopFence, undefined);
    }
    assert.deepEqual(snapshot.sessions[index], { ...terminal, lifecycle: "ready", health: "current_healthy" });
  }
  return verifyPanePresentations(snapshot, fixture.terminals);
}

function verifyNativeApp(app) {
  assert.ok(Number.isSafeInteger(app.pid) && app.pid > 1, "Missing native app PID");
  for (const field of ["processIdentity", "generation", "channel"]) {
    assert.ok(typeof app[field] === "string" && app[field].length > 0, `Missing native app ${field}`);
  }
}

export async function observeRestartApp(descriptor, { channel, stateRoot }) {
  assert.equal(descriptor?.channel, channel);
  const ping = await requestAppControl({ descriptor, path: "/ping", method: "GET", timeoutMs: 10_000 });
  for (const field of ["channel", "generation", "processId"]) {
    assert.equal(ping[field], descriptor[field], `Native backend ${field} differs from its descriptor`);
  }
  const observation = await observeProcessMembers({ kind: "point", pids: [descriptor.processId] });
  assert.equal(observation.status, "complete");
  const member = observation.members.find(({ pid, state }) => pid === descriptor.processId && state !== "zombie");
  assert.ok(member, "Native Dure process is not live");
  const owner = readOwnedProcessGroup(join(stateRoot, "app-process-group.json"));
  assert.ok(readOwnedProcessLedger(owner).some((entry) => entry.pid === member.pid &&
    exactOwnedProcessIdentity(entry).processIdentity === member.processIdentity), "Native Dure is not owned by this QA run");
  return { pid: member.pid, processIdentity: member.processIdentity, generation: descriptor.generation, channel };
}

export function observeRestartRuntime(discoveryRoot, hmuxCli) {
  const sessions = collectIsolatedHmuxCleanupTargets(discoveryRoot);
  for (const session of sessions) {
    assert.equal(session.lifecycle, "ready");
    for (const target of [session.hostProcess, session.providerProcess]) {
      const receipt = JSON.parse(execFileSync(hmuxCli, [
        "--discovery-root", discoveryRoot, "--json", "process", "probe", String(target.process_id), target.start_marker,
      ], { encoding: "utf8", timeout: 7_000, maxBuffer: 1024 * 1024 }));
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.status, "live");
      assert.equal(Number(receipt.process?.process_id), target.process_id);
      assert.equal(receipt.process?.start_marker, target.start_marker);
    }
  }
  return sessions;
}

export async function runPaneAppRestartQa({ proof }, io) {
  const report = { schemaVersion: 1, proof, result: "running", phase: "prepare" };
  try {
    const before = structuredClone(await io.receipt("pane-app-restart-before", proof));
    report.before = before;
    verifyWindow(before, proof, "prepared");
    const beforeIdentity = verifyBefore(before);
    const appBefore = structuredClone(await io.app());
    verifyNativeApp(appBefore);
    report.appBefore = structuredClone(appBefore);
    const runtimeBefore = structuredClone(await io.runtime());
    report.runtimeBefore = structuredClone(runtimeBefore);
    for (const target of before.fixture.terminals) {
      assert.equal(runtimeBefore.filter((session) => session.session_id === target.sessionId &&
        session.workspace_id === target.workspaceId && session.terminal_epoch === target.terminalEpoch &&
        session.sessionClass === target.sessionClass).length, 1);
    }
    for (const { paneId } of before.fixture.terminals) await io.pane(appBefore, paneId);
    const supervisor = await io.supervisor();
    report.phase = "restart";
    // One exact operation. The existing client reconciles a lost response;
    // an uncertain result never authorizes another restart request here.
    report.restart = await io.restart(supervisor);
    report.phase = "restore";
    const after = structuredClone(await io.receipt("pane-app-restart-after", proof));
    report.after = after;
    verifyWindow(after, proof, "observed");
    assert.notEqual(after.realm, before.realm, "WebView realm did not change");
    const afterIdentity = verifyPanePresentations(after.snapshot, before.fixture.terminals);
    assert.deepEqual(afterIdentity, beforeIdentity, "Restart changed pane IDs, targets, layout or selection");
    const appAfter = structuredClone(await io.app());
    verifyNativeApp(appAfter);
    assert.equal(appAfter.channel, appBefore.channel, "App channel changed across restart");
    report.appAfter = structuredClone(appAfter);
    assert.notEqual(appAfter.processIdentity, appBefore.processIdentity, "Only the WebView reloaded; native Dure did not restart");
    assert.notEqual(appAfter.generation, appBefore.generation, "Native backend generation did not change");
    await io.departed(appBefore);
    const runtimeAfter = await io.runtime();
    report.runtimeAfter = structuredClone(runtimeAfter);
    assert.deepEqual(runtimeAfter, runtimeBefore, "App restart created or replaced runtime generations");
    for (const { paneId } of before.fixture.terminals) await io.pane(appAfter, paneId);
    report.phase = "claims";
    report.claims = await io.claims({ proof, fixture: before.fixture, cases: after.claimCases, runtime: runtimeAfter });
    assert.equal(report.claims?.length, 8, "Native pane claim evidence is incomplete");
    report.runtimeAfterClaims = structuredClone(await io.runtime());
    assert.deepEqual(report.runtimeAfterClaims, runtimeBefore, "Pane content replacement changed runtime generations");
    report.phase = "complete";
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.error = error.message ?? String(error);
    if (error.restartRequestId) report.restartRequestId = error.restartRequestId;
  }
  await io.writeEvidence(report);
  return report;
}

async function main() {
  const stateRoot = realpathSync(process.env.DURE_QA_STATE_ROOT);
  const discoveryRoot = process.env.HMUX_DISCOVERY_ROOT;
  assertIsolatedCleanupBoundary(stateRoot, discoveryRoot);
  const home = realpathSync(process.env.HOME);
  assert.equal(home, join(stateRoot, "home"));
  assert.equal(process.env.DURE_HOME, join(home, ".dure"));
  const proof = process.env.DURE_QA_PANE_RESTART_PROOF;
  assert.match(proof, /^[a-f\d-]{36}$/);
  const channel = process.env.DURE_APP_CHANNEL;
  const root = realpathSync(process.cwd());
  const directory = appControlDirectory(home, channel);
  const post = (descriptor, path, body = {}) => requestAppControl({ descriptor, path, body, timeoutMs: 10_000 });
  const claimRowsPath = join(stateRoot, "evidence/pane-claim-rows.txt");
  const claimRows = () => {
    let contents;
    try { contents = readFileSync(claimRowsPath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    assert.ok(contents.length <= 16_384, "Pane claim execution evidence exceeded its bound");
    return contents.trimEnd().split("\n");
  };
  let currentDescriptor;
  const result = await runPaneAppRestartQa({ proof }, {
    receipt: (name, runProof) => waitForQaLogReceipt(name, runProof),
    async app() {
      const descriptor = loadAppControlDescriptor(directory);
      const identity = await observeRestartApp(descriptor, { channel, stateRoot });
      currentDescriptor = descriptor;
      return identity;
    },
    async pane(app, paneId) {
      assert.equal(currentDescriptor.processId, app.pid);
      assert.equal(currentDescriptor.generation, app.generation);
      const { pane } = await post(currentDescriptor, "/pane/state", { targetPanelId: paneId });
      assert.equal(pane.paneId, paneId);
      assert.equal(pane.status, "attached");
    },
    supervisor() {
      const { value } = readDescriptor({ home, channel, worktreeRoot: root });
      assert.equal(value.state, "ready");
      return value;
    },
    restart: (expectedAuthority) => requestDevLaunchRestart({ root, home, channel, expectedAuthority }),
    async departed(before) {
      const observed = await observeProcessMembers({ kind: "point", pids: [before.pid] });
      assert.equal(observed.status, "complete");
      assert.equal(observed.members.some(({ processIdentity, state }) =>
        processIdentity === before.processIdentity && state !== "zombie"), false, "Previous native Dure process survived restart");
    },
    runtime: () => observeRestartRuntime(discoveryRoot, process.env.DURE_QA_HMUX_CLI),
    claims: (options) => runPaneAppClaimQa(options, {
      input(marker) {
        const quotedPath = `'${claimRowsPath.replaceAll("'", "'\\''")}'`;
        return { text: `printf '%s:%s\\n' '${marker}' "$$" >> ${quotedPath}`, appendEnter: true };
      },
      act: (body, { discardResponse = false } = {}) => requestAppControl({
        descriptor: currentDescriptor, path: "/pane/act", body, timeoutMs: 10_000,
        ...(discardResponse ? { fetchImpl: async (...args) => {
          const response = await fetch(...args);
          await response.body?.cancel();
          throw new Error("QA discarded the native response body after headers");
        } } : {}),
      }),
      rows: claimRows,
      async waitForRow(row) {
        const deadline = Date.now() + 10_000;
        while (!claimRows().includes(row)) {
          assert.ok(Date.now() < deadline, `No native shell execution for ${row}`);
          await delay(25);
        }
      },
    }),
    writeEvidence: (report) => writeAtomicFile(join(stateRoot, "evidence/pane-app-restart.json"), `${JSON.stringify(report, null, 2)}\n`),
  });
  console.log(JSON.stringify({ result: result.result, phase: result.phase, error: result.error, proof }));
  process.exitCode = result.result === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
