import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { viewportFrameRecord } from "../src/test/terminalRecordFixtures.ts";
import {
  decodeTerminalStateRecord,
} from "../src/lib/terminal/protocol/terminalStateProtocol.ts";
import "../tools/media-capture/compositor/storyboard.test.mjs";
import "../tools/media-capture/compositor/review-contract.test.mjs";
import "../tools/media-capture/compositor/source-provenance.test.mjs";
import "../tools/media-capture/compositor/storyboard-generation.test.mjs";
import "../tools/media-capture/atomic-json.test.mjs";
import "../tools/media-capture/regular-file.test.mjs";
import "../tools/media-capture/runtime/spaces-pane-move-actions.test.mjs";
import "../tools/media-capture/native/terminal-surface-proof.test.mjs";
import "../tools/media-capture/marketing/activation-bundle.test.mjs";
import {
  captureHelp,
  parseCaptureArgs,
  selectCaptureScenarios,
} from "../tools/media-capture/capture.mjs";
import {
  MEDIA_CAPTURE_SCENARIOS,
  MEDIA_CAPTURE_SCHEMA_VERSION,
  scenarioById,
  validateScenario,
} from "../tools/media-capture/scenarios.mjs";
import { PROVIDER_SCREEN_FIXTURES } from "../tools/media-capture/provider-screens.mjs";
import {
  ProviderAuthenticationRequiredError,
  UnsafeProviderOutputError,
  assertProviderScreenSafe,
  normalizeProviderScreen,
  providerPrivacyViolations,
  visibleProviderText,
} from "../tools/media-capture/providers/privacy.mjs";
import {
  assertCompatibleHmuxCapabilities,
  assertLiveSessionContinuity,
  createLiveProviderMedia,
  decodeHmuxScreen,
  fenceFromSessionRecord,
  framesForSessionTarget,
  processProbeIsAbsent,
  replayFramesBySession,
  replayVisibility,
  stillFrameForTarget,
  videoInitialFrame,
} from "../tools/media-capture/providers/live-sessions.mjs";
import {
  prepareProviderAutomationState,
  providerAutomationCommand,
  retireProviderAutomationCredentials,
} from "../tools/media-capture/providers/codex-automation-home.mjs";
import {
  liveReplaySteps,
  unrenderedLatestSessions,
  unrenderedReplayPublications,
} from "../tools/media-capture/runtime/live-terminal-replay.mjs";
import {
  providerScreenReady,
  providerStartupKeys,
} from "../tools/media-capture/providers/startup-prompts.mjs";
import { providersForScenario } from "../tools/media-capture/providers/specs.mjs";
import {
  providerResponseBusy,
  providerResponseComplete,
} from "../tools/media-capture/providers/response-completion.mjs";
import { providerProvenance } from "../tools/media-capture/providers/provenance.mjs";
import {
  createProviderDemoRepo,
  createProviderDemoWorktree,
} from "../tools/media-capture/providers/demo-repo.mjs";
import {
  claimCleanupLedger,
  readCleanupLedger,
  recoverableCleanupLedgers,
  removeCleanupLedger,
  writeCleanupLedger,
} from "../tools/media-capture/providers/cleanup-ledger.mjs";
import { providerFixtureRoot } from "../tools/media-capture/paths.mjs";
import {
  resizeHmuxSession,
  terminalCaptureSize,
  terminalGeometryFitsViewport,
} from "../tools/media-capture/providers/terminal-geometry.mjs";
import {
  exactProcessGenerationStatus,
  observeProcessGeneration,
} from "../tools/media-capture/providers/process-generation.mjs";
import {
  dedicatedTargetsForProvider,
  paneSizedFrameHasRedrawn,
  primaryTerminalSize,
  providerScreenFillsColumns,
  waitForStablePaneSizedFrame,
} from "../tools/media-capture/providers/pane-sized-sessions.mjs";
import {
  declaredTerminalSize,
  resolvedMeasuredTerminalSize,
  unsettledTerminalSessionIds,
} from "../tools/media-capture/runtime/terminal-viewport-measurement.mjs";
import {
  repaintVisibleLiveTerminals,
  requiredLiveStillSessionIds,
} from "../tools/media-capture/runtime/live-terminal-still.mjs";
import {
  applicationWorkingTreeFingerprint,
  applicationWorkingTreeState,
  assertApplicationBuildUnchanged,
  normalizeApplicationBuildInfo,
  readApplicationBuild,
} from "../tools/media-capture/runtime/application-build.mjs";
import { fixtureGitArguments } from "./lib/git-test-fixture.mjs";
import { processMemberSnapshots } from "./lib/process-identity.mjs";
import {
  gifFilterGraph,
  readmeGifRecipe,
  validateGifProbe,
  validateReadmeGifRecipe,
} from "../tools/media-capture/runtime/gif-derivative.mjs";
import { captureArtifactPlan } from "../tools/media-capture/runtime/capture-plan.mjs";
import { createOrchestrationChannelFixture } from "../tools/media-capture/scenarios/orchestration-channel-fixture.mjs";
import { runClientLifecycleAction } from "../tools/media-capture/runtime/client-lifecycle-actions.mjs";
import { runSessionRecoveryAction } from "../tools/media-capture/runtime/session-recovery-actions.mjs";
import { captureInterfacePreferences } from "../tools/media-capture/runtime/interface-preferences.mjs";
import { assertBrowserCaptureProviderSource } from "../tools/media-capture/runtime/provider-source-policy.mjs";
import { captureInteractionEvidence } from "../tools/media-capture/runtime/interaction-evidence.mjs";
import {
  captureProofManifest,
  captureProofNeedsLiveContinuity,
  captureProofNeedsNativeTauri,
  captureProofRequirements,
} from "../tools/media-capture/runtime/capture-proof.mjs";
import {
  TERMINAL_SURFACE_SELECTORS,
  terminalSurfaceIsPresentable,
  terminalSurfaceReadiness,
  terminalViewportGeometryFromSurface,
} from "../tools/media-capture/runtime/terminal-surface.mjs";
import {
  MEDIA_BACKEND_FEATURES,
  mediaBackendCapabilities,
} from "../tools/media-capture/runtime/backend-capabilities.mjs";
import {
  captureStageBootstrapCss,
  captureStageClockLabel,
} from "../tools/media-capture/runtime/capture-stage.mjs";
import {
  publicWebmFilterGraph,
  publicWebmRecipe,
  publicWebmRenderArgs,
  renderPublicWebmDerivative,
  validatePublicWebmProbe,
  validatePublicWebmRecipe,
} from "../tools/media-capture/runtime/webm-derivative.mjs";
import {
  capturePromotionJournalPath,
  createCaptureGeneration,
  discardCaptureGeneration,
  promoteCaptureGeneration,
  recoverCapturePromotion,
} from "../tools/media-capture/runtime/output-generation.mjs";
import {
  qaTauriConfig,
  qaWindowPlan,
} from "./qa/lib/tauri-window-config.mjs";
import {
  nativeWindowBridgeResponse,
  parseNativeWindowBridgeRequest,
} from "../tools/media-capture/native/window-bridge.mjs";
import {
  assertNativeInteractionWindowRequest,
  expectedNativeInitialWindowTitles,
  expectedNativeWindowErrorTitles,
  expectedNativeWindowReplayTitles,
  expectedNativeWindowTitles,
  nativeWindowPlan,
} from "../tools/media-capture/native/window-contract.mjs";
import { nativeMediaRunnerEnvironment } from "../tools/media-capture/native/environment.mjs";
import {
  nativeHmuxRuntimeEnvironment,
  stageNativeHmuxRuntime,
} from "../tools/media-capture/native/runtime-binaries.mjs";
import {
  applyNativeSnapshotOverride,
  encodeNativeSnapshotOverride,
} from "../tools/media-capture/native/snapshot-override.mjs";
import { runTerminalSurfaceProof } from "../tools/media-capture/native/terminal-surface-proof.mjs";
import {
  nativeBlankReplayScenario,
  nativeLiveReplaySteps,
} from "../tools/media-capture/native/replay.mjs";
import {
  NATIVE_DESKTOP_STAGE,
  nativeDesktopStageFilter,
  nativeDesktopStageManifest,
} from "../tools/media-capture/native/desktop-stage.mjs";
import {
  nativeWindowCompositionFilter,
  nativeWindowFramePath,
  nativeWindowVideoEncoding,
  nativeWindowVideoEncodingOptions,
  validateNativeWindowVideoProbe,
} from "../tools/media-capture/native/video.mjs";
import {
  expectedNativeTerminalSessionIds,
  expectedNativeTerminalSurfaceCount,
  nativeTerminalReplayStepsForSurface,
  playNativeScenarioTimeline,
  playNativeTerminalReplay,
  waitForNativeTerminalReplayStart,
} from "../tools/media-capture/native/scenario-runtime.mjs";
import {
  matchingAvailableWindows,
  matchingReadyWindows,
  normalizeWindowProbe,
} from "../tools/media-capture/native/window-probe.mjs";
import { orderedFrameDigest } from "../tools/media-capture/native/output.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const ffmpegIt = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return it;
  } catch {
    return it.skip;
  }
})();

async function withTemporaryGlobals(overrides, callback) {
  const previous = new Map(
    Object.keys(overrides).map((key) => [
      key,
      {
        existed: Object.hasOwn(globalThis, key),
        value: globalThis[key],
      },
    ]),
  );
  Object.assign(globalThis, overrides);
  try {
    return await callback();
  } finally {
    for (const [key, entry] of previous) {
      if (entry.existed) globalThis[key] = entry.value;
      else delete globalThis[key];
    }
  }
}

describe("media capture scenarios", () => {
  it("keeps a versioned, unique, privacy-safe scenario catalog", () => {
    expect(MEDIA_CAPTURE_SCHEMA_VERSION).toBe(6);
    expect(MEDIA_CAPTURE_SCENARIOS.length).toBeGreaterThan(0);
    expect(new Set(MEDIA_CAPTURE_SCENARIOS.map(({ id }) => id)).size).toBe(
      MEDIA_CAPTURE_SCENARIOS.length,
    );
    for (const scenario of MEDIA_CAPTURE_SCENARIOS) {
      expect(validateScenario(scenario)).toEqual([]);
      expect(scenarioById(scenario.id)).toBe(scenario);
      expect(scenario.windowChrome).toEqual({
        platform: "macos",
        fullscreen: false,
      });
      expect(scenario.captureStage).toEqual(
        captureProofNeedsNativeTauri(scenario)
          ? { schemaVersion: 1, mode: "full-frame" }
          : scenario.fixture.productTour
            ? { schemaVersion: 1, mode: "desktop-window", backdrop: "dure-dusk", menuBar: true, window: scenario.id === "social-pane-layout"
              ? { left: 120, top: 110, width: 1680, height: 860, borderRadius: 14 }
              : { left: 24, top: 40, width: 1432, height: 876, borderRadius: 14 } }
            : {
              schemaVersion: 1,
              mode: "desktop-window",
              backdrop: "dure-dusk",
              menuBar: true,
              window: {
                left: 54,
                top: 50,
                width: 1_812,
                height: 982,
                borderRadius: 14,
              },
            },
      );
    }
  });

  it("rejects a desktop capture stage that does not leave visible background", () => {
    const scenario = structuredClone(scenarioById("workspace-overview"));
    scenario.captureStage.window.width = scenario.viewport.width;
    expect(validateScenario(scenario)).toContain(
      "captureStage.window must leave desktop pixels on both sides",
    );
  });

  it("fits social demo excerpts in the narrowest three-column pane", () => {
    const scenario = scenarioById("social-pane-layout");
    for (const screen of Object.values(scenario.fixture.terminalSnapshots)) {
      const rows = screen.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").split("\r\n");
      expect(rows.length).toBeLessThanOrEqual(15);
      expect(Math.max(...rows.map((row) => [...row].length))).toBeLessThanOrEqual(46);
    }
  });

  it("lets dense hero layouts choose a reproducible terminal zoom", () => {
    const overview = scenarioById("workspace-overview");
    expect(overview.terminalFontSize).toBe(10);
    expect(overview.liveTerminalSize).toEqual({ columns: 77, rows: 29 });
    expect(overview.liveSessionTerminalSizes["session-codex"]).toEqual({
      columns: 81,
      rows: 30,
    });

    const invalid = structuredClone(overview);
    invalid.terminalFontSize = 9.25;
    expect(validateScenario(invalid)).toContain(
      "terminalFontSize must be a half-pixel step between 8 and 30",
    );
  });

  it("binds SSH image paste media to one isolated remote agent contract", () => {
    const scenario = scenarioById("ssh-image-paste");
    expect(providersForScenario(scenario)).toEqual(["codex"]);
    expect(scenario.setup).toEqual([
      {
        action: "openAgent",
        desktopId: "desk-launch",
        agentId: "agent-api-review",
        relativeToTerminal: true,
        direction: "right",
      },
    ]);
    expect(scenario.timeline).toEqual([
      {
        atMs: 3_200,
        action: "pasteClipboardImage",
        desktopId: "desk-launch",
        agentId: "agent-api-review",
      },
    ]);
    expect(scenario.fixture.clipboardImagePaste).toMatchObject({
      schemaVersion: 1,
      agentId: "agent-api-review",
      sessionId: "session-kimi",
      image: { ext: "png" },
      remotePath: "/tmp/dure-media-demo/architecture-overview.png",
    });
    const invalid = structuredClone(scenario);
    invalid.fixture.agents.find(
      ({ id }) => id === "agent-api-review",
    ).sessionKind = "pty";
    expect(validateScenario(invalid)).toContain(
      "clipboardImagePaste.agentId must reference an SSH agent",
    );
  });

  it("records one joined SSH upload and terminal write per captured surface", () => {
    const receipt = {
      uploads: [
        {
          bytes: 70,
          ext: "png",
          remotePath: "/tmp/dure-media-demo/architecture-overview.png",
          sessionId: "remote-session",
        },
      ],
      writes: [
        {
          data: "/tmp/dure-media-demo/architecture-overview.png ",
          sessionId: "remote-session",
        },
      ],
    };
    expect(
      captureInteractionEvidence({
        png: { clipboardImagePaste: receipt },
        webm: { clipboardImagePaste: structuredClone(receipt) },
        gif: { clipboardImagePaste: structuredClone(receipt) },
      }),
    ).toEqual({
      schemaVersion: 1,
      clipboardImagePaste: {
        png: { upload: receipt.uploads[0], write: receipt.writes[0] },
        webm: { upload: receipt.uploads[0], write: receipt.writes[0] },
      },
    });
    const mismatched = structuredClone(receipt);
    mismatched.writes[0].data = "/tmp/dure-media-demo/other.png ";
    expect(() =>
      captureInteractionEvidence({
        png: { clipboardImagePaste: mismatched },
      }),
    ).toThrow("does not join upload to write");
    const duplicated = structuredClone(receipt);
    duplicated.uploads.push(structuredClone(duplicated.uploads[0]));
    expect(() =>
      captureInteractionEvidence({
        webm: { clipboardImagePaste: duplicated },
      }),
    ).toThrow("must be exactly-once");
  });

  it("binds headless spawn media to one durable receipt and live provider source", () => {
    const scenario = scenarioById("headless-spawn");
    expect(providersForScenario(scenario)).toEqual(["codex"]);
    expect(scenario.setup).toEqual([
      { action: "activateDesktop", desktopId: "desk-launch" },
    ]);
    expect(scenario.timeline).toEqual([
      { atMs: 2_150, action: "headlessSpawn", desktopId: "desk-launch" },
    ]);
    expect(scenario.fixture.headlessSpawn).toMatchObject({
      schemaVersion: 1,
      receiptId: "sp_media_release_auditor_01",
      desktopId: "desk-launch",
      request: {
        project: "dure",
        name: "release-auditor",
        provider: "codex",
        useWorktree: false,
      },
      providerTarget: {
        sessionId: "media-headless-codex-source",
        provider: "codex",
      },
    });
    const invalid = structuredClone(scenario);
    invalid.timeline.push({
      atMs: 3_000,
      action: "headlessSpawn",
      desktopId: "desk-launch",
    });
    expect(validateScenario(invalid)).toContain(
      "headlessSpawn must have one matching timeline action",
    );
  });

  it("binds worktree launch media to the dedicated branch contract", () => {
    const scenario = scenarioById("worktree-launch");
    expect(providersForScenario(scenario)).toEqual(["codex"]);
    expect(scenario.fixture.headlessSpawn).toMatchObject({
      schemaVersion: 1,
      receiptId: "sp_media_isolation_audit_01",
      request: {
        project: "dure",
        name: "isolation-audit",
        provider: "codex",
        useWorktree: true,
      },
      worktree: {
        schemaVersion: 1,
        repo: "/workspace/dure",
        path: "/workspace/dure/.worktrees/isolation-audit",
        branch: "agent/isolation-audit",
        preExisting: false,
      },
    });
    expect(scenario.liveSessionTerminalSizes).toMatchObject({
      "media-worktree-codex-source": { columns: 101, rows: 50 },
    });
    const invalid = structuredClone(scenario);
    invalid.fixture.headlessSpawn.worktree.path =
      "/workspace/dure/.worktrees/unrelated";
    expect(validateScenario(invalid)).toContain(
      "headlessSpawn.worktree must match the dedicated worktree contract",
    );
  });

  it("records a joined 202 receipt, successful saga, and visible pane per surface", () => {
    const receiptId = "sp_media_receipt";
    const receipt = {
      receiptId,
      state: "succeeded",
      steps: [
        { step: "preflight", status: "ok" },
        { step: "worktree", status: "skipped" },
        {
          step: "pane",
          status: "ok",
          artifacts: [
            { kind: "agent_registration", id: "agent-created" },
            { kind: "pane", id: "agent:agent-created" },
          ],
        },
        {
          step: "runtime_session",
          status: "ok",
          detail: { sessionId: "agent-created" },
        },
        { step: "provider_exec", status: "ok" },
        { step: "prompt_delivery", status: "skipped" },
      ],
    };
    const diagnostics = {
      requests: [{ receiptId, status: 202 }],
      presentations: [
        {
          agentId: "agent-created",
          panelId: "agent:agent-created",
          receiptId,
          sessionId: "agent-created",
        },
      ],
      receipts: { [receiptId]: receipt },
      runtimeSessionId: "agent-created",
      worktreeCommands: [],
      worktreeCreations: [],
      worktreeStatusReads: [],
    };
    expect(
      captureInteractionEvidence({
        png: { headlessSpawn: diagnostics },
        webm: { headlessSpawn: structuredClone(diagnostics) },
      }),
    ).toMatchObject({
      schemaVersion: 1,
      headlessSpawn: {
        png: { receiptId, state: "succeeded" },
        webm: { receiptId, state: "succeeded" },
      },
    });
    const duplicate = structuredClone(diagnostics);
    duplicate.requests.push(structuredClone(duplicate.requests[0]));
    expect(() =>
      captureInteractionEvidence({ png: { headlessSpawn: duplicate } }),
    ).toThrow("must be exactly-once");
  });

  it("joins worktree planning, creation, journal, git status, and pane evidence", () => {
    const receiptId = "sp_media_worktree";
    const path = "/workspace/dure/.worktrees/isolation-audit";
    const branch = "agent/isolation-audit";
    const gitStatus = {
      isRepo: true,
      branch,
      ahead: 2,
      behind: 0,
      staged: 1,
      unstaged: 2,
      untracked: 0,
    };
    const receipt = {
      receiptId,
      request: { useWorktree: true },
      state: "succeeded",
      steps: [
        { step: "preflight", status: "ok" },
        {
          step: "worktree",
          status: "ok",
          detail: { path, branch },
          artifacts: [
            {
              kind: "worktree",
              id: path,
              branch,
              ownership: "created_by_request",
            },
          ],
        },
        {
          step: "pane",
          status: "ok",
          artifacts: [
            { kind: "agent_registration", id: "agent-created" },
            { kind: "pane", id: "agent:agent-created" },
          ],
        },
        {
          step: "runtime_session",
          status: "ok",
          detail: { sessionId: "agent-created" },
        },
        { step: "provider_exec", status: "ok" },
        { step: "prompt_delivery", status: "skipped" },
      ],
    };
    const diagnostics = {
      requests: [{ receiptId, status: 202 }],
      presentations: [
        {
          agentId: "agent-created",
          branch,
          gitStatus,
          panelId: "agent:agent-created",
          receiptId,
          sessionId: "agent-created",
          worktreePath: path,
        },
      ],
      receipts: { [receiptId]: receipt },
      runtimeSessionId: "agent-created",
      worktreeCommands: [
        { repo: "/workspace/dure", name: "isolation-audit", path, branch },
      ],
      worktreeCreations: [
        {
          repo: "/workspace/dure",
          name: "isolation-audit",
          path,
          branch,
          outcome: "created",
        },
        {
          repo: "/workspace/dure",
          name: "isolation-audit",
          path,
          branch,
          outcome: "reused",
        },
      ],
      worktreeStatusReads: [{ path, status: gitStatus }],
    };
    expect(
      captureInteractionEvidence({ png: { headlessSpawn: diagnostics } }),
    ).toMatchObject({
      headlessSpawn: {
        png: {
          receiptId,
          worktree: {
            branch,
            ownership: "created_by_request",
            path,
          },
        },
      },
    });
    const mismatched = structuredClone(diagnostics);
    mismatched.worktreeCreations[0].path =
      "/workspace/dure/.worktrees/wrong";
    expect(() =>
      captureInteractionEvidence({ png: { headlessSpawn: mismatched } }),
    ).toThrow("does not join request to pane");
  });

  it("binds orchestration media to two live agents and one ordered typed channel", () => {
    const scenario = scenarioById("orchestration-channel");
    expect(providersForScenario(scenario)).toEqual(["codex", "claude"]);
    expect(scenario.setup.map(({ action }) => action)).toEqual([
      "activateDesktop",
      "openAgent",
      "openAgent",
      "equalizeGridColumns",
      "advanceOrchestrationChannel",
    ]);
    expect(scenario.timeline.map(({ phaseId }) => phaseId)).toEqual([
      "dispatched",
      "working",
      "decision",
      "resolved",
    ]);
    const fixture = scenario.fixture.orchestrationChannel;
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      desktopId: "desk-launch",
      coordinator: "release-lead",
      gate: { id: "g1", resolution: "preserve" },
    });
    expect(fixture.agentBindings.map(({ provider }) => provider)).toEqual([
      "codex",
      "claude",
    ]);
    expect(fixture.phases.map(({ id }) => id)).toEqual([
      "queued",
      "dispatched",
      "working",
      "decision",
      "resolved",
    ]);
    expect([...new Set(fixture.messages.map(({ type }) => type))]).toEqual([
      "note",
      "dispatch",
      "heartbeat",
      "worker_done",
      "decision_gate",
    ]);
    expect(
      new Set(fixture.messages.map(({ idempotencyKey }) => idempotencyKey)).size,
    ).toBe(fixture.messages.length);
    const rebuilt = createOrchestrationChannelFixture(scenario.clock);
    expect(rebuilt).toEqual(fixture);
    const invalid = structuredClone(scenario);
    invalid.timeline.push({
      atMs: 7_000,
      action: "advanceOrchestrationChannel",
      desktopId: "desk-launch",
      phaseId: "resolved",
    });
    expect(validateScenario(invalid)).toContain(
      "orchestrationChannel phases must advance exactly once in order",
    );
  });

  it("records exactly-once orchestration phases joined to visible agent panes", () => {
    const fixture = scenarioById("orchestration-channel").fixture
      .orchestrationChannel;
    const contract = {
      agentBindings: fixture.agentBindings,
      desktopId: fixture.desktopId,
      gateId: fixture.gate.id,
      messageIds: fixture.messages.map(({ id }) => id),
      messages: fixture.messages.map(({ from, id, taskId, to, type }) => ({
        from,
        id,
        taskId,
        to,
        type,
      })),
      phaseIds: fixture.phases.map(({ id }) => id),
      phases: fixture.phases.map((phase) => ({
        gateStatus: phase.gateStatus,
        id: phase.id,
        messageIds: phase.messageIds,
        taskStates: phase.taskStates,
      })),
      taskIds: fixture.tasks.map(({ id }) => id),
    };
    const advances = fixture.phases.map((phase) => ({
      agentBindings: fixture.agentBindings,
      agentComments: phase.agentComments,
      desktopId: fixture.desktopId,
      gateStatus: phase.gateStatus,
      messageIds: phase.messageIds,
      phaseId: phase.id,
      taskStates: phase.taskStates,
      terminalSessionId: "terminal-orchestration",
    }));
    const presentations = advances.map(
      ({ agentBindings, agentComments: _, ...advance }) => ({
        ...advance,
        agentPanels: agentBindings,
      }),
    );
    const diagnostics = { advances, contract, presentations };
    expect(
      captureInteractionEvidence({
        png: { orchestrationChannel: diagnostics },
        webm: { orchestrationChannel: structuredClone(diagnostics) },
      }),
    ).toMatchObject({
      schemaVersion: 1,
      orchestrationChannel: {
        png: {
          agentIds: ["agent-test-triage", "agent-copy-review"],
          gateId: "g1",
          messageCount: 9,
          phaseIds: ["queued", "dispatched", "working", "decision", "resolved"],
          taskIds: ["t17", "t18"],
        },
      },
    });
    const duplicate = structuredClone(diagnostics);
    duplicate.presentations.push(structuredClone(duplicate.presentations.at(-1)));
    expect(() =>
      captureInteractionEvidence({
        png: { orchestrationChannel: duplicate },
      }),
    ).toThrow("must be exactly-once");
    const mismatched = structuredClone(diagnostics);
    mismatched.presentations[2].agentPanels = structuredClone(
      mismatched.presentations[2].agentPanels,
    );
    mismatched.presentations[2].agentPanels[0].sessionId = "wrong-session";
    expect(() =>
      captureInteractionEvidence({
        png: { orchestrationChannel: mismatched },
      }),
    ).toThrow("does not join its presentation");
  });

  it("renders the desktop menu clock without host locale or timezone input", () => {
    expect(captureStageClockLabel("2026-07-31T09:30:00.000Z")).toBe(
      "Fri Jul 31  9:30 AM",
    );
    expect(() => captureStageClockLabel("not-a-clock")).toThrow(
      "captureStage clock must be a valid timestamp",
    );
  });

  it("bootstraps the desktop stage before an app reload can paint full-frame", () => {
    const scenario = scenarioById("session-recovery");
    const css = captureStageBootstrapCss(scenario);
    expect(css).toContain('content: "Dure"');
    expect(css).toContain('content: "Fri Jul 31  9:30 AM"');
    expect(css).toContain("left: 54px");
    expect(css).toContain("top: 50px");
    expect(css).toContain("width: 1812px");
    expect(css).toContain("height: 982px");
    expect(captureStageBootstrapCss(scenarioById("hmux-multiple-views"))).toBe(
      "",
    );
  });

  it("pins reconnect live output to the staged pane grid", () => {
    const reconnect = scenarioById("hmux-app-reconnect");
    expect(reconnect.liveTerminalSize).toEqual({ columns: 101, rows: 49 });
    expect(
      declaredTerminalSize(
        reconnect,
        "codex",
        "session-codex-reconnect",
      ),
    ).toEqual({ columns: 101, rows: 49 });
    expect(declaredTerminalSize({}, "codex", "session-unknown")).toBeUndefined();
    expect(
      terminalViewportGeometryFromSurface({
        canonicalColumns: "101",
        renderedRowCount: 49,
        viewportRows: "49",
      }),
    ).toEqual({ columns: 101, rows: 49 });
    expect(
      terminalViewportGeometryFromSurface({
        canonicalColumns: null,
        renderedRowCount: 0,
        viewportRows: null,
      }),
    ).toBeNull();
    expect(
      resolvedMeasuredTerminalSize(
        { columns: 101, rows: 49 },
        {
          canonicalColumns: "101",
          renderedRowCount: 22,
          viewportRows: "22",
        },
      ),
    ).toEqual({ columns: 101, rows: 22 });
    expect(resolvedMeasuredTerminalSize({ columns: 71, rows: 26 }, null)).toEqual(
      { columns: 71, rows: 26 },
    );
  });

  it("drives onboarding through the production preview before committing panes", () => {
    const onboarding = scenarioById("onboarding-walkthrough");
    expect(onboarding.terminalRequired).toBe(false);
    expect(onboarding.expectedRecoveryOverlayCount).toBe(0);
    expect(onboarding.liveTerminalSize).toEqual({ columns: 66, rows: 26 });
    expect(onboarding.fixture.projects).toEqual([]);
    expect(onboarding.fixture.agents).toEqual([]);
    expect(onboarding.fixture.onboardingDismissed).toBe(false);
    expect(
      onboarding.fixture.providerConversations.map((record) => [
        record.provider,
        record.executionLocation,
      ]),
    ).toEqual([
      ["codex", "local"],
      ["claude", "local"],
      ["kimi", "ssh"],
      ["codex", "local"],
    ]);
    expect(onboarding.timeline.map(({ action }) => action)).toEqual([
      "openOnboarding",
      "renameOnboardingDesktop",
      "moveOnboardingPane",
      "confirmOnboarding",
    ]);
    expect(onboarding.stillAtMs).toBeLessThan(
      onboarding.timeline.find(({ action }) => action === "confirmOnboarding")
        .atMs,
    );
    expect(JSON.stringify(onboarding.fixture)).not.toMatch(/\/(?:Users|home)\//u);
  });

  it("crosses a real reload boundary before confirming standalone recovery", () => {
    const recovery = scenarioById("session-recovery");
    expect(recovery.allowRecoveryOverlayDuringTimeline).toBeUndefined();
    expect(recovery.expectedRecoveryOverlayCount).toBe(0);
    expect(captureProofRequirements(recovery)).toMatchObject({
      boundary: "reboot-stale-session",
      profile: "hmux-reboot-stale-recovery-v1",
      requiredProviderSource: "fixture",
      requiredSurface: "browser-client",
      status: "recovered",
    });
    expect(recovery.fixture.sessionRecovery).toMatchObject({
      schemaVersion: 1,
      requiresConfirmation: true,
      source: {
        sessionName: "deploy-watch",
        terminalEpoch: "epoch-before-reboot",
        outputSeq: "842",
      },
      replacement: {
        sessionName: "deploy-watch",
        terminalEpoch: "epoch-after-reboot",
      },
    });
    expect(recovery.setup.map(({ action }) => action)).toEqual([
      "openRecoveryTerminal",
    ]);
    expect(recovery.timeline.map(({ action }) => action)).toEqual([
      "reloadForSessionRecovery",
      "openSessionRecovery",
      "confirmSessionRecovery",
      "showRecoveredTerminal",
      "focusTerminal",
    ]);
    expect(
      recovery.fixture.terminalSnapshots[
        recovery.fixture.sessionRecovery.replacement.sessionId
      ],
    ).toContain("New Host · new PTY · new terminal epoch");
    expect(JSON.stringify(recovery.fixture)).not.toMatch(/\/(?:Users|home)\//u);
  });

  it("keeps one live Hmux generation across an app-client reconnect", () => {
    const reconnect = scenarioById("hmux-app-reconnect");
    const agent = reconnect.fixture.agents[0];
    expect(captureProofRequirements(reconnect)).toMatchObject({
      boundary: "client-reconnect",
      profile: "hmux-client-reconnect-v1",
      requiredSurface: "browser-client",
      requiresLiveContinuity: true,
      status: "reattached",
    });
    expect(reconnect.fixture.agents).toHaveLength(1);
    expect(agent).toMatchObject({ provider: "codex", started: true });
    expect(reconnect.setup.map(({ action }) => action)).toEqual([
      "openAgent",
      "openTerminal",
    ]);
    expect(reconnect.timeline.map(({ action }) => action)).toEqual([
      "reloadAppClient",
      "focusTerminal",
    ]);
    const reload = reconnect.timeline[0];
    expect(reload.sessionId).toBe(agent.sessionId);
    expect(reload.panelId).toBe(`agent:${agent.id}`);
    expect(reload.reconnectReadyAtMs).toBeGreaterThan(reload.atMs);
    expect(providersForScenario(reconnect)).toEqual(["codex"]);
    expect(JSON.stringify(reconnect.fixture)).not.toMatch(/\/(?:Users|home)\//u);
  });

  it("refuses contradictory or unproved lifecycle capture claims", () => {
    const contradictory = structuredClone(scenarioById("hmux-app-reconnect"));
    contradictory.requiresNativeWindows = true;
    contradictory.requiresControllerLeaseProof = true;
    contradictory.nativeSessionWindowAgentId = contradictory.fixture.agents[0].id;
    expect(validateScenario(contradictory)).toContain(
      "legacy capture proof flags are unsupported; use captureProof",
    );

    const relabeled = structuredClone(scenarioById("hmux-app-reconnect"));
    relabeled.captureProof = {
      schemaVersion: 1,
      profile: "native-app-restart-v1",
    };
    expect(validateScenario(relabeled)).toContain(
      "captureProof.profile native-app-restart-v1 is unsupported",
    );

    const incompleteRecovery = structuredClone(scenarioById("session-recovery"));
    incompleteRecovery.timeline = incompleteRecovery.timeline.filter(
      ({ action }) => action !== "confirmSessionRecovery",
    );
    expect(validateScenario(incompleteRecovery)).toContain(
      "captureProof.profile hmux-reboot-stale-recovery-v1 requires exactly one confirmSessionRecovery action",
    );
  });

  it("projects one proof contract into browser and native evidence", () => {
    const continuityEvidence = [
      {
        captureKind: "webm",
        exactSessionFencesPreserved: true,
        processGenerationsLive: true,
        sequencesNondecreasing: true,
      },
    ];
    const reconnect = scenarioById("hmux-app-reconnect");
    expect(captureProofNeedsLiveContinuity(reconnect)).toBe(true);
    expect(
      captureProofManifest({
        captureSurface: "browser-client",
        continuityEvidence,
        providerSource: "live",
        scenario: reconnect,
      }),
    ).toMatchObject({
      schemaVersion: 1,
      profile: "hmux-client-reconnect-v1",
      captureSurface: "browser-client",
      claim: { boundary: "client-reconnect", status: "reattached" },
      limitations: [
        "does-not-observe-native-app-process-exit",
        "does-not-prove-native-app-restart",
      ],
      liveContinuity: { required: true, enforced: true },
      terminalSurface: { required: false, proof: null },
    });
    expect(() =>
      captureProofManifest({
        captureSurface: "native-tauri",
        continuityEvidence,
        providerSource: "live",
        scenario: reconnect,
      }),
    ).toThrow("requires browser-client evidence");

    const multipleViews = scenarioById("hmux-multiple-views");
    expect(() =>
      captureProofManifest({
        captureSurface: "native-tauri",
        continuityEvidence,
        providerSource: "live",
        scenario: multipleViews,
      }),
    ).toThrow("missing terminal surface evidence");
    expect(
      captureProofManifest({
        captureSurface: "native-tauri",
        continuityEvidence,
        terminalSurfaceProof: { schemaVersion: 1, status: "passed" },
        providerSource: "live",
        scenario: multipleViews,
      }),
    ).toMatchObject({
      profile: "hmux-native-view-handoff-v1",
      captureSurface: "native-tauri",
      claim: { boundary: "view-handoff", status: "survived" },
      terminalSurface: { required: true },
    });

    const recovery = scenarioById("session-recovery");
    expect(
      captureProofManifest({
        captureSurface: "browser-client",
        providerSource: "fixture",
        scenario: recovery,
      }),
    ).toMatchObject({
      profile: "hmux-reboot-stale-recovery-v1",
      captureSurface: "browser-client",
      claim: { boundary: "reboot-stale-session", status: "recovered" },
      exactEvidence: [
        "reboot-stale-census-fixture",
        "confirmation-gated-recovery-plan",
        "presentation-checkpoint-replay",
        "pane-binding-retarget",
        "fresh-terminal-epoch",
      ],
      limitations: [
        "uses-deterministic-backend-fixture",
        "does-not-observe-machine-reboot",
        "does-not-observe-native-app-process-exit",
        "does-not-prove-network-disconnect-recovery",
        "does-not-prove-host-crash-recovery",
      ],
      liveContinuity: { required: false, enforced: false, probes: [] },
    });
    expect(() =>
      captureProofManifest({
        captureSurface: "browser-client",
        providerSource: "live",
        scenario: recovery,
      }),
    ).toThrow("requires fixture provider evidence");
  });

  it("rejects private paths and invalid action references", () => {
    const base = structuredClone(MEDIA_CAPTURE_SCENARIOS[0]);
    base.fixture.projects[0].path = "/Users/someone/private-repo";
    base.timeline.push({
      atMs: base.durationMs,
      action: "openAgent",
      agentId: "missing-agent",
    });
    base.timeline.push({
      atMs: base.durationMs,
      action: "openAgent",
      desktopId: "desk-launch",
      agentId: "agent-docs-polish",
      relativeToAgentId: "missing-relative-agent",
      direction: "below",
    });
    base.timeline.push({
      atMs: base.durationMs,
      action: "selectSpaceRange",
      fromSpaceKey: "agent:agent-session-recovery",
      toSpaceKey: "agent:missing-agent",
    });
    base.timeline.push({
      atMs: base.durationMs,
      action: "floatAgent",
      desktopId: "missing-desktop",
      agentId: "missing-agent",
      width: 0,
      height: 0,
      left: -1,
      top: -1,
    });
    base.timeline.push({
      atMs: base.durationMs,
      action: "reloadAppClient",
      desktopId: "desk-launch",
      panelId: "agent:agent-session-recovery",
      sessionId: "missing-session",
      reconnectReadyAtMs: base.durationMs + 1,
    });
    base.readmeGif = {
      schemaVersion: 1,
      segments: [{ startMs: 0, endMs: base.durationMs + 1 }],
      fps: 8,
      width: 960,
      maxColors: 300,
      loop: 0,
    };
    expect(validateScenario(base)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("forbidden private-data pattern"),
        expect.stringContaining("unknown agent"),
        expect.stringContaining("unknown relative agent"),
        expect.stringContaining("unknown space"),
        expect.stringContaining("floatAgent.width"),
        expect.stringContaining("unknown session"),
        expect.stringContaining("reconnect window exceeds"),
        expect.stringContaining("readmeGif.segments must stay within"),
        expect.stringContaining("readmeGif.maxColors"),
      ]),
    );
  });

  it("replays recognizable provider screens without private session data", () => {
    expect(PROVIDER_SCREEN_FIXTURES.codex).toContain("gpt-5.6-sol xhigh");
    expect(PROVIDER_SCREEN_FIXTURES.codex).toContain("›");
    expect(PROVIDER_SCREEN_FIXTURES.codex).toContain("•");
    expect(
      PROVIDER_SCREEN_FIXTURES.codex.match(/\u001b\[38;5;111m›/gu),
    ).toHaveLength(1);
    expect(PROVIDER_SCREEN_FIXTURES.codex).toContain("Ran");
    expect(PROVIDER_SCREEN_FIXTURES.codex).toContain("Worked for");
    expect(PROVIDER_SCREEN_FIXTURES.codex).toContain("gpt-5.6-sol xhigh");
    expect(PROVIDER_SCREEN_FIXTURES.codex).toContain("Goal achieved");
    expect(PROVIDER_SCREEN_FIXTURES.codex.split("\r\n").length).toBeLessThanOrEqual(28);
    expect(PROVIDER_SCREEN_FIXTURES.claude).toContain("❯");
    expect(PROVIDER_SCREEN_FIXTURES.claude).toContain("⏺");
    expect(PROVIDER_SCREEN_FIXTURES.claude).toContain("thinking");
    expect(
      PROVIDER_SCREEN_FIXTURES.claude.match(/\u001b\[38;5;183m❯/gu),
    ).toHaveLength(2);
    expect(
      PROVIDER_SCREEN_FIXTURES.claude.split("\r\n").length,
    ).toBeLessThanOrEqual(30);
    expect(PROVIDER_SCREEN_FIXTURES.claude).toContain("Newspapering");
    expect(PROVIDER_SCREEN_FIXTURES.claude).toContain(
      "Read 1 file, ran 6 shell commands",
    );
    expect(PROVIDER_SCREEN_FIXTURES.claude).toContain("bypass permissions on");
    expect(PROVIDER_SCREEN_FIXTURES.claudeSafe).toContain("accept edits on");
    expect(PROVIDER_SCREEN_FIXTURES.claudeSafe).not.toContain(
      "bypass permissions on",
    );
    for (const screen of Object.values(PROVIDER_SCREEN_FIXTURES)) {
      expect(screen).not.toMatch(/\/(?:Users|home)\//u);
      expect(screen).not.toMatch(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu,
      );
      expect(screen).not.toContain("Resync Siblings");
      expect(screen).not.toContain("Reconnect Session");
      expect(screen).toContain("\u001b[?25l");
    }
    expect(PROVIDER_SCREEN_FIXTURES.codex).toContain(
      "Find and fix a bug in @filename",
    );
    const overview = scenarioById("workspace-overview");
    expect(overview.durationMs).toBeGreaterThanOrEqual(15_000);
    expect(overview.fixture.desktops.map(({ name }) => name)).toEqual([
      "Launch",
      "Review",
      "Operate",
    ]);
    expect(overview.timeline).toContainEqual(
      expect.objectContaining({
        action: "activateDesktop",
        desktopId: "desk-operate",
      }),
    );
    expect(overview.timeline).toContainEqual({
      atMs: 450,
      action: "floatAgent",
      desktopId: "desk-launch",
      agentId: "agent-session-recovery",
      width: 508,
      height: 467,
      left: 76,
      top: 300,
    });
    expect(
      overview.timeline.filter((step) => step.action === "floatAgent"),
    ).toHaveLength(1);
    expect(overview.timeline).toContainEqual(
      expect.objectContaining({
        action: "focusTerminal",
        desktopId: "desk-launch",
      }),
    );
    expect(overview.timeline).toContainEqual(
      expect.objectContaining({
        action: "openAgent",
        desktopId: "desk-launch",
        agentId: "agent-keyboard-nav",
        relativeToAgentId: "agent-api-review",
        direction: "right",
      }),
    );
    expect(overview.timeline).toContainEqual({
      atMs: 1_300,
      action: "equalizeGridColumns",
      desktopId: "desk-launch",
      columns: [1, 2, 2],
      panelColumns: [
        ["term:*"],
        ["agent:agent-api-review", "agent:agent-docs-polish"],
        ["agent:agent-keyboard-nav", "agent:agent-release-gate"],
      ],
    });
    expect(
      overview.timeline
        .filter(
          (step) =>
            step.action === "openAgent" &&
            step.desktopId === "desk-launch" &&
            step.agentId !== "agent-session-recovery",
        )
        .map(({ agentId, relativeToAgentId, relativeToTerminal, direction }) => ({
          agentId,
          relativeToAgentId,
          relativeToTerminal,
          direction,
        })),
    ).toEqual([
      {
        agentId: "agent-api-review",
        relativeToAgentId: undefined,
        relativeToTerminal: true,
        direction: "right",
      },
      {
        agentId: "agent-keyboard-nav",
        relativeToAgentId: "agent-api-review",
        relativeToTerminal: undefined,
        direction: "right",
      },
      {
        agentId: "agent-docs-polish",
        relativeToAgentId: "agent-api-review",
        relativeToTerminal: undefined,
        direction: "below",
      },
      {
        agentId: "agent-release-gate",
        relativeToAgentId: "agent-keyboard-nav",
        relativeToTerminal: undefined,
        direction: "below",
      },
    ]);
    expect(overview.fixture.diffBadges["agent-keyboard-nav"]).toBeUndefined();
    expect(
      Object.values(overview.fixture.agentDisplayStates).filter(
        (state) => state === "working",
      ),
    ).toHaveLength(7);
    expect(overview.timeline).toContainEqual(
      expect.objectContaining({
        action: "openDiff",
        agentId: "agent-session-recovery",
      }),
    );
    expect(Object.keys(overview.fixture.diffBadges)).toHaveLength(2);
    expect(overview.fixture.diffBadges["agent-session-recovery"]).toMatchObject({
      added: 318,
      deleted: 7,
      files: 3,
    });
    const review = overview.fixture.diffReviews["agent-session-recovery"];
    const diffLines = review.diff.split("\n");
    expect(diffLines.filter((line) => line.startsWith("diff --git "))).toHaveLength(
      review.files.length,
    );
    expect(
      diffLines.filter(
        (line) => line.startsWith("+") && !line.startsWith("+++"),
      ),
    ).toHaveLength(318);
    expect(
      diffLines.filter(
        (line) => line.startsWith("-") && !line.startsWith("---"),
      ),
    ).toHaveLength(7);
    for (const [desktopId, agentIds] of [
      ["desk-review", ["agent-test-triage", "agent-copy-review"]],
      ["desk-operate", ["agent-release-operator", "agent-rollout-watch"]],
    ]) {
      expect(
        overview.setup
          .filter(
            (step) => step.action === "openAgent" && step.desktopId === desktopId,
          )
          .map((step) => step.agentId),
      ).toEqual(agentIds);
      expect(
        overview.setup.filter(
          (step) => step.action === "openTerminal" && step.desktopId === desktopId,
        ),
      ).toHaveLength(2);
    }
    expect(Object.keys(overview.fixture.terminalScreensByCwd)).toHaveLength(4);
    expect(new Set(Object.values(overview.fixture.terminalScreensByCwd)).size).toBe(4);
    expect(overview.fixture.terminalSnapshots["session-kimi"]).toContain(
      "SSH connected",
    );
    expect(
      overview.fixture.agents.every(
        (agent) =>
          agent.runtimeBinding?.runtime === "hmux_managed_v1" &&
          agent.runtimeBinding.sessionId === agent.sessionId,
      ),
    ).toBe(true);
    expect(
      overview.fixture.agents.find(({ id }) => id === "agent-api-review")
        ?.runtimeBinding,
    ).toMatchObject({
      source: "ssh",
      hostId: "host-buildbox",
      workspaceId: "workspace-project-atlas",
    });
  });

  it("shares one current structured-terminal backend capability contract", () => {
    expect(MEDIA_BACKEND_FEATURES).toEqual(
      expect.arrayContaining([
        "hmux.terminal-state-binary-v1",
        "hmux.standalone-terminal-surface-v1",
        "hmux.managed-create-advance-v1",
        "hmux.managed-shell-v1",
        "hmux.initial-agent-prompt-v1",
        "hmux.remote-structured-terminal-v1",
        "hmux.remote-pane-departure-v1",
        "hmux.remote-initial-agent-prompt-v1",
      ]),
    );
    expect(MEDIA_BACKEND_FEATURES).not.toContain(
      "hmux.standalone-controller-canary-v1",
    );
    expect(MEDIA_BACKEND_FEATURES).not.toContain("hmux.remote-controller-v1");
    const runtimeFingerprint = `git-object-v1:${"a".repeat(40)}`;
    expect(
      mediaBackendCapabilities({
        buildId: "build-media",
        name: "media-test",
        runtimeFingerprint,
      }),
    ).toMatchObject({
      buildId: "build-media",
      name: "media-test",
      protocolVersion: 1,
      runtimeFingerprint,
      features: ["app.runtime-fingerprint-v1", ...MEDIA_BACKEND_FEATURES],
    });
    expect(
      mediaBackendCapabilities({
        buildId: "build-media",
        name: "media-test",
      }),
    ).toMatchObject({
      runtimeFingerprint: null,
      features: [...MEDIA_BACKEND_FEATURES],
    });
  });

  it("permits a blank painted projection only at an explicit replay boundary", async () => {
    const bounds = { top: 0, left: 0, width: 640, height: 320 };
    const presentation = {
      dataset: {
        terminalCanonicalColumns: "80",
        terminalViewportRows: "24",
      },
    };
    const viewport = {
      dataset: { projectionRevision: "1" },
      getBoundingClientRect: () => bounds,
      querySelectorAll: () => [],
      textContent: "",
    };
    const host = {
      classList: { contains: () => false },
      getBoundingClientRect: () => bounds,
      querySelector: (selector) =>
        selector === TERMINAL_SURFACE_SELECTORS.presentation
          ? presentation
          : viewport,
    };
    await withTemporaryGlobals(
      {
        getComputedStyle: () => ({
          display: "block",
          opacity: "1",
          visibility: "visible",
        }),
      },
      async () => {
        expect(terminalSurfaceIsPresentable(host)).toBe(false);
        expect(terminalSurfaceReadiness(host).reasons).toEqual([
          "empty-visible-text",
        ]);
        expect(
          terminalSurfaceIsPresentable(
            host,
            TERMINAL_SURFACE_SELECTORS,
            { requireVisibleText: false },
          ),
        ).toBe(true);
        expect(
          terminalSurfaceReadiness(host, TERMINAL_SURFACE_SELECTORS, {
            requireVisibleText: false,
          }),
        ).toMatchObject({ presentable: true, reasons: [] });
      },
    );
  });

  it("keeps the media backend independent from the general QA mock", async () => {
    const [mock, capture] = await Promise.all([
      readFile(resolve(repoRoot, "tools/media-capture/tauri-mock.js"), "utf8"),
      readFile(
        resolve(repoRoot, "tools/media-capture/runtime/browser-capture.mjs"),
        "utf8",
      ),
    ]);
    expect(mock).not.toContain("/Users/");
    expect(mock).not.toContain("scripts/qa/tauri-mock");
    expect(mock).toContain("__DURE_MEDIA_CAPTURE_CONFIG__");
    expect(mock).toContain("config.windowChrome?.fullscreen");
    expect(mock).toContain('case "diff_review_target_create"');
    expect(mock).toContain('case "diff_review_snapshot"');
    expect(mock).toContain("terminalScreensByCwd");
    expect(mock).toContain("fixture.defaultTerminalSnapshotGeometry");
    expect(mock).toContain("defaultTerminalSnapshotGeometry");
    expect(mock).toContain('case "append_hmux_connection_diagnostics"');
    expect(mock).toContain("hmuxConnectionDiagnostics");
    expect(capture).toContain(
      "defaultTerminalSnapshotGeometry: terminalCaptureSize(scenario)",
    );
    expect(mock).toContain("terminalCwds.set");
    expect(mock).toContain("resumed: false");
    expect(mock).toContain("if (!probe.resumed) return");
    expect(mock).toContain("cancelTerminalRenderProbe");
    expect(mock).toContain("activeDesktop?.contains(element)");
    expect(mock).toContain("bounds.left < window.innerWidth");
    expect(mock).toContain('case "hmux_managed_create"');
    expect(mock).toContain('case "hmux_managed_create_advance_v1"');
    expect(mock).toContain('case "hmux_managed_shell_create"');
    expect(mock).toContain('case "hmux_plan_recovery"');
    expect(mock).toContain('case "hmux_execute_recovery"');
    expect(mock).toContain('case "list_remote_provider_conversations"');
  });

  it("shares one Host-atomic prompt receipt and journal projection", async () => {
    const mockSource = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const scenario = structuredClone(scenarioById("headless-spawn"));
    const prompt = "Continue";
    const promptLen = new TextEncoder().encode(prompt).byteLength;
    const digest = `sha256:${createHash("sha256").update(prompt).digest("hex")}`;
    Object.assign(scenario.fixture.headlessSpawn.request, {
      promptDigest: digest,
      promptLen,
    });
    const window = {
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        fixture: scenario.fixture,
      },
    };
    vm.runInNewContext(mockSource, {
      TextDecoder,
      TextEncoder,
      atob,
      btoa,
      structuredClone,
      window,
    });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const localRequest = {
      sessionId: "session-prompt",
      workspaceId: "workspace-prompt",
      expectedFence: { terminalEpoch: "terminal-prompt" },
      prompt,
    };
    const writeProof = {
      terminalEpoch: "terminal-prompt",
      recordId: "1",
      inputBaselineOutputSequence: "0",
      initialAgentRuntimeRevision: "1",
    };

    await expect(
      invoke("hmux_initial_agent_prompt", { request: localRequest }),
    ).resolves.toEqual(writeProof);
    await expect(
      invoke("remote_hmux_initial_agent_prompt", {
        request: {
          prompt,
          session: {
            sessionId: "session-prompt",
            workspaceId: "workspace-prompt",
            terminalEpoch: "terminal-prompt",
          },
          target: { hostId: "host-prompt" },
        },
      }),
    ).resolves.toEqual({
      hostId: "host-prompt",
      sessionId: "session-prompt",
      workspaceId: "workspace-prompt",
      ...writeProof,
    });

    window.__DURE_MEDIA_CAPTURE_MOCK__.beginHeadlessSpawn({
      desktopId: "desk-launch",
      terminalSessionId: "terminal-source",
    });
    const receiptId = scenario.fixture.headlessSpawn.receiptId;
    await invoke("spawn_journal_append", {
      receiptId,
      event: {
        event: "step_started",
        step: "prompt_delivery",
        detail: { deliveryContract: "host_atomic_v1" },
      },
    });
    await invoke("spawn_journal_append", {
      receiptId,
      event: {
        event: "step_succeeded",
        step: "prompt_delivery",
        detail: {
          deliveryContract: "host_atomic_v1",
          promptDigest: digest,
          promptLen,
          receipt: writeProof,
        },
      },
    });
    await expect(
      invoke("spawn_receipt_get", { receiptId }),
    ).resolves.toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "prompt_delivery",
          status: "ok",
          evidence: expect.objectContaining({ level: "written_to_pty" }),
          delivery: expect.objectContaining({
            state: "written_to_pty",
            promptDigest: digest,
            promptLen,
            receipt: writeProof,
          }),
        }),
      ]),
    });
  });

  it("does not emulate the retired automation marker adapter", async () => {
    const mock = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const window = {
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        fixture: {},
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
      },
    };
    vm.runInNewContext(mock, { TextDecoder, TextEncoder, atob, btoa, window });

    await expect(
      window.__TAURI_INTERNALS__.invoke("hebbian_list", {
        prefix: "auto-run-",
      }),
    ).resolves.toBeNull();
  });

  it("resizes the exact capture session without an interactive attachment", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        sessionId: "standalone-1",
        receipt: {
          state: "applied_to_terminal",
          columns: 92,
          rows: 40,
        },
      }),
    }));
    const state = {
      env: {
        PATH: "/fixture/bin",
        HMUX_SESSION_ID: "ambient-session",
      },
      fixture: { discoveryRoot: "/fixture/discovery" },
      hmux: "/fixture/bin/hmux",
      run,
      terminalSize: { columns: 92, rows: 40 },
    };

    await expect(resizeHmuxSession(state, "standalone-1")).resolves.toEqual({
      columns: 92,
      rows: 40,
    });
    expect(run).toHaveBeenCalledWith(
      "/fixture/bin/hmux",
      [
        "--discovery-root",
        "/fixture/discovery",
        "--json",
        "resize",
        "--target",
        "standalone-1",
        "--columns",
        "92",
        "--rows",
        "40",
      ],
      {
        env: { PATH: "/fixture/bin" },
        timeoutMs: 5_000,
      },
    );
  });

  it("does not retain retired Hmux or browser terminal runtimes", async () => {
    const commandSurfaces = [
      {
        path: "src-tauri/src/lib.rs",
        commands: [
          "hmux_observer_attach",
          "hmux_observer_open_channel",
          "hmux_observer_set_presentation",
          "hmux_observer_detach",
          "hmux_observer_request_snapshot",
          "hmux_observer_sequences",
          "hmux_observer_watermarks",
        ],
      },
      {
        path: "src-tauri/src/remote_hmux.rs",
        commands: [
          "remote_hmux_observer_attach",
          "remote_hmux_observer_detach",
          "remote_hmux_observer_request_snapshot",
          "remote_hmux_observer_set_presentation",
        ],
      },
      {
        path: "tools/media-capture/tauri-mock.js",
        commands: [
          "hmux_observer_attach",
          "hmux_observer_detach",
          "hmux_observer_request_snapshot",
          "hmux_observer_sequences",
          "hmux_observer_watermarks",
          "remote_hmux_observer_attach",
          "remote_hmux_observer_detach",
          "remote_hmux_observer_request_snapshot",
          "remote_hmux_observer_set_presentation",
        ],
      },
      {
        path: "src-tauri/src/hmux/mod.rs",
        commands: [
          "struct ObserverTask",
          "fn run_observer(",
          "OBSERVER_EVENT",
          "observer_activations:",
          "mod controller;",
          "controller_leases:",
        ],
      },
      {
        path: "src-tauri/src/qa.rs",
        commands: [
          "ControllerAttachRequest",
          ".attach_controller(",
          ".controller_write(",
          ".detach_controller(",
          "controller_external_input_availability",
        ],
      },
      {
        path: "src-tauri/src/qa/terminal_resize_render.rs",
        commands: [
          "ControllerAttachRequest",
          "attach_controller(",
          ".controller_write(",
          ".detach_controller(",
        ],
      },
      {
        path: "scripts/qa/hmux-managed-input-smoke.sh",
        commands: ["hmux::controller::tests"],
      },
      {
        path: "package.json",
        commands: ["test:hmux-controller-lease"],
      },
      {
        path: "src-tauri/src/hmux/remote_pane.rs",
        commands: [
          "RemoteControllerTask",
          "attach_remote_controller",
          "AttachedSessionController",
          "ControllerMutationHandle",
          "ControllerEventEnvelope",
          "project_snapshot",
        ],
      },
      {
        path: "src-tauri/src/server.rs",
        commands: ["/qa/hmux/controller/input"],
      },
      {
        path: "src/lib/terminal/protocol/terminalStateProtocol.ts",
        commands: [
          'case "snapshot"',
          'case "mutation"',
          'case "historyPage"',
          'case "snapshotPart"',
          'case "historyRequest"',
        ],
      },
      {
        path: "src/lib/terminal/protocol/terminalStateSemanticValidation.ts",
        commands: [
          "validateTerminalStateSnapshot",
          "validateTerminalMutation",
          "validateTerminalHistoryPage",
          "validateTerminalSnapshotPart",
          "validateTerminalHistoryRequest",
        ],
      },
      {
        path: "src/lib/terminal/protocol/terminalViewportMultipartAssembler.ts",
        commands: ["historyRequest"],
      },
      {
        path: "mobile/src/app.ts",
        commands: [
          'from "./terminal"',
          "sendSessionInput",
          "sendSessionResize",
          "relayEvents",
          'terminal.kind === "legacy"',
        ],
      },
      {
        path: "mobile/src/ipc.ts",
        commands: [
          'kind: "legacy"',
          '"send_session_input"',
          '"send_session_resize"',
          '"relay://output"',
          '"relay://stopped"',
        ],
      },
      {
        path: "mobile/src-tauri/src/lib.rs",
        commands: [
          "enum MobileAttachment",
          "should_fallback_to_legacy",
          "activate_legacy(",
          "open_attachment(",
          "open_relayed_transport(",
        ],
      },
      {
        path: "mobile/src-tauri/src/terminal_attach.rs",
        commands: [
          "Legacy {",
          "activate_legacy(",
          "pump_legacy_output",
          "send_session_input(",
          "send_session_resize(",
        ],
      },
      {
        path: "mobile/src-tauri/src/relay.rs",
        commands: [
          "pub fn attach_command",
          "pub enum AttachAuthority",
          "pub struct RelayAttachment",
          "pub fn open_attachment",
          "pub fn open_relayed_transport",
        ],
      },
      {
        path: "mobile/src-tauri/examples/relay_probe.rs",
        commands: ["open_attachment", "relay_output", "initial_snapshot"],
      },
      {
        path: "mobile/src/main.ts",
        commands: ["@xterm/xterm/css"],
      },
      {
        path: "mobile/package.json",
        commands: ['"@xterm/'],
      },
      {
        path: "src-tauri/src/lib.rs",
        commands: [
          "remote_hmux_controller_attach",
          "remote_hmux_controller_detach",
          "remote_hmux_controller_write",
          "remote_hmux_controller_resize",
          "remote_hmux_controller_request_snapshot",
          "remote_hmux_controller_set_presentation",
          "remote_hmux_controller_depart_gracefully",
        ],
      },
      {
        path: "src-tauri/src/remote_hmux.rs",
        commands: [
          "remote_hmux_controller_attach",
          "remote_hmux_controller_detach",
          "remote_hmux_controller_write",
          "remote_hmux_controller_resize",
          "remote_hmux_controller_request_snapshot",
          "remote_hmux_controller_set_presentation",
          "remote_hmux_controller_depart_gracefully",
        ],
      },
      {
        path: "tools/media-capture/tauri-mock.js",
        commands: [
          'case "hmux_controller_attach"',
          'case "hmux_controller_resize_delegated"',
          'case "hmux_controller_request_snapshot"',
          'case "hmux_controller_write"',
          'case "hmux_controller_resize"',
          'case "hmux_controller_detach"',
          'case "hmux_controller_set_presentation"',
          'case "remote_hmux_controller_attach"',
          'case "remote_hmux_controller_detach"',
          'case "remote_hmux_controller_write"',
          'case "remote_hmux_controller_resize"',
          'case "remote_hmux_controller_request_snapshot"',
          'case "remote_hmux_controller_set_presentation"',
          'case "remote_hmux_controller_depart_gracefully"',
        ],
      },
    ];

    for (const surface of commandSurfaces) {
      const source = await readFile(resolve(repoRoot, surface.path), "utf8");
      for (const command of surface.commands) {
        expect(source, `${surface.path} still exposes ${command}`).not.toContain(
          command,
        );
      }
    }

    for (const path of [
      "src-tauri/src/hmux/observer_activation.rs",
      "src-tauri/src/hmux/observer_attach_request.rs",
      "src-tauri/src/hmux/observer_delivery.rs",
      "src-tauri/src/hmux/observer_snapshot_channel.rs",
      "src-tauri/src/hmux/controller.rs",
      "src-tauri/src/hmux/remote_controller.rs",
      "scripts/qa/hmux-controller-lease-smoke.sh",
      "tools/media-capture/native/controller-proof.mjs",
      "src/lib/terminal/state/terminalStateMutationValidation.ts",
      "src/lib/terminal/state/terminalStateRepairRed.test.ts",
      "mobile/src/terminal.ts",
    ]) {
      await expect(readFile(resolve(repoRoot, path), "utf8")).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    }
  });

  it("serves isolated onboarding discovery and managed terminal receipts", async () => {
    const mock = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const structuredFrames = [];
    const window = {
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        backendCapabilities: { buildId: "1.2.3+abcdef123456" },
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        fixture: {
          agents: [],
          providerConversations: [
            {
              provider: "codex",
              id: "local-conversation",
              executionLocation: "local",
            },
            {
              provider: "kimi",
              id: "remote-conversation",
              executionLocation: "ssh",
              hostId: "host-studio",
            },
          ],
          providerConversationDetails: [
            {
              provider: "codex",
              conversationId: "local-conversation",
              executionLocation: "local",
              totalCount: 1,
              subagents: [{ id: "child-local", title: "Local child" }],
            },
            {
              provider: "kimi",
              conversationId: "remote-conversation",
              executionLocation: "ssh",
              hostId: "host-studio",
              totalCount: 1,
              subagents: [{ id: "child-remote", title: "Remote child" }],
            },
          ],
          terminalScreensByCwd: { "/workspace/dure": "managed screen" },
          structuredTerminalCodec: {
            decodeTerminalStateRecord: () => ({
              metadata: { recordId: 17n },
              record: {
                body: {
                  case: "inputIntent",
                  value: {
                    intent: {
                      case: "resize",
                      value: { columns: 90, rows: 24 },
                    },
                  },
                },
              },
            }),
            inputReceiptRecord: () => Uint8Array.of(73),
            resizeAppliedReceiptRecord: () => Uint8Array.of(82),
            visibleProviderText: (value) => value,
            viewportFrameRecord: (frame) => {
              structuredFrames.push(frame);
              return Uint8Array.of(Number(frame.projectionRevision));
            },
          },
        },
      },
    };
    vm.runInNewContext(mock, { TextDecoder, TextEncoder, atob, btoa, window });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const initialDefaults = await invoke("dure_backend_request", {
      operation: "provider_launch_defaults.get",
      body: { schemaVersion: 1 },
    });
    expect(initialDefaults.result.document.defaults).toEqual({});
    const savedDefaults = await invoke("dure_backend_request", {
      operation: "provider_launch_defaults.put",
      body: {
        schemaVersion: 1,
        expectedRevision: 1,
        idempotencyKey: "onboarding-permissions",
        defaults: { claude: { permissionMode: "bypass_approvals" } },
      },
    });
    expect(savedDefaults.result.document).toMatchObject({
      revision: 2,
      defaults: { claude: { permissionMode: "bypass_approvals" } },
    });
    await expect(invoke("list_provider_conversations")).resolves.toEqual([
      expect.objectContaining({ id: "local-conversation" }),
    ]);
    await expect(
      invoke("list_remote_provider_conversations", { hostId: "host-studio" }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "remote-conversation" }),
    ]);
    await expect(
      invoke("provider_conversation_details", {
        provider: "codex",
        conversationId: "local-conversation",
      }),
    ).resolves.toMatchObject({
      totalCount: 1,
      subagents: [{ id: "child-local" }],
    });
    await expect(
      invoke("remote_provider_conversation_details", {
        hostId: "host-studio",
        provider: "kimi",
        conversationId: "remote-conversation",
      }),
    ).resolves.toMatchObject({
      totalCount: 1,
      subagents: [{ id: "child-remote" }],
    });
    const created = await invoke("hmux_managed_create", {
      idempotencyKey: "create-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      cwd: "/workspace/dure",
    });
    expect(created).toMatchObject({
      idempotencyKey: "create-1",
      outcome: "created",
      session: {
        sessionId: "session-1",
        workspaceId: "workspace-1",
        lifecycle: "ready",
        stopFence: {
          runnerPrincipal: "media-user",
          runnerInstance: "runner-session-1",
          channelEpoch: "1",
          hostInstanceId: "host-session-1",
          terminalEpoch: "epoch-session-1",
        },
      },
    });
    await expect(
      invoke("hmux_managed_shell_create", {
        idempotencyKey: "shell-1",
        sessionId: "shell-session-1",
        workspaceId: "dure-local-shells-v1",
        cwd: "/workspace/dure",
      }),
    ).resolves.toMatchObject({
      idempotencyKey: "shell-1",
      outcome: "created",
      session: {
        sessionId: "shell-session-1",
        workspaceId: "dure-local-shells-v1",
        sessionClass: "managed",
        lifecycle: "ready",
      },
    });
    await expect(
      invoke("hmux_managed_create_advance_v1", {
        request: {
          idempotencyKey: "advance-1",
          sessionId: "advance-session-1",
          workspaceId: "workspace-advance",
          cwd: "/workspace/dure",
        },
      }),
    ).resolves.toMatchObject({
      state: "current",
      receipt: {
        idempotencyKey: "advance-1",
        cwd: "/workspace/dure",
        outcome: "created",
        session: {
          sessionId: "advance-session-1",
          workspaceId: "workspace-advance",
        },
      },
    });
    const structured = await invoke("hmux_structured_terminal_attach", {
      observerId: "observer-structured",
      sessionId: "shell-session-1",
      workspaceId: "dure-local-shells-v1",
    });
    expect(structured).toMatchObject({
      terminalEpoch: "epoch-shell-session-1",
      throughOutputSeq: "1",
      stateRevision: "1",
      initialDeliveryRecordCount: 1,
      selectedCapabilities: ["terminal_state_binary_v1"],
    });
    const initialRecord = await invoke("hmux_structured_terminal_next", {
      observerId: "observer-structured",
    });
    expect([...new Uint8Array(initialRecord)]).toEqual([1]);
    await expect(
      invoke("hmux_structured_terminal_upstream", {
        observerId: "observer-structured",
        record: [84, 83, 80, 66],
      }),
    ).resolves.toBe("17");
    const resizedRecords = [];
    for (let index = 0; index < 3; index += 1) {
      resizedRecords.push(
        new Uint8Array(
          await invoke("hmux_structured_terminal_next", {
            observerId: "observer-structured",
          }),
        )[0],
      );
    }
    expect(resizedRecords).toEqual([2, 82, 3]);
    expect(
      structuredFrames.slice(-2).map((frame) => ({
        columns: frame.columns,
        projectionRevision: String(frame.projectionRevision),
        rows: frame.texts.length,
      })),
    ).toEqual([
      { columns: 90, projectionRevision: "2", rows: 24 },
      { columns: 90, projectionRevision: "3", rows: 24 },
    ]);
    expect(
      window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics()
        .terminalViewportGeometry["shell-session-1"],
    ).toEqual({ columns: 90, rows: 24 });
    const remoteStructured = await invoke(
      "remote_hmux_structured_terminal_attach",
      {
        request: {
          observerId: "observer-remote-structured",
          surfaceId: "surface-remote",
          target: { hostId: "host-studio" },
          session: {
            sessionId: "remote-session-1",
            workspaceId: "workspace-remote",
            sessionClass: "managed",
            lifecycle: "ready",
            providerId: "kimi",
          },
        },
      },
    );
    expect(remoteStructured).toMatchObject({
      selectedCapabilities: ["terminal_state_binary_v1"],
      session: {
        sessionId: "remote-session-1",
        workspaceId: "workspace-remote",
        runtimeHost: "host-studio",
      },
    });
    expect(
      [
        ...new Uint8Array(
          await invoke("hmux_structured_terminal_next", {
            observerId: "observer-remote-structured",
          }),
        ),
      ],
    ).toEqual([1]);
  });

  it("advances the authoritative structured frame when repainting a terminal", async () => {
    const mock = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const window = {
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        fixture: {
          agents: [],
          structuredTerminalCodec: {
            viewportFrameRecord,
            visibleProviderText,
          },
          terminalScreensByCwd: { "/workspace/dure": "managed screen" },
        },
      },
    };
    vm.runInNewContext(mock, { TextDecoder, TextEncoder, atob, btoa, window });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke("hmux_managed_create", {
      idempotencyKey: "create-sequence",
      sessionId: "session-sequence",
      workspaceId: "workspace-sequence",
      cwd: "/workspace/dure",
    });
    await invoke("hmux_structured_terminal_attach", {
      observerId: "observer-sequence",
      sessionId: "session-sequence",
      workspaceId: "workspace-sequence",
    });
    const initial = decodeTerminalStateRecord(
      new Uint8Array(
        await invoke("hmux_structured_terminal_next", {
          observerId: "observer-sequence",
        }),
      ),
    );

    const first = window.__DURE_MEDIA_CAPTURE_MOCK__.repaintHmuxTerminal(
      "session-sequence",
    );
    const firstFrame = decodeTerminalStateRecord(
      new Uint8Array(
        await invoke("hmux_structured_terminal_next", {
          observerId: "observer-sequence",
        }),
      ),
    );
    const second = window.__DURE_MEDIA_CAPTURE_MOCK__.repaintHmuxTerminal(
      "session-sequence",
    );
    const secondFrame = decodeTerminalStateRecord(
      new Uint8Array(
        await invoke("hmux_structured_terminal_next", {
          observerId: "observer-sequence",
        }),
      ),
    );
    const reattached = await invoke("hmux_structured_terminal_attach", {
      observerId: "observer-reattached",
      sessionId: "session-sequence",
      workspaceId: "workspace-sequence",
    });
    const reattachedFrame = decodeTerminalStateRecord(
      new Uint8Array(
        await invoke("hmux_structured_terminal_next", {
          observerId: "observer-reattached",
        }),
      ),
    );

    expect(initial.record.throughOutputSeq).toBe(1n);
    expect(first.sequenceThrough).toBe("2");
    expect(second.sequenceThrough).toBe("3");
    expect(firstFrame.record.throughOutputSeq).toBe(2n);
    expect(secondFrame.record.throughOutputSeq).toBe(3n);
    expect(reattached.throughOutputSeq).toBe("3");
    expect(reattachedFrame.record.throughOutputSeq).toBe(3n);
  });

  it("keeps reboot recovery generation-fenced across the mock cold start", async () => {
    const mock = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const values = new Map();
    const sessionStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    const source = {
      sessionId: "source-session",
      sessionName: "deploy-watch",
      workspaceId: "workspace-release",
      hostBuildVersion: "build-old",
      terminalEpoch: "epoch-old",
      outputSeq: "842",
    };
    const replacement = {
      sessionId: "replacement-session",
      sessionName: "deploy-watch",
      workspaceId: "workspace-release",
      hostBuildVersion: "build-current",
      terminalEpoch: "epoch-new",
      outputSeq: "3",
    };
    const window = {
      sessionStorage,
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        fixture: {
          agents: [],
          structuredTerminalCodec: {
            viewportFrameRecord,
            visibleProviderText,
          },
          terminalSnapshots: {
            [source.sessionId]: "screen before reboot",
            [replacement.sessionId]: "screen after reboot",
          },
          sessionRecovery: {
            schemaVersion: 1,
            source,
            replacement,
            requiresConfirmation: true,
          },
        },
      },
    };
    vm.runInNewContext(mock, {
      Date,
      TextDecoder,
      TextEncoder,
      atob,
      btoa,
      window,
    });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await expect(invoke("hmux_list_sessions")).resolves.toEqual([
      expect.objectContaining({
        sessionId: source.sessionId,
        lifecycle: "ready",
        health: "current_healthy",
      }),
    ]);

    sessionStorage.setItem(
      "dure-media-session-recovery-stage-v1",
      "stale",
    );
    await expect(invoke("hmux_control_plane_census")).resolves.toMatchObject({
      sessions: [
        {
          sessionId: source.sessionId,
          lifecycle: "unavailable",
          health: "stale_transport",
          terminalEpoch: "epoch-old",
        },
      ],
    });
    const request = {
      sessionId: source.sessionId,
      workspaceId: source.workspaceId,
      kind: "plain_shell",
      confirmed: false,
    };
    await expect(
      invoke("hmux_plan_recovery", { request }),
    ).resolves.toMatchObject({
      action: "none",
      allowed: false,
      reason: "update_requires_confirmation",
      requiresConfirmation: true,
    });
    await expect(
      invoke("hmux_execute_recovery", { request }),
    ).resolves.toMatchObject({
      outcome: "refused",
      reason: "update_requires_confirmation",
    });
    await expect(
      invoke("hmux_execute_recovery", {
        request: { ...request, confirmed: true },
      }),
    ).resolves.toMatchObject({
      outcome: "restored",
      replayed: false,
      replacementSession: {
        sessionId: replacement.sessionId,
        terminalEpoch: "epoch-new",
        inputAllowed: true,
      },
    });
    await expect(
      invoke("hmux_structured_terminal_attach", {
        observerId: "observer-recovered",
        sessionId: replacement.sessionId,
        workspaceId: replacement.workspaceId,
      }),
    ).resolves.toMatchObject({
      terminalEpoch: "epoch-new",
      throughOutputSeq: "3",
      selectedCapabilities: ["terminal_state_binary_v1"],
    });
  });

  it("binds a newly-created terminal snapshot to its requested cwd", async () => {
    const mock = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const window = {
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        fixture: {
          defaultTerminalSnapshotGeometry: { columns: 74, rows: 28 },
          terminalScreensByCwd: {
            "/workspace/dure/qa/focus-tests": "focus fixture",
          },
          terminalSnapshots: {
            "provider-session": "provider fixture",
          },
        },
      },
    };
    vm.runInNewContext(mock, { TextEncoder, btoa, window });
    const invoke = window.__TAURI_INTERNALS__.invoke;

    window.__DURE_MEDIA_CAPTURE_MOCK__.registerTerminalCwd(
      "local-session",
      "/workspace/dure/qa/focus-tests",
    );
    const snapshot = await invoke("pty_screen_snapshot", {
      id: "local-session",
    });
    expect(Buffer.from(snapshot.data, "base64").toString("utf8")).toBe(
      "focus fixture",
    );
    const providerSnapshot = await invoke("pty_screen_snapshot", {
      id: "provider-session",
    });
    expect(Buffer.from(providerSnapshot.data, "base64").toString("utf8")).toBe(
      "provider fixture",
    );
    expect(
      window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics()
        .terminalSnapshotGeometry,
    ).toEqual({
      "local-session": { columns: 74, rows: 28 },
      "provider-session": { columns: 74, rows: 28 },
    });
  });

  it("models native clipboard read, SSH upload, and terminal path insertion as one receipt", async () => {
    const mock = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const image = {
      dataB64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ext: "png",
    };
    const remotePath = "/tmp/dure-media-demo/architecture-overview.png";
    const window = {
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        fixture: {
          clipboardImagePaste: {
            schemaVersion: 1,
            agentId: "remote-agent",
            sessionId: "remote-session",
            image,
            remotePath,
          },
          terminalSnapshots: { "remote-session": "Kimi Code\r\n❯ " },
        },
      },
    };
    vm.runInNewContext(mock, {
      TextDecoder,
      TextEncoder,
      atob,
      btoa,
      window,
    });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await expect(invoke("read_clipboard_image")).resolves.toEqual(image);
    await expect(
      invoke("ssh_upload_image", { id: "remote-session", ...image }),
    ).resolves.toBe(remotePath);
    await expect(
      invoke("ssh_write", {
        id: "remote-session",
        data: `${remotePath} `,
      }),
    ).resolves.toBeNull();
    expect(
      window.__DURE_MEDIA_CAPTURE_MOCK__.repaintTerminal(
        "remote-session",
        "ssh",
      ),
    ).toMatchObject({ consumers: 0, sourceGeometry: { columns: 71, rows: 26 } });
    expect(
      window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics().clipboardImagePaste,
    ).toEqual({
      uploads: [
        {
          bytes: 70,
          ext: "png",
          remotePath,
          sessionId: "remote-session",
        },
      ],
      writes: [{ data: `${remotePath} `, sessionId: "remote-session" }],
    });
    const snapshot = await invoke("ssh_screen_snapshot", {
      id: "remote-session",
    });
    expect(Buffer.from(snapshot.data, "base64").toString("utf8")).toContain(
      `${remotePath} `,
    );
  });

  it("replaces subscribed terminal screens through the Tauri snapshot event contract", async () => {
    const mock = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const window = {
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        fixture: {
          agents: [
            { sessionId: "provider-session", sessionKind: "pty" },
          ],
          terminalSnapshots: { "provider-session": "first screen" },
        },
      },
    };
    vm.runInNewContext(mock, {
      TextDecoder,
      TextEncoder,
      atob,
      btoa,
      window,
    });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const events = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback((event) =>
      events.push(event),
    );
    await invoke("plugin:event|listen", {
      event: "session:snapshot-required",
      handler,
    });
    const initial = await invoke("pty_screen_snapshot", {
      id: "provider-session",
    });
    window.__DURE_MEDIA_CAPTURE_MOCK__.publishTerminalSnapshot({
      kind: "pty",
      id: "provider-session",
      repaintBase64: Buffer.from("between snapshot and subscribe").toString(
        "base64",
      ),
    });
    const racedSubscription = await invoke("session_output_subscribe", {
      kind: "pty",
      id: "provider-session",
      consumerId: "consumer-raced",
      startOffset: initial.endOffset,
    });
    expect(racedSubscription.snapshotRequired).toBe(true);
    await invoke("session_output_unsubscribe", {
      id: "provider-session",
      consumerId: "consumer-raced",
    });

    const current = await invoke("pty_screen_snapshot", {
      id: "provider-session",
    });
    await invoke("session_output_subscribe", {
      kind: "pty",
      id: "provider-session",
      consumerId: "consumer-1",
      startOffset: current.endOffset,
    });

    const published = window.__DURE_MEDIA_CAPTURE_MOCK__.publishTerminalSnapshot({
      kind: "pty",
      id: "provider-session",
      repaintBase64: Buffer.from("second screen").toString("base64"),
      columns: 80,
      rows: 24,
    });
    expect(published.consumers).toBe(1);
    expect(published.sourceGeometry).toEqual({ columns: 80, rows: 24 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "session:snapshot-required",
      payload: {
        kind: "pty",
        id: "provider-session",
        consumerId: "consumer-1",
        endOffset: published.endOffset,
      },
    });
    const resumed = await invoke("session_screen_snapshot_and_resume", {
      id: "provider-session",
      consumerId: "consumer-1",
    });
    expect(Buffer.from(resumed.snapshot.data, "base64").toString("utf8")).toBe(
      "second screen",
    );
    expect(resumed.snapshot.endOffset).toBe(published.endOffset);
    await expect(
      window.__DURE_MEDIA_CAPTURE_MOCK__.waitForTerminalSnapshotResume({
        id: "provider-session",
        endOffset: published.endOffset,
        consumerIds: published.consumerIds,
      }),
    ).resolves.toMatchObject({
      resumedConsumers: ["consumer-1"],
      endOffset: published.endOffset,
    });

    await invoke("session_output_unsubscribe", {
      id: "provider-session",
      consumerId: "consumer-1",
    });
    window.__DURE_MEDIA_CAPTURE_MOCK__.publishTerminalSnapshot({
      kind: "pty",
      id: "provider-session",
      repaintBase64: Buffer.from("third screen").toString("base64"),
    });
    expect(events).toHaveLength(1);
  });

  it("binds a late-mounted terminal host when its output consumer subscribes", async () => {
    const mock = await readFile(
      resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
      "utf8",
    );
    const agentHost = {
      dataset: {},
      getBoundingClientRect: () => ({
        bottom: 500,
        height: 400,
        left: 20,
        right: 620,
        top: 100,
        width: 600,
      }),
    };
    const terminalHost = {
      dataset: {},
      getBoundingClientRect: () => ({
        bottom: 500,
        height: 400,
        left: 620,
        right: 1_220,
        top: 100,
        width: 600,
      }),
    };
    const activeDesktop = {
      contains: (candidate) =>
        candidate === agentHost || candidate === terminalHost,
    };
    const agentPanel = {
      id: "pane_opaque_identity",
      params: { agentRef: { agentId: "agent-late-host" } },
      group: {
        element: {
          querySelector: (selector) =>
            selector === ".terminal-host" ? agentHost : null,
        },
      },
    };
    const document = {
      getElementById: (id) =>
        id === "desktop-panel-desk-live" ? activeDesktop : null,
      querySelectorAll: (selector) => {
        if (selector === ".terminal-host") return [agentHost, terminalHost];
        if (selector === "[data-dure-media-session-id]") {
          return [agentHost, terminalHost].filter(
            (host) => host.dataset.dureMediaSessionId,
          );
        }
        return [];
      },
    };
    const window = {
      __DURE_DOCK__: {
        mountedDockviewEntries: () => [
          [
            "desk-live",
            {
              panels: [agentPanel],
            },
          ],
        ],
      },
      __DURE_MEDIA_CAPTURE_CONFIG__: {
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
        fixture: {
          agents: [
            {
              id: "agent-late-host",
              sessionId: "session-late-host",
            },
          ],
        },
      },
      __DURE_STORE__: {
        getState: () => ({ activeDesktopId: "desk-live" }),
      },
      innerHeight: 1_080,
      innerWidth: 1_920,
    };
    vm.runInNewContext(mock, {
      TextDecoder,
      TextEncoder,
      atob,
      btoa,
      document,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      window,
    });
    await window.__TAURI_INTERNALS__.invoke("session_output_subscribe", {
      id: "session-late-host",
      consumerId: "consumer-late-host",
      startOffset: 0,
    });
    expect(agentHost.dataset.dureMediaSessionId).toBe("session-late-host");
    expect(terminalHost.dataset.dureMediaSessionId).toBeUndefined();
  });

  it("maps a launched tour terminal to its recorded live source", async () => {
    const mock = await readFile(resolve(repoRoot, "tools/media-capture/tauri-mock.js"), "utf8");
    const window = { __DURE_MEDIA_CAPTURE_CONFIG__: { terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS, fixture: {
      productTour: { screens: { codex: "fixture fallback" } },
      terminalSnapshots: { "tour-session-new": "actual provider recording" },
      terminalSnapshotGeometry: { "tour-session-new": { columns: 48, rows: 15 } },
    } } };
    vm.runInNewContext(mock, { TextDecoder, TextEncoder, atob, btoa, structuredClone, window });
    const capture = window.__DURE_MEDIA_CAPTURE_MOCK__;
    expect(capture.resolveTerminalSessionId("tour-session-new")).toBe("tour-session-new");
    await window.__TAURI_INTERNALS__.invoke("hmux_managed_create", { sessionId: "launched-codex", workspaceId: "workspace-tour", command: "codex" });
    expect(capture.resolveTerminalSessionId("tour-session-new")).toBe("launched-codex");
    expect(capture.resolveTerminalSessionId("unrelated")).toBe("unrelated");
    expect(capture.diagnostics().terminalSnapshotGeometry["launched-codex"]).toEqual({ columns: 48, rows: 15 });
  });

  it("answers exact session inspection without crossing workspace identities", async () => {
    const mock = await readFile(resolve(repoRoot, "tools/media-capture/tauri-mock.js"), "utf8");
    const window = { __DURE_MEDIA_CAPTURE_CONFIG__: { terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS, fixture: {} } };
    vm.runInNewContext(mock, { TextDecoder, TextEncoder, atob, btoa, window });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const { session } = await invoke("hmux_managed_create", { sessionId: "tour-session", workspaceId: "tour-workspace" });
    const absent = { sessionId: "tour-session", workspaceId: "another-workspace" };
    await expect(invoke("hmux_inspect_sessions_exact", { targets: [
      { sessionId: "tour-session", workspaceId: "tour-workspace" }, absent,
    ] })).resolves.toEqual([{ outcome: "found", session }, { outcome: "not_found", ...absent }]);
  });

  it("uses canonical Dure QA globals while retaining the legacy harness alias", async () => {
    const [capture, liveStill, qa, qaGlobals, spacesRows] = await Promise.all([
      readFile(
        resolve(repoRoot, "tools/media-capture/runtime/browser-capture.mjs"),
        "utf8",
      ),
      readFile(
        resolve(repoRoot, "tools/media-capture/runtime/live-terminal-still.mjs"),
        "utf8",
      ),
      readFile(resolve(repoRoot, "src/qa.ts"), "utf8"),
      readFile(resolve(repoRoot, "src/lib/qa/qaHarnessGlobals.ts"), "utf8"),
      readFile(resolve(repoRoot, "src/components/spaces/SpacesRows.tsx"), "utf8"),
    ]);
    expect(capture).toContain("__DURE_DOCK__");
    expect(capture).toContain("__DURE_STORE__");
    expect(capture).toContain('/src/lib/scm/status/diffBadgesStore.ts');
    expect(capture).toContain('/src/lib/agents/agentAttentionStore.ts');
    expect(capture).toContain('new PointerEvent("pointerdown"');
    expect(capture).toContain('closest(".dv-tab")');
    expect(capture).toContain(".dv-resize-handle-bottomright");
    expect(capture).toContain(".dv-floating-titlebar");
    expect(capture).toContain("saveLayout(desktopId, api.toJSON())");
    expect(capture).toContain("sessionActivity: Object.fromEntries");
    expect(capture).toContain('code: element.getAttribute("title")');
    expect(capture).toContain("dureMediaSessionId");
    expect(capture).toContain('classList.contains("bg-glass-pane/75")');
    // v4 전환(2026-08-17): ring-inset은 v3 문법이라 inset-ring 계열로 바뀌었다.
    expect(spacesRows).toContain('"bg-glass-pane/75 inset-ring-1');
    expect(liveStill).not.toContain(".xterm");
    expect(capture).not.toContain("__HEBBIAN_DOCK__");
    expect(capture).not.toContain("__HEBBIAN_STORE__");
    // dock was de-barreled (2026-08-17): the QA namespace is recomposed from
    // the real defining modules so external harness scripts keep one surface.
    expect(qa).toContain("exposeQaHarnessGlobals(");
    expect(qa).toContain(
      "{ ...dock, ...dockRegistry, ...fileViewerPane, ...standaloneShellTerminal }",
    );
    expect(qaGlobals).toContain("globals.__DURE_DOCK__ = dock");
    expect(qaGlobals).toContain("globals.__DURE_DIFF_BADGES__ = diffBadges");
    expect(qaGlobals).not.toContain("__HEBBIAN_");
  });
});

describe("native multi-window media", () => {
  it("encodes the explicit blank projection used before native live replay", () => {
    expect(() =>
      decodeTerminalStateRecord(
        viewportFrameRecord({
          columns: 92,
          texts: Array.from({ length: 40 }, () => ""),
        }),
      ),
    ).not.toThrow();
  });

  const proof = "0123456789abcdef0123456789abcdef";

  it("binds the native window bridge to one proof and command allowlist", () => {
    const request = {
      schemaVersion: 1,
      channel: "dure-native-media-window-v1",
      proof,
      requestId: 1,
      command: "plugin:webview|create_webview_window",
      args: { options: {} },
    };
    expect(parseNativeWindowBridgeRequest(request, proof)).toBe(request);
    expect(
      nativeWindowBridgeResponse({ proof, requestId: 1, result: { ok: true } }),
    ).toEqual({
      schemaVersion: 1,
      channel: "dure-native-media-window-v1",
      proof,
      requestId: 1,
      result: { ok: true },
    });
    expect(() =>
      parseNativeWindowBridgeRequest(
        { ...request, command: "plugin:shell|execute" },
        proof,
      ),
    ).toThrow("request is invalid");
    expect(() =>
      parseNativeWindowBridgeRequest(request, "f".repeat(32)),
    ).toThrow("request is invalid");
  });

  it("scrubs ambient live snapshots unless this run supplies one", () => {
    const base = {
      PATH: "/fixture/bin",
      VITE_DURE_NATIVE_MEDIA_SNAPSHOT_OVERRIDE: "ambient-private-frame",
    };
    const options = {
      baseEnvironment: base,
      durationMs: 3_000,
      fps: 6,
      output: "/fixture/output",
      plan: [{ label: "main" }],
      proof,
      scenarioId: "workspace-overview",
    };
    expect(nativeMediaRunnerEnvironment(options)).toMatchObject({
      DURE_NATIVE_MEDIA_REPLAY_REQUIRED: "0",
      VITE_DURE_NATIVE_MEDIA_SNAPSHOT_OVERRIDE: "",
    });
    expect(
      nativeMediaRunnerEnvironment({
        ...options,
        replayRequired: true,
        snapshotOverride: "this-run-live-frame",
      }),
    ).toMatchObject({
      PATH: "/fixture/bin",
      DURE_NATIVE_MEDIA_REPLAY_REQUIRED: "1",
      VITE_DURE_NATIVE_MEDIA_SNAPSHOT_OVERRIDE: "this-run-live-frame",
    });
  });

  it("keeps the native frame scenario catalog browser-safe", async () => {
    const [catalog, validation] = await Promise.all([
      readFile(resolve(repoRoot, "tools/media-capture/scenarios.mjs"), "utf8"),
      readFile(
        resolve(repoRoot, "tools/media-capture/runtime/recipe-validation.mjs"),
        "utf8",
      ),
    ]);
    expect(catalog).toContain('from "./runtime/recipe-validation.mjs"');
    expect(catalog).not.toContain('from "./runtime/gif-derivative.mjs"');
    expect(catalog).not.toContain('from "./runtime/webm-derivative.mjs"');
    expect(validation).not.toContain('from "node:');
  });

  it("preserves the legacy hidden single-window QA config by default", () => {
    expect(
      qaTauriConfig({
        layer: "exclusive_focus",
        port: "1420",
        title: "Dure QA",
        url: "index.html?qaWindowSmokeController=1",
      }),
    ).toEqual({
      build: {
        devUrl: "http://127.0.0.1:1420",
        beforeDevCommand:
          "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1420 --strictPort",
      },
      app: {
        windows: [
          {
            label: "main",
            title: "Dure QA",
            url: "index.html?qaWindowSmokeController=1",
            width: 480,
            height: 240,
            visible: false,
            focus: false,
            focusable: false,
            backgroundThrottling: "disabled",
          },
        ],
      },
    });
  });

  it("builds two bounded real-Tauri windows from the declared native plan", () => {
    const plan = nativeWindowPlan({ proof, scenarioId: "workspace-overview" });
    const serialized = JSON.stringify(plan);
    const windows = qaWindowPlan({
      serialized,
      title: "ignored",
      url: "index.html",
    });
    expect(windows).toHaveLength(2);
    expect(windows.map(({ label }) => label)).toEqual(["main", "native-operate"]);
    expect(windows.every(({ visible, focusable }) => visible && focusable)).toBe(
      true,
    );
    expect(windows.every(({ transparent }) => transparent === false)).toBe(true);
    expect(
      windows.every(({ url }) =>
        url.startsWith("tools/media-capture/native/window.html?"),
      ),
    ).toBe(true);
    expect(
      new Set(expectedNativeWindowTitles(proof).map(({ title }) => title)).size,
    ).toBe(2);
    expect(
      expectedNativeWindowReplayTitles(proof).every(
        ({ title }, index) =>
          title.endsWith("replay-complete") &&
          title !== expectedNativeWindowTitles(proof)[index].title,
      ),
    ).toBe(true);
    expect(
      qaTauriConfig({
        layer: "exclusive_focus_native_media",
        port: "1420",
        serializedWindows: serialized,
        title: "ignored",
        url: "index.html",
      }).app.security.capabilities,
    ).toEqual([
      "default",
      {
        identifier: "exclusive-focus-native-media-window-title-proof",
        windows: ["main", "native-operate"],
        permissions: ["core:window:allow-set-title"],
      },
    ]);
  });

  it("declares one workspace and one dedicated session window for the Hmux scenario", () => {
    const plan = nativeWindowPlan({ proof, scenarioId: "hmux-multiple-views" });
    const windows = qaWindowPlan({
      serialized: JSON.stringify(plan),
      title: "ignored",
      url: "index.html",
    });
    expect(windows.map(({ label }) => label)).toEqual([
      "main",
      "win-session-agent-runtime-observer",
    ]);
    expect(windows.map(({ create }) => create)).toEqual([true, false]);
    expect(windows[0].url).toContain("surface=desktop");
    expect(windows[1].url).toContain("surface=session");
    expect(windows[1].url).toContain("sessionWindow=agent-runtime-observer");
    expect(
      expectedNativeWindowTitles(proof, "hmux-multiple-views").map(
        ({ surface }) => surface,
      ),
    ).toEqual(["desktop", "session"]);
    expect(
      expectedNativeInitialWindowTitles(proof, "hmux-multiple-views").map(
        ({ surface }) => surface,
      ),
    ).toEqual(["desktop"]);
    expect(
      assertNativeInteractionWindowRequest({
        label: "win-session-agent-runtime-observer",
        options: {
          label: "win-session-agent-runtime-observer",
          url: "index.html?sessionWindow=agent-runtime-observer&sourceWindow=main&sourcePane=desk-observe%3Aagent%3Aagent-runtime-observer",
          width: 1_180,
          height: 880,
          focus: true,
        },
        scenarioId: "hmux-multiple-views",
      }),
    ).toMatchObject({
      label: "win-session-agent-runtime-observer",
      surface: "session",
    });
    const scenario = scenarioById("hmux-multiple-views");
    expect(scenario.interfaceMode).toBe("pro");
    expect(captureProofRequirements(scenario)).toMatchObject({
      boundary: "view-handoff",
      profile: "hmux-native-view-handoff-v1",
      requiredSurface: "native-tauri",
      requiresTerminalSurfaceProof: true,
      requiresLiveContinuity: true,
      status: "survived",
    });
    expect(scenario.fixture.agents.map(({ provider }) => provider)).toEqual([
      "codex",
      "claude",
    ]);
    expect(providersForScenario(scenario)).toEqual(["codex", "claude"]);
    expect(scenario.timeline).toEqual([
      {
        atMs: 1_400,
        action: "openSessionWindow",
        desktopId: "desk-observe",
        agentId: "agent-runtime-observer",
      },
      {
        atMs: 4_500,
        action: "toggleWindowMaximize",
        desktopId: "desk-observe",
        agentId: "agent-runtime-observer",
        surface: "session",
        maximized: true,
      },
      {
        atMs: 7_000,
        action: "toggleWindowMaximize",
        desktopId: "desk-observe",
        agentId: "agent-runtime-observer",
        surface: "session",
        maximized: false,
      },
      {
        atMs: 8_500,
        action: "openDiff",
        desktopId: "desk-observe",
        agentId: "agent-runtime-observer",
      },
    ]);
    expect(scenario.fixture.diffReviews["agent-runtime-observer"]).toMatchObject({
      baseRef: "origin/main",
      files: expect.any(Array),
    });
    expect(
      scenario.fixture.agents.every(
        (agent) =>
          agent.runtimeBinding?.runtime === "hmux_managed_v1" &&
          agent.runtimeBinding.sessionId === agent.sessionId,
      ),
    ).toBe(true);
    expect(
      expectedNativeTerminalSurfaceCount(scenario, {
        desktopId: "desk-observe",
        surface: "desktop",
      }),
    ).toBe(2);
    expect(
      expectedNativeTerminalSurfaceCount(scenario, {
        desktopId: "desk-observe",
        surface: "session",
      }),
    ).toBe(1);
    expect(
      expectedNativeTerminalSurfaceCount(scenarioById("workspace-overview"), {
        desktopId: "desk-review",
        surface: "desktop",
      }),
    ).toBe(2);
    const sessionIds = scenario.fixture.agents.map(({ sessionId }) => sessionId);
    expect(
      expectedNativeTerminalSessionIds(scenario, {
        desktopId: "desk-observe",
        surface: "desktop",
      }),
    ).toEqual(sessionIds);
    expect(
      expectedNativeTerminalSessionIds(scenario, {
        desktopId: "desk-observe",
        surface: "session",
      }),
    ).toEqual([sessionIds[0]]);
    expect(
      expectedNativeTerminalSessionIds(scenarioById("workspace-overview"), {
        desktopId: "desk-review",
        surface: "desktop",
      }),
    ).toEqual(["session-codex-review", "session-claude-review"]);
    const replayScenario = structuredClone(scenario);
    replayScenario.nativeTerminalReplay = {
      steps: [
        { id: sessionIds[0], atMs: 0 },
        { id: sessionIds[1], atMs: 100 },
        { id: sessionIds[0], atMs: 2_000 },
        { id: sessionIds[1], atMs: 2_100 },
      ],
    };
    expect(
      nativeTerminalReplayStepsForSurface(replayScenario, {
        desktopId: "desk-observe",
        surface: "desktop",
      }).map(({ id, atMs }) => [id, atMs]),
    ).toEqual([
      [sessionIds[0], 0],
      [sessionIds[1], 100],
      [sessionIds[1], 2_100],
    ]);
    expect(
      nativeTerminalReplayStepsForSurface(replayScenario, {
        desktopId: "desk-observe",
        surface: "session",
      }).map(({ id, atMs }) => [id, atMs]),
    ).toEqual([
      [sessionIds[0], 0],
      [sessionIds[0], 2_000],
    ]);
  });

  it("round-trips only declared terminal snapshots into the native frame", () => {
    const scenario = structuredClone(scenarioById("hmux-multiple-views"));
    const sessionId = scenario.fixture.agents[0].sessionId;
    scenario.fixture.terminalSnapshots[sessionId] = "\u001b[32mlive frame\u001b[0m";
    scenario.fixture.terminalSnapshotGeometry[sessionId] = {
      columns: 92,
      rows: 40,
    };
    const replaySteps = [
      {
        atMs: 750,
        id: sessionId,
        kind: "pty",
        columns: 92,
        rows: 40,
        repaintBase64: Buffer.from("next frame", "utf8").toString("base64"),
        sequenceThrough: "42",
      },
    ];
    const controlUrl =
      "/output/playwright/native-multi-window/hmux-multiple-views/2026-08-04T11:20:11.995Z-af3071badb4d/replay-start.json";
    const encoded = encodeNativeSnapshotOverride(
      scenario,
      replaySteps,
      controlUrl,
    );
    const applied = applyNativeSnapshotOverride(
      scenarioById("hmux-multiple-views"),
      encoded,
    );
    expect(applied.fixture.terminalSnapshots[sessionId]).toBe(
      "\u001b[32mlive frame\u001b[0m",
    );
    expect(applied.fixture.terminalSnapshotGeometry[sessionId]).toEqual({
      columns: 92,
      rows: 40,
    });
    expect(applied.liveProviderSessionIds).toEqual(
      scenario.fixture.agents.map(({ sessionId: id }) => id),
    );
    expect(applied.nativeTerminalReplay).toEqual({
      schemaVersion: 1,
      controlUrl,
      steps: replaySteps,
    });
    expect(() =>
      applyNativeSnapshotOverride(
        scenarioById("workspace-overview"),
        encoded,
      ),
    ).toThrow("envelope is invalid");

    const decoded = JSON.parse(
      Buffer.from(
        encoded.replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("utf8"),
    );
    delete decoded.terminalSnapshotGeometry[sessionId];
    const missingGeometry = Buffer.from(JSON.stringify(decoded), "utf8")
      .toString("base64url");
    expect(() =>
      applyNativeSnapshotOverride(scenario, missingGeometry),
    ).toThrow("geometry is invalid");

    decoded.terminalSnapshotGeometry[sessionId] = { columns: 92, rows: 40 };
    decoded.replaySteps[0].id = "private-session";
    const unknownReplaySession = Buffer.from(JSON.stringify(decoded), "utf8")
      .toString("base64url");
    expect(() =>
      applyNativeSnapshotOverride(scenario, unknownReplaySession),
    ).toThrow("replay is invalid");

    decoded.replaySteps[0].id = sessionId;
    decoded.replaySteps[0].repaintBase64 = "not base64";
    const malformedReplay = Buffer.from(JSON.stringify(decoded), "utf8")
      .toString("base64url");
    expect(() => applyNativeSnapshotOverride(scenario, malformedReplay)).toThrow(
      "replay is invalid",
    );

    decoded.replaySteps[0].repaintBase64 = replaySteps[0].repaintBase64;
    decoded.replayControlUrl = controlUrl.replace(
      "/hmux-multiple-views/",
      "/workspace-overview/",
    );
    const crossScenarioControl = Buffer.from(JSON.stringify(decoded), "utf8")
      .toString("base64url");
    expect(() =>
      applyNativeSnapshotOverride(scenario, crossScenarioControl),
    ).toThrow("replay control is invalid");
  });

  it("waits for native consumers, resume, and xterm paint before advancing replay", async () => {
    const calls = [];
    const mock = {
      beginTerminalRenderProbe: (id) => {
        calls.push(`probe:${id}`);
        return `probe:${id}`;
      },
      publishTerminalSnapshot: (step) => {
        calls.push(`publish:${step.sequenceThrough}`);
        return { consumerIds: ["consumer-1"], endOffset: 42 };
      },
      waitForTerminalSnapshotResume: async ({ renderProbe }) => {
        calls.push(`resume:${renderProbe}`);
      },
      waitForTerminalRender: async (renderProbe) => {
        calls.push(`render:${renderProbe}`);
      },
      cancelTerminalRenderProbe: () => {
        throw new Error("successful replay must not cancel its probe");
      },
    };
    const waits = [];
    const publications = await playNativeTerminalReplay(
      [
        {
          atMs: 0,
          id: "session-1",
          kind: "pty",
          repaintBase64: "YQ==",
          sequenceThrough: "1",
        },
      ],
      {
        initialDelayMs: 100,
        mock,
        now: () => 0,
        wait: async (delayMs) => waits.push(delayMs),
        waitForConsumer: async (id) => {
          calls.push(`consumer:${id}`);
          return { consumerCount: 1, kind: "legacy" };
        },
      },
    );
    expect(waits).toEqual([100]);
    expect(calls).toEqual([
      "consumer:session-1",
      "probe:session-1",
      "publish:1",
      "resume:probe:session-1",
      "render:probe:session-1",
    ]);
    expect(publications).toEqual([
      {
        atMs: 0,
        consumerCount: 1,
        id: "session-1",
        sequenceThrough: "1",
        transport: "legacy",
      },
    ]);
  });

  it("plays native timeline actions only in their owning desktop surface", async () => {
    const scenario = scenarioById("hmux-multiple-views");
    const waits = [];
    const executed = [];
    let elapsedMs = 0;
    const completed = await playNativeScenarioTimeline(
      scenario,
      { desktopId: "desk-observe", surface: "desktop" },
      {
        execute: async (action) => executed.push(action.action),
        now: () => elapsedMs,
        wait: async (delayMs) => {
          waits.push(delayMs);
          elapsedMs += delayMs;
        },
      },
    );
    expect(waits).toEqual([1_400, 7_100]);
    expect(executed).toEqual(["openSessionWindow", "openDiff"]);
    expect(completed).toEqual([
      { action: "openSessionWindow", atMs: 1_400 },
      { action: "openDiff", atMs: 8_500 },
    ]);

    const sessionWaits = [];
    const sessionActions = [];
    elapsedMs = 2_500;
    const sessionCompleted = await playNativeScenarioTimeline(
      scenario,
      { desktopId: "desk-observe", surface: "session" },
      {
        execute: async (action) =>
          sessionActions.push([action.action, action.maximized]),
        now: () => elapsedMs,
        startedAtMs: 0,
        wait: async (delayMs) => {
          sessionWaits.push(delayMs);
          elapsedMs += delayMs;
        },
      },
    );
    expect(sessionWaits).toEqual([2_000, 2_500]);
    expect(sessionActions).toEqual([
      ["toggleWindowMaximize", true],
      ["toggleWindowMaximize", false],
    ]);
    expect(sessionCompleted).toEqual([
      { action: "toggleWindowMaximize", atMs: 4_500 },
      { action: "toggleWindowMaximize", atMs: 7_000 },
    ]);
  });

  it("repaints managed Hmux observers without waiting for PTY resume", async () => {
    const calls = [];
    const mock = {
      beginTerminalRenderProbe: () => "probe-1",
      publishTerminalSnapshot: () => {
        calls.push("publish");
        return { consumerIds: [], endOffset: 42 };
      },
      repaintHmuxTerminal: () => {
        calls.push("hmux-repaint");
        return { observerIds: ["observer-1"] };
      },
      waitForTerminalSnapshotResume: async () => {
        throw new Error("managed Hmux replay must not use PTY resume");
      },
      waitForTerminalRender: async () => calls.push("render"),
      cancelTerminalRenderProbe: () => {
        throw new Error("successful replay must not cancel its probe");
      },
    };
    const result = await playNativeTerminalReplay(
      [
        {
          atMs: 0,
          id: "session-1",
          kind: "pty",
          repaintBase64: "YQ==",
          sequenceThrough: "1",
        },
      ],
      {
        initialDelayMs: 0,
        mock,
        now: () => 0,
        waitForConsumer: async () => ({ consumerCount: 1, kind: "hmux" }),
      },
    );
    expect(calls).toEqual(["publish", "hmux-repaint", "render"]);
    expect(result[0]).toMatchObject({
      consumerCount: 1,
      transport: "hmux",
    });
  });

  it("starts both native windows blank before replaying the live ready frame", () => {
    const scenario = scenarioById("hmux-multiple-views");
    const sessionId = scenario.fixture.agents[0].sessionId;
    const initial = {
      columns: 92,
      rows: 40,
      repaintBase64: Buffer.from("clean provider ready screen", "utf8").toString(
        "base64",
      ),
    };
    const replayBySession = {
      [sessionId]: {
        desktopId: "desk-observe",
        kind: "pty",
        visibleWindows: [{ startMs: 250, endMs: 5_100 }],
        frames: [{ ...initial, sequenceThrough: "1" }],
      },
    };
    const seeded = nativeBlankReplayScenario(scenario, replayBySession);
    expect(seeded.fixture.terminalSnapshots[sessionId]).toBe(
      "\u001b[2J\u001b[3J\u001b[H",
    );
    expect(seeded.fixture.terminalSnapshotGeometry[sessionId]).toEqual({
      columns: 92,
      rows: 40,
    });
    expect(scenario.fixture.terminalSnapshots[sessionId]).not.toBe(
      seeded.fixture.terminalSnapshots[sessionId],
    );
    expect(nativeLiveReplaySteps(replayBySession, 6_000)).toEqual([{
      atMs: 0,
      id: sessionId,
      kind: "pty",
      columns: 92,
      rows: 40,
      repaintBase64: initial.repaintBase64,
      sequenceThrough: "1",
    }]);
  });

  it("does not count a duplicated initial provider frame as native motion", () => {
    expect(
      nativeLiveReplaySteps(
        {
          "session-1": {
            kind: "pty",
            frames: [
              {
                columns: 92,
                rows: 40,
                repaintBase64: "c2FtZS1mcmFtZQ==",
                sequenceThrough: "1",
              },
            ],
            visibleWindows: [{ startMs: 250, endMs: 5_100 }],
          },
        },
        6_000,
      ),
    ).toHaveLength(1);
  });

  it("starts native replay only after the exact frame-zero marker", async () => {
    let attempts = 0;
    const receipt = await waitForNativeTerminalReplayStart(
      { controlUrl: "/owned/replay-start.json", proof: "proof-1" },
      {
        request: async () => {
          attempts += 1;
          return {
            ok: true,
            json: async () =>
              attempts === 1
                ? {
                    schemaVersion: 2,
                    proof: "wrong",
                    startedAtUnixMs: 1_000,
                  }
                : {
                    schemaVersion: 2,
                    proof: "proof-1",
                    startedAtUnixMs: 1_000,
                  },
          };
        },
        wait: async () => {},
      },
    );
    expect(attempts).toBe(2);
    expect(receipt).toEqual({
      schemaVersion: 2,
      proof: "proof-1",
      startedAtUnixMs: 1_000,
    });
  });

  it("records a bounded terminal-surface smoke proof", async () => {
    const times = [1_000, 1_087];
    const proofReceipt = await runTerminalSurfaceProof({
      now: () => times.shift(),
      run: async () => ({ stdout: "terminal surface smoke passed\n", stderr: "" }),
      sourceRevision: "a".repeat(40),
      workingTreeFingerprint: `git-working-tree-v1:${"b".repeat(64)}`,
    });
    expect(proofReceipt).toMatchObject({
      schemaVersion: 1,
      durationMs: 87,
      proofTarget: "hmux-webview-recovery-smoke",
      sourceRevision: "a".repeat(40),
      status: "passed",
    });
    expect(proofReceipt.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      runTerminalSurfaceProof({
        run: async () => {
          throw Object.assign(new Error("failed"), { stderr: "marker missing" });
        },
        sourceRevision: "a".repeat(40),
        workingTreeFingerprint: `git-working-tree-v1:${"b".repeat(64)}`,
      }),
    ).rejects.toThrow("marker missing");
    await expect(
      runTerminalSurfaceProof({
        run: async () => ({ stdout: "ignored", stderr: "" }),
        sourceRevision: "HEAD",
        workingTreeFingerprint: "dirty",
      }),
    ).rejects.toThrow("source revision is invalid");
  });

  it("binds live native capture to one current-source Hmux pair", async () => {
    const calls = [];
    const executableChecks = [];
    const binaries = await stageNativeHmuxRuntime({
      assertExecutable: async (path) => executableChecks.push(path),
      baseEnvironment: {
        DURE_MEDIA_HMUX_BIN: "/global/stale-hmux",
        PATH: "/bin",
      },
      repoRoot: "/repo",
      run: async (command, args) => {
        calls.push([command, args]);
        return command === "rustc"
          ? { stdout: "rustc 1.90.0\nhost: aarch64-apple-darwin\n" }
          : { stdout: "" };
      },
    });
    expect(calls).toEqual([
      ["pnpm", ["hmux:runtime:stage:dev"]],
      ["rustc", ["-vV"]],
    ]);
    expect(binaries).toEqual({
      cli: "/repo/src-tauri/binaries/hmux-aarch64-apple-darwin",
      runtime:
        "/repo/src-tauri/binaries/hmux-runtime-aarch64-apple-darwin",
    });
    expect(executableChecks).toEqual([binaries.cli, binaries.runtime]);
    expect(
      nativeHmuxRuntimeEnvironment(
        { DURE_MEDIA_HMUX_BIN: "/global/stale-hmux" },
        binaries,
      ),
    ).toMatchObject({
      DURE_MEDIA_HMUX_BIN: binaries.cli,
      DURE_QA_HMUX_CLI: binaries.cli,
      DURE_QA_HMUX_RUNTIME: binaries.runtime,
    });
  });

  it("composes the dedicated session window over the workspace without browser chrome", () => {
    const filter = nativeWindowCompositionFilter({
      duration: 6,
      fps: 6,
      scenarioId: "hmux-multiple-views",
    });
    expect(filter).toContain("scale=1120");
    expect(filter).toContain("scale=820");
    expect(filter).toContain("gradients=s=1920x1080");
    expect(filter).toContain("drawbox=x=0:y=0:w=iw:h=32");
    expect(filter).toContain("overlay=x=W-w-40:y=H-h-52");
    expect(filter).not.toContain("color=c=0x0b0e14");
    expect(filter).not.toContain("browser");
  });

  it("uses a deterministic privacy-safe desktop stage for native assets", () => {
    const filter = nativeDesktopStageFilter({ duration: 6, fps: 6 });
    const first = nativeDesktopStageManifest({ fps: 6, frameCount: 36 });
    const second = nativeDesktopStageManifest({ fps: 6, frameCount: 36 });
    expect(NATIVE_DESKTOP_STAGE).toMatchObject({
      schemaVersion: 1,
      stageId: "dure-dusk-native-v1",
      mode: "generated-virtual-desktop",
      canvas: { width: 1920, height: 1080 },
      privacy: {
        desktopPixelsIncluded: false,
        source: "generated-filter-graph",
      },
    });
    expect(filter).toContain("nb_colors=3");
    expect(filter).toContain("seed=0:speed=0");
    expect(filter.match(/drawbox=/gu)).toHaveLength(9);
    expect(first).toEqual(second);
    expect(first.render).toMatchObject({
      engine: "ffmpeg-filter-graph",
      fps: 6,
      frameCount: 36,
      durationMs: 6_000,
    });
    expect(first.render).toMatchObject({
      composition: "independent-full-frame-sequence",
    });
    expect(first.render.frameRecipeSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("encodes native terminal video with seek-safe intra-only VP9 frames", () => {
    expect(nativeWindowVideoEncoding(6)).toEqual({
      codec: "vp9",
      crf: 24,
      bitrate: 0,
      pixelFormat: "yuv420p",
      keyframeInterval: 1,
      automaticAlternateReferenceFrames: false,
      rowMultithreading: false,
      threads: 1,
    });
    expect(nativeWindowVideoEncodingOptions(6)).toEqual([
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-crf",
      "24",
      "-b:v",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "1",
      "-auto-alt-ref",
      "0",
      "-row-mt",
      "0",
      "-threads",
      "1",
    ]);
    const probe = {
      frames: Array.from({ length: 12 }, () => ({ key_frame: 1 })),
      streams: [
        {
          codec_name: "vp9",
          width: 1_920,
          height: 1_080,
          pix_fmt: "yuv420p",
          r_frame_rate: "6/1",
          nb_read_frames: "12",
        },
      ],
      format: { start_time: "0.000000", duration: "2.000000", size: "1000" },
    };
    expect(
      validateNativeWindowVideoProbe(probe, { fps: 6, frameCount: 12 }),
    ).toMatchObject({
      keyFrameIndexes: Array.from({ length: 12 }, (_, index) => index),
    });
    const missingBoundary = structuredClone(probe);
    missingBoundary.frames[6].key_frame = 0;
    expect(() =>
      validateNativeWindowVideoProbe(missingBoundary, {
        fps: 6,
        frameCount: 12,
      }),
    ).toThrow("native window video probe failed");
    expect(nativeWindowFramePath("/tmp/frames/%05d.png", 18)).toBe(
      "/tmp/frames/00018.png",
    );
    expect(() => nativeWindowFramePath("/tmp/frames/frame.png", 0)).toThrow(
      "one %05d token",
    );
  });

  it("rejects unsafe or ambiguous native window plans before app launch", () => {
    const plan = nativeWindowPlan({ proof, scenarioId: "workspace-overview" });
    expect(() =>
      qaWindowPlan({
        serialized: JSON.stringify([plan[0], { ...plan[1], label: plan[0].label }]),
        title: "ignored",
        url: "index.html",
      }),
    ).toThrow("labels must be unique");
    expect(() =>
      qaWindowPlan({
        serialized: JSON.stringify([{ ...plan[0], url: "https://private.example/" }]),
        title: "ignored",
        url: "index.html",
      }),
    ).toThrow("outside the QA allowlist");
    expect(() =>
      qaWindowPlan({
        serialized: JSON.stringify([{ ...plan[0], width: 10_000 }]),
        title: "ignored",
        url: "index.html",
      }),
    ).toThrow("width");
  });

  it("binds exact ready titles to visible layer-zero windows owned by one PID", () => {
    const expected = expectedNativeWindowTitles(proof);
    const probe = normalizeWindowProbe(
      {
        schemaVersion: 1,
        ownerPid: 4242,
        windows: expected.map((identity, index) => ({
          windowId: 90 + index,
          title: identity.title,
          ownerName: "Dure",
          ownerPid: 4242,
          layer: 0,
          alpha: 1,
          onScreen: true,
          sharingState: 1,
          bounds: { x: 40 + index * 900, y: 80, width: 840, height: 650 },
        })),
      },
      4242,
    );
    expect(matchingReadyWindows(probe, expected).map(({ label }) => label)).toEqual([
      "main",
      "native-operate",
    ]);
    const hidden = structuredClone(probe);
    hidden.windows[0].onScreen = false;
    expect(() => matchingReadyWindows(hidden, expected)).toThrow(
      "visible layer-zero surface",
    );
    const duplicate = structuredClone(probe);
    duplicate.windows.push({ ...duplicate.windows[0], windowId: 999 });
    expect(() => matchingReadyWindows(duplicate, expected)).toThrow(
      "expected one exact ready title",
    );
  });

  it("discovers an interaction-created window in either ready state", () => {
    const ready = expectedNativeWindowTitles(proof, "hmux-multiple-views");
    const replay = expectedNativeWindowReplayTitles(
      proof,
      "hmux-multiple-views",
    );
    const probe = normalizeWindowProbe(
      {
        schemaVersion: 1,
        ownerPid: 4242,
        windows: [ready[0], replay[1]].map((identity, index) => ({
          windowId: 90 + index,
          title: identity.title,
          ownerName: "Dure",
          ownerPid: 4242,
          layer: 0,
          alpha: 1,
          onScreen: true,
          sharingState: 1,
          bounds: { x: 40 + index * 900, y: 80, width: 840, height: 650 },
        })),
      },
      4242,
    );
    expect(
      matchingAvailableWindows(probe, [...ready, ...replay]).map(
        ({ label }) => label,
      ),
    ).toEqual(["main", "win-session-agent-runtime-observer"]);
  });

  it("surfaces an exact native setup error instead of reporting a missing ready window", () => {
    const expected = expectedNativeWindowTitles(proof);
    const errors = expectedNativeWindowErrorTitles(proof);
    const probe = normalizeWindowProbe(
      {
        schemaVersion: 1,
        ownerPid: 4242,
        windows: [
          {
            windowId: 90,
            title: errors[0].title,
            ownerName: "Dure",
            ownerPid: 4242,
            layer: 0,
            alpha: 1,
            onScreen: true,
            sharingState: 1,
            bounds: { x: 40, y: 80, width: 840, height: 650 },
          },
        ],
      },
      4242,
    );

    expect(() => matchingReadyWindows(probe, expected, errors)).toThrow(
      "native window main reported a setup error",
    );
  });

  it("binds ordered frame identities and cleanup to the exact app generation", async () => {
    expect(
      orderedFrameDigest([
        { label: "main", frame: 0, sha256: "a".repeat(64), bytes: 10 },
        { label: "native-operate", frame: 0, sha256: "b".repeat(64), bytes: 11 },
      ]),
    ).not.toBe(
      orderedFrameDigest([
        { label: "native-operate", frame: 0, sha256: "b".repeat(64), bytes: 11 },
        { label: "main", frame: 0, sha256: "a".repeat(64), bytes: 10 },
      ]),
    );
    const [client, cli, environment, frame, windowConfig, mock, browserCapture] =
      await Promise.all([
        readFile(
          resolve(repoRoot, "tools/media-capture/native/capture-client.mjs"),
          "utf8",
        ),
        readFile(resolve(repoRoot, "tools/media-capture/native.mjs"), "utf8"),
        readFile(
          resolve(repoRoot, "tools/media-capture/native/environment.mjs"),
          "utf8",
        ),
        readFile(
          resolve(repoRoot, "tools/media-capture/native/frame-entry.mjs"),
          "utf8",
        ),
        readFile(
          resolve(repoRoot, "scripts/qa/lib/tauri-window-config.mjs"),
          "utf8",
        ),
        readFile(
          resolve(repoRoot, "tools/media-capture/tauri-mock.js"),
          "utf8",
        ),
        readFile(
          resolve(repoRoot, "tools/media-capture/runtime/browser-capture.mjs"),
          "utf8",
        ),
      ]);
    expect(client).toContain("macos-screencapture-window-id");
    expect(client).toContain("captureWindowPng(window.windowId");
    expect(client).not.toContain('"-R"');
    expect(cli).toContain("exactProcessGenerationStatus(manifest.appProcess)");
    expect(cli).toContain('options.providerSource === "live"');
    expect(client).toContain("nativeDesktopStageManifest({ fps, frameCount })");
    expect(client).toContain('"independent-full-frame-sequence"');
    expect(client).toContain('"frames/composed/%05d.png"');
    expect(cli).toContain("manifest.captureStage = captureStage");
    expect(environment).toContain("VITE_DURE_NATIVE_MEDIA_SNAPSHOT_OVERRIDE");
    expect(cli.indexOf("exactProcessGenerationStatus")).toBeLessThan(
      cli.indexOf('"cleanup-receipt.json"'),
    );
    expect(frame).toContain("window.top === window || window.__TAURI_INTERNALS__");
    expect(frame).toContain('import("../scenarios.mjs")');
    expect(frame).toContain('fetch("/__app_build_info"');
    expect(frame).not.toContain("native-media-${proof}");
    expect(frame).toContain("surface,");
    expect(frame).toContain('publish("ready")');
    expect(windowConfig).toContain("DURE_QA_WINDOW_PLAN_JSON");
    expect(mock).toContain('config.windowLabel ?? "main"');
    expect(mock).toContain('config.captureSurface === "session"');
    expect(browserCapture).toContain(
      "clipboardImagePaste: scenario.fixture.clipboardImagePaste ?? null",
    );
  });
});

describe("media capture CLI", () => {
  it("keeps native-only scenarios out of the browser capture catalog", () => {
    expect(
      selectCaptureScenarios({ allScenarios: true, format: "all" }).map(
        ({ id }) => id,
      ),
    ).not.toContain("hmux-multiple-views");
    expect(
      selectCaptureScenarios({
        allScenarios: false,
        format: "png",
        scenarioId: "hmux-multiple-views",
      }).map(captureProofNeedsNativeTauri),
    ).toEqual([true]);
  });

  it("parses explicit still and video requests", () => {
    expect(
      parseCaptureArgs([
        "--",
        "--scenario",
        "workspace-overview",
        "--format",
        "webm",
        "--headed",
      ]),
    ).toMatchObject({
      scenarioId: "workspace-overview",
      format: "webm",
      headed: true,
      providerSource: "live",
    });
  });

  it("supports a reproducible README GIF derivative", () => {
    expect(
      parseCaptureArgs([
        "--scenario",
        "onboarding-walkthrough",
        "--format",
        "gif",
      ]),
    ).toMatchObject({ format: "gif" });
    const onboarding = scenarioById("onboarding-walkthrough");
    const recipe = readmeGifRecipe(onboarding);
    expect(recipe).toEqual(onboarding.readmeGif);
    expect(gifFilterGraph(recipe)).toContain(`fps=fps=${recipe.fps}`);
    expect(gifFilterGraph(recipe)).toContain(`max_colors=${recipe.maxColors}`);
    expect(captureArtifactPlan("gif", onboarding)).toEqual({
      png: false,
      webm: true,
      gif: true,
      publicWebm: false,
    });
    const overview = scenarioById("workspace-overview");
    expect(readmeGifRecipe(overview)).toMatchObject({
      fps: 10,
      width: 960,
      segments: [
        { startMs: 1_200, endMs: 3_600 },
        { startMs: 5_000, endMs: 7_800 },
        { startMs: 9_600, endMs: 12_000 },
        { startMs: 12_800, endMs: 15_000 },
      ],
    });
    expect(captureArtifactPlan("gif", overview)).toEqual({
      png: false,
      webm: true,
      gif: true,
      publicWebm: false,
    });
    expect(captureArtifactPlan("all", overview)).toEqual({
      png: true,
      webm: true,
      gif: true,
      publicWebm: true,
    });
    const diffReview = scenarioById("diff-review-workflow");
    expect(readmeGifRecipe(diffReview)).toMatchObject({
      fps: 10,
      width: 960,
      segments: [
        { startMs: 200, endMs: 1_200 },
        { startMs: 1_200, endMs: 7_000 },
      ],
    });
    expect(diffReview.setup).toEqual([
      {
        action: "openAgent",
        desktopId: "desk-review",
        agentId: "agent-keyboard-nav",
        relativeToTerminal: true,
        direction: "right",
      },
    ]);
    expect(diffReview.timeline.map(({ action }) => action)).toEqual([
      "openAgent",
      "openDiff",
    ]);
    expect(captureArtifactPlan("all", diffReview)).toEqual({
      png: true,
      webm: true,
      gif: true,
      publicWebm: true,
    });
    const sshImagePaste = scenarioById("ssh-image-paste");
    expect(readmeGifRecipe(sshImagePaste)).toMatchObject({
      fps: 10,
      width: 960,
      segments: [
        { startMs: 600, endMs: 3_200 },
        { startMs: 3_200, endMs: 7_000 },
      ],
    });
    expect(captureArtifactPlan("all", sshImagePaste)).toEqual({
      png: true,
      webm: true,
      gif: true,
      publicWebm: true,
    });
    const orchestrationChannel = scenarioById("orchestration-channel");
    expect(readmeGifRecipe(orchestrationChannel)).toMatchObject({
      fps: 10,
      width: 960,
      segments: [
        { startMs: 400, endMs: 1_000 },
        { startMs: 1_000, endMs: 8_600 },
      ],
    });
    expect(captureArtifactPlan("all", orchestrationChannel)).toEqual({
      png: true,
      webm: true,
      gif: true,
      publicWebm: true,
    });
    expect(captureArtifactPlan("all", onboarding)).toEqual({
      png: true,
      webm: true,
      gif: true,
      publicWebm: true,
    });
    expect(
      validateReadmeGifRecipe(
        {
          ...recipe,
          segments: [
            { startMs: 1_000, endMs: 2_000 },
            { startMs: 1_500, endMs: 2_500 },
          ],
        },
        onboarding.durationMs,
      ),
    ).toContain("readmeGif.segments must be sorted and non-overlapping");
    expect(
      validateGifProbe(
        {
          streams: [
            {
              codec_name: "gif",
              width: 960,
              height: 540,
              r_frame_rate: "12/1",
              nb_frames: "67",
            },
          ],
          format: { duration: "5.580000" },
        },
        recipe,
      ),
    ).toMatchObject({ codec: "gif", frameCount: 67 });
    expect(() =>
      validateGifProbe(
        {
          streams: [
            {
              codec_name: "gif",
              width: 960,
              height: 540,
              r_frame_rate: "0/0",
              nb_frames: "67",
            },
          ],
          format: { duration: "5.580000" },
        },
        recipe,
      ),
    ).toThrow("frame rate does not match");
  });

  it("supports a reviewed public WebM composition", () => {
    const onboarding = scenarioById("onboarding-walkthrough");
    const recipe = publicWebmRecipe(onboarding);
    expect(recipe).toEqual(onboarding.publicWebm);
    expect(publicWebmFilterGraph(recipe)).toContain("concat=n=2:v=1:a=0");
    expect(publicWebmFilterGraph(recipe)).toContain(`fps=fps=${recipe.fps}`);
    expect(publicWebmFilterGraph(recipe).indexOf("fps=fps=")).toBeLessThan(
      publicWebmFilterGraph(recipe).indexOf("trim=start="),
    );
    const renderArgs = publicWebmRenderArgs(
      "source.webm",
      "public.webm",
      recipe,
    );
    expect(
      renderArgs.filter((argument) => argument === "-fflags"),
    ).toHaveLength(2);
    expect(renderArgs.lastIndexOf("-fflags")).toBeGreaterThan(
      renderArgs.indexOf("source.webm"),
    );
    expect(renderArgs).toEqual(
      expect.arrayContaining(["-map_chapters", "-1"]),
    );
    expect(
      validatePublicWebmRecipe(recipe, onboarding.durationMs),
    ).toEqual([]);
    expect(
      validatePublicWebmRecipe(
        {
          ...recipe,
          segments: [{ startMs: 0, endMs: onboarding.durationMs + 1 }],
          threads: 4,
        },
        onboarding.durationMs,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("segments must stay within"),
        expect.stringContaining("threads must be 1"),
      ]),
    );
    expect(
      validatePublicWebmRecipe(
        {
          ...recipe,
          fps: 1,
          segments: [{ startMs: 0, endMs: 1_400 }],
        },
        onboarding.durationMs,
      ),
    ).toContain("publicWebm.segments[0] must align to the fps frame grid");
    expect(
      validatePublicWebmRecipe(
        {
          ...recipe,
          fps: 1,
          segments: [{ startMs: 0, endMs: 1_000 }],
        },
        onboarding.durationMs,
      ),
    ).toContain("publicWebm.segments must produce at least 2 frames");
    expect(
      validatePublicWebmProbe(
        {
          streams: [
            {
              codec_name: "vp9",
              width: 1_920,
              height: 1_080,
              pix_fmt: "yuv420p",
              r_frame_rate: "25/1",
              time_base: "1/1000",
              nb_read_frames: "265",
            },
          ],
          format: { start_time: "0.000000", duration: "10.600000" },
        },
        recipe,
      ),
    ).toMatchObject({ codec: "vp9", frameCount: 265, startTimeMs: 0 });
    expect(() =>
      validatePublicWebmProbe(
        {
          streams: [
            {
              codec_name: "vp9",
              width: 1_920,
              height: 1_080,
              pix_fmt: "yuv420p",
              r_frame_rate: "0/0",
              time_base: "1/1000",
              nb_read_frames: "264",
            },
          ],
          format: { start_time: "0.200000", duration: "10.600000" },
        },
        recipe,
      ),
    ).toThrow("frame rate does not match");
  });

  ffmpegIt("renders a public WebM byte-identically twice", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-public-webm-"));
    const inputPath = resolve(root, "source.webm");
    const firstPath = resolve(root, "first.webm");
    const secondPath = resolve(root, "second.webm");
    const publicWebm = {
      schemaVersion: 1,
      segments: [{ startMs: 0, endMs: 1_000 }],
      fps: 10,
      timeBase: "1/1000",
      width: 320,
      codec: "vp9",
      crf: 40,
      pixelFormat: "yuv420p",
      bitrateKbps: 0,
      deadline: "good",
      cpuUsed: 2,
      rowMt: 0,
      threads: 1,
    };
    try {
      execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=0x242424:s=320x180:r=5:d=1",
          "-an",
          "-c:v",
          "libvpx-vp9",
          "-deadline",
          "good",
          "-cpu-used",
          "2",
          "-row-mt",
          "0",
          "-threads",
          "1",
          "-fflags",
          "+bitexact",
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          inputPath,
        ],
        { stdio: "pipe" },
      );
      const scenario = {
        id: "determinism-contract",
        durationMs: 1_000,
        publicWebm,
      };
      const first = await renderPublicWebmDerivative({
        inputPath,
        outputPath: firstPath,
        scenario,
      });
      const second = await renderPublicWebmDerivative({
        inputPath,
        outputPath: secondPath,
        scenario,
      });
      const sha256 = async (path) =>
        createHash("sha256").update(await readFile(path)).digest("hex");
      expect(await sha256(firstPath)).toBe(await sha256(secondPath));
      expect(first.media).toEqual(second.media);
      expect(first.media).toMatchObject({
        codec: "vp9",
        frameCount: 10,
        pixelFormat: "yuv420p",
        timeBase: "1/1000",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps deterministic provider fixtures explicit", () => {
    expect(
      parseCaptureArgs([
        "--scenario",
        "workspace-overview",
        "--provider-source",
        "fixture",
      ]),
    ).toMatchObject({ providerSource: "fixture", requireLiveProviders: false });
    expect(() =>
      parseCaptureArgs([
        "--scenario",
        "workspace-overview",
        "--provider-source",
        "fixture",
        "--require-live-providers",
      ]),
    ).toThrow("cannot be used with fixture source");
  });

  it("rejects fixture capture when the browser scenario requires live continuity", () => {
    const reconnect = scenarioById("hmux-app-reconnect");
    expect(() =>
      assertBrowserCaptureProviderSource(
        { providerSource: "fixture" },
        reconnect,
      ),
    ).toThrow("requires --provider-source live");
    expect(() =>
      assertBrowserCaptureProviderSource({ providerSource: "live" }, reconnect),
    ).not.toThrow();
    expect(() =>
      assertBrowserCaptureProviderSource(
        { providerSource: "fixture" },
        scenarioById("workspace-overview"),
      ),
    ).not.toThrow();
  });

  it("measures reconnect geometry before a live output consumer exists", async () => {
    const waits = [];
    let reloaded = false;
    let restored = false;
    const page = {
      evaluate: async () => undefined,
      reload: async () => {
        reloaded = true;
      },
      waitForFunction: async (_predicate, value) => waits.push(value),
    };
    const action = scenarioById("hmux-app-reconnect").timeline.find(
      ({ action: actionName }) => actionName === "reloadAppClient",
    );
    await runClientLifecycleAction(page, action, {
      afterReload: async () => {
        restored = true;
      },
      measureOnly: true,
    });
    expect(waits).toEqual([]);
    expect(reloaded).toBe(false);
    expect(restored).toBe(false);
  });

  it("accepts the canonical Hmux consumer when the legacy output map is empty", async () => {
    const action = scenarioById("hmux-app-reconnect").timeline.find(
      ({ action: actionName }) => actionName === "reloadAppClient",
    );
    const terminalConsumerCount = vi.fn(() => 1);
    const host = {
      dataset: { dureMediaSessionId: action.sessionId },
      getBoundingClientRect: () => ({ width: 720, height: 840 }),
    };
    vi.stubGlobal("window", {
      __DURE_DOCK__: {
        getDockview: () => ({ getPanel: () => ({ id: action.panelId }) }),
      },
      __DURE_MEDIA_CAPTURE_MOCK__: {
        diagnostics: () => ({ outputConsumers: {} }),
        terminalConsumerCount,
      },
    });
    vi.stubGlobal("document", {
      querySelectorAll: (selector) =>
        selector === "[data-dure-media-session-id]" ? [host] : [],
    });
    let reloads = 0;
    let restores = 0;
    const page = {
      evaluate: async () => undefined,
      reload: async () => {
        reloads += 1;
      },
      waitForFunction: async (predicate, value) => {
        if (!predicate(value)) throw new Error("pane is not connected");
      },
    };
    try {
      await runClientLifecycleAction(page, action, {
        afterReload: async () => {
          restores += 1;
        },
      });
      expect(reloads).toBe(1);
      expect(restores).toBe(1);
      expect(terminalConsumerCount).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a canonical stale recovery source without an invented overlay", async () => {
    const action = scenarioById("session-recovery").timeline.find(
      ({ action: actionName }) => actionName === "reloadForSessionRecovery",
    );
    const viewport = {
      textContent: action.expectedBeforeMarker,
      getBoundingClientRect: () => ({ width: 720, height: 840 }),
    };
    vi.stubGlobal("window", {
      __DURE_DOCK__: {
        getDockview: () => ({ getPanel: () => ({ id: action.panelId }) }),
      },
      __DURE_MEDIA_CAPTURE_MOCK__: {
        diagnostics: () => ({ recoveryStage: "stale" }),
      },
    });
    vi.stubGlobal("document", {
      querySelectorAll: (selector) =>
        selector === TERMINAL_SURFACE_SELECTORS.paintedViewport
          ? [viewport]
          : [],
    });
    let reloads = 0;
    let restores = 0;
    let waits = 0;
    const page = {
      evaluate: async () => undefined,
      reload: async () => {
        reloads += 1;
      },
      waitForFunction: async (predicate, value) => {
        waits += 1;
        if (!predicate(value)) throw new Error("recovery source is not stale");
      },
    };
    try {
      await runSessionRecoveryAction(page, action, {
        afterReload: async () => {
          restores += 1;
        },
      });
      expect(reloads).toBe(1);
      expect(restores).toBe(1);
      expect(waits).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("projects one scenario interface preference into every capture runtime", () => {
    expect(
      captureInterfacePreferences(scenarioById("session-recovery")),
    ).toEqual({ interfaceMode: "pro" });
    expect(captureInterfacePreferences(scenarioById("workspace-overview"))).toEqual(
      {},
    );
  });

  it("finds hidden recovery candidates through the shipped Sessions search", async () => {
    const action = scenarioById("session-recovery").timeline.find(
      ({ action: actionName }) => actionName === "openSessionRecovery",
    );
    const fill = vi.fn();
    const waitForAction = vi.fn();
    const page = {
      getByPlaceholder: () => ({ fill, waitFor: vi.fn() }),
      getByRole: (_role, { name }) =>
        name === "Sessions"
          ? { click: vi.fn() }
          : { waitFor: waitForAction },
    };
    await runSessionRecoveryAction(page, action);
    expect(fill).toHaveBeenCalledWith("deploy-watch");
    expect(waitForAction).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade a required client-continuity proof to fixtures", async () => {
    await expect(
      createLiveProviderMedia({
        scenario: scenarioById("hmux-app-reconnect"),
        env: {
          PATH: "",
          DURE_MEDIA_HMUX_BIN: "definitely-missing-hmux",
        },
      }),
    ).rejects.toThrow("CLI executable was not found");
  });

  it("supports one-command catalog regeneration without ambiguous selection", () => {
    expect(parseCaptureArgs(["--all-scenarios", "--format", "png"])).toMatchObject({
      allScenarios: true,
      format: "png",
    });
    expect(() =>
      parseCaptureArgs([
        "--all-scenarios",
        "--scenario",
        "workspace-overview",
      ]),
    ).toThrow("cannot be used with --scenario");
    expect(captureHelp()).toContain("--all-scenarios");
    expect(
      selectCaptureScenarios({ allScenarios: true, format: "gif" }).map(
        ({ id }) => id,
      ),
    ).toEqual([
      "workspace-overview",
      "ssh-image-paste",
      "headless-spawn",
      "worktree-launch",
      "orchestration-channel",
      "diff-review-workflow",
      "spaces-pane-move",
      "onboarding-walkthrough",
      "session-recovery",
      "hmux-app-reconnect",
    ]);
  });

  it("rejects unknown output formats and documents the transient root", () => {
    expect(() =>
      parseCaptureArgs(["--scenario", "workspace-overview", "--format", "mp4"]),
    ).toThrow("--format must be one of");
    expect(() => parseCaptureArgs(["--scenario"])).toThrow(
      "--scenario requires a value",
    );
    expect(() =>
      parseCaptureArgs([
        "--scenario",
        "workspace-overview",
        "--output",
        "docs/public/images",
      ]),
    ).toThrow("--output must stay below output/playwright");
    expect(captureHelp()).toContain("output/playwright/media");
  });
});

describe("media capture output generations", () => {
  it("keeps the previous complete generation until the replacement commits", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-media-generation-"));
    const finalDirectory = resolve(root, "onboarding-walkthrough");
    try {
      await mkdir(finalDirectory);
      await writeFile(resolve(finalDirectory, "old.webm"), "old video");
      await writeFile(resolve(finalDirectory, "manifest.json"), "old manifest");

      const generation = await createCaptureGeneration(
        root,
        "onboarding-walkthrough",
      );
      await writeFile(
        resolve(generation.stagingDirectory, "onboarding-walkthrough.webm"),
        "new video",
      );
      await writeFile(
        resolve(generation.stagingDirectory, "manifest.json"),
        "new manifest",
      );
      expect(await readFile(resolve(finalDirectory, "manifest.json"), "utf8")).toBe(
        "old manifest",
      );

      await promoteCaptureGeneration(generation);
      expect(await readFile(resolve(finalDirectory, "manifest.json"), "utf8")).toBe(
        "new manifest",
      );
      await expect(readFile(resolve(finalDirectory, "old.webm"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const abandoned = await createCaptureGeneration(
        root,
        "onboarding-walkthrough",
      );
      await writeFile(resolve(abandoned.stagingDirectory, "partial.gif"), "partial");
      await discardCaptureGeneration(abandoned.stagingDirectory);
      expect(await readFile(resolve(finalDirectory, "manifest.json"), "utf8")).toBe(
        "new manifest",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers the previous generation after interruption between renames", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-media-promotion-"));
    const scenarioId = "onboarding-walkthrough";
    const finalDirectory = resolve(root, scenarioId);
      const backupDirectory = resolve(
        root,
        `.${scenarioId}.${process.pid}.00000000-0000-4000-8000-000000000000.previous`,
      );
    try {
      await mkdir(finalDirectory);
      await writeFile(resolve(finalDirectory, "manifest.json"), "old manifest");
      const generation = await createCaptureGeneration(root, scenarioId);
      await writeFile(
        resolve(generation.stagingDirectory, "manifest.json"),
        "new manifest",
      );
      await writeFile(
        capturePromotionJournalPath(root, scenarioId),
        `${JSON.stringify({
          schemaVersion: 1,
          scenarioId,
          finalName: scenarioId,
          stagingName: basename(generation.stagingDirectory),
          backupName: basename(backupDirectory),
        })}\n`,
      );
      await rename(finalDirectory, backupDirectory);

      await expect(recoverCapturePromotion(root, scenarioId)).resolves.toEqual({
        recovered: true,
        outcome: "previous-restored",
      });
      expect(await readFile(resolve(finalDirectory, "manifest.json"), "utf8")).toBe(
        "old manifest",
      );
      await expect(readFile(resolve(generation.stagingDirectory, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(capturePromotionJournalPath(root, scenarioId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never lets a promotion journal target a sibling generation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-media-journal-scope-"));
    const scenarioId = "mintlify";
    try {
      await Promise.all([
        mkdir(resolve(root, scenarioId)),
        mkdir(resolve(root, "launch")),
      ]);
      await writeFile(resolve(root, "launch", "keep.txt"), "keep");
      await writeFile(
        capturePromotionJournalPath(root, scenarioId),
        `${JSON.stringify({
          schemaVersion: 1,
          scenarioId,
          finalName: scenarioId,
          stagingName: "launch",
          backupName:
            ".mintlify.123.00000000-0000-4000-8000-000000000000.previous",
        })}\n`,
      );
      await expect(recoverCapturePromotion(root, scenarioId)).rejects.toThrow(
        "not owned by mintlify",
      );
      expect(await readFile(resolve(root, "launch", "keep.txt"), "utf8")).toBe(
        "keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("media capture application provenance", () => {
  it("fingerprints tracked and non-ignored untracked working-tree bytes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-media-build-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Media Fixture"], {
        cwd: root,
      });
      execFileSync("git", ["config", "user.email", "media@example.invalid"], {
        cwd: root,
      });
      await writeFile(resolve(root, ".gitignore"), "ignored.txt\n");
      await writeFile(resolve(root, "tracked.txt"), "first\n");
      execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });
      execFileSync(
        "git",
        fixtureGitArguments("commit", "--quiet", "-m", "fixture"),
        { cwd: root },
      );

      const clean = await applicationWorkingTreeFingerprint(root);
      expect(await applicationWorkingTreeState(root)).toMatchObject({
        dirty: false,
        fingerprint: clean,
      });
      await writeFile(resolve(root, "tracked.txt"), "second\n");
      const tracked = await applicationWorkingTreeFingerprint(root);
      expect(await applicationWorkingTreeState(root)).toMatchObject({
        dirty: true,
        fingerprint: tracked,
      });
      await writeFile(resolve(root, "untracked.txt"), "public bytes\n");
      const untracked = await applicationWorkingTreeFingerprint(root);
      await writeFile(resolve(root, "ignored.txt"), "transient bytes\n");
      const ignored = await applicationWorkingTreeFingerprint(root);

      expect(clean).toMatch(/^git-working-tree-v1:[0-9a-f]{64}$/u);
      expect(tracked).not.toBe(clean);
      expect(untracked).not.toBe(tracked);
      expect(ignored).toBe(untracked);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("normalizes clean and dirty current-checkout build identities", () => {
    expect(
      normalizeApplicationBuildInfo({
        schemaVersion: 1,
        buildId: "1.4.0+abcdef123456",
        sourceRevision: "abcdef123456",
        worktreeOverlay: "clean",
        backendRuntimeFingerprint:
          "git-object-v1:0123456789012345678901234567890123456789",
      }),
    ).toMatchObject({
      packageVersion: "1.4.0",
      sourceRevision: "abcdef123456",
      dirty: false,
    });
    expect(
      normalizeApplicationBuildInfo({
        schemaVersion: 1,
        buildId: "1.4.0+abcdef123456-dirty",
        sourceRevision: "abcdef123456",
        worktreeOverlay: "present",
        backendRuntimeFingerprint: null,
      }),
    ).toMatchObject({ sourceRevision: "abcdef123456", dirty: true });
    expect(() =>
      normalizeApplicationBuildInfo({
        schemaVersion: 1,
        buildId: "latest",
        sourceRevision: "abcdef123456",
        worktreeOverlay: "clean",
        backendRuntimeFingerprint: null,
      }),
    ).toThrow("runtime observation is invalid");
  });

  it("takes source identity from the runtime observation, not its display label", () => {
    expect(
      normalizeApplicationBuildInfo({
        schemaVersion: 1,
        buildId: "1.4.0+display-only-dirty",
        sourceRevision: "abcdef123456",
        worktreeOverlay: "present",
        backendRuntimeFingerprint: null,
      }),
    ).toMatchObject({
      sourceRevision: "abcdef123456",
      dirty: true,
    });
  });

  it("reads the build identity from the capture server contract", async () => {
    const requests = [];
    await expect(
      readApplicationBuild(
        "http://127.0.0.1:1420",
        async (url) => {
          requests.push(url);
          return {
            ok: true,
            json: async () => ({
              schemaVersion: 1,
              buildId: "1.4.0+abcdef123456",
              sourceRevision: "abcdef123456",
              worktreeOverlay: "clean",
              backendRuntimeFingerprint: null,
            }),
          };
        },
        async () => "git-working-tree-v1:fixture",
      ),
    ).resolves.toMatchObject({
      sourceRevision: "abcdef123456",
      dirty: false,
      workingTreeFingerprint: "git-working-tree-v1:fixture",
    });
    expect(requests).toEqual(["http://127.0.0.1:1420/__app_build_info"]);
  });

  it("fails when the checked-out application changes during capture", () => {
    const clean = normalizeApplicationBuildInfo({
      schemaVersion: 1,
      buildId: "1.4.0+abcdef123456",
      sourceRevision: "abcdef123456",
      worktreeOverlay: "clean",
      backendRuntimeFingerprint: null,
    });
    expect(() => assertApplicationBuildUnchanged(clean, clean)).not.toThrow();
    expect(() =>
      assertApplicationBuildUnchanged(clean, {
        ...clean,
        buildId: "1.4.0+fedcba654321",
        sourceRevision: "fedcba654321",
      }),
    ).toThrow("buildId, sourceRevision");
    expect(() =>
      assertApplicationBuildUnchanged(
        { ...clean, workingTreeFingerprint: "git-working-tree-v1:a" },
        { ...clean, workingTreeFingerprint: "git-working-tree-v1:b" },
      ),
    ).toThrow("workingTreeFingerprint");
  });
});

describe("live provider capture contracts", () => {
  it("separates Codex credential authority from ambient hooks and runtime state", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "codex-automation-home-"));
    const sourceHome = resolve(root, "account");
    const fixture = {
      root: resolve(root, "fixture"),
      repo: resolve(root, "fixture", "repo"),
      discoveryRoot: resolve(root, "fixture", "hmux-discovery"),
    };
    await Promise.all([
      mkdir(sourceHome, { recursive: true, mode: 0o700 }),
      mkdir(fixture.repo, { recursive: true, mode: 0o700 }),
      mkdir(fixture.discoveryRoot, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(resolve(sourceHome, "auth.json"), "fixture-auth", {
        mode: 0o600,
      }),
      writeFile(
        resolve(sourceHome, "hooks.json"),
        JSON.stringify({ hooks: { SessionStart: [{ command: "exit 1" }] } }),
        { mode: 0o600 },
      ),
    ]);
    const intent = {
      provider: "codex",
      sessionName: "dure-media-codex",
      state: "resolved",
    };
    try {
      await retireProviderAutomationCredentials(fixture, [intent]);
      const state = await prepareProviderAutomationState({
        env: { CODEX_HOME: sourceHome },
        fixture,
        provider: "codex",
        sessionName: "dure-media-codex",
        workingDirectory: fixture.repo,
      });
      expect(state.removals).toEqual([
        "DURE_MEDIA_CODEX_HOME",
        "OPENAI_API_KEY",
      ]);
      expect(state.environment.CODEX_HOME).not.toBe(sourceHome);
      expect(state.environment.CODEX_SQLITE_HOME).not.toBe(sourceHome);
      expect(
        providerAutomationCommand(
          "/opt/codex",
          ["--sandbox", "read-only"],
          state,
        ),
      ).toEqual([
        "/usr/bin/env",
        "-u",
        "DURE_MEDIA_CODEX_HOME",
        "-u",
        "OPENAI_API_KEY",
        `CODEX_HOME=${state.environment.CODEX_HOME}`,
        `CODEX_SQLITE_HOME=${state.environment.CODEX_SQLITE_HOME}`,
        "/opt/codex",
        "--sandbox",
        "read-only",
      ]);
      expect(fixture).not.toHaveProperty("providerAutomationRoots");
      expect(
        (await lstat(resolve(state.environment.CODEX_HOME, "auth.json")))
          .isSymbolicLink(),
      ).toBe(true);
      expect(
        await readlink(resolve(state.environment.CODEX_HOME, "auth.json")),
      ).toBe(resolve(await realpath(sourceHome), "auth.json"));
      const config = await readFile(
        resolve(state.environment.CODEX_HOME, "config.toml"),
        "utf8",
      );
      expect(config).toContain('history.persistence = "none"');
      expect(config).toContain(JSON.stringify(fixture.repo));
      expect(config).not.toContain("hooks");
      expect(
        (await lstat(state.environment.CODEX_HOME)).mode & 0o777,
      ).toBe(0o700);

      await unlink(resolve(state.environment.CODEX_HOME, "auth.json"));
      await writeFile(
        resolve(state.environment.CODEX_HOME, "auth.json"),
        "refreshed-fixture-auth",
        { mode: 0o600 },
      );
      await retireProviderAutomationCredentials(fixture, [intent]);
      await expect(
        lstat(resolve(state.environment.CODEX_HOME, "auth.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await lstat(state.environment.CODEX_HOME)).mode & 0o777,
      ).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the exact hmux capabilities used by capture and cleanup", () => {
    const compatible = {
      schemaVersion: 2,
      capabilities: [
        "managed_screen_read_v1",
        "generation_fenced_kill_v1",
        "process_generation_probe_v1",
      ],
    };
    expect(assertCompatibleHmuxCapabilities(compatible)).toBe(compatible);
    expect(() =>
      assertCompatibleHmuxCapabilities({
        ...compatible,
        capabilities: compatible.capabilities.slice(1),
      }),
    ).toThrow("managed_screen_read_v1");
  });

  it("uses measured session geometry before provider defaults", () => {
    expect(terminalCaptureSize(MEDIA_CAPTURE_SCENARIOS[0])).toEqual({
      columns: 77,
      rows: 29,
    });
    expect(terminalCaptureSize(MEDIA_CAPTURE_SCENARIOS[0], "claude")).toEqual({
      columns: 77,
      rows: 29,
    });
    expect(
      terminalCaptureSize(
        MEDIA_CAPTURE_SCENARIOS[0],
        "codex",
        "session-codex",
      ),
    ).toEqual({ columns: 81, rows: 30 });
    expect(
      terminalCaptureSize(
        MEDIA_CAPTURE_SCENARIOS[0],
        "codex",
        "session-codex",
        { "session-codex": { columns: 71, rows: 22 } },
      ),
    ).toEqual({ columns: 71, rows: 22 });
    expect(() =>
      terminalCaptureSize({ liveTerminalSize: { columns: 20, rows: 5 } }),
    ).toThrow("at least 40 columns by 12 rows");
  });

  it("waits for every measured xterm to finish hydration and fit settling", () => {
    const sessions = ["session-codex", "session-claude"];
    expect(
      unsettledTerminalSessionIds(sessions, [
        {
          sessionId: "session-codex",
          hydrating: false,
          fitSettling: true,
        },
      ]),
    ).toEqual(["session-codex", "session-claude"]);
    expect(
      unsettledTerminalSessionIds(sessions, [
        {
          sessionId: "session-codex",
          hydrating: false,
          fitSettling: false,
        },
        {
          sessionId: "session-claude",
          hydrating: false,
          fitSettling: false,
        },
      ]),
    ).toEqual([]);
  });

  it("requires live terminal geometry to closely fill its viewport", () => {
    expect(
      terminalGeometryFitsViewport(
        { columns: 109, rows: 16 },
        { columns: 109, rows: 16 },
        { closeFit: true },
      ),
    ).toBe(true);
    expect(
      terminalGeometryFitsViewport(
        { columns: 107, rows: 15 },
        { columns: 109, rows: 16 },
        { closeFit: true },
      ),
    ).toBe(true);
    expect(
      terminalGeometryFitsViewport(
        { columns: 80, rows: 15 },
        { columns: 109, rows: 16 },
        { closeFit: true },
      ),
    ).toBe(false);
    expect(
      terminalGeometryFitsViewport(
        { columns: 110, rows: 16 },
        { columns: 109, rows: 16 },
      ),
    ).toBe(false);
  });

  it("uses the shared boot-bound Linux identity and rejects a legacy ledger owner", async () => {
    const processId = 2_147_483_647;
    const currentIdentity = "linux:test-boot:4242";
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    const linuxProcessMemberSnapshots = vi.fn(() => ({
      status: "complete",
      scope: { kind: "point", requestedPids: [processId] },
      members: [{
        pid: processId,
        groupId: processId,
        state: "live",
        processIdentity: currentIdentity,
      }],
    }));

    vi.resetModules();
    vi.doMock("./lib/process-identity.mjs", async (importOriginal) => ({
      ...await importOriginal(),
      processMemberSnapshots: linuxProcessMemberSnapshots,
    }));
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "linux",
    });
    try {
      const generation = await import(
        "../tools/media-capture/providers/process-generation.mjs?linux-authority-contract"
      );
      expect(generation.observeProcessGeneration(processId)).toBe(
        currentIdentity,
      );
      expect(linuxProcessMemberSnapshots).toHaveBeenCalledWith(
        [processId],
        "linux",
      );
      expect(
        generation.exactProcessGenerationStatus({
          processId,
          startMarker: "linux:prior-boot:4242",
        }),
      ).toBe("replaced");
      linuxProcessMemberSnapshots.mockReturnValue({
        status: "complete",
        scope: { kind: "point", requestedPids: [processId] },
        members: [],
      });
      expect(
        generation.exactProcessGenerationStatus({
          processId,
          startMarker: currentIdentity,
        }),
      ).toBe("absent");
      const observationCount = linuxProcessMemberSnapshots.mock.calls.length;
      expect(() =>
        generation.exactProcessGenerationStatus({
          processId,
          startMarker: "kernel-start-v1:linux:4242",
        })
      ).toThrow("media cleanup ledger has an invalid Linux owner generation");
      expect(linuxProcessMemberSnapshots).toHaveBeenCalledTimes(
        observationCount,
      );
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      vi.doUnmock("./lib/process-identity.mjs");
      vi.resetModules();
    }
  });

  it("persists exact interrupted-run cleanup inputs outside the owned fixture", async () => {
    await mkdir(providerFixtureRoot, { recursive: true });
    const root = await mkdtemp(resolve(providerFixtureRoot, "ledger-contract-"));
    const fixture = {
      root,
      repo: resolve(root, "repo"),
      discoveryRoot: resolve(root, "hmux-discovery"),
    };
    await Promise.all([
      mkdir(fixture.repo, { recursive: true }),
      mkdir(fixture.discoveryRoot, { recursive: true }),
    ]);
    let ledgerPath;
    try {
      ledgerPath = await writeCleanupLedger(
        fixture,
        [
          {
            provider: "codex",
            sessionId: "session-exact",
            record: { terminal_epoch: "4" },
          },
        ],
        [
          {
            intentId: "primary",
            provider: "codex",
            sessionName: "dure-media-codex",
            state: "pending",
          },
          {
            intentId: "overlay",
            provider: "codex",
            sessionName: "dure-media-codex-session-codex",
            state: "pending",
          },
        ],
      );
      const ledger = await readCleanupLedger(ledgerPath);
      const currentOwner = processMemberSnapshots([process.pid]);
      expect(currentOwner.status).toBe("complete");
      expect(ledger.owner.startMarker).toBe(
        currentOwner.members[0]?.processIdentity,
      );
      expect(ledger).toMatchObject({
        schemaVersion: 1,
        owner: {
          processId: process.pid,
          startMarker: expect.any(String),
        },
        fixture,
        sessions: [
          {
            provider: "codex",
            sessionId: "session-exact",
            record: { terminal_epoch: "4" },
          },
        ],
        spawnIntents: [
          {
            intentId: "primary",
            provider: "codex",
            sessionName: "dure-media-codex",
            sessionId: null,
            state: "pending",
          },
          {
            intentId: "overlay",
            provider: "codex",
            sessionName: "dure-media-codex-session-codex",
            sessionId: null,
            state: "pending",
          },
        ],
      });
      expect(exactProcessGenerationStatus(ledger.owner)).toBe("live");
    } finally {
      if (ledgerPath) await removeCleanupLedger(ledgerPath);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "keeps a live legacy-owner ledger out of recovery",
    async () => {
      await mkdir(providerFixtureRoot, { recursive: true });
      const root = await mkdtemp(resolve(providerFixtureRoot, "ledger-legacy-"));
      const fixture = {
        root,
        repo: resolve(root, "repo"),
        discoveryRoot: resolve(root, "hmux-discovery"),
      };
      await Promise.all([
        mkdir(fixture.repo, { recursive: true }),
        mkdir(fixture.discoveryRoot, { recursive: true }),
      ]);
      let ledgerPath;
      try {
        ledgerPath = await writeCleanupLedger(fixture, [], []);
        const payload = JSON.parse(await readFile(ledgerPath, "utf8"));
        const uniqueId = payload.owner.startMarker.match(/(\d+)$/u)?.[1];
        expect(uniqueId).toBeTruthy();
        payload.owner.startMarker = `kernel-start-v2:macos:${uniqueId}`;
        await writeFile(ledgerPath, `${JSON.stringify(payload, null, 2)}\n`);

        const scan = await recoverableCleanupLedgers();
        expect(scan.ledgers.some(({ path }) => path === ledgerPath)).toBe(false);
        expect(scan.errors).toContainEqual(
          expect.objectContaining({
            message: "media cleanup ledger has an invalid macOS owner generation",
          }),
        );
      } finally {
        if (ledgerPath) await removeCleanupLedger(ledgerPath);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("fails closed for symlinked fixture roots", async () => {
    await mkdir(providerFixtureRoot, { recursive: true });
    const root = await mkdtemp(resolve(providerFixtureRoot, "ledger-symlink-"));
    const repo = resolve(root, "repo");
    const realDiscovery = resolve(root, "real-discovery");
    const discoveryRoot = resolve(root, "hmux-discovery");
    await Promise.all([
      mkdir(repo, { recursive: true }),
      mkdir(realDiscovery, { recursive: true }),
    ]);
    await symlink(realDiscovery, discoveryRoot);
    try {
      await expect(
        writeCleanupLedger({ root, repo, discoveryRoot }, []),
      ).rejects.toThrow(/real directory|symlink/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("claims one dead-owner ledger atomically while reporting invalid neighbors", async () => {
    await mkdir(providerFixtureRoot, { recursive: true });
    const root = await mkdtemp(resolve(providerFixtureRoot, "ledger-claim-"));
    const fixture = {
      root,
      repo: resolve(root, "repo"),
      discoveryRoot: resolve(root, "hmux-discovery"),
    };
    await Promise.all([
      mkdir(fixture.repo, { recursive: true }),
      mkdir(fixture.discoveryRoot, { recursive: true }),
    ]);
    const ledgerDirectory = resolve(providerFixtureRoot, ".cleanup-ledgers");
    const invalidPath = resolve(
      ledgerDirectory,
      `invalid-${process.pid}-${Date.now()}.json`,
    );
    let ledgerPath;
    let claimedPath;
    try {
      ledgerPath = await writeCleanupLedger(fixture, [], []);
      const payload = JSON.parse(await readFile(ledgerPath, "utf8"));
      const currentMarker = observeProcessGeneration(process.pid);
      expect(currentMarker).toBeTruthy();
      payload.owner = {
        processId: 2_147_483_647,
        startMarker: currentMarker,
      };
      await writeFile(ledgerPath, `${JSON.stringify(payload, null, 2)}\n`);
      await writeFile(invalidPath, "{invalid json\n");
      expect(
        exactProcessGenerationStatus({
          processId: process.pid,
          startMarker: currentMarker,
        }),
      ).toBe("live");
      const scan = await recoverableCleanupLedgers();
      expect(scan.errors).toHaveLength(1);
      const ledger = scan.ledgers.find(({ path }) => path === ledgerPath);
      expect(ledger).toBeTruthy();
      const claims = await Promise.all([
        claimCleanupLedger(ledger),
        claimCleanupLedger(ledger),
      ]);
      const successful = claims.filter(Boolean);
      expect(successful).toHaveLength(1);
      claimedPath = successful[0].path;
      expect((await readCleanupLedger(claimedPath)).owner).toMatchObject({
        processId: process.pid,
        startMarker: expect.any(String),
      });
    } finally {
      if (ledgerPath) await removeCleanupLedger(ledgerPath);
      if (claimedPath) await removeCleanupLedger(claimedPath);
      await rm(invalidPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "all live",
      media: {
        providers: ["codex", "claude"],
        fallbackProviders: [],
        fallbackReasons: {},
      },
      effectiveProviderSource: "live",
      providerSources: { codex: "live", claude: "live" },
    },
    {
      name: "partial fallback",
      media: {
        providers: ["codex"],
        fallbackProviders: ["claude", "opencode"],
        fallbackReasons: {
          claude: "authentication-required",
          opencode: "unsupported-live-provider",
        },
      },
      effectiveProviderSource: "mixed",
      providerSources: {
        codex: "live",
        claude: "fixture",
        opencode: "fixture",
      },
    },
    {
      name: "all fallback or explicit fixture",
      media: {
        providers: [],
        fallbackProviders: ["codex", "opencode"],
        fallbackReasons: {
          codex: "explicit-fixture-source",
          opencode: "explicit-fixture-source",
        },
      },
      effectiveProviderSource: "fixture",
      providerSources: { codex: "fixture", opencode: "fixture" },
    },
  ])(
    "records $name provider provenance",
    ({ media, effectiveProviderSource, providerSources }) => {
      expect(providerProvenance(media)).toMatchObject({
        effectiveProviderSource,
        providerSources,
        liveProviders: media.providers,
        fallbackProviders: media.fallbackProviders,
        fallbackReasons: media.fallbackReasons,
      });
    },
  );

  it("advances only known safe provider startup prompts", () => {
    expect(
      providerStartupKeys(
        "codex",
        "Do you trust the contents of this directory?",
      ),
    ).toEqual(["Enter"]);
    expect(
      providerStartupKeys(
        "codex",
        "Do you trust the contents of this directory?\n› Write tests for @filename\ngpt-5.3-codex-spark xhigh · ~/repo",
      ),
    ).toBeNull();
    expect(
      providerStartupKeys(
        "claude",
        "Allow external CLAUDE.md file imports?",
      ),
    ).toEqual(["Down", "Enter"]);
    expect(
      providerStartupKeys(
        "claude",
        "Allow external CLAUDE.md file imports?\n❯ \nplan mode on",
      ),
    ).toBeNull();
    expect(
      providerStartupKeys(
        "claude",
        "Allow external CLAUDE.md file imports?\nplan mode on\nEnter to confirm · Esc to cancel",
      ),
    ).toBeNull();
    expect(
      providerStartupKeys(
        "claude",
        "Do you trust this project?\n❯ \nplan mode on\nEnter to confirm",
      ),
    ).toBeNull();
    expect(
      providerStartupKeys(
        "claude",
        "Quick safety check\n❯ No, exit\n  Yes, I trust this\n  folder\nEnter to confirm · Esc to cancel",
      ),
    ).toEqual(["Down", "Enter"]);
    expect(
      providerStartupKeys(
        "claude",
        "Quick safety check\n  No, exit\n❯ Yes, I trust this folder\nEnter to confirm · Esc to cancel",
      ),
    ).toEqual(["Enter"]);
    expect(
      providerStartupKeys(
        "claude",
        visibleProviderText(
          "Allow external CLAUDE.md file imports?\n\u001b[2mEnter\u001b[0m to confirm · \u001b[2mEsc\u001b[0m to cancel",
        ),
      ),
    ).toEqual(["Down", "Enter"]);
    expect(providerStartupKeys("claude", "bypass permissions on")).toBeNull();
    expect(providerStartupKeys("kimi", "Authorize this device")).toBeNull();
    expect(providerScreenReady("codex", "OpenAI Codex\nmodel: gpt-5.6-sol")).toBe(
      true,
    );
    expect(
      providerScreenReady(
        "claude",
        "Allow external CLAUDE.md file imports?\n❯ 1. Yes",
      ),
    ).toBe(false);
    expect(providerScreenReady("claude", "Claude Code\n❯ ")).toBe(true);
  });

  it("requires a substantive provider response after the busy surface", () => {
    const prompt =
      "Inspect this demo repository read-only. Trace the session handoff code, run the focused tests, and report one concrete race-condition safeguard. Do not edit files.";
    const codexBaseline = "OpenAI Codex\nmodel: gpt-test\ndirectory: ~/dure-demo\n› Explain this codebase";
    const codexBusy = [
      codexBaseline,
      prompt,
      "• Working (2s · esc to interrupt)",
      "› Explain this codebase",
    ].join("\n");
    expect(providerResponseBusy("codex", codexBusy)).toBe(true);
    expect(
      providerResponseComplete("codex", codexBusy, {
        baseline: codexBaseline,
        prompt,
      }),
    ).toBe(false);
    const codexComplete = [
      codexBaseline,
      prompt,
      "• Read 3 files and ran the focused recovery tests.",
      "The generation fence prevents a stale sibling from retargeting the committed pane.",
      "› Explain this codebase",
    ].join("\n");
    expect(
      providerResponseComplete("codex", codexComplete, {
        baseline: codexBaseline,
        prompt,
      }),
    ).toBe(true);
    const codexSubstantiveWhileBusy = [
      codexBusy,
      "• Explored the session router and read the complete handoff test matrix.",
      "The exact-generation check rejects stale clients before replacement and preserves the active pane generation.",
    ].join("\n");
    expect(
      providerResponseComplete("codex", codexSubstantiveWhileBusy, {
        baseline: codexBaseline,
        prompt,
      }),
    ).toBe(true);

    const claudeBaseline = "Claude Code\n❯ \nplan mode on";
    const claudeBusy = `${claudeBaseline}\n${prompt}\n✻ Topsy-turvying… (thinking)`;
    expect(providerResponseBusy("claude", claudeBusy)).toBe(true);
    expect(
      providerResponseBusy(
        "claude",
        `${claudeBaseline}\n✶ Prestidigitating… (10s · thought for 7s)`,
      ),
    ).toBe(true);
    expect(
      providerResponseComplete("claude", claudeBusy, {
        baseline: claudeBaseline,
        prompt,
      }),
    ).toBe(false);
    const claudeShortWhileBusy = [
      claudeBaseline,
      "Safe mode loaded the complete test and session policy surface after startup.",
      prompt,
      "⏺ I'll inspect the handoff implementation and its tests first.",
      "✻ Extraordinarily-long-photosynthesizing… (25s · thought for 23s · 826 tokens)",
    ].join("\n");
    expect(
      providerResponseComplete("claude", claudeShortWhileBusy, {
        baseline: claudeBaseline,
        prompt,
      }),
    ).toBe(false);
    const claudeAnsiShortWhileBusy = claudeShortWhileBusy.replace(
      "Inspect this demo repository read-only.",
      "\u001b[7mInspect this demo repository read-only.\u001b[0m",
    );
    expect(
      providerResponseComplete("claude", claudeAnsiShortWhileBusy, {
        baseline: claudeBaseline,
        prompt,
      }),
    ).toBe(false);
    const claudeComplete = [
      claudeBaseline,
      prompt,
      "⏺ Read 2 files and ran 1 shell command.",
      "The handoff journal persists replacement inputs before the destructive boundary.",
      "❯ ",
      "plan mode on",
    ].join("\n");
    expect(
      providerResponseComplete("claude", claudeComplete, {
        baseline: claudeBaseline,
        prompt,
      }),
    ).toBe(true);
  });

  it("copies the complete snake-case hmux generation fence", () => {
    const record = {
      workspace_id: "workspace",
      session_id: "session",
      runner_principal: "principal",
      runner_instance: "runner",
      channel_epoch: "3",
      host_instance_id: "host",
      terminal_epoch: "7",
    };
    expect(fenceFromSessionRecord(record)).toEqual(record);
    expect(() =>
      fenceFromSessionRecord({ ...record, terminal_epoch: undefined }),
    ).toThrow("terminal_epoch");
  });

  it("accepts only the same live Hmux generation with monotonic output", () => {
    const observation = (overrides = {}) => ({
      provider: "codex",
      sessionId: "live-session",
      workingDirectory: "/fixture/worktrees/live-session",
      fence: {
        workspace_id: "workspace",
        session_id: "live-session",
        runner_principal: "principal",
        runner_instance: "runner",
        channel_epoch: "3",
        host_instance_id: "host",
        terminal_epoch: "7",
      },
      hostProcess: { process_id: 101, start_marker: "host-start" },
      providerProcess: { process_id: 102, start_marker: "provider-start" },
      hostLive: true,
      providerLive: true,
      sequenceThrough: "842",
      ...overrides,
    });
    expect(
      assertLiveSessionContinuity(
        [observation()],
        [observation({ sequenceThrough: "849" })],
      ),
    ).toEqual({
      liveSessionCount: 1,
      providers: ["codex"],
      exactSessionFencesPreserved: true,
      processGenerationsLive: true,
      sequencesNondecreasing: true,
      distinctWorkingDirectories: true,
    });
    expect(() =>
      assertLiveSessionContinuity(
        [observation()],
        [
          observation({
            fence: { ...observation().fence, terminal_epoch: "8" },
          }),
        ],
      ),
    ).toThrow("generation fence changed");
    expect(() =>
      assertLiveSessionContinuity(
        [observation()],
        [
          observation({
            workingDirectory: "/fixture/worktrees/different-session",
          }),
        ],
      ),
    ).toThrow("working directory changed");
    const secondSession = observation({
      provider: "claude",
      sessionId: "live-session-2",
      fence: { ...observation().fence, session_id: "live-session-2" },
      hostProcess: { process_id: 201, start_marker: "host-start-2" },
      providerProcess: {
        process_id: 202,
        start_marker: "provider-start-2",
      },
    });
    expect(() =>
      assertLiveSessionContinuity(
        [observation(), secondSession],
        [observation(), secondSession],
      ),
    ).toThrow("share one working directory");
    expect(() =>
      assertLiveSessionContinuity(
        [observation()],
        [observation({ providerLive: false })],
      ),
    ).toThrow("process exited");
    expect(() =>
      assertLiveSessionContinuity(
        [observation()],
        [observation({ sequenceThrough: "841" })],
      ),
    ).toThrow("sequence moved backwards");
  });

  it("keeps live replay away from the client reload navigation window", () => {
    const reconnect = scenarioById("hmux-app-reconnect");
    const visibility = replayVisibility(
      reconnect,
      reconnect.fixture.agents[0].sessionId,
    );
    expect(visibility).toEqual({
      desktopId: "desk-live",
      visibleWindows: [
        { startMs: 1_000, endMs: 2_450 },
        { startMs: 5_800, endMs: 9_800 },
      ],
    });
  });

  it("fails closed for credentials while aliasing private terminal paths", () => {
    expect(
      normalizeProviderScreen(
        "\u001b[32m/Users/demo/projects/private/repo\u001b[0m",
        {
        home: "/Users/demo",
          ownedPaths: [
            {
              path: "/Users/demo/projects/private/repo",
              alias: "~/dure-demo",
            },
          ],
        },
      ),
    ).toBe("\u001b[32m~/dure-demo\u001b[0m");
    const abbreviated = normalizeProviderScreen(
      "directory: ~/.../workspace-overview-Z4zArF/repo\n~/AAA/projects/hebbia…",
      { home: "/Users/demo" },
    );
    expect(abbreviated).toBe(
      "directory: ~/dure-demo\n~/dure-demo",
    );
    expect(abbreviated).not.toMatch(/workspace-overview-|AAA\/projects/u);
    const wrappedOwnedPath = normalizeProviderScreen(
      [
        "~/AAA/projects/hebbian/",
        "HebbianIDE/.worktrees/hmux-codex-fork/output/",
      ].join("\n"),
      {
        home: "/Users/demo",
        ownedPaths: [
          {
            path: "/Users/demo/AAA/projects/hebbian/HebbianIDE/.worktrees/hmux-codex-fork",
            alias: "~/dure-demo",
          },
        ],
      },
    );
    expect(wrappedOwnedPath).toBe("~/dure-demo\n~/dure-demo/output/");
    expect(wrappedOwnedPath).not.toMatch(/HebbianIDE|hmux-codex-fork/u);
    const publicClaudeLabel = normalizeProviderScreen(
      "\u001b[38;5;208mClaude Max\u001b[0m",
    );
    expect(publicClaudeLabel).toBe(
      "\u001b[38;5;208mClaude Code\u001b[0m",
    );
    expect(
      normalizeProviderScreen("Welcome back · private@example.com's organization"),
    ).toBe("Welcome back · Dure demo account's organization");
    expect(normalizeProviderScreen("private@example.\ncom")).toBe(
      "Dure demo account",
    );
    expect(
      normalizeProviderScreen("private@\u001b[1mexample.com\u001b[0m"),
    ).toBe("Dure demo account\u001b[0m");
    expect(normalizeProviderScreen("Welcome back Hebbian!")).toBe(
      "Welcome to Dure demo!",
    );
    expect(normalizeProviderScreen("Welcome back\nPrivate Name!")).toBe(
      "Welcome to Dure demo!",
    );
    expect(
      normalizeProviderScreen(
        "Welcome back \u001b[1mHebbian\u001b[0m!",
      ),
    ).toBe(
      "Welcome to Dure demo!",
    );
    const withoutTransientMcpDiagnostic = normalizeProviderScreen(
      [
        "\u001b[33m⚠ MCP startup interrupted. The following servers were not",
        " initialized: memory, playwright, sequential-thinking\u001b[0m",
        "",
        "› Inspect this demo repository read-only.",
      ].join("\r\n"),
    );
    expect(visibleProviderText(withoutTransientMcpDiagnostic)).not.toContain(
      "MCP startup interrupted",
    );
    expect(visibleProviderText(withoutTransientMcpDiagnostic)).toContain(
      "› Inspect this demo repository read-only.",
    );
    const withoutClaudeSafeModeNotice = normalizeProviderScreen(
      [
        "\u001b[33m⚠ Safe mode: all customizations are disabled",
        "  (CLAUDE.md, skills, plugins, hooks, MCP,",
        "   agents, and more)",
        "  Restart without --safe-mode to re-enable\u001b[0m",
        "",
        "❯ Inspect this demo repository read-only.",
      ].join("\r\n"),
    );
    expect(visibleProviderText(withoutClaudeSafeModeNotice)).not.toContain(
      "Safe mode:",
    );
    expect(visibleProviderText(withoutClaudeSafeModeNotice)).toContain(
      "❯ Inspect this demo repository read-only.",
    );
    const withoutClaudeRuntimeNotices = normalizeProviderScreen(
      [
        "auto mode unavailable for this model",
        "Update available! Run: brew upgrade claude-code@latest",
        "❯ Inspect this demo repository read-only.",
      ].join("\r\n"),
    );
    expect(withoutClaudeRuntimeNotices).toBe(
      "❯ Inspect this demo repository read-only.",
    );
    expect(() => assertProviderScreenSafe("claude", "Claude Max"))
      .toThrow(UnsafeProviderOutputError);
    expect(providerPrivacyViolations("Claude Enterprise")).toContain(
      "provider account tier",
    );
    expect(providerPrivacyViolations("private@example.com")).toContain(
      "email address",
    );
    expect(providerPrivacyViolations("private@example.\ncom")).toContain(
      "email address",
    );
    expect(providerPrivacyViolations("Welcome back Hebbian!")).toContain(
      "provider account display name",
    );
    expect(() =>
      assertProviderScreenSafe(
        "claude",
        normalizeProviderScreen("Welcome back Hebbian!"),
      ),
    ).not.toThrow();
    expect(() =>
      assertProviderScreenSafe("codex", "Authorization: Bearer secret-token-value"),
    ).toThrow(UnsafeProviderOutputError);
    for (const diagnostic of [
      "SessionStart hook (failed)",
      "error: hook exited with code 1",
    ]) {
      expect(() => assertProviderScreenSafe("codex", diagnostic)).toThrow(
        UnsafeProviderOutputError,
      );
      expect(providerPrivacyViolations(diagnostic)).toContain(
        "ambient lifecycle hook failure",
      );
    }
    expect(() =>
      assertProviderScreenSafe(
        "codex",
        "Authorization: Bearer \u001b[31msecret-token-value\u001b[0m",
      ),
    ).toThrow(UnsafeProviderOutputError);
    expect(() =>
      assertProviderScreenSafe("claude", "Please log in at https://example.com/login"),
    ).toThrow(ProviderAuthenticationRequiredError);
    expect(providerPrivacyViolations("api_key=super-secret-value")).toContain(
      "named credential",
    );
    for (const assignment of [
      "AWS_SECRET_ACCESS_KEY=super-secret-value",
      "DATABASE_PASSWORD=super-secret-value",
      "GH_TOKEN=super-secret-value",
    ]) {
      expect(providerPrivacyViolations(assignment)).toContain(
        "environment credential",
      );
    }
    expect(visibleProviderText("a\u001b[31mstyled\u001b[0m value")).toBe(
      "astyled value",
    );
  });

  it("creates the disposable demo commit without inherited signing", async () => {
    const signingHome = await mkdtemp(resolve(tmpdir(), "dure-media-signing-"));
    const gitConfig = resolve(signingHome, "gitconfig");
    let fixture;
    try {
      await writeFile(
        gitConfig,
        [
          "[commit]",
          "\tgpgsign = true",
          "[gpg]",
          "\tformat = ssh",
          "[gpg \"ssh\"]",
          "\tprogram = /usr/bin/false",
          "[user]",
          "\tsigningkey = invalid-signing-key",
          "",
        ].join("\n"),
      );
      fixture = await createProviderDemoRepo("signing-disabled", {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfig,
        HOME: signingHome,
      });
      expect(await readFile(resolve(fixture.repo, ".git", "HEAD"), "utf8"))
        .toMatch(/^ref: refs\/heads\//u);
      const codexWorktree = await createProviderDemoWorktree(
        fixture,
        "dure-media-codex",
        process.env,
      );
      const claudeWorktree = await createProviderDemoWorktree(
        fixture,
        "dure-media-claude",
        process.env,
      );
      expect([codexWorktree, claudeWorktree]).toEqual([
        resolve(fixture.root, "worktrees", "dure-media-codex"),
        resolve(fixture.root, "worktrees", "dure-media-claude"),
      ]);
      expect(codexWorktree).not.toBe(claudeWorktree);
      await expect(
        readFile(resolve(codexWorktree, "package.json"), "utf8"),
      ).resolves.toContain("dure-session-handoff-demo");
      await expect(
        readFile(resolve(claudeWorktree, "package.json"), "utf8"),
      ).resolves.toContain("dure-session-handoff-demo");
    } finally {
      if (fixture) await rm(fixture.root, { recursive: true, force: true });
      await rm(signingHome, { recursive: true, force: true });
    }
  });

  it("decodes canonical hmux repaint frames without exposing the home path", () => {
    const frame = decodeHmuxScreen(
      "codex",
      {
        ok: true,
        encoding: "AnsiRedrawV1",
        columns: 80,
        rows: 24,
        sequenceThrough: "12",
        repaintBase64: Buffer.from("/Users/demo/worktree\nWorking…").toString(
          "base64",
        ),
      },
      "/Users/demo",
    );
    expect(frame).toMatchObject({
      columns: 80,
      rows: 24,
      sequenceThrough: "12",
    });
    expect(Buffer.from(frame.repaintBase64, "base64").toString("utf8")).toBe(
      "~/dure-demo\nWorking…",
    );
    const worktreeFrame = decodeHmuxScreen(
      "codex",
      {
        ok: true,
        encoding: "AnsiRedrawV1",
        columns: 80,
        rows: 24,
        sequenceThrough: "13",
        repaintBase64: Buffer.from(
          "/private/fixture/worktrees/dure-media-codex\nWorking…",
        ).toString("base64"),
      },
      undefined,
      {
        root: "/private/fixture",
        repo: "/private/fixture/repo",
      },
      "/private/fixture/worktrees/dure-media-codex",
    );
    expect(
      Buffer.from(worktreeFrame.repaintBase64, "base64").toString("utf8"),
    ).toBe("~/dure-demo/codex\nWorking…");

    const abbreviatedWorktreeFrame = decodeHmuxScreen(
      "claude",
      {
        ok: true,
        encoding: "AnsiRedrawV1",
        columns: 80,
        rows: 24,
        sequenceThrough: "14",
        repaintBase64: Buffer.from(
          "~/…/dure-media-claude\nWorking…",
        ).toString("base64"),
      },
      undefined,
      {
        root: "/private/fixture",
        repo: "/private/fixture/repo",
      },
      "/private/fixture/worktrees/dure-media-claude",
    );
    expect(
      Buffer.from(abbreviatedWorktreeFrame.repaintBase64, "base64").toString(
        "utf8",
      ),
    ).toBe("~/dure-demo/claude\nWorking…");
  });

  it("accepts process absence only for the exact echoed generation", () => {
    const expected = {
      process_id: 4242,
      start_marker: "macos-proc-start:exact",
    };
    expect(
      processProbeIsAbsent(expected, {
        schemaVersion: 1,
        process: expected,
        status: "absent",
      }),
    ).toBe(true);
    expect(
      processProbeIsAbsent(expected, {
        schemaVersion: 1,
        process: expected,
        status: "live",
      }),
    ).toBe(false);
    expect(() =>
      processProbeIsAbsent(expected, {
        schemaVersion: 1,
        process: { ...expected, start_marker: "replacement" },
        status: "absent",
      }),
    ).toThrow("exact process generation");
  });

  it("keeps real terminal replay ordered and inside the recording window", () => {
    const steps = liveReplaySteps(
      {
        "session-codex": {
          kind: "pty",
          frames: [
            { atMs: 0, sequenceThrough: "1", repaintBase64: "QQ==" },
            { atMs: 6_000, sequenceThrough: "2", repaintBase64: "Qg==" },
            { atMs: 12_000, sequenceThrough: "3", repaintBase64: "Qw==" },
          ],
        },
      },
      10_000,
    );
    expect(steps.map(({ sequenceThrough }) => sequenceThrough)).toEqual([
      "2",
      "3",
    ]);
    expect(steps[0].atMs).toBeLessThan(steps[1].atMs);
    expect(steps.at(-1).atMs).toBeLessThanOrEqual(8_500);
    expect(
      liveReplaySteps(
        {
          "session-claude": {
            kind: "pty",
            frames: [
              { atMs: 0, sequenceThrough: "1", repaintBase64: "QQ==" },
              { atMs: 1_000, sequenceThrough: "2", repaintBase64: "Qg==" },
            ],
          },
        },
        10_000,
      )[0].atMs,
    ).toBe(4_375);
    const visibleSteps = liveReplaySteps(
      {
        "session-review": {
          kind: "pty",
          desktopId: "desk-review",
          visibleWindows: [{ startMs: 5_450, endMs: 9_550 }],
          frames: [
            { atMs: 0, sequenceThrough: "1", repaintBase64: "QQ==" },
            { atMs: 1_000, sequenceThrough: "2", repaintBase64: "Qg==" },
            { atMs: 2_000, sequenceThrough: "3", repaintBase64: "Qw==" },
          ],
        },
      },
      10_000,
    );
    expect(visibleSteps).toHaveLength(2);
    expect(
      visibleSteps.every(
        ({ atMs, desktopId }) =>
          desktopId === "desk-review" && atMs > 5_450 && atMs < 9_550,
      ),
    ).toBe(true);
    const manyFrames = Array.from({ length: 30 }, (_, index) => ({
      atMs: index * 100,
      sequenceThrough: String(index + 1),
      repaintBase64: Buffer.from(String(index)).toString("base64"),
    }));
    const sampled = liveReplaySteps(
      {
        "session-long": {
          kind: "pty",
          frames: manyFrames,
          visibleWindows: [{ startMs: 2_000, endMs: 5_000 }],
        },
      },
      10_000,
    );
    expect(sampled).toHaveLength(6);
    expect(sampled.at(-1).sequenceThrough).toBe("30");
    expect(
      liveReplaySteps(
        {
          "session-static": {
            kind: "pty",
            frames: [
              {
                atMs: 0,
                sequenceThrough: "1",
                repaintBase64: "QQ==",
              },
            ],
          },
        },
        10_000,
      ),
    ).toHaveLength(1);
  });

  it("uses the prompt-confirmed live frame for floating-pane stills", () => {
    const frames = [
      { sequenceThrough: "1", repaintBase64: "cmVhZHk=" },
      { sequenceThrough: "2", repaintBase64: "cHJvbXB0" },
      { sequenceThrough: "3", repaintBase64: "dHJhbnNpdGlvbmFs" },
    ];
    const scenario = {
      setup: [],
      timeline: [
        {
          action: "floatAgent",
          agentId: "agent-floating",
        },
      ],
    };

    const floatingFrame = stillFrameForTarget(
      scenario,
      { agentId: "agent-floating" },
      frames,
    );
    expect(floatingFrame.sequenceThrough).toBe("2");
    expect(
      Buffer.from(floatingFrame.repaintBase64, "base64").toString("utf8"),
    ).toBe("\u001b[3Jprompt");
    expect(
      stillFrameForTarget(
        scenario,
        { agentId: "agent-grid" },
        frames,
      ).sequenceThrough,
    ).toBe("3");
  });

  it("keeps floating-pane video replay on its coherent live frame", () => {
    const frames = [
      { atMs: 0, sequenceThrough: "1", repaintBase64: "cmVhZHk=" },
      { atMs: 1, sequenceThrough: "2", repaintBase64: "cHJvbXB0" },
      { atMs: 2, sequenceThrough: "3", repaintBase64: "dHJhbnNpdGlvbmFs" },
    ];
    const replay = replayFramesBySession(
      scenarioById("workspace-overview"),
      new Map([["codex", frames]]),
    );

    expect(
      replay["session-codex"].frames.map(({ sequenceThrough }) =>
        sequenceThrough,
      ),
    ).toEqual(["2"]);
    expect(
      Buffer.from(
        replay["session-codex"].frames[0].repaintBase64,
        "base64",
      ).toString("utf8"),
    ).toBe("\u001b[3Jprompt");
    const floatingReplayAt = liveReplaySteps(replay, 15_000).find(
      ({ id }) => id === "session-codex",
    ).atMs;
    expect(floatingReplayAt).toBeGreaterThanOrEqual(550);
    expect(floatingReplayAt).toBeLessThanOrEqual(650);
    expect(replay["session-codex-navigation"].frames).toHaveLength(3);
  });

  it("schedules floating-pane replay when the pane is floated during setup", () => {
    const frames = [
      { atMs: 0, sequenceThrough: "1", repaintBase64: "cmVhZHk=" },
      { atMs: 1, sequenceThrough: "2", repaintBase64: "cHJvbXB0" },
    ];
    const scenario = structuredClone(scenarioById("workspace-overview"));
    const floating = scenario.timeline.find(
      ({ action }) => action === "floatAgent",
    );
    scenario.timeline = scenario.timeline.filter(
      ({ action }) => action !== "floatAgent",
    );
    scenario.setup.push(floating);

    const replay = replayFramesBySession(
      scenario,
      new Map([["codex", frames]]),
    );
    const floatingReplayAt = liveReplaySteps(replay, 15_000).find(
      ({ id }) => id === "session-codex",
    ).atMs;

    expect(floatingReplayAt).toBeGreaterThanOrEqual(100);
    expect(floatingReplayAt).toBeLessThanOrEqual(200);
  });

  it("requires live still panes opened on the active desktop", () => {
    const scenario = structuredClone(scenarioById("workspace-overview"));
    scenario.liveProviderSessionIds = [
      "session-codex",
      "session-claude",
      "session-codex-navigation",
      "session-codex-review",
      "session-claude-review",
    ];

    expect(requiredLiveStillSessionIds(scenario)).toEqual([
      "session-codex",
      "session-claude",
      "session-codex-navigation",
    ]);
  });

  it("fails closed when a required live still pane does not render", async () => {
    const scenario = structuredClone(scenarioById("workspace-overview"));
    for (const id of ["session-codex", "session-codex-review"]) {
      scenario.fixture.terminalSnapshots[id] = "provider screen";
      scenario.fixture.terminalSnapshotGeometry ??= {};
      scenario.fixture.terminalSnapshotGeometry[id] = {
        columns: 80,
        rows: 24,
      };
    }
    scenario.liveProviderSessionIds = ["session-codex"];
    const activeDesktop = { contains: () => false };
    const page = { evaluate: async (evaluate, value) => evaluate(value) };
    const unexpectedMockCall = () => {
      throw new Error("hidden terminal must not publish a repaint");
    };
    await withTemporaryGlobals(
      {
        document: {
          getElementById: () => activeDesktop,
          querySelectorAll: () => [],
        },
        getComputedStyle: () => ({
          display: "block",
          visibility: "visible",
        }),
        window: {
          __DURE_MEDIA_CAPTURE_MOCK__: {
            beginTerminalRenderProbe: unexpectedMockCall,
            publishTerminalSnapshot: unexpectedMockCall,
          },
          __DURE_STORE__: { getState: () => ({ activeDesktopId: "desk-launch" }) },
          innerHeight: 1_080,
          innerWidth: 1_920,
        },
      },
      async () => {
        await expect(
          repaintVisibleLiveTerminals(page, scenario),
        ).rejects.toThrow("live still repaint did not render");

        scenario.liveProviderSessionIds = ["session-codex-review"];
        await expect(
          repaintVisibleLiveTerminals(page, scenario),
        ).resolves.toHaveLength(1);
      },
    );
  });

  it("publishes, resumes, and renders a visible live still repaint", async () => {
    const scenario = structuredClone(scenarioById("workspace-overview"));
    scenario.liveProviderSessionIds = ["session-codex"];
    scenario.fixture.terminalSnapshots["session-codex"] = "provider screen";
    scenario.fixture.terminalSnapshotGeometry ??= {};
    scenario.fixture.terminalSnapshotGeometry["session-codex"] = {
      columns: 80,
      rows: 24,
    };
    const calls = [];
    const host = {
      dataset: { dureMediaSessionId: "session-codex" },
      getBoundingClientRect: () => ({
        bottom: 500,
        height: 400,
        left: 100,
        right: 700,
        top: 100,
        width: 600,
      }),
    };
    const mock = {
      beginTerminalRenderProbe: (id) => {
        calls.push(`begin:${id}`);
        return "probe-1";
      },
      publishTerminalSnapshot: (snapshot) => {
        calls.push(`publish:${snapshot.id}`);
        return { consumerIds: ["consumer-1"], endOffset: "7" };
      },
      waitForTerminalSnapshotResume: async ({ endOffset, renderProbe }) => {
        calls.push(`resume:${endOffset}:${renderProbe}`);
      },
      waitForTerminalRender: async (renderProbe) => {
        calls.push(`render:${renderProbe}`);
      },
    };
    const page = { evaluate: async (evaluate, value) => evaluate(value) };

    await withTemporaryGlobals(
      {
        document: {
          getElementById: () => ({ contains: (candidate) => candidate === host }),
          querySelectorAll: () => [host],
        },
        getComputedStyle: () => ({
          display: "block",
          visibility: "visible",
        }),
        window: {
          __DURE_MEDIA_CAPTURE_MOCK__: mock,
          __DURE_STORE__: { getState: () => ({ activeDesktopId: "desk-launch" }) },
          innerHeight: 1_080,
          innerWidth: 1_920,
        },
      },
      async () => {
        await expect(
          repaintVisibleLiveTerminals(page, scenario),
        ).resolves.toEqual([
          expect.objectContaining({
            id: "session-codex",
            rendered: true,
            required: true,
            visible: true,
          }),
        ]);
      },
    );
    expect(calls).toEqual([
      "begin:session-codex",
      "publish:session-codex",
      "resume:7:probe-1",
      "render:probe-1",
    ]);
  });

  it("replays only provider panes that the selected scenario opens", () => {
    const frames = [
      { atMs: 0, sequenceThrough: "1", repaintBase64: "QQ==" },
      { atMs: 1_000, sequenceThrough: "2", repaintBase64: "Qg==" },
    ];
    for (const scenario of MEDIA_CAPTURE_SCENARIOS) {
      const openedAgentIds = new Set(
        [...scenario.setup, ...scenario.timeline]
          .filter(({ action }) => action === "openAgent")
          .map(({ agentId }) => agentId),
      );
      const expectedSessions = scenario.fixture.agents
        .filter(
          ({ id, provider }) =>
            provider === "codex" && openedAgentIds.has(id),
        )
        .map(({ sessionId }) => sessionId)
        .sort();
      if (scenario.fixture.headlessSpawn?.providerTarget?.provider === "codex") {
        expectedSessions.push(
          scenario.fixture.headlessSpawn.providerTarget.sessionId,
        );
        expectedSessions.sort();
      }
      for (const target of scenario.fixture.productTour?.providerTargets ?? []) {
        if (target.provider === "codex" && !expectedSessions.includes(target.id)) expectedSessions.push(target.id);
      }
      expectedSessions.sort();
      const replay = replayFramesBySession(
        scenario,
        new Map([["codex", frames]]),
      );
      expect(Object.keys(replay).sort()).toEqual(expectedSessions);
      const expectedProviders = [
        ...new Set(
          scenario.fixture.agents
            .filter(({ id }) => openedAgentIds.has(id))
            .map(({ provider }) => provider),
        ),
      ];
      const headlessProvider =
        scenario.fixture.headlessSpawn?.providerTarget?.provider;
      if (headlessProvider && !expectedProviders.includes(headlessProvider)) {
        expectedProviders.push(headlessProvider);
      }
      for (const target of scenario.fixture.productTour?.providerTargets ?? []) {
        if (!expectedProviders.includes(target.provider)) expectedProviders.push(target.provider);
      }
      expect(providersForScenario(scenario)).toEqual(expectedProviders);
    }
  });

  it("selects a pane-sized redraw without duplicating provider calls", () => {
    const shared = [{ sequenceThrough: "1" }, { sequenceThrough: "2" }];
    const overlay = [{ sequenceThrough: "3", columns: 69, rows: 21 }];
    const capture = {
      frames: shared,
      framesBySession: { "session-codex": overlay },
    };
    expect(framesForSessionTarget(capture, "session-codex")).toBe(overlay);
    expect(
      framesForSessionTarget(capture, "session-codex-navigation"),
    ).toBe(shared);
    expect(framesForSessionTarget(shared, "legacy-target")).toBe(shared);
    const overview = scenarioById("workspace-overview");
    expect(
      dedicatedTargetsForProvider(overview, "codex").map(({ id }) => id),
    ).toEqual(["session-codex"]);
    expect(
      primaryTerminalSize(overview, "codex", {
        "session-codex-navigation": { columns: 109, rows: 16 },
      }),
    ).toEqual({ columns: 109, rows: 16 });
  });

  it("waits for the provider TUI to stably redraw after a pane resize", async () => {
    const before = {
      columns: 66,
      rows: 22,
      sequenceThrough: "10",
      repaintBase64: "before",
      text: "OpenAI Codex model: gpt demo",
    };
    const staleLayout = {
      ...before,
      columns: 101,
      rows: 22,
    };
    const redrawn = {
      columns: 101,
      rows: 22,
      sequenceThrough: "11",
      repaintBase64: "redrawn",
      text: `OpenAI Codex model: gpt demo ready\n${"─".repeat(100)}`,
    };
    const options = {
      before,
      targetSize: { columns: 101, rows: 22 },
      visibleText: (frame) => frame.text,
      ready: (screen) => screen.includes("OpenAI Codex"),
    };
    expect(
      paneSizedFrameHasRedrawn({ ...options, candidate: staleLayout }),
    ).toBe(false);
    expect(
      paneSizedFrameHasRedrawn({ ...options, candidate: redrawn }),
    ).toBe(true);
    expect(providerScreenFillsColumns(redrawn.text, 101)).toBe(true);
    expect(providerScreenFillsColumns("OpenAI Codex\nshort", 101)).toBe(false);

    const changing = {
      ...redrawn,
      sequenceThrough: "12",
      repaintBase64: "redrawn-with-updated-status",
    };
    const frames = [redrawn, changing];
    await expect(
      waitForStablePaneSizedFrame({
        ...options,
        readFrame: async () => frames.shift(),
        sleep: async () => {},
        attempts: 2,
        intervalMs: 0,
      }),
    ).resolves.toBe(changing);
  });

  it("fails closed when the latest live frame did not render", () => {
    const replay = { "session-codex": { frames: [{}, {}, {}] } };
    expect(
      unrenderedLatestSessions(replay, [
        { id: "session-codex", atMs: 1_000, rendered: true },
        { id: "session-codex", atMs: 2_000, rendered: false },
      ]),
    ).toEqual(["session-codex"]);
    expect(
      unrenderedLatestSessions(replay, [
        { id: "session-codex", atMs: 1_000, rendered: false },
        { id: "session-codex", atMs: 2_000, rendered: true },
      ]),
    ).toEqual([]);
    expect(
      unrenderedReplayPublications([
        { id: "session-codex", atMs: 1_000, rendered: false },
        { id: "session-codex", atMs: 2_000, rendered: true },
      ]),
    ).toEqual([
      { id: "session-codex", atMs: 1_000, rendered: false },
    ]);
  });

  it("starts videos from the first provider update instead of an empty spawn frame", () => {
    const spawn = { sequenceThrough: "1" };
    const firstUpdate = { sequenceThrough: "2" };
    expect(videoInitialFrame([spawn, firstUpdate])).toBe(firstUpdate);
    expect(videoInitialFrame([spawn])).toBe(spawn);
  });
});
