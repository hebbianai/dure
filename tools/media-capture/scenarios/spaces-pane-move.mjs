import {
  WORKSPACE_OVERVIEW_PUBLIC_WEBM,
  WORKSPACE_OVERVIEW_README_GIF,
} from "./workspace-overview-recipes.mjs";

const SEGMENTS = Object.freeze([
  Object.freeze({ startMs: 600, endMs: 8_000 }),
]);

export function createSpacesPaneMoveScenario({ baseScenario }) {
  const fixture = structuredClone(baseScenario.fixture);
  // The SSH inventory is illustrative; provider frames come from one owned
  // local Hmux source, as recorded by this scenario's proof limitations.
  fixture.agents.find(({ id }) => id === "agent-api-review").provider = "codex";
  fixture.diffBadges["agent-keyboard-nav"] = structuredClone(
    fixture.diffBadges["agent-session-recovery"],
  );
  return {
    ...baseScenario,
    id: "spaces-pane-move",
    title: "Move a Spaces row to another Space",
    description:
      "Move a running pane between Spaces while preserving its session, output and diff context.",
    durationMs: 8_000,
    stillAtMs: 6_000,
    captureProof: { schemaVersion: 1, profile: "hmux-source-pane-move-v1" },
    readmeGif: { ...WORKSPACE_OVERVIEW_README_GIF, segments: SEGMENTS },
    publicWebm: { ...WORKSPACE_OVERVIEW_PUBLIC_WEBM, segments: SEGMENTS },
    fixture,
    setup: [
      { action: "activateDesktop", desktopId: "desk-review" },
      {
        action: "openAgent",
        desktopId: "desk-review",
        agentId: "agent-test-triage",
        replaceDefaultTerminal: true,
      },
      {
        action: "openAgent",
        desktopId: "desk-review",
        agentId: "agent-api-review",
        relativeToAgentId: "agent-test-triage",
        direction: "right",
      },
      { action: "activateDesktop", desktopId: "desk-launch" },
      {
        action: "openAgent",
        desktopId: "desk-launch",
        agentId: "agent-keyboard-nav",
        replaceDefaultTerminal: true,
      },
    ],
    timeline: [
      {
        atMs: 1_600,
        action: "moveSpacesPane",
        panelId: "agent:agent-keyboard-nav",
        fromDesktopId: "desk-launch",
        toDesktopId: "desk-review",
      },
      { atMs: 4_000, action: "activateDesktop", desktopId: "desk-review" },
    ],
  };
}

export function validateSpacesPaneMove(action, desktopIds, spaceKeys) {
  const errors = [];
  for (const key of ["fromDesktopId", "toDesktopId"]) {
    if (!desktopIds.has(action[key])) errors.push(`${key} is unknown`);
  }
  if (!spaceKeys.has(action.panelId)) errors.push("panelId is unknown");
  if (action.fromDesktopId === action.toDesktopId) {
    errors.push("moveSpacesPane must cross desktops");
  }
  return errors;
}
