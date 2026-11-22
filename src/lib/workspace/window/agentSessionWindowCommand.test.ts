import { describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import {
	type AgentSessionWindowCommandBackend,
	agentSessionWindowCredentialPort,
	agentSessionWindowViewPort,
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

	it("runs the large window's View moves in the exact source pane", async () => {
		const backend = transport();
		const execute = vi.fn(async (command: { action: string }) =>
			command.action === "set_native_view"
				? { kind: "view_set" as const }
				: { kind: "chat_handover" as const, outcome: "scheduled" as const },
		);
		const stop = subscribeAgentSessionWindowCommands(execute, backend);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);
		const port = agentSessionWindowViewPort(
			{
				agentId: "agent-1",
				sourceWindowLabel: "win-workspace-2",
				sourcePaneOwnerId: "desktop-2:agent:agent-1",
			},
			backend,
		);

		await port.setView("conversation");
		await expect(port.requestChat()).resolves.toEqual({
			kind: "chat_handover",
			outcome: "scheduled",
		});
		await port.applyChatNow();
		await port.cancelChat();

		expect(execute.mock.calls.map(([command]) => command)).toEqual([
			{
				action: "set_native_view",
				agentId: "agent-1",
				desktopId: "desktop-2",
				panelId: "agent:agent-1",
				view: "conversation",
			},
			...(["request", "apply_now", "cancel"] as const).map((step) => ({
				action: "chat_handover",
				agentId: "agent-1",
				desktopId: "desktop-2",
				panelId: "agent:agent-1",
				step,
			})),
		]);
		expect(backend.emitCommand).toHaveBeenCalledWith(
			"win-workspace-2",
			expect.objectContaining({ replyWindowLabel: "win-large-view" }),
		);
		stop();
	});

	it("sends nothing from a large window that lost its source pane", async () => {
		const backend = transport();
		const route = { agentId: "agent-1", sourceWindowLabel: "main" };

		await expect(
			agentSessionWindowViewPort(route, backend).requestChat(),
		).rejects.toThrow(t("workspace.agentWindow.sourcePaneMissing"));
		await expect(
			agentSessionWindowCredentialPort(route, backend).switch("account-2"),
		).rejects.toThrow(t("workspace.agentWindow.sourcePaneMissing"));
		expect(backend.emitCommand).not.toHaveBeenCalled();
	});

	it("rejects a View receipt of the wrong kind as uncertain", async () => {
		const backend = transport();
		const stop = subscribeAgentSessionWindowCommands(
			async () => ({ kind: "applied" as const }),
			backend,
		);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);

		await expect(
			agentSessionWindowViewPort(
				{
					agentId: "agent-1",
					sourceWindowLabel: "main",
					sourcePaneOwnerId: "desktop-1:agent:agent-1",
				},
				backend,
			).setView("terminal"),
		).rejects.toThrow("outcome is uncertain");
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
		commandListener?.({
			action: "set_native_view",
			agentId: "agent-1",
			generation: "generation-3",
			sourcePaneOwnerId: "desktop-1:agent:agent-1",
			replyWindowLabel: "win-large-view",
			view: "chat",
			expiresAtMs: 30,
		});
		commandListener?.({
			action: "chat_handover",
			agentId: "agent-1",
			generation: "generation-4",
			sourcePaneOwnerId: "desktop-1:agent:agent-1",
			replyWindowLabel: "win-large-view",
			step: "discard",
			expiresAtMs: 30,
		});

		expect(execute).not.toHaveBeenCalled();
		stop();
	});
});
