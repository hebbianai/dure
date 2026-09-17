#!/usr/bin/env node
import { runProductTourAction } from "./product-tour-actions.mjs";
import { startLosslessScreencast } from "./lossless-screencast.mjs";

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import {
  createLiveProviderMedia,
  fixtureProviderMedia,
} from "../providers/live-sessions.mjs";
import { providerProvenance } from "../providers/provenance.mjs";
import {
  terminalCaptureSize,
  terminalGeometryFitsViewport,
} from "../providers/terminal-geometry.mjs";
import { playLiveTerminalReplay } from "./live-terminal-replay.mjs";
import { repaintVisibleLiveTerminals } from "./live-terminal-still.mjs";
import { measureLiveTerminalSizes } from "./terminal-viewport-measurement.mjs";
import { mediaBackendCapabilities } from "./backend-capabilities.mjs";
import { TERMINAL_SURFACE_SELECTORS } from "./terminal-surface.mjs";
import {
  assertSafeOutputRoot,
  repoRoot,
  toolRoot,
} from "../paths.mjs";
import { MEDIA_CAPTURE_SCHEMA_VERSION } from "../scenarios.mjs";
import {
  assertApplicationBuildUnchanged,
  readApplicationBuild,
} from "./application-build.mjs";
import { runOnboardingAction } from "./onboarding-actions.mjs";
import { runSpacesPaneMoveAction } from "./spaces-pane-move-actions.mjs";
import { runSessionRecoveryAction } from "./session-recovery-actions.mjs";
import { captureInterfacePreferences } from "./interface-preferences.mjs";
import { runClientLifecycleAction } from "./client-lifecycle-actions.mjs";
import { runClipboardImagePasteAction } from "./clipboard-image-paste-actions.mjs";
import { runHeadlessSpawnAction } from "./headless-spawn-actions.mjs";
import { runOrchestrationChannelAction } from "./orchestration-channel-actions.mjs";
import { captureArtifactPlan } from "./capture-plan.mjs";
import {
  assertCaptureStageBootstrap,
  captureStageBootstrapCss,
  installCaptureStage,
} from "./capture-stage.mjs";
import { renderGifDerivative } from "./gif-derivative.mjs";
import { renderPublicWebmDerivative } from "./webm-derivative.mjs";
import {
  createCaptureGeneration,
  discardCaptureGeneration,
  promoteCaptureGeneration,
} from "./output-generation.mjs";
import { assertBrowserCaptureProviderSource } from "./provider-source-policy.mjs";
import { captureInteractionEvidence } from "./interaction-evidence.mjs";
import {
  captureProofManifest,
  captureProofNeedsNativeTauri,
} from "./capture-proof.mjs";

const mockPath = resolve(toolRoot, "tauri-mock.js");

function progress(message) {
  process.stderr.write(`[media-capture] ${message}\n`);
}

export async function startCaptureServer() {
  progress("starting isolated Vite server");
  const server = await createServer({
    root: repoRoot,
    configFile: resolve(repoRoot, "vite.config.ts"),
    logLevel: "warn",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("Vite capture server did not expose a TCP address");
  }
  progress(`Vite ready on 127.0.0.1:${address.port}`);
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function installCaptureInit(page, scenario, buildInfo) {
  const mock = await readFile(mockPath, "utf8");
  const defaultSnapshotGeometry = Object.fromEntries(
    Object.keys(scenario.fixture.terminalSnapshots ?? {}).map((id) => {
      const provider = scenario.fixture.agents.find(
        (agent) => agent.sessionId === id,
      )?.provider;
      return [id, terminalCaptureSize(scenario, provider, id)];
    }),
  );
  const init = [
    `{
      const installCaptureStageBootstrap = () => {
        if (!document.documentElement) return false;
        document.documentElement.dataset.dureCaptureStage = ${JSON.stringify(
          scenario.captureStage.mode,
        )};
        const css = ${JSON.stringify(captureStageBootstrapCss(scenario))};
        if (css) {
          const style = document.createElement("style");
          style.dataset.dureCaptureStageBootstrap = "desktop-window";
          style.textContent = css;
          document.documentElement.append(style);
        }
        return true;
      };
      if (!installCaptureStageBootstrap()) {
        document.addEventListener("readystatechange", installCaptureStageBootstrap, {
          once: true,
        });
      }
    }`,
    `{
      const NativeDate = Date;
      const captureEpochMs = ${Date.parse(scenario.clock)};
      const captureStartedAt = performance.now();
      const captureNow = () =>
        Math.floor(captureEpochMs + (performance.now() - captureStartedAt));
      function DureCaptureDate(...args) {
        if (new.target) {
          return args.length === 0
            ? new NativeDate(captureNow())
            : new NativeDate(...args);
        }
        return new NativeDate(captureNow()).toString();
      }
      Object.setPrototypeOf(DureCaptureDate, NativeDate);
      DureCaptureDate.prototype = NativeDate.prototype;
      DureCaptureDate.now = captureNow;
      globalThis.Date = DureCaptureDate;
    }`,
    `window.__DURE_MEDIA_CAPTURE_CONFIG__ = ${JSON.stringify({
      schemaVersion: MEDIA_CAPTURE_SCHEMA_VERSION,
      scenarioId: scenario.id,
      backendCapabilities: mediaBackendCapabilities({
        buildId: buildInfo.buildId,
        name: "dure-media-fixture",
        runtimeFingerprint: buildInfo.backendRuntimeFingerprint,
      }),
      terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
      fixture: {
        agents: scenario.fixture.agents,
        providerConversations: scenario.fixture.providerConversations ?? [],
        providerConversationDetails:
          scenario.fixture.providerConversationDetails ?? [],
        diffBadges: scenario.fixture.diffBadges,
        diffReviews: scenario.fixture.diffReviews,
        gitStatuses: scenario.fixture.gitStatuses,
        terminalScreensByCwd: scenario.fixture.terminalScreensByCwd,
        terminalSnapshots: scenario.fixture.terminalSnapshots,
        clipboardImagePaste: scenario.fixture.clipboardImagePaste ?? null,
        productTour: scenario.fixture.productTour ?? null,
        headlessSpawn: scenario.fixture.headlessSpawn ?? null,
        orchestrationChannel: scenario.fixture.orchestrationChannel ?? null,
        sessionRecovery: scenario.fixture.sessionRecovery ?? null,
        terminalSnapshotGeometry:
          {
            ...defaultSnapshotGeometry,
            ...(scenario.fixture.terminalSnapshotGeometry ?? {}),
          },
        defaultTerminalSnapshotGeometry: terminalCaptureSize(scenario),
        fixedTerminalSnapshotIds: Object.keys(
          scenario.fixture.terminalSnapshotGeometry ?? {},
        ),
      },
      liveProviderSessionIds: scenario.liveProviderSessionIds ?? [],
      windowChrome: scenario.windowChrome,
      captureStage: scenario.captureStage,
    })};`,
    `if (sessionStorage.getItem("dure-media-capture-initialized-v1") !== ${JSON.stringify(
      scenario.id,
    )}) {
      localStorage.clear();
      localStorage.setItem("agent-ide-main-window-sidebar", ${JSON.stringify(
        JSON.stringify({
          state: { open: true, width: 340, tab: "spaces" },
          version: 1,
        }),
      )});
      sessionStorage.setItem("dure-media-capture-initialized-v1", ${JSON.stringify(
        scenario.id,
      )});
    }`,
    mock,
  ].join("\n");
  await page.addInitScript({ content: init });
}

async function applyFixture(page, scenario, pageErrors) {
  await page.addScriptTag({ type: "module", content: `
    import { useDiffBadges } from "/src/lib/scm/status/diffBadgesStore.ts";
    import { useAgentAttention } from "/src/lib/agents/agentAttentionStore.ts";
    window.__DURE_CAPTURE_STORES__ = { useDiffBadges, useAgentAttention };
  ` });
  await page.waitForFunction(() => Boolean(window.__DURE_CAPTURE_STORES__));
  await page.evaluate(({ captureScenario, interfacePreferences }) => {
    const { useDiffBadges, useAgentAttention } = window.__DURE_CAPTURE_STORES__;
    const store = window.__DURE_STORE__;
    const current = store.getState();
    const fixture = captureScenario.fixture;
    store.setState({
      desktops: fixture.desktops,
      activeDesktopId: fixture.activeDesktopId,
      desktopVisits: {},
      layouts: {},
      projects: fixture.projects,
      pinnedProjects: fixture.projects.map((project) => project.id),
      agents: fixture.agents,
      sshHosts: fixture.sshHosts,
      installedAgents: fixture.installedAgents,
      agentActivity: fixture.agentActivity,
      gitStatuses: fixture.gitStatuses,
      sshStates: fixture.sshStates,
      language: fixture.language,
      terminalFontSize: captureScenario.terminalFontSize ?? 11.5,
      uiPrefs: {
        ...current.uiPrefs,
        ...interfacePreferences,
        theme: "dark",
        onboardingDismissed: fixture.onboardingDismissed ?? true,
        showClaudeUsage: false,
        showCodexUsage: false,
        paneInactiveOpacity: 0.92,
      },
      terminalPrefs: {
        ...current.terminalPrefs,
        gpu: "off",
      },
      stats: {
        agentsStarted: 18,
        prsCreated: 7,
        activeMs: 28_800_000,
        since: Date.parse(captureScenario.clock) - 86_400_000,
      },
    });
    useDiffBadges.setState({ badges: fixture.diffBadges ?? {} });
    useAgentAttention.setState({
      displayStates: fixture.agentDisplayStates ?? {},
    });
    document.documentElement.dataset.dureMediaCapture = captureScenario.id;
    document.documentElement.dataset.captureSchema = String(
      captureScenario.schemaVersion,
    );
    document.documentElement.style.backgroundColor = "#0b0e14";
  }, {
    captureScenario: scenario,
    interfacePreferences: captureInterfacePreferences(scenario),
  });
  try {
    await page.waitForFunction(
      (desktopId) =>
        window.__DURE_STORE__.getState().activeDesktopId === desktopId &&
        window.__DURE_DOCK__?.getDockview?.(desktopId) !== undefined,
      scenario.fixture.activeDesktopId,
      { timeout: 10_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      activeDesktopId: window.__DURE_STORE__?.getState?.().activeDesktopId,
      desktops: window.__DURE_STORE__?.getState?.().desktops,
      mountedDesktopIds:
        window.__DURE_DOCK__?.mountedDockviewEntries?.().map?.(([id]) => id) ??
        [],
      bodyText: document.body.innerText.slice(0, 1_000),
      rootHtml: document.getElementById("root")?.innerHTML.slice(0, 1_000),
    }));
    throw new Error(
      `capture fixture did not mount its active desktop: ${JSON.stringify({
        ...diagnostics,
        pageErrors: pageErrors.map((pageError) => pageError.message),
      })}`,
      { cause: error },
    );
  }
}

async function restoreCaptureSurfaceAfterReload(page, scenario) {
  await assertCaptureStageBootstrap(page, scenario);
  await installCaptureWindowChrome(page, scenario);
  await page.waitForFunction(
    () =>
      typeof window.__DURE_STORE__ === "function" &&
      typeof window.__DURE_DOCK__ === "object",
  );
  await page.waitForFunction(
    (desktopId) =>
      window.__DURE_STORE__.getState().activeDesktopId === desktopId &&
      window.__DURE_DOCK__?.getDockview?.(desktopId) !== undefined,
    scenario.fixture.activeDesktopId,
    { timeout: 10_000 },
  );
  await page.evaluate((captureScenario) => {
    document.documentElement.dataset.dureMediaCapture = captureScenario.id;
    document.documentElement.dataset.captureSchema = String(
      captureScenario.schemaVersion,
    );
    document.documentElement.style.backgroundColor = "#0b0e14";
  }, scenario);
}

export async function runAction(page, action, scenario, runtime = {}) {
  if (
    await runClientLifecycleAction(page, action, {
      ...runtime,
      afterReload: () => restoreCaptureSurfaceAfterReload(page, scenario),
    })
  ) {
    return;
  }
  if (
    await runSessionRecoveryAction(page, action, {
      afterReload: () => restoreCaptureSurfaceAfterReload(page, scenario),
    })
  ) {
    return;
  }
  if (await runProductTourAction(page, action, scenario)) return;
  if (await runOnboardingAction(page, action)) return;
  if (await runSpacesPaneMoveAction(page, action, runtime)) return;
  if (await runClipboardImagePasteAction(page, action, runtime)) return;
  if (await runHeadlessSpawnAction(page, action, runtime)) return;
  if (await runOrchestrationChannelAction(page, action, runtime)) return;
  const terminalCountBefore =
    action.action === "openTerminal"
      ? await page.evaluate(
          (desktopId) =>
            window.__DURE_DOCK__
              ?.getDockview?.(desktopId)
              ?.panels.filter((panel) => panel.id.startsWith("term:")).length ??
            0,
          action.desktopId,
        )
      : null;
  const requiredSpaceKeys =
    action.action === "clickSpace"
      ? [action.spaceKey]
      : action.action === "selectSpaceRange"
        ? [action.fromSpaceKey, action.toSpaceKey]
        : [];
  if (requiredSpaceKeys.length > 0) {
    await page.waitForFunction(
      (spaceKeys) =>
        spaceKeys.every((spaceKey) =>
          [...document.querySelectorAll("[data-space-key]")].some(
            (candidate) => candidate.dataset.spaceKey === spaceKey,
          ),
        ),
      requiredSpaceKeys,
    );
  }
  await page.evaluate(async (step) => {
    const store = window.__DURE_STORE__;
    const dock = window.__DURE_DOCK__;
    const clickSpace = (spaceKey, shiftKey = false) => {
      const row = [...document.querySelectorAll("[data-space-key]")].find(
        (candidate) => candidate.dataset.spaceKey === spaceKey,
      );
      const button = row?.querySelector("button");
      if (!button) throw new Error(`capture space is missing: ${spaceKey}`);
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          shiftKey,
          view: window,
        }),
      );
    };
    if (step.action === "activateDesktop") {
      store.getState().setActiveDesktop(step.desktopId);
      return;
    }
    if (step.action === "focusTerminal") {
      const api = dock.getDockview(step.desktopId);
      const panel = api?.panels.find((candidate) =>
        candidate.id.startsWith("term:"),
      );
      if (!panel) {
        throw new Error(`capture terminal is missing: ${step.desktopId}`);
      }
      panel.api.setActive();
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const host = [
        ...document.querySelectorAll(".dv-active-group .terminal-host"),
      ].find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        });
      if (!host) {
        throw new Error(`active terminal host is missing: ${step.desktopId}`);
      }
      host.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          cancelable: true,
          pointerId: 7,
          pointerType: "mouse",
          view: window,
        }),
      );
      host.querySelector(step.terminalSurfaceSelectors.input)?.focus({
        preventScroll: true,
      });
      return;
    }
    if (step.action === "equalizeGridColumns") {
      const api = dock.getDockview(step.desktopId);
      const terminalPanel = api?.panels.find((candidate) =>
        candidate.id.startsWith("term:"),
      );
      if (!api || !terminalPanel) {
        throw new Error(
          `capture terminal grid is missing: ${step.desktopId}`,
        );
      }
      const gridBounds = api.groups
        .filter((group) => group.api.location.type === "grid")
        .map((group) => group.element.getBoundingClientRect());
      if (
        gridBounds.length !==
        step.columns.reduce((sum, count) => sum + count, 0)
      ) {
        throw new Error(
          `capture grid pane count does not match ${step.columns.join("|")}`,
        );
      }
      const left = Math.min(...gridBounds.map((bounds) => bounds.left));
      const right = Math.max(...gridBounds.map((bounds) => bounds.right));
      const resolvePanel = (panelId) =>
        panelId === "term:*" ? terminalPanel : api.getPanel(panelId);
      const expectedPanels = step.panelColumns.map((column) =>
        column.map((panelId) => {
          const panel = resolvePanel(panelId);
          if (!panel) {
            throw new Error(`capture grid panel is missing: ${panelId}`);
          }
          return panel;
        }),
      );
      const nextLayout = () =>
        new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
        );
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const columnWidth = Math.floor((right - left) / step.columns.length);
        for (const column of expectedPanels.slice(0, -1)) {
          column[0].group.api.setSize({ width: columnWidth });
        }
        await nextLayout();
        for (const column of expectedPanels) {
          if (column.length < 2) continue;
          const bounds = column.map((panel) =>
            panel.group.element.getBoundingClientRect(),
          );
          const top = Math.min(...bounds.map((rect) => rect.top));
          const bottom = Math.max(...bounds.map((rect) => rect.bottom));
          const rowHeight = Math.floor((bottom - top) / column.length);
          for (const panel of column.slice(0, -1)) {
            panel.group.api.setSize({ height: rowHeight });
          }
        }
        await nextLayout();
      }
      return;
    }
    if (step.action === "floatAgent") {
      const agent = store
        .getState()
        .agents.find((candidate) => candidate.id === step.agentId);
      if (!agent) throw new Error(`capture agent is missing: ${step.agentId}`);
      const desktop = document.getElementById(
        `desktop-panel-${step.desktopId}`,
      );
      const tab = [...(desktop?.querySelectorAll(".pane-chrome") ?? [])]
        .find((candidate) => {
          const candidateBounds = candidate.getBoundingClientRect();
          return (
            candidate.textContent?.includes(agent.name) &&
            candidateBounds.width > 0 &&
            candidateBounds.height > 0
          );
        })
        ?.closest(".dv-tab");
      if (!tab) throw new Error(`capture agent tab is missing: ${agent.name}`);
      const bounds = tab.getBoundingClientRect();
      tab.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          cancelable: true,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          pointerId: 11,
          pointerType: "mouse",
          shiftKey: true,
          view: window,
        }),
      );
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          buttons: 0,
          pointerId: 11,
          pointerType: "mouse",
          view: window,
        }),
      );
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
        (candidate) => candidate.getAttribute("aria-label") === agent.name,
      );
      if (!dialog) {
        throw new Error(`capture floating pane is missing: ${agent.name}`);
      }
      const resizeHandle = dialog.querySelector(
        ".dv-resize-handle-bottomright",
      );
      if (!resizeHandle) {
        throw new Error(`capture resize handle is missing: ${agent.name}`);
      }
      const beforeResize = dialog.getBoundingClientRect();
      const resizePointerId = 12;
      resizeHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          cancelable: true,
          clientX: beforeResize.right,
          clientY: beforeResize.bottom,
          pointerId: resizePointerId,
          pointerType: "mouse",
          view: window,
        }),
      );
      for (const [clientX, clientY] of [
        [beforeResize.right, beforeResize.bottom],
        [beforeResize.left + step.width, beforeResize.top + step.height],
      ]) {
        window.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            buttons: 1,
            clientX,
            clientY,
            pointerId: resizePointerId,
            pointerType: "mouse",
            view: window,
          }),
        );
      }
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          buttons: 0,
          clientX: beforeResize.left + step.width,
          clientY: beforeResize.top + step.height,
          pointerId: resizePointerId,
          pointerType: "mouse",
          view: window,
        }),
      );
      const titlebar = dialog.querySelector(".dv-floating-titlebar");
      if (!titlebar || !dialog.parentElement) {
        throw new Error(`capture floating titlebar is missing: ${agent.name}`);
      }
      const afterResize = dialog.getBoundingClientRect();
      const containerBounds = dialog.parentElement.getBoundingClientRect();
      const titlebarBounds = titlebar.getBoundingClientRect();
      const grabX = titlebarBounds.left + titlebarBounds.width / 2;
      const grabY = titlebarBounds.top + titlebarBounds.height / 2;
      const movePointerId = 13;
      titlebar.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          cancelable: true,
          clientX: grabX,
          clientY: grabY,
          pointerId: movePointerId,
          pointerType: "mouse",
          view: window,
        }),
      );
      for (const [clientX, clientY] of [
        [grabX, grabY],
        [
          containerBounds.left + step.left + (grabX - afterResize.left),
          containerBounds.top + step.top + (grabY - afterResize.top),
        ],
      ]) {
        window.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            buttons: 1,
            clientX,
            clientY,
            pointerId: movePointerId,
            pointerType: "mouse",
            view: window,
          }),
        );
      }
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          buttons: 0,
          pointerId: movePointerId,
          pointerType: "mouse",
          view: window,
        }),
      );
      return;
    }
    if (step.action === "openDiff") {
      const agent = store
        .getState()
        .agents.find((candidate) => candidate.id === step.agentId);
      if (!agent) throw new Error(`capture agent is missing: ${step.agentId}`);
      dock.openDiffPanel(step.desktopId, agent.id, agent.name);
      return;
    }
    if (step.action === "openTerminal") {
      const api = dock.getDockview(step.desktopId);
      const referencePanel = api?.panels.find((candidate) =>
        candidate.id.startsWith("term:"),
      );
      if (!api) {
        throw new Error(`capture desktop is missing: ${step.desktopId}`);
      }
      const sessionId = dock.openLocalTerminalOn(
        api,
        step.cwd,
        referencePanel
          ? {
              referencePanel: referencePanel.id,
              direction: step.direction,
            }
          : undefined,
      );
      window.__DURE_MEDIA_CAPTURE_MOCK__.registerTerminalCwd(
        sessionId,
        step.cwd,
      );
      return;
    }
    if (step.action === "clickSpace") {
      clickSpace(step.spaceKey);
      return;
    }
    if (step.action === "selectSpaceRange") {
      clickSpace(step.fromSpaceKey);
      clickSpace(step.toSpaceKey, true);
      return;
    }
    if (step.action === "openAgent") {
      const agent = store
        .getState()
        .agents.find((candidate) => candidate.id === step.agentId);
      if (!agent) throw new Error(`capture agent is missing: ${step.agentId}`);
      if (step.relativeToAgentId || step.relativeToTerminal) {
        if (!dock.getDockview(step.desktopId)) {
          throw new Error(`capture desktop is not mounted: ${step.desktopId}`);
        }
        const api = dock.getDockview(step.desktopId);
        const referencePanel = step.relativeToAgentId
          ? `agent:${step.relativeToAgentId}`
          : api.panels.find((candidate) => candidate.id.startsWith("term:"))?.id;
        if (!referencePanel) {
          throw new Error(
            `capture relative terminal is missing: ${step.desktopId}`,
          );
        }
        dock.openAgentPanel(step.desktopId, agent, {
          referencePanel,
          direction: step.direction,
        });
      } else {
        dock.openAgentPanelOnDesktop(step.desktopId, agent);
      }
    }
  }, { ...action, terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS });
  if (action.action === "activateDesktop") {
    await page.waitForFunction(
      (desktopId) =>
        window.__DURE_STORE__.getState().activeDesktopId === desktopId &&
        window.__DURE_DOCK__?.getDockview?.(desktopId) !== undefined,
      action.desktopId,
    );
  } else if (action.action === "focusTerminal") {
    await page.waitForFunction(
      ({ desktopId, terminalSurfaceSelectors }) => {
        const api = window.__DURE_DOCK__.getDockview(desktopId);
        return (
          api?.activePanel?.id.startsWith("term:") &&
          document.activeElement?.matches(terminalSurfaceSelectors.input)
        );
      },
      {
        desktopId: action.desktopId,
        terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
      },
    );
  } else if (action.action === "equalizeGridColumns") {
    await page.waitForFunction(
      ({ desktopId, expectedColumns, expectedPanelColumns }) => {
        const api = window.__DURE_DOCK__.getDockview(desktopId);
        if (!api) return false;
        const terminalPanel = api.panels.find((panel) =>
          panel.id.startsWith("term:"),
        );
        if (!terminalPanel) return false;
        const groups = api.groups
          .filter((group) => group.api.location.type === "grid")
          .map((group) => ({
            bounds: group.element.getBoundingClientRect(),
            panelIds: group.panels.map((panel) => panel.id),
          }))
          .filter(({ bounds }) => bounds.width > 0 && bounds.height > 0)
          .sort(
            (left, right) =>
              left.bounds.left - right.bounds.left ||
              left.bounds.top - right.bounds.top,
          );
        const columns = [];
        for (const group of groups) {
          const column = columns.find(
            (candidate) =>
              Math.abs(candidate.left - group.bounds.left) <= 2,
          );
          if (column) column.groups.push(group);
          else columns.push({ left: group.bounds.left, groups: [group] });
        }
        if (
          columns.length !== expectedColumns.length ||
          columns.some(
            (column, index) =>
              column.groups.length !== expectedColumns[index],
          )
        ) {
          return false;
        }
        for (const column of columns) {
          column.groups.sort(
            (left, right) => left.bounds.top - right.bounds.top,
          );
        }
        const resolvedExpectedPanelColumns = expectedPanelColumns.map((column) =>
          column.map((panelId) =>
            panelId === "term:*" ? terminalPanel.id : panelId,
          ),
        );
        const panelTopologyMatches = columns.every((column, columnIndex) =>
          column.groups.every(
            (group, rowIndex) =>
              group.panelIds.length === 1 &&
              group.panelIds[0] ===
                resolvedExpectedPanelColumns[columnIndex][rowIndex],
          ),
        );
        if (!panelTopologyMatches) return false;
        const bounds = groups.map((group) => group.bounds);
        const top = Math.min(...bounds.map((rect) => rect.top));
        const bottom = Math.max(...bounds.map((rect) => rect.bottom));
        const columnsCoverTheGrid = columns.every((column) => {
          const columnBounds = column.groups.map((group) => group.bounds);
          if (
            Math.abs(columnBounds[0].top - top) > 3 ||
            Math.abs(columnBounds.at(-1).bottom - bottom) > 3
          ) {
            return false;
          }
          return columnBounds.slice(1).every(
            (rect, index) =>
              Math.abs(columnBounds[index].bottom - rect.top) <= 3,
          );
        });
        const widths = columns.map(
          (column) => column.groups[0].bounds.width,
        );
        const columnEdgesAlign = columns.every((column) => {
          const { left, right } = column.groups[0].bounds;
          return column.groups.every(
            ({ bounds: rect }) =>
              Math.abs(rect.left - left) <= 3 &&
              Math.abs(rect.right - right) <= 3,
          );
        });
        const columnsAreAdjacent = columns.slice(1).every(
          (column, index) =>
            Math.abs(
              columns[index].groups[0].bounds.right - column.groups[0].bounds.left,
            ) <= 3,
        );
        const stackedColumnsAreBalanced = columns.every((column) => {
          if (column.groups.length < 2) return true;
          const heights = column.groups.map((group) => group.bounds.height);
          return Math.max(...heights) - Math.min(...heights) <= 3;
        });
        return (
          Math.max(...widths) - Math.min(...widths) <= 3 &&
          columnEdgesAlign &&
          columnsAreAdjacent &&
          stackedColumnsAreBalanced &&
          columnsCoverTheGrid
        );
      },
      {
        desktopId: action.desktopId,
        expectedColumns: action.columns,
        expectedPanelColumns: action.panelColumns,
      },
    );
  } else if (action.action === "floatAgent") {
    await page.waitForFunction(
      ({ agentId, width, height, left, top }) => {
        const agent = window.__DURE_STORE__
          .getState()
          .agents.find((candidate) => candidate.id === agentId);
        if (!agent) return false;
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
          (candidate) => candidate.getAttribute("aria-label") === agent.name,
        );
        if (!dialog) return false;
        const bounds = dialog.getBoundingClientRect();
        const containerBounds = dialog.parentElement?.getBoundingClientRect();
        if (!containerBounds) return false;
        return (
          Math.abs(bounds.width - width) <= 1 &&
          Math.abs(bounds.height - height) <= 1 &&
          Math.abs(bounds.left - containerBounds.left - left) <= 1 &&
          Math.abs(bounds.top - containerBounds.top - top) <= 1
        );
      },
      {
        agentId: action.agentId,
        width: action.width,
        height: action.height,
        left: action.left,
        top: action.top,
      },
    );
  } else if (action.action === "openDiff") {
    await page.waitForFunction(
      (agentId) => {
        const hasPanel = window.__DURE_DOCK__
          .mountedDockviewEntries()
          .some(([, api]) => api.getPanel(`diff:${agentId}`));
        const review =
          window.__DURE_MEDIA_CAPTURE_CONFIG__.fixture.diffReviews[agentId];
        const totals = review.files.reduce(
          (sum, file) => ({
            added: sum.added + file.added,
            deleted: sum.deleted + file.deleted,
          }),
          { added: 0, deleted: 0 },
        );
        const text = document.body.innerText;
        return (
          hasPanel &&
          text.includes("origin/main @") &&
          text.includes(`+${totals.added}`) &&
          text.includes(`−${totals.deleted}`) &&
          text.includes(`All files (${review.files.length})`)
        );
      },
      action.agentId,
    );
  } else if (action.action === "openTerminal") {
    await page.waitForFunction(
      ({ desktopId, expectedCount }) => {
        const api = window.__DURE_DOCK__.getDockview(desktopId);
        return (
          api?.panels.filter((panel) => panel.id.startsWith("term:")).length >=
          expectedCount
        );
      },
      {
        desktopId: action.desktopId,
        expectedCount: (terminalCountBefore ?? 0) + 1,
      },
    );
  } else if (action.action === "openAgent") {
    await page.waitForFunction(
      (agentId) => {
        for (const [, api] of window.__DURE_DOCK__.mountedDockviewEntries()) {
          if (api.getPanel(`agent:${agentId}`)) return true;
        }
        return false;
      },
      action.agentId,
    );
    if (action.replaceDefaultTerminal) {
      await page.evaluate((desktopId) => {
        const api = window.__DURE_DOCK__.getDockview(desktopId);
        for (const panel of [...api.panels]) {
          if (panel.id.startsWith("term:")) panel.api.close();
        }
      }, action.desktopId);
      await page.waitForFunction(
        (desktopId) =>
          window.__DURE_DOCK__
            .getDockview(desktopId)
            .panels.every((panel) => !panel.id.startsWith("term:")),
        action.desktopId,
      );
    }
  } else if (action.action === "selectSpaceRange") {
    await page.waitForFunction(
      ([fromSpaceKey, toSpaceKey]) =>
        [fromSpaceKey, toSpaceKey].every((spaceKey) =>
          [...document.querySelectorAll("[data-space-key]")]
            .find((candidate) => candidate.dataset.spaceKey === spaceKey)
            ?.classList.contains("bg-glass-pane/75"),
        ),
      [action.fromSpaceKey, action.toSpaceKey],
    );
  } else if (action.action === "clickSpace") {
    await page.waitForFunction(() =>
      [...document.querySelectorAll("[data-space-key]")].every(
        (row) => !row.classList.contains("bg-glass-pane/75"),
      ),
    );
  }
  if (
    [
      "equalizeGridColumns",
      "floatAgent",
      "openAgent",
      "openDiff",
      "openTerminal",
    ].includes(action.action)
  ) {
    await page.evaluate((desktopId) => {
      const api = window.__DURE_DOCK__.getDockview(desktopId);
      if (!api) throw new Error(`capture desktop is missing: ${desktopId}`);
      window.__DURE_STORE__.getState().saveLayout(desktopId, api.toJSON());
    }, action.desktopId);
  }
}

async function playTimeline(
  page,
  scenario,
  untilMs = scenario.durationMs,
  startedAt = performance.now(),
  runtime = {},
) {
  for (const action of scenario.timeline) {
    if (action.atMs > untilMs) break;
    const remaining = action.atMs - (performance.now() - startedAt);
    if (remaining > 0) await page.waitForTimeout(remaining);
    await runAction(page, action, scenario, runtime);
  }
  const remaining = untilMs - (performance.now() - startedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
}

export async function preparePage(browser, baseUrl, scenario, applicationBuild) {
  const context = await browser.newContext({
    viewport: {
      width: scenario.viewport.width,
      height: scenario.viewport.height,
    },
    deviceScaleFactor: scenario.viewport.deviceScaleFactor,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    userAgent:
      scenario.windowChrome.platform === "macos"
        ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36"
        : undefined,
  });
  const page = await context.newPage();
  const devtools = await context.newCDPSession(page);
  await devtools.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 8, g: 12, b: 16, a: 1 },
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await installCaptureInit(page, scenario, applicationBuild);
  await page.goto(
    `${baseUrl}/?mediaCapture=${encodeURIComponent(scenario.id)}`,
    { waitUntil: "networkidle" },
  );
  await installCaptureWindowChrome(page, scenario);
  await page.waitForFunction(
    () =>
      typeof window.__DURE_STORE__ === "function" &&
      typeof window.__DURE_DOCK__ === "object",
  );
  await applyFixture(page, scenario, pageErrors);
  for (const action of scenario.setup) await runAction(page, action, scenario);
  if (scenario.terminalRequired !== false) {
    await page.waitForSelector(TERMINAL_SURFACE_SELECTORS.paintedViewport, {
      state: "attached",
      timeout: 10_000,
    });
  }
  await page.waitForTimeout(1_000);
  const terminalReadiness = await page.evaluate((selectors) => {
    const hosts = [...document.querySelectorAll(selectors.host)];
    const viewports = [...document.querySelectorAll(selectors.paintedViewport)];
    return {
      hosts: hosts.length,
      hydrating: hosts.filter((host) =>
        host.classList.contains("terminal-hydrating"),
      ).length,
      fitSettling: hosts.filter((host) =>
        host.classList.contains("terminal-fit-settling"),
      ).length,
      paintedViewports: viewports.length,
      visibleViewports: viewports.filter((viewport) => {
        const style = getComputedStyle(viewport);
        const bounds = viewport.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      }).length,
      documentFocus: document.hasFocus(),
      documentVisibility: document.visibilityState,
    };
  }, TERMINAL_SURFACE_SELECTORS);
  if (
    scenario.terminalRequired !== false &&
    (terminalReadiness.hosts === 0 ||
      terminalReadiness.hydrating > 0 ||
      terminalReadiness.visibleViewports === 0)
  ) {
    throw new Error(
      `capture terminal did not become presentable: ${JSON.stringify(
        terminalReadiness,
      )}`,
    );
  }
  await page.evaluate(
    ({ agents, at }) => {
      window.__DURE_STORE__.setState({
        sessionActivity: Object.fromEntries(
          agents.map((agent) => [
            agent.sessionId,
            { text: agent.name, at },
          ]),
        ),
      });
    },
    {
      agents: scenario.fixture.agents,
      at: Date.parse(scenario.clock),
    },
  );
  await page.evaluate(() => {
    document.documentElement.dataset.captureReady = "true";
  });
  return { context, page, pageErrors };
}

async function installCaptureWindowChrome(page, scenario) {
  await installCaptureStage(page, scenario);
  if (
    scenario.windowChrome.platform !== "macos" ||
    scenario.windowChrome.fullscreen
  ) {
    return;
  }
  await page.evaluate(() => {
    document.querySelector("[data-dure-native-window-controls]")?.remove();
    const controls = document.createElement("div");
    controls.dataset.dureNativeWindowControls = "macos";
    controls.setAttribute("aria-hidden", "true");
    Object.assign(controls.style, {
      alignItems: "center",
      display: "flex",
      gap: "8px",
      height: "34px",
      left: "14px",
      pointerEvents: "none",
      position: "absolute",
      top: "0",
      zIndex: "1000",
    });
    for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
      const button = document.createElement("span");
      Object.assign(button.style, {
        background: color,
        border: "0.5px solid rgba(0, 0, 0, 0.24)",
        borderRadius: "999px",
        boxSizing: "border-box",
        display: "block",
        height: "12px",
        width: "12px",
      });
      controls.append(button);
    }
    const root = document.getElementById("root");
    if (!root) throw new Error("capture window controls could not find app root");
    root.append(controls);
  });
}

function throwPageErrors(pageErrors, scenarioId) {
  if (pageErrors.length === 0) return;
  const sample = pageErrors
    .slice(0, 5)
    .map((error) => error.stack || error.message)
    .join("\n\n");
  throw new Error(`browser errors while capturing ${scenarioId}:\n${sample}`);
}

async function assertExpectedRecoveryOverlays(page, scenario, label) {
  if (scenario.expectedRecoveryOverlayCount === undefined) return;
  const overlays = await page
    .locator('[data-testid="hmux-recovery-overlay"]')
    .allTextContents();
  if (overlays.length !== scenario.expectedRecoveryOverlayCount) {
    throw new Error(
      `${label} expected ${scenario.expectedRecoveryOverlayCount} Hmux recovery overlays, found ${overlays.length}: ${JSON.stringify(overlays)}`,
    );
  }
}

async function startRecoveryOverlayLedger(page, scenario) {
  if (scenario.expectedRecoveryOverlayCount === undefined) return false;
  await page.evaluate(() => {
    const selector = '[data-testid="hmux-recovery-overlay"]';
    const occurrences = [];
    const record = (node, reason) => {
      const elements = [];
      if (node instanceof Element) {
        if (node.matches(selector)) elements.push(node);
        elements.push(...node.querySelectorAll(selector));
      } else if (node.parentElement?.closest(selector)) {
        elements.push(node.parentElement.closest(selector));
      }
      for (const element of elements) {
        const group = element.closest(".dv-groupview");
        occurrences.push({
          reason,
          text: element.textContent?.trim() ?? "",
          code: element.getAttribute("title") ?? "",
          panel: group?.querySelector(".pane-chrome")?.textContent?.trim() ?? "",
          sessionId:
            group?.querySelector("[data-dure-media-session-id]")?.dataset
              ?.dureMediaSessionId ?? "",
          atMs: Math.round(performance.now()),
        });
      }
    };
    const handleRecords = (records) => {
      for (const mutation of records) {
        record(mutation.target, mutation.type);
        for (const node of mutation.addedNodes) record(node, "added");
        for (const node of mutation.removedNodes) record(node, "removed");
      }
    };
    const observer = new MutationObserver(handleRecords);
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    for (const overlay of document.querySelectorAll(selector)) {
      record(overlay, "initial");
    }
    window.__DURE_MEDIA_RECOVERY_OVERLAY_LEDGER__ = {
      finish() {
        handleRecords(observer.takeRecords());
        observer.disconnect();
        return occurrences;
      },
    };
  });
  return true;
}

async function finishRecoveryOverlayLedger(page, scenario, label, started) {
  if (!started) return;
  const evidence = await page.evaluate(() => {
    const ledger = window.__DURE_MEDIA_RECOVERY_OVERLAY_LEDGER__;
    delete window.__DURE_MEDIA_RECOVERY_OVERLAY_LEDGER__;
    return {
      occurrences: ledger?.finish?.() ?? [],
      hmuxConnectionDiagnostics:
        window.__DURE_MEDIA_CAPTURE_MOCK__?.diagnostics?.()
          ?.hmuxConnectionDiagnostics ?? [],
    };
  });
  if (
    scenario.expectedRecoveryOverlayCount === 0 &&
    scenario.allowRecoveryOverlayDuringTimeline !== true &&
    evidence.occurrences.length > 0
  ) {
    const diagnostics = {
      occurrences: evidence.occurrences.slice(0, 5),
      hmuxConnectionDiagnostics:
        evidence.hmuxConnectionDiagnostics.slice(-12),
    };
    throw new Error(
      `${label} rendered an Hmux recovery overlay during recording: ${JSON.stringify(diagnostics)}`,
    );
  }
}

async function assertVisibleTerminalGeometryFits(page, label) {
  const evidence = await page.evaluate(async () => {
    const {
      TERMINAL_SURFACE_SELECTORS: selectors,
      terminalSurfaceDiagnostics,
      terminalSurfaceIsVisible,
      terminalViewportGeometryFromSurface,
    } = await import("/tools/media-capture/runtime/terminal-surface.mjs");
    const mock = window.__DURE_MEDIA_CAPTURE_MOCK__;
    const recordedDiagnostics = mock.diagnostics();
    const visibleHosts = [
      ...document.querySelectorAll(selectors.host),
    ].filter(terminalSurfaceIsVisible);
    const visibleSurfaces = visibleHosts.map((host) => {
      const surface = terminalSurfaceDiagnostics(host, selectors);
      return {
        geometry: terminalViewportGeometryFromSurface(surface),
        panel:
          host.closest(".dv-groupview")?.querySelector(".pane-chrome")
            ?.textContent ??
          host.closest('[role="dialog"]')?.getAttribute("aria-label") ??
          null,
        painted: surface?.painted ?? false,
        sessionId: host.dataset.dureMediaSessionId ?? null,
        textLength: surface?.text.trim().length ?? 0,
        viewportAligned: surface?.viewportAligned ?? false,
        visibleTextLength: surface?.visibleTextLength ?? 0,
      };
    });
    const visibleSessions = [
      ...new Set(
        visibleSurfaces.flatMap(({ sessionId }) =>
          sessionId ? [sessionId] : [],
        ),
      ),
    ];
    const terminalViewportGeometry = {
      ...recordedDiagnostics.terminalViewportGeometry,
    };
    for (const { geometry, sessionId } of visibleSurfaces) {
      if (geometry && sessionId) terminalViewportGeometry[sessionId] = geometry;
    }
    const diagnostics = {
      ...recordedDiagnostics,
      terminalViewportGeometry,
    };
    return {
      diagnostics,
      liveProviderSessions:
        (window.__DURE_MEDIA_CAPTURE_CONFIG__.liveProviderSessionIds ?? []).map(id => window.__DURE_MEDIA_CAPTURE_MOCK__.resolveTerminalSessionId?.(id) ?? id),
      visibleSurfaces,
      visibleSessions,
    };
  });
  const unpresentableSurfaces = evidence.visibleSurfaces.filter(
    ({ painted, sessionId, textLength, viewportAligned, visibleTextLength }) =>
      !painted ||
      !sessionId ||
      textLength === 0 ||
      !viewportAligned ||
      visibleTextLength === 0,
  );
  if (unpresentableSurfaces.length > 0) {
    throw new Error(
      `${label} has visible terminals without an exact painted session: ${JSON.stringify(unpresentableSurfaces)}`,
    );
  }
  const failures = evidence.visibleSessions.flatMap((id) => {
    const source = evidence.diagnostics.terminalSnapshotGeometry[id];
    const viewport = evidence.diagnostics.terminalViewportGeometry[id];
    return terminalGeometryFitsViewport(source, viewport)
      ? []
      : [{ id, source: source ?? null, viewport: viewport ?? null }];
  });
  if (failures.length > 0) {
    throw new Error(
      `${label} has terminal geometry outside the visible viewport: ${JSON.stringify(failures)}`,
    );
  }
  const undersizedLiveSessions = evidence.visibleSessions.flatMap((id) => {
    if (!evidence.liveProviderSessions.includes(id)) return [];
    const source = evidence.diagnostics.terminalSnapshotGeometry[id];
    const viewport = evidence.diagnostics.terminalViewportGeometry[id];
    return terminalGeometryFitsViewport(source, viewport, { closeFit: true })
      ? []
      : [{ id, source, viewport }];
  });
  if (undersizedLiveSessions.length > 0) {
    throw new Error(
      `${label} has live terminals that do not fill their panes: ${JSON.stringify(undersizedLiveSessions)}`,
    );
  }
  return evidence.diagnostics;
}

async function capturePng(
  browser,
  baseUrl,
  scenario,
  outputPath,
  applicationBuild,
  providerMedia,
) {
  progress(`rendering PNG keyframe for ${scenario.id}`);
  const { context, page, pageErrors } = await preparePage(
    browser,
    baseUrl,
    scenario,
    applicationBuild,
  );
  try {
    await playTimeline(
      page,
      scenario,
      scenario.stillAtMs,
      performance.now(),
      {
        captureKind: "png",
        probeLiveSessions: providerMedia.probeLiveSessions,
      },
    );
    await repaintVisibleLiveTerminals(page, scenario);
    await assertExpectedRecoveryOverlays(page, scenario, `${scenario.id} PNG`);
    const diagnostics = await assertVisibleTerminalGeometryFits(
      page,
      `${scenario.id} PNG`,
    );
    await page.screenshot({
      path: outputPath,
      animations: "disabled",
    });
    progress(`wrote ${relative(repoRoot, outputPath)}`);
    throwPageErrors(pageErrors, scenario.id);
    return diagnostics;
  } finally {
    await closeCaptureContext(context, `${scenario.id} PNG`);
  }
}

async function closeCaptureContext(context, label, timeoutMs = 5_000) {
  let timeout;
  const timedOut = Symbol("capture-context-close-timeout");
  const result = await Promise.race([
    context.close().then(() => undefined),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(timedOut), timeoutMs);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
  if (result === timedOut) {
    progress(
      `${label} context close exceeded ${timeoutMs}ms; browser shutdown owns the remaining teardown`,
    );
  }
}

async function captureWebm(
  browser,
  baseUrl,
  scenario,
  outputPath,
  replayBySession,
  applicationBuild,
  providerMedia,
) {
  progress(`recording WebM timeline for ${scenario.id}`);
  const { context, page, pageErrors } = await preparePage(
    browser,
    baseUrl,
    scenario,
    applicationBuild,
  );
  const temporaryPath = `${outputPath}.partial.webm`;
  let recording = false;
  let recordingStartedAt;
  let finishRecording;
  let recoveryOverlayLedgerStarted = false;
  try {
    recoveryOverlayLedgerStarted = await startRecoveryOverlayLedger(
      page,
      scenario,
    );
    recordingStartedAt = performance.now();
    if (scenario.fixture.productTour) {
      finishRecording = await startLosslessScreencast(page, temporaryPath, scenario.viewport);
    } else {
      await page.screencast.start({
        path: temporaryPath,
        size: {
          width: scenario.viewport.width,
          height: scenario.viewport.height,
        },
      });
      finishRecording = () => page.screencast.stop();
    }
    recording = true;
    const startedAt = performance.now();
    const deadlineAt = startedAt + scenario.durationMs + 1_000;
    const [, publications] = await Promise.all([
      playTimeline(page, scenario, scenario.durationMs, startedAt, {
        captureKind: "webm",
        probeLiveSessions: providerMedia.probeLiveSessions,
      }),
      playLiveTerminalReplay(page, replayBySession, scenario.durationMs, {
        startedAt,
        deadlineAt,
      }),
    ]);
    const contentElapsedMs = Math.round(performance.now() - startedAt);
    if (performance.now() > deadlineAt) {
      throw new Error(
        `${scenario.id} exceeded its ${scenario.durationMs}ms recording timeline deadline (${contentElapsedMs}ms elapsed)`,
      );
    }
    recording = false;
    const encoding = await finishRecording();
    await assertExpectedRecoveryOverlays(page, scenario, `${scenario.id} WebM`);
    const diagnostics = await assertVisibleTerminalGeometryFits(
      page,
      `${scenario.id} WebM`,
    );
    await finishRecoveryOverlayLedger(
      page,
      scenario,
      `${scenario.id} WebM`,
      recoveryOverlayLedgerStarted,
    );
    recoveryOverlayLedgerStarted = false;
    const recordingElapsedMs = Math.round(
      performance.now() - recordingStartedAt,
    );
    await rename(temporaryPath, outputPath);
    progress(`wrote ${relative(repoRoot, outputPath)}`);
    throwPageErrors(pageErrors, scenario.id);
    return {
      diagnostics,
      publications,
      recording: {
        ...(encoding ? { encoding } : {}),
        requestedDurationMs: scenario.durationMs,
        contentElapsedMs,
        elapsedMs: recordingElapsedMs,
      },
    };
  } finally {
    if (recording) await finishRecording(false).catch(() => {});
    await rm(temporaryPath, { force: true });
    await closeCaptureContext(context, `${scenario.id} WebM`);
  }
}

async function captureScenarioGeneration(
  options,
  scenario,
  artifactPlan,
  outputDirectory,
  finalDirectory,
) {
  let providerMedia;
  let server;
  let url;
  let browser;
  const files = [];
  const temporaryFiles = new Set();
  let replayPublications = [];
  let recordingEvidence = null;
  let applicationBuild;
  let gifDerivative = null;
  let publicWebmDerivative = null;
  const captureDiagnostics = {};
  try {
    ({ server, url } = await startCaptureServer());
    applicationBuild = await readApplicationBuild(url);
    if (options.expectedApplicationBuild) {
      assertApplicationBuildUnchanged(
        options.expectedApplicationBuild,
        applicationBuild,
      );
    }
    progress("launching Chromium");
    browser = await chromium.launch({ headless: !options.headed });
    progress("Chromium ready");
    const terminalSizesBySession =
      options.providerSource === "live"
        ? await measureLiveTerminalSizes({
            baseUrl: url,
            browser,
            preparePage,
            progress,
            runAction,
            scenario,
            throwPageErrors,
            applicationBuild,
          })
        : undefined;
    providerMedia =
      options.providerSource === "live"
        ? await createLiveProviderMedia({
            scenario,
            requireLiveProviders: options.requireLiveProviders,
            progress,
            terminalSizesBySession,
          })
        : fixtureProviderMedia(scenario);
    if (artifactPlan.png) {
      const png = resolve(outputDirectory, `${scenario.id}.png`);
      captureDiagnostics.png = await capturePng(
        browser,
        url,
        providerMedia.stillScenario,
        png,
        applicationBuild,
        providerMedia,
      );
      files.push(png);
    }
    if (artifactPlan.webm) {
      const webm = resolve(outputDirectory, `${scenario.id}.webm`);
      const capture = await captureWebm(
        browser,
        url,
        providerMedia.videoScenario,
        webm,
        providerMedia.replayBySession,
        applicationBuild,
        providerMedia,
      );
      replayPublications = capture.publications;
      recordingEvidence = capture.recording;
      captureDiagnostics.webm = capture.diagnostics;
      files.push(webm);
      if (artifactPlan.gif || artifactPlan.publicWebm) {
        const sourceMetadata = await stat(webm);
        const sourceSha256 = await sha256(webm);
        const source = {
          path: relative(
            repoRoot,
            resolve(finalDirectory, `${scenario.id}.webm`),
          ),
          retained: true,
          bytes: sourceMetadata.size,
          sha256: sourceSha256,
        };
        if (artifactPlan.gif) {
          const gif = resolve(outputDirectory, `${scenario.id}.gif`);
          const temporaryGif = `${gif}.partial.gif`;
          temporaryFiles.add(temporaryGif);
          progress(`deriving README GIF for ${scenario.id}`);
          gifDerivative = {
            ...(await renderGifDerivative({
              inputPath: webm,
              outputPath: temporaryGif,
              scenario,
            })),
            source,
          };
          await rename(temporaryGif, gif);
          captureDiagnostics.gif = capture.diagnostics;
          files.push(gif);
          progress(`wrote ${relative(repoRoot, gif)}`);
        }
        if (artifactPlan.publicWebm) {
          const publicWebm = resolve(
            outputDirectory,
            `${scenario.id}.public.webm`,
          );
          const temporaryPublicWebm = `${publicWebm}.partial.webm`;
          temporaryFiles.add(temporaryPublicWebm);
          progress(`deriving public WebM for ${scenario.id}`);
          publicWebmDerivative = {
            ...(await renderPublicWebmDerivative({
              inputPath: webm,
              outputPath: temporaryPublicWebm,
              scenario,
            })),
            source,
          };
          await rename(temporaryPublicWebm, publicWebm);
          captureDiagnostics.publicWebm = capture.diagnostics;
          files.push(publicWebm);
          progress(`wrote ${relative(repoRoot, publicWebm)}`);
        }
        if ((await sha256(webm)) !== sourceSha256) {
          throw new Error(
            `${scenario.id} WebM changed during derivative generation`,
          );
        }
      }
    }
    assertApplicationBuildUnchanged(
      applicationBuild,
      await readApplicationBuild(url),
    );
  } finally {
    progress("closing capture runtime");
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          await providerMedia?.close();
        } finally {
          await Promise.all(
            [...temporaryFiles].map((path) => rm(path, { force: true })),
          );
        }
      }
    }
  }

  const artifacts = [];
  for (const path of files) {
    const metadata = await stat(path);
    const finalPath = resolve(finalDirectory, relative(outputDirectory, path));
    artifacts.push({
      path: relative(repoRoot, finalPath),
      bytes: metadata.size,
      sha256: await sha256(path),
    });
  }
  const manifestPath = resolve(outputDirectory, "manifest.json");
  const provenance = providerProvenance(providerMedia);
  const geometryEvidence = Object.fromEntries(
    Object.entries(captureDiagnostics).map(([format, diagnostics]) => {
      const source = diagnostics.terminalSnapshotGeometry ?? {};
      const viewport = diagnostics.terminalViewportGeometry ?? {};
      return [
        format,
        Object.fromEntries(
          [...new Set([...Object.keys(source), ...Object.keys(viewport)])].map(
            (id) => [
              id,
              {
                source: source[id] ?? null,
                viewport: viewport[id] ?? null,
              },
            ],
          ),
        ),
      ];
    }),
  );
  const interactionEvidence = captureInteractionEvidence(captureDiagnostics);
  const captureProof = captureProofManifest({
    captureSurface: "browser-client",
    continuityEvidence: providerMedia.continuityEvidence ?? [],
    providerSource: options.providerSource,
    scenario,
  });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: MEDIA_CAPTURE_SCHEMA_VERSION,
        scenario: scenario.id,
        clock: scenario.clock,
        applicationBuild,
        providerSource: options.providerSource,
        requestedFormat: options.format,
        ...provenance,
        liveReplay: {
          publishedFrames: replayPublications.length,
          deliveredFrames: replayPublications.filter(
            ({ consumers }) => consumers > 0,
          ).length,
          consumedFrames: replayPublications.filter(
            ({ rendered }) => rendered,
          ).length,
          sessions: [...new Set(replayPublications.map(({ id }) => id))],
          terminalGeometry: Object.fromEntries(
            replayPublications.map(
              ({ id, sourceGeometry, viewportGeometry }) => [
                id,
                { source: sourceGeometry, viewport: viewportGeometry },
              ],
            ),
          ),
        },
        captureProof,
        terminalGeometry: geometryEvidence,
        ...(interactionEvidence ? { interactionEvidence } : {}),
        recording: recordingEvidence,
        derivatives: {
          ...(gifDerivative ? { gif: gifDerivative } : {}),
          ...(publicWebmDerivative
            ? { publicWebm: publicWebmDerivative }
            : {}),
        },
        windowChrome: scenario.windowChrome,
        captureStage: scenario.captureStage,
        viewport: scenario.viewport,
        terminalPresentation: {
          fontSize: scenario.terminalFontSize ?? 11.5,
        },
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
  const promotion = await promoteCaptureGeneration({
    finalDirectory,
    stagingDirectory: outputDirectory,
  });
  if (promotion.cleanupPending) {
    progress(
      `committed ${scenario.id}; deferred previous-generation cleanup to the next run`,
    );
  }
  return {
    scenario: scenario.id,
    applicationBuild,
    outputDirectory: relative(repoRoot, finalDirectory),
    artifacts,
    manifest: relative(repoRoot, resolve(finalDirectory, "manifest.json")),
  };
}

export async function captureScenario(options, scenario) {
  if (captureProofNeedsNativeTauri(scenario)) {
    throw new Error(
      `${scenario.id} requires the owned real-Tauri native capture command`,
    );
  }
  assertBrowserCaptureProviderSource(options, scenario);
  assertSafeOutputRoot(options.outputRoot);
  const artifactPlan = captureArtifactPlan(options.format, scenario);
  await mkdir(options.outputRoot, { recursive: true });
  const { finalDirectory, stagingDirectory } = await createCaptureGeneration(
    options.outputRoot,
    scenario.id,
  );
  try {
    return await captureScenarioGeneration(
      options,
      scenario,
      artifactPlan,
      stagingDirectory,
      finalDirectory,
    );
  } finally {
    await discardCaptureGeneration(stagingDirectory);
  }
}
