import { PROVIDER_SCREEN_FIXTURES } from "../provider-screens.mjs";

const recent = (clock, secondsAgo) => Date.parse(clock) / 1_000 - secondsAgo;

/**
 * A first-run fixture intentionally starts with no registered projects or
 * agents. The production onboarding pane discovers these provider-owned
 * records through the isolated Tauri bridge, lets the real React UI edit its
 * draft, and commits the resulting Dockview layout only after confirmation.
 */
export function createOnboardingWalkthroughScenario({ schemaVersion, clock }) {
  return {
    schemaVersion,
    id: "onboarding-walkthrough",
    title: "Onboarding from recent conversations",
    description:
      "Discover privacy-safe local and SSH conversations, edit the proposed workspace, and confirm real Dure panes.",
    clock,
    windowChrome: {
      platform: "macos",
      fullscreen: false,
    },
    viewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    },
    terminalRequired: false,
    expectedRecoveryOverlayCount: 0,
    liveTerminalSize: {
      columns: 66,
      rows: 26,
    },
    durationMs: 17_000,
    stillAtMs: 5_200,
    readmeGif: {
      schemaVersion: 1,
      segments: [{ startMs: 600, endMs: 6_200 }],
      fps: 12,
      width: 960,
      maxColors: 128,
      loop: 0,
    },
    publicWebm: {
      schemaVersion: 1,
      segments: [
        { startMs: 600, endMs: 6_200 },
        { startMs: 12_000, endMs: 17_000 },
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
      onboardingDismissed: false,
      desktops: [{ id: "desk-welcome", name: "Welcome" }],
      activeDesktopId: "desk-welcome",
      projects: [],
      agents: [],
      installedAgents: ["codex", "claude", "kimi"],
      agentActivity: {},
      gitStatuses: {},
      diffBadges: {},
      diffReviews: {},
      sshStates: {},
      sshHosts: [
        {
          id: "host-studio",
          name: "studio",
          host: "studio",
          port: 22,
          user: "dev",
          auth: "key",
          keyPath: "/workspace/keys/demo_ed25519",
        },
      ],
      providerConversations: [
        {
          provider: "codex",
          id: "conv-session-runtime",
          cwd: "/workspace/dure/.worktrees/session-runtime",
          title: "Session runtime",
          mtime: recent(clock, 24 * 60),
          resumeCapability: "exact",
          executionLocation: "local",
          repositoryRoot: "/workspace/dure",
          repositoryCommonDir: "/workspace/dure/.git",
          repositoryRemoteIdentity: "github.com/example/dure",
          branch: "agent/session-runtime",
          recentTurns: [
            {
              role: "user",
              text: "Trace the session handoff and verify the recovery boundary.",
            },
            {
              role: "agent",
              text: "The provider transcript stays authoritative; the UI receives only a bounded projection.",
            },
          ],
          subagentCount: 1,
        },
        {
          provider: "claude",
          id: "conv-onboarding-copy",
          cwd: "/workspace/dure/.worktrees/onboarding-copy",
          title: "Onboarding copy",
          mtime: recent(clock, 53 * 60),
          resumeCapability: "exact",
          executionLocation: "local",
          repositoryRoot: "/workspace/dure",
          repositoryCommonDir: "/workspace/dure/.git",
          repositoryRemoteIdentity: "github.com/example/dure",
          branch: "agent/onboarding-copy",
          recentTurns: [
            {
              role: "user",
              text: "Make the recent sessions hierarchy easier to scan.",
            },
            {
              role: "agent",
              text: "Project groups are flat, while each session reveals its own details on demand.",
            },
          ],
          subagentCount: 2,
        },
        {
          provider: "kimi",
          id: "conv-api-review",
          cwd: "/workspace/atlas-api/.worktrees/api-review",
          title: "API review",
          mtime: recent(clock, 82 * 60),
          resumeCapability: "exact",
          executionLocation: "ssh",
          hostId: "host-studio",
          repositoryRoot: "/workspace/atlas-api",
          repositoryCommonDir: "/workspace/atlas-api/.git",
          repositoryRemoteIdentity: "github.com/example/atlas-api",
        },
        {
          provider: "codex",
          id: "conv-older-release-notes",
          cwd: "/workspace/dure/.worktrees/release-notes",
          title: "Release notes",
          mtime: recent(clock, 12 * 24 * 60 * 60),
          resumeCapability: "exact",
          executionLocation: "local",
          repositoryRoot: "/workspace/dure",
          repositoryCommonDir: "/workspace/dure/.git",
          repositoryRemoteIdentity: "github.com/example/dure",
        },
      ],
      providerConversationDetails: [
        {
          provider: "codex",
          conversationId: "conv-session-runtime",
          executionLocation: "local",
          totalCount: 1,
          subagents: [
            {
              id: "child-runtime",
              title: "Trace session ownership",
              kind: "Explore",
              status: "completed",
              mtime: recent(clock, 31 * 60),
            },
          ],
        },
        {
          provider: "claude",
          conversationId: "conv-onboarding-copy",
          executionLocation: "local",
          totalCount: 2,
          subagents: [
            {
              id: "child-layout",
              title: "Review sidebar information hierarchy",
              kind: "Explore",
              status: "completed",
              mtime: recent(clock, 58 * 60),
            },
            {
              id: "child-copy",
              title: "Check action labels and empty states",
              kind: "Review",
              status: "unknown",
              mtime: recent(clock, 64 * 60),
            },
          ],
        },
      ],
      terminalScreensByCwd: {
        "/workspace/dure/.worktrees/session-runtime":
          PROVIDER_SCREEN_FIXTURES.codex,
        "/workspace/dure/.worktrees/onboarding-copy":
          PROVIDER_SCREEN_FIXTURES.claudeSafe,
        "/workspace/atlas-api/.worktrees/api-review":
          PROVIDER_SCREEN_FIXTURES.kimi,
      },
      terminalSnapshots: {},
    },
    setup: [],
    timeline: [
      {
        atMs: 600,
        action: "openOnboarding",
        desktopId: "desk-welcome",
        expectedDesktopCount: 2,
      },
      {
        atMs: 2_300,
        action: "renameOnboardingDesktop",
        desktopIndex: 0,
        name: "Dure Core",
      },
      {
        atMs: 4_000,
        action: "moveOnboardingPane",
        fromDesktopIndex: 1,
        toDesktopIndex: 0,
      },
      {
        atMs: 6_400,
        action: "confirmOnboarding",
        expectedPaneCount: 3,
        expectedTerminalMarkers: [
          "Goal achieved",
          "Newspapering",
          "SSH connected",
        ],
      },
    ],
  };
}
