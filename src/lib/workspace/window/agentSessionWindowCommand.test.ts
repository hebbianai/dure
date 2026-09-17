import { describe, expect, it, vi } from "vitest";
import {
	type AgentSessionWindowCommandBackend,
	requestAgentSessionCredentialCommand,
	requestAgentSessionForkPresentation,
	subscribeAgentSessionWindowCommands,
} from "./agentSessionWindowCommand";

function transport() {
	let commandListener: ((payload: unknown) => void) | undefined;
	let resultListener: ((payload: unknown) => void) | undefined;
	const backend: AgentSessionWindowCommandBackend = {
		currentWindowLabel: () => "win-large-view",
		listenCommand: vi.fn(async (listener) => {
			commandListener = listener;
			return vi.fn();
		}),
		listenResult: vi.fn(async (listener) => {
			resultListener = listener;
			return vi.fn();
		}),
		emitCommand: vi.fn(async (_targetWindowLabel, payload) => {
			commandListener?.(payload);
		}),
		emitResult: vi.fn(async (_targetWindowLabel, payload) => {
			resultListener?.(payload);
		}),
	};
	return backend;
}

describe("large-view source command routing", () => {
	it("executes an account switch in the exact source pane", async () => {
		const backend = transport();
		const execute = vi.fn(async () => ({
			kind: "completed" as const,
			conversationId: "conversation-1",
		}));
		const stop = subscribeAgentSessionWindowCommands(
			execute,
			backend,
			() => 10,
		);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);

		await expect(
			requestAgentSessionCredentialCommand(
				{
					action: "switch",
					agentId: "agent-1",
					targetCredentialId: "account-2",
					sourceWindowLabel: "win-workspace-2",
					sourcePaneOwnerId: "desktop-2:agent:agent-1",
				},
				backend,
				() => 10,
			),
		).resolves.toEqual({
			kind: "completed",
			conversationId: "conversation-1",
		});
		expect(backend.emitCommand).toHaveBeenCalledWith(
			"win-workspace-2",
			expect.objectContaining({
				action: "switch",
				replyWindowLabel: "win-large-view",
				sourcePaneOwnerId: "desktop-2:agent:agent-1",
			}),
		);
		expect(execute).toHaveBeenCalledWith({
			action: "switch",
			agentId: "agent-1",
			desktopId: "desktop-2",
			panelId: "agent:agent-1",
			targetCredentialId: "account-2",
		});
		stop();
	});

	it("presents a fork in the exact desktop owned by the source pane", async () => {
		const backend = transport();
		const execute = vi.fn(async () => ({ kind: "presented" as const }));
		const stop = subscribeAgentSessionWindowCommands(
			execute,
			backend,
			() => 10,
		);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);

		await expect(
			requestAgentSessionForkPresentation(
				{
					agentId: "agent-1",
					forkedAgentId: "agent-fork",
					sourceWindowLabel: "win-workspace-2",
					sourcePaneOwnerId: "desktop-2:agent:agent-1",
				},
				backend,
				() => 10,
			),
		).resolves.toEqual({ kind: "presented" });
		expect(backend.emitCommand).toHaveBeenCalledWith(
			"win-workspace-2",
			expect.objectContaining({
				action: "present_fork",
				forkedAgentId: "agent-fork",
				replyWindowLabel: "win-large-view",
				sourcePaneOwnerId: "desktop-2:agent:agent-1",
			}),
		);
		expect(execute).toHaveBeenCalledWith({
			action: "present_fork",
			agentId: "agent-1",
			desktopId: "desktop-2",
			panelId: "agent:agent-1",
			forkedAgentId: "agent-fork",
		});
		stop();
	});

	it("returns the source-window failure without replacing it with a local pane error", async () => {
		const backend = transport();
		const stop = subscribeAgentSessionWindowCommands(
			async () => {
				throw new Error("source credential inspection failed");
			},
			backend,
			() => 10,
		);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);

		await expect(
			requestAgentSessionCredentialCommand(
				{
					action: "apply_pending",
					agentId: "agent-1",
					sourceWindowLabel: "main",
					sourcePaneOwnerId: "desktop-1:agent:agent-1",
				},
				backend,
				() => 10,
			),
		).rejects.toThrow("source credential inspection failed");
		stop();
	});

	it("returns the source authority's Agent mismatch without deciding from the pane ID", async () => {
		const backend = transport();
		const execute = vi.fn(async () => {
			throw new Error("credential command source Agent mismatch");
		});
		const stop = subscribeAgentSessionWindowCommands(
			execute,
			backend,
			() => 10,
		);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);

		await expect(
			requestAgentSessionCredentialCommand(
				{
					action: "switch",
					agentId: "agent-1",
					targetCredentialId: "account-2",
					sourceWindowLabel: "main",
					sourcePaneOwnerId: "desktop-1:agent:agent-2",
				},
				backend,
				() => 10,
			),
		).rejects.toThrow("credential command source Agent mismatch");
		expect(execute).toHaveBeenCalledWith({
			action: "switch",
			agentId: "agent-1",
			desktopId: "desktop-1",
			panelId: "agent:agent-2",
			targetCredentialId: "account-2",
		});
		stop();
	});

	it("ignores expired and malformed source requests", async () => {
		let commandListener: ((payload: unknown) => void) | undefined;
		const backend = transport();
		backend.listenCommand = vi.fn(async (listener) => {
			commandListener = listener;
			return vi.fn();
		});
		const execute = vi.fn(async () => ({ kind: "applied" as const }));
		const stop = subscribeAgentSessionWindowCommands(
			execute,
			backend,
			() => 20,
		);
		await vi.waitFor(() => expect(commandListener).toBeTypeOf("function"));

		commandListener?.({
			action: "apply_pending",
			agentId: "agent-1",
			generation: "generation-1",
			sourcePaneOwnerId: "desktop-1:agent:agent-1",
			replyWindowLabel: "win-large-view",
			expiresAtMs: 20,
		});
		commandListener?.({
			action: "switch",
			agentId: "agent-1",
			generation: "generation-2",
			sourcePaneOwnerId: "not-a-pane-owner",
			replyWindowLabel: "win-large-view",
			targetCredentialId: "account-2",
			expiresAtMs: 30,
		});

		expect(execute).not.toHaveBeenCalled();
		stop();
	});
});
