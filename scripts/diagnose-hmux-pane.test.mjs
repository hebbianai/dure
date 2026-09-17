import { describe, expect, it } from "vitest";
import {
  buildDiagnosticReceipt,
  optionalHmuxJson,
  resolveSession,
  webviewRecoveryTimeline,
} from "./diagnose-hmux-pane.mjs";

function session(overrides = {}) {
  return {
    session_id: "standalone-1",
    session_name: "hebbian-ide-next",
    workspace_id: "workspace-1",
    session_class: "standalone",
    lifecycle: "ready",
    provider_id: "local-shell",
    host_build_version: "0.1.0+old",
    terminal_epoch: "terminal-1",
    output_seq: "0",
    host_process: { process_id: 10, start_marker: "10-1" },
    provider_process: { process_id: 11, start_marker: "11-1" },
    endpoint: {
      kind: "unix_socket",
      address: "/secret/session.sock",
    },
    capability_token: "never-emit-this",
    capabilities: ["screen_snapshot"],
    ...overrides,
  };
}

describe("diagnose Hmux pane receipt", () => {
  it("preserves a valid unhealthy probe receipt emitted with exit 1", () => {
    const receipt = optionalHmuxJson(
      "hmux-fixture",
      ["session", "probe", "session-1"],
      () => {
        const error = new Error("expected unhealthy exit");
        error.status = 1;
        error.stdout =
          '{"schemaVersion":1,"ok":false,"sessionId":"session-1","workspaceId":"workspace-1","status":"stale_transport"}';
        throw error;
      },
    );

    expect(receipt).toMatchObject({
      ok: false,
      status: "stale_transport",
    });
  });

  it("groups the first transport mount by WebView generation", () => {
    const events = [
      {
        timestamp: "2026-07-28T00:00:00.100Z",
        event: "transport",
        state: "mounted",
        details: {
          webviewInstanceId: "webview-old",
          webviewStartedAt: "2026-07-28T00:00:00.000Z",
          webviewUptimeMs: 100,
        },
      },
      {
        timestamp: "2026-07-28T00:00:01.275Z",
        event: "transport",
        state: "mounted",
        details: {
          webviewInstanceId: "webview-new",
          webviewStartedAt: "2026-07-28T00:00:01.000Z",
          webviewUptimeMs: 275,
        },
      },
    ];

    expect(webviewRecoveryTimeline(events)).toEqual([
      expect.objectContaining({
        webviewInstanceId: "webview-old",
        firstTransportMountedAt: "2026-07-28T00:00:00.100Z",
      }),
      expect.objectContaining({
        webviewInstanceId: "webview-new",
        firstTransportMountedAt: "2026-07-28T00:00:01.275Z",
      }),
    ]);
  });

  it("resolves the sole ready session when an old session has the same name", () => {
    expect(
      resolveSession([
        session({ session_id: "old", lifecycle: "exited" }),
        session({ session_id: "current" }),
      ], "hebbian-ide-next").session_id,
    ).toBe("current");
  });

  it("correlates replica closures without emitting terminal bytes or authority", () => {
    const closed = (paneId, consumerId) => ({
      timestamp: "2026-07-28T00:00:00.000Z",
      event: "connection",
      sessionId: "standalone-1",
      workspaceId: "workspace-1",
      paneId,
      state: "disconnected",
      code: "hmux_transport_closed",
      details: {
        consumerId,
        windowLabel: "main",
        webviewInstanceId: "webview-1",
        controlActive: false,
        renderer: {
          droppedQueuedWrites: 24,
          secretTerminalText: "do not emit",
        },
        message: "private user path",
      },
    });
    const events = [
      {
        ...closed("desktop:term:one", "consumer-1"),
        event: "transport",
        state: "mounted",
        code: "hmux_transport_mounted",
      },
      {
        ...closed("desktop:term:two", "consumer-2"),
        event: "transport",
        state: "mounted",
        code: "hmux_transport_mounted",
      },
      closed("desktop:term:one", "consumer-1"),
      closed("desktop:term:two", "consumer-2"),
    ];
    const receipt = buildDiagnosticReceipt({
      session: session(),
      probe: {
        schemaVersion: 1,
        sessionId: "standalone-1",
        workspaceId: "workspace-1",
        status: "healthy",
      },
      snapshot: {
        schemaVersion: 1,
        sessionId: "standalone-1",
        workspaceId: "workspace-1",
        terminalEpoch: "terminal-1",
        sequenceThrough: "42",
        columns: 120,
        rows: 30,
        data: "base64-secret-terminal-frame",
      },
      journal: {
        schemaVersion: 2,
        updatedAt: "2026-07-28T00:00:01.000Z",
        events,
        incidents: events.filter(
          (event) => event.code === "hmux_transport_closed",
        ),
      },
      hmuxCliVersion: "hmux 0.1.1",
      installedBuildVersion: "0.1.1+new",
      generatedAt: "2026-07-28T00:00:02.000Z",
    });
    const serialized = JSON.stringify(receipt);

    expect(receipt.assessment).toMatchObject({
      hostHealthy: true,
      supportedReplicaCohortObserved: true,
      appTransportInterruptionWithLiveHost: true,
    });
    expect(receipt.appEvidence.simultaneousTransportClosures).toHaveLength(1);
    expect(receipt.appEvidence.recentTransitions).toHaveLength(4);
    expect(receipt.live.snapshot.sequenceThrough).toBe("42");
    expect(serialized).not.toContain("base64-secret-terminal-frame");
    expect(serialized).not.toContain("never-emit-this");
    expect(serialized).not.toContain("/secret/session.sock");
    expect(serialized).not.toContain("private user path");
    expect(serialized).not.toContain("do not emit");
  });

  it("keeps bounded background-observer failure posture in the receipt", () => {
    const event = {
      timestamp: "2026-09-04T00:00:00.000Z",
      lastTimestamp: "2026-09-04T00:01:00.000Z",
      repeatCount: 3,
      event: "managed_agent_semantic_observer",
      sessionId: "standalone-1",
      workspaceId: "workspace-1",
      paneId: "main-window-semantic-observer",
      state: "error",
      code: "hmux_session_not_found",
      details: {
        observationScope: "background",
        retryDirective: "never",
        phase: "attach",
        errorType: "HmuxStructuredTerminalAttachError",
      },
    };
    const receipt = buildDiagnosticReceipt({
      session: session(),
      journal: {
        schemaVersion: 2,
        updatedAt: event.lastTimestamp,
        events: [event],
        incidents: [event],
      },
      generatedAt: "2026-09-04T00:02:00.000Z",
    });

    expect(receipt.appEvidence.incidents).toEqual([
      expect.objectContaining({
        code: "hmux_session_not_found",
        observationScope: "background",
        retryDirective: "never",
        phase: "attach",
        errorType: "HmuxStructuredTerminalAttachError",
        repeatCount: 3,
        lastTimestamp: "2026-09-04T00:01:00.000Z",
      }),
    ]);
  });
});
