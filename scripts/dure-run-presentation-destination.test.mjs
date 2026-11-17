import { describe, expect, it, vi } from "vitest";
import {
  RUN_PARENT_PRESENTATION_CAPABILITY,
  RUN_START_ORDER_PRESENTATION_CAPABILITY,
  managedRunPresentationRequest,
  presentAgentRunRuntime,
  registerAgentRunInBackground,
  runReceiptSummary,
  structuredRunPresentationRequest,
} from "../cli/lib/run-presentation.mjs";
import {
  adoptExistingCheckout,
  loginGatedNativeReceipt,
  succeededNativeReceipt,
  succeededStructuredReceipt,
  trustGatedNativeReceipt,
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

  it("sends the Run's parent Session only to an app that accepts it", () => {
    const receipt = makeReceipt();
    const parent = { sessionId: "session-lead", workspaceId: "workspace-lead" };
    receipt.plan.request.parent = parent;
    const accepting = { capabilities: [RUN_PARENT_PRESENTATION_CAPABILITY] };
    expect(project({ ...options(receipt), descriptor: accepting }).parent).toEqual(parent);
    // An older app rejects unknown request keys, so it never sees one.
    expect("parent" in project({ ...options(receipt), descriptor: { capabilities: [] } })).toBe(false);
    expect("parent" in project(options(receipt))).toBe(false);
    expect("parent" in project({ ...options(makeReceipt()), descriptor: accepting })).toBe(false);
  });

  it("sends the Run's start time only to an app that orders workers by it", () => {
    const receipt = makeReceipt();
    const accepting = { capabilities: [RUN_START_ORDER_PRESENTATION_CAPABILITY] };
    expect(project({ ...options(receipt), descriptor: accepting }).startedAtMs).toBe(
      receipt.createdAtMs,
    );
    // An older app rejects unknown request keys, so it never sees one.
    expect("startedAtMs" in project({ ...options(receipt), descriptor: { capabilities: [] } })).toBe(false);
    expect("startedAtMs" in project(options(receipt))).toBe(false);
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
      parent: null,
      startupGate: null,
      error: null,
    });
  });

  it("names the first-run screen a Run is stopped at, so the head says why the prompt is undelivered", () => {
    // A Codex account whose login expired: Codex sits on its sign-in screen
    // and the carried prompt waits behind it (#583).
    const login = runReceiptSummary({ kind: "dure.agent_spawn.apply", receipt: loginGatedNativeReceipt() });
    expect(login).toMatchObject({ state: "prompt_delivery_uncertain", startupGate: "login" });
    const trust = runReceiptSummary({ kind: "dure.agent_spawn.apply", receipt: trustGatedNativeReceipt() });
    expect(trust).toMatchObject({ state: "prompt_delivery_uncertain", startupGate: "workspace_trust" });

    // A gate answered before the prompt went in no longer holds the Run up.
    const answered = succeededNativeReceipt();
    answered.completed[1].evidence.startup_gate = { kind: "workspace_trust", launch_prompt_carried: false };
    expect(runReceiptSummary({ kind: "dure.agent_spawn.apply", receipt: answered }).startupGate).toBeNull();

    // An unknown gate kind is not vouched for.
    const unknown = loginGatedNativeReceipt();
    unknown.completed[1].evidence.startup_gate.kind = "Not A Token!";
    expect(runReceiptSummary({ kind: "dure.agent_spawn.apply", receipt: unknown }).startupGate).toBeNull();
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
      parent: null,
      startupGate: null,
      error: null,
    });
    expect(runReceiptSummary({ kind: "dure.agent_spawn.error", error: { code: "x" } })).toEqual({
      agentId: null, sessionId: null, workspaceId: null, panelId: null, spaceId: null,
      state: null, presentation: null, interactionProfile: null, parent: null, startupGate: null, error: null,
    });
  });

  it("says why a Run stopped short: the failed stage, its code and its detail", () => {
    const report = nativeReport();
    report.receipt.state = "retry_required";
    report.receipt.completed = [];
    report.receipt.recovery = {
      kind: "retry_required",
      stage: "worktree",
      failed_attempt: 1,
      error_code: "workspace_identity_conflict",
      error_detail: "branch agent/codex-1 already exists",
      inputs: { stage: "worktree" },
    };
    expect(runReceiptSummary(report)).toMatchObject({
      state: "retry_required",
      error: { stage: "worktree", code: "workspace_identity_conflict", detail: "branch agent/codex-1 already exists" },
    });
    delete report.receipt.recovery.error_detail;
    expect(runReceiptSummary(report).error).toEqual({ stage: "worktree", code: "workspace_identity_conflict", detail: null });

    report.receipt.state = "prompt_delivery_uncertain";
    report.receipt.recovery = {
      kind: "do_not_replay_prompt", attempt: 1, error_code: "prompt_delivery_timeout",
      inputs: { stage: "prompt_delivery" },
    };
    expect(runReceiptSummary(report).error).toEqual({ stage: "prompt_delivery", code: "prompt_delivery_timeout", detail: null });

    report.receipt.state = "failed";
    report.receipt.recovery = { kind: "none" };
    report.receipt.terminalCode = "agent_spawn_runtime_launch_failed";
    expect(runReceiptSummary(report).error).toEqual({ stage: null, code: "agent_spawn_runtime_launch_failed", detail: null });
  });
});
