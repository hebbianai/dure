const RECONNECT_TERMINAL_SCREEN = [
  "\u001b[1;36mdure\u001b[0m \u001b[2m· hmux reconnect QA\u001b[0m",
  "",
  "$ pnpm test:hmux-webview-recovery",
  "\u001b[32m✓\u001b[0m client detach preserves Host generation     \u001b[2m41ms\u001b[0m",
  "\u001b[32m✓\u001b[0m reconnect replays canonical scrollback       \u001b[2m36ms\u001b[0m",
  "\u001b[32m✓\u001b[0m resumed output reaches the same pane          \u001b[2m29ms\u001b[0m",
  "",
  "\u001b[1;32mHmux webview recovery smoke passed\u001b[0m",
  "\u001b[2mWatching the client lifecycle…\u001b[0m",
  "$ ",
].join("\r\n");

/**
 * Demonstrates the shipped app-client reconnect contract. The provider pane
 * is backed by one live, isolated Hmux session for the complete generation;
 * the browser reload is the real lifecycle boundary captured in the video.
 */
export function createHmuxAppReconnectScenario({
  baseScenario,
  clock,
  schemaVersion,
}) {
  const fixture = structuredClone(baseScenario.fixture);
  const sourceAgent = fixture.agents.find(
    ({ id }) => id === "agent-session-recovery",
  );
  if (!sourceAgent) throw new Error("reconnect scenario base agent is missing");

  const agent = {
    ...sourceAgent,
    id: "agent-runtime-audit",
    name: "runtime-audit",
    branch: "agent/runtime-audit",
    worktreePath: "/workspace/dure/.worktrees/runtime-audit",
    sessionId: "session-codex-reconnect",
    runtimeBinding: {
      ...sourceAgent.runtimeBinding,
      sessionId: "session-codex-reconnect",
      createIdempotencyKey: "media-session-codex-reconnect",
    },
    comment: "Verifying Hmux client reconnect continuity",
    commentUpdatedAt: Date.parse(clock) - 21_000,
  };
  fixture.desktops = [{ id: "desk-live", name: "Live" }];
  fixture.activeDesktopId = "desk-live";
  fixture.projects = fixture.projects.filter(({ id }) => id === "project-dure");
  fixture.sshHosts = [];
  fixture.agents = [agent];
  fixture.installedAgents = ["codex", "claude", "kimi"];
  fixture.agentActivity = { [agent.id]: "working" };
  fixture.agentDisplayStates = { [agent.id]: "working" };
  fixture.gitStatuses = {
    [agent.id]: {
      isRepo: true,
      branch: agent.branch,
      ahead: 2,
      behind: 0,
      staged: 1,
      unstaged: 2,
      untracked: 0,
    },
  };
  fixture.diffBadges = {
    [agent.id]: { added: 84, deleted: 12, binary: 0, files: 5 },
  };
  fixture.diffReviews = {};
  fixture.sshStates = {};
  fixture.terminalSnapshots = {
    [agent.sessionId]: baseScenario.fixture.terminalSnapshots["session-codex"],
  };
  fixture.terminalScreensByCwd = {
    "/workspace/dure/qa/reconnect": RECONNECT_TERMINAL_SCREEN,
  };

  return {
    schemaVersion,
    id: "hmux-app-reconnect",
    title: "Agents survive an app reconnect",
    description:
      "Reload the Dure client while one Hmux-owned Codex session keeps its exact Host, provider, PTY, and scrollback generation.",
    clock,
    windowChrome: { platform: "macos", fullscreen: false },
    viewport: { width: 1_920, height: 1_080, deviceScaleFactor: 1 },
    terminalRequired: true,
    expectedRecoveryOverlayCount: 0,
    captureProof: {
      schemaVersion: 1,
      profile: "hmux-client-reconnect-v1",
    },
    liveTerminalSize: { columns: 101, rows: 49 },
    durationMs: 10_800,
    stillAtMs: 6_800,
    readmeGif: {
      schemaVersion: 1,
      segments: [
        { startMs: 480, endMs: 2_600 },
        { startMs: 2_720, endMs: 5_520 },
        { startMs: 5_600, endMs: 9_600 },
      ],
      fps: 12,
      width: 960,
      maxColors: 128,
      loop: 0,
    },
    publicWebm: {
      schemaVersion: 1,
      segments: [
        { startMs: 480, endMs: 2_600 },
        { startMs: 2_720, endMs: 5_520 },
        { startMs: 5_600, endMs: 9_600 },
      ],
      fps: 25,
      timeBase: "1/1000",
      width: 1_920,
      codec: "vp9",
      crf: 34,
      pixelFormat: "yuv420p",
      bitrateKbps: 0,
      deadline: "good",
      cpuUsed: 2,
      rowMt: 0,
      threads: 1,
    },
    fixture,
    setup: [
      {
        action: "openAgent",
        desktopId: "desk-live",
        agentId: agent.id,
        replaceDefaultTerminal: true,
      },
      {
        action: "openTerminal",
        desktopId: "desk-live",
        cwd: "/workspace/dure/qa/reconnect",
        direction: "right",
      },
    ],
    timeline: [
      {
        atMs: 2_700,
        action: "reloadAppClient",
        desktopId: "desk-live",
        panelId: `agent:${agent.id}`,
        sessionId: agent.sessionId,
        reconnectReadyAtMs: 5_300,
      },
      { atMs: 8_400, action: "focusTerminal", desktopId: "desk-live" },
    ],
  };
}
