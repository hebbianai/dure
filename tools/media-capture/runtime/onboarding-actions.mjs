import { TERMINAL_SURFACE_SELECTORS } from "./terminal-surface.mjs";

async function describeTerminalReadiness(page) {
  return page.evaluate((selectors) => {
    const state = window.__DURE_STORE__?.getState?.();
    const activeDesktop = state?.activeDesktopId
      ? document.getElementById(`desktop-panel-${state.activeDesktopId}`)
      : null;
    const describeElement = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        classes: [...element.classList],
        bounds: {
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        },
        display: style.display,
        visibility: style.visibility,
        sessionId: element.dataset.dureMediaSessionId,
      };
    };
    const mock = window.__DURE_MEDIA_CAPTURE_MOCK__?.diagnostics?.();
    return {
      activeDesktopId: state?.activeDesktopId,
      agentIds: state?.agents.map((agent) => agent.id) ?? [],
      panelIds:
        window.__DURE_DOCK__
          ?.getDockview?.(state?.activeDesktopId)
          ?.panels.map((panel) => panel.id) ?? [],
      hosts: [...(activeDesktop?.querySelectorAll(".terminal-host") ?? [])].map(
        describeElement,
      ),
      viewports: [
        ...(activeDesktop?.querySelectorAll(selectors.viewport) ?? []),
      ].map(describeElement),
      overlays: [
        ...document.querySelectorAll('[data-testid="hmux-recovery-overlay"]'),
      ].map((overlay) => overlay.textContent?.trim()),
      mock: mock
        ? {
            commandCounts: mock.commandCounts,
            terminalSnapshotGeometry: mock.terminalSnapshotGeometry,
            terminalViewportGeometry: mock.terminalViewportGeometry,
            hmuxClientSessions: mock.hmuxClientSessions,
            recentHmuxConnectionDiagnostics:
              mock.hmuxConnectionDiagnostics?.slice(-12),
          }
        : undefined,
    };
  }, TERMINAL_SURFACE_SELECTORS);
}

export async function runOnboardingAction(page, action) {
  if (action.action === "openOnboarding") {
    await page.waitForFunction(() => {
      if (document.querySelector("[data-onboarding-import-action-bar]")) return true;
      return [...document.querySelectorAll("button")].some(
        (button) =>
          button.textContent?.trim() === "Open the getting-started guide",
      );
    });
    await page.evaluate(() => {
      if (document.querySelector("[data-onboarding-import-action-bar]")) return;
      const button = [...document.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent?.trim() === "Open the getting-started guide",
      );
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("capture onboarding entry action is missing");
      }
      button.click();
    });
    await page.waitForFunction(
      (expectedDesktopCount) =>
        document.querySelector("[data-onboarding-import-action-bar]") !== null &&
        document.querySelectorAll("[data-import-desktop-id]").length ===
          expectedDesktopCount,
      action.expectedDesktopCount,
    );
    return true;
  }
  if (action.action === "renameOnboardingDesktop") {
    await page.evaluate(({ desktopIndex, name }) => {
      const card = document.querySelectorAll("[data-import-desktop-id]")[
        desktopIndex
      ];
      const input = card?.querySelector('input[aria-label="Desktop name"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error(`capture onboarding desktop ${desktopIndex} is missing`);
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!setter) throw new Error("capture onboarding input setter is missing");
      setter.call(input, name);
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, action);
    await page.waitForFunction(
      ({ desktopIndex, name }) => {
        const card = document.querySelectorAll("[data-import-desktop-id]")[
          desktopIndex
        ];
        return card?.querySelector('input[aria-label="Desktop name"]')?.value === name;
      },
      action,
    );
    return true;
  }
  if (action.action === "moveOnboardingPane") {
    const counts = await page.evaluate(({ fromDesktopIndex, toDesktopIndex }) => {
      const cards = document.querySelectorAll("[data-import-desktop-id]");
      const source = cards[fromDesktopIndex]?.querySelector("[data-layout-cell]");
      if (!(source instanceof HTMLElement) || !cards[toDesktopIndex]) {
        throw new Error("capture onboarding pane move endpoints are missing");
      }
      const transfer = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      window.__DURE_MEDIA_ONBOARDING_DRAG__ = { source, transfer };
      return {
        fromBefore: cards[fromDesktopIndex].querySelectorAll("[data-layout-cell]")
          .length,
        toBefore: cards[toDesktopIndex].querySelectorAll("[data-layout-cell]")
          .length,
      };
    }, action);
    await page.waitForTimeout(100);
    await page.evaluate(({ toDesktopIndex }) => {
      const cards = document.querySelectorAll("[data-import-desktop-id]");
      const drag = window.__DURE_MEDIA_ONBOARDING_DRAG__;
      const target = cards[toDesktopIndex];
      if (!drag || !(target instanceof HTMLElement)) {
        throw new Error("capture onboarding drag state is missing");
      }
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: drag.transfer,
          }),
        );
      }
      drag.source.dispatchEvent(
        new DragEvent("dragend", {
          bubbles: true,
          dataTransfer: drag.transfer,
        }),
      );
      delete window.__DURE_MEDIA_ONBOARDING_DRAG__;
    }, action);
    await page.waitForFunction(
      ({ action: move, counts: before }) => {
        const cards = document.querySelectorAll("[data-import-desktop-id]");
        return (
          cards[move.fromDesktopIndex]?.querySelectorAll("[data-layout-cell]")
            .length ===
            before.fromBefore - 1 &&
          cards[move.toDesktopIndex]?.querySelectorAll("[data-layout-cell]")
            .length ===
            before.toBefore + 1
        );
      },
      { action, counts },
    );
    return true;
  }
  if (action.action === "confirmOnboarding") {
    await page.evaluate(() => {
      const actionBar = document.querySelector(
        "[data-onboarding-import-action-bar]",
      );
      const button = actionBar?.querySelector("[data-onboarding-import-apply]");
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        throw new Error("capture onboarding confirmation is unavailable");
      }
      button.click();
    });
    await page.waitForFunction(
      (expectedPaneCount) => {
        const state = window.__DURE_STORE__?.getState?.();
        const api = state?.activeDesktopId
          ? window.__DURE_DOCK__?.getDockview?.(state.activeDesktopId)
          : undefined;
        return (
          state?.agents.length === expectedPaneCount &&
          api?.panels.filter((panel) => panel.id.startsWith("agent:")).length ===
            expectedPaneCount
        );
      },
      action.expectedPaneCount,
      { timeout: 10_000 },
    );
    try {
      await page.waitForFunction(
        ({ expectedPaneCount, selectors }) => {
          const state = window.__DURE_STORE__?.getState?.();
          const activeDesktop = state?.activeDesktopId
            ? document.getElementById(`desktop-panel-${state.activeDesktopId}`)
            : null;
          if (!activeDesktop) return false;
          const hosts = [...activeDesktop.querySelectorAll(".terminal-host")];
          const visibleViewports = [
            ...activeDesktop.querySelectorAll(selectors.paintedViewport),
          ].filter((viewport) => {
            const bounds = viewport.getBoundingClientRect();
            const style = getComputedStyle(viewport);
            return (
              bounds.width > 0 &&
              bounds.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          });
          return (
            hosts.length === expectedPaneCount &&
            visibleViewports.length === expectedPaneCount &&
            hosts.every(
              (host) =>
                !host.classList.contains("terminal-hydrating") &&
                !host.classList.contains("terminal-fit-settling"),
            )
          );
        },
        {
          expectedPaneCount: action.expectedPaneCount,
          selectors: TERMINAL_SURFACE_SELECTORS,
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      const diagnostics = await describeTerminalReadiness(page);
      throw new Error(
        `onboarding terminals did not become capture-ready: ${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    const panelMarkers = await page.evaluate((markers) => {
      const state = window.__DURE_STORE__?.getState?.();
      return state.agents.map((agent, index) => ({
        panelId: `agent:${agent.id}`,
        marker: markers[index],
      }));
    }, action.expectedTerminalMarkers);
    for (const { panelId, marker } of panelMarkers) {
      await page.waitForFunction(
        ({ targetPanelId, expectedMarker, selectors }) => {
          const state = window.__DURE_STORE__?.getState?.();
          const api = state?.activeDesktopId
            ? window.__DURE_DOCK__?.getDockview?.(state.activeDesktopId)
            : undefined;
          const panel = api?.getPanel(targetPanelId);
          const host = panel?.group.element.querySelector(".terminal-host");
          return (
            !host?.classList.contains("terminal-hydrating") &&
            panel?.group.element
              .querySelector(selectors.paintedViewport)
              ?.textContent?.includes(expectedMarker)
          );
        },
        {
          targetPanelId: panelId,
          expectedMarker: marker,
          selectors: TERMINAL_SURFACE_SELECTORS,
        },
        { timeout: 10_000 },
      );
    }
    await page.evaluate(() => {
      const state = window.__DURE_STORE__?.getState?.();
      const activeDesktop = state?.activeDesktopId
        ? document.getElementById(`desktop-panel-${state.activeDesktopId}`)
        : null;
      const mock = window.__DURE_MEDIA_CAPTURE_MOCK__;
      for (const host of activeDesktop?.querySelectorAll(
        "[data-dure-media-session-id]",
      ) ?? []) {
        mock.repaintHmuxTerminal(host.dataset.dureMediaSessionId);
      }
    });
    await page.waitForFunction(
      ({ expected, selectors }) => {
        const text = [...document.querySelectorAll(selectors.paintedViewport)]
          .map((viewport) => viewport.textContent ?? "")
          .join("\n");
        return expected.every(
          (marker) => text.split(marker).length - 1 === 1,
        );
      },
      {
        expected: action.expectedTerminalMarkers,
        selectors: TERMINAL_SURFACE_SELECTORS,
      },
      { timeout: 5_000 },
    );
    await page.evaluate(() => {
      const state = window.__DURE_STORE__?.getState?.();
      for (const agent of state.agents) {
        state.setAgentActivity(agent.id, "waiting");
      }
    });
    await page.waitForTimeout(750);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="hmux-recovery-overlay"]')
          .length === 0,
      undefined,
      { timeout: 5_000 },
    );
    return true;
  }
  return false;
}
