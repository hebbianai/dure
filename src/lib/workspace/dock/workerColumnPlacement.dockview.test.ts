// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import {
	type ShellRelationNode,
	shellRowKey,
} from "@/lib/agents/relations/shellRelationNodes";
import { openAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const disposers: (() => void)[] = [];
const initial = useStore.getState();
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	useStore.setState(initial, true);
});

const leadSession = { sessionId: "session-lead", workspaceId: "workspace-1" };

function lead(): Agent {
	return agentFixture({
		id: "lead",
		name: "lead",
		runtimeBinding: managedBindingFixture(leadSession),
	});
}

function worker(id: string): Agent {
	return agentFixture({
		id,
		name: id,
		runtimeBinding: managedBindingFixture({
			sessionId: `session-${id}`,
			createIdempotencyKey: `create-${id}`,
		}),
		runParent: { ...leadSession, leadAgentId: "lead" },
	});
}

function fixture(width = 1600, height = 900) {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("textarea"),
			init() {},
		}),
	});
	const desktopId = `worker-column-${disposers.length}`;
	registerDockview(desktopId, api);
	api.layout(width, height);
	disposers.push(() => {
		unregisterDockview(desktopId, api);
		api.dispose();
		element.remove();
	});
	const agents: Agent[] = [];
	const shells: ShellRelationNode[] = [];
	/** Project the Agent into the store order, then open its pane, as a Run
	 * presentation does. */
	const open = (agent: Agent, preferredPanelId?: string) => {
		agents.push(agent);
		const panelId = openAgentPanelOnDockview({
			api,
			desktopId,
			agent,
			relationFacts: { agents, shells },
			preferredPanelId,
		});
		expect(panelId).not.toBe(false);
		return api.getPanel(String(panelId))!;
	};
	/** A plain shell pane holding the lead's Hmux Session. */
	const openShell = (panelId: string, besidePanelId: string) => {
		const panel = api.addPanel({
			id: panelId,
			component: "terminal",
			title: panelId,
			position: { referencePanel: besidePanelId, direction: "right" },
		});
		shells.push({
			key: shellRowKey(desktopId, panelId),
			desktopId,
			panelId,
			terminalSessionId: `term-${panelId}`,
			session: leadSession,
		});
		return panel;
	};
	return { api, open, openShell };
}

type Tree = string[] | Tree[];

/** The grid as nested arrays of each group's panel titles. */
function tree(api: DockviewApi): Tree {
	const walk = (node: { type: string; data: unknown }): Tree | string[] =>
		node.type === "leaf"
			? (node.data as { views: string[] }).views.map(
					(id) => api.getPanel(id)?.title ?? id,
				)
			: ((node.data as { type: string; data: unknown }[]).map(walk) as Tree);
	return walk(api.toJSON().grid.root as never);
}

describe("worker column placement", () => {
	it("stacks a lead's four workers beside it in start order and leaves an unrelated terminal alone", () => {
		const { api, open } = fixture();
		const leadPanel = open(lead());
		const terminal = api.addPanel({
			id: "terminal",
			component: "terminal",
			title: "terminal",
			position: { referencePanel: leadPanel.id, direction: "right" },
		});
		const terminalGroup = terminal.group;
		const terminalElement = terminalGroup.element;
		const terminalSize = [terminalGroup.api.width, terminalGroup.api.height];
		// The terminal is the active pane: placement must not follow it.
		terminal.api.setActive();

		for (const id of ["work-1", "work-2", "work-3", "work-4"]) {
			open(worker(id), terminal.id);
		}

		expect(tree(api)).toEqual([
			["lead"],
			[["work-1"], ["work-2", "work-3", "work-4"]],
			["terminal"],
		]);
		expect(api.getPanel("terminal")?.group).toBe(terminalGroup);
		expect(terminalGroup.element).toBe(terminalElement);
		expect(terminalGroup.panels.map((panel) => panel.id)).toEqual(["terminal"]);
		expect([terminalGroup.api.width, terminalGroup.api.height]).toEqual(
			terminalSize,
		);
	});

	it("keeps splitting the column while both halves stay readable", () => {
		const { api, open } = fixture(1600, 1300);
		open(lead());
		for (const id of ["work-1", "work-2", "work-3", "work-4"]) {
			open(worker(id));
		}
		expect(tree(api)).toEqual([
			["lead"],
			[["work-1"], ["work-2"], ["work-3", "work-4"]],
		]);
	});

	it("follows the latest worker's group when the user moved the column", () => {
		const { api, open } = fixture();
		const leadPanel = open(lead());
		open(worker("work-1"));
		const moved = open(worker("work-2"));
		// The user drags work-2 to the far left of the Space.
		moved.api.moveTo({ position: "left", group: leadPanel.group });
		leadPanel.api.setActive();
		open(worker("work-3"));
		expect(tree(api)).toEqual([[["work-2"], ["work-3"]], ["lead"], ["work-1"]]);
	});

	it("stacks the workers of a lead in a plain shell pane beside that pane", () => {
		const { api, open, openShell } = fixture();
		const other = open(agentFixture({ id: "other", name: "other" }));
		openShell("shell", other.id);
		other.api.setActive();
		// `dure run` in the shell records its Session, which no Agent owns.
		const shellWorker = (id: string) => ({
			...worker(id),
			runParent: { ...leadSession },
		});
		open(shellWorker("work-1"), other.id);
		open(shellWorker("work-2"), other.id);
		expect(tree(api)).toEqual([["other"], ["shell"], [["work-1"], ["work-2"]]]);
	});

	it("keeps ordinary placement for an Agent without a lead pane in this Space", () => {
		const { api, open } = fixture();
		const other = open(agentFixture({ id: "other", name: "other" }));
		open(worker("orphan"), other.id);
		open(agentFixture({ id: "plain", name: "plain" }), other.id);
		expect(tree(api)).toEqual([[["other"], ["plain"]], ["orphan"]]);
	});
});
