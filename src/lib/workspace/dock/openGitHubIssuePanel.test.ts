// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeGitHubIssueDrag } from "@/lib/github/githubIssueDrag";
import { parseGitHubWorkItem } from "@/lib/github/githubResponses";
import { handleSidebarDrop } from "@/lib/sidebar/sidebarDropHandler";
import { registerDockview, unregisterDockview } from "./dockRegistry";
import { openGitHubIssuePanel } from "./openGitHubIssuePanel";
import { useStore } from "@/store";
import { installInteriorBoundaryDrop } from "@/lib/workspace/pane/paneInsertionDrop";

const project = {
	id: "project",
	name: "Dure",
	path: "/work/dure",
	kind: "local" as const,
	isRepo: true,
};
const repository = {
	projectId: project.id,
	projectName: project.name,
	path: project.path,
	nameWithOwner: "o/r",
	owner: "o",
	url: "https://github.com/o/r",
	isInOrganization: true,
};
const row = parseGitHubWorkItem(
	{ number: 42, title: "Fix refresh", url: `${repository.url}/issues/42` },
	"issue",
	repository,
)!;
let api: DockviewApi;
let container: HTMLElement;
let desktopId: string;
let stopBoundary: (() => void) | undefined;

beforeEach(() => {
	desktopId = useStore.getState().addDesktop({ name: "Issue QA" });
	useStore.setState({ projects: [project], activeSpaceId: desktopId });
	container = document.createElement("div");
	document.body.append(container);
	api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
			dispose() {},
		}),
	});
	api.layout(1200, 800);
	registerDockview(desktopId, api);
	api.addPanel({ id: "existing", component: "test" });
});
afterEach(() => {
	stopBoundary?.();
	stopBoundary = undefined;
	unregisterDockview(desktopId, api);
	api.dispose();
	container.remove();
});

function expectSeparateIssue() {
	const existing = api.getPanel("existing")!;
	const issue = currentIssue()!;
	expect(issue).toBeDefined();
	expect(issue.group).not.toBe(existing.group);
	expect(existing.api.isVisible).toBe(true);
	expect(issue.api.isVisible).toBe(true);
	expect(existing.group.panels).toHaveLength(1);
	expect(issue.group.panels).toHaveLength(1);
}

function currentIssue() {
	return api.panels.find(
		(panel) =>
			panel.api.component === "githubissue" &&
			panel.params?.row?.repository?.projectId === row.repository.projectId &&
			panel.params?.row?.number === row.number &&
			panel.params?.row?.kind === "issue",
	);
}

describe("sidebar issue panes with real Dockview", () => {
	it.each(["column", "row"])(
		"inserts a new issue at the shared interior %s boundary",
		(axis) => {
			api.addPanel({
				id: "second",
				component: "test",
				position: {
					referencePanel: "existing",
					direction: axis === "column" ? "right" : "below",
				},
			});
			container.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 800);
			const options = {
				api,
				container,
				draggedPanelId: () => null,
				dropNewPane: (nativeEvent: DragEvent, group: { id: string }) =>
					handleSidebarDrop(
						{ nativeEvent, group, position: "center" },
						desktopId,
						container,
					),
			};
			stopBoundary = installInteriorBoundaryDrop(options);
			const drag = (type: string, payload = encodeGitHubIssueDrag(row)) => {
				const event = new MouseEvent(type, {
					bubbles: true,
					cancelable: true,
					clientX:
						axis === "column" ? api.getPanel("existing")!.group.api.width : 600,
					clientY:
						axis === "row" ? api.getPanel("existing")!.group.api.height : 400,
				});
				Object.defineProperty(event, "dataTransfer", {
					value: {
						types: ["text/plain", "application/x-dure-new-pane"],
						getData: (mime: string) => (mime === "text/plain" ? payload : ""),
					},
				});
				container.dispatchEvent(event);
				if (type === "dragover") expect(event.defaultPrevented).toBe(true);
			};
			drag("dragover");
			expect(
				container.querySelector<HTMLElement>(".pane-boundary-drop-overlay")
					?.dataset.paneDropIntent,
			).toBe(`insert-${axis}`);
			drag("drop");
			expectSeparateIssue();
			expect(api.groups).toHaveLength(3);
			const saved = api.toJSON();
			const leaves = (node: { type: string; data: unknown }): string[][] =>
				node.type === "leaf"
					? [(node.data as { views: string[] }).views]
					: (node.data as Parameters<typeof leaves>[0][]).flatMap(leaves);
			expect(leaves(saved.grid.root)).toEqual([
				["existing"],
				[currentIssue()!.id],
				["second"],
			]);
			api.fromJSON(saved);
			expectSeparateIssue();
			// A repeated or invalid drop must not strand an empty insertion group.
			drag("dragover");
			drag("drop");
			expect(api.groups).toHaveLength(3);
			drag("dragover");
			drag("drop", 'dure:{"type":"github-issue"}');
			expect(api.groups).toHaveLength(3);
			expect(api.toJSON().grid).toEqual(saved.grid);
			expect(api.groups.every((group) => group.panels.length === 1)).toBe(true);
		},
	);

	it("opens alongside the focused pane and reuses the same issue without replacing its loaded params", () => {
		openGitHubIssuePanel(desktopId, row);
		expectSeparateIssue();
		const issue = currentIssue()!;
		issue.api.updateParameters({
			row: { ...row, title: "Newer detail title" },
		});
		api.getPanel("existing")!.api.setActive();
		openGitHubIssuePanel(desktopId, row);
		expect(api.panels).toHaveLength(2);
		expect(api.activePanel).toBe(issue);
		expect(issue.params?.row.title).toBe("Newer detail title");
		expectSeparateIssue();
	});
	it("allocates a neutral pane and reuses its saved identity", () => {
		openGitHubIssuePanel(desktopId, row);
		const id = currentIssue()!.id;
		expect(id).toMatch(/^pane-/);
		api.fromJSON(api.toJSON());
		openGitHubIssuePanel(desktopId, row);
		expect(api.activePanel?.id).toBe(id);
		expect(api.panels).toHaveLength(2);
	});
	it.each(["pane-existing", "github-issue:project:42", "launcher:former"])(
		"reuses the current issue at %s without overwriting loaded detail",
		(id) => {
			const pane = api.addPanel({
				id,
				component: "githubissue",
				params: { row: { ...row, title: "Loaded title" }, preserved: true },
			});
			api.getPanel("existing")!.api.setActive();
			openGitHubIssuePanel(desktopId, row);
			expect(api.activePanel).toBe(pane);
			expect(api.panels).toHaveLength(2);
			expect(pane.params).toEqual({
				row: { ...row, title: "Loaded title" },
				preserved: true,
			});
		},
	);
	it("does not focus a historical issue pane after its content has changed", () => {
		const pane = api.addPanel({
			id: "github-issue:project:42",
			component: "githubissue",
			params: { row },
		});
		const terminal = api.replacePanel(pane.api, {
			component: "terminal",
			params: { row, sessionId: "retained-session" },
		})!;
		openGitHubIssuePanel(desktopId, row);
		expect(api.activePanel).not.toBe(terminal);
		expect(currentIssue()?.id).toMatch(/^pane-/);
		expect(terminal.params).toEqual({ row, sessionId: "retained-session" });
	});
	it.each([
		{},
		{ row: null },
		{ row: { ...row, kind: "pr" } },
		{ row: { ...row, repository: {} } },
		{ row: { ...row, number: "42" } },
		{ row: { ...row, number: 43 } },
		{ row: { ...row, repository: { ...repository, projectId: "other" } } },
	])(
		"does not infer a missing, malformed or changed issue from its ID: %j",
		(params) => {
			const pane = api.addPanel({
				id: "github-issue:project:42",
				component: "githubissue",
				params,
			});
			openGitHubIssuePanel(desktopId, row);
			expect(api.activePanel).not.toBe(pane);
			expect(api.panels).toHaveLength(3);
			expect(pane.params).toEqual(params);
		},
	);
	it("keeps the same issue in another Space independent", () => {
		const element = document.createElement("div");
		document.body.append(element);
		const other = createDockview(element, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
			}),
		});
		other.layout(1000, 700);
		registerDockview("other-space", other);
		try {
			other.addPanel({
				id: "github-issue:project:42",
				component: "githubissue",
				params: { row },
			});
			const saved = other.toJSON();
			openGitHubIssuePanel(desktopId, row);
			expect(currentIssue()?.id).toMatch(/^pane-/);
			expect(other.toJSON()).toEqual(saved);
		} finally {
			unregisterDockview("other-space", other);
			other.dispose();
			element.remove();
		}
	});
	it.each(["left", "right", "top", "bottom", "center"])(
		"drops at %s without tab-stacking the target",
		(position) => {
			const group = api.getPanel("existing")!.group;
			handleSidebarDrop(
				{
					position,
					group,
					nativeEvent: {
						clientX: 500,
						clientY: 300,
						dataTransfer: {
							getData: (type: string) =>
								type === "text/plain" ? encodeGitHubIssueDrag(row) : "",
						},
					} as unknown as DragEvent,
				},
				desktopId,
				container,
			);
			expectSeparateIssue();
		},
	);
});
