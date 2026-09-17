const CLIENT_RECONNECT_STAGE_KEY = "dure-media-client-reconnect-stage-v1";

async function waitForConnectedPane(page, action) {
  try {
    await page.waitForFunction(
      ({ desktopId, panelId, sessionId }) => {
        const api = window.__DURE_DOCK__?.getDockview?.(desktopId);
        const host = [
          ...document.querySelectorAll("[data-dure-media-session-id]"),
        ].find(
          (candidate) => candidate.dataset.dureMediaSessionId === sessionId,
        );
        const bounds = host?.getBoundingClientRect();
        const consumers =
          window.__DURE_MEDIA_CAPTURE_MOCK__?.terminalConsumerCount?.(
            sessionId,
          ) ?? 0;
        return Boolean(
          api?.getPanel(panelId) &&
            host &&
            bounds &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            consumers > 0 &&
            document.querySelectorAll('[data-testid="hmux-recovery-overlay"]')
              .length === 0,
        );
      },
      action,
      { timeout: 10_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(
      ({ desktopId, panelId, sessionId }) => {
        const api = window.__DURE_DOCK__?.getDockview?.(desktopId);
        const mock = window.__DURE_MEDIA_CAPTURE_MOCK__?.diagnostics?.();
        return {
          activeDesktopId: window.__DURE_STORE__?.getState?.().activeDesktopId,
          panelPresent: Boolean(api?.getPanel(panelId)),
          panelIds: api?.panels?.map?.((panel) => panel.id) ?? [],
          expectedSessionId: sessionId,
          terminalHosts: [
            ...document.querySelectorAll("[data-dure-media-session-id]"),
          ].map((host) => {
            const bounds = host.getBoundingClientRect();
            return {
              sessionId: host.dataset.dureMediaSessionId,
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            };
          }),
          terminalConsumerCount:
            window.__DURE_MEDIA_CAPTURE_MOCK__?.terminalConsumerCount?.(
              sessionId,
            ) ?? 0,
          recoveryOverlayCount: document.querySelectorAll(
            '[data-testid="hmux-recovery-overlay"]',
          ).length,
        };
      },
      action,
    );
    throw new Error(
      `capture reconnect pane did not become ready: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
}

export async function runClientLifecycleAction(
  page,
  action,
  { afterReload, captureKind, measureOnly = false, probeLiveSessions } = {},
) {
  if (action.action !== "reloadAppClient") return false;
  if (measureOnly) return true;

  await waitForConnectedPane(page, action);
  await page.evaluate(
    ({ panelId, sessionId, stageKey }) => {
      const persisted = localStorage.getItem("agent-ide");
      if (!persisted?.includes(panelId) || !persisted.includes(sessionId)) {
        throw new Error(`capture reconnect layout was not durable: ${panelId}`);
      }
      sessionStorage.setItem(stageKey, "disconnecting");
    },
    { ...action, stageKey: CLIENT_RECONNECT_STAGE_KEY },
  );
  await probeLiveSessions?.({ captureKind, phase: "before" });

  await page.reload({ waitUntil: "networkidle" });
  if (typeof afterReload !== "function") {
    throw new Error("capture client reconnect reload hook is missing");
  }
  await afterReload();
  await waitForConnectedPane(page, action);
  await probeLiveSessions?.({ captureKind, phase: "after" });
  await page.evaluate((stageKey) => {
    sessionStorage.setItem(stageKey, "reconnected");
  }, CLIENT_RECONNECT_STAGE_KEY);
  return true;
}

export { CLIENT_RECONNECT_STAGE_KEY };
