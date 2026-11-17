import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSendCommand } from "../cli/lib/send-command.mjs";
import { sendTrackedMessage } from "../cli/lib/tracked-message.mjs";

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const agent = { id: "agent-1", name: "lead", project: "fixture", sessionId: "session-1",
  runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", sessionId: "session-1", workspaceId: "workspace-1" } };

/** Collaborators for runSendCommand that record what reached each delivery path.
 * The environment is explicit so the header never depends on the test's own Session. */
function collaborators(target = agent, { environment = {}, agents } = {}) {
  const failures = [];
  return {
    parseOptions: (args) => {
      const terminator = args.indexOf("--");
      const options = terminator < 0 ? args : args.slice(0, terminator);
      return { rest: [...options.filter((arg) => !arg.startsWith("--")), ...(terminator < 0 ? [] : args.slice(terminator + 1))],
        enter: !options.includes("--no-enter"), json: options.includes("--json") };
    },
    loadRegistry: () => ({ agents: agents ?? (typeof target === "string" ? [] : [target]) }),
    resolveAgent: () => target,
    send: vi.fn(async () => ({ sessionId: "session-1", workspaceId: "workspace-1", receipt: {} })),
    sendExactSession: vi.fn(async (sessionId) => ({ sessionId, workspaceId: "workspace-1", receipt: {} })),
    sendTracked: vi.fn(async () => ({ sessionId: "session-1", workspaceId: "workspace-1",
      receipt: { kind: "durable_message", interactionId: "message.1", receiptPath: "/private/message.1.json", deliveries: [] } })),
    fail: (message) => { failures.push(message); },
    environment,
    failures,
  };
}

function quiet() {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

const worker = { id: "agent-2", name: "worker-3", displayName: "Review worker", project: "fixture", sessionId: "session-2",
  runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", sessionId: "session-2", workspaceId: "workspace-1" } };
const insideWorker = { environment: { HMUX_SESSION_ID: "session-2", HMUX_WORKSPACE_ID: "workspace-1" }, agents: [agent, worker] };

describe("dure send header", () => {
  it("marks input sent from outside a managed Session as unregistered", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "build", "is", "green"], c);
    expect(c.failures).toEqual([]);
    expect(c.send).toHaveBeenCalledTimes(1);
    expect(c.send.mock.calls[0][2]).toBe("[dure send · unregistered] build is green");
  });

  it("names the registered Agent whose Session runs the CLI", async () => {
    quiet();
    const c = collaborators(agent, insideWorker);
    await runSendCommand(["lead", "build is green"], c);
    expect(c.failures).toEqual([]);
    expect(c.send.mock.calls[0][2]).toBe("[dure send · from Review worker] build is green");
  });

  it("sends as unregistered from a Session no registered Agent owns", async () => {
    quiet();
    const unknown = collaborators(agent, { ...insideWorker, environment: { HMUX_SESSION_ID: "session-9" } });
    await runSendCommand(["lead", "hello"], unknown);
    expect(unknown.send.mock.calls[0][2]).toBe("[dure send · unregistered] hello");
    const ambiguous = collaborators(agent, { ...insideWorker, agents: [worker, { ...worker, id: "agent-3" }] });
    await runSendCommand(["lead", "hello"], ambiguous);
    expect(ambiguous.send.mock.calls[0][2]).toBe("[dure send · unregistered] hello");
  });

  it("puts the --from label inside the header", async () => {
    quiet();
    const c = collaborators(agent, insideWorker);
    await runSendCommand(["lead", "--from", "ci-bot", "build", "is", "green"], c);
    expect(c.send.mock.calls[0][2]).toBe("[dure send · from Review worker · label ci-bot] build is green");
    const outside = collaborators();
    await runSendCommand(["lead", "--from", "ci-bot", "hello"], outside);
    expect(outside.send.mock.calls[0][2]).toBe("[dure send · unregistered · label ci-bot] hello");
  });

  it("adds the header for an exact Session target", async () => {
    quiet();
    const c = collaborators("session-1");
    await runSendCommand(["session-1", "hello", "--from", "release bot"], c);
    expect(c.failures).toEqual([]);
    expect(c.sendExactSession.mock.calls[0][1]).toBe("[dure send · unregistered · label release bot] hello");
  });

  it("adds the header to file text and keeps the text after it exact", async () => {
    quiet();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-send-header-"));
    roots.push(root);
    const file = path.join(root, "input.txt");
    fs.writeFileSync(file, "first\n  second\n");
    const c = collaborators();
    await runSendCommand(["lead", "--file", file, "--no-enter"], c);
    expect(c.failures).toEqual([]);
    expect(c.send.mock.calls[0][2]).toBe("[dure send · unregistered] first\n  second\n");
  });

  it("titles a durable inbox message with the header and keeps its body exact", async () => {
    quiet();
    const c = collaborators(agent, insideWorker);
    await runSendCommand(["lead", "--track", "--from", "ci-bot", "hello"], c);
    expect(c.failures).toEqual([]);
    const [, text, opts] = c.sendTracked.mock.calls[0];
    expect(text).toBe("hello");
    expect(opts.messageTitle).toBe("[dure send · from Review worker · label ci-bot]");
    const outside = collaborators();
    await runSendCommand(["lead", "--track", "/compact"], outside);
    expect(outside.sendTracked.mock.calls[0][1]).toBe("/compact");
    expect(outside.sendTracked.mock.calls[0][2].messageTitle).toBe("[dure send · unregistered]");
  });

  it.each(["/compact", "/compact\n", " /compact", "/model opus", "/project:review-pr 12",
    "/superpowers:brainstorm", "/compact keep\nthe API notes"])(
    "sends the provider command %j exactly as written", async (command) => {
      quiet();
      const c = collaborators(agent, insideWorker);
      await runSendCommand(["lead", "--", command], c);
      expect(c.failures).toEqual([]);
      expect(c.send.mock.calls[0][2]).toBe(command);
    });

  it.each(["/tmp/report.txt is ready", "/", "// not a command", "/ compact", "please /compact"])(
    "adds the header to %j, which is not one provider command", async (text) => {
      quiet();
      const c = collaborators();
      await runSendCommand(["lead", "--", text], c);
      expect(c.send.mock.calls[0][2]).toBe(`[dure send · unregistered] ${text}`);
    });

  it("refuses to label a provider command before anything is sent", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "--from", "ci-bot", "/compact"], c);
    expect(c.failures).toEqual(["--from cannot label a provider command such as /compact; it is sent exactly as written. Nothing was sent."]);
    expect(c.send).not.toHaveBeenCalled();
  });

  it("treats --from after -- as message text", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "--", "--from", "ci-bot"], c);
    expect(c.failures).toEqual([]);
    expect(c.send.mock.calls[0][2]).toBe("[dure send · unregistered] --from ci-bot");
  });

  it("trims the label", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "--from", "  ci-bot  ", "hello"], c);
    expect(c.send.mock.calls[0][2]).toBe("[dure send · unregistered · label ci-bot] hello");
  });

  it.each([
    [["--from"], "--from requires a sender name"],
    [["--from", "--json"], "--from requires a sender name"],
    [["--from", "   "], "--from requires a sender name"],
    [["--from", "a", "--from", "b"], "Choose --from once"],
    [["--from", "ci\nbot"], "--from must be one line without control characters"],
    [["--from", "ci\u001b[2Jbot"], "--from must be one line without control characters"],
    [["--from", "x".repeat(65)], "--from accepts at most 64 characters"],
  ])("refuses %j before anything is sent", async (flags, message) => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "hello", ...flags], c);
    expect(c.failures).toEqual([message]);
    expect(c.send).not.toHaveBeenCalled();
    expect(c.sendTracked).not.toHaveBeenCalled();
  });

  it("accepts a 64-character label, counted in characters", async () => {
    quiet();
    const c = collaborators();
    const name = "봇".repeat(64);
    await runSendCommand(["lead", "hi", "--from", name], c);
    expect(c.failures).toEqual([]);
    expect(c.send.mock.calls[0][2]).toBe(`[dure send · unregistered · label ${name}] hi`);
  });

  it("documents the header and its limits in help", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += chunk; return true; });
    await runSendCommand(["--help"], collaborators());
    expect(output).toContain("--from NAME");
    expect(output).toContain("[dure send · from AGENT]");
    expect(output).toContain("[dure send · unregistered]");
    expect(output).toContain("a missing header does not prove that a person typed the text");
    expect(output).toContain("must come from the person in the app");
  });
});

describe("tracked message title", () => {
  const generation = { runnerPrincipal: "owner", runnerInstance: "runner", channelEpoch: "1", hostInstanceId: "host", terminalEpoch: "epoch" };
  const live = { session: { sessionId: "session", workspaceId: "workspace", provider: { id: "codex" }, liveness: { exactGeneration: true }, runtime: { sessionClass: "managed", generation } } };
  const context = { target: { authority: { workspaceId: "workspace" } }, coordinatorGrant: { participant: "author" }, interactionCapability: "secret-capability", endpointFence: { endpointRef: "endpoint" } };

  async function openedTitle(options) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-send-sender-"));
    roots.push(root);
    const request = vi.fn(async (_, method) => method.startsWith("dispatch.context") ? context : { deliveries: [] });
    await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", {
      environment: { DURE_HOME: root }, backend: { profile: { id: "local" } }, querySession: async () => live, request, ...options,
    });
    const [, method, body] = request.mock.calls[1];
    expect(method).toBe("interaction.message.open.exact-session");
    expect(body.descriptionMarkdown).toBe("hello");
    return body.title;
  }

  it("opens the message with the header as its title", async () => {
    expect(await openedTitle({ title: "[dure send · unregistered · label ci-bot]" })).toBe("[dure send · unregistered · label ci-bot]");
  });
});
