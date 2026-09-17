import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendHmuxConnectionDiagnostic,
  HmuxConnectionDiagnosticBatchWriter,
  hmuxConnectionDiagnosticsPath,
  hmuxDiagnosticWebviewIdentity,
  recordHmuxInputFailureDiagnostic,
  type HmuxConnectionDiagnosticEvent,
  type HmuxConnectionDiagnosticJournal,
  type HmuxConnectionDiagnosticJournalV1,
} from "@/lib/hmux/identity/hmuxConnectionDiagnostics";

afterEach(() => {
  vi.unstubAllEnvs();
});

function journal(): HmuxConnectionDiagnosticJournal {
  return {
    schemaVersion: 2,
    updatedAt: new Date(0).toISOString(),
    events: [],
    incidents: [],
  };
}

describe("appendHmuxConnectionDiagnostic", () => {
  it("records the exact recovery code and renderer context", () => {
    const next = appendHmuxConnectionDiagnostic(
      journal(),
      {
        event: "connection",
        sessionId: "standalone-1",
        workspaceId: "workspace-1",
        paneId: "desktop:pane",
        runtime: "hmux_standalone_v1",
        state: "recovering",
        code: "hmux_observer_pending",
        details: {
          onScreen: true,
          presentationActive: true,
          activeBytes: 0,
        },
      },
      "2026-07-28T00:00:00.000Z",
    );

    expect(next.events).toEqual([
      expect.objectContaining({
        event: "connection",
        code: "hmux_observer_pending",
        timestamp: "2026-07-28T00:00:00.000Z",
        details: {
          onScreen: true,
          presentationActive: true,
          activeBytes: 0,
        },
      }),
    ]);
    expect(next.incidents).toEqual([]);
  });

  it("keeps only the latest bounded event window", () => {
    let current = journal();
    for (let index = 0; index < 517; index += 1) {
      current = appendHmuxConnectionDiagnostic(current, {
        event: `event-${index}`,
        sessionId: "standalone-1",
        paneId: "pane-1",
      });
    }

    expect(current.events).toHaveLength(512);
    expect(current.events[0]?.event).toBe("event-5");
    expect(current.events[511]?.event).toBe("event-516");
  });

  it("retains an incident after routine health events rotate", () => {
    let current = appendHmuxConnectionDiagnostic(journal(), {
      event: "connection",
      sessionId: "standalone-1",
      paneId: "pane-1",
      state: "disconnected",
      code: "hmux_transport_closed",
    });
    for (let index = 0; index < 517; index += 1) {
      current = appendHmuxConnectionDiagnostic(current, {
        event: "health",
        sessionId: "standalone-1",
        paneId: "pane-1",
        state: "live",
        code: `healthy-${index}`,
      });
    }

    expect(current.events.some((event) => event.code === "hmux_transport_closed")).toBe(false);
    expect(current.incidents).toEqual([
      expect.objectContaining({
        state: "disconnected",
        code: "hmux_transport_closed",
      }),
    ]);
  });

  it("retains typed subscriber backpressure recovery as an incident", () => {
    const next = appendHmuxConnectionDiagnostic(journal(), {
      event: "connection",
      sessionId: "standalone-1",
      paneId: "pane-1",
      state: "recovering",
      code: "hmux_resource_limit",
    });

    expect(next.incidents).toEqual([
      expect.objectContaining({
        state: "recovering",
        code: "hmux_resource_limit",
      }),
    ]);
  });

  it("migrates retained v1 incidents while appending a v2 event", () => {
    const previous: HmuxConnectionDiagnosticJournalV1 = {
      schemaVersion: 1,
      updatedAt: "2026-07-28T00:00:00.000Z",
      events: [
        {
          event: "health",
          sessionId: "standalone-1",
          paneId: "pane-1",
          state: "stale",
          code: "render_backlog",
          timestamp: "2026-07-28T00:00:00.000Z",
        },
      ],
    };

    const next = appendHmuxConnectionDiagnostic(previous, {
      event: "health",
      sessionId: "standalone-1",
      paneId: "pane-1",
      state: "live",
    });

    expect(next.schemaVersion).toBe(2);
    expect(next.incidents).toEqual([
      expect.objectContaining({ code: "render_backlog" }),
    ]);
  });
});

describe("HmuxConnectionDiagnosticBatchWriter", () => {
  function event(index: number, incident = false): HmuxConnectionDiagnosticEvent {
    return {
      event: `event-${index}`,
      sessionId: "standalone-1",
      paneId: "pane-1",
      state: incident ? "disconnected" : "live",
      timestamp: `2026-07-30T00:00:${String(index).padStart(2, "0")}.000Z`,
    };
  }

  it("persists a burst in bounded ordered batches", async () => {
    const scheduled: Array<() => void> = [];
    const persisted: HmuxConnectionDiagnosticEvent[][] = [];
    const writer = new HmuxConnectionDiagnosticBatchWriter(
      async (events) => {
        persisted.push(events);
      },
      { schedule: (callback) => scheduled.push(callback) },
    );

    for (let index = 0; index < 70; index += 1) writer.enqueue(event(index));
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled.shift()?.();
    await vi.waitFor(() => expect(persisted).toHaveLength(2));

    expect(persisted.map((batch) => batch.length)).toEqual([64, 6]);
    expect(persisted.flat().map((entry) => entry.event)).toEqual(
      Array.from({ length: 70 }, (_, index) => `event-${index}`),
    );
  });

  it("does not overlap persistence while the backend is slow", async () => {
    const scheduled: Array<() => void> = [];
    const persisted: HmuxConnectionDiagnosticEvent[][] = [];
    let releaseFirst!: () => void;
    const writer = new HmuxConnectionDiagnosticBatchWriter(
      (events) => {
        persisted.push(events);
        if (persisted.length > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
      { schedule: (callback) => scheduled.push(callback) },
    );

    for (let index = 0; index < 70; index += 1) writer.enqueue(event(index));
    scheduled.shift()?.();
    await vi.waitFor(() => expect(persisted).toHaveLength(1));
    writer.enqueue(event(70, true));
    expect(scheduled).toHaveLength(0);

    releaseFirst();
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled.shift()?.();
    await vi.waitFor(() => expect(persisted).toHaveLength(2));
    expect(persisted[1]?.map((entry) => entry.event)).toEqual([
      "event-64",
      "event-65",
      "event-66",
      "event-67",
      "event-68",
      "event-69",
      "event-70",
    ]);
  });
});

describe("hmuxDiagnosticWebviewIdentity", () => {
  it("keeps one boot identity and reports bounded recovery uptime", () => {
    const scope: Record<string, unknown> = {};
    const started = hmuxDiagnosticWebviewIdentity(
      scope,
      Date.parse("2026-07-28T00:00:00.000Z"),
    );
    const recovered = hmuxDiagnosticWebviewIdentity(
      scope,
      Date.parse("2026-07-28T00:00:00.275Z"),
    );

    expect(recovered.instanceId).toBe(started.instanceId);
    expect(recovered.startedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(recovered.uptimeMs).toBe(275);
  });
});

describe("recordHmuxInputFailureDiagnostic", () => {
  it("retains an exact bounded failure code without retaining input bytes", () => {
    const inputBytes = "private typed command";
    const record = vi.fn();
    recordHmuxInputFailureDiagnostic(
      record,
      new Error(`hmux_input_discarded_after_disconnect: ${inputBytes}`),
    );

    expect(record).toHaveBeenCalledWith(
      "input",
      "failed",
      "hmux_input_discarded_after_disconnect",
      { errorType: "Error" },
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(inputBytes);
  });

  it("uses a stable generic code for unstructured failures", () => {
    const record = vi.fn();
    recordHmuxInputFailureDiagnostic(record, "provider payload");

    expect(record).toHaveBeenCalledWith(
      "input",
      "failed",
      "hmux_input_write_failed",
      { errorType: "string" },
    );
  });

  it("classifies focus handoff cancellation without persisting typed input", () => {
    const record = vi.fn();
    recordHmuxInputFailureDiagnostic(
      record,
      new Error("Hmux controller pane lost focus before input could be sent"),
    );

    expect(record).toHaveBeenCalledWith(
      "input",
      "failed",
      "hmux_input_cancelled_focus_handoff",
      { errorType: "Error" },
    );
  });
});

describe("hmuxConnectionDiagnosticsPath", () => {
  it("uses the canonical Vite channel for the active journal", async () => {
    vi.stubEnv("VITE_DURE_APP_CHANNEL", "dev-canonical-a1b2c3d4");
    vi.stubEnv("VITE_HEBBIAN_APP_CHANNEL", "dev-legacy-decoy-a1b2c3d4");
    vi.resetModules();

    const diagnostics = await import(
      "@/lib/hmux/identity/hmuxConnectionDiagnostics"
    );

    expect(diagnostics.HMUX_CONNECTION_DIAGNOSTICS_PATH).toBe(
      "~/.dure/channels/dev-canonical-a1b2c3d4/hmux-connection-diagnostics.json",
    );
  });

  it("reports only canonical Dure paths for stable and isolated journals", () => {
    expect(hmuxConnectionDiagnosticsPath()).toBe(
      "~/.dure/hmux-connection-diagnostics.json",
    );
    expect(hmuxConnectionDiagnosticsPath("stable")).toBe(
      "~/.dure/hmux-connection-diagnostics.json",
    );
    expect(hmuxConnectionDiagnosticsPath("dev-feature-a-a1b2c3d4")).toBe(
      "~/.dure/channels/dev-feature-a-a1b2c3d4/hmux-connection-diagnostics.json",
    );
    expect(hmuxConnectionDiagnosticsPath("../stable")).toBe(
      "~/.dure/hmux-connection-diagnostics.json",
    );
  });
});
