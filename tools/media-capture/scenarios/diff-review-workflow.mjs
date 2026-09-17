import {
  DIFF_REVIEW_WORKFLOW_PUBLIC_WEBM,
  DIFF_REVIEW_WORKFLOW_README_GIF,
} from "./diff-review-workflow-recipes.mjs";

export function createDiffReviewWorkflowScenario({ baseScenario }) {
  const fixture = structuredClone(baseScenario.fixture);
  fixture.activeDesktopId = "desk-review";
  return {
    ...baseScenario,
    id: "diff-review-workflow",
    title: "Read-only agent diff review",
    description:
      "Codex and Claude panes beside a terminal and a fork-point diff review.",
    durationMs: 7_000,
    stillAtMs: 3_200,
    readmeGif: DIFF_REVIEW_WORKFLOW_README_GIF,
    publicWebm: DIFF_REVIEW_WORKFLOW_PUBLIC_WEBM,
    fixture,
    setup: [
      {
        action: "openAgent",
        desktopId: "desk-review",
        agentId: "agent-keyboard-nav",
        relativeToTerminal: true,
        direction: "right",
      },
    ],
    timeline: [
      {
        atMs: 500,
        action: "openAgent",
        desktopId: "desk-review",
        agentId: "agent-docs-polish",
        relativeToAgentId: "agent-keyboard-nav",
        direction: "below",
      },
      {
        atMs: 1_400,
        action: "openDiff",
        desktopId: "desk-review",
        agentId: "agent-session-recovery",
      },
    ],
  };
}
