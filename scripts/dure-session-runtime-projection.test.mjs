import { describe, expect, it } from "vitest";
import { collectSessionQuery } from "../cli/lib/session-query.mjs";
import { hmuxSession } from "./lib/dure-session-test-fixture.mjs";

const state = {
  terminal_epoch: "terminal-1", revision: "3", observed_through_output_seq: "11",
  lifecycle: "running", activity: "waiting", attention: "approval_required",
  attention_id: "attention-1", source: "provider_event", turn_completed_count: "2",
};

async function query(session, transport = "local") {
  const report = await collectSessionQuery({
    action: "show", sessionId: "session-1", workspaceId: "workspace-1",
    backend: { profile: { id: "qa", transport: { kind: transport }, expected: { capabilities: ["sessions.show"] } } },
    requestBackend: async () => ({
      backend: { id: "qa", generation: "qa-1", observedAtMs: Date.now() },
      result: { schemaVersion: 1, session },
    }),
  });
  expect(report.kind).toBe("dure.sessions.show");
  return report.session;
}

describe("Host runtime state in session inspection", () => {
  const boundary = { terminal_epoch: "terminal-1", observed_through_output_seq: "11", source: "process_inspection" };

  it.each(["local", "ssh"])("preserves Host execution and foreground identity through %s", async (transport) => {
    const session = await query(hmuxSession(1, {
      executionLocation: { ...boundary, location: { kind: "ssh", target: "qa@host.example" } },
      agentIdentity: { ...boundary, agent: "codex" },
    }), transport);
    expect(session.runtime.executionLocation).toEqual({
      terminalEpoch: "terminal-1", observedThroughOutputSeq: "11", source: "process_inspection",
      location: { kind: "ssh", target: "qa@host.example" },
    });
    expect(session.runtime.agentIdentity).toEqual({
      terminalEpoch: "terminal-1", observedThroughOutputSeq: "11", source: "process_inspection", agent: "codex",
    });
  });

  it("distinguishes positive local/shell observations from absent projections", async () => {
    const absent = await query(hmuxSession());
    expect(absent.runtime.executionLocation).toBeNull();
    expect(absent.runtime.agentIdentity).toBeNull();
    const shell = await query(hmuxSession(1, {
      executionLocation: { ...boundary, location: { kind: "local" } },
      agentIdentity: { ...boundary, agent: null },
    }));
    expect(shell.runtime.executionLocation.location).toEqual({ kind: "local" });
    expect(shell.runtime.agentIdentity.agent).toBeNull();
    expect(shell.runtime.agentIdentity).not.toBeNull();
  });

  it.each([
    { terminal_epoch: "retired" }, { observed_through_output_seq: "13" },
    { source: "terminal_inference" }, { source: "future_unsupported_source" },
  ])("keeps invalid execution and identity fences unavailable: %j", async (override) => {
    const session = await query(hmuxSession(1, {
      executionLocation: { ...boundary, location: { kind: "local" }, ...override },
      agentIdentity: { ...boundary, agent: "codex", ...override },
    }));
    expect(session.runtime.executionLocation).toBeNull();
    expect(session.runtime.agentIdentity).toBeNull();
  });

  it.each(["unprobed", "stale_transport", "generation_changed", "incompatible_protocol"])(
    "does not reuse identity or execution location on %s", async (health) => {
      const session = await query(hmuxSession(1, {
        health, executionLocation: { ...boundary, location: { kind: "local" } },
        agentIdentity: { ...boundary, agent: "codex" },
      }));
      expect(session.runtime.executionLocation).toBeNull();
      expect(session.runtime.agentIdentity).toBeNull();
    },
  );

  it.each([
    [{ kind: "ssh", target: "line\nbreak" }, "line\nbreak"],
    [{ kind: "ssh", target: "" }, ""],
    [{ kind: "invented" }, 4],
  ])("rejects malformed execution location and agent identity (%j)", async (location, agent) => {
    const session = await query(hmuxSession(1, {
      executionLocation: { ...boundary, location }, agentIdentity: { ...boundary, agent },
    }));
    expect(session.runtime.executionLocation).toBeNull();
    expect(session.runtime.agentIdentity).toBeNull();
  });

  it.each(["local", "ssh"])("preserves the fenced state through the %s backend", async (transport) => {
    const session = await query(hmuxSession(1, { agentRuntimeState: { ...state, unrelatedPayload: "must not project" } }), transport);
    expect(session.runtime.agentRuntimeState).toEqual({
      terminalEpoch: "terminal-1", revision: "3", observedThroughOutputSeq: "11",
      lifecycle: "running", activity: "waiting", attention: "approval_required",
      attentionId: "attention-1", source: "provider_event", turnCompletedCount: "2",
    });
  });

  it.each([undefined, null])("represents an absent projection as null (%s)", async (agentRuntimeState) => {
    expect((await query(hmuxSession(1, { agentRuntimeState }))).runtime.agentRuntimeState).toBeNull();
  });

  it.each([
    { terminal_epoch: "previous-terminal" }, { observed_through_output_seq: "13" },
    { revision: "-1" }, { revision: "03" }, { turn_completed_count: "NaN" },
    { lifecycle: "invented" }, { activity: "invented" }, { attention: "invented" },
    { attention_id: "x".repeat(513) }, { attention_id: "line\nbreak" },
    { source: "terminal_inference" }, { source: "unknown" },
  ])("does not certify an invalid or stale runtime fact: %j", async (override) => {
    const session = await query(hmuxSession(1, { agentRuntimeState: { ...state, ...override } }));
    expect(session.runtime.agentRuntimeState).toBeNull();
    expect(session.runtime.generation.terminalEpoch).toBe("terminal-1");
  });

  it.each(["unprobed", "stale_transport", "generation_changed", "incompatible_protocol"])(
    "does not reuse runtime state when the observation is %s", async (health) => {
      const session = await query(hmuxSession(1, { agentRuntimeState: state, health }));
      expect(session.runtime.agentRuntimeState).toBeNull();
      expect(session.liveness.exactGeneration).toBe(false);
    },
  );

  it("retains large decimal counters exactly and allows the captured output boundary", async () => {
    const counter = "18446744073709551615";
    const session = await query(hmuxSession(1, {
      output_seq: counter,
      agentRuntimeState: { ...state, revision: counter, turn_completed_count: counter, observed_through_output_seq: counter, attention: "none", attention_id: null },
    }));
    expect(session.runtime.agentRuntimeState).toMatchObject({
      revision: counter, turnCompletedCount: counter, observedThroughOutputSeq: counter, attentionId: null,
    });
  });
});
