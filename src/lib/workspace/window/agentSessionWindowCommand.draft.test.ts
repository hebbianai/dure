// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareAgentChatDraftTarget } from "@/lib/agents/chat/agentChatDraftInput";
import { MAX_EXTERNAL_DROP_FILES } from "@/lib/files/externalFileDrop";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import {
	type AgentSessionWindowCommandBackend,
	requestAgentSessionDraftAppend,
	subscribeAgentSessionWindowCommands,
} from "./agentSessionWindowCommand";
import { executeAgentSessionWindowCommand } from "./agentSessionWindowCommandRuntime";
import { resolveMountedPaneWindow } from "./mountedPaneWindow";

const native = vi.hoisted(() => ({
	mounts: vi.fn(),
	moving: new Set<string>(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "win-100-2" }),
	getAllWebviewWindows: async () => [],
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (original) => ({
	...(await original<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	mountedDockviewEntries: native.mounts,
	movingPanels: native.moving,
}));
const profile = {
	schemaVersion: 1 as const,
	kind: "structured_protocol" as const,
	backendProfileId: "local",
	interactionSessionId: "interaction-channel",
};
const agent = () =>
	managedAgentFixture({
		id: "channel-chat",
		sessionId: "channel-session",
		interactionProfile: profile,
		runtimeBinding: undefined,
	});
const image = { fileName: "요소.png", dataB64: "cG5nLWJ5dGVz" };
const stops: Array<() => void> = [];
beforeEach(() => {
	native.moving.clear();
	native.mounts
		.mockReset()
		.mockReturnValue([["chat-space", { id: "dock-2", getPanel: () => ({}) }]]);
	useStore.setState({
		agents: [agent()],
		chatDrafts: {},
		projects: [
			{
				id: agent().projectId,
				name: "Chat",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		spaces: [{ id: "chat-space", name: "Chat" }],
		activeSpaceId: "chat-space",
		layouts: {
			"chat-space": {
				panels: { "agent:channel-chat": { component: "agent", params: {} } },
			},
		},
	});
});
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	vi.useRealTimers();
});

async function fixture(paneId = "agent:channel-chat") {
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
	const panel = api.addPanel({
		id: paneId,
		component: "agent",
		params: { agentRef: { agentId: agent().id } },
	});
	registerDockview("chat-space", api);
	native.mounts.mockReturnValue([["chat-space", api]]);
	useStore.setState({ layouts: { "chat-space": api.toJSON() } });
	stops.push(() => {
		unregisterDockview("chat-space", api);
		api.dispose();
		element.remove();
	});
	const owner = await resolveMountedPaneWindow(paneId, "win-100-2");
	let commandListener: ((payload: unknown) => void) | undefined;
	let resultListener: ((payload: unknown) => void) | undefined;
	const transport: AgentSessionWindowCommandBackend = {
		currentWindowLabel: () => "main",
		listenCommand: async (receive) => {
			commandListener = receive;
			return () => {
				commandListener = undefined;
			};
		},
		listenResult: async (receive) => {
			resultListener = receive;
			return () => {
				resultListener = undefined;
			};
		},
		emitCommand: vi.fn(async (label, payload) => {
			expect(label).toBe("win-100-2");
			commandListener?.(payload);
		}),
		emitResult: vi.fn(async (label, payload) => {
			expect(label).toBe("main");
			resultListener?.(payload);
		}),
	};
	stops.push(
		subscribeAgentSessionWindowCommands(
			executeAgentSessionWindowCommand,
			transport,
		),
	);
	await Promise.resolve();
	return {
		api,
		panel,
		transport,
		request: {
			target: prepareAgentChatDraftTarget(agent()),
			owner,
			text: "한글 캡처\n검토해 주세요.",
			attachments: [image],
		},
		resultListening: () => resultListener !== undefined,
	};
}

it.each(["agent:channel-chat", "pane:opaque-slot", "launcher:old-slot"])(
	"round-trips exact text/image bytes at current owner %s",
	async (paneId) => {
		const { transport, request, resultListening } = await fixture(paneId);
		useStore.getState().updateChatDraft(request.target.identity, () => ({
			text: "기존 초안",
			attachments: [],
		}));
		await expect(
			requestAgentSessionDraftAppend(request, transport),
		).resolves.toEqual({ kind: "drafted" });
		expect(
			Object.values(useStore.getState().chatDrafts[agent().id])[0],
		).toEqual({
			text: "기존 초안\n\n한글 캡처\n검토해 주세요.",
			attachments: [image],
		});
		expect(transport.emitCommand).toHaveBeenCalledTimes(1);
		expect(transport.emitResult).toHaveBeenCalledTimes(1);
		expect(resultListening()).toBe(false);
	},
);
it.each(["conversation", "pane", "generation"])(
	"refuses a changed %s at the receiving boundary without appending",
	async (change) => {
		const { transport, request } = await fixture();
		if (change === "conversation")
			useStore.setState({
				agents: [
					{
						...agent(),
						interactionProfile: {
							...profile,
							interactionSessionId: "replacement",
						},
					},
				],
			});
		if (change === "pane") native.mounts.mockReturnValue([]);
		if (change === "generation")
			request.owner = { ...request.owner, windowGeneration: "retired" };
		await expect(
			requestAgentSessionDraftAppend(request, transport),
		).rejects.toThrow(/changed/);
		expect(useStore.getState().chatDrafts).toEqual({});
		expect(transport.emitCommand).toHaveBeenCalledTimes(1);
	},
);
it("does not retry a successful append whose response was lost", async () => {
	const { transport, request, resultListening } = await fixture();
	vi.useFakeTimers();
	vi.mocked(transport.emitResult).mockImplementation(async () => {});
	const pending = expect(
		requestAgentSessionDraftAppend(request, transport),
	).rejects.toThrow("response timed out");
	await vi.advanceTimersByTimeAsync(120_001);
	await pending;
	expect(transport.emitCommand).toHaveBeenCalledTimes(1);
	expect(Object.values(useStore.getState().chatDrafts[agent().id])[0]).toEqual({
		text: request.text,
		attachments: [image],
	});
	expect(resultListening()).toBe(false);
});
it("rejects a malformed pane packet before sending", async () => {
	const { transport, request } = await fixture();
	await expect(
		requestAgentSessionDraftAppend(
			{ ...request, owner: { ...request.owner, paneId: "" } },
			transport,
		),
	).rejects.toThrow("invalid");
	expect(transport.emitCommand).not.toHaveBeenCalled();
	expect(useStore.getState().chatDrafts).toEqual({});
});

it.each([null, {}, { agentId: "replacement" }])(
	"does not append to an ID-named Agent through current reference %j",
	async (agentRef) => {
		const { transport, request, panel } = await fixture();
		const replacement = { ...agent(), id: "replacement" };
		useStore.setState({ agents: [agent(), replacement] });
		useStore.getState().updateChatDraft(request.target.identity, () => ({
			text: "Keep original",
			attachments: [image],
		}));
		useStore
			.getState()
			.updateChatDraft(
				prepareAgentChatDraftTarget(replacement).identity,
				() => ({ text: "Keep replacement", attachments: [] }),
			);
		const drafts = useStore.getState().chatDrafts;
		panel.api.updateParameters({ agentRef });
		await expect(
			requestAgentSessionDraftAppend(request, transport),
		).rejects.toThrow("recipient changed");
		expect(useStore.getState().chatDrafts).toBe(drafts);
	},
);

it.each(["terminal", "launcher"])(
	"refuses append when the same pane now contains %s",
	async (component) => {
		const { api, panel, request, transport } = await fixture();
		api.removePanel(panel);
		api.addPanel({
			id: request.owner.paneId,
			component,
			params: { agentRef: { agentId: agent().id } },
		});
		await expect(
			requestAgentSessionDraftAppend(request, transport),
		).rejects.toThrow("recipient changed");
		expect(useStore.getState().chatDrafts).toEqual({});
	},
);

it("rejects an existing different pane at the receiving boundary", async () => {
	const { api, request, transport } = await fixture();
	api.addPanel({
		id: "agent:other",
		component: "agent",
		params: { agentRef: { agentId: "other" } },
	});
	useStore.setState({
		agents: [agent(), { ...agent(), id: "other" }],
		layouts: { "chat-space": api.toJSON() },
	});
	await expect(
		requestAgentSessionDraftAppend(
			{ ...request, owner: { ...request.owner, paneId: "agent:other" } },
			transport,
		),
	).rejects.toThrow("recipient changed");
	expect(transport.emitCommand).toHaveBeenCalledTimes(1);
	expect(useStore.getState().chatDrafts).toEqual({});
});

it("rejects an unknown provider in an external draft packet before sending", async () => {
	const { transport, request } = await fixture();
	const packet = JSON.parse(JSON.stringify(request));
	packet.target.provider = "toString";
	await expect(
		requestAgentSessionDraftAppend(packet, transport),
	).rejects.toThrow("invalid");
	expect(transport.emitCommand).not.toHaveBeenCalled();
	expect(useStore.getState().chatDrafts).toEqual({});
});

it("does not report success or retry after receiving the wrong command receipt", async () => {
	const { transport, request, resultListening } = await fixture();
	const emitResult = transport.emitResult;
	transport.emitResult = vi.fn(async (label, payload) =>
		emitResult(label, { ...payload, ok: true, result: { kind: "presented" } }),
	);
	await expect(
		requestAgentSessionDraftAppend(request, transport),
	).rejects.toThrow("delivery is uncertain");
	expect(transport.emitCommand).toHaveBeenCalledTimes(1);
	expect(Object.values(useStore.getState().chatDrafts[agent().id])[0]).toEqual({
		text: request.text,
		attachments: [image],
	});
	expect(resultListening()).toBe(false);
});

it("ignores old and duplicate replies without delivering the append twice", async () => {
	const { transport, request, resultListening } =
		await fixture("pane:reply-slot");
	const emit = transport.emitResult;
	transport.emitResult = vi.fn(async (label, payload) => {
		await emit(label, {
			generation: "retired-request",
			ok: false,
			error: "Old failure",
		});
		await emit(label, payload);
		await emit(label, {
			generation: payload.generation,
			ok: false,
			error: "Duplicate failure",
		});
	});
	await expect(
		requestAgentSessionDraftAppend(request, transport),
	).resolves.toEqual({ kind: "drafted" });
	expect(transport.emitCommand).toHaveBeenCalledTimes(1);
	expect(Object.values(useStore.getState().chatDrafts[agent().id])[0]).toEqual({
		text: request.text,
		attachments: [image],
	});
	expect(resultListening()).toBe(false);
});

it("rejects a conflicting pane envelope without editing either draft", async () => {
	const { transport, request } = await fixture("pane:envelope-slot");
	const emit = transport.emitCommand;
	transport.emitCommand = vi.fn((label, payload) =>
		emit(label, { ...payload, sourcePaneOwnerId: "chat-space:pane:other" }),
	);
	await expect(
		requestAgentSessionDraftAppend(request, transport),
	).rejects.toThrow("identity is inconsistent");
	expect(useStore.getState().chatDrafts).toEqual({});
});

it("retains the attachment count boundary for a neutral pane ID", async () => {
	const { transport, request } = await fixture("pane:bounded-slot");
	await expect(
		requestAgentSessionDraftAppend(
			{
				...request,
				attachments: Array.from(
					{ length: MAX_EXTERNAL_DROP_FILES + 1 },
					() => image,
				),
			},
			transport,
		),
	).rejects.toThrow("invalid");
	expect(transport.emitCommand).not.toHaveBeenCalled();
	expect(useStore.getState().chatDrafts).toEqual({});
});
