import { TERMINAL_SURFACE_SELECTORS } from "./terminal-surface.mjs";

const RECOVERY_STAGE_KEY = "dure-media-session-recovery-stage-v1";

function visibleTextIncludes({ marker, selectors }) {
  return [...document.querySelectorAll(selectors.paintedViewport)].some((viewport) => {
    const bounds = viewport.getBoundingClientRect();
    return (
      bounds.width > 0 &&
      bounds.height > 0 &&
      viewport.textContent?.includes(marker)
    );
  });
}

export async function runSessionRecoveryAction(
  page,
  action,
  { afterReload } = {},
) {
  if (action.action === "openRecoveryTerminal") {
    await page.evaluate((step) => {
      const api = window.__DURE_DOCK__?.getDockview?.(step.desktopId);
      if (!api) {
        throw new Error(`capture recovery desktop is missing: ${step.desktopId}`);
      }
      window.__DURE_DOCK__.openHmuxStandaloneTerminalOn(
        api,
        step.sessionId,
        step.workspaceId,
        step.cwd,
      );
    }, action);
    await page.waitForFunction(
      ({ desktopId, sessionId, selectors }) => {
        const api = window.__DURE_DOCK__?.getDockview?.(desktopId);
        const panel = api?.getPanel(`term:${sessionId}`);
        return (
          panel?.group.element.querySelector(selectors.paintedViewport) !== null
        );
      },
      { ...action, selectors: TERMINAL_SURFACE_SELECTORS },
    );
    await page.waitForTimeout(400);
    await page.evaluate((step) => {
      const api = window.__DURE_DOCK__.getDockview(step.desktopId);
      for (const panel of [...api.panels]) {
        if (panel.id !== `term:${step.sessionId}`) panel.api.close();
      }
      const source = api.getPanel(`term:${step.sessionId}`);
      source?.api.setActive();
      window.__DURE_STORE__.getState().saveLayout(step.desktopId, api.toJSON());
    }, action);
    await page.waitForFunction(
      ({ desktopId, sessionId, selectors }) => {
        const api = window.__DURE_DOCK__?.getDockview?.(desktopId);
        return (
          api?.panels.length === 1 &&
          api.activePanel?.id === `term:${sessionId}` &&
          api.activePanel.group.element.querySelector(
            selectors.paintedViewport,
          ) !== null
        );
      },
      { ...action, selectors: TERMINAL_SURFACE_SELECTORS },
    );
    return true;
  }

  if (action.action === "reloadForSessionRecovery") {
    await page.waitForFunction(visibleTextIncludes, {
      marker: action.expectedBeforeMarker,
      selectors: TERMINAL_SURFACE_SELECTORS,
    });
    await page.evaluate(
      ({ panelId, recoveryStageKey }) => {
        const persisted = localStorage.getItem("agent-ide");
        if (!persisted?.includes(panelId)) {
          throw new Error(`capture recovery layout was not durable: ${panelId}`);
        }
        sessionStorage.setItem(recoveryStageKey, "stale");
      },
      { ...action, recoveryStageKey: RECOVERY_STAGE_KEY },
    );
    await page.reload({ waitUntil: "networkidle" });
    if (typeof afterReload !== "function") {
      throw new Error("capture recovery reload hook is missing");
    }
    await afterReload();
    await page.waitForFunction(
      ({ desktopId, panelId }) => {
        const api = window.__DURE_DOCK__?.getDockview?.(desktopId);
        const recoveryStage =
          window.__DURE_MEDIA_CAPTURE_MOCK__?.diagnostics?.().recoveryStage;
        return (
          api?.getPanel(panelId) !== undefined &&
          recoveryStage === "stale"
        );
      },
      action,
      { timeout: 10_000 },
    );
    return true;
  }

  if (action.action === "openSessionRecovery") {
    await page
      .getByRole("button", { name: "Sessions", exact: true })
      .click();
    const search = page.getByPlaceholder("Search session name, ID, or folder");
    await search.waitFor();
    await search.fill(action.sessionName);
    await page
      .getByRole("button", {
        name: `Restore verified shell: ${action.sessionName}`,
      })
      .waitFor({ timeout: 10_000 });
    return true;
  }

  if (action.action === "confirmSessionRecovery") {
    await page
      .getByRole("button", {
        name: `Restore verified shell: ${action.sessionName}`,
      })
      .click();
    await page.waitForFunction(
      ({
        sourceSessionId,
        replacementSessionId,
        workspaceId,
        expectedAfterMarker,
        recoveryStageKey,
        selectors,
      }) => {
        const state = window.__DURE_STORE__?.getState?.();
        const api = state?.activeDesktopId
          ? window.__DURE_DOCK__?.getDockview?.(state.activeDesktopId)
          : undefined;
        const panel = api?.getPanel(`term:${sourceSessionId}`);
        const binding = panel?.params?.binding;
        const markerVisible = [
          ...document.querySelectorAll(selectors.paintedViewport),
        ].some((viewport) => {
          const bounds = viewport.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            viewport.textContent?.includes(expectedAfterMarker)
          );
        });
        return (
          sessionStorage.getItem(recoveryStageKey) === "restored" &&
          binding?.sessionId === replacementSessionId &&
          binding?.workspaceId === workspaceId &&
          document.querySelectorAll('[data-testid="hmux-recovery-overlay"]')
            .length === 0 &&
          markerVisible
        );
      },
      {
        ...action,
        recoveryStageKey: RECOVERY_STAGE_KEY,
        selectors: TERMINAL_SURFACE_SELECTORS,
      },
      { timeout: 15_000 },
    );
    return true;
  }

  if (action.action === "showRecoveredTerminal") {
    await page
      .getByRole("button", { name: "Sessions", exact: true })
      .click();
    await page.waitForFunction(
      ({ desktopId, replacementSessionId, expectedMarker, selectors }) => {
        const api = window.__DURE_DOCK__?.getDockview?.(desktopId);
        const host = document.querySelector(
          `[data-dure-media-session-id="${replacementSessionId}"]`,
        );
        const markerVisible = [
          ...document.querySelectorAll(selectors.paintedViewport),
        ].some((viewport) => {
          const bounds = viewport.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            viewport.textContent?.includes(expectedMarker)
          );
        });
        return (
          api?.activePanel?.id.startsWith("term:") &&
          host instanceof HTMLElement &&
          host.getBoundingClientRect().width > 0 &&
          markerVisible
        );
      },
      { ...action, selectors: TERMINAL_SURFACE_SELECTORS },
    );
    return true;
  }

  return false;
}

export { RECOVERY_STAGE_KEY };
