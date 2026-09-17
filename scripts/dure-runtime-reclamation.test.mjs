import { describe, expect, it } from "vitest";
import { collectAgentRuntimeCommand, formatAgentRuntimeCommand } from "../cli/lib/agent-runtime-command.mjs";

const entry = {
  agentId: "agent-1", providerId: "codex", operationId: "sleep-1", journalRevision: 2,
  stage: "source_stopped", stopState: "completed", wakeState: "not_requested",
  sourceSessionId: "session-1", requestedAtMs: 100, updatedAtMs: 200, reasonCode: null,
};
const outcomes = {
  schemaVersion: 1, state: "available", observedAtMs: 300,
  scope: "latest_runtime_transition_admissions", scanned: 1, limit: 64,
  partial: false, reasonCode: null, entries: [entry],
};
async function observe(reclamation) {
  const operations = [];
  const report = await collectAgentRuntimeCommand({
    args: ["idle"], requestId: "read-only",
    resolveBackend: async () => ({ profile: { id: "selected" } }),
    requestBackend: async (_profile, request) => {
      operations.push(request.operation);
      return { result: {
        schemaVersion: 1, configuration: "disabled", afterMs: null,
        observedAtMs: null, partial: false, reasonCode: null, agents: [], reclamation,
      } };
    },
  });
  expect(operations).toEqual(["agent_runtime.idle.inspect"]);
  return report;
}

describe("optional journal outcome boundary", () => {
  it("keeps old policy-only producers readable and never infers completed cleanup", async () => {
    const report = await observe(undefined);
    expect(report.ok).toBe(true);
    expect(formatAgentRuntimeCommand(report)).toContain("Source-stop outcomes: unavailable");
  });
  it.each([
    { schemaVersion: 2 }, { scanned: 65 }, { limit: 65 }, { partial: undefined },
    { observedAtMs: null }, { entries: [entry, entry], scanned: 2 },
    { entries: [{ ...entry, journalRevision: 0 }] },
    { entries: [{ ...entry, updatedAtMs: 99 }] },
    { entries: [{ ...entry, operationId: "bad id" }] },
    { state: "unavailable" },
  ])("isolates malformed outcome evidence from valid policy: %j", async (changes) => {
    const report = await observe({ ...outcomes, ...changes });
    expect(report).toMatchObject({ ok: true, result: { configuration: "disabled",
      reclamation: { state: "unavailable", entries: [], reasonCode: "runtime_reclamation_response_invalid" },
    } });
    expect(formatAgentRuntimeCommand(report)).not.toContain("source stop completed");
  });
  it("retains explicit truncation and future states without inventing a wake command", async () => {
    const report = await observe({ ...outcomes, partial: true,
      entries: [{ ...entry, stopState: "future_state", wakeState: "future_state" }],
    });
    expect(report.result.reclamation.entries[0].stopState).toBe("future_state");
    expect(formatAgentRuntimeCommand(report)).toContain("older admissions omitted");
    expect(formatAgentRuntimeCommand(report)).not.toContain("Wake: dure");
  });
});
