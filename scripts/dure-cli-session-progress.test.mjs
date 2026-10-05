import { describe, expect, it } from "vitest";
import { collectSessionQuery, formatSessionQuery } from "../cli/lib/session-query.mjs";
import { hmuxSession, hostGeneration } from "./lib/dure-session-test-fixture.mjs";

const capability = "exact_session_probe_runtime_state_v1";
const progress = {
  report: { source_id: "native-driver", sequence: "2", phase: "thinking", turn_id: "turn-1", message_turns: [] },
  last_activity_unix_ms: "1700000000000", quiet_threshold_ms: "300000", progress_unconfirmed: false,
};
const state = {
  terminal_epoch: "terminal-1", revision: "3", observed_through_output_seq: "19",
  lifecycle: "running", activity: "working", attention: "none", attention_id: null,
  source: "provider_event", turn_completed_count: "0", progress,
};
const observed = () => hmuxSession(1, { output_seq: "20", agentRuntimeState: state });
const catalog = () => hmuxSession(1, {
  output_seq: "12", health: "unprobed", effectiveLifecycle: "unprobed", agentRuntimeState: null,
});

function localFixture({ supported = true, receipt = {}, batchKind = "success" } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (argv, limits) => {
      calls.push({ argv, limits });
      let payload;
      if (argv.includes("capabilities")) {
        payload = { schemaVersion: 2, capabilities: ["bounded_session_catalog_query_v1", ...(supported ? [capability] : [])] };
      } else if (argv.includes("list")) {
        payload = { schemaVersion: 1, complete: true, prioritizedItems: 0, sessions: [catalog()], truncation: { items: false, omittedCount: 0 } };
      } else if (argv.includes("probe-batch")) {
        if (batchKind !== "success") return { kind: batchKind };
        const result = {
          ...hostGeneration(), liveness: "alive", status: "healthy",
          ...(supported ? { outputSequence: "20", agentRuntimeState: state } : {}), ...receipt,
        };
        payload = { schemaVersion: 1, complete: result.liveness !== "unknown", results: [result] };
      } else {
        payload = observed();
      }
      return { kind: "success", stdout: JSON.stringify(payload) };
    },
  };
}

describe("bounded session progress observation", () => {
  it("projects the same fresh Host progress for local list and inspect in one bounded batch", async () => {
    const fixture = localFixture();
    const list = await collectSessionQuery({ action: "list", execute: fixture.execute });
    const show = await collectSessionQuery({ action: "show", sessionId: "session-1", execute: fixture.execute });
    expect(list.sessions[0].runtime.agentRuntimeState).toEqual(show.session.runtime.agentRuntimeState);
    expect(list.sessions[0].runtime.agentRuntimeState.progress).toEqual(progress);
    expect(list.sessions[0].runtime.outputSequence).toBe("20");
    expect(formatSessionQuery(list)).toContain("thinking");
    const batch = fixture.calls.filter(({ argv }) => argv.includes("probe-batch"));
    expect(batch).toHaveLength(1);
    expect(batch[0].argv).toContain("--include-runtime-state");
    expect(batch[0].limits.timeoutMs).toBeLessThanOrEqual(2500);
    expect(fixture.calls.filter(({ argv }) => argv.includes("show"))).toHaveLength(1);
  });

  it.each(["local", "ssh"])("preserves the same projection through the %s backend", async (kind) => {
    const requests = [];
    const options = {
      backend: { profile: { id: "backend", transport: { kind }, expected: { capabilities: ["sessions.list", "sessions.show"] } } },
      requestBackend: async (_profile, request, limits) => {
        requests.push({ request, limits });
        return { backend: {}, result: request.operation === "sessions.list"
          ? { schemaVersion: 1, complete: true, sessions: [observed()] }
          : { schemaVersion: 1, session: observed() } };
      },
    };
    const list = await collectSessionQuery({ ...options, action: "list" });
    const show = await collectSessionQuery({ ...options, action: "show", sessionId: "session-1" });
    expect(list.sessions[0].runtime.agentRuntimeState).toEqual(show.session.runtime.agentRuntimeState);
    expect(list.sessions[0].runtime.agentRuntimeState.progress).toEqual(progress);
    expect(requests.map(({ request }) => request.operation)).toEqual(["sessions.list", "sessions.show"]);
    expect(requests[0].request.body.probeBudgetMs).toBe(1000);
    expect(requests[0].limits.deadlineMs).toBe(2500);
  });

  it("retains liveness with old runtimes without requesting the new option", async () => {
    const fixture = localFixture({ supported: false });
    const list = await collectSessionQuery({ action: "list", execute: fixture.execute });
    expect(list.sessions[0].liveness.state).toBe("alive");
    expect(list.sessions[0].runtime.agentRuntimeState).toBeNull();
    expect(fixture.calls.flatMap(({ argv }) => argv)).not.toContain("--include-runtime-state");
  });

  it("keeps unsupported Host progress absent without losing healthy runtime state", async () => {
    const fixture = localFixture({ receipt: { agentRuntimeState: { ...state, progress: undefined } } });
    const list = await collectSessionQuery({ action: "list", execute: fixture.execute });
    expect(list.sessions[0].liveness.state).toBe("alive");
    expect(list.sessions[0].runtime.agentRuntimeState.activity).toBe("working");
    expect(list.sessions[0].runtime.agentRuntimeState.progress).toBeUndefined();
    expect(formatSessionQuery(list)).toContain("unknown");
  });

  it.each(["thinking", "tool_running", "waiting", "progress_unconfirmed"])("renders Host progress %s", async (phase) => {
    const observation = { ...progress, report: { ...progress.report, phase: phase === "progress_unconfirmed" ? "thinking" : phase },
      progress_unconfirmed: phase === "progress_unconfirmed" };
    const fixture = localFixture({ receipt: { agentRuntimeState: { ...state, progress: observation } } });
    const list = await collectSessionQuery({ action: "list", execute: fixture.execute });
    expect(list.sessions[0].runtime.agentRuntimeState.progress).toEqual(observation);
    expect(formatSessionQuery(list)).toContain(phase);
  });

  it.each([
    { hostInstanceId: "replacement" },
    { terminalEpoch: "replacement" },
    { agentRuntimeState: { ...state, terminal_epoch: "replacement" } },
    { outputSequence: "18" },
    { status: "generation_changed", liveness: "unknown" },
    { status: "stale_transport", liveness: "dead" },
  ])("does not attribute progress across invalid observation fences: %j", async (receipt) => {
    const fixture = localFixture({ receipt });
    const list = await collectSessionQuery({ action: "list", execute: fixture.execute });
    expect(list.sessions[0].runtime.agentRuntimeState).toBeNull();
  });

  it("leaves timed out and zero-budget observations unknown without falling back to per-session show", async () => {
    for (const options of [{ batchKind: "timeout" }, {}]) {
      const fixture = localFixture(options);
      const list = await collectSessionQuery({ action: "list", execute: fixture.execute, ...(!options.batchKind ? { probeBudgetMs: 0 } : {}) });
      expect(list.sessions[0].liveness.state).toBe("unknown");
      expect(list.sessions[0].runtime.agentRuntimeState).toBeNull();
      expect(fixture.calls.flatMap(({ argv }) => argv)).not.toContain("show");
    }
  });

  it("retains completed progress when another target exhausts the shared budget", async () => {
    const fixture = localFixture();
    const execute = async (argv, limits) => {
      const result = await fixture.execute(argv, limits);
      const payload = JSON.parse(result.stdout);
      if (argv.includes("list")) payload.sessions.push(hmuxSession(2, { health: "unprobed", effectiveLifecycle: "unprobed" }));
      if (argv.includes("probe-batch")) {
        payload.complete = false;
        payload.results.push({ sessionId: "session-2", workspaceId: "workspace-2", liveness: "unknown", status: "unprobed" });
      }
      return { ...result, stdout: JSON.stringify(payload) };
    };
    const list = await collectSessionQuery({ action: "list", execute });
    expect(list.sessions[0].runtime.agentRuntimeState.progress).toEqual(progress);
    expect(list.sessions[1].liveness.state).toBe("unknown");
    expect(list.sessions[1].runtime.agentRuntimeState).toBeNull();
    expect(fixture.calls.filter(({ argv }) => argv.includes("probe-batch"))).toHaveLength(1);
  });
});
