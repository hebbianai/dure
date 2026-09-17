// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import {
	agentForChatPane,
	prepareAgentChatDraftTarget,
	revalidateAgentChatDraftTarget,
} from "./agentChatDraftInput";

const owner = { desktopId: "source", panelId: "agent:original" };
const agents = ["original", "current"].map((id) =>
	managedAgentFixture({
		id,
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: `chat-${id}`,
		},
	}),
);
const cleanups: Array<() => void> = [];
beforeEach(() =>
	useStore.setState({
		agents,
		projects: [],
		spaces: [{ id: owner.desktopId, name: "Source" }],
		layouts: {},
	}),
);
afterEach(() => {
	for (const stop of cleanups.splice(0).reverse()) stop();
});
function dock() {
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
			dispose() {},
		}),
	});
	api.layout(800, 600);
	registerDockview(owner.desktopId, api);
	cleanups.push(() => {
		unregisterDockview(owner.desktopId, api);
		api.dispose();
		element.remove();
	});
	return api;
}
function saveReference(agentRef: unknown) {
	useStore.setState({
		layouts: {
			[owner.desktopId]: {
				panels: {
					[owner.panelId]: { contentComponent: "agent", params: { agentRef } },
				},
			},
		},
	});
}

it("selects merged model parameters, then follows a current reference update instead of the saved projection", () => {
	saveReference({ agentId: "original" });
	const api = dock();
	const panel = api.addPanel({
		id: owner.panelId,
		component: "agent",
		params: { agentRef: { agentId: "current" } },
	});
	panel.api.updateParameters({ titleHint: "unrelated update" });
	expect(agentForChatPane(owner)).toBe(agents[1]);
	expect(
		revalidateAgentChatDraftTarget(
			prepareAgentChatDraftTarget(agents[1]),
			owner,
		),
	).toBe(agents[1]);
	panel.api.updateParameters({ agentRef: { agentId: "original" } });
	expect(agentForChatPane(owner)).toBe(agents[0]);
	expect(() =>
		revalidateAgentChatDraftTarget(
			prepareAgentChatDraftTarget(agents[1]),
			owner,
		),
	).toThrow("recipient changed");
});

it("uses the saved reference only while the source Space is unmounted", () => {
	saveReference({ agentId: "current" });
	expect(agentForChatPane(owner)).toBe(agents[1]);
	dock();
	expect(agentForChatPane(owner)).toBeUndefined();
	expect(() =>
		revalidateAgentChatDraftTarget(
			prepareAgentChatDraftTarget(agents[1]),
			owner,
		),
	).toThrow("recipient changed");
});

it.each(["terminal", "launcher", "unknown"])(
	"does not infer a chat from %s content or its stale Agent parameters",
	(component) => {
		saveReference({ agentId: "original" });
		dock().addPanel({
			id: owner.panelId,
			component,
			params: { agentRef: { agentId: "current" } },
		});
		expect(agentForChatPane(owner)).toBeUndefined();
		expect(() =>
			revalidateAgentChatDraftTarget(
				prepareAgentChatDraftTarget(agents[0]),
				owner,
			),
		).toThrow("recipient changed");
	},
);

it.each([null, {}, { agentId: "" }, { agentId: "missing" }])(
	"never guesses through explicit reference %j",
	(agentRef) => {
		saveReference(agentRef);
		expect(agentForChatPane(owner)).toBeUndefined();
		dock().addPanel({
			id: owner.panelId,
			component: "agent",
			params: { agentRef },
		});
		expect(agentForChatPane(owner)).toBeUndefined();
		expect(() =>
			revalidateAgentChatDraftTarget(
				prepareAgentChatDraftTarget(agents[0]),
				owner,
			),
		).toThrow("recipient changed");
	},
);

it("preserves legacy Agent content after saved-layout normalization", () => {
	const api = dock();
	api.addPanel({ id: owner.panelId, component: "agent" });
	expect(agentForChatPane(owner)).toBeUndefined();
	api.fromJSON(
		normalizePersistedPaneLayout(api.toJSON()) as ReturnType<typeof api.toJSON>,
	);
	expect(agentForChatPane(owner)).toBe(agents[0]);
});

it("does not stage structured drafts for a terminal-profile Agent", () => {
	useStore.setState({ agents: [managedAgentFixture({ id: "original" })] });
	dock().addPanel({
		id: owner.panelId,
		component: "agent",
		params: { agentRef: { agentId: "original" } },
	});
	expect(agentForChatPane(owner)).toBeUndefined();
});
