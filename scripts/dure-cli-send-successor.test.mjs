import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSendCommand } from "../cli/lib/send-command.mjs";
import { succeededNativeReceipt } from "./fixtures/agent-spawn-receipts.mjs";
import {
  hmuxSession,
  installRemoteBackendFixture,
  runSessionCli,
  writeRegistry,
} from "./lib/dure-session-test-fixture.mjs";

const SUCCESSOR = "runtime-native-successor";
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The backend's projection of an Agent whose binding now names `current`, as
 * a `dure runs switch-account` or restart leaves it before the app re-projects
 * the registry. */
function agentRuntime(plan, session, current) {
  return { schemaVersion: 1, state: "stable", receipt: { schemaVersion: 1,
    agentId: plan.agentId, selectionRevision: 2, providerId: plan.request.providerId,
    executionProfile: plan.request.executionProfile, permissionMode: plan.request.permissionMode,
    authority: { interactionProfile: "native_cli", authority: {
      ...session, sessionId: current, runtimeWorkspaceId: plan.workspaceId,
      binding: { agentId: plan.agentId, sessionId: current, runtimeKindId: "runtime.hmux" },
    } } }, projectionContext: { schemaVersion: 1, identity: { kind: "registered" },
      agent: { agentId: plan.agentId, providerId: plan.request.providerId, workspaceId: plan.workspaceId },
      workspace: { workspaceId: plan.workspaceId, projectId: plan.authority.projectId, rootPath: "/repo" },
      project: { projectId: plan.authority.projectId, rootPath: "/repo" } } };
}

/** A registry Agent `lead` whose registered Session answers input as
 * `predecessor` says, an hmux stub that knows the live successor, and an SSH
 * backend stub whose Agent projection names `current`. */
function fixture({ predecessor = "exited", current = SUCCESSOR, backendDown = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-send-successor-"));
  roots.push(root);
  const receipt = succeededNativeReceipt();
  const plan = receipt.plan;
  const session = receipt.completed.find((stage) => stage.stage === "runtime_launch").evidence.session;
  const { sessionId, workspaceId, runnerPrincipal, runnerInstance, channelEpoch, hostInstanceId, terminalEpoch } = session;
  writeRegistry(root, [{ id: plan.agentId, name: "lead", displayName: "lead", project: "fixture", sessionId, kind: "pty",
    runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", sessionId, workspaceId,
      stopFence: { runnerPrincipal, runnerInstance, channelEpoch, hostInstanceId, terminalEpoch } } }]);
  const successor = hmuxSession(1, { session_id: SUCCESSOR, workspace_id: plan.workspaceId });
  const refusal = {
    exited: { code: "hmux_session_exited", message: "An exited Hmux session can only be inspected", deliveryState: "not_written" },
    draft: { code: "hmux_input_draft_pending", message: "Unsubmitted user input remains", deliveryState: "not_written" },
    unknown: { code: "hmux_session_exited", message: "Hmux session exited during input", deliveryState: "unknown" },
  }[predecessor];
  const calls = join(root, "hmux-calls.jsonl");
  writeFileSync(calls, "");
  const hmux = join(root, "hmux.mjs");
  writeFileSync(hmux, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const value = (flag) => args[args.indexOf(flag) + 1];
if (args.includes("capabilities")) {
  console.log(JSON.stringify({ schemaVersion: 2, capabilities: ["semantic_command_input_v1", "semantic_key_input_v1", "draft_guarded_command_input_v1"] }));
} else if (args.includes("show")) {
  if (value("show") !== ${JSON.stringify(SUCCESSOR)}) process.exit(3);
  console.log(JSON.stringify(${JSON.stringify(successor)}));
} else if (args.includes("command-input")) {
  const refusal = ${JSON.stringify(refusal ?? null)};
  if (refusal && value("--target") === ${JSON.stringify(sessionId)}) {
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: refusal }));
    process.exit(1);
  }
  const atomic = args.includes("--draft-guard-wait-ms");
  const submit = args.includes("--submit");
  console.log(JSON.stringify({ schemaVersion: 1, ok: true, receipt: {
    terminalEpoch: JSON.parse(value("--expected-fence-json")).terminal_epoch,
    text: { recordId: "1", state: "written_to_pty" },
    submit: submit ? { recordId: atomic ? "1" : "2", state: "written_to_pty" } : null,
    ...(atomic ? { atomic: true } : {}) } }));
} else process.exit(72);
`);
  chmodSync(hmux, 0o700);
  const remote = installRemoteBackendFixture(root, [], {
    fail: backendDown,
    capabilities: ["sessions.list", "sessions.show", "agent_runtime.projection.inspect"],
    results: { "agent_runtime.projection.inspect": agentRuntime(plan, session, current) },
  });
  const environment = {
    PATH: `${remote.bin}:${process.env.PATH}`,
    DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
    DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
    DURE_SESSION_REQUEST_LOG: remote.requestLog,
  };
  const lines = (file) => existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return {
    plan, sessionId, workspaceId,
    send: (args) => runSessionCli(root, hmux, ["send", "lead", ...args], environment),
    inputs: () => lines(calls).filter((args) => args.includes("command-input")),
    backendRequests: () => lines(remote.requestLog),
  };
}

const after = (args, flag) => args.slice(args.indexOf(flag));

describe("dure send <name> after the registered Session exited", () => {
  it.each([[[]], [["--no-enter", "--ignore-draft"]], [["--draft-wait", "4"]]])(
    "delivers to the Agent's current Session with the same options: %j",
    (options) => {
      const f = fixture();
      const result = f.send(["hello", ...options, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true,
        target: { agentId: f.plan.agentId, sessionId: SUCCESSOR, workspaceId: f.plan.workspaceId } });
      expect(result.stderr).toBe(
        `lead now runs in Session ${SUCCESSOR} (workspace ${f.plan.workspaceId}); the app's agent ` +
        `registry still lists ${f.sessionId}. Sending to the current Session.\n`);
      const [first, second, ...rest] = f.inputs();
      expect(rest).toEqual([]);
      expect(first[first.indexOf("--target") + 1]).toBe(f.sessionId);
      expect(second[second.indexOf("--target") + 1]).toBe(SUCCESSOR);
      expect(second[second.indexOf("--workspace") + 1]).toBe(f.plan.workspaceId);
      // The successor's fence comes from the successor, not from the registry.
      expect(JSON.parse(second[second.indexOf("--expected-fence-json") + 1]))
        .toMatchObject({ session_id: SUCCESSOR, terminal_epoch: "terminal-1", runner_instance: "runner-1" });
      expect(after(second, "--text")).toEqual(after(first, "--text"));
      expect(f.backendRequests()).toEqual([
        expect.objectContaining({ operation: "agent_runtime.projection.inspect" }),
      ]);
    },
  );

  it("reports the original failure when the backend names no other Session", () => {
    const f = fixture();
    const unmoved = fixture({ current: f.sessionId });
    for (const [scenario, run] of [["unmoved", unmoved], ["backend down", fixture({ backendDown: true })]]) {
      const result = run.send(["hello"]);
      expect(result.status, scenario).not.toBe(0);
      expect(result.stderr, scenario).toBe(
        "hmux_session_exited: An exited Hmux session can only be inspected (deliveryState=not_written)\n");
      expect(run.inputs(), scenario).toHaveLength(1);
    }
    expect(unmoved.backendRequests()).toHaveLength(1);
  });

  it("never asks the backend while the registered Session is live", () => {
    const f = fixture({ predecessor: "live" });
    const result = f.send(["hello", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).target).toEqual({ agentId: f.plan.agentId, sessionId: f.sessionId, workspaceId: f.workspaceId });
    expect(result.stderr).toBe("");
    expect(f.inputs()).toHaveLength(1);
    expect(f.backendRequests()).toEqual([]);
  });

  it.each(["draft", "unknown"])("keeps a %s refusal on the registered Session", (predecessor) => {
    const f = fixture({ predecessor });
    const result = f.send(["hello"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("now runs in Session");
    expect(f.inputs()).toHaveLength(1);
    expect(f.backendRequests()).toEqual([]);
  });
});

/** Collaborators for runSendCommand that record what reached them. */
function collaborators({ agent, sendTracked, send, findSuccessor = vi.fn(async () => ({ sessionId: SUCCESSOR, workspaceId: "workspace-2" })) }) {
  const failures = [];
  return {
    parseOptions: (args) => ({ rest: args.filter((arg) => !arg.startsWith("--")), enter: true,
      json: args.includes("--json"), idempotencyKey: args.includes("--idempotency-key") ? "key-1" : undefined }),
    loadRegistry: () => ({ agents: typeof agent === "string" ? [] : [agent] }),
    resolveAgent: () => agent,
    send: send ?? vi.fn(),
    sendExactSession: vi.fn(async (sessionId, _text, opts) => ({ sessionId, workspaceId: opts.workspace, receipt: {} })),
    sendTracked,
    findSuccessor,
    fail: (message) => { failures.push(message); },
    failures,
  };
}

const registryAgent = { id: "agent-1", name: "lead", project: "fixture", sessionId: "session-1",
  runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", sessionId: "session-1", workspaceId: "workspace-1" } };
const exited = (sessionId) => Object.assign(new Error(`Session ${sessionId} has exited. Nothing was sent.`),
  { code: "dure_send_session_exited", sessionId });
const durable = (sessionId, workspaceId) => ({ sessionId, workspaceId,
  receipt: { kind: "durable_message", interactionId: "message.1", receiptPath: "/private/message.1.json", deliveries: [] } });

describe("runSendCommand after the registered Session exited", () => {
  function quiet() {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return { stdout: () => stdout.mock.calls.join(""), stderr: () => stderr.mock.calls.join("") };
  }

  it("sends the durable message to the Agent's current Session", async () => {
    const output = quiet();
    const sendTracked = vi.fn(async (target, _text, opts) => {
      if (target === registryAgent) throw exited("session-1");
      return durable(target, opts.workspace);
    });
    const c = collaborators({ agent: registryAgent, sendTracked });
    await runSendCommand(["lead", "hello", "--track", "--json"], c);
    expect(c.failures).toEqual([]);
    expect(sendTracked.mock.calls.map(([target, text, opts]) => [target === registryAgent ? "registry" : target, text, opts.workspace]))
      .toEqual([["registry", "hello", undefined], [SUCCESSOR, "hello", "workspace-2"]]);
    expect(c.sendExactSession).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout()).target).toEqual({ agentId: "agent-1", sessionId: SUCCESSOR, workspaceId: "workspace-2" });
    expect(output.stderr()).toContain(`lead now runs in Session ${SUCCESSOR} (workspace workspace-2)`);
  });

  it("keeps today's failure text when there is no successor", async () => {
    quiet();
    const sendTracked = vi.fn(async () => { throw exited("session-1"); });
    const c = collaborators({ agent: registryAgent, sendTracked, findSuccessor: vi.fn(async () => null) });
    await runSendCommand(["lead", "hello", "--track"], c);
    expect(c.failures).toEqual(["lead has exited (Session session-1). Nothing was sent.\nFind a live Agent with: dure ls --alive"]);
    expect(c.findSuccessor).toHaveBeenCalledTimes(1);
    expect(sendTracked).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unrelated tracked failure", registryAgent, Object.assign(new Error("context unavailable"), { code: "dure_send_context_unavailable" })],
    ["an unregistered Session target", "session-1", exited("session-1")],
  ])("does not look for a successor after %s", async (_label, agent, error) => {
    quiet();
    const sendTracked = vi.fn(async () => { throw error; });
    const c = collaborators({ agent, sendTracked });
    await runSendCommand(["lead", "hello", "--track"], c);
    expect(c.failures).toHaveLength(1);
    expect(c.findSuccessor).not.toHaveBeenCalled();
    expect(sendTracked).toHaveBeenCalledTimes(1);
  });

  it("does not follow an idempotent broker send", async () => {
    quiet();
    const send = vi.fn(async () => { throw exited("session-1"); });
    const c = collaborators({ agent: registryAgent, send });
    await runSendCommand(["lead", "hello", "--idempotency-key", "key-1"], c);
    expect(c.failures).toEqual(["Session session-1 has exited. Nothing was sent."]);
    expect(c.findSuccessor).not.toHaveBeenCalled();
    expect(c.sendExactSession).not.toHaveBeenCalled();
  });
});

describe("dure send --from through the CLI", () => {
  it("writes the sender label ahead of the text the Session receives", () => {
    const f = fixture({ predecessor: "live" });
    const result = f.send(["--from", "ci-bot", "hello", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const [input, ...rest] = f.inputs();
    expect(rest).toEqual([]);
    expect(input[input.indexOf("--text") + 1]).toBe("[from ci-bot] hello");
  });

  it("refuses a missing sender name before any input", () => {
    const f = fixture({ predecessor: "live" });
    const result = f.send(["hello", "--from"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--from requires a sender name");
    expect(f.inputs()).toEqual([]);
  });
});
