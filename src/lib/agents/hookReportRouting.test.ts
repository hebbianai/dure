import { describe, expect, it } from "vitest";
import {
  decideHookReportRoute,
  HOST_WORKING_TTL_HINT_MS,
  HOST_WORKING_TTL_STICKY_MS,
  mapHookStateToReport,
  resolveHookReportBinding,
} from "@/lib/agents/hookReportRouting";
import {
  hmuxLocalBinding,
  hmuxManagedBinding,
  hmuxStandaloneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

const legacyLocalBinding = (sessionId: string) =>
	({
		schemaVersion: 1,
		runtime: "legacy_session_v1",
		source: "local",
		hostId: "local",
		sessionId,
	}) as unknown as TerminalPaneBindingV1;
const legacySshBinding = (sessionId: string, hostId: string) =>
	({
		schemaVersion: 1,
		runtime: "legacy_ssh_session_v1",
		source: "ssh",
		hostId,
		sessionId,
	}) as unknown as TerminalPaneBindingV1;

describe("mapHookStateToReport", () => {
  it("working은 terminalEvents 여부로 lease TTL을 고른다", () => {
    expect(mapHookStateToReport("working", true)).toEqual({
      activity: "working",
      attention: "none",
      turnCompleted: false,
      workingTtlMs: HOST_WORKING_TTL_STICKY_MS,
    });
    expect(mapHookStateToReport("working", false).workingTtlMs).toBe(
      HOST_WORKING_TTL_HINT_MS,
    );
  });

  it.each([
    ["waiting", { activity: "waiting", attention: "none", turnCompleted: false }],
    [
      "blocked",
      { activity: "waiting", attention: "approval_required", turnCompleted: false },
    ],
    ["done", { activity: "waiting", attention: "none", turnCompleted: true }],
  ] as const)("%s 매핑은 DESIGN v2를 따른다", (state, expected) => {
    expect(mapHookStateToReport(state, true)).toEqual(expected);
  });
});

describe("decideHookReportRoute", () => {
  it("managed/standalone hmux 바인딩은 host로 전달한다", () => {
    for (const binding of [
      hmuxManagedBinding("s1", "w1"),
      hmuxStandaloneBinding("s1", "w1"),
    ]) {
      const route = decideHookReportRoute(binding, "done", true);
      expect(route).toEqual({
        sessionId: "s1",
        workspaceId: "w1",
        report: { activity: "waiting", attention: "none", turnCompleted: true },
      });
    }
  });

  it("opaque conversation identity travels only as part of the Host report", () => {
    expect(
      decideHookReportRoute(hmuxManagedBinding("s1", "w1"), "waiting", true, {
        providerId: "codex",
        conversationId: "conversation-1",
      }),
    ).toEqual({
      sessionId: "s1",
      workspaceId: "w1",
      report: {
        activity: "waiting",
        attention: "none",
        turnCompleted: false,
        conversationIdentity: {
          providerId: "codex",
          conversationId: "conversation-1",
        },
      },
    });
  });

  it("rejects reports without an authoritative Host route", () => {
    expect(decideHookReportRoute(undefined, "working", true)).toBeNull();
    expect(
      decideHookReportRoute(legacyLocalBinding("s1"), "done", true),
    ).toBeNull();
    expect(
      decideHookReportRoute(legacySshBinding("s1", "h1"), "done", true),
    ).toBeNull();
    expect(
      decideHookReportRoute(hmuxLocalBinding("s1", "w1"), "done", true),
    ).toBeNull();
  });
});

describe("resolveHookReportBinding", () => {
  const fence = {
    sessionId: "s1",
    workspaceId: "dure-local-shells-v1",
    runnerPrincipal: "runner",
    runnerInstance: "instance",
    channelEpoch: "1",
    hostInstanceId: "host",
    terminalEpoch: "terminal",
  };

  it("uses an exact current hook fence before an Agent record exists", () => {
    expect(
      resolveHookReportBinding(undefined, "s1", { kind: "fenced", fence }),
    ).toMatchObject({
      runtime: "hmux_managed_v1",
      sessionId: "s1",
      workspaceId: fence.workspaceId,
      stopFence: {
        runnerPrincipal: fence.runnerPrincipal,
        runnerInstance: fence.runnerInstance,
        channelEpoch: fence.channelEpoch,
        hostInstanceId: fence.hostInstanceId,
        terminalEpoch: fence.terminalEpoch,
      },
    });
    expect(
      resolveHookReportBinding(undefined, "other", { kind: "fenced", fence }),
    ).toBeUndefined();
    expect(
      resolveHookReportBinding(undefined, "s1", {
        kind: "fenced",
        fence: { ...fence, workspaceId: "managed-agent-workspace" },
      }),
    ).toBeUndefined();
  });
});
