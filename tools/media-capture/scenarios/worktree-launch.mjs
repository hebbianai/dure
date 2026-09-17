import {
  createWorktreeLaunchFixture,
  WORKTREE_LAUNCH_PROVIDER_SESSION_ID,
} from "./worktree-launch-fixture.mjs";
import {
  WORKTREE_LAUNCH_PUBLIC_WEBM,
  WORKTREE_LAUNCH_README_GIF,
} from "./worktree-launch-recipes.mjs";

export function createWorktreeLaunchScenario({ baseScenario }) {
  const fixture = structuredClone(baseScenario.fixture);
  fixture.activeDesktopId = "desk-launch";
  fixture.terminalSnapshots[WORKTREE_LAUNCH_PROVIDER_SESSION_ID] =
    fixture.terminalSnapshots["session-codex"];
  fixture.headlessSpawn = createWorktreeLaunchFixture();
  return {
    ...baseScenario,
    id: "worktree-launch",
    title: "One agent, one dedicated worktree",
    description:
      "The shipped spawn saga journals a dedicated branch and worktree before opening a live Codex pane with joined git status.",
    durationMs: 8_600,
    stillAtMs: 6_000,
    readmeGif: WORKTREE_LAUNCH_README_GIF,
    publicWebm: WORKTREE_LAUNCH_PUBLIC_WEBM,
    liveSessionTerminalSizes: {
      ...baseScenario.liveSessionTerminalSizes,
      [WORKTREE_LAUNCH_PROVIDER_SESSION_ID]: { columns: 101, rows: 50 },
    },
    fixture,
    setup: [{ action: "activateDesktop", desktopId: "desk-launch" }],
    timeline: [
      {
        atMs: 2_150,
        action: "headlessSpawn",
        desktopId: "desk-launch",
      },
    ],
  };
}
