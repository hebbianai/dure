import { readFileSync } from "node:fs";
import { DURE_DESKTOP_CAPTURE_STAGE } from "../runtime/capture-stage.mjs";
const pluginJson = (path) => JSON.parse(readFileSync(new URL(`../../../plugins/github/${path}`, import.meta.url), "utf8"));
const githubPlugin = {
  manifest: pluginJson("dure-plugin.json"),
  compatibility: { status: "supported", negotiated_host_api_version: 2, contributions: [{ id: "dure.github.views", family: "dure.views", version: 1 }, { id: "dure.github.issue-tracker", family: "dure.issue-tracker", version: 1 }], ignored_optional_contributions: [], enabled_agent_integrations: [], ignored_optional_agent_integrations: [] },
  distribution: "bundled", installed: true, removable: false, settings_contribution: null,
  issue_tracker_contributions: [{ contribution_id: "dure.github.issue-tracker", provider: pluginJson("contributions/issue-tracker.json") }],
  view_contributions: [{ contribution_id: "dure.github.views", views: pluginJson("contributions/views.json") }],
};

// Fixture mode provides an idle terminal only; execution output comes from live capture.
export const TOUR_SCREENS = Object.fromEntries(["claude", "codex", "pi", "tests", "issue"].map(id => [id,
  "OpenAI Codex\r\n\r\n❯ ",
]));

export const PRODUCT_TOUR_CLIPS = [
  { id: "new-agent", title: "Run agents side by side", intro: "Give Codex a task while Codex stays open.", durationMs: 17000, steps: [
    [1100, "open-new", "1. Open a new agent with ⌘ N"],
    [2300, "type-prompt", "2. Describe the task you want Codex to handle"],
    [5000, "start-agent", "3. Start Codex in the same workspace"],
    [7200, "outcome", "Two agents, one workspace. Switch without losing context."],
  ] },
  { id: "split-codex", title: "Add Codex in a split pane", intro: "Keep a second agent visible beside your work.", durationMs: 15000, steps: [
    [1200, "split", "1. Right-click the pane → Split Right → New pane"],
    [4200, "add-codex", "2. Choose Codex for the new pane"],
    [6200, "outcome", "Codex and Codex are now visible together."],
  ] },
  { id: "github-issue", title: "Turn a GitHub issue into an agent task", intro: "Bring the issue context into a new agent automatically.", durationMs: 19000, steps: [
    [1200, "github", "1. Open GitHub in the Review space"],
    [3500, "issue-start", "2. Choose an issue and click Start"],
    [6500, "start-agent", "3. Start Codex with the issue already attached"],
    [8400, "outcome", "The agent opens with the issue title and repository context."],
  ] },
  { id: "pane-layout", title: "Arrange your workspace by dragging", intro: "Move an agent to the side or stack it below another.", durationMs: 15000, steps: [
    [1500, "drag-right", "1. Drag Pi to the right edge of Codex"],
    [6500, "drag-below", "2. Drag Pi below Codex to stack the panes"],
    [11000, "outcome", "Your layout changes. The agent sessions stay open."],
  ] },
  { id: "appearance", title: "Switch between light and dark themes", intro: "Change the whole workspace appearance.", durationMs: 11000, steps: [
    [1100, "settings", "1. Open Settings → Appearance"],
    [3500, "theme", "2. Switch from dark to light"],
    [6500, "close-settings", "3. Return to the terminal to see the new theme"],
    [7300, "outcome", "A clear workspace-wide appearance change."],
  ] },
  { id: "space-shortcuts", title: "Switch between desktop layouts", intro: "Keep separate layouts for active work and review.", durationMs: 18000, steps: [
    [4000, "space-review", "1. Click Review to open Review"],
    [9000, "space-build", "Open the four-pane Build desktop"],
    [14000, "space-main", "2. Click Main to return to Main"],
    [16000, "outcome", "Your panes and sessions are right where you left them."],
  ] },
];

export function createProductTourScenarios({ baseScenario }) {
  const fixture = {
    language: "en", desktops: [{ id: "desk-main", name: "Main" }, { id: "desk-review", name: "Review" }, { id: "desk-build", name: "Build" }],
    activeDesktopId: "desk-main",
    projects: [{ id: "project-launchpad", name: "launchpad", path: "/workspace/launchpad", kind: "local", isRepo: true }],
    agents: ["claude", "codex", "pi", "tests", "review", "review-code", "build-code", "build-test", "build-review"].map((provider) => ({
      id: `tour-${provider}`, name: { claude: "Session handoff", codex: "Test run", pi: "Handoff review", tests: "Regression tests", review: "Review tests", "review-code": "Code review", "build-code": "Implementation", "build-test": "Test coverage", "build-review": "Final review" }[provider],
      provider: "codex", projectId: "project-launchpad", worktreePath: provider === "claude" ? "/workspace/launchpad" : `/workspace/launchpad/.worktrees/${provider}`,
      branch: `agent/${provider === "claude" ? "handoff" : provider === "pi" ? "review" : provider}`, sessionId: `tour-session-${provider}`, sessionKind: "pty", started: true,
      runtimeBinding: { schemaVersion: 1, runtime: "hmux_managed_v1", sessionId: `tour-session-${provider}`,
        workspaceId: "workspace-project-launchpad", createIdempotencyKey: `tour-${provider}`, source: "local", hostId: "local" },
    })),
    installedAgents: ["codex"], agentActivity: {}, gitStatuses: {}, diffBadges: {}, diffReviews: {}, sshStates: {}, sshHosts: [],
    terminalSnapshots: Object.fromEntries(Object.entries(TOUR_SCREENS).filter(([id]) => id !== "issue").map(([id, value]) => [`tour-session-${id}`, value])),
    terminalScreensByCwd: { "/workspace/launchpad": "$ " },
    productTour: { screens: TOUR_SCREENS, plugin: githubPlugin },
  };
  const setup = [{ action: "productTour", gesture: "prepare" }];
  return PRODUCT_TOUR_CLIPS.map(({ id, title, intro, durationMs, steps }, index) => {
    const target = (key, desktopId, startMs, endMs) => ({ agentId: `tour-${key}`, id: `tour-session-${key}`, kind: "pty", provider: "codex", desktopId, visibleWindows: [{ startMs, endMs }] });
    let targets;
    if (id === "new-agent") targets = [target("codex", "desk-main", 500, durationMs - 800)];
    else if (id === "split-codex" || id === "appearance") targets = [target("claude", "desk-main", id === "appearance" ? 7200 : 500, durationMs - 800)];
    else if (id === "github-issue") targets = [{ ...target("codex", "desk-review", 2300, durationMs - 800), visibleWindows: [{ desktopId: "desk-main", startMs: 250, endMs: 800 }, { startMs: 2300, endMs: durationMs - 800 }] }];
    else targets = ["claude", "codex", "pi"].map(key => target(key, "desk-main", 500, id === "space-shortcuts" ? 3300 : durationMs - 800));
    if (["new-agent", "github-issue", "split-codex"].includes(id)) targets.push({ ...target("new", id === "github-issue" ? "desk-review" : "desk-main", id === "github-issue" ? 8200 : 6600, durationMs - 800), provider: "codex" });
    if (id === "space-shortcuts") {
      targets = targets.map(item => ({ ...item, visibleWindows: [...item.visibleWindows, { startMs: 15000, endMs: 17200 }] }));
      targets.push(...["review", "review-code"].map(key => target(key, "desk-review", 4900, 8300)));
      targets.push(...["tests", "build-code", "build-test", "build-review"].map(key => target(key, "desk-build", 10000, 13300)));
    }
    if (id === "pane-layout") targets = targets.map(item => ({ ...item, visibleWindows: [{ startMs: 10500, endMs: 14200 }] }));
    return ({
    ...baseScenario, id: `tour-${id}`, title, description: `${title} using shipped UI and English demo data.`,
    captureStage: { ...DURE_DESKTOP_CAPTURE_STAGE, window: { left: 24, top: 40, width: 1432, height: 876, borderRadius: 14 } },
    viewport: { width: 1480, height: 940, deviceScaleFactor: 2 },
    interfaceMode: "pro", terminalFontSize: 14, liveTerminalSize: { columns: 70, rows: 28 },
    liveProviderTerminalSizes: {}, liveSessionTerminalSizes: {},
    durationMs, stillAtMs: durationMs - 500, readmeGif: undefined, publicWebm: undefined,
    fixture: { ...structuredClone(fixture),
      desktops: fixture.desktops.filter(desktop => id === "space-shortcuts" || desktop.id !== "desk-build"),
      agents: fixture.agents.filter(agent => id === "space-shortcuts" || agent.id === "tour-codex" || targets.some(target => target.agentId === agent.id)),
      productTour: { ...structuredClone(fixture.productTour), providerTargets: targets, guide: { title, intro, number: index + 1, steps: Object.fromEntries(steps.map(([, gesture, text]) => [gesture, text])) } } }, setup: structuredClone(setup),
    timeline: steps.map(([atMs, gesture]) => ({ atMs, action: "productTour", gesture })),
  });
  });
}
