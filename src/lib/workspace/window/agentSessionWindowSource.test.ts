// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntimeStateBackend,
	type AgentSessionSourceBackend,
	agentSessionSourceIsOpen,
	agentSessionSourceFromSearch,
	currentAgentSessionSource,
	publishAgentSessionSource,
	publishAgentSessionRuntimeState,
	setAgentSessionSourceOpen,
	subscribeAgentSessionRuntimeState,
	subscribeAgentSessionSource,
} from "./agentSessionWindowSource";

beforeEach(() => localStorage.clear());

describe("Agent session source", () => {
	it("reads the exact opener and keeps main as the legacy default", () => {
		expect(agentSessionSourceFromSearch("")).toEqual({ windowLabel: "main" });
		expect(
			agentSessionSourceFromSearch(
				"?sessionWindow=agent-1&sourceWindow=win-workspace-2&sourcePane=desktop-2%3Aagent%3A1",
			),
		).toEqual({
			windowLabel: "win-workspace-2",
			paneOwnerId: "desktop-2:agent:1",
		});
	});

	it("publishes and remembers the exact pane that reused the large view", async () => {
		const transport: AgentSessionSourceBackend = {
			emitChanged: vi.fn(async () => {}),
			listenChanged: vi.fn(async () => vi.fn()),
		};
		const source = {
			windowLabel: "win-workspace-2",
			paneOwnerId: "desktop-2:agent:1",
		};

		await publishAgentSessionSource(
			"win-session-agent-1",
			"agent-1",
			source,
			transport,
		);

		expect(transport.emitChanged).toHaveBeenCalledWith("win-session-agent-1", {
			agentId: "agent-1",
			sourceWindowLabel: "win-workspace-2",
			sourcePaneOwnerId: "desktop-2:agent:1",
		});
		expect(
			currentAgentSessionSource("agent-1", { windowLabel: "main" }),
		).toEqual(source);
	});

	it("relays the large-view Host activity to its source window", async () => {
		let listener: ((payload: unknown) => void) | undefined;
		const unlisten = vi.fn();
		const transport: AgentSessionRuntimeStateBackend = {
			emitState: vi.fn(async () => {}),
			listenState: vi.fn(async (nextListener) => {
				listener = nextListener;
				return unlisten;
			}),
		};
		const state = {
			terminalEpoch: "terminal-1",
			revision: "3",
			observedThroughOutputSeq: "11",
			lifecycle: "running" as const,
			activity: "working" as const,
			attention: "none" as const,
			source: "controller_input" as const,
		};

		await publishAgentSessionRuntimeState(
			"main",
			"session-1",
			state,
			transport,
		);
		expect(transport.emitState).toHaveBeenCalledWith("main", {
			sessionId: "session-1",
			state,
		});

		const received = vi.fn();
		const dispose = subscribeAgentSessionRuntimeState(received, transport);
		await vi.waitFor(() => expect(listener).toBeTypeOf("function"));
		listener?.({ sessionId: "session-1", state });
		expect(received).toHaveBeenCalledWith("session-1", state);
		dispose();
		expect(unlisten).toHaveBeenCalledOnce();
	});

	it("ignores another Agent and accepts the matching live source update", async () => {
		let listener: ((payload: unknown) => void) | undefined;
		const unlisten = vi.fn();
		const transport: AgentSessionSourceBackend = {
			emitChanged: vi.fn(async () => {}),
			listenChanged: vi.fn(async (nextListener) => {
				listener = nextListener;
				return unlisten;
			}),
		};
		const changed = vi.fn();
		const dispose = subscribeAgentSessionSource("agent-1", changed, transport);
		await vi.waitFor(() => expect(listener).toBeTypeOf("function"));

		listener?.({ agentId: "agent-2", sourceWindowLabel: "win-wrong" });
		listener?.({
			agentId: "agent-1",
			sourceWindowLabel: "win-workspace-3",
			sourcePaneOwnerId: "desktop-3:agent:1",
		});

		expect(changed).toHaveBeenCalledOnce();
		expect(changed).toHaveBeenCalledWith({
			windowLabel: "win-workspace-3",
			paneOwnerId: "desktop-3:agent:1",
		});
		dispose();
		expect(unlisten).toHaveBeenCalledOnce();
	});

	it("projects active presence only onto the exact source pane", () => {
		const source = {
			windowLabel: "main",
			paneOwnerId: "desktop-1:agent:1",
		};
		setAgentSessionSourceOpen("agent-1", source, true);

		expect(agentSessionSourceIsOpen("agent-1", source)).toBe(true);
		expect(
			agentSessionSourceIsOpen("agent-1", {
				windowLabel: "win-workspace-2",
				paneOwnerId: source.paneOwnerId,
			}),
		).toBe(false);
		expect(
			agentSessionSourceIsOpen("agent-1", {
				windowLabel: source.windowLabel,
				paneOwnerId: "desktop-1:agent:2",
			}),
		).toBe(false);

		setAgentSessionSourceOpen("agent-1", source, false);
		expect(agentSessionSourceIsOpen("agent-1", source)).toBe(false);
	});
});
