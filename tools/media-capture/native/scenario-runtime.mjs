import { mediaBackendCapabilities } from "../runtime/backend-capabilities.mjs";
import { captureInterfacePreferences } from "../runtime/interface-preferences.mjs";
import {
  TERMINAL_SURFACE_SELECTORS,
  terminalSurfaceIsPresentable,
  terminalSurfaceReadiness,
} from "../runtime/terminal-surface.mjs";
import { createNativeWindowBridgeClient } from "./window-bridge.mjs";

function waitFor(read, description, timeoutMs = 15_000) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = read();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error(`timed out waiting for ${description}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function waitForNativeReplayConsumer(id, mock) {
  return waitFor(
    () => {
      const host = [
        ...document.querySelectorAll("[data-dure-media-session-id]"),
      ].find((candidate) => candidate.dataset.dureMediaSessionId === id);
      if (!presentableTerminalHost(host, { requireVisibleText: false })) {
        return null;
      }
      const diagnostics = mock.diagnostics();
      const hmuxConsumerCount = Object.values(
        diagnostics.hmuxClientSessions ?? {},
      ).filter((sessionId) => sessionId === id).length;
      if (hmuxConsumerCount > 0) {
        return { consumerCount: hmuxConsumerCount, kind: "hmux" };
      }
      const legacyConsumerCount = diagnostics.outputConsumers[id] ?? 0;
      return legacyConsumerCount > 0
        ? { consumerCount: legacyConsumerCount, kind: "legacy" }
        : null;
    },
    `native terminal replay consumer ${id}`,
    5_000,
  );
}

export async function playNativeTerminalReplay(
  steps,
  {
    initialDelayMs = 750,
    mock = window.__DURE_MEDIA_CAPTURE_MOCK__,
    now = () => performance.now(),
    startedAtMs,
    wait = (delayMs) =>
      new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
    waitForConsumer = (id) => waitForNativeReplayConsumer(id, mock),
  } = {},
) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const startedAt = startedAtMs ?? now();
  const publications = [];
  const groups = [];
  for (const step of steps) {
    const group = groups.at(-1);
    if (group?.atMs === step.atMs) group.steps.push(step);
    else groups.push({ atMs: step.atMs, steps: [step] });
  }
  for (const group of groups) {
    const remaining = initialDelayMs + group.atMs - (now() - startedAt);
    if (remaining > 0) await wait(remaining);
    const rendered = await Promise.all(
      group.steps.map(async (step) => {
        const transport = await waitForConsumer(step.id);
        const renderProbe = mock.beginTerminalRenderProbe(step.id);
        try {
          const publication = mock.publishTerminalSnapshot(step);
          if (transport.kind === "hmux") {
            const repaint = mock.repaintHmuxTerminal(step.id);
            if (repaint.observerIds.length === 0) {
              throw new Error(`native terminal ${step.id} lost every Hmux observer`);
            }
          } else {
            if (publication.consumerIds.length === 0) {
              throw new Error(`native terminal ${step.id} lost every consumer`);
            }
            await mock.waitForTerminalSnapshotResume({
              id: step.id,
              endOffset: publication.endOffset,
              consumerIds: publication.consumerIds,
              renderProbe,
              timeoutMs: 1_500,
            });
          }
          await mock.waitForTerminalRender(renderProbe, 1_500);
          return {
            atMs: step.atMs,
            consumerCount: transport.consumerCount,
            id: step.id,
            sequenceThrough: step.sequenceThrough,
            transport: transport.kind,
          };
        } catch (error) {
          mock.cancelTerminalRenderProbe(renderProbe);
          throw error;
        }
      }),
    );
    publications.push(...rendered);
  }
  return publications;
}

export function nativeScenarioTimelineActions(scenario) {
  return scenario.nativeSessionWindowAgentId ? (scenario.timeline ?? []) : [];
}

export function nativeScenarioTimelineForSurface(
  scenario,
  { desktopId, surface },
) {
  return nativeScenarioTimelineActions(scenario).filter(
    (action) =>
      action.desktopId === desktopId &&
      (action.surface ?? "desktop") === surface,
  );
}

export async function playNativeScenarioTimeline(
  scenario,
  identity,
  {
    execute = runNativeScenarioAction,
    now = () => performance.now(),
    startedAtMs,
    wait = (delayMs) =>
      new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
  } = {},
) {
  const actions = nativeScenarioTimelineForSurface(scenario, identity);
  if (actions.length === 0) return [];
  const startedAt = startedAtMs ?? now();
  const completed = [];
  for (const action of actions) {
    const remaining = action.atMs - (now() - startedAt);
    if (remaining > 0) await wait(remaining);
    await execute(action);
    completed.push({ action: action.action, atMs: action.atMs });
  }
  return completed;
}

export async function waitForNativeTerminalReplayStart(
  { controlUrl, proof },
  {
    request = (url) => fetch(url, { cache: "no-store" }),
    wait = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
    timeoutMs = 30_000,
  } = {},
) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const response = await request(controlUrl);
      if (response.ok) {
        const receipt = await response.json();
        if (
          receipt?.schemaVersion === 2 &&
          receipt.proof === proof &&
          Number.isFinite(receipt.startedAtUnixMs)
        ) {
          return receipt;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await wait(25);
  }
  throw new Error(`timed out waiting for native replay start: ${String(lastError)}`);
}

function terminalGeometry(scenario, provider, sessionId) {
  return (
    scenario.liveSessionTerminalSizes?.[sessionId] ??
    scenario.liveProviderTerminalSizes?.[provider] ??
    scenario.liveTerminalSize ?? { columns: 52, rows: 15 }
  );
}

function presentableTerminalHost(host, { requireVisibleText = true } = {}) {
  return terminalSurfaceIsPresentable(
    host,
    TERMINAL_SURFACE_SELECTORS,
    { requireVisibleText },
  );
}

export function expectedNativeTerminalSurfaceCount(
  scenario,
  { desktopId, surface },
) {
  if (surface === "session") return 1;
  const declaredScreens = scenario.setup.filter(
    (action) =>
      action.desktopId === desktopId &&
      (action.action === "openAgent" || action.action === "openTerminal"),
  ).length;
  // Dockview keeps inactive tab content unmounted. Two visible terminal
  // surfaces preserve the desktop-grid readiness proof without requiring every
  // declared tab in the DOM at once; a one-pane scenario still requires one.
  return Math.max(1, Math.min(2, declaredScreens));
}

export function expectedNativeTerminalSessionIds(
  scenario,
  { desktopId, surface },
) {
  if (surface === "session") {
    const agent = scenario.fixture.agents.find(
      (candidate) => candidate.id === scenario.nativeSessionWindowAgentId,
    );
    return agent?.sessionId ? [agent.sessionId] : [];
  }
  if (surface !== "desktop") return [];
  return scenario.setup
    .filter(
      (action) =>
        action.action === "openAgent" && action.desktopId === desktopId,
    )
    .map((action) =>
      scenario.fixture.agents.find(
        (candidate) => candidate.id === action.agentId,
      ),
    )
    .filter((candidate) => candidate?.sessionId)
    .map((candidate) => candidate.sessionId);
}

export function nativeTerminalReplayStepsForSurface(
  scenario,
  { desktopId, surface },
) {
  const sessionIds = new Set(
    expectedNativeTerminalSessionIds(scenario, { desktopId, surface }),
  );
  const handedOffAt = new Map(
    (scenario.timeline ?? [])
      .filter(
        (action) =>
          action.action === "openSessionWindow" &&
          action.desktopId === desktopId,
      )
      .map((action) => {
        const agent = scenario.fixture.agents.find(
          (candidate) => candidate.id === action.agentId,
        );
        return [agent?.sessionId, action.atMs];
      })
      .filter(([sessionId]) => sessionId),
  );
  return (scenario.nativeTerminalReplay?.steps ?? []).filter((step) => {
    if (!sessionIds.has(step.id)) return false;
    const boundary = handedOffAt.get(step.id);
    return surface !== "desktop" || boundary === undefined || step.atMs < boundary;
  });
}

export function installNativeMediaFixtureConfig({
  applicationBuild,
  proof,
  scenario,
  surface = "desktop",
  windowLabel,
}) {
  const NativeDate = Date;
  const captureEpochMs = Date.parse(scenario.clock);
  const captureStartedAt = performance.now();
  const captureNow = () => captureEpochMs + (performance.now() - captureStartedAt);
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

  const defaultSnapshotGeometry = Object.fromEntries(
    Object.keys(scenario.fixture.terminalSnapshots ?? {}).map((sessionId) => {
      const provider = scenario.fixture.agents.find(
        (agent) => agent.sessionId === sessionId,
      )?.provider;
      return [sessionId, terminalGeometry(scenario, provider, sessionId)];
    }),
  );
  window.__DURE_MEDIA_CAPTURE_CONFIG__ = {
    schemaVersion: scenario.schemaVersion,
    scenarioId: scenario.id,
    captureSurface: surface,
    windowLabel,
    backendCapabilities: mediaBackendCapabilities({
      buildId: applicationBuild.buildId,
      name: "dure-native-media-fixture",
      runtimeFingerprint: applicationBuild.backendRuntimeFingerprint,
    }),
    nativeWindowBridge: scenario.nativeSessionWindowAgentId ? { proof } : null,
    terminalSurfaceSelectors: TERMINAL_SURFACE_SELECTORS,
    fixture: {
      agents: scenario.fixture.agents,
      providerConversations: scenario.fixture.providerConversations ?? [],
      diffBadges: scenario.fixture.diffBadges,
      diffReviews: scenario.fixture.diffReviews,
      gitStatuses: scenario.fixture.gitStatuses,
      terminalScreensByCwd: scenario.fixture.terminalScreensByCwd,
      terminalSnapshots: scenario.fixture.terminalSnapshots,
      terminalSnapshotGeometry: {
        ...defaultSnapshotGeometry,
        ...(scenario.fixture.terminalSnapshotGeometry ?? {}),
      },
      fixedTerminalSnapshotIds: Object.keys(
        scenario.fixture.terminalSnapshotGeometry ?? {},
      ),
    },
    liveProviderSessionIds: scenario.liveProviderSessionIds ?? [],
    windowChrome: { platform: "macos", fullscreen: false },
  };
  window.__DURE_MEDIA_CAPTURE_NATIVE_WINDOW_BRIDGE__ =
    scenario.nativeSessionWindowAgentId
      ? createNativeWindowBridgeClient({ proof })
      : null;
  localStorage.clear();
  localStorage.setItem(
    "agent-ide-main-window-sidebar",
    JSON.stringify({ state: { open: true, width: 300, tab: "spaces" }, version: 1 }),
  );
}

export async function applyNativeMediaFixture(
  scenario,
  { desktopId, surface = "desktop" },
) {
  const [{ useDiffBadges }, { useAgentAttention }] = await Promise.all([
    import("/src/lib/scm/status/diffBadgesStore.ts"),
    import("/src/lib/agents/agentAttentionStore.ts"),
  ]);
  const store = window.__DURE_STORE__;
  const current = store.getState();
  const fixture = scenario.fixture;
  if (!fixture.desktops.some((desktop) => desktop.id === desktopId)) {
    throw new Error(`native media desktop is missing: ${desktopId}`);
  }
  store.setState({
    desktops: fixture.desktops,
    activeDesktopId: desktopId,
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
    terminalFontSize: scenario.terminalFontSize ?? 11.5,
    uiPrefs: {
      ...current.uiPrefs,
      ...captureInterfacePreferences(scenario),
      theme: "dark",
      onboardingDismissed: true,
      showClaudeUsage: false,
      showCodexUsage: false,
      paneInactiveOpacity: 0.92,
    },
    terminalPrefs: { ...current.terminalPrefs, gpu: "off" },
    stats: {
      agentsStarted: 18,
      prsCreated: 7,
      activeMs: 28_800_000,
      since: Date.parse(scenario.clock) - 86_400_000,
    },
  });
  useDiffBadges.setState({ badges: fixture.diffBadges ?? {} });
  useAgentAttention.setState({ displayStates: fixture.agentDisplayStates ?? {} });
  document.documentElement.dataset.dureMediaCapture = scenario.id;
  document.documentElement.dataset.captureSchema = String(scenario.schemaVersion);
  document.documentElement.dataset.dureMediaSurface = surface;
  document.documentElement.style.backgroundColor = "#0b0e14";

  if (surface === "desktop") {
    await waitFor(
      () =>
        store.getState().activeDesktopId === desktopId &&
        window.__DURE_DOCK__?.getDockview?.(desktopId),
      `native media desktop ${desktopId}`,
    );
    for (const action of scenario.setup.filter(
      (candidate) => candidate.desktopId === desktopId,
    )) {
      await runNativeScenarioAction(action);
    }
  } else if (surface !== "session") {
    throw new Error(`native media surface is unsupported: ${surface}`);
  }
  store.setState({
    sessionActivity: Object.fromEntries(
      fixture.agents.map((agent) => [
        agent.sessionId,
        { text: agent.name, at: Date.parse(scenario.clock) },
      ]),
    ),
  });
  const expectedScreens = expectedNativeTerminalSurfaceCount(scenario, {
    desktopId,
    surface,
  });
  const expectedSessionIds = expectedNativeTerminalSessionIds(scenario, {
    desktopId,
    surface,
  });
  const replayStartsFromBlankProjection =
    (scenario.nativeTerminalReplay?.steps?.length ?? 0) > 0;
  const readHosts = () => [
    ...document.querySelectorAll(TERMINAL_SURFACE_SELECTORS.host),
  ];
  const readinessOptions = {
    requireVisibleText: !replayStartsFromBlankProjection,
  };
  try {
    await waitFor(
      () => {
        const hosts = readHosts();
        const isReady = (host) =>
          presentableTerminalHost(host, readinessOptions);
        if (expectedSessionIds.length > 0) {
          return expectedSessionIds.every((sessionId) =>
            hosts.some(
              (host) =>
                host.dataset.dureMediaSessionId === sessionId &&
                isReady(host),
            ),
          );
        }
        return hosts.filter(isReady).length >= expectedScreens;
      },
      `presentable ${surface} terminal surface for ${desktopId}`,
    );
  } catch (error) {
    const hosts = readHosts().slice(0, 8).map((host) => {
      const readiness = terminalSurfaceReadiness(
        host,
        TERMINAL_SURFACE_SELECTORS,
        readinessOptions,
      );
      const diagnostics = readiness.surface;
      return {
        sessionId: host.dataset.dureMediaSessionId ?? null,
        reasons: readiness.reasons,
        failureText:
          diagnostics && !diagnostics.painted
            ? (host.textContent?.trim().slice(0, 512) || null)
            : null,
        projectionRevision: diagnostics?.projectionRevision ?? null,
        geometry: diagnostics
          ? {
              columns: diagnostics.canonicalColumns,
              rows: diagnostics.viewportRows,
              width: diagnostics.width,
              height: diagnostics.height,
            }
          : null,
      };
    });
    const transport = window.__DURE_MEDIA_CAPTURE_MOCK__?.diagnostics?.();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}; terminal readiness ${JSON.stringify({
        expectedScreens,
        expectedSessionIds,
        hosts,
        transport: transport
          ? {
              commandCounts: transport.commandCounts,
              hmuxClientSessions: transport.hmuxClientSessions,
              terminalViewportGeometry: transport.terminalViewportGeometry,
            }
          : null,
      })}`,
      { cause: error },
    );
  }
  document.documentElement.dataset.captureReady = "true";
}

export async function runNativeScenarioAction(action) {
  const store = window.__DURE_STORE__;
  const dock = window.__DURE_DOCK__;
  const api = dock?.getDockview?.(action.desktopId);
  if (!api && action.action !== "toggleWindowMaximize") {
    throw new Error(`native media desktop is not mounted: ${action.desktopId}`);
  }
  if (action.action === "activateDesktop") {
    store.setState({ activeDesktopId: action.desktopId });
  } else if (action.action === "openAgent") {
    const agent = store
      .getState()
      .agents.find((candidate) => candidate.id === action.agentId);
    if (!agent) throw new Error(`native media agent is missing: ${action.agentId}`);
    if (action.relativeToAgentId) {
      dock.openAgentPanel(action.desktopId, agent, {
        referencePanel: `agent:${action.relativeToAgentId}`,
        direction: action.direction,
      });
    } else {
      dock.openAgentPanelOnDesktop(action.desktopId, agent);
    }
    await waitFor(
      () => api.getPanel(`agent:${action.agentId}`),
      `native media agent ${action.agentId}`,
    );
    if (action.replaceDefaultTerminal) {
      for (const panel of [...api.panels]) {
        if (panel.id.startsWith("term:")) panel.api.close();
      }
      await waitFor(
        () => api.panels.every((panel) => !panel.id.startsWith("term:")),
        `default terminal retirement for ${action.desktopId}`,
      );
    }
  } else if (action.action === "openTerminal") {
    const referencePanel = api.panels.find((panel) => panel.id.startsWith("term:"));
    const before = api.panels.filter((panel) => panel.id.startsWith("term:")).length;
    const sessionId = dock.openLocalTerminalOn(
      api,
      action.cwd,
      referencePanel
        ? { referencePanel: referencePanel.id, direction: action.direction }
        : undefined,
    );
    window.__DURE_MEDIA_CAPTURE_MOCK__.registerTerminalCwd(sessionId, action.cwd);
    await waitFor(
      () => api.panels.filter((panel) => panel.id.startsWith("term:")).length > before,
      `native media terminal ${action.cwd}`,
    );
  } else if (action.action === "openSessionWindow") {
    const agent = store
      .getState()
      .agents.find((candidate) => candidate.id === action.agentId);
    if (!agent) {
      throw new Error(`native media agent is missing: ${action.agentId}`);
    }
    const button = await waitFor(
      () => {
        const chrome = [...document.querySelectorAll(".pane-chrome")].find(
          (candidate) =>
            candidate
              .querySelector("[data-pane-title]")
              ?.textContent?.trim() === agent.name,
        );
        return chrome?.querySelector("[data-pane-window-action]");
      },
      `native media session tile ${action.agentId}`,
    );
    const bridge = await waitFor(
      () =>
        window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics().nativeWindowBridge,
      "native media window bridge",
    );
    const createCommand = "plugin:webview|create_webview_window";
    const focusCommand = "plugin:window|set_focus";
    const createdBefore = bridge?.completedCounts?.[createCommand] ?? 0;
    const focusedBefore = bridge?.completedCounts?.[focusCommand] ?? 0;
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`native media session tile is invalid: ${action.agentId}`);
    }
    button.click();
    await waitFor(
      () => {
        const current =
          window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics().nativeWindowBridge;
        const creation = current?.lastResults?.[createCommand];
        return (
          current?.completedCounts?.[createCommand] > createdBefore &&
          current?.completedCounts?.[focusCommand] > focusedBefore &&
          creation?.state === "created" &&
          creation.requestKind === "agent-session-window-v1"
        );
      },
      `native media session window ${action.agentId}`,
    );
  } else if (action.action === "toggleWindowMaximize") {
    const header = document.querySelector("header[data-tauri-drag-region]");
    const command = "toggle_window_maximize_atomic";
    const bridge =
      window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics().nativeWindowBridge;
    const completedBefore = bridge?.completedCounts?.[command] ?? 0;
    if (!(header instanceof HTMLElement) || !bridge) {
      throw new Error("native media session window chrome is missing");
    }
    header.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        detail: 2,
      }),
    );
    await waitFor(
      () => {
        const current =
          window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics().nativeWindowBridge;
        return (
          current?.completedCounts?.[command] > completedBefore &&
          current?.lastResults?.[command]?.maximized === action.maximized
        );
      },
      `native media session maximize=${action.maximized}`,
    );
  } else if (action.action === "openDiff") {
    const agent = store
      .getState()
      .agents.find((candidate) => candidate.id === action.agentId);
    const review =
      window.__DURE_MEDIA_CAPTURE_CONFIG__.fixture.diffReviews[action.agentId];
    if (!agent || !review) {
      throw new Error(`native media diff evidence is missing: ${action.agentId}`);
    }
    dock.openDiffPanel(action.desktopId, agent.id, agent.name);
    const totals = review.files.reduce(
      (sum, file) => ({
        added: sum.added + file.added,
        deleted: sum.deleted + file.deleted,
      }),
      { added: 0, deleted: 0 },
    );
    await waitFor(
      () => {
        const text = document.body.innerText;
        return (
          api.getPanel(`diff:${agent.id}`) &&
          text.includes(`${review.baseRef} @`) &&
          text.includes(`+${totals.added}`) &&
          text.includes(`−${totals.deleted}`) &&
          text.includes(`All files (${review.files.length})`)
        );
      },
      `native media diff ${agent.id}`,
    );
  } else {
    throw new Error(`native media action is unsupported: ${action.action}`);
  }
  if (api) store.getState().saveLayout(action.desktopId, api.toJSON());
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
}

export function nativeCenterHitTest() {
  const element = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  if (!element || !document.body.contains(element)) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}
