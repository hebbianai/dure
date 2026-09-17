import { createProductTourScenarios } from "./scenarios/product-tour.mjs";
import { createSocialPaneLayoutScenario } from "./scenarios/social-pane-layout.mjs";
import { PROVIDER_SCREEN_FIXTURES } from "./provider-screens.mjs";
import { createOnboardingWalkthroughScenario } from "./scenarios/onboarding-walkthrough.mjs";
import { createSessionRecoveryScenario } from "./scenarios/session-recovery.mjs";
import { createHmuxAppReconnectScenario } from "./scenarios/hmux-app-reconnect.mjs";
import { createHmuxMultipleViewsScenario } from "./scenarios/hmux-multiple-views.mjs";
import { createDiffReviewWorkflowScenario } from "./scenarios/diff-review-workflow.mjs";
import { createSshImagePasteScenario } from "./scenarios/ssh-image-paste.mjs";
import { createHeadlessSpawnScenario } from "./scenarios/headless-spawn.mjs";
import { createOrchestrationChannelScenario } from "./scenarios/orchestration-channel.mjs";
import { createWorktreeLaunchScenario } from "./scenarios/worktree-launch.mjs";
import {
  createSpacesPaneMoveScenario,
  validateSpacesPaneMove,
} from "./scenarios/spaces-pane-move.mjs";
import {
  WORKSPACE_OVERVIEW_PUBLIC_WEBM,
  WORKSPACE_OVERVIEW_README_GIF,
} from "./scenarios/workspace-overview-recipes.mjs";
import {
  validatePublicWebmRecipe,
  validateReadmeGifRecipe,
} from "./runtime/recipe-validation.mjs";
import {
  DURE_DESKTOP_CAPTURE_STAGE,
  FULL_FRAME_CAPTURE_STAGE,
  validateCaptureStage,
} from "./runtime/capture-stage.mjs";
import {
  captureProofNeedsNativeTauri,
  captureProofValidationErrors,
} from "./runtime/capture-proof.mjs";

export const MEDIA_CAPTURE_SCHEMA_VERSION = 6;

const FIXED_CLOCK = "2026-07-31T09:30:00.000Z";
const ALLOWED_ACTIONS = new Set([
  "productTour",
  "advanceOrchestrationChannel",
  "activateDesktop",
  "clickSpace",
  "equalizeGridColumns",
  "floatAgent",
  "focusTerminal",
  "headlessSpawn",
  "openAgent",
  "openDiff",
  "openOnboarding",
  "openRecoveryTerminal",
  "openSessionWindow",
  "openSessionRecovery",
  "openTerminal",
  "pasteClipboardImage",
  "confirmSessionRecovery",
  "confirmOnboarding",
  "moveOnboardingPane",
  "moveSpacesPane",
  "renameOnboardingDesktop",
  "reloadForSessionRecovery",
  "reloadAppClient",
  "selectSpaceRange",
  "showRecoveredTerminal",
  "toggleWindowMaximize",
]);
const PRIVATE_DATA_PATTERNS = [
  /\/Users\//u,
  /\/home\//u,
  /(?:^|[^a-z])(?:localhost|127\.0\.0\.1)(?:[^a-z]|$)/iu,
  /@[a-z0-9.-]+\.[a-z]{2,}/iu,
  /(?:token|password|secret|credential)[=:]\S+/iu,
];
const generatedAdditions = (count, render) =>
  Array.from({ length: count }, (_, index) => `+${render(index + 1)}`);
const mediaManagedAgent = (agent) => {
  const workspaceId = `workspace-${agent.projectId}`;
  const common = {
    schemaVersion: 1,
    runtime: "hmux_managed_v1",
    sessionId: agent.sessionId,
    workspaceId,
    createIdempotencyKey: `media-${agent.sessionId}`,
  };
  const runtimeBinding =
    agent.sessionKind === "ssh"
      ? {
          ...common,
          source: "ssh",
          hostId: "host-buildbox",
          commandBridgeNonce: `bridge-${agent.sessionId}`,
          stopFence: {
            runnerPrincipal: "media-user",
            runnerInstance: `runner-${agent.sessionId}`,
            channelEpoch: "1",
            hostInstanceId: `host-${agent.sessionId}`,
            terminalEpoch: `epoch-${agent.sessionId}`,
          },
        }
      : { ...common, source: "local", hostId: "local" };
  return { ...agent, runtimeBinding };
};
const SESSION_RECOVERY_DIFF = [
  "diff --git a/hmux/crates/hmux-host/src/session_host.rs b/hmux/crates/hmux-host/src/session_host.rs",
  "index 8d77e20..e26b185 100644",
  "--- a/hmux/crates/hmux-host/src/session_host.rs",
  "+++ b/hmux/crates/hmux-host/src/session_host.rs",
  "@@ -418,6 +418,18 @@ async fn recover_session(request: RecoverRequest) {",
  ...Array.from(
    { length: 6 },
    (_, index) => `-    retired_generation.publish_pane(${index + 1}).await?;`,
  ),
  ...generatedAdditions(
    18,
    (index) =>
      `    recovery_plan.record_verified_pane(PaneId::from_raw(${index}));`,
  ),
  "",
  "diff --git a/hmux/crates/hmux-host/src/lib.rs b/hmux/crates/hmux-host/src/lib.rs",
  "index 0d1138a..fa250af 100644",
  "--- a/hmux/crates/hmux-host/src/lib.rs",
  "+++ b/hmux/crates/hmux-host/src/lib.rs",
  "@@ -90,1 +90,24 @@ mod recovery_tests {",
  "-    const RECOVERY_CASES: usize = 1;",
  ...generatedAdditions(
    24,
    (index) =>
      `    recovery_case!(${String(index).padStart(2, "0")}, all_panes_same_generation);`,
  ),
  "",
  "diff --git a/docs/operations/hmux-pane-diagnostics.md b/docs/operations/hmux-pane-diagnostics.md",
  "new file mode 100644",
  "index 0000000..51c3b9f",
  "--- /dev/null",
  "+++ b/docs/operations/hmux-pane-diagnostics.md",
  "@@ -0,0 +1,276 @@",
  ...generatedAdditions(
    276,
    (index) =>
      `${String(index).padStart(3, "0")}. Recovery evidence: sibling panes share one committed generation.`,
  ),
].join("\n");

const workspaceOverview = {
  schemaVersion: MEDIA_CAPTURE_SCHEMA_VERSION,
  id: "workspace-overview",
  title: "Parallel agent workspace",
  description:
    "Local and remote agents moving between three focused Dure desktops.",
  clock: FIXED_CLOCK,
  windowChrome: {
    platform: "macos",
    fullscreen: false,
  },
  viewport: {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
  },
  terminalFontSize: 10,
  liveTerminalSize: {
    columns: 77,
    rows: 29,
  },
  liveProviderTerminalSizes: {
    claude: { columns: 77, rows: 29 },
    kimi: { columns: 77, rows: 29 },
  },
  liveSessionTerminalSizes: {
    "session-codex": { columns: 81, rows: 30 },
  },
  durationMs: 15_000,
  stillAtMs: 3_000,
  readmeGif: WORKSPACE_OVERVIEW_README_GIF,
  publicWebm: WORKSPACE_OVERVIEW_PUBLIC_WEBM,
  fixture: {
    language: "en",
    desktops: [
      { id: "desk-launch", name: "Launch" },
      { id: "desk-review", name: "Review" },
      { id: "desk-operate", name: "Operate" },
    ],
    activeDesktopId: "desk-launch",
    projects: [
      {
        id: "project-dure",
        name: "dure",
        path: "/workspace/dure",
        kind: "local",
        isRepo: true,
      },
      {
        id: "project-atlas",
        name: "atlas-api",
        path: "/workspace/atlas-api",
        kind: "ssh",
        sshHostId: "host-buildbox",
        isRepo: true,
      },
    ],
    sshHosts: [
      {
        id: "host-buildbox",
        name: "buildbox",
        host: "buildbox",
        port: 22,
        user: "dev",
        auth: "key",
        keyPath: "/workspace/keys/demo_ed25519",
      },
    ],
    agents: [
      {
        id: "agent-session-recovery",
        name: "session-recovery",
        provider: "codex",
        projectId: "project-dure",
        worktreePath: "/workspace/dure/.worktrees/session-recovery",
        branch: "agent/session-recovery",
        sessionId: "session-codex",
        sessionKind: "pty",
        started: true,
        comment: "Reboot recovery smoke is green",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 42_000,
      },
      {
        id: "agent-docs-polish",
        name: "docs-polish",
        provider: "claude",
        projectId: "project-dure",
        worktreePath: "/workspace/dure/.worktrees/docs-polish",
        branch: "agent/docs-polish",
        sessionId: "session-claude",
        sessionKind: "pty",
        started: true,
        comment: "Polishing the public quickstart",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 91_000,
      },
      {
        id: "agent-keyboard-nav",
        name: "keyboard-nav",
        provider: "codex",
        projectId: "project-dure",
        worktreePath: "/workspace/dure/.worktrees/keyboard-nav",
        branch: "agent/keyboard-nav",
        sessionId: "session-codex-navigation",
        sessionKind: "pty",
        started: true,
        comment: "Polishing cross-pane navigation",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 53_000,
      },
      {
        id: "agent-test-triage",
        name: "test-triage",
        provider: "codex",
        projectId: "project-dure",
        worktreePath: "/workspace/dure/.worktrees/test-triage",
        branch: "agent/test-triage",
        sessionId: "session-codex-review",
        sessionKind: "pty",
        started: true,
        comment: "Eliminating a focus-transition flake",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 29_000,
      },
      {
        id: "agent-copy-review",
        name: "copy-review",
        provider: "claude",
        projectId: "project-dure",
        worktreePath: "/workspace/dure/.worktrees/copy-review",
        branch: "agent/copy-review",
        sessionId: "session-claude-review",
        sessionKind: "pty",
        started: true,
        comment: "Reviewing onboarding claims and captions",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 44_000,
      },
      {
        id: "agent-release-operator",
        name: "release-operator",
        provider: "codex",
        projectId: "project-dure",
        worktreePath: "/workspace/dure/.worktrees/release-operator",
        branch: "agent/release-operator",
        sessionId: "session-codex-operate",
        sessionKind: "pty",
        started: true,
        comment: "Assembling the desktop release candidate",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 18_000,
      },
      {
        id: "agent-rollout-watch",
        name: "rollout-watch",
        provider: "claude",
        projectId: "project-dure",
        worktreePath: "/workspace/dure/.worktrees/rollout-watch",
        branch: "agent/rollout-watch",
        sessionId: "session-claude-operate",
        sessionKind: "pty",
        started: true,
        comment: "Watching reconnect and render health",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 12_000,
      },
      {
        id: "agent-api-review",
        name: "api-review",
        provider: "kimi",
        projectId: "project-atlas",
        worktreePath: "/workspace/atlas-api/.worktrees/api-review",
        branch: "agent/api-review",
        sessionId: "session-kimi",
        sessionKind: "ssh",
        started: true,
        comment: "Reviewing the streaming contract",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 155_000,
      },
      {
        id: "agent-release-gate",
        name: "release-gate",
        provider: "opencode",
        projectId: "project-dure",
        worktreePath: "/workspace/dure/.worktrees/release-gate",
        branch: "agent/release-gate",
        sessionId: "session-release-gate",
        sessionKind: "pty",
        started: true,
        comment: "Checking the release evidence",
        commentUpdatedAt: Date.parse(FIXED_CLOCK) - 68_000,
      },
    ].map(mediaManagedAgent),
    installedAgents: ["claude", "codex", "gemini", "kimi", "opencode"],
    agentActivity: {
      "agent-session-recovery": "working",
      "agent-docs-polish": "working",
      "agent-keyboard-nav": "working",
      "agent-test-triage": "working",
      "agent-copy-review": "working",
      "agent-release-operator": "working",
      "agent-rollout-watch": "waiting",
      "agent-api-review": "waiting",
      "agent-release-gate": "working",
    },
    agentDisplayStates: {
      "agent-session-recovery": "working",
      "agent-docs-polish": "working",
      "agent-keyboard-nav": "working",
      "agent-test-triage": "working",
      "agent-copy-review": "working",
      "agent-release-operator": "working",
      "agent-rollout-watch": "waiting",
      "agent-api-review": "waiting",
      "agent-release-gate": "working",
    },
    gitStatuses: {
      "agent-session-recovery": {
        isRepo: true,
        branch: "agent/session-recovery",
        ahead: 3,
        behind: 0,
        staged: 2,
        unstaged: 1,
        untracked: 0,
      },
      "agent-docs-polish": {
        isRepo: true,
        branch: "agent/docs-polish",
        ahead: 1,
        behind: 0,
        staged: 0,
        unstaged: 4,
        untracked: 1,
      },
      "agent-keyboard-nav": {
        isRepo: true,
        branch: "agent/keyboard-nav",
        ahead: 2,
        behind: 0,
        staged: 1,
        unstaged: 0,
        untracked: 0,
      },
      "agent-test-triage": {
        isRepo: true,
        branch: "agent/test-triage",
        ahead: 2,
        behind: 0,
        staged: 1,
        unstaged: 2,
        untracked: 0,
      },
      "agent-copy-review": {
        isRepo: true,
        branch: "agent/copy-review",
        ahead: 1,
        behind: 0,
        staged: 0,
        unstaged: 3,
        untracked: 1,
      },
      "agent-release-operator": {
        isRepo: true,
        branch: "agent/release-operator",
        ahead: 4,
        behind: 0,
        staged: 3,
        unstaged: 0,
        untracked: 0,
      },
      "agent-rollout-watch": {
        isRepo: true,
        branch: "agent/rollout-watch",
        ahead: 1,
        behind: 0,
        staged: 0,
        unstaged: 1,
        untracked: 0,
      },
      "agent-api-review": {
        isRepo: true,
        branch: "agent/api-review",
        ahead: 0,
        behind: 1,
        staged: 0,
        unstaged: 2,
        untracked: 0,
      },
      "agent-release-gate": {
        isRepo: true,
        branch: "agent/release-gate",
        ahead: 2,
        behind: 0,
        staged: 1,
        unstaged: 2,
        untracked: 0,
      },
    },
    diffBadges: {
      "agent-session-recovery": {
        added: 318,
        deleted: 7,
        binary: 0,
        files: 3,
      },
      "agent-docs-polish": {
        added: 48,
        deleted: 3,
        binary: 0,
        files: 4,
      },
    },
    diffReviews: {
      "agent-session-recovery": {
        baseRef: "origin/main",
        mergeBase: "9f47c2a18d67c31d4be26009b8c4f02c26eb9531",
        headCommitSha: "e26b18502655fce06be550ed54df83aaf3c31987",
        files: [
          {
            path: "hmux/crates/hmux-host/src/session_host.rs",
            oldPath: null,
            added: 18,
            deleted: 6,
            status: "M",
          },
          {
            path: "hmux/crates/hmux-host/src/lib.rs",
            oldPath: null,
            added: 24,
            deleted: 1,
            status: "M",
          },
          {
            path: "docs/operations/hmux-pane-diagnostics.md",
            oldPath: null,
            added: 276,
            deleted: 0,
            status: "A",
          },
        ],
        diff: SESSION_RECOVERY_DIFF,
      },
    },
    sshStates: {
      "session-kimi": "connected",
    },
    terminalSnapshots: {
      "session-codex": PROVIDER_SCREEN_FIXTURES.codex,
      "session-claude": PROVIDER_SCREEN_FIXTURES.claude,
      "session-codex-navigation": PROVIDER_SCREEN_FIXTURES.codexNavigation,
      "session-codex-review": PROVIDER_SCREEN_FIXTURES.codexReview,
      "session-claude-review": PROVIDER_SCREEN_FIXTURES.claudeReview,
      "session-codex-operate": PROVIDER_SCREEN_FIXTURES.codexOperate,
      "session-claude-operate": PROVIDER_SCREEN_FIXTURES.claudeOperate,
      "session-kimi": [
        "\u001b[2m$ ssh dev@buildbox\u001b[0m",
        "\u001b[32m● SSH connected\u001b[0m \u001b[2m· ED25519 · 24ms\u001b[0m",
        "\u001b[1;33mdev@buildbox:/workspace/atlas-api · Kimi Code\u001b[0m",
        "",
        "\u001b[1mYou\u001b[0m",
        "Review the streaming reconnect contract for race conditions.",
        "",
        "\u001b[1;33mKimi\u001b[0m",
        "  ✓ reconnect is idempotent",
        "  ✓ stale observers are fenced",
        "  • one note for the retry budget",
        "",
        "› Writing review notes…\u001b[?25l",
      ].join("\r\n"),
      "session-release-gate": [
        "\u001b[1;32mDure · release-gate\u001b[0m",
        "",
        "\u001b[1mYou\u001b[0m",
        "Audit the release checklist and investigate any flaky smoke",
        "tests before we publish the docs.",
        "",
        "\u001b[1;32mOpenCode\u001b[0m",
        "✓ changed scopes classified",
        "✓ documentation links checked",
        "• comparing final artifact hashes",
        "",
        "› Preparing the release evidence…\u001b[?25l",
      ].join("\r\n"),
    },
    terminalScreensByCwd: {
      "/workspace/dure/qa/focus-tests": [
        "\u001b[1;36mdure/test-triage\u001b[0m \u001b[2m· vitest watch\u001b[0m",
        "",
        "$ pnpm vitest src/components/WorkspaceDeck.test.tsx --watch",
        "\u001b[32m✓\u001b[0m desktop switch preserves active pane       \u001b[2m12ms\u001b[0m",
        "\u001b[32m✓\u001b[0m warm layout restores terminal focus        \u001b[2m18ms\u001b[0m",
        "\u001b[32m✓\u001b[0m floating pane keeps independent bounds     \u001b[2m9ms\u001b[0m",
        "",
        "\u001b[1;32mTest Files  1 passed\u001b[0m \u001b[2m(1)\u001b[0m",
        "\u001b[1;32mTests      14 passed\u001b[0m \u001b[2m(14)\u001b[0m",
        "\u001b[2mWatching for file changes…\u001b[0m",
      ].join("\r\n"),
      "/workspace/dure/docs/link-check": [
        "\u001b[1;35mdure/copy-review\u001b[0m \u001b[2m· documentation\u001b[0m",
        "",
        "$ pnpm docs:links --changed",
        "scanning README.md                         \u001b[32mok\u001b[0m",
        "scanning public image references            \u001b[32mok\u001b[0m",
        "scanning Mintlify routes                    \u001b[32mok\u001b[0m",
        "",
        "\u001b[32m86 links valid\u001b[0m \u001b[2m· 4 images reachable · 0 redirects\u001b[0m",
        "$ git diff --stat",
        " README.md                         | 18 +++++++++++---",
        " docs/quickstart.mdx               | 11 +++++++--",
      ].join("\r\n"),
      "/workspace/dure/output/mac-build": [
        "\u001b[1;34mdure/release-operator\u001b[0m \u001b[2m· packaging\u001b[0m",
        "",
        "$ pnpm package:mac --profile release",
        "\u001b[36m◆\u001b[0m compiling desktop adapter          \u001b[32mdone\u001b[0m",
        "\u001b[36m◆\u001b[0m staging hmux runtime               \u001b[32mdone\u001b[0m",
        "\u001b[36m◆\u001b[0m assembling arm64 app bundle        \u001b[32mdone\u001b[0m",
        "\u001b[36m◆\u001b[0m generating checksums               \u001b[33mrunning\u001b[0m",
        "",
        "\u001b[2moutput/release/Dure-arm64.app · 184 MB\u001b[0m",
      ].join("\r\n"),
      "/workspace/dure/output/canary-logs": [
        "\u001b[1;33mrelease observation\u001b[0m \u001b[2m· live tail\u001b[0m",
        "",
        "$ tail -f output/release-observation.log",
        "14:31:08  cohort=canary   reconnect_p95=181ms  \u001b[32mhealthy\u001b[0m",
        "14:31:18  cohort=canary   render_backlog=0     \u001b[32mhealthy\u001b[0m",
        "14:31:28  cohort=canary   input_stalls=0       \u001b[32mhealthy\u001b[0m",
        "14:31:38  cohort=canary   sessions=48          \u001b[36mobserving\u001b[0m",
        "",
        "\u001b[2mnext sample in 10s…\u001b[0m",
      ].join("\r\n"),
    },
  },
  setup: [
    { action: "activateDesktop", desktopId: "desk-review" },
    {
      action: "openAgent",
      desktopId: "desk-review",
      agentId: "agent-test-triage",
      replaceDefaultTerminal: true,
    },
    {
      action: "openTerminal",
      desktopId: "desk-review",
      cwd: "/workspace/dure/qa/focus-tests",
      direction: "right",
    },
    {
      action: "openAgent",
      desktopId: "desk-review",
      agentId: "agent-copy-review",
      relativeToAgentId: "agent-test-triage",
      direction: "below",
    },
    {
      action: "openTerminal",
      desktopId: "desk-review",
      cwd: "/workspace/dure/docs/link-check",
      direction: "below",
    },
    { action: "activateDesktop", desktopId: "desk-operate" },
    {
      action: "openAgent",
      desktopId: "desk-operate",
      agentId: "agent-release-operator",
      replaceDefaultTerminal: true,
    },
    {
      action: "openTerminal",
      desktopId: "desk-operate",
      cwd: "/workspace/dure/output/mac-build",
      direction: "right",
    },
    {
      action: "openAgent",
      desktopId: "desk-operate",
      agentId: "agent-rollout-watch",
      relativeToAgentId: "agent-release-operator",
      direction: "below",
    },
    {
      action: "openTerminal",
      desktopId: "desk-operate",
      cwd: "/workspace/dure/output/canary-logs",
      direction: "below",
    },
    { action: "activateDesktop", desktopId: "desk-launch" },
    {
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-session-recovery",
    },
  ],
  timeline: [
    {
      atMs: 450,
      action: "floatAgent",
      desktopId: "desk-launch",
      agentId: "agent-session-recovery",
      width: 508,
      height: 467,
      left: 76,
      top: 300,
    },
    {
      atMs: 650,
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-api-review",
      relativeToTerminal: true,
      direction: "right",
    },
    {
      atMs: 800,
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-keyboard-nav",
      relativeToAgentId: "agent-api-review",
      direction: "right",
    },
    {
      atMs: 950,
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-docs-polish",
      relativeToAgentId: "agent-api-review",
      direction: "below",
    },
    {
      atMs: 1_100,
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-release-gate",
      relativeToAgentId: "agent-keyboard-nav",
      direction: "below",
    },
    {
      atMs: 1_300,
      action: "equalizeGridColumns",
      desktopId: "desk-launch",
      columns: [1, 2, 2],
      panelColumns: [
        ["term:*"],
        ["agent:agent-api-review", "agent:agent-docs-polish"],
        ["agent:agent-keyboard-nav", "agent:agent-release-gate"],
      ],
    },
    {
      atMs: 1_550,
      action: "selectSpaceRange",
      fromSpaceKey: "agent:agent-session-recovery",
      toSpaceKey: "agent:agent-release-gate",
    },
    { atMs: 2_600, action: "focusTerminal", desktopId: "desk-launch" },
    { atMs: 5_200, action: "activateDesktop", desktopId: "desk-review" },
    {
      atMs: 6_000,
      action: "openDiff",
      desktopId: "desk-review",
      agentId: "agent-session-recovery",
    },
    { atMs: 9_800, action: "activateDesktop", desktopId: "desk-operate" },
    { atMs: 13_000, action: "activateDesktop", desktopId: "desk-launch" },
    { atMs: 13_700, action: "focusTerminal", desktopId: "desk-launch" },
  ],
};

function scenarioVariant({
  id,
  title,
  description,
  activeDesktopId,
  durationMs,
  stillAtMs,
  setup,
  timeline,
}) {
  const fixture = structuredClone(workspaceOverview.fixture);
  fixture.activeDesktopId = activeDesktopId;
  return {
    ...workspaceOverview,
    id,
    title,
    description,
    durationMs,
    stillAtMs,
    readmeGif: undefined,
    publicWebm: undefined,
    fixture,
    setup,
    timeline,
  };
}

const localSshAgents = scenarioVariant({
  id: "local-ssh-agents",
  title: "Local and SSH agents",
  description:
    "A local Codex agent and remote Kimi agent sharing one Spaces workspace.",
  activeDesktopId: "desk-launch",
  durationMs: 6_000,
  stillAtMs: 2_600,
  setup: [
    {
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-keyboard-nav",
    },
  ],
  timeline: [
    {
      atMs: 500,
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-api-review",
      relativeToAgentId: "agent-keyboard-nav",
      direction: "right",
    },
    {
      atMs: 1_300,
      action: "selectSpaceRange",
      fromSpaceKey: "agent:agent-keyboard-nav",
      toSpaceKey: "agent:agent-api-review",
    },
    { atMs: 2_000, action: "focusTerminal", desktopId: "desk-launch" },
  ],
});

const diffReviewWorkflow = createDiffReviewWorkflowScenario({
  baseScenario: workspaceOverview,
});

const sshImagePaste = createSshImagePasteScenario({
  baseScenario: workspaceOverview,
});

const headlessSpawn = createHeadlessSpawnScenario({
  baseScenario: workspaceOverview,
});

const worktreeLaunch = createWorktreeLaunchScenario({
  baseScenario: workspaceOverview,
});

const orchestrationChannel = createOrchestrationChannelScenario({
  baseScenario: workspaceOverview,
});

const paneLayoutWorkflow = scenarioVariant({
  id: "pane-layout-workflow",
  title: "Desktops, split panes, and a floating pane",
  description:
    "A real Dockview split layout followed by Shift-click floating and desktop switching.",
  activeDesktopId: "desk-launch",
  durationMs: 8_000,
  stillAtMs: 3_200,
  setup: [
    {
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-session-recovery",
    },
  ],
  timeline: [
    {
      atMs: 450,
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-keyboard-nav",
      relativeToAgentId: "agent-session-recovery",
      direction: "below",
    },
    {
      atMs: 900,
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-docs-polish",
    },
    {
      atMs: 1_350,
      action: "openTerminal",
      desktopId: "desk-launch",
      cwd: "/workspace/dure",
      direction: "below",
    },
    {
      atMs: 2_000,
      action: "floatAgent",
      desktopId: "desk-launch",
      agentId: "agent-session-recovery",
      width: 508,
      height: 467,
      left: 76,
      top: 300,
    },
    { atMs: 2_700, action: "focusTerminal", desktopId: "desk-launch" },
    { atMs: 5_000, action: "activateDesktop", desktopId: "desk-review" },
    { atMs: 6_500, action: "activateDesktop", desktopId: "desk-launch" },
  ],
});

const onboardingWalkthrough = createOnboardingWalkthroughScenario({
  schemaVersion: MEDIA_CAPTURE_SCHEMA_VERSION,
  clock: FIXED_CLOCK,
});
const sessionRecovery = createSessionRecoveryScenario({
  schemaVersion: MEDIA_CAPTURE_SCHEMA_VERSION,
  clock: FIXED_CLOCK,
});
const hmuxAppReconnect = createHmuxAppReconnectScenario({
  schemaVersion: MEDIA_CAPTURE_SCHEMA_VERSION,
  clock: FIXED_CLOCK,
  baseScenario: workspaceOverview,
});
const hmuxMultipleViews = createHmuxMultipleViewsScenario({
  schemaVersion: MEDIA_CAPTURE_SCHEMA_VERSION,
  clock: FIXED_CLOCK,
  baseScenario: workspaceOverview,
});

export const MEDIA_CAPTURE_SCENARIOS = Object.freeze(
  [
    workspaceOverview,
    ...createProductTourScenarios({ baseScenario: workspaceOverview }),
    createSocialPaneLayoutScenario({ baseScenario: workspaceOverview }),
    localSshAgents,
    sshImagePaste,
    headlessSpawn,
    worktreeLaunch,
    orchestrationChannel,
    diffReviewWorkflow,
    paneLayoutWorkflow,
    createSpacesPaneMoveScenario({ baseScenario: workspaceOverview }),
    onboardingWalkthrough,
    sessionRecovery,
    hmuxAppReconnect,
    hmuxMultipleViews,
  ].map((scenario) => ({
    ...scenario,
    captureStage: captureProofNeedsNativeTauri(scenario)
      ? FULL_FRAME_CAPTURE_STAGE
      : scenario.captureStage ?? DURE_DESKTOP_CAPTURE_STAGE,
  })),
);

export function scenarioById(id) {
  return MEDIA_CAPTURE_SCENARIOS.find((scenario) => scenario.id === id);
}

export function validateScenario(scenario) {
  const errors = [];
  if (scenario?.schemaVersion !== MEDIA_CAPTURE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MEDIA_CAPTURE_SCHEMA_VERSION}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(scenario?.id ?? "")) {
    errors.push("id must be lowercase kebab-case");
  }
  if (
    scenario?.windowChrome?.platform !== "macos" ||
    typeof scenario?.windowChrome?.fullscreen !== "boolean"
  ) {
    errors.push("windowChrome must describe a macOS window mode");
  }
  for (const key of ["width", "height", "deviceScaleFactor"]) {
    const value = scenario?.viewport?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      errors.push(`viewport.${key} must be a positive number`);
    }
  }
  if (
    scenario?.terminalFontSize !== undefined &&
    (!Number.isFinite(scenario.terminalFontSize) ||
      scenario.terminalFontSize < 8 ||
      scenario.terminalFontSize > 30 ||
      Math.round(scenario.terminalFontSize * 2) !==
        scenario.terminalFontSize * 2)
  ) {
    errors.push("terminalFontSize must be a half-pixel step between 8 and 30");
  }
  if (
    scenario?.interfaceMode !== undefined &&
    !["basic", "pro"].includes(scenario.interfaceMode)
  ) {
    errors.push('interfaceMode must be "basic" or "pro" when provided');
  }
  errors.push(...validateCaptureStage(scenario?.captureStage, scenario?.viewport));
  for (const [label, size] of [
    ["liveTerminalSize", scenario?.liveTerminalSize],
    ...Object.entries(scenario?.liveProviderTerminalSizes ?? {}).map(
      ([provider, providerSize]) => [
        `liveProviderTerminalSizes.${provider}`,
        providerSize,
      ],
    ),
    ...Object.entries(scenario?.liveSessionTerminalSizes ?? {}).map(
      ([sessionId, sessionSize]) => [
        `liveSessionTerminalSizes.${sessionId}`,
        sessionSize,
      ],
    ),
  ]) {
    for (const [key, minimum] of [
      ["columns", 40],
      ["rows", 12],
    ]) {
      const value = size?.[key];
      if (!Number.isInteger(value) || value < minimum) {
        errors.push(`${label}.${key} must be an integer >= ${minimum}`);
      }
    }
  }
  if (
    !Number.isInteger(scenario?.durationMs) ||
    scenario.durationMs <= 0 ||
    !Number.isInteger(scenario?.stillAtMs) ||
    scenario.stillAtMs < 0 ||
    scenario.stillAtMs > scenario.durationMs
  ) {
    errors.push("durationMs and stillAtMs must define a valid capture window");
  }
  if (scenario?.readmeGif !== undefined) {
    errors.push(
      ...validateReadmeGifRecipe(scenario.readmeGif, scenario.durationMs),
    );
  }
  if (scenario?.publicWebm !== undefined) {
    errors.push(
      ...validatePublicWebmRecipe(scenario.publicWebm, scenario.durationMs),
    );
  }
  if (
    scenario?.terminalRequired !== undefined &&
    typeof scenario.terminalRequired !== "boolean"
  ) {
    errors.push("terminalRequired must be a boolean when provided");
  }
  if (
    scenario?.expectedRecoveryOverlayCount !== undefined &&
    (!Number.isInteger(scenario.expectedRecoveryOverlayCount) ||
      scenario.expectedRecoveryOverlayCount < 0)
  ) {
    errors.push("expectedRecoveryOverlayCount must be a non-negative integer");
  }
  if (
    scenario?.allowRecoveryOverlayDuringTimeline !== undefined &&
    typeof scenario.allowRecoveryOverlayDuringTimeline !== "boolean"
  ) {
    errors.push("allowRecoveryOverlayDuringTimeline must be a boolean");
  }
  const captureProofErrors = captureProofValidationErrors(scenario);
  errors.push(...captureProofErrors);
  const desktopIds = new Set(
    (scenario?.fixture?.desktops ?? []).map((desktop) => desktop.id),
  );
  const agentIds = new Set(
    (scenario?.fixture?.agents ?? []).map((agent) => agent.id),
  );
  const headlessSpawn = scenario?.fixture?.headlessSpawn;
  const orchestrationChannel = scenario?.fixture?.orchestrationChannel;
  const sessionIds = new Set(
    [
      ...(scenario?.fixture?.agents ?? []).map((agent) => agent.sessionId),
      headlessSpawn?.providerTarget?.sessionId,
    ].filter(Boolean),
  );
  const clipboardImagePaste = scenario?.fixture?.clipboardImagePaste;
  if (clipboardImagePaste !== undefined) {
    const pasteAgent = (scenario.fixture.agents ?? []).find(
      (agent) => agent.id === clipboardImagePaste.agentId,
    );
    if (clipboardImagePaste.schemaVersion !== 1) {
      errors.push("clipboardImagePaste.schemaVersion must be 1");
    }
    if (!pasteAgent || pasteAgent.sessionKind !== "ssh") {
      errors.push("clipboardImagePaste.agentId must reference an SSH agent");
    }
    if (pasteAgent?.sessionId !== clipboardImagePaste.sessionId) {
      errors.push("clipboardImagePaste.sessionId must match its agent");
    }
    if (
      typeof clipboardImagePaste.image?.dataB64 !== "string" ||
      clipboardImagePaste.image.dataB64.length === 0 ||
      !/^[a-z0-9+/]+={0,2}$/iu.test(clipboardImagePaste.image.dataB64)
    ) {
      errors.push("clipboardImagePaste.image.dataB64 must be base64");
    }
    if (!/^[a-z0-9]+$/iu.test(clipboardImagePaste.image?.ext ?? "")) {
      errors.push("clipboardImagePaste.image.ext must be alphanumeric");
    }
    if (
      typeof clipboardImagePaste.remotePath !== "string" ||
      !clipboardImagePaste.remotePath.startsWith("/tmp/dure-media-demo/")
    ) {
      errors.push(
        "clipboardImagePaste.remotePath must stay below /tmp/dure-media-demo",
      );
    }
  }
  if (headlessSpawn !== undefined) {
    if (headlessSpawn.schemaVersion !== 1) {
      errors.push("headlessSpawn.schemaVersion must be 1");
    }
    if (!/^sp_[a-z0-9_]+$/u.test(headlessSpawn.receiptId ?? "")) {
      errors.push("headlessSpawn.receiptId must be a public fixture identity");
    }
    if (!desktopIds.has(headlessSpawn.desktopId)) {
      errors.push("headlessSpawn.desktopId must reference a desktop");
    }
    const request = headlessSpawn.request;
    const worktree = headlessSpawn.worktree;
    if (
      request?.project !== "dure" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request?.name ?? "") ||
      request?.provider !== "codex" ||
      request?.runtime !== "hmux" ||
      typeof request?.useWorktree !== "boolean"
    ) {
      errors.push("headlessSpawn.request must be a public Dure Codex fixture");
    }
    if (request?.useWorktree === false && worktree !== undefined) {
      errors.push("headlessSpawn.worktree must be absent when worktrees are disabled");
    }
    if (request?.useWorktree === true) {
      const expectedRepo = "/workspace/dure";
      const expectedPath = `${expectedRepo}/.worktrees/${request.name}`;
      const expectedBranch = `agent/${request.name}`;
      const gitStatus = worktree?.gitStatus;
      if (
        worktree?.schemaVersion !== 1 ||
        worktree?.repo !== expectedRepo ||
        worktree?.name !== request.name ||
        worktree?.path !== expectedPath ||
        worktree?.branch !== expectedBranch ||
        worktree?.preExisting !== false ||
        gitStatus?.isRepo !== true ||
        gitStatus?.branch !== expectedBranch ||
        [
          gitStatus?.ahead,
          gitStatus?.behind,
          gitStatus?.staged,
          gitStatus?.unstaged,
          gitStatus?.untracked,
        ].some((value) => !Number.isInteger(value) || value < 0)
      ) {
        errors.push(
          "headlessSpawn.worktree must match the dedicated worktree contract",
        );
      }
    }
    const providerTarget = headlessSpawn.providerTarget;
    if (
      providerTarget?.provider !== headlessSpawn.request?.provider ||
      providerTarget?.sessionKind !== "pty" ||
      typeof providerTarget?.agentId !== "string" ||
      providerTarget.agentId.length === 0 ||
      typeof providerTarget?.sessionId !== "string" ||
      providerTarget.sessionId.length === 0
    ) {
      errors.push("headlessSpawn.providerTarget must define its live PTY source");
    }
    const spawnActions = [
      ...(scenario.setup ?? []),
      ...(scenario.timeline ?? []),
    ].filter(({ action }) => action === "headlessSpawn");
    if (
      spawnActions.length !== 1 ||
      spawnActions[0]?.desktopId !== headlessSpawn.desktopId
    ) {
      errors.push("headlessSpawn must have one matching timeline action");
    }
  }
  if (orchestrationChannel !== undefined) {
    if (orchestrationChannel.schemaVersion !== 1) {
      errors.push("orchestrationChannel.schemaVersion must be 1");
    }
    if (!desktopIds.has(orchestrationChannel.desktopId)) {
      errors.push("orchestrationChannel.desktopId must reference a desktop");
    }
    const taskIds = orchestrationChannel.tasks?.map(({ id }) => id) ?? [];
    const messageIds = orchestrationChannel.messages?.map(({ id }) => id) ?? [];
    const phaseIds = orchestrationChannel.phases?.map(({ id }) => id) ?? [];
    if (
      taskIds.length !== 2 ||
      new Set(taskIds).size !== taskIds.length ||
      messageIds.length === 0 ||
      new Set(messageIds).size !== messageIds.length ||
      JSON.stringify(phaseIds) !==
        JSON.stringify(["queued", "dispatched", "working", "decision", "resolved"])
    ) {
      errors.push("orchestrationChannel must define its versioned task/message phases");
    }
    for (const binding of orchestrationChannel.agentBindings ?? []) {
      const agent = scenario.fixture.agents.find(({ id }) => id === binding.agentId);
      if (
        !agent ||
        agent.name !== binding.name ||
        agent.provider !== binding.provider ||
        agent.sessionId !== binding.sessionId ||
        binding.panelId !== `agent:${binding.agentId}` ||
        !taskIds.includes(binding.taskId)
      ) {
        errors.push("orchestrationChannel agent binding must match a visible agent");
      }
    }
    if ((orchestrationChannel.agentBindings ?? []).length !== 2) {
      errors.push("orchestrationChannel must bind exactly two live agents");
    }
    for (const message of orchestrationChannel.messages ?? []) {
      if (
        !["note", "dispatch", "heartbeat", "worker_done", "decision_gate"].includes(
          message.type,
        ) ||
        (message.taskId !== null && !taskIds.includes(message.taskId))
      ) {
        errors.push("orchestrationChannel message must join a typed task contract");
      }
    }
    for (const phase of orchestrationChannel.phases ?? []) {
      if (
        (phase.messageIds ?? []).some((id) => !messageIds.includes(id)) ||
        Object.keys(phase.taskStates ?? {}).some((id) => !taskIds.includes(id)) ||
        Object.keys(phase.agentComments ?? {}).some((id) => !agentIds.has(id))
      ) {
        errors.push("orchestrationChannel phase references an unknown identity");
      }
    }
    const phaseActions = [...(scenario.setup ?? []), ...(scenario.timeline ?? [])]
      .filter(({ action }) => action === "advanceOrchestrationChannel")
      .map(({ phaseId }) => phaseId);
    if (JSON.stringify(phaseActions) !== JSON.stringify(phaseIds)) {
      errors.push("orchestrationChannel phases must advance exactly once in order");
    }
  }
  if (
    captureProofErrors.length === 0 &&
    captureProofNeedsNativeTauri(scenario) &&
    !agentIds.has(scenario?.nativeSessionWindowAgentId)
  ) {
    errors.push("nativeSessionWindowAgentId must reference a fixture agent");
  }
  for (const sessionId of Object.keys(
    scenario?.liveSessionTerminalSizes ?? {},
  )) {
    if (!sessionIds.has(sessionId)) {
      errors.push(`liveSessionTerminalSizes references unknown ${sessionId}`);
    }
  }
  const spaceKeys = new Set([...agentIds].map((agentId) => `agent:${agentId}`));
  if (!desktopIds.has(scenario?.fixture?.activeDesktopId)) {
    errors.push("fixture.activeDesktopId must reference a fixture desktop");
  }
  let previousAt = -1;
  for (const step of scenario?.setup ?? []) {
    validateAction(
      step,
      desktopIds,
      agentIds,
      sessionIds,
      spaceKeys,
      errors,
      "setup",
    );
  }
  for (const step of scenario?.timeline ?? []) {
    validateAction(
      step,
      desktopIds,
      agentIds,
      sessionIds,
      spaceKeys,
      errors,
      "timeline",
    );
    if (!Number.isInteger(step.atMs) || step.atMs < previousAt) {
      errors.push("timeline atMs values must be sorted non-negative integers");
    }
    if (step.atMs > scenario.durationMs) {
      errors.push(`timeline step at ${step.atMs} exceeds durationMs`);
    }
    if (
      step.action === "reloadAppClient" &&
      step.reconnectReadyAtMs > scenario.durationMs
    ) {
      errors.push("reloadAppClient reconnect window exceeds durationMs");
    }
    previousAt = step.atMs;
  }
  const serialized = JSON.stringify(scenario?.fixture ?? {});
  for (const pattern of PRIVATE_DATA_PATTERNS) {
    if (pattern.test(serialized)) {
      errors.push(`fixture matches forbidden private-data pattern ${pattern}`);
    }
  }
  return errors;
}

function validateAction(
  action,
  desktopIds,
  agentIds,
  sessionIds,
  spaceKeys,
  errors,
  source,
) {
  if (!ALLOWED_ACTIONS.has(action?.action)) {
    errors.push(`${source} has unsupported action ${String(action?.action)}`);
    return;
  }
  if (
    action.action === "activateDesktop" &&
    !desktopIds.has(action.desktopId)
  ) {
    errors.push(`${source} references unknown desktop ${String(action.desktopId)}`);
  }
  if (
    action.action === "focusTerminal" &&
    !desktopIds.has(action.desktopId)
  ) {
    errors.push(`${source} references unknown desktop ${String(action.desktopId)}`);
  }
  if (action.action === "openOnboarding") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    if (
      !Number.isInteger(action.expectedDesktopCount) ||
      action.expectedDesktopCount < 1
    ) {
      errors.push(`${source} openOnboarding.expectedDesktopCount is invalid`);
    }
  }
  if (action.action === "openRecoveryTerminal") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    for (const key of ["sessionId", "workspaceId"]) {
      if (typeof action[key] !== "string" || action[key].trim().length === 0) {
        errors.push(`${source} openRecoveryTerminal.${key} is invalid`);
      }
    }
    if (typeof action.cwd !== "string" || !action.cwd.startsWith("/workspace/")) {
      errors.push(`${source} openRecoveryTerminal.cwd must stay below /workspace`);
    }
  }
  if (
    action.action === "openSessionRecovery" &&
    (typeof action.sessionName !== "string" || action.sessionName.trim().length === 0)
  ) {
    errors.push(`${source} openSessionRecovery.sessionName is invalid`);
  }
  if (action.action === "reloadForSessionRecovery") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    for (const key of ["panelId", "expectedBeforeMarker"]) {
      if (typeof action[key] !== "string" || action[key].trim().length === 0) {
        errors.push(`${source} reloadForSessionRecovery.${key} is invalid`);
      }
    }
  }
  if (action.action === "reloadAppClient") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    for (const key of ["panelId", "sessionId"]) {
      if (typeof action[key] !== "string" || action[key].trim().length === 0) {
        errors.push(`${source} reloadAppClient.${key} is invalid`);
      }
    }
    if (!sessionIds.has(action.sessionId)) {
      errors.push(
        `${source} references unknown session ${String(action.sessionId)}`,
      );
    }
    if (
      !Number.isInteger(action.reconnectReadyAtMs) ||
      !Number.isInteger(action.atMs) ||
      action.reconnectReadyAtMs <= action.atMs
    ) {
      errors.push(`${source} reloadAppClient.reconnectReadyAtMs is invalid`);
    }
  }
  if (action.action === "confirmSessionRecovery") {
    for (const key of [
      "sourceSessionId",
      "replacementSessionId",
      "workspaceId",
      "sessionName",
      "expectedAfterMarker",
    ]) {
      if (typeof action[key] !== "string" || action[key].trim().length === 0) {
        errors.push(`${source} confirmSessionRecovery.${key} is invalid`);
      }
    }
  }
  if (action.action === "showRecoveredTerminal") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    for (const key of ["replacementSessionId", "expectedMarker"]) {
      if (typeof action[key] !== "string" || action[key].trim().length === 0) {
        errors.push(`${source} showRecoveredTerminal.${key} is invalid`);
      }
    }
  }
  if (action.action === "renameOnboardingDesktop") {
    if (!Number.isInteger(action.desktopIndex) || action.desktopIndex < 0) {
      errors.push(`${source} renameOnboardingDesktop.desktopIndex is invalid`);
    }
    if (typeof action.name !== "string" || action.name.trim().length === 0) {
      errors.push(`${source} renameOnboardingDesktop.name is invalid`);
    }
  }
  if (action.action === "moveOnboardingPane") {
    for (const key of ["fromDesktopIndex", "toDesktopIndex"]) {
      if (!Number.isInteger(action[key]) || action[key] < 0) {
        errors.push(`${source} moveOnboardingPane.${key} is invalid`);
      }
    }
    if (action.fromDesktopIndex === action.toDesktopIndex) {
      errors.push(`${source} moveOnboardingPane must cross desktops`);
    }
  }
  if (action.action === "moveSpacesPane") {
    errors.push(
      ...validateSpacesPaneMove(action, desktopIds, spaceKeys).map(
        (error) => `${source} ${error}`,
      ),
    );
  }
  if (
    action.action === "confirmOnboarding" &&
    (!Number.isInteger(action.expectedPaneCount) || action.expectedPaneCount < 1)
  ) {
    errors.push(`${source} confirmOnboarding.expectedPaneCount is invalid`);
  }
  if (
    action.action === "confirmOnboarding" &&
    (!Array.isArray(action.expectedTerminalMarkers) ||
      action.expectedTerminalMarkers.length !== action.expectedPaneCount ||
      action.expectedTerminalMarkers.some(
        (marker) => typeof marker !== "string" || marker.length === 0,
      ))
  ) {
    errors.push(`${source} confirmOnboarding.expectedTerminalMarkers is invalid`);
  }
  if (action.action === "equalizeGridColumns") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    if (
      !Array.isArray(action.columns) ||
      action.columns.length === 0 ||
      action.columns.some((count) => !Number.isInteger(count) || count < 1)
    ) {
      errors.push(
        `${source} equalizeGridColumns columns must be positive integers`,
      );
    }
    if (
      !Array.isArray(action.panelColumns) ||
      action.panelColumns.length !== action.columns?.length ||
      action.panelColumns.some(
        (column, index) =>
          !Array.isArray(column) ||
          column.length !== action.columns?.[index] ||
          column.some((panelId) => typeof panelId !== "string"),
      )
    ) {
      errors.push(
        `${source} equalizeGridColumns panelColumns must match columns`,
      );
    }
  }
  if (action.action === "openTerminal") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    if (!["right", "below"].includes(action.direction)) {
      errors.push(`${source} openTerminal direction must be right|below`);
    }
    if (typeof action.cwd !== "string" || !action.cwd.startsWith("/workspace/")) {
      errors.push(`${source} openTerminal cwd must stay below /workspace`);
    }
  }
  if (action.action === "pasteClipboardImage") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    if (!agentIds.has(action.agentId)) {
      errors.push(`${source} references unknown agent ${String(action.agentId)}`);
    }
  }
  if (action.action === "headlessSpawn") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
  }
  if (action.action === "advanceOrchestrationChannel") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    if (typeof action.phaseId !== "string" || action.phaseId.length === 0) {
      errors.push(`${source} advanceOrchestrationChannel.phaseId is invalid`);
    }
  }
  if (
    [
      "floatAgent",
      "openDiff",
      "openSessionWindow",
      "toggleWindowMaximize",
    ].includes(action.action)
  ) {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    if (!agentIds.has(action.agentId)) {
      errors.push(`${source} references unknown agent ${String(action.agentId)}`);
    }
  }
  if (
    action.action === "openSessionWindow" &&
    action.surface !== undefined
  ) {
    errors.push(`${source} openSessionWindow must originate on the desktop`);
  }
  if (
    action.action === "toggleWindowMaximize" &&
    (action.surface !== "session" || typeof action.maximized !== "boolean")
  ) {
    errors.push(
      `${source} toggleWindowMaximize requires a session surface and expected state`,
    );
  }
  if (action.action === "floatAgent") {
    for (const key of ["width", "height", "left", "top"]) {
      const value = action[key];
      const minimum = key === "left" || key === "top" ? 0 : 1;
      if (!Number.isInteger(value) || value < minimum) {
        errors.push(
          `${source} floatAgent.${key} must be an integer of at least ${minimum}`,
        );
      }
    }
  }
  if (action.action === "openAgent") {
    if (!desktopIds.has(action.desktopId)) {
      errors.push(
        `${source} references unknown desktop ${String(action.desktopId)}`,
      );
    }
    if (!agentIds.has(action.agentId)) {
      errors.push(`${source} references unknown agent ${String(action.agentId)}`);
    }
    if (
      action.relativeToAgentId !== undefined &&
      !agentIds.has(action.relativeToAgentId)
    ) {
      errors.push(
        `${source} references unknown relative agent ${String(action.relativeToAgentId)}`,
      );
    }
    if (
      action.relativeToAgentId !== undefined &&
      !["right", "below"].includes(action.direction)
    ) {
      errors.push(`${source} relative agent placement requires right|below`);
    }
    if (
      action.relativeToAgentId === undefined &&
      action.relativeToTerminal !== true &&
      action.direction !== undefined
    ) {
      errors.push(
        `${source} direction requires relativeToAgentId or relativeToTerminal`,
      );
    }
    if (
      action.relativeToTerminal !== undefined &&
      typeof action.relativeToTerminal !== "boolean"
    ) {
      errors.push(`${source} relativeToTerminal must be boolean`);
    }
    if (
      action.relativeToTerminal === true &&
      (action.relativeToAgentId !== undefined ||
        !["right", "below"].includes(action.direction))
    ) {
      errors.push(
        `${source} terminal-relative placement requires only right|below`,
      );
    }
    if (
      action.replaceDefaultTerminal !== undefined &&
      typeof action.replaceDefaultTerminal !== "boolean"
    ) {
      errors.push(`${source} replaceDefaultTerminal must be boolean`);
    }
  }
  if (
    action.action === "clickSpace" &&
    !spaceKeys.has(action.spaceKey)
  ) {
    errors.push(`${source} references unknown space ${String(action.spaceKey)}`);
  }
  if (action.action === "selectSpaceRange") {
    for (const key of [action.fromSpaceKey, action.toSpaceKey]) {
      if (!spaceKeys.has(key)) {
        errors.push(`${source} references unknown space ${String(key)}`);
      }
    }
  }
}

for (const scenario of MEDIA_CAPTURE_SCENARIOS) {
  const errors = validateScenario(scenario);
  if (errors.length > 0) {
    throw new Error(`invalid media capture scenario ${scenario.id}: ${errors.join("; ")}`);
  }
}
