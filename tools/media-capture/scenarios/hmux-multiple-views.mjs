const TERMINAL_SURFACE_PROBE_SCREEN = [
  "\u001b[1;36mdure\u001b[0m \u001b[2m\u00b7 two agents, Codex in two views\u001b[0m",
  "",
  "$ pnpm test:hmux-webview-recovery",
  "\u001b[32m\u2713\u001b[0m one TerminalSurface authority",
  "\u001b[32m\u2713\u001b[0m stale WebView input fenced",
  "\u001b[32m\u2713\u001b[0m successor presentation stayed live",
  "\u001b[32m\u2713\u001b[0m Host process generation unchanged",
  "",
  "\u001b[2mThe Codex workspace pane and large view share one Hmux session.\u001b[0m",
  "$ ",
].join("\r\n");

/**
 * Real-Tauri-only media scenario for the shipped Agent large-view action.
 * Browser capture refuses this scenario: its publication contract requires
 * tools/media-capture/native.mjs and two exact macOS window IDs.
 */
export function createHmuxMultipleViewsScenario({
  baseScenario,
  clock,
  schemaVersion,
}) {
  const fixture = structuredClone(baseScenario.fixture);
  const sourceAgent = fixture.agents.find(
    ({ id }) => id === "agent-session-recovery",
  );
  const sourceReviewer = fixture.agents.find(
    ({ id }) => id === "agent-docs-polish",
  );
  const sourceDiffReview = baseScenario.fixture.diffReviews[sourceAgent?.id];
  if (!sourceAgent || !sourceReviewer || !sourceDiffReview) {
    throw new Error("multiple-views scenario base evidence is missing");
  }

  const workspaceId = "workspace-runtime-observer";
  const agent = {
    ...sourceAgent,
    id: "agent-runtime-observer",
    name: "runtime-observer",
    branch: "agent/runtime-observer",
    worktreePath: "/workspace/dure/.worktrees/runtime-observer",
    sessionId: "session-codex-multiple-views",
    runtimeBinding: {
      schemaVersion: 1,
      runtime: "hmux_managed_v1",
      source: "local",
      hostId: "local",
      sessionId: "session-codex-multiple-views",
      workspaceId,
      createIdempotencyKey: "media-multiple-views-v1",
    },
    comment: "Watching the Codex Hmux session from two windows",
    commentUpdatedAt: Date.parse(clock) - 18_000,
  };
  const reviewer = {
    ...sourceReviewer,
    id: "agent-runtime-reviewer",
    name: "runtime-reviewer",
    branch: "agent/runtime-reviewer",
    worktreePath: "/workspace/dure/.worktrees/runtime-reviewer",
    sessionId: "session-claude-multiple-views",
    runtimeBinding: {
      schemaVersion: 1,
      runtime: "hmux_managed_v1",
      source: "local",
      hostId: "local",
      sessionId: "session-claude-multiple-views",
      workspaceId: "workspace-runtime-reviewer",
      createIdempotencyKey: "media-multiple-views-reviewer-v1",
    },
    comment: "Reviewing the same handoff from an isolated worktree",
    commentUpdatedAt: Date.parse(clock) - 12_000,
  };

  fixture.desktops = [{ id: "desk-observe", name: "Observe" }];
  fixture.activeDesktopId = "desk-observe";
  fixture.projects = fixture.projects.filter(({ id }) => id === "project-dure");
  fixture.sshHosts = [];
  fixture.agents = [agent, reviewer];
  fixture.installedAgents = ["codex", "claude", "kimi"];
  fixture.agentActivity = {
    [agent.id]: "working",
    [reviewer.id]: "working",
  };
  fixture.agentDisplayStates = {
    [agent.id]: "working",
    [reviewer.id]: "working",
  };
  fixture.gitStatuses = {
    [agent.id]: {
      isRepo: true,
      branch: agent.branch,
      ahead: 1,
      behind: 0,
      staged: 0,
      unstaged: 2,
      untracked: 0,
    },
    [reviewer.id]: {
      isRepo: true,
      branch: reviewer.branch,
      ahead: 1,
      behind: 0,
      staged: 0,
      unstaged: 1,
      untracked: 0,
    },
  };
  fixture.diffBadges = {
    [agent.id]: { added: 47, deleted: 6, binary: 0, files: 4 },
    [reviewer.id]: { added: 18, deleted: 2, binary: 0, files: 2 },
  };
  fixture.diffReviews = {
    [agent.id]: structuredClone(sourceDiffReview),
  };
  fixture.sshStates = {};
  fixture.terminalSnapshots = {
    [agent.sessionId]: baseScenario.fixture.terminalSnapshots["session-codex"],
    [reviewer.sessionId]:
      baseScenario.fixture.terminalSnapshots["session-claude"],
  };
  fixture.terminalSnapshotGeometry = {
    [agent.sessionId]: { columns: 92, rows: 40 },
    [reviewer.sessionId]: { columns: 54, rows: 40 },
  };
  fixture.terminalScreensByCwd = {
    "/workspace/dure/qa/terminal-surface": TERMINAL_SURFACE_PROBE_SCREEN,
  };

  return {
    schemaVersion,
    id: "hmux-multiple-views",
    title: "Two agents, Codex in two views",
    description:
      "Observe isolated Codex and Claude sessions together, hand Codex to a dynamically created real Tauri window, then open its actual diff.",
    clock,
    interfaceMode: "pro",
    windowChrome: { platform: "macos", fullscreen: false },
    viewport: { width: 1_920, height: 1_080, deviceScaleFactor: 1 },
    terminalRequired: true,
    expectedRecoveryOverlayCount: 0,
    captureProof: {
      schemaVersion: 1,
      profile: "hmux-native-view-handoff-v1",
    },
    nativeSessionWindowAgentId: agent.id,
    liveTerminalSize: { columns: 92, rows: 40 },
    liveProviderTerminalSizes: {
      claude: { columns: 54, rows: 40 },
    },
    durationMs: 13_000,
    stillAtMs: 12_200,
    fixture,
    setup: [
      {
        action: "openAgent",
        desktopId: "desk-observe",
        agentId: agent.id,
        replaceDefaultTerminal: true,
      },
      {
        action: "openAgent",
        desktopId: "desk-observe",
        agentId: reviewer.id,
        relativeToAgentId: agent.id,
        direction: "right",
      },
    ],
    timeline: [
      {
        atMs: 1_400,
        action: "openSessionWindow",
        desktopId: "desk-observe",
        agentId: agent.id,
      },
      {
        atMs: 4_500,
        action: "toggleWindowMaximize",
        desktopId: "desk-observe",
        agentId: agent.id,
        surface: "session",
        maximized: true,
      },
      {
        atMs: 7_000,
        action: "toggleWindowMaximize",
        desktopId: "desk-observe",
        agentId: agent.id,
        surface: "session",
        maximized: false,
      },
      {
        atMs: 8_500,
        action: "openDiff",
        desktopId: "desk-observe",
        agentId: agent.id,
      },
    ],
  };
}
