// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/ipc/telemetry";
import {
	openDiffPanel,
	openGitPanel,
	openSessionDiffPanel,
} from "@/lib/workspace/dock/openScmPanel";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";

vi.mock("@/lib/ipc/telemetry", () => ({ track: vi.fn() }));

const cleanups: (() => void)[] = [];
let api: DockviewApi;
const desktopId = "desktop-1";
function mounted(spaceId = desktopId) {
	const element = document.createElement("div");
	document.body.append(element);
	const dock = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	dock.layout(1000, 700);
	registerDockview(spaceId, dock);
	dock.addPanel({
		id: "sibling",
		component: "fileviewer",
		params: { path: "/file", source: "local" },
	});
	cleanups.push(() => {
		unregisterDockview(spaceId, dock);
		dock.dispose();
		element.remove();
	});
	return dock;
}
beforeEach(() => {
	api = mounted();
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("openGitPanel", () => {
	it("offers git_panel_opened only when a new Git pane is created", () => {
		vi.mocked(track).mockClear();
		openGitPanel(desktopId, "project-1", "Dure");
		openGitPanel(desktopId, "project-1", "Dure");
		expect(
			api.panels.filter((panel) => panel.api.component === "git"),
		).toHaveLength(1);
		expect(vi.mocked(track).mock.calls).toEqual([["git_panel_opened"]]);
	});
});

describe("openSessionDiffPanel", () => {
	it("captures the current cwd in a session-scoped read-only Diff pane", () => {
		openSessionDiffPanel(
			desktopId,
			"standalone-1",
			"/repo/.worktrees/feature/subdir ",
			"Codex",
		);
		const pane = api.activePanel!;
		expect(pane.id).toMatch(/^pane-/);
		expect(pane.api.component).toBe("diff");
		expect(pane.api.title).toBe("Diff · Codex");
		expect(pane.params).toMatchObject({
			cwd: "/repo/.worktrees/feature/subdir ",
			sessionId: "standalone-1",
			reviewId: expect.stringMatching(/^review-/),
		});
		expect(pane.group).not.toBe(api.getPanel("sibling")!.group);
	});
	it("retargets only when the user explicitly opens Diff again", () => {
		const pane = api.addPanel({
			id: "pane-review",
			component: "diff",
			params: {
				sessionId: "standalone-1",
				cwd: "/repo/old",
				reviewId: "review-old",
				preserved: true,
			},
		});
		openSessionDiffPanel(desktopId, "standalone-1", "/repo/new", "Shell");
		expect(api.activePanel).toBe(pane);
		expect(pane.params).toMatchObject({
			cwd: "/repo/new",
			sessionId: "standalone-1",
			preserved: true,
		});
		expect(pane.params?.reviewId).toMatch(/^review-/);
		expect(pane.params?.reviewId).not.toBe("review-old");
		expect(pane.api.title).toBe("Diff · Shell");
	});
	it("does nothing without a captured working directory", () => {
		const before = api.toJSON();
		openSessionDiffPanel(desktopId, "standalone-1", "  ", "Shell");
		expect(api.toJSON()).toEqual(before);
	});
	it.each([null, "", 12, "agent-other"])(
		"does not reuse an explicit Agent target %j as a standalone review",
		(agentId) => {
			const pane = api.addPanel({
				id: "diff:session:standalone-1",
				component: "diff",
				params: {
					agentId,
					sessionId: "standalone-1",
					cwd: "/before",
					reviewId: "review-before",
				},
			});
			const before = { ...pane.params };
			openSessionDiffPanel(desktopId, "standalone-1", "/after", "Shell");
			expect(api.activePanel?.id).toMatch(/^pane-/);
			expect(api.activePanel).not.toBe(pane);
			expect(pane.params).toEqual(before);
		},
	);
});

const targets = [
	{
		name: "Git",
		component: "git",
		legacyId: "git:target",
		params: { projectId: "target" },
		open: (spaceId = desktopId) => openGitPanel(spaceId, "target", "Target"),
	},
	{
		name: "Agent Diff",
		component: "diff",
		legacyId: "diff:target",
		params: { agentId: "target", reviewId: "review-before" },
		open: (spaceId = desktopId) => openDiffPanel(spaceId, "target", "Target"),
	},
	{
		name: "standalone Diff",
		component: "diff",
		legacyId: "diff:session:target",
		params: { sessionId: "target", cwd: "/repo", reviewId: "review-before" },
		open: (spaceId = desktopId) =>
			openSessionDiffPanel(spaceId, "target", "/repo", "Target"),
	},
] as const;

describe.each(targets)("$name pane identity", (target) => {
	it("allocates a neutral ID only once and preserves it after save/restore", () => {
		target.open();
		const id = api.activePanel!.id;
		expect(id).toMatch(/^pane-/);
		expect(id).not.toBe(target.legacyId);
		expect(api.activePanel!.api.component).toBe(target.component);
		api.fromJSON(api.toJSON());
		target.open();
		expect(api.activePanel?.id).toBe(id);
		expect(api.panels).toHaveLength(2);
		expect(api.getPanel("sibling")?.params).toEqual({
			path: "/file",
			source: "local",
		});
	});
	it.each(["pane-existing", target.legacyId, "launcher:former"])(
		"reuses current content at %s without renaming it",
		(id) => {
			const pane = api.addPanel({
				id,
				component: target.component,
				params: { ...target.params, preserved: true },
			});
			api.getPanel("sibling")!.api.setActive();
			target.open();
			expect(api.activePanel).toBe(pane);
			expect(api.panels).toHaveLength(2);
			expect(pane.params?.preserved).toBe(true);
			if (target.name === "Agent Diff")
				expect(pane.params?.reviewId).toBe("review-before");
		},
	);
	it("leaves a repurposed historical pane unchanged", () => {
		const pane = api.addPanel({
			id: target.legacyId,
			component: target.component,
			params: target.params,
		});
		const terminal = api.replacePanel(pane.api, {
			component: "terminal",
			params: { ...target.params, sessionId: "retained-session" },
		})!;
		const before = { ...terminal.params };
		target.open();
		expect(api.activePanel?.id).toMatch(/^pane-/);
		expect(api.activePanel).not.toBe(terminal);
		expect(terminal.api.component).toBe("terminal");
		expect(terminal.params).toEqual(before);
	});
	it("does not infer a missing target from its historical ID", () => {
		const pane = api.addPanel({
			id: target.legacyId,
			component: target.component,
			params: { reviewId: "retained" },
		});
		target.open();
		expect(api.activePanel).not.toBe(pane);
		expect(pane.params).toEqual({ reviewId: "retained" });
	});
	it("does not reuse or rename another Space's view", () => {
		const other = mounted("other");
		const pane = other.addPanel({
			id: target.legacyId,
			component: target.component,
			params: target.params,
		});
		const saved = other.toJSON();
		target.open();
		expect(api.activePanel?.id).toMatch(/^pane-/);
		expect(other.toJSON()).toEqual(saved);
		expect(other.getPanel(target.legacyId)).toBe(pane);
	});
});
