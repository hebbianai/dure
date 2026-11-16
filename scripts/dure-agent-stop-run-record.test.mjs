import { describe, expect, it, vi } from "vitest";
import { appServerMissingReceipt, collectRunRecordStop, formatAgentStopReport, stopsRunRecord }
  from "../cli/lib/agent-stop-command.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";

const backend = { profile: { id: "local", transport: { kind: "local" } } };
const run = { agentId: "agent-scheduled-1", operationId: "spawn-scheduled-1", name: "nightly-review",
  providerId: "codex", workspaceId: "workspace-1", projectId: "dure", launchState: "succeeded",
  createdAtMs: 1, updatedAtMs: 1 };
const appReceipt = { ok: false, error: { code: "pane_not_found", message: "Hmux agent x was not found" } };

function stopResult(state, journalRevision, { agentId = run.agentId, disposition = "preserve" } = {}) {
  return { schemaVersion: 1, receipt: {
    plan: { schemaVersion: 1, operationId: "dispatch-stop-1", agentId, planToken: `sha256:${"a".repeat(64)}`,
      spawn: { operationId: run.operationId },
      ...(disposition === "preserve" ? { workspaceDisposition: "preserve" } : { ownedCheckout: {} }) },
    state, journalRevision, createdAtMs: 1, updatedAtMs: 1 } };
}

function staleStopConflict() {
  return new BackendTransportError("backend_transport_remote_error",
    { details: { code: "agent_dispatch_stop_conflict", disposition: "stale_generation" } });
}

function stopWith(results, runs = [run]) {
  const requestBackend = vi.fn(async (_profile, request) => {
    if (request.operation === "agent_spawn.list") return { result: { schemaVersion: 1, runs, nextCursor: null } };
    const result = results[request.operation];
    if (!result) throw new Error(`Unexpected operation: ${request.operation}`);
    return { result: typeof result === "function" ? result(request.body) : result };
  });
  const operations = () => requestBackend.mock.calls.map(([, request]) => request.operation);
  const bodies = () => requestBackend.mock.calls.map(([, request]) => request.body);
  return { requestBackend, operations, bodies,
    stop: (selector = run.agentId) => collectRunRecordStop({ selector, appReceipt,
      resolveBackend: async () => backend, requestBackend }) };
}

describe("stopping a Run the app has not opened", () => {
  it("continues only after the app reports no Agent for an exact Agent selector", () => {
    const options = { rest: ["stop", "agent-scheduled-1"] };
    expect(stopsRunRecord(appReceipt, options)).toBe(true);
    expect(stopsRunRecord(appReceipt, { rest: ["stop"], name: "nightly-review" })).toBe(true);
    expect(stopsRunRecord({ ok: false, error: { code: "pane_ambiguous" } }, options)).toBe(false);
    expect(stopsRunRecord({ ok: false, error: { code: "hmux_managed_stop_failed" } }, options)).toBe(false);
    expect(stopsRunRecord(appReceipt, { ...options, targetPanelId: "pane-1" })).toBe(false);
    expect(stopsRunRecord(appReceipt, { rest: ["stop", "project/worker"] })).toBe(false);
    expect(stopsRunRecord(null, options)).toBe(false);
  });

  it("continues on a host without the app only for a selector a Run record can match", () => {
    const options = { rest: ["stop", "agent-scheduled-1"] };
    expect(stopsRunRecord(appServerMissingReceipt(), options)).toBe(true);
    expect(stopsRunRecord(appServerMissingReceipt(), { rest: ["stop"], name: "nightly-review" })).toBe(true);
    expect(stopsRunRecord(appServerMissingReceipt(), { rest: ["stop", "project/worker"] })).toBe(false);
    expect(stopsRunRecord(appServerMissingReceipt(), { ...options, targetPanelId: "pane-1" })).toBe(false);
  });

  it("resumes an authorized stop at its recorded revision without planning another", async () => {
    const f = stopWith({
      "dispatch.stop.status": stopResult({ status: "authorized", runtimeCloseOperationId: "close-1" }, 2),
      "dispatch.stop.apply": stopResult({ status: "workspace_preserved", runtime: {} }, 3),
    });
    const report = await f.stop();
    expect(report).toMatchObject({ ok: true, agent: { id: run.agentId, name: run.name },
      dispatchStop: { status: "workspace_preserved" } });
    expect(f.operations()).toEqual(["agent_spawn.list", "dispatch.stop.status", "dispatch.stop.apply"]);
    expect(f.requestBackend.mock.calls.at(-1)[1].body).toEqual({ schemaVersion: 1, operationId: "dispatch-stop-1",
      planToken: `sha256:${"a".repeat(64)}`, expectedJournalRevision: 1 });
  });

  it("reports an already stopped Run without another mutation", async () => {
    const f = stopWith({ "dispatch.stop.status": stopResult({ status: "workspace_preserved", runtime: {} }, 3) });
    expect(await f.stop()).toMatchObject({ ok: true, dispatchStop: { status: "workspace_preserved" } });
    expect(f.operations()).toEqual(["agent_spawn.list", "dispatch.stop.status"]);
  });

  it("refuses a shared Run name with each exact stop command and stops nothing", async () => {
    const second = { ...run, agentId: "agent-scheduled-2", operationId: "spawn-scheduled-2" };
    const f = stopWith({}, [run, second]);
    const report = await f.stop("nightly-review");
    expect(report).toMatchObject({ ok: false, error: { code: "run_selector_ambiguous", candidates: [
      { agentId: run.agentId, retry: ["stop", run.agentId, "--yes"] },
      { agentId: second.agentId, retry: ["stop", second.agentId, "--yes"] },
    ] } });
    expect(f.operations()).toEqual(["agent_spawn.list"]);
    expect(formatAgentStopReport({ ...report, apiVersion: "dure.agent-stop/v1" }, "nightly-review"))
      .toContain("dure 'stop' 'agent-scheduled-2' '--yes'");
  });

  it("returns the app's answer when the backend has no Run record either", async () => {
    const f = stopWith({}, []);
    expect(await f.stop("ghost")).toBe(appReceipt);
  });

  it("fails with the receipt when the backend retains the runtime", async () => {
    const f = stopWith({
      "dispatch.stop.status": { schemaVersion: 1, receipt: null },
      "dispatch.stop.preview": stopResult({ status: "planned" }, 1),
      "dispatch.stop.apply": stopResult({ status: "source_retained", runtime: {} }, 3),
    });
    expect(await f.stop()).toMatchObject({ ok: false, error: { code: "agent_dispatch_stop_source_retained" },
      dispatchStop: { status: "source_retained" }, agent: { id: run.agentId } });
  });

  it("leaves a stop that removes the workspace to its original cleanup flow", async () => {
    const f = stopWith({ "dispatch.stop.status": stopResult({ status: "authorized",
      runtimeCloseOperationId: "close-1" }, 2, { disposition: "remove_owned" }) });
    expect(await f.stop()).toMatchObject({ ok: false, error: { code: "agent_dispatch_stop_failed" } });
    expect(f.operations()).toEqual(["agent_spawn.list", "dispatch.stop.status"]);
  });

  it("re-plans a saved stop the backend refuses because the Agent's runtime moved on", async () => {
    const stale = stopResult({ status: "planned" }, 1);
    const fresh = stopResult({ status: "planned" }, 1);
    fresh.receipt.plan = { ...fresh.receipt.plan, operationId: "dispatch-stop-2", planToken: `sha256:${"b".repeat(64)}` };
    const preserved = structuredClone(fresh);
    preserved.receipt.state = { status: "workspace_preserved", runtime: {} };
    preserved.receipt.journalRevision = 3;
    const f = stopWith({
      "dispatch.stop.status": stale,
      "dispatch.stop.preview": fresh,
      "dispatch.stop.apply": (body) => {
        if (body.operationId === "dispatch-stop-1") throw staleStopConflict();
        return preserved;
      },
    });
    expect(await f.stop()).toMatchObject({ ok: true, agent: { id: run.agentId },
      dispatchStop: { operationId: "dispatch-stop-2", status: "workspace_preserved" } });
    expect(f.operations()).toEqual(["agent_spawn.list", "dispatch.stop.status", "dispatch.stop.apply",
      "dispatch.stop.preview", "dispatch.stop.apply"]);
    expect(f.bodies().at(-1)).toEqual({ schemaVersion: 1, operationId: "dispatch-stop-2",
      planToken: `sha256:${"b".repeat(64)}`, expectedJournalRevision: 1 });
  });

  it("reports a stale refusal of its own fresh plan without planning again", async () => {
    const f = stopWith({
      "dispatch.stop.status": { schemaVersion: 1, receipt: null },
      "dispatch.stop.preview": stopResult({ status: "planned" }, 1),
      "dispatch.stop.apply": () => { throw staleStopConflict(); },
    });
    expect(await f.stop()).toMatchObject({ ok: false, agent: { id: run.agentId },
      error: { remoteCode: "agent_dispatch_stop_conflict", disposition: "stale_generation" } });
    expect(f.operations()).toEqual(["agent_spawn.list", "dispatch.stop.status", "dispatch.stop.preview",
      "dispatch.stop.apply"]);
  });

  it("never re-plans an authorized stop the backend refuses", async () => {
    const f = stopWith({
      "dispatch.stop.status": stopResult({ status: "authorized", runtimeCloseOperationId: "close-1" }, 2),
      "dispatch.stop.apply": () => { throw staleStopConflict(); },
    });
    expect(await f.stop()).toMatchObject({ ok: false, error: { remoteCode: "agent_dispatch_stop_conflict" } });
    expect(f.operations()).toEqual(["agent_spawn.list", "dispatch.stop.status", "dispatch.stop.apply"]);
  });

  it("refuses a receipt for another Agent before applying it", async () => {
    const f = stopWith({
      "dispatch.stop.status": { schemaVersion: 1, receipt: null },
      "dispatch.stop.preview": stopResult({ status: "planned" }, 1, { agentId: "agent-other" }),
    });
    expect(await f.stop()).toMatchObject({ ok: false, error: { code: "agent_dispatch_stop_response_invalid" } });
    expect(f.operations()).not.toContain("dispatch.stop.apply");
  });
});
