const SOURCE_SCREEN = [
  "\u001b[1;36mdure\u001b[0m \u001b[2m· deploy-watch\u001b[0m",
  "",
  "$ git status --short --branch",
  "## agent/release-observer...origin/main",
  " M docs/public/operations/release.mdx",
  "",
  "$ pnpm test:release-smoke",
  "\u001b[32m  ✓ runtime handoff       18 tests\u001b[0m",
  "\u001b[32m  ✓ session checkpoint   27 tests\u001b[0m",
  "\u001b[32m  ✓ SSH reconnect        12 tests\u001b[0m",
  "",
  "\u001b[2mPresentation checkpoint saved · sequence 842\u001b[0m",
  "\u001b[2mWatching release evidence for changes…\u001b[0m",
  "$ ",
].join("\r\n");

const RESTORED_SCREEN = [
  "\u001b[1;36mdure\u001b[0m \u001b[2m· deploy-watch\u001b[0m",
  "",
  "\u001b[38;5;111mRecovered presentation checkpoint\u001b[0m",
  "  source terminal epoch   epoch-before-reboot",
  "  source sequence through 842",
  "  restored screen         complete",
  "",
  "$ git status --short --branch",
  "## agent/release-observer...origin/main",
  " M docs/public/operations/release.mdx",
  "",
  "\u001b[32m✓ Verified shell recipe restored\u001b[0m",
  "\u001b[32m✓ Pane binding retargeted atomically\u001b[0m",
  "\u001b[2mNew Host · new PTY · new terminal epoch\u001b[0m",
  "$ ",
].join("\r\n");

/**
 * A deterministic cold-start proof for the shipped Session Recovery surface.
 * The browser performs a real reload; only Hmux process/liveness facts are
 * supplied by the isolated backend fixture. The successor is deliberately a
 * new terminal epoch, matching the product's resurrection contract.
 */
export function createSessionRecoveryScenario({ schemaVersion, clock }) {
  const sourceSessionId = "session-deploy-watch-before-reboot";
  const replacementSessionId = "session-deploy-watch-restored";
  const workspaceId = "workspace-release-observer";
  return {
    schemaVersion,
    id: "session-recovery",
    title: "Session recovery after a cold start",
    description:
      "Reload Dure, inspect a reboot-stale shell, and restore its verified presentation into a fresh PTY.",
    clock,
    interfaceMode: "pro",
    windowChrome: {
      platform: "macos",
      fullscreen: false,
    },
    viewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    },
    terminalRequired: true,
    expectedRecoveryOverlayCount: 0,
    captureProof: {
      schemaVersion: 1,
      profile: "hmux-reboot-stale-recovery-v1",
    },
    liveTerminalSize: {
      columns: 96,
      rows: 30,
    },
    durationMs: 12_000,
    stillAtMs: 10_400,
    readmeGif: {
      schemaVersion: 1,
      segments: [
        { startMs: 400, endMs: 2_800 },
        { startMs: 3_520, endMs: 7_840 },
        { startMs: 8_240, endMs: 11_040 },
      ],
      fps: 12,
      width: 960,
      maxColors: 128,
      loop: 0,
    },
    publicWebm: {
      schemaVersion: 1,
      segments: [
        { startMs: 400, endMs: 2_800 },
        { startMs: 3_520, endMs: 7_840 },
        { startMs: 8_240, endMs: 11_040 },
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
    fixture: {
      language: "en",
      desktops: [{ id: "desk-1", name: "Release" }],
      activeDesktopId: "desk-1",
      projects: [
        {
          id: "project-dure",
          name: "dure",
          path: "/workspace/dure",
          kind: "local",
          isRepo: true,
        },
      ],
      sshHosts: [],
      agents: [],
      installedAgents: ["codex", "claude", "kimi"],
      agentActivity: {},
      agentDisplayStates: {},
      gitStatuses: {},
      diffBadges: {},
      diffReviews: {},
      sshStates: {},
      terminalScreensByCwd: {},
      terminalSnapshots: {
        [sourceSessionId]: SOURCE_SCREEN,
        [replacementSessionId]: RESTORED_SCREEN,
      },
      sessionRecovery: {
        schemaVersion: 1,
        source: {
          sessionId: sourceSessionId,
          sessionName: "deploy-watch",
          workspaceId,
          hostBuildVersion: "0.1.3+release-observer",
          terminalEpoch: "epoch-before-reboot",
          outputSeq: "842",
        },
        replacement: {
          sessionId: replacementSessionId,
          sessionName: "deploy-watch",
          workspaceId,
          hostBuildVersion: "0.1.4+current",
          terminalEpoch: "epoch-after-reboot",
          outputSeq: "3",
        },
        requiresConfirmation: true,
      },
    },
    setup: [
      {
        action: "openRecoveryTerminal",
        desktopId: "desk-1",
        sessionId: sourceSessionId,
        workspaceId,
        cwd: "/workspace/dure/.worktrees/release-observer",
      },
    ],
    timeline: [
      {
        atMs: 2_800,
        action: "reloadForSessionRecovery",
        desktopId: "desk-1",
        panelId: `term:${sourceSessionId}`,
        expectedBeforeMarker: "Presentation checkpoint saved",
      },
      {
        atMs: 4_800,
        action: "openSessionRecovery",
        sessionName: "deploy-watch",
      },
      {
        atMs: 6_800,
        action: "confirmSessionRecovery",
        sourceSessionId,
        replacementSessionId,
        workspaceId,
        sessionName: "deploy-watch",
        expectedAfterMarker: "New Host · new PTY · new terminal epoch",
      },
      {
        atMs: 8_400,
        action: "showRecoveredTerminal",
        desktopId: "desk-1",
        replacementSessionId,
        expectedMarker: "Recovered presentation checkpoint",
      },
      { atMs: 9_200, action: "focusTerminal", desktopId: "desk-1" },
    ],
  };
}
