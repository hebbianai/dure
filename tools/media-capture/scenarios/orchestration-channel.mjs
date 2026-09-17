import { createOrchestrationChannelFixture } from "./orchestration-channel-fixture.mjs";
import {
  ORCHESTRATION_CHANNEL_PUBLIC_WEBM,
  ORCHESTRATION_CHANNEL_README_GIF,
} from "./orchestration-channel-recipes.mjs";

export function createOrchestrationChannelScenario({ baseScenario }) {
  const fixture = structuredClone(baseScenario.fixture);
  fixture.activeDesktopId = "desk-launch";
  fixture.orchestrationChannel = createOrchestrationChannelFixture(
    baseScenario.clock,
  );
  for (const binding of fixture.orchestrationChannel.agentBindings) {
    const agent = fixture.agents.find(({ id }) => id === binding.agentId);
    agent.comment = fixture.orchestrationChannel.phases[0].agentComments[agent.id];
  }
  return {
    ...baseScenario,
    id: "orchestration-channel",
    title: "Live multi-agent orchestration channel",
    description:
      "Typed dispatch, heartbeat, worker_done, and decision-gate messages coordinate live Codex and Claude panes.",
    durationMs: 8_600,
    stillAtMs: 7_200,
    readmeGif: ORCHESTRATION_CHANNEL_README_GIF,
    publicWebm: ORCHESTRATION_CHANNEL_PUBLIC_WEBM,
    fixture,
    setup: [
      { action: "activateDesktop", desktopId: "desk-launch" },
      {
        action: "openAgent",
        desktopId: "desk-launch",
        agentId: "agent-test-triage",
        relativeToTerminal: true,
        direction: "right",
      },
      {
        action: "openAgent",
        desktopId: "desk-launch",
        agentId: "agent-copy-review",
        relativeToAgentId: "agent-test-triage",
        direction: "below",
      },
      {
        action: "equalizeGridColumns",
        desktopId: "desk-launch",
        columns: [1, 2],
        panelColumns: [
          ["term:*"],
          ["agent:agent-test-triage", "agent:agent-copy-review"],
        ],
      },
      {
        action: "advanceOrchestrationChannel",
        desktopId: "desk-launch",
        phaseId: "queued",
      },
    ],
    timeline: [
      {
        atMs: 1_000,
        action: "advanceOrchestrationChannel",
        desktopId: "desk-launch",
        phaseId: "dispatched",
      },
      {
        atMs: 2_800,
        action: "advanceOrchestrationChannel",
        desktopId: "desk-launch",
        phaseId: "working",
      },
      {
        atMs: 4_800,
        action: "advanceOrchestrationChannel",
        desktopId: "desk-launch",
        phaseId: "decision",
      },
      {
        atMs: 6_600,
        action: "advanceOrchestrationChannel",
        desktopId: "desk-launch",
        phaseId: "resolved",
      },
    ],
  };
}
