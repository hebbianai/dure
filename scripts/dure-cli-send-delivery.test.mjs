import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOpts } from "../cli/lib/cli-options.mjs";
import { runSendCommand } from "../cli/lib/send-command.mjs";
import { recordedSendDelivery, sendTargetDelivery } from "../cli/lib/send-delivery.mjs";

afterEach(() => vi.restoreAllMocks());

const agent = { id: "agent-1", name: "worker", project: "fixture", sessionId: "session-1",
  runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", sessionId: "session-1", workspaceId: "workspace-1" } };

/** Collaborators for runSendCommand whose target's Run recorded `delivery`. */
function collaborators({ target = agent, delivery = "inbox", sendDelivery } = {}) {
  const failures = [];
  return {
    parseOptions: parseOpts,
    loadRegistry: () => ({ agents: typeof target === "string" ? [] : [target] }),
    resolveAgent: () => target,
    send: vi.fn(async () => ({ sessionId: "session-1", workspaceId: "workspace-1", receipt: {} })),
    sendExactSession: vi.fn(async (sessionId) => ({ sessionId, workspaceId: "workspace-1", receipt: {} })),
    sendTracked: vi.fn(async () => ({ sessionId: "session-1", workspaceId: "workspace-1",
      receipt: { kind: "durable_message", interactionId: "message.1", receiptPath: "/private/message.1.json", deliveries: [] } })),
    sendDelivery: sendDelivery ?? vi.fn(async () => delivery),
    fail: (message) => { failures.push(message); },
    environment: {},
    failures,
  };
}

function quiet() {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

function nothingSent(c) {
  expect(c.send).not.toHaveBeenCalled();
  expect(c.sendExactSession).not.toHaveBeenCalled();
  expect(c.sendTracked).not.toHaveBeenCalled();
}

describe("dure send to an Agent whose Run chose inbox delivery", () => {
  it("sends a tracked message and never terminal input", async () => {
    const stderr = quiet();
    const c = collaborators();
    await runSendCommand(["worker", "build is green"], c);
    expect(c.failures).toEqual([]);
    expect(c.sendDelivery).toHaveBeenCalledWith(agent);
    expect(c.sendTracked).toHaveBeenCalledTimes(1);
    expect(c.sendTracked.mock.calls[0][1]).toBe("build is green");
    expect(c.sendTracked.mock.calls[0][2].messageTitle).toBe("[dure send · unregistered]");
    expect(c.send).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join("")).toContain("worker takes dure send only through its durable inbox");
  });

  it("follows an exact Session to the Agents bound to it", async () => {
    quiet();
    const c = collaborators({ target: "session-9" });
    await runSendCommand(["session-9", "--workspace", "workspace-1", "hello"], c);
    expect(c.sendDelivery).toHaveBeenCalledWith("session-9");
    expect(c.sendTracked.mock.calls[0][0]).toBe("session-9");
    expect(c.sendExactSession).not.toHaveBeenCalled();
  });

  it.each([
    [["--no-enter"], "--no-enter"],
    [["--idempotency-key", "key-1"], "--idempotency-key"],
    [["--window-label", "main"], "--window-label"],
    [["--draft-wait", "5"], "--draft-wait"],
    [["--ignore-draft"], "--ignore-draft"],
  ])("refuses %j, which only terminal input has", async (extra, flag) => {
    quiet();
    const c = collaborators();
    await runSendCommand(["worker", ...extra, "hello"], c);
    expect(c.failures).toHaveLength(1);
    expect(c.failures[0]).toContain("worker takes dure send only through its durable inbox");
    expect(c.failures[0]).toContain(`${flag} applies only to terminal input. Nothing was sent.`);
    nothingSent(c);
  });

  it("refuses a provider command instead of delivering it as a message", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["worker", "/compact"], c);
    expect(c.failures[0]).toContain("a provider command such as /compact runs only as terminal input");
    nothingSent(c);
  });

  it("sends nothing when the target's Run records cannot be read", async () => {
    quiet();
    const c = collaborators({ sendDelivery: vi.fn(async () => {
      throw new Error("its backend is unavailable (backend_transport_unavailable)");
    }) });
    await runSendCommand(["worker", "hello"], c);
    expect(c.failures).toEqual(["Could not read how worker takes dure send input: its backend is unavailable " +
      "(backend_transport_unavailable). Nothing was sent. Retry, or send with --track."]);
    nothingSent(c);
  });

  it("keeps terminal input for an Agent whose Run chose nothing", async () => {
    quiet();
    const c = collaborators({ delivery: null });
    await runSendCommand(["worker", "/compact"], c);
    await runSendCommand(["worker", "--no-enter", "draft"], c);
    expect(c.failures).toEqual([]);
    expect(c.send.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["/compact", true], ["[dure send · unregistered] draft", false]]);
    expect(c.sendTracked).not.toHaveBeenCalled();
  });

  it("needs no Run answer for --track, which refuses the same options", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["worker", "--track", "hello"], c);
    expect(c.sendDelivery).not.toHaveBeenCalled();
    expect(c.sendTracked).toHaveBeenCalledTimes(1);
    await runSendCommand(["worker", "--track", "--window-label", "main", "--ignore-draft", "hello"], c);
    expect(c.failures).toEqual(["--track delivers through the durable inbox; --window-label, --ignore-draft " +
      "apply only to terminal input. Nothing was sent."]);
    expect(c.sendTracked).toHaveBeenCalledTimes(1);
  });
});

const run = (overrides = {}) => ({ agentId: "agent-1", operationId: "spawn-1", name: "worker", providerId: "claude",
  workspaceId: "workspace-1", projectId: "fixture", launchState: "succeeded", createdAtMs: 1, updatedAtMs: 2, ...overrides });

/** A backend that answers the Session lookup and the Run listing. */
function backend({ capabilities = ["agent_spawn.send_delivery.v1", "agent_runtime.native_session.resolve.v1"],
  runs = [run()], owners = ["agent-1"], error } = {}) {
  const requests = [];
  return {
    requests,
    backend: { profile: { id: "local", expected: { capabilities } }, transportOptions: {} },
    requestBackend: async (_profile, request) => {
      requests.push(request);
      if (error) throw error;
      if (request.operation === "agent_runtime.native_session.resolve.v1") {
        return { result: { schemaVersion: 1, sessionId: request.body.sessionId, complete: true,
          agents: owners.map((agentId) => ({ agentId, workspaceId: "workspace-1", bindingGeneration: 1 })) } };
      }
      const selected = runs.filter((entry) => [entry.agentId, entry.name, entry.operationId].includes(request.body.selector));
      return { result: { schemaVersion: 1, runs: selected, nextCursor: null } };
    },
  };
}

describe("reading a target's send delivery from its Run records", () => {
  it("reads a registered Agent's Runs by its ID", async () => {
    const f = backend({ runs: [run({ sendDelivery: "inbox" })] });
    expect(await sendTargetDelivery({ target: agent, ...f })).toBe("inbox");
    expect(f.requests).toMatchObject([{ operation: "agent_spawn.list", requiredCapabilities: ["agent_spawn.list"],
      body: { schemaVersion: 1, selector: "agent-1" } }]);
  });

  it("maps an exact Session to the Agents bound to it", async () => {
    const f = backend({ runs: [run({ agentId: "agent-2", name: "other", sendDelivery: "inbox" })], owners: ["agent-2"] });
    expect(await sendTargetDelivery({ target: "session-9", ...f })).toBe("inbox");
    expect(f.requests.map((request) => request.operation))
      .toEqual(["agent_runtime.native_session.resolve.v1", "agent_spawn.list"]);
  });

  it("finds no delivery for an Agent without a Run choice", async () => {
    expect(await sendTargetDelivery({ target: agent, ...backend() })).toBeNull();
    expect(await sendTargetDelivery({ target: agent, ...backend({ runs: [] }) })).toBeNull();
    expect(await sendTargetDelivery({ target: "session-9", ...backend({ owners: [] }) })).toBeNull();
  });

  it("asks nothing of a backend that cannot record the choice", async () => {
    const f = backend({ capabilities: ["agent_spawn.list"] });
    expect(await sendTargetDelivery({ target: agent, ...f })).toBeNull();
    expect(f.requests).toEqual([]);
  });

  it.each(["backend_profiles_config_missing", "backend_profiles_selection_not_found"])(
    "finds no Run on a backend this machine does not have (%s)", async (code) => {
      expect(await sendTargetDelivery({ target: agent, backend: { error: { code } } })).toBeNull();
    });

  it.each([
    ["an unavailable backend", { backend: { error: { code: "backend_profiles_config_unsafe" } } }, "its backend is unavailable"],
    ["a failed request", backend({ error: Object.assign(new Error("down"), { code: "backend_transport_timeout" }) }),
      "its backend did not answer (backend_transport_timeout)"],
    ["an unknown delivery", backend({ runs: [run({ sendDelivery: "pigeon" })] }), "does not know (pigeon); update Dure"],
    ["an invalid listing", backend({ runs: [run({ launchState: "imagined" })] }), "Run records are unavailable"],
  ])("refuses to guess with %s", async (_label, f, message) => {
    await expect(sendTargetDelivery({ target: agent, requestBackend: f.requestBackend, ...f }))
      .rejects.toMatchObject({ code: "dure_send_delivery_unreadable", message: expect.stringContaining(message) });
  });

  it("stops after a bounded number of pages", async () => {
    let page = 0;
    const requestBackend = async () => {
      page += 1;
      const runs = Array.from({ length: 64 }, (_, i) =>
        run({ operationId: `spawn-${String(page).padStart(2, "0")}-${String(i).padStart(2, "0")}` }));
      return { result: { schemaVersion: 1, runs, nextCursor: runs.at(-1).operationId } };
    };
    await expect(recordedSendDelivery({ agentIds: ["agent-1"], requestBackend,
      backend: { profile: { id: "local" }, transportOptions: {} } }))
      .rejects.toMatchObject({ code: "dure_send_delivery_unreadable", message: expect.stringContaining("pages") });
    expect(page).toBe(4);
  });
});
