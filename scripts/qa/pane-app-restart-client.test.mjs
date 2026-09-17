import assert from "node:assert/strict";
import { test } from "vitest";
import { runPaneAppRestartQa } from "./pane-app-restart-client.mjs";

const proof = "019ff6b1-7ae2-7712-b159-e1c6ba4a473f";
const clone = structuredClone;
function fixture(shellClass = "standalone") {
  const spaceId = "space-owned";
  const ids = ["pane-converted", `launcher:${proof}`, "pane-terminal"];
  const terminals = ids.map((paneId, index) => ({
    paneId, sessionId: `session-${index}`, workspaceId: "runtime-workspace", terminalEpoch: `epoch-${index}`,
    sessionClass: index < 2 ? shellClass : "standalone",
  }));
  const panes = terminals.map(({ paneId, sessionId, workspaceId, sessionClass, terminalEpoch }) => ({
    id: paneId, component: "terminal", params: {
      binding: {
        schemaVersion: 1, runtime: `hmux_${sessionClass}_v1`, source: "local", hostId: "local", sessionId, workspaceId,
        ...(sessionClass === "managed" ? { createIdempotencyKey: `create-${sessionId}`, stopFence: {
          runnerPrincipal: "fixture", runnerInstance: "runner", channelEpoch: "1", hostInstanceId: `host-${sessionId}`, terminalEpoch,
        } } : {}),
      },
    },
  }));
  panes.push({ id: "pane-launcher", component: "launcher", params: {} });
  const layout = {
    panels: Object.fromEntries(panes.map((pane) => [pane.id, clone(pane)])),
    grid: { orientation: "HORIZONTAL", root: { type: "branch", data: panes.map(({ id }) => ({ type: "leaf", data: { views: [id], activeView: id } })) } },
  };
  const snapshot = {
    spaceId, activeSpaceId: spaceId, activePaneId: ids[0], panes,
    layout, durableLayout: clone(layout),
    sessions: terminals.map((terminal) => ({ ...terminal, lifecycle: "ready", health: "current_healthy" })),
    presentations: terminals.map(({ paneId, terminalEpoch }) => ({
      paneId, state: "live", terminalEpoch, receivedSequence: "0", presentedSequence: "0",
    })),
  };
  const before = {
    proof, realm: "00000000-0000-4000-8000-000000000001", windowLabel: "main", userAgent: "Native AppleWebKit/605.1",
    schemaVersion: 1, phase: "prepared", status: "prepared",
    fixture: { spaceId, convertedPaneId: ids[0], legacyPaneId: ids[1], launcherPaneId: "pane-launcher", terminals },
    snapshot,
  };
  const after = { proof, realm: "00000000-0000-4000-8000-000000000002", windowLabel: "main", userAgent: before.userAgent, status: "observed", snapshot: clone(snapshot) };
  const native = [
    { pid: 101, processIdentity: "native-process-1", generation: "native-generation-1", channel: "qa-owned" },
    { pid: 102, processIdentity: "native-process-2", generation: "native-generation-2", channel: "qa-owned" },
  ];
  const runtime = terminals.map(({ sessionId, workspaceId, terminalEpoch, sessionClass }, index) => ({
    session_id: sessionId, workspace_id: workspaceId, terminal_epoch: terminalEpoch,
    sessionClass,
    lifecycle: "ready", host_instance_id: `host-${index}`,
    hostProcess: { process_id: 200 + index, start_marker: `host-generation-${index}` },
    providerProcess: { process_id: 300 + index, start_marker: `provider-generation-${index}` },
  }));
  const calls = [];
  const evidence = [];
  let appIndex = 0;
  const io = {
    async receipt(name, runProof) {
      calls.push(["receipt", name, runProof]);
      return name.endsWith("before") ? before : after;
    },
    async app() { calls.push(["app"]); return native[appIndex++]; },
    async runtime() { calls.push(["runtime"]); return runtime; },
    async pane(app, paneId) { calls.push(["pane", clone(app), paneId]); },
    async supervisor() { calls.push(["supervisor"]); return { exact: "owned-supervisor" }; },
    async restart(authority) { calls.push(["restart", authority]); return { requestId: "same-request", previousLaunch: "old", launch: "new" }; },
    async departed(app) { calls.push(["departed", clone(app)]); },
    async claims(options) {
      calls.push(["claims", clone(options)]);
      return Array.from({ length: 8 }, (_, index) => ({ fixtureObservation: index }));
    },
    async writeEvidence(report) { evidence.push(clone(report)); },
  };
  return { before, after, native, runtime, io, calls, evidence };
}
async function run(f) {
  const report = await runPaneAppRestartQa({ proof }, f.io);
  assert.deepEqual(f.evidence, [report], "Retained evidence must match the returned outcome");
  return report;
}
const restartCalls = (f) => f.calls.filter(([name]) => name === "restart");

test("one full restart preserves neutral/legacy targets, layout, selection and runtime", async () => {
  const f = fixture();
  const result = await run(f);
  assert.equal(result.result, "passed", result.error);
  assert.equal(result.phase, "complete");
  assert.deepEqual(restartCalls(f), [["restart", { exact: "owned-supervisor" }]]);
  assert.deepEqual(f.calls.filter(([name]) => name === "departed"), [["departed", f.native[0]]]);
  assert.deepEqual(f.calls.filter(([name]) => name === "pane").map(([, app, pane]) => [app.pid, pane]),
    [101, 102].flatMap((pid) => f.before.fixture.terminals.map(({ paneId }) => [pid, paneId])));
});

test("does not certify a restart when native claim verification fails", async () => {
  const f = fixture();
  f.io.claims = async () => { throw new Error("Wrong native command recipient"); };
  const result = await run(f);
  assert.equal(result.result, "failed");
  assert.equal(result.phase, "claims");
  assert.match(result.error, /Wrong native command recipient/);
  assert.equal(restartCalls(f).length, 1);
});

test("does not certify missing claim evidence or replacement runtime generations", async () => {
  for (const missingEvidence of [true, false]) {
    const f = fixture();
    f.io.claims = async () => {
      if (missingEvidence) return undefined;
      f.runtime[0].providerProcess.start_marker = "replaced-by-pane-action";
      return Array.from({ length: 8 }, () => ({}));
    };
    const result = await run(f);
    assert.equal(result.result, "failed");
    assert.equal(result.phase, "claims");
    assert.equal(restartCalls(f).length, 1);
  }
});

test("preserves the ordinary managed-shell choice alongside an explicit standalone terminal", async () => {
  const result = await run(fixture("managed"));
  assert.equal(result.result, "passed", result.error);
  assert.deepEqual(result.before.fixture.terminals.map(({ sessionClass }) => sessionClass), ["managed", "managed", "standalone"]);
});

test("accepts advancing terminal frames while the restarted pane and runtime remain identical", async () => {
  const f = fixture();
  f.after.snapshot.presentations[0].receivedSequence = "12";
  f.after.snapshot.presentations[0].presentedSequence = "10";
  const result = await run(f);
  assert.equal(result.result, "passed", result.error);
  assert.equal(restartCalls(f).length, 1);
});

for (const [name, change] of [
  ["missing presentation evidence", (snapshot) => { delete snapshot.presentations; }],
  ["missing presentation", (snapshot) => { snapshot.presentations.pop(); }],
  ["unpainted frame", (snapshot) => { delete snapshot.presentations[0].presentedSequence; }],
  ["wrong pane", (snapshot) => { snapshot.presentations[0].paneId = "another-pane"; }],
  ["different epoch", (snapshot) => { snapshot.presentations[0].terminalEpoch = "another-epoch"; }],
  ["disconnected presentation", (snapshot) => { snapshot.presentations[0].state = "recovering"; }],
]) {
  test(`does not restart with ${name} despite healthy runtime manifests`, async () => {
    const f = fixture();
    change(f.before.snapshot);
    f.after.snapshot = clone(f.before.snapshot);
    const result = await run(f);
    assert.equal(result.result, "failed");
    assert.equal(restartCalls(f).length, 0);
  });
  test(`does not certify restored ${name} despite healthy runtime manifests`, async () => {
    const f = fixture();
    change(f.after.snapshot);
    const result = await run(f);
    assert.equal(result.result, "failed");
    assert.equal(restartCalls(f).length, 1);
  });
}

for (const [name, change] of [
  ["missing create receipt", (f) => { delete f.before.snapshot.panes[0].params.binding.createIdempotencyKey; }],
  ["missing exact fence", (f) => { delete f.before.snapshot.panes[0].params.binding.stopFence; }],
  ["changed exact fence", (f) => { f.before.snapshot.panes[0].params.binding.stopFence.terminalEpoch = "replacement"; }],
  ["different binding class", (f) => { f.before.snapshot.panes[0].params.binding.runtime = "hmux_standalone_v1"; }],
  ["different native class", (f) => { f.runtime[0].sessionClass = "standalone"; }],
]) test(`does not restart a managed shell with ${name}`, async () => {
  const f = fixture("managed");
  change(f);
  const result = await run(f);
  assert.equal(result.result, "failed");
  assert.equal(restartCalls(f).length, 0);
});

test("does not certify a changed managed binding after restart", async () => {
  const f = fixture("managed");
  f.after.snapshot.panes[0].params.binding.stopFence.hostInstanceId = "replacement";
  const result = await run(f);
  assert.equal(result.result, "failed");
  assert.equal(restartCalls(f).length, 1);
});

for (const [name, change] of [
  ["wrong proof", (f) => { f.before.proof = "other"; }],
  ["failed preparation", (f) => { f.before.status = "failed"; f.before.error = "document checkpoint failed"; }],
  ["browser fixture", (f) => { f.before.userAgent += " Chromium"; }],
  ["missing durable layout", (f) => { delete f.before.snapshot.durableLayout; }],
  ["invalid legacy explicit reference", (f) => { f.before.snapshot.panes[1].params.binding.sessionId = "wrong"; }],
  ["missing native generation", (f) => { delete f.native[0].generation; }],
]) test(`does not restart after ${name}`, async () => {
  const f = fixture();
  change(f);
  const result = await run(f);
  assert.equal(result.result, "failed");
  assert.equal(restartCalls(f).length, 0);
});

for (const [name, change] of [
  ["same WebView realm", (f) => { f.after.realm = f.before.realm; }],
  ["native process unchanged", (f) => { f.native[1].processIdentity = f.native[0].processIdentity; }],
  ["backend generation unchanged", (f) => { f.native[1].generation = f.native[0].generation; }],
  ["pane removed", (f) => { f.after.snapshot.panes.pop(); }],
  ["pane retargeted", (f) => { f.after.snapshot.panes[1].params.binding.sessionId = "replacement"; }],
  ["launcher auto-started", (f) => { f.after.snapshot.panes[3].component = "terminal"; }],
  ["layout changed", (f) => { f.after.snapshot.layout.grid.root.data.reverse(); }],
  ["active pane changed", (f) => { f.after.snapshot.activePaneId = "pane-terminal"; }],
  ["failed restoration", (f) => { f.after.status = "failed"; f.after.error = "saved layout unavailable"; }],
  ["previous native generation remains live", (f) => { f.io.departed = async () => { throw new Error("predecessor still live"); }; }],
]) test(`retains failure without another restart after ${name}`, async () => {
  const f = fixture();
  change(f);
  const result = await run(f);
  assert.equal(result.result, "failed");
  assert.equal(restartCalls(f).length, 1);
});

test("a shared runtime observation cannot rewrite the before evidence", async () => {
  const f = fixture();
  let reads = 0;
  f.io.runtime = async () => {
    if (reads++ === 1) f.runtime[0].providerProcess.start_marker = "replacement-generation";
    return f.runtime;
  };
  const result = await run(f);
  assert.equal(result.result, "failed");
  assert.equal(result.runtimeBefore[0].providerProcess.start_marker, "provider-generation-0");
  assert.equal(restartCalls(f).length, 1);
});

test("uncertain restart keeps the admitted request identity without resubmitting", async () => {
  const f = fixture();
  f.io.restart = async (authority) => {
    f.calls.push(["restart", authority]);
    const error = new Error("response lost after restart admission");
    error.restartRequestId = "admitted-request";
    throw error;
  };
  const result = await run(f);
  assert.equal(result.result, "failed");
  assert.equal(result.phase, "restart");
  assert.equal(result.restartRequestId, "admitted-request");
  assert.equal(restartCalls(f).length, 1);
  assert.equal(f.calls.filter(([name]) => name === "app").length, 1);
});

test("a delayed restored snapshot stays on the same restart operation", async () => {
  const f = fixture();
  let deliver;
  const delivered = new Promise((resolve) => { deliver = resolve; });
  let waiting;
  const reached = new Promise((resolve) => { waiting = resolve; });
  f.io.receipt = async (name) => {
    if (name.endsWith("before")) return f.before;
    waiting();
    return delivered;
  };
  const pending = run(f);
  await reached;
  assert.equal(restartCalls(f).length, 1);
  assert.equal(f.evidence.length, 0);
  deliver(f.after);
  const result = await pending;
  assert.equal(result.result, "passed", result.error);
  assert.equal(restartCalls(f).length, 1);
});
