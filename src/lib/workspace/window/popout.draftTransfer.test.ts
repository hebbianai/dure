// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
	agentChatDraftKey,
	createAgentChatDraftStoreSlice,
} from "@/lib/agents/chat/agentChatDraftStoreSlice";
import { recoverAgentChatDraftMove } from "@/lib/agents/chat/agentChatDraftMoveRecovery";
import { movePanelsToDesktop } from "@/lib/workspace/dock";
import {
	movingPanels,
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import type { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import { subscribeAgentSessionWindowCommands } from "./agentSessionWindowCommand";
import { executeAgentSessionWindowCommand } from "./agentSessionWindowCommandRuntime";
import { mountedWindowGeneration } from "./mountedWindowIdentity";
import { popOutPanels, returnPopoutPanels } from "./popout";

type State = ReturnType<typeof useStore.getState>;
const context = vi.hoisted(() => ({
	label: "main",
	destinationLabel: "",
	destinationId: "",
	source: null as unknown as typeof useStore,
	destination: null as unknown as StoreApi<State>,
	destinationApi: null as unknown as DockviewApi,
	listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
	commands: [] as Array<{ step: string; transfer: { id: string } }>,
	closed: vi.fn(),
	drop: "",
	afterStage: null as null | (() => void),
	afterRecovery: null as null | (() => void),
	open: vi.fn(),
}));
vi.mock("@/store", async (original) => {
	const actual = await original<typeof import("@/store")>();
	context.source = actual.useStore;
	const current = () =>
		context.label === "main" ? actual.useStore : context.destination;
	return {
		...actual,
		useStore: Object.assign(
			(...args: Parameters<typeof useStore>) => actual.useStore(...args),
			{
				getState: () => current().getState(),
				setState: (...args: Parameters<typeof useStore.setState>) =>
					current().setState(...args),
			},
		),
	};
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: context.label }),
	getAllWebviewWindows: async () => [{ label: context.label }],
}));
vi.mock("./windows", () => ({
	openPopoutWindow: context.open,
	initialDesktopId: () => null,
	initialPopoutDesktopId: () => "source",
}));
vi.mock("@tauri-apps/api/window", async (original) => ({
	...(await original<typeof import("@tauri-apps/api/window")>()),
	getCurrentWindow: () => ({ close: context.closed }),
}));
vi.mock("./mountedWorkspaceWindow", async (original) => ({
	...(await original<typeof import("./mountedWorkspaceWindow")>()),
	resolveReadyWorkspaceWindow: async () => ({
		schemaVersion: 1,
		desktopId: context.destinationId,
		dockviewId: context.destinationApi.id,
		windowLabel: context.destinationLabel,
		windowGeneration: mountedWindowGeneration,
	}),
	resolveMountedWorkspaceWindow: async () => ({
		schemaVersion: 1,
		desktopId: context.destinationId,
		dockviewId: context.destinationApi.id,
		windowLabel: context.destinationLabel,
		windowGeneration: mountedWindowGeneration,
	}),
	waitForMountedWorkspaceWindow: async () => ({
		schemaVersion: 1,
		desktopId: context.destinationId,
		dockviewId: context.destinationApi.id,
		windowLabel: context.destinationLabel,
		windowGeneration: mountedWindowGeneration,
	}),
}));
vi.mock("@/lib/platform/tauriBridge", async (original) => ({
	...(await original<typeof import("@/lib/platform/tauriBridge")>()),
	listenWhenReady: async (
		event: string,
		callback: (event: { payload: unknown }) => void,
	) => {
		const key = `${context.label}:${event}`;
		const listeners = context.listeners.get(key) ?? new Set();
		context.listeners.set(key, listeners);
		listeners.add(callback);
		return () => listeners.delete(callback);
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	emit: async () => {},
	listen: async () => () => {},
	emitTo: async (
		target: { label: string },
		event: string,
		payload: Record<string, unknown>,
	) => {
		if (event.endsWith("/source-command")) {
			context.commands.push(
				payload as unknown as (typeof context.commands)[number],
			);
			context.label = target.label;
		}
		if (event.endsWith("/source-command-result")) {
			context.label = "main";
			if (context.commands[context.commands.length - 1]?.step === "stage")
				context.afterStage?.();
			if (
				context.drop === "all" ||
				context.commands[context.commands.length - 1]?.step === context.drop
			)
				return;
		}
		for (const receive of context.listeners.get(`${target.label}:${event}`) ??
			[])
			receive({ payload });
	},
}));
vi.mock("@/lib/persistence/currentDurableProjectionRecovery", () => ({
	recoverCurrentDurableStoreProjection: async () => {
		const source = context.source.getState();
		context.destination.setState({
			layouts: source.layouts,
			spaces: source.spaces,
		});
		context.destinationApi.fromJSON(
			source.layouts[context.destinationId] as Parameters<
				DockviewApi["fromJSON"]
			>[0],
			{ reuseExistingPanels: true },
		);
		context.afterRecovery?.();
		return true;
	},
}));
const identity = {
	agentId: "transfer-chat",
	backendProfileId: "local",
	interactionSessionId: "transfer-conversation",
};
const panelId = `agent:${identity.agentId}`;
const key = agentChatDraftKey(identity);
const image = { fileName: "초안.png", dataB64: "aW1hZ2UtYnl0ZXM=" };
const cleanups: Array<() => void> = [];
function dock(id: string) {
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
	registerDockview(id, api);
	cleanups.push(() => {
		unregisterDockview(id, api);
		api.dispose();
		element.remove();
	});
	return api;
}
beforeEach(() => {
	context.label = "main";
	context.commands = [];
	context.listeners.clear();
	context.drop = "";
	context.afterStage = null;
	context.afterRecovery = null;
	movingPanels.clear();
	context.closed.mockReset().mockResolvedValue(undefined);
	context.source.setState({
		spaces: [{ id: "source", name: "Source" }],
		activeSpaceId: "source",
		layouts: {},
		projects: [],
		agents: [
			managedAgentFixture({
				id: identity.agentId,
				interactionProfile: {
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: identity.backendProfileId,
					interactionSessionId: identity.interactionSessionId,
				},
			}),
		],
		chatDrafts: {},
		chatDraftMoves: {},
		chatDraftMoveReceipts: {},
		chatDraftEpochs: {},
	});
	context.source.getState().updateChatDraft(identity, () => ({
		text: "한글 초안\n ",
		attachments: [image],
	}));
	context.open.mockReset().mockImplementation(async (id: string) => {
		context.destinationId = id;
		context.destinationLabel = `win-popout-${id}`;
		context.destinationApi = dock(id);
		context.destination = createStore<State>((set) => ({
			...context.source.getState(),
			...createAgentChatDraftStoreSlice(set),
			activeSpaceId: id,
		}));
		context.label = context.destinationLabel;
		cleanups.push(
			subscribeAgentSessionWindowCommands(executeAgentSessionWindowCommand),
		);
		await Promise.resolve();
		context.label = "main";
		return true;
	});
});
afterEach(() => {
	context.label = "main";
	for (const stop of cleanups.splice(0).reverse()) stop();
	movingPanels.clear();
	vi.useRealTimers();
});
function source(
	id = panelId,
	params: Record<string, unknown> = { agentRef: { agentId: identity.agentId } },
	component = "agent",
) {
	const api = dock("source");
	api.addPanel({ id, component, title: "Chat", params });
	context.source.getState().saveLayout("source", api.toJSON());
	return api;
}

it("popout transfers exact text/images through the actual command parser/runtime into an independent destination store", async () => {
	const api = source();
	const before = context.source.getState().chatDrafts[identity.agentId];
	const id = await popOutPanels("source", [panelId]);
	expect(id).toBe(context.destinationId);
	expect(context.destination.getState().chatDrafts[identity.agentId]).toEqual(
		before,
	);
	expect(
		context.source.getState().chatDrafts[identity.agentId],
	).toBeUndefined();
	expect(api.getPanel(panelId)).toBeUndefined();
	expect(context.destinationApi.getPanel(panelId)).toBeDefined();
	expect(context.commands.map((command) => command.step)).toEqual([
		"stage",
		"commit",
	]);
	expect(
		new Set(context.commands.map((command) => command.transfer.id)).size,
	).toBe(1);
	context.destination
		.getState()
		.updateChatDraft(identity, (draft) => ({ ...draft, text: "새 창의 편집" }));
	expect(
		context.destination.getState().chatDrafts[identity.agentId][key].text,
	).toBe("새 창의 편집");
});

it.each(["pane:opaque", "launcher:slot", "agent:old-owner"])(
	"popout transfers the current reference behind %s",
	async (id) => {
		const api = source(id, { agentRef: { agentId: identity.agentId } });
		const before = context.source.getState().chatDrafts[identity.agentId];
		expect(await popOutPanels("source", [id])).toBe(context.destinationId);
		expect(context.destination.getState().chatDrafts[identity.agentId]).toEqual(
			before,
		);
		expect(
			context.source.getState().chatDrafts[identity.agentId],
		).toBeUndefined();
		expect(api.getPanel(id)).toBeUndefined();
		expect(context.destinationApi.getPanel(id)!.params?.agentRef).toEqual({
			agentId: identity.agentId,
		});
		expect(context.commands.map((command) => command.step)).toEqual([
			"stage",
			"commit",
		]);
	},
);

it.each([null, {}, { agentId: "" }, { agentId: "missing" }])(
	"does not guess a chat recipient for explicit reference %j",
	async (agentRef) => {
		source(panelId, { agentRef });
		const before = context.source.getState().chatDrafts[identity.agentId];
		expect(await popOutPanels("source", [panelId])).toBe(context.destinationId);
		expect(context.source.getState().chatDrafts[identity.agentId]).toBe(before);
		expect(context.destination.getState().chatDrafts).toEqual({});
		expect(context.commands).toEqual([]);
	},
);

it.each(["before-stage", "after-stage"])(
	"preserves the source when its pane reference changes %s",
	async (phase) => {
		const api = source();
		const retarget = () =>
			api
				.getPanel(panelId)!
				.api.updateParameters({ agentRef: { agentId: "replacement" } });
		if (phase === "after-stage") context.afterStage = retarget;
		else {
			const open = context.open.getMockImplementation()!;
			context.open.mockImplementation(async (id: string) => {
				const opened = await open(id);
				retarget();
				return opened;
			});
		}
		const before = context.source.getState().chatDrafts[identity.agentId];
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await popOutPanels("source", [panelId])).toBeNull();
			expect(api.getPanel(panelId)).toBeDefined();
			expect(context.source.getState().chatDrafts[identity.agentId]).toBe(
				before,
			);
			expect(context.source.getState().chatDraftMoves).toEqual({});
			expect(context.destination.getState().chatDrafts).toEqual({});
			expect(context.commands.map((command) => command.step)).toEqual(
				phase === "after-stage" ? ["stage", "abort"] : [],
			);
		} finally {
			log.mockRestore();
		}
	},
);

it("does not remove the source if its conversation changes after staging, and releases the unchanged draft after abort acknowledgement", async () => {
	const api = source();
	context.afterStage = () =>
		context.source.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				sessionId: "replacement",
			})),
		}));
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await popOutPanels("source", [panelId])).toBeNull();
		expect(api.getPanel(panelId)).toBeDefined();
		expect(context.source.getState().chatDrafts[identity.agentId][key]).toEqual(
			{ text: "한글 초안\n ", attachments: [image] },
		);
		expect(context.source.getState().chatDraftMoves).toEqual({});
		expect(context.destination.getState().chatDrafts).toEqual({});
		expect(context.commands.map((command) => command.step)).toEqual([
			"stage",
			"abort",
		]);
	} finally {
		log.mockRestore();
	}
});

it("retains a locked source copy after a committed destination response is lost without resending the move", async () => {
	source();
	context.drop = "commit";
	vi.useFakeTimers();
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const pending = popOutPanels("source", [panelId]);
	try {
		await vi.waitFor(() =>
			expect(context.commands.map((command) => command.step)).toContain(
				"commit",
			),
		);
		await vi.advanceTimersByTimeAsync(120_001);
		expect(await pending).toBeNull();
		expect(
			context.source.getState().chatDrafts[identity.agentId][key].text,
		).toBe("한글 초안\n ");
		expect(
			context.destination.getState().chatDrafts[identity.agentId][key].text,
		).toBe("한글 초안\n ");
		expect(() =>
			context.source.getState().updateChatDraft(identity, (draft) => draft),
		).toThrow("moving");
		context.destination.getState().updateChatDraft(identity, (draft) => ({
			...draft,
			text: "수신 후 편집",
		}));
		expect(context.commands.map((command) => command.step)).toEqual([
			"stage",
			"commit",
		]);
		expect(
			context.source
				.getState()
				.spaces.some((space) => space.id === context.destinationId),
		).toBe(true);
	} finally {
		await vi.advanceTimersByTimeAsync(240_001);
		await pending;
		log.mockRestore();
	}
});

it("keeps staged bytes inert if the destination pane was retargeted, then recovers the same transfer", async () => {
	const id = panelId;
	source(id, { agentRef: { agentId: identity.agentId } });
	context.afterRecovery = () =>
		context.destinationApi
			.getPanel(id)!
			.api.updateParameters({ agentRef: { agentId: "replacement" } });
	const before = context.source.getState().chatDrafts[identity.agentId];
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await popOutPanels("source", [id])).toBeNull();
		expect(context.source.getState().chatDrafts[identity.agentId]).toBe(before);
		expect(context.destination.getState().chatDrafts).toEqual({});
		expect(() =>
			context.source.getState().updateChatDraft(identity, (draft) => draft),
		).toThrow("moving");
		const { transfer } =
			context.source.getState().chatDraftMoves[identity.agentId];
		expect(
			context.destination.getState().chatDraftMoveReceipts[transfer.id].status,
		).toBe("staged");
		context.afterRecovery = null;
		const receipt = await recoverAgentChatDraftMove({
			transfer,
			intent: "finish",
		});
		expect(receipt.status).toBe("committed");
		expect(context.destination.getState().chatDrafts[identity.agentId]).toEqual(
			before,
		);
		expect(
			context.source.getState().chatDrafts[identity.agentId],
		).toBeUndefined();
		expect(
			new Set(context.commands.map((command) => command.transfer.id)),
		).toEqual(new Set([transfer.id]));
	} finally {
		log.mockRestore();
	}
});

it.each([panelId, "pane:opaque"])(
	"ordinary source-initiated moves transfer %s before removing the source pane",
	async (id) => {
		const api = source(id, { agentRef: { agentId: identity.agentId } });
		context.source.setState((state) => ({
			spaces: [...state.spaces, { id: "target", name: "Target" }],
		}));
		await context.open("target");
		const receipt = await movePanelsToDesktop(
			[{ panelId: id, fromDesktopId: "source" }],
			"target",
		);
		expect(receipt.movedPanelIds).toEqual([id]);
		expect(
			context.destination.getState().chatDrafts[identity.agentId][key],
		).toEqual({ text: "한글 초안\n ", attachments: [image] });
		expect(
			context.source.getState().chatDrafts[identity.agentId],
		).toBeUndefined();
		expect(api.getPanel(id)).toBeUndefined();
		expect(context.commands.map((command) => command.step)).toEqual([
			"stage",
			"commit",
		]);
	},
);

it("return popout awaits the destination draft receipt before removing its Space and closing the source window", async () => {
	source();
	context.source.setState({
		spaces: [
			{ id: "source", name: "Popout", kind: "popout", originSpaceId: "origin" },
			{ id: "origin", name: "Origin" },
		],
	});
	await context.open("origin");
	context.closed.mockImplementation(async () => {
		expect(
			context.destination.getState().chatDrafts[identity.agentId][key],
		).toEqual({ text: "한글 초안\n ", attachments: [image] });
		expect(
			context.source.getState().chatDrafts[identity.agentId],
		).toBeUndefined();
		expect(context.commands.map((command) => command.step)).toEqual([
			"stage",
			"commit",
		]);
	});
	expect(await returnPopoutPanels("source")).toBe(true);
	expect(context.closed).toHaveBeenCalledOnce();
	expect(
		context.source.getState().spaces.some((space) => space.id === "source"),
	).toBe(false);
});

it.each(["stage", "all"])(
	"keeps source data when %s responses are lost and retains an unresolved destination for recovery",
	async (drop) => {
		const api = source();
		context.drop = drop;
		vi.useFakeTimers();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const pending = popOutPanels("source", [panelId]);
		try {
			await vi.waitFor(() =>
				expect(context.commands.map((command) => command.step)).toContain(
					"stage",
				),
			);
			await vi.advanceTimersByTimeAsync(240_002);
			expect(await pending).toBeNull();
			expect(api.getPanel(panelId)).toBeDefined();
			expect(
				context.source.getState().chatDrafts[identity.agentId][key],
			).toEqual({ text: "한글 초안\n ", attachments: [image] });
			expect(context.destination.getState().chatDrafts).toEqual({});
			expect(context.commands.map((command) => command.step)).toEqual([
				"stage",
				"abort",
			]);
			expect(
				Boolean(context.source.getState().chatDraftMoves[identity.agentId]),
			).toBe(drop === "all");
			expect(
				context.source
					.getState()
					.spaces.some((space) => space.id === context.destinationId),
			).toBe(drop === "all");
		} finally {
			await vi.advanceTimersByTimeAsync(240_001);
			await pending;
			log.mockRestore();
		}
	},
);
