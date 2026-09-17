import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WorkspacePerformanceTracker,
  type WorkspaceTransitionSample,
} from "@/lib/workspace/performance/workspacePerformance";
import { DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES } from "@/lib/workspace/performance/terminalResourceBudget";

describe("WorkspacePerformanceTracker", () => {
	it("reports retired render-pressure measurement as unavailable, not drained", () => {
		const tracker = new WorkspacePerformanceTracker(() => 0);
		expect(tracker.snapshot().render).toBeNull();
	});

  it("does not import retired terminal renderer modules into the product tracker", () => {
    const source = readFileSync(
      new URL("./workspacePerformance.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("/terminal/renderer/");
  });

  it("reports the latest shell-cache decision and inactive presentation activity", () => {
    const tracker = new WorkspacePerformanceTracker(() => 0);
    tracker.recordWorkspaceCacheDecision({
      budget: {
        maxWorkspaces: 6,
        maxTerminalSurfaces: 14,
        retainedWorkspaces: 12,
        retainedTerminalModelBytes: 2_048,
        reason: "high-resource",
      },
      occupancy: {
        total: {
          workspaces: 2,
          projectedTerminalSurfaces: 8,
          projectedTerminalModelBytes: 1_200,
        },
        warm: {
          workspaces: 1,
          projectedTerminalSurfaces: 3,
          projectedTerminalModelBytes: 400,
        },
        frozen: {
          workspaces: 1,
          projectedTerminalSurfaces: 5,
          projectedTerminalModelBytes: 800,
        },
      },
    });
    tracker.registerTerminal({
      id: "terminal-background",
      desktopId: "desktop-frozen",
      runtime: "hmux",
      renderer: "dom",
    });

    expect(tracker.snapshot().workspaceCache).toEqual({
      budget: {
        maxWorkspaces: 6,
        maxTerminalSurfaces: 14,
        retainedWorkspaces: 12,
        retainedTerminalModelBytes: 2_048,
        reason: "high-resource",
      },
      occupancy: {
        total: {
          workspaces: 2,
          projectedTerminalSurfaces: 8,
          projectedTerminalModelBytes: 1_200,
        },
        warm: {
          workspaces: 1,
          projectedTerminalSurfaces: 3,
          projectedTerminalModelBytes: 400,
        },
        frozen: {
          workspaces: 1,
          projectedTerminalSurfaces: 5,
          projectedTerminalModelBytes: 800,
        },
      },
      backgroundPresentation: {
        terminalSurfaces: 1,
        recentWriterSurfaces: null,
        bufferedBytes: null,
        maxRecentWriteLatencyMs: null,
      },
    });
  });

  it("liveWebglContextCount는 등록부의 webgl 렌더러만 O(n)으로 센다", () => {
    // Request-time severe-overshoot predicate input — must not need a full
    // snapshot (those stay reconcile-time-only).
    const tracker = new WorkspacePerformanceTracker(() => 0);
    const unmount = tracker.mountWorkspace("desktop-1");
    const first = tracker.registerTerminal({
      id: "terminal-1",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "webgl",
    });
    const second = tracker.registerTerminal({
      id: "terminal-2",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "dom",
    });
    expect(tracker.liveWebglContextCount()).toBe(1);
    second.updateRenderer("webgl");
    expect(tracker.liveWebglContextCount()).toBe(2);
    first.updateRenderer("dom");
    expect(tracker.liveWebglContextCount()).toBe(1);
    second.dispose();
    expect(tracker.liveWebglContextCount()).toBe(0);
    first.dispose();
    unmount();
  });

	it("retires active per-surface projection work with the terminal registration", () => {
		const tracker = new WorkspacePerformanceTracker(() => 0);
		const terminal = tracker.registerTerminal({
			id: "terminal-1",
			desktopId: "desktop-1",
			runtime: "hmux",
			renderer: "dom",
		});
		terminal.recordProjection("background", {
			projectionStartedAt: 4,
			projectionCommittedAt: 7,
		});
		expect(tracker.snapshot().terminalPresentation).toMatchObject({
			total: { commits: 1, totalMs: 3, maxMs: 3 },
			perSurface: [{ id: "terminal-1", total: { commits: 1 } }],
		});

		terminal.dispose();
		terminal.recordProjection("background", {
			projectionStartedAt: 7,
			projectionCommittedAt: 70,
		});
		expect(tracker.snapshot().terminalPresentation).toMatchObject({
			total: { commits: 1, totalMs: 3, maxMs: 3 },
			perSurface: [],
		});
	});

  it("records transition paint, attach latency, and workspace renderer resources", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    let resourceChanges = 0;
    const stopResourceWatch = tracker.onTerminalResourcesChanged(() => {
      resourceChanges += 1;
    });
    // Real cold-switch order: the transition begins, then the workspace mounts.
    tracker.beginTransition("desktop-1", false);
    const unmount = tracker.mountWorkspace("desktop-1");
    now = 4;
    const transitionSequence = tracker.markWorkspaceCommit("desktop-1");
    now = 5;
    tracker.markWorkspaceCommitMicrotask(transitionSequence as number);
    now = 7;
    tracker.markWorkspaceCommitMessageTask(transitionSequence as number);
    now = 12;
    tracker.markWorkspaceFirstFrame("desktop-1");
    now = 16;
    tracker.markWorkspacePaint("desktop-1");
    const terminal = tracker.registerTerminal({
      id: "terminal-1",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "webgl",
    });
    terminal.updateGpuViewportBytes(45_678);
    terminal.updateModelBytes(12_345);
    tracker.markTerminalPresentationRequested("terminal-1");
    now = 46;
    tracker.markTerminalPaint("terminal-1");
		now = 52;
		tracker.markTerminalInteractive("terminal-1");

    const snapshot = tracker.snapshot();
    expect(snapshot.transitions[0]).toMatchObject({
      warm: false,
      workspaceCommitMs: 4,
      workspaceCommitMicrotaskMs: 5,
      workspaceCommitMessageTaskMs: 7,
      workspaceFirstFrameMs: 12,
      workspacePaintMs: 16,
      firstTerminalPaintMs: 46,
			firstInteractivePaneMs: 52,
			firstInteractiveTerminalId: "terminal-1",
      // Cold remount cost is isolated from pre-mount work: the workspace
      // mounted at t=0 and the first terminal painted at t=46.
      remountCostMs: 46,
      // Attach+hydration portion measured in this present cycle (16→46).
      remountAttachMs: 30,
    });
    expect(snapshot.workspaces[0]).toEqual({
      desktopId: "desktop-1",
      mounted: true,
      terminalSurfaces: 1,
      visibleTerminalSurfaces: 0,
      terminalGpuViewportBytes: 45_678,
      terminalModelBytes: 12_345,
      webglContexts: 1,
      hmuxObservers: 1,
      maxTerminalAttachMs: 30,
    });
    expect(snapshot.render).toBeNull();

    terminal.updateRenderer("dom");
    terminal.dispose();
    stopResourceWatch();
    unmount();
    expect(resourceChanges).toBe(5);
    expect(tracker.snapshot().totals).toEqual({
      mountedWorkspaces: 0,
      terminalSurfaces: 0,
      terminalGpuViewportBytes: 0,
      terminalModelBytes: 0,
      webglContexts: 0,
      hmuxObservers: 0,
    });
  });

  it("fences asynchronous commit checkpoints to the exact transition", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    tracker.beginTransition("desktop-1", "cold", 0, "initial");
    now = 4;
    const staleSequence = tracker.markWorkspaceCommit("desktop-1");

    now = 8;
    tracker.beginTransition("desktop-2", "renderer", 8, "revisit");
    const currentSequence = tracker.markWorkspaceCommit("desktop-2");
    now = 9;
    tracker.markWorkspaceCommitMicrotask(staleSequence as number);
    tracker.markWorkspaceCommitMessageTask(staleSequence as number);
    tracker.markWorkspaceCommitMicrotask(currentSequence as number);
    now = 11;
    tracker.markWorkspaceCommitMessageTask(currentSequence as number);

    expect(tracker.snapshot().transitions).toMatchObject([
      {
        workspaceCommitMs: 4,
        workspaceCommitMicrotaskMs: null,
        workspaceCommitMessageTaskMs: null,
      },
      {
        workspaceCommitMs: 0,
        workspaceCommitMicrotaskMs: 1,
        workspaceCommitMessageTaskMs: 3,
      },
    ]);
  });

  it("isolates cold remount cost from pre-mount work; warm transitions keep null", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    tracker.beginTransition("desktop-1", false);
    now = 30; // store update + LRU reconcile before the workspace mounts
    tracker.mountWorkspace("desktop-1");
    tracker.registerTerminal({
      id: "terminal-1",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "webgl",
    });
    now = 80;
    tracker.markTerminalPaint("terminal-1");

    tracker.beginTransition("desktop-1", true);
    now = 90;
    tracker.markTerminalPaint("terminal-1");

    const transitions = tracker.snapshot().transitions;
    expect(transitions[0]).toMatchObject({
      warm: false,
      firstTerminalPaintMs: 80,
      remountCostMs: 50,
      // 이번 사이클에 presentation 요청이 없었으면 stale 값을 쓰지 않는다.
      remountAttachMs: null,
    });
    expect(transitions[1]).toMatchObject({
      warm: true,
      firstTerminalPaintMs: 10,
      remountCostMs: null,
    });
  });

  it("fails closed when a terminal reports non-finite memory costs", () => {
    const tracker = new WorkspacePerformanceTracker(() => 0);
    const terminal = tracker.registerTerminal({
      id: "terminal-invalid",
      desktopId: "desktop-1",
      runtime: "legacy",
      renderer: "dom",
    });

    expect(tracker.snapshot().workspaces[0].terminalGpuViewportBytes).toBe(
      DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES,
    );
    terminal.updateGpuViewportBytes(Number.POSITIVE_INFINITY);
    terminal.updateModelBytes(Number.NaN);

    expect(tracker.snapshot().workspaces[0].terminalGpuViewportBytes).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(tracker.snapshot().workspaces[0].terminalModelBytes).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("abandons a stale transition instead of recording a late paint as an outlier", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    tracker.beginTransition("desktop-1", false);
    tracker.mountWorkspace("desktop-1");
    tracker.registerTerminal({
      id: "terminal-1",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "webgl",
    });
    // A terminal painting long after the switch (e.g. opened by hand later)
    // must not be attributed to the stale transition.
    now = 20_000;
    tracker.markTerminalPaint("terminal-1");

    const [sample] = tracker.snapshot().transitions;
    expect(sample.firstTerminalPaintMs).toBeNull();
    expect(sample.remountCostMs).toBeNull();

    // The transition is fully abandoned — a second late paint stays ignored.
    now = 20_016;
    tracker.markTerminalPaint("terminal-1");
    expect(tracker.snapshot().transitions[0].firstTerminalPaintMs).toBeNull();
  });

  it("records first and all visible-pane paint/stable readiness separately", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    const first = tracker.registerTerminal({
      id: "terminal-first",
      desktopId: "desktop-1",
      runtime: "legacy",
      renderer: "dom",
    });
    const slow = tracker.registerTerminal({
      id: "terminal-slow",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "dom",
    });
    tracker.registerTerminal({
      id: "terminal-hidden-tab",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "dom",
    });

    tracker.beginTransition("desktop-1", "model");
    first.updateVisibility(true);
    slow.updateVisibility(true);
    now = 16;
    tracker.markWorkspacePaint("desktop-1");
    tracker.sealVisibleTerminals("desktop-1");
    const sequence = tracker.currentTransitionSequence("desktop-1");

    now = 30;
    tracker.markTerminalPaintForTransition("terminal-first", sequence);
    now = 45;
    tracker.markTerminalStable("terminal-first", sequence);
    let sample = tracker.snapshot().transitions[0];
    expect(sample).toMatchObject({
      expectedTerminalPanes: 2,
      paintedTerminalPanes: 1,
      stableTerminalPanes: 1,
      firstTerminalPaintMs: 30,
      allTerminalPaintMs: null,
      firstTerminalStableMs: 45,
      allTerminalStableMs: null,
      terminalPaintRanksMs: [30],
      terminalStableRanksMs: [45],
    });

    now = 70;
    tracker.markTerminalPaintForTransition("terminal-slow", sequence);
    now = 95;
    tracker.markTerminalStable("terminal-slow", sequence);
    // A later re-settle must not move the completion timestamp.
    now = 120;
    tracker.markTerminalStable("terminal-slow", sequence);
    sample = tracker.snapshot().transitions[0];
    expect(sample).toMatchObject({
      paintedTerminalPanes: 2,
      stableTerminalPanes: 2,
      allTerminalPaintMs: 70,
      allTerminalStableMs: 95,
      terminalPaintRanksMs: [30, 70],
      terminalStableRanksMs: [45, 95],
      slowestTerminalId: "terminal-slow",
    });
  });

  it("counts deferred terminal construction without inflating resource totals", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    tracker.beginTransition("desktop-1", "cold");
    tracker.registerExpectedTerminal({
      id: "terminal-deferred",
      desktopId: "desktop-1",
      panelId: "term:deferred",
      visible: true,
    });
    expect(
      tracker.hasExpectedTerminalPanels("desktop-1", ["term:deferred"]),
    ).toBe(true);
    expect(
      tracker.hasExpectedTerminalPanels("desktop-1", ["term:missing"]),
    ).toBe(false);
    tracker.sealVisibleTerminals("desktop-1");

    let snapshot = tracker.snapshot();
    expect(snapshot.transitions[0]).toMatchObject({
      expectedTerminalPanes: 1,
      paintedTerminalPanes: 0,
      stableTerminalPanes: 0,
    });
    expect(snapshot.totals.terminalSurfaces).toBe(0);

    tracker.registerTerminal({
      id: "terminal-deferred",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "dom",
      visible: true,
    });
    const sequence = tracker.currentTransitionSequence("desktop-1");
    now = 40;
    tracker.markTerminalPaintForTransition("terminal-deferred", sequence);
    now = 60;
    tracker.markTerminalStable("terminal-deferred", sequence);

    snapshot = tracker.snapshot();
    expect(snapshot.transitions[0]).toMatchObject({
      expectedTerminalPanes: 1,
      paintedTerminalPanes: 1,
      stableTerminalPanes: 1,
      allTerminalPaintMs: 40,
      allTerminalStableMs: 60,
    });
    expect(snapshot.totals.terminalSurfaces).toBe(1);
  });

  it("matches expected and attached production panels on the exact desktop", () => {
    const tracker = new WorkspacePerformanceTracker();
    tracker.registerExpectedTerminal({
      id: "terminal-deferred",
      desktopId: "desktop-1",
      panelId: "term:deferred",
      visible: true,
    });
    tracker.registerTerminal({
      id: "terminal-live",
      desktopId: "desktop-1",
      panelId: "term:live",
      runtime: "hmux",
      renderer: "dom",
      visible: true,
    });
    tracker.registerTerminal({
      id: "terminal-other-desktop",
      desktopId: "desktop-2",
      panelId: "term:other-desktop",
      runtime: "hmux",
      renderer: "dom",
      visible: true,
    });
    tracker.registerTerminal({
      id: "terminal-without-panel",
      desktopId: "desktop-1",
      runtime: "hmux",
      renderer: "dom",
      visible: true,
    });

    expect(
      tracker.hasExpectedTerminalPanels("desktop-1", [
        "term:deferred",
        "term:live",
      ]),
    ).toBe(true);
    expect(
      tracker.hasExpectedTerminalPanels("desktop-1", [
        "term:other-desktop",
      ]),
    ).toBe(false);
    expect(
      tracker.hasExpectedTerminalPanels("desktop-1", ["terminal-without-panel"]),
    ).toBe(false);
  });

  it("rejects a stale stable callback after leaving and returning to a desktop", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    const terminal = tracker.registerTerminal({
      id: "terminal-1",
      desktopId: "desktop-1",
      runtime: "legacy",
      renderer: "dom",
      visible: true,
    });
    tracker.beginTransition("desktop-1", "model");
    tracker.sealVisibleTerminals("desktop-1");
    const staleSequence = tracker.currentTransitionSequence("desktop-1");

    terminal.updateVisibility(false);
    tracker.beginTransition("desktop-2", "renderer");
    terminal.updateVisibility(true);
    tracker.beginTransition("desktop-1", "model");
    tracker.sealVisibleTerminals("desktop-1");
    const currentSequence = tracker.currentTransitionSequence("desktop-1");
    now = 50;
    tracker.markTerminalStable("terminal-1", staleSequence);
    expect(tracker.snapshot().transitions[2].allTerminalStableMs).toBeNull();

    now = 65;
    tracker.markTerminalStable("terminal-1", currentSequence);
    expect(tracker.snapshot().transitions[2]).toMatchObject({
      firstTerminalStableMs: 65,
      allTerminalStableMs: 65,
    });
  });

  it("does not attribute a paint captured outside a transition to a later switch", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    const terminal = tracker.registerTerminal({
      id: "terminal-1",
      desktopId: "desktop-1",
      runtime: "legacy",
      renderer: "dom",
      visible: true,
    });
    const stalePaint = tracker.captureTerminalPaint(
      "terminal-1",
      "desktop-1",
    );

    now = 10;
    tracker.beginTransition("desktop-1", "model");
    terminal.updateVisibility(true);
    tracker.sealVisibleTerminals("desktop-1");
    now = 20;
    stalePaint();

    expect(tracker.snapshot().transitions[0].firstTerminalPaintMs).toBeNull();
  });

  it("bounds retained transition history", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    for (let index = 0; index < 100; index += 1) {
      tracker.beginTransition(`desktop-${index}`, index % 2 === 0);
      now += 1;
    }
    const transitions =
      tracker.snapshot().transitions as readonly WorkspaceTransitionSample[];
    expect(transitions).toHaveLength(96);
    expect(transitions[0].sequence).toBe(5);
    expect(transitions[95].sequence).toBe(100);
  });

  it("retains the initial workspace sample across a long-running transition history", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    tracker.beginTransition("desktop-initial", "cold", 0, "initial");
    for (let index = 0; index < 100; index += 1) {
      now += 1;
      tracker.beginTransition(`desktop-${index}`, "renderer", now, "revisit");
    }

    const transitions = tracker.snapshot().transitions;
    expect(transitions).toHaveLength(96);
    expect(transitions[0]).toMatchObject({
      desktopId: "desktop-initial",
      visitKind: "initial",
    });
    expect(transitions[transitions.length - 1]?.sequence).toBe(101);
  });

  it("measures active-pane paint and terminal interactive handoff separately", () => {
    let now = 100;
    const tracker = new WorkspacePerformanceTracker(() => now);
    tracker.registerTerminal({
      id: "terminal-1",
      desktopId: "desktop-1",
      panelId: "term:one",
      runtime: "hmux",
      renderer: "dom",
    });

    const sequence = tracker.beginPaneFocus(
      "desktop-1",
      "term:one",
      true,
      90,
    );
    now = 105;
    tracker.markPaneFocusCommit(sequence);
    tracker.markPaneFocusEventMicrotask(sequence);
    tracker.markPaneFocusEventMessageTask(sequence);
    tracker.markPaneFocusEventTask(sequence);
    now = 108;
    tracker.markPaneFocusFrame(sequence);
    tracker.markTerminalFocusGeometry("desktop-1", "term:one", 3);
    tracker.markTerminalFocusRoleCommit("desktop-1", "term:one", 2);
    tracker.markTerminalInputFocusCallStart(
      "desktop-1",
      "term:one",
      108,
    );
    tracker.markTerminalInputFocusHandler("desktop-1", "term:one", {
      handlerStartedAt: 108.5,
      handlerEndedAt: 111.5,
      projectionMs: 1,
      intentDispatchMs: 1,
    });
    tracker.markTerminalInputFocus("desktop-1", "term:one", 4);
    now = 112;
    tracker.markPaneFocusPaint(sequence);

    expect(tracker.snapshot().paneFocus).toEqual([
      {
        sequence: 1,
        desktopId: "desktop-1",
        panelId: "term:one",
        terminal: true,
        startedAt: 90,
        commitMs: 15,
        eventMicrotaskMs: 15,
		eventMessageTaskMs: 15,
        eventTaskMs: 15,
        firstFrameMs: 18,
        commitToFirstFrameSchedulerActivity: {
          reveal: { unitsRun: 0, msSpent: 0, starvationRescues: 0 },
          catchup: { unitsRun: 0, msSpent: 0, starvationRescues: 0 },
          maintenance: { unitsRun: 0, msSpent: 0, starvationRescues: 0 },
        },
        localGeometryMs: 3,
        localGeometryCount: 1,
        terminalRoleCommitMs: 18,
        terminalRoleEffectMs: 2,
        terminalInputFocusCommitMs: 18,
        terminalInputFocusCallMs: 4,
        terminalInputFocusPreHandlerMs: 0.5,
        terminalInputFocusHandlerMs: 3,
        terminalInputFocusPostHandlerMs: 0.5,
        terminalInputFocusProjectionMs: 1,
        terminalInputFocusIntentDispatchMs: 1,
        terminalInputFocusNativeRemainderMs: 1,
        paintMs: 22,
        interactiveMs: 22,
        outcome: "complete",
      },
    ]);
  });

  it("times pane opens; first open of a kind is cold, later opens warm", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);

    // First "file" pane: pays the lazy-import cost → cold.
    tracker.beginPaneOpen("pane-a", "file");
    now = 120;
    tracker.markPaneReady("pane-a");
    // Second "file" pane: chunk cached → warm.
    tracker.beginPaneOpen("pane-b", "file");
    now = 130;
    tracker.markPaneReady("pane-b");

    const opens = tracker.snapshot().paneOpens;
    expect(opens).toHaveLength(2);
    expect(opens[0]).toMatchObject({ paneId: "pane-a", kind: "file", warm: false, openMs: 120 });
    expect(opens[1]).toMatchObject({ paneId: "pane-b", kind: "file", warm: true, openMs: 10 });
  });

  it("restarts the clock when a still-open paneId is reopened (no orphan sample)", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    tracker.beginPaneOpen("pane-x", "diff"); // never marked ready (e.g., unmounted)
    now = 5;
    tracker.beginPaneOpen("pane-x", "diff"); // reopened before the first completed
    now = 25;
    tracker.markPaneReady("pane-x");

    const opens = tracker.snapshot().paneOpens;
    // The orphan in-flight sample is dropped; only the completed one remains.
    expect(opens).toHaveLength(1);
    expect(opens[0].openMs).toBe(20);
  });

  it("cancelPaneOpen discards an in-flight sample but never a completed one", () => {
    let now = 0;
    const tracker = new WorkspacePerformanceTracker(() => now);
    tracker.beginPaneOpen("pane-gone", "agent:claude"); // closed before first paint
    tracker.cancelPaneOpen("pane-gone");
    tracker.beginPaneOpen("pane-done", "agent:claude");
    now = 40;
    tracker.markPaneReady("pane-done");
    tracker.cancelPaneOpen("pane-done"); // effect cleanup after completion — no-op

    const opens = tracker.snapshot().paneOpens;
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ paneId: "pane-done", openMs: 40 });
  });

  it("agent spawns: warm judged at start, only ok spawns mark the provider seen", () => {
    const tracker = new WorkspacePerformanceTracker(() => 0);

    // 실패 스폰은 provider를 seen에 넣지 않는다 — 재시도는 여전히 cold.
    expect(tracker.agentSpawnWarm("claude")).toBe(false);
    tracker.recordAgentReady("claude", {
      warm: false,
      ok: false,
      totalMs: 30000,
      preflightMs: 400,
      createMs: 29600,
    });
    expect(tracker.agentSpawnWarm("claude")).toBe(false);

    // 동시 cold 스폰 2건: 둘 다 시작 시점 warm=false로 기록된다.
    const warmA = tracker.agentSpawnWarm("claude");
    const warmB = tracker.agentSpawnWarm("claude");
    tracker.recordAgentReady("claude", {
      warm: warmA,
      ok: true,
      totalMs: 2000,
      preflightMs: 300,
      createMs: 1700,
    });
    tracker.recordAgentReady("claude", {
      warm: warmB,
      ok: true,
      totalMs: 2100,
      preflightMs: 350,
      createMs: 1750,
    });
    // 성공 이후의 새 스폰만 warm이 된다.
    expect(tracker.agentSpawnWarm("claude")).toBe(true);

    const samples = tracker.snapshot().agentReady;
    expect(samples.map((s) => [s.ok, s.warm])).toEqual([
      [false, false],
      [true, false],
      [true, false],
    ]);
  });
});
