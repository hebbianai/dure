export async function runOrchestrationChannelAction(page, action, runtime = {}) {
  if (action.action !== "advanceOrchestrationChannel") return false;
  if (runtime.measureOnly) return true;

  const presentation = await page.evaluate(
    ({ desktopId, phaseId }) => {
      const dock = window.__DURE_DOCK__.getDockview(desktopId);
      const terminal = dock?.panels.find((panel) => panel.id.startsWith("term:"));
      const terminalHost = terminal?.group?.element?.querySelector?.(
        ".terminal-host",
      );
      const terminalSessionId = terminalHost?.dataset?.dureMediaSessionId;
      if (!terminal || !terminalSessionId) {
        throw new Error(`orchestration caller terminal is missing: ${desktopId}`);
      }
      const mock = window.__DURE_MEDIA_CAPTURE_MOCK__;
      const phase = mock.advanceOrchestrationChannel({
        desktopId,
        phaseId,
        terminalSessionId,
      });
      const store = window.__DURE_STORE__;
      const state = store.getState();
      const agents = state.agents.map((agent) =>
        phase.agentComments[agent.id]
          ? { ...agent, comment: phase.agentComments[agent.id], commentUpdatedAt: Date.now() }
          : agent,
      );
      const sessionActivity = { ...state.sessionActivity };
      const agentPanels = phase.agentBindings.map((binding) => {
        const panel = dock.getPanel(binding.panelId);
        const agent = agents.find(({ id }) => id === binding.agentId);
        if (
          !panel ||
          !agent ||
          agent.sessionId !== binding.sessionId ||
          agent.provider !== binding.provider
        ) {
          throw new Error(
            `orchestration phase ${phaseId} does not resolve ${binding.agentId}`,
          );
        }
        sessionActivity[binding.sessionId] = {
          text: binding.name,
          at: Date.now(),
        };
        return { ...binding };
      });
      store.setState({ agents, sessionActivity });
      const completed = mock.completeOrchestrationChannel({
        agentPanels,
        desktopId,
        gateStatus: phase.gateStatus,
        messageIds: phase.messageIds,
        phaseId,
        taskStates: phase.taskStates,
        terminalSessionId,
      });
      mock.repaintTerminal(terminalSessionId);
      terminal.api.setActive();
      return completed;
    },
    { desktopId: action.desktopId, phaseId: action.phaseId },
  );

  await page.waitForFunction(
    ({ phaseId, terminalSessionId }) => {
      const host = [...document.querySelectorAll("[data-dure-media-session-id]")]
        .find((candidate) =>
          candidate.dataset.dureMediaSessionId === terminalSessionId,
        );
      return (
        host?.textContent?.includes(`phase ${phaseId}`) &&
        window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics()
          .orchestrationChannel?.presentations?.some(
            (candidate) => candidate.phaseId === phaseId,
          )
      );
    },
    { phaseId: action.phaseId, terminalSessionId: presentation.terminalSessionId },
  );
  return true;
}
