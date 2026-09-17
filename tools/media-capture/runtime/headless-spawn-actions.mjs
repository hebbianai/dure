export async function runHeadlessSpawnAction(page, action, runtime = {}) {
  if (action.action !== "headlessSpawn") return false;
  if (runtime.measureOnly) return true;

  const accepted = await page.evaluate((desktopId) => {
    const api = window.__DURE_DOCK__.getDockview(desktopId);
    const terminal = api?.panels.find((panel) => panel.id.startsWith("term:"));
    const host = terminal?.group?.element?.querySelector?.(".terminal-host");
    const terminalSessionId = host?.dataset?.dureMediaSessionId;
    if (!terminal || !terminalSessionId) {
      throw new Error(`headless spawn caller terminal is missing: ${desktopId}`);
    }
    terminal.api.setActive();
    return window.__DURE_MEDIA_CAPTURE_MOCK__.beginHeadlessSpawn({
      desktopId,
      terminalSessionId,
    });
  }, action.desktopId);
  if (accepted.status !== 202 || accepted.body?.ok !== true) {
    throw new Error(`headless spawn did not return 202: ${JSON.stringify(accepted)}`);
  }

  await page.evaluate((terminalSessionId) => {
    window.__DURE_MEDIA_CAPTURE_MOCK__.repaintTerminal(terminalSessionId);
  }, accepted.terminalSessionId);
  await page.waitForFunction(
    (receiptId) => {
      const receipt = window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics()
        .headlessSpawn?.receipts?.[receiptId];
      return receipt?.state && receipt.state !== "running";
    },
    accepted.body.receiptId,
    { timeout: 10_000 },
  );
  const settledReceipt = await page.evaluate(
    (receiptId) =>
      window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics().headlessSpawn.receipts[
        receiptId
      ],
    accepted.body.receiptId,
  );
  if (settledReceipt?.state !== "succeeded") {
    throw new Error(
      `headless spawn receipt failed: ${JSON.stringify(settledReceipt)}`,
    );
  }
  await page.waitForTimeout(500);

  const presentation = await page.evaluate(
    async ({ desktopId, receiptId, terminalSessionId }) => {
      const mock = window.__DURE_MEDIA_CAPTURE_MOCK__;
      const receipt = mock.diagnostics().headlessSpawn.receipts[receiptId];
      const paneStep = receipt.steps.find((step) => step.step === "pane");
      const agentId = paneStep?.artifacts?.find(
        (artifact) => artifact.kind === "agent_registration",
      )?.id;
      const panelId = paneStep?.artifacts?.find(
        (artifact) => artifact.kind === "pane",
      )?.id;
      const runtimeStep = receipt.steps.find(
        (step) => step.step === "runtime_session",
      );
      const sessionId = runtimeStep?.detail?.sessionId;
      const agent = window.__DURE_STORE__.getState().agents.find(
        (candidate) => candidate.id === agentId,
      );
      const panel = window.__DURE_DOCK__.getDockview(desktopId)?.getPanel(panelId);
      if (
        !agent ||
        !panel ||
        agent.sessionId !== sessionId ||
        panel.id !== `agent:${agent.id}`
      ) {
        throw new Error("headless spawn receipt did not resolve its visible pane");
      }
      const gitStatus = receipt.request.useWorktree
        ? await window.__TAURI_INTERNALS__.invoke("git_status", {
            path: agent.worktreePath,
          })
        : null;
      if (gitStatus) {
        const store = window.__DURE_STORE__;
        const state = store.getState();
        store.setState({
          gitStatuses: { ...state.gitStatuses, [agent.id]: gitStatus },
        });
      }
      mock.completeHeadlessSpawn({
        agentId,
        branch: agent.branch,
        desktopId,
        gitStatus,
        panelId,
        receiptId,
        sessionId,
        terminalSessionId,
        worktreePath: agent.worktreePath,
      });
      return {
        agentId,
        branch: agent.branch,
        gitStatus,
        panelId,
        sessionId,
        terminalSessionId,
        worktreePath: agent.worktreePath,
      };
    },
    {
      desktopId: action.desktopId,
      receiptId: accepted.body.receiptId,
      terminalSessionId: accepted.terminalSessionId,
    },
  );
  await page.evaluate(({ sessionId, terminalSessionId }) => {
    const mock = window.__DURE_MEDIA_CAPTURE_MOCK__;
    mock.repaintTerminal(terminalSessionId);
    mock.repaintTerminal(sessionId);
  }, presentation);
  await page.waitForFunction(
    ({ panelId, receiptId }) =>
      document.body.innerText.includes(receiptId) &&
      Boolean(
        window.__DURE_DOCK__
          .getDockview(window.__DURE_STORE__.getState().activeDesktopId)
          ?.getPanel(panelId),
      ),
    { panelId: presentation.panelId, receiptId: accepted.body.receiptId },
  );
  return true;
}
