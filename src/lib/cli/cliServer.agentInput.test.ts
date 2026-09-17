import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import { startCliServer } from "./cliServer";

const mocks = vi.hoisted(() => ({
	listeners: new Map<
		string,
		(event: { event: string; id: number; payload: unknown }) => unknown
	>(),
	claim: vi.fn(),
	complete: vi.fn(),
	send: vi.fn(),
}));
vi.mock("@/lib/platform/tauriBridge", async (original) => ({
	...(await original<typeof import("@/lib/platform/tauriBridge")>()),
	listenWhenReady: async (
		name: string,
		callback: (event: {
			event: string;
			id: number;
			payload: unknown;
		}) => unknown,
	) => {
		mocks.listeners.set(name, callback);
		return () => {
			mocks.listeners.delete(name);
		};
	},
}));
vi.mock("@tauri-apps/api/webviewWindow", async (original) => ({
	...(await original<typeof import("@tauri-apps/api/webviewWindow")>()),
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("./cliServerObservers", () => ({
	startCliServerObservers: async () => () => {},
}));
vi.mock("./cliRequestBroker", () => ({
	claimCliRequest: mocks.claim,
	completeCliRequest: mocks.complete,
}));
vi.mock("@/lib/agents/chat/agentChatSessionRuntime", () => ({
	sendAgentChatMessage: mocks.send,
}));
vi.mock("@/lib/workspace/window/mountedPaneWindow", async (original) => ({
	...(await original<
		typeof import("@/lib/workspace/window/mountedPaneWindow")
	>()),
	resolveMountedPaneWindow: async (paneId: string) => ({
		schemaVersion: 1,
		paneId,
		desktopId: "chat-space",
		dockviewId: "dock-1",
		windowLabel: "main",
		windowGeneration: "main-generation",
	}),
	revalidateMountedPaneWindow: () => {},
}));
const profile = {
	schemaVersion: 1 as const,
	kind: "structured_protocol" as const,
	backendProfileId: "local",
	interactionSessionId: "interaction-entry",
};
const stops: Array<() => void> = [];
beforeEach(() => {
	mocks.listeners.clear();
	mocks.claim.mockReset().mockResolvedValue(true);
	mocks.complete.mockReset().mockResolvedValue(undefined);
	mocks.send.mockReset().mockResolvedValue({ delivery: "sent" });
	useStore.setState({
		agents: [
			managedAgentFixture({
				id: "entry-chat",
				sessionId: "entry-session",
				runtimeBinding: undefined,
				interactionProfile: profile,
			}),
		],
		spaces: [{ id: "chat-space", name: "Chat" }],
		layouts: { "chat-space": { panels: { "agent:entry-chat": {
			contentComponent: "agent", params: { agentRef: { agentId: "entry-chat" } },
		} } } },
		chatDrafts: {},
		projects: [],
	});
});
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	expect(mocks.listeners.has("cli:request")).toBe(false);
	expect(mocks.listeners.has("dure://pane-owner/request")).toBe(false);
});
it("preserves no-enter through the actual cli:request listener and completes a draft receipt without submitting", async () => {
	stops.push(await startCliServer());
	const listener = mocks.listeners.get("cli:request");
	expect(listener).toBeDefined();
	await listener?.({
		event: "cli:request",
		id: 1,
		payload: {
			reqId: "entry-request",
			action: "agent.input",
			params: {
				name: "entry-chat",
				sessionId: "entry-session",
				targetPanelId: "agent:entry-chat",
				expectedInteractionProfile: profile,
				text: "한글 초안",
				enter: false,
			},
		},
	});
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.complete).toHaveBeenCalledWith(
		"entry-request",
		expect.objectContaining({
			ok: true,
			input: expect.objectContaining({
				enter: false,
				receipt: { kind: "structured_chat", delivery: "drafted" },
			}),
		}),
		"agent.input",
	);
	expect(
		Object.values(useStore.getState().chatDrafts["entry-chat"])[0].text,
	).toBe("한글 초안");
});
