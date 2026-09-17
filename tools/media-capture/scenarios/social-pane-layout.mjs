import { PROVIDER_SCREEN_FIXTURES } from "../provider-screens.mjs";
import { createProductTourScenarios } from "./product-tour.mjs";

const visibleWidth = (text) =>
  [...text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")].length;

function wrapExcerpt(screen, lines) {
  return screen.split("\r\n").slice(0, lines).flatMap((line) => {
    const rows = [];
    let row = "";
    for (const word of line.split(" ")) {
      const candidate = row ? `${row} ${word}` : word;
      if (visibleWidth(candidate) > 46 && row) {
        rows.push(row);
        row = word;
      } else row = candidate;
    }
    rows.push(row);
    return rows;
  }).join("\r\n") + "\r\n\u001b[0m";
}

// Reuse the shipped pane-drag gestures without altering the website tour.
export function createSocialPaneLayoutScenario({ baseScenario }) {
  const scenario = structuredClone(
    createProductTourScenarios({ baseScenario }).find(
      (candidate) => candidate.id === "tour-pane-layout",
    ),
  );
  scenario.id = "social-pane-layout";
  scenario.title = "Arrange agent panes with the desktop in view";
  scenario.description =
    "A wallpaper-framed, fixture-backed demonstration of real pane dragging.";
  scenario.viewport = { width: 1920, height: 1080, deviceScaleFactor: 1 };
  scenario.captureStage.window = {
    left: 120, top: 110, width: 1680, height: 860, borderRadius: 14,
  };
  const excerpts = {
    claude: wrapExcerpt(PROVIDER_SCREEN_FIXTURES.codex, 4),
    codex: wrapExcerpt(PROVIDER_SCREEN_FIXTURES.codexReview, 5),
    pi: wrapExcerpt(PROVIDER_SCREEN_FIXTURES.codexNavigation, 9),
  };
  // Short existing sanitized excerpts stay readable in stacked panes. They
  // illustrate layout only, never live execution or performance evidence.
  scenario.fixture.terminalSnapshots = Object.fromEntries(
    Object.entries(excerpts).map(([id, screen]) => [
      `tour-session-${id}`,
      screen,
    ]),
  );
  // Visible titles follow the demo folder, not an unrelated provider name.
  for (const agent of scenario.fixture.agents) {
    const folder = { "tour-codex": "test-triage", "tour-pi": "pane-navigation" }[agent.id];
    if (folder) agent.worktreePath = `/workspace/launchpad/.worktrees/${folder}`;
  }
  return scenario;
}
