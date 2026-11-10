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

/** Collaborators for runSendCommand that record what reached each delivery path. */
function collaborators(target = agent) {
  const failures = [];
  return {
    parseOptions: (args) => {
      const terminator = args.indexOf("--");
      const options = terminator < 0 ? args : args.slice(0, terminator);
      return { rest: [...options.filter((arg) => !arg.startsWith("--")), ...(terminator < 0 ? [] : args.slice(terminator + 1))],
        enter: !options.includes("--no-enter"), json: options.includes("--json") };
    },
    loadRegistry: () => ({ agents: typeof target === "string" ? [] : [target] }),
    resolveAgent: () => target,
    send: vi.fn(async () => ({ sessionId: "session-1", workspaceId: "workspace-1", receipt: {} })),
    sendExactSession: vi.fn(async (sessionId) => ({ sessionId, workspaceId: "workspace-1", receipt: {} })),
    sendTracked: vi.fn(async () => ({ sessionId: "session-1", workspaceId: "workspace-1",
      receipt: { kind: "durable_message", interactionId: "message.1", receiptPath: "/private/message.1.json", deliveries: [] } })),
    fail: (message) => { failures.push(message); },
    failures,
  };
}

function quiet() {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("dure send --from", () => {
  it("names the sender at the start of terminal and chat input", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "--from", "ci-bot", "build", "is", "green"], c);
    expect(c.failures).toEqual([]);
    expect(c.send).toHaveBeenCalledTimes(1);
    expect(c.send.mock.calls[0][2]).toBe("[from ci-bot] build is green");
  });

  it("names the sender for an exact Session target", async () => {
    quiet();
    const c = collaborators("session-1");
    await runSendCommand(["session-1", "hello", "--from", "release bot"], c);
    expect(c.failures).toEqual([]);
    expect(c.sendExactSession.mock.calls[0][1]).toBe("[from release bot] hello");
  });

  it("titles a durable inbox message with the sender and keeps its body exact", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "--track", "--from", "ci-bot", "hello"], c);
    expect(c.failures).toEqual([]);
    const [, text, opts] = c.sendTracked.mock.calls[0];
    expect(text).toBe("hello");
    expect(opts.messageTitle).toBe("Message from ci-bot");
  });

  it("leaves input unchanged without --from", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "hello"], c);
    expect(c.send.mock.calls[0][2]).toBe("hello");
    await runSendCommand(["lead", "--track", "hello"], c);
    expect(c.sendTracked.mock.calls[0][2].messageTitle).toBeUndefined();
  });

  it("treats --from after -- as message text", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "--", "--from", "ci-bot"], c);
    expect(c.failures).toEqual([]);
    expect(c.send.mock.calls[0][2]).toBe("--from ci-bot");
  });

  it("trims the name", async () => {
    quiet();
    const c = collaborators();
    await runSendCommand(["lead", "--from", "  ci-bot  ", "hello"], c);
    expect(c.send.mock.calls[0][2]).toBe("[from ci-bot] hello");
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

  it("accepts a 64-character name, counted in characters", async () => {
    quiet();
    const c = collaborators();
    const name = "봇".repeat(64);
    await runSendCommand(["lead", "hi", "--from", name], c);
    expect(c.failures).toEqual([]);
    expect(c.send.mock.calls[0][2]).toBe(`[from ${name}] hi`);
  });

  it("documents --from in help", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += chunk; return true; });
    await runSendCommand(["--help"], collaborators());
    expect(output).toContain("--from NAME");
    expect(output).toContain("not an authenticated identity");
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

  it("uses the sender's title when given and the existing title otherwise", async () => {
    expect(await openedTitle({ title: "Message from ci-bot" })).toBe("Message from ci-bot");
    expect(await openedTitle({})).toBe("Agent message");
  });
});
