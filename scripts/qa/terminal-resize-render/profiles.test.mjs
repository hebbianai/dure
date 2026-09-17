import { describe, expect, it } from "vitest";
import {
  TERMINAL_RESIZE_RENDER_PROFILES,
  resizeRenderPhase,
  selectedProviders,
} from "./profiles.mjs";
import { HELP, parseArguments } from "./run.mjs";
import {
  captureSnapshotSeed,
  validateSnapshotSeed,
} from "./snapshot-seed.mjs";

function status(provider, buffer, generation = 3) {
  const window = {
    bufferState: {
      fitDimensionsMatch: true,
      resizeRender: {
        provider,
        buffer,
        generation,
        terminalColumns: 120,
        terminalRows: 40,
        dimensionsMatch: true,
        footerVisible: true,
      },
    },
    renderMetrics: { snapshotCollapses: 4, maxWriteLatencyMs: 12 },
    resizeRenderIntegrity: {
      samples: 3,
      visibleFrames: 3,
      concealedFrames: 0,
      validFrames: 3,
      violationFrames: 0,
      lastGeneration: generation,
      violations: {},
    },
  };
  return { windows: { a: window, b: structuredClone(window) } };
}

describe("terminal resize render profiles", () => {
  it("keeps provider differences declarative", () => {
    expect(selectedProviders("all")).toEqual(["claude", "codex"]);
    expect(TERMINAL_RESIZE_RENDER_PROFILES.claude.buffer).toBe("alternate");
    expect(TERMINAL_RESIZE_RENDER_PROFILES.codex.buffer).toBe("normal");
  });

  it("accepts only synchronized complete provider frames", () => {
    expect(
      resizeRenderPhase(
        status("claude", "alternate"),
        TERMINAL_RESIZE_RENDER_PROFILES.claude,
        2,
      ),
    ).toMatchObject({ generation: 3, columns: 120, rows: 40 });
    expect(
      resizeRenderPhase(
        status("claude", "normal"),
        TERMINAL_RESIZE_RENDER_PROFILES.claude,
        2,
      ),
    ).toBeUndefined();
  });

  it("validates only the surviving source after the large window closes", () => {
    const candidate = status("claude", "alternate", 4);
    candidate.windows.b.bufferState.resizeRender.dimensionsMatch = false;
    expect(
      resizeRenderPhase(
        candidate,
        TERMINAL_RESIZE_RENDER_PROFILES.claude,
        3,
        ["a"],
      ),
    ).toMatchObject({ generation: 4, buffers: { a: "alternate" } });
  });

  it("rejects a final frame that recovered after an exposed invalid frame", () => {
    const candidate = status("claude", "alternate", 4);
    candidate.windows.a.resizeRenderIntegrity.violationFrames = 1;
    expect(
      resizeRenderPhase(
        candidate,
        TERMINAL_RESIZE_RENDER_PROFILES.claude,
        3,
      ),
    ).toBeUndefined();
  });

  it("requires local container fit only from the selected reference surface", () => {
    const candidate = status("claude", "alternate", 4);
    candidate.windows.b.bufferState.fitDimensionsMatch = false;
    expect(
      resizeRenderPhase(
        candidate,
        TERMINAL_RESIZE_RENDER_PROFILES.claude,
        3,
        ["a", "b"],
        "a",
      ),
    ).toMatchObject({ generation: 4 });
    expect(
      resizeRenderPhase(
        candidate,
        TERMINAL_RESIZE_RENDER_PROFILES.claude,
        3,
        ["a", "b"],
        "b",
      ),
    ).toBeUndefined();
  });

  it("parses a provider-specific read-only session run", () => {
    expect(
      parseArguments([
        "--",
        "--provider",
        "claude",
        "--session",
        "dure-frontend",
        "--workspace",
        "workspace-1",
        "--discovery-root",
        "/tmp/hmux",
      ]),
    ).toMatchObject({
      providers: ["claude"],
      session: "dure-frontend",
      workspace: "workspace-1",
    });
  });

  it("keeps help read-only and documents the focus gate", () => {
    expect(parseArguments(["--help"])).toMatchObject({ help: true });
    expect(HELP).toContain("HEBBIAN_QA_ALLOW_FOCUS_STEAL=1");
    expect(HELP).toContain("--workspace <hmux-workspace-id>");
  });

  it("rejects a snapshot whose identity differs from the selected session", () => {
    expect(() =>
      validateSnapshotSeed(
        {
          schemaVersion: 1,
          sessionId: "other",
          workspaceId: "workspace-1",
          rows: 24,
          columns: 80,
          data: "aGVsbG8=",
          alternateScreen: false,
          cursorVisible: true,
          truncated: false,
        },
        { session_id: "session-1", workspace_id: "workspace-1" },
      ),
    ).toThrow("invalid canonical snapshot seed");
  });

  it("rejects snapshot geometry outside the isolated renderer bound", () => {
    expect(() =>
      validateSnapshotSeed(
        {
          schemaVersion: 1,
          sessionId: "session-1",
          workspaceId: "workspace-1",
          rows: 24,
          columns: 1_001,
          data: "aGVsbG8=",
          alternateScreen: false,
          cursorVisible: true,
          truncated: false,
        },
        { session_id: "session-1", workspace_id: "workspace-1" },
      ),
    ).toThrow("invalid canonical snapshot seed");
  });

  it("copies an existing session through list and read-only snapshot only", () => {
    const calls = [];
    const execute = (_binary, args) => {
      calls.push(args);
      if (args.at(-1) === "ls") {
        return JSON.stringify([
          {
            session_id: "session-1",
            session_name: "dure-frontend",
            workspace_id: "workspace-1",
            lifecycle: "ready",
          },
        ]);
      }
      return JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-1",
        workspaceId: "workspace-1",
        rows: 24,
        columns: 80,
        data: "aGVsbG8=",
        alternateScreen: true,
        cursorVisible: true,
        truncated: false,
      });
    };

    expect(
      captureSnapshotSeed({
        target: "dure-frontend",
        workspace: "workspace-1",
        discoveryRoot: "/tmp/hmux",
        binary: "hmux-fixture",
        execute,
      }),
    ).toMatchObject({ sessionId: "session-1", alternateScreen: true });
    expect(calls).toEqual([
      ["--json", "--discovery-root", "/tmp/hmux", "ls"],
      [
        "--json",
        "--discovery-root",
        "/tmp/hmux",
        "session",
        "snapshot",
        "session-1",
        "--workspace",
        "workspace-1",
      ],
    ]);
  });
});
