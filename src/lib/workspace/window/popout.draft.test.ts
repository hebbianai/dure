// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentChatDraftKey } from "@/lib/agents/chat/agentChatDraftStoreSlice";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import {
	extractPanelIdsFromLayout,
	panelsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import { popOutPanels } from "./popout";

vi.mock("@/lib/agents/chat/agentChatDraftMoveCoordinator", () => ({
	withAgentChatDraftMoves: (_items: unknown, _destination: unknown, commit: () => unknown) => commit(),
}));
const native = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./windows", () => ({ openPopoutWindow: native.open }));
const sourceId = "draft-source";
const panelId = "agent:popout-chat";
const profile = {
	schemaVersion: 1 as const,
	kind: "structured_protocol" as const,
	backendProfileId: "local",
	interactionSessionId: "popout-interaction",
};
const identity = { agentId: "popout-chat", ...profile };
const image = { fileName: "한글.png", dataB64: "cHJlc2VydmVkLWltYWdl" };
const cleanup: Array<() => void> = [];
function dock(): DockviewApi {
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
	cleanup.push(() => {
		unregisterDockview(sourceId, api);
		api.dispose();
		element.remove();
	});
	return api;
}
function draft() {
	return useStore.getState().chatDrafts[identity.agentId]?.[
		agentChatDraftKey(identity)
	];
}
beforeEach(() => {
	native.open.mockReset();
	useStore.setState({
		spaces: [{ id: sourceId, name: "Source" }],
		activeSpaceId: sourceId,
		layouts: {},
		projects: [],
		agents: [
			managedAgentFixture({
				id: identity.agentId,
				interactionProfile: profile,
			}),
		],
		chatDrafts: {},
	});
	useStore
		.getState()
		.updateChatDraft(identity, () => ({
			text: "작성 중인 초안",
			attachments: [image],
		}));
});
afterEach(() => {
	for (const stop of cleanup.splice(0).reverse()) stop();
});
function source() {
	const api = dock();
	api.addPanel({ id: panelId, component: "agent", title: "Chat", params: { agentRef: { agentId: identity.agentId } } });
	registerDockview(sourceId, api);
	useStore.getState().saveLayout(sourceId, api.toJSON());
	return api;
}
function creation() {
	let resolve!: (created: boolean) => void;
	native.open.mockReturnValue(
		new Promise<boolean>((accept) => {
			resolve = accept;
		}),
	);
	return (created: boolean) => resolve(created);
}

it("retains the mounted source and exact draft while destination creation is pending", async () => {
	const api = source();
	const original = api.getPanel(panelId);
	const before = useStore.getState().layouts[sourceId];
	const settle = creation();
	const pending = popOutPanels(sourceId, [panelId]);
	try {
		await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
		expect(api.getPanel(panelId)).toBe(original);
		expect(useStore.getState().layouts[sourceId]).toEqual(before);
		expect(draft()).toEqual({ text: "작성 중인 초안", attachments: [image] });
	} finally {
		settle(false);
		await pending;
	}
});

it("keeps the source editable and compensates only its empty staged Space after failed creation", async () => {
	const api = source();
	const original = api.getPanel(panelId);
	const before = useStore.getState().layouts[sourceId];
	native.open.mockResolvedValue(false);
	expect(await popOutPanels(sourceId, [panelId])).toBeNull();
	expect(api.getPanel(panelId)).toBe(original);
	expect(useStore.getState().layouts[sourceId]).toEqual(before);
	expect(useStore.getState().spaces.map((space) => space.id)).toEqual([
		sourceId,
	]);
	useStore
		.getState()
		.updateChatDraft(identity, (current) => ({
			...current,
			text: "계속 작성",
		}));
	expect(draft()).toEqual({ text: "계속 작성", attachments: [image] });
});

it("refuses to retire a source Dockview replaced during native creation", async () => {
	const api = source();
	const settle = creation();
	const pending = popOutPanels(sourceId, [panelId]);
	try {
		await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
		const replacement = dock();
		replacement.addPanel({ id: panelId, component: "agent", params: { agentRef: { agentId: identity.agentId } } });
		registerDockview(sourceId, replacement);
		useStore.getState().saveLayout(sourceId, replacement.toJSON());
		settle(true);
		expect(await pending).toBeNull();
		expect(replacement.getPanel(panelId)).toBeDefined();
		expect(draft()).toEqual({ text: "작성 중인 초안", attachments: [image] });
	} finally {
		settle(false);
		await pending;
	}
	expect(api.getPanel(panelId)).toBeDefined();
});

it("moves the fresh selected groups after creation while preserving intervening edits and source siblings", async () => {
	const api = source();
	api.addPanel({
		id: "term:selected",
		component: "terminal",
		position: { referencePanel: panelId, direction: "right" },
	});
	useStore.getState().saveLayout(sourceId, api.toJSON());
	const settle = creation();
	const pending = popOutPanels(sourceId, [panelId, "term:selected"]);
	try {
		await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
		expect(api.getPanel(panelId)).toBeDefined();
		api.getPanel(panelId)?.api.setTitle("Edited during creation");
		api.addPanel({ id: "term:keep", component: "terminal" });
		useStore
			.getState()
			.updateChatDraft(identity, (current) => ({
				...current,
				text: "한글 추가\n검토할 초안",
			}));
		const expected = extractPanelIdsFromLayout(
			api.toJSON(),
			new Set([panelId, "term:selected"]),
		);
		settle(true);
		const targetId = await pending;
		expect(targetId).not.toBeNull();
		expect(useStore.getState().layouts[targetId!]).toEqual(expected);
		expect(api.panels.map((panel) => panel.id)).toEqual(["term:keep"]);
		expect(
			panelsFromLayout(useStore.getState().layouts[sourceId]).map(
				(panel) => panel.id,
			),
		).toEqual(["term:keep"]);
		expect(draft()).toEqual({
			text: "한글 추가\n검토할 초안",
			attachments: [image],
		});
	} finally {
		settle(false);
		await pending;
	}
});

it("preserves concurrent content placed in the staged destination after creation fails", async () => {
	const api = source();
	const settle = creation();
	const pending = popOutPanels(sourceId, [panelId]);
	try {
		await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
		const targetId = native.open.mock.calls[0][0];
		const peer = dock();
		peer.addPanel({ id: "term:peer", component: "terminal" });
		useStore.getState().saveLayout(targetId, peer.toJSON());
		settle(false);
		expect(await pending).toBeNull();
		expect(
			useStore.getState().spaces.some((space) => space.id === targetId),
		).toBe(true);
		expect(
			panelsFromLayout(useStore.getState().layouts[targetId]).map(
				(panel) => panel.id,
			),
		).toEqual(["term:peer"]);
		expect(api.getPanel(panelId)).toBeDefined();
		expect(draft()).toEqual({ text: "작성 중인 초안", attachments: [image] });
	} finally {
		settle(false);
		await pending;
	}
});

it("refuses a changed conversation without moving its old draft into the new presentation", async () => {
	const api = source();
	const settle = creation();
	const pending = popOutPanels(sourceId, [panelId]);
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				interactionProfile: { ...profile, interactionSessionId: "replacement" },
			})),
		}));
		settle(true);
		expect(await pending).toBeNull();
		expect(api.getPanel(panelId)).toBeDefined();
		expect(draft()).toEqual({ text: "작성 중인 초안", attachments: [image] });
	} finally {
		settle(false);
		await pending;
		log.mockRestore();
	}
});
