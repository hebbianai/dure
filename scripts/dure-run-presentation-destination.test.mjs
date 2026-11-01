import { describe, expect, it, vi } from "vitest";
import {
  managedRunPresentationRequest,
  presentAgentRunRuntime,
  registerAgentRunInBackground,
  runReceiptSummary,
  structuredRunPresentationRequest,
} from "../cli/lib/run-presentation.mjs";
import {
  adoptExistingCheckout,
  succeededNativeReceipt,
  succeededStructuredReceipt,
} from "./fixtures/agent-spawn-receipts.mjs";

describe.each([
  ["native", succeededNativeReceipt, managedRunPresentationRequest],
  ["structured", succeededStructuredReceipt, structuredRunPresentationRequest],
])("%s Run destination projection", (_name, makeReceipt, project) => {
  const options = (receipt) => ({
    report: { kind: "dure.agent_spawn.apply", receipt },
    target: { state: "requested", spaceId: "space-a", windowLabel: "main" },
    profile: { id: "local", transport: { kind: "local" } },
    projectPath: "/repo",
  });

  function presentation(receipt, changes = {}) {
    const input = options(receipt);
    const expected = project(input);
    const pane = {
      spaceId: expected.spaceId,
      panelId: `agent:${expected.agentId}`,
      agentId: expected.agentId,
      outcome: "created",
      ...(_name === "native"
        ? {
            runtime: expected.runtime,
            sessionId: expected.sessionId,
            workspaceId: expected.workspaceId,
          }
        : {
            interactionProfile: expected.interactionProfile,
            interactionSessionId: expected.interactionSessionId,
          }),
      ...changes,
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, pane }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    return {
      pane,
      fetchImpl,
      run: () =>
        presentAgentRunRuntime({
          ...input,
          descriptor: {
            port: 42,
            token: "fixture-token",
            channel: "stable",
            generation: "fixture-generation",
            buildId: "0.2.16+fixture",
          },
          fetchImpl,
        }),
    };
  }

  it.each(["slot", "pane-neutral", "launcher:previous", "term:previous", "agent:previous"])(
    "reports the client's actual pane %s without deriving its ID from the Agent",
    async (panelId) => {
      for (const outcome of ["created", "reused"]) {
        const fixture = presentation(makeReceipt(), { panelId, outcome });
        await expect(fixture.run()).resolves.toMatchObject({
          state: "opened",
          pane: fixture.pane,
        });
        expect(fixture.fetchImpl).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    "spaceId",
    "agentId",
    ...(_name === "native"
      ? ["sessionId", "workspaceId"]
      : ["interactionSessionId"]),
  ])(
    "does not accept a different %s behind a plausible pane ID",
    async (field) => {
      const fixture = presentation(makeReceipt(), { [field]: "wrong-target" });
      await expect(fixture.run()).rejects.toMatchObject({ code: "client_response_invalid" });
      expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("sends the backend's actual checkout root to the client", () => {
    const receipt = makeReceipt();
    receipt.plan.request.worktree.checkout_path = "/selected/work/codex-1";
    receipt.plan.request.worktree.branch_mode = "existing";
    receipt.checkoutRegistration = {
      repositoryPath: "/repo",
      instance: {
        schemaVersion: 1,
        canonicalPath: "/canonical/work/codex-1",
        gitCommonDir: "/repo/.git",
        gitDir: "/repo/.git/worktrees/codex-1",
        instanceToken: `dwt1_${"a".repeat(32)}`,
      },
    };
    const outgoing = project(options(receipt));
    const expected = {
      kind: "dedicated",
      branch: "agent/codex-1",
      directoryName: "codex-1",
      rootPath: "/canonical/work/codex-1",
    };
    expect(outgoing.worktree).toEqual(expected);
  });

  it("keeps legacy default receipts usable without inventing a root", () => {
    expect(project(options(makeReceipt())).worktree).toEqual({
      kind: "dedicated",
      branch: "agent/codex-1",
      directoryName: "codex-1",
    });
  });

  it("presents a selected checkout without a source Agent or a derived directory", () => {
    const value = adoptExistingCheckout(makeReceipt());
    expect(project(options(value)).worktree).toEqual({
      kind: "existing_checkout", branch: "user/work", rootPath: "/repo/preexisting-checkout",
    });
    value.checkoutRegistration = { ...value.checkoutRegistration,
      instance: { ...value.checkoutRegistration.instance, instanceToken: `dwt1_${"b".repeat(32)}` } };
    expect(() => project(options(value))).toThrowError(
      expect.objectContaining({ code: "client_run_receipt_invalid" }),
    );
  });

  it("does not apply new-branch naming limits to an already selected checkout", () => {
    const value = adoptExistingCheckout(makeReceipt());
    const branch = `${"a".repeat(128)}/${"b".repeat(128)}`;
    value.plan.request.worktree.branch = branch;
    expect(project(options(value)).worktree).toEqual({
      kind: "existing_checkout", branch, rootPath: "/repo/preexisting-checkout",
    });
  });

  it("does not substitute the default location for a missing explicit result", () => {
    const receipt = makeReceipt();
    receipt.plan.request.worktree.checkout_path = "/selected/work/codex-1";
    expect(() => project(options(receipt))).toThrowError(
      expect.objectContaining({ code: "client_run_receipt_invalid" }),
    );
  });
});

it("registers a background structured Run without requesting a pane or Space", async () => {
  const receipt = succeededStructuredReceipt();
  const fetchImpl = vi.fn(async (_url, request) => {
    const body = JSON.parse(request.body);
    expect(body.presentation).toBe("background");
    expect(body.spaceId).toBeUndefined();
    return new Response(JSON.stringify({
      ok: true,
      agent: { agentId: body.agentId, interactionSessionId: body.interactionSessionId },
    }));
  });
  await expect(presentAgentRunRuntime({
    report: { kind: "dure.agent_spawn.apply", receipt },
    target: { state: "background", windowLabel: "main" },
    profile: { id: "local", transport: { kind: "local" } },
    projectPath: "/repo",
    descriptor: { port: 42, token: "fixture", channel: "stable", generation: "fixture", buildId: "fixture" },
    fetchImpl,
  })).resolves.toMatchObject({ state: "background", agent: { agentId: receipt.plan.agentId } });
  expect(fetchImpl).toHaveBeenCalledOnce();
});


describe("native Run background registration", () => {
  it("registers one exact runtime without selecting a Space or opening a pane", async () => {
    const receipt = succeededNativeReceipt();
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body).not.toHaveProperty("spaceId");
      expect(body).not.toHaveProperty("windowLabel");
      return new Response(JSON.stringify({ok:true,agent:{agentId:body.agentId,sessionId:body.sessionId}}));
    });
    const result = await registerAgentRunInBackground({report:{kind:"dure.agent_spawn.apply",receipt},
      profile:{id:"local",transport:{kind:"local"}},projectPath:"/repo",
      descriptor:{port:42,token:"fixture",capabilities:["agent.run_background_v1"]},fetchImpl});
    expect(result).toMatchObject({state:"registered",agentId:receipt.plan.agentId});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("keeps headless no-client and remote launches independent of local registration", async () => {
    const fetchImpl=vi.fn();
    expect(await registerAgentRunInBackground({profile:{transport:{kind:"ssh"}},descriptor:{capabilities:["agent.run_background_v1"]},fetchImpl})).toBeUndefined();
    expect(await registerAgentRunInBackground({profile:{transport:{kind:"local"}},fetchImpl})).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Run receipt summary", () => {
  const nativeReport = () => ({ kind: "dure.agent_spawn.apply", receipt: succeededNativeReceipt() });
  const launchedSession = (receipt) =>
    receipt.completed.find((stage) => stage.stage === "runtime_launch").evidence.session.sessionId;

  it("leads with the launched session and the opened pane for a verified native Run", () => {
    const report = nativeReport();
    const presentation = { state: "opened", pane: { spaceId: "space-a", panelId: "agent:pane-1", agentId: report.receipt.plan.agentId } };
    expect(runReceiptSummary(report, presentation)).toEqual({
      agentId: report.receipt.plan.agentId,
      sessionId: launchedSession(report.receipt),
      workspaceId: report.receipt.plan.workspaceId,
      panelId: "agent:pane-1",
      spaceId: "space-a",
      state: "succeeded",
      presentation: "opened",
      interactionProfile: "native_cli",
    });
  });

  it("reports the runtime's actual session, not the planned one, when the launch landed elsewhere", () => {
    const receipt = succeededNativeReceipt({ sessionId: "session-relaunched", launchIdempotencyKey: "spawn-runtime:relaunch-1" });
    expect(receipt.plan.launch.sessionId).not.toBe("session-relaunched");
    expect(runReceiptSummary({ kind: "dure.agent_spawn.apply", receipt }).sessionId).toBe("session-relaunched");
  });

  it("leaves pane fields null for a headless Run and session null for a structured Run", () => {
    const headless = runReceiptSummary(nativeReport(), { state: "headless", reason: "no_client" });
    expect(headless).toMatchObject({ panelId: null, spaceId: null, presentation: "headless", state: "succeeded" });
    const structured = runReceiptSummary(
      { kind: "dure.agent_spawn.apply", receipt: succeededStructuredReceipt() },
      { state: "background", agent: { agentId: "agent-x" } },
    );
    expect(structured).toMatchObject({ sessionId: null, interactionProfile: "structured_protocol", presentation: "background", panelId: null });
    expect(structured.agentId).toBeTruthy();
  });

  it("falls back to the plan for an unverified receipt and to null for a backend error", () => {
    const report = nativeReport();
    report.receipt.state = "applying";
    report.receipt.completed = [];
    expect(runReceiptSummary(report)).toEqual({
      agentId: report.receipt.plan.agentId,
      sessionId: report.receipt.plan.launch.sessionId,
      workspaceId: report.receipt.plan.workspaceId,
      panelId: null,
      spaceId: null,
      state: "applying",
      presentation: null,
      interactionProfile: "native_cli",
    });
    expect(runReceiptSummary({ kind: "dure.agent_spawn.error", error: { code: "x" } })).toEqual({
      agentId: null, sessionId: null, workspaceId: null, panelId: null, spaceId: null,
      state: null, presentation: null, interactionProfile: null,
    });
  });
});
