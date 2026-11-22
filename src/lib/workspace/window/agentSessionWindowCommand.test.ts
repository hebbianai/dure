import { describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import {
	type AgentSessionWindowCommandBackend,
	agentSessionWindowCredentialPort,
	agentSessionWindowLaunchSelection,
	agentSessionWindowProjectMovePort,
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

const sourceRoute = {
	agentId: "agent-1",
	sourceWindowLabel: "win-workspace-2",
	sourcePaneOwnerId: "desktop-2:agent:agent-1",
};

/** A plan the project move contract accepts for `agent-1` into `project-new`. */
function movePlan(operationId = "operation-1") {
	return {
		schemaVersion: 1,
		operationId,
		idempotencyKey: `idempotency-${operationId}`,
		source: { agentId: "agent-1", revision: 3, providerId: "codex" },
		targetInteractionProfile: "native_cli",
		providerConversationRef: "conversation-1",
		workspaceMove: {
			sourceAgent: { agentId: "agent-1" },
			sourceWorkspace: {
				workspaceId: "workspace-old",
				projectId: "project-old",
				rootPath: "/old",
			},
			targetProject: { projectId: "project-new" },
			targetWorkspace: {
				workspaceId: "workspace-new",
				projectId: "project-new",
				rootPath: "/new",
			},
		},
	};
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

	it("runs the large window's project move steps in the exact source pane", async () => {
		const backend = transport();
		const plan = movePlan();
		const execute = vi.fn(async (command: { action: string; step?: string }) => {
			switch (command.step) {
				case "prepare":
					return {
						kind: "project_move_prepared" as const,
						moveId: "move-1",
						projects: [{ id: "project-new", displayName: "New" }],
						complete: true,
					};
				case "preview":
					return { kind: "project_move_previewed" as const, plan };
				case "status":
					return {
						kind: "project_move_status" as const,
						status: "repair_required" as const,
					};
				default:
					return { kind: "project_move_done" as const };
			}
		});
		const stop = subscribeAgentSessionWindowCommands(execute as never, backend);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);

		const prepared = await agentSessionWindowProjectMovePort(
			sourceRoute,
			backend,
		).prepare();
		expect(prepared).toMatchObject({
			projects: [{ id: "project-new", displayName: "New" }],
			complete: true,
		});
		await expect(prepared.preview("project-new")).resolves.toEqual(plan);
		await expect(prepared.status(plan as never)).resolves.toBe(
			"repair_required",
		);
		await prepared.repair(plan as never);
		await prepared.apply(plan as never);

		const source = {
			action: "project_move",
			agentId: "agent-1",
			desktopId: "desktop-2",
			panelId: "agent:agent-1",
		};
		// Later steps name the held move and the reviewed plan's operation;
		// the plan itself is never sent back to the source.
		expect(execute.mock.calls.map(([command]) => command)).toEqual([
			{ ...source, step: "prepare" },
			{ ...source, step: "preview", moveId: "move-1", projectId: "project-new" },
			...(["status", "repair", "apply"] as const).map((step) => ({
				...source,
				step,
				moveId: "move-1",
				operationId: "operation-1",
			})),
		]);
		expect(backend.emitCommand).toHaveBeenCalledWith(
			"win-workspace-2",
			expect.objectContaining({ replyWindowLabel: "win-large-view" }),
		);
		stop();
	});

	it("runs the large window's launch pill steps in the exact source pane", async () => {
		const backend = transport();
		const execute = vi.fn(async (command: { step?: string }) =>
			command.step === "run"
				? { kind: "launch_selection_ran" as const }
				: { kind: "launch_selection_unwatched" as const },
		);
		const stop = subscribeAgentSessionWindowCommands(execute as never, backend);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);
		const mirror = agentSessionWindowLaunchSelection(sourceRoute, backend);

		await mirror?.run({ kind: "select", field: "effort", value: "max" });

		expect(execute).toHaveBeenCalledWith({
			action: "launch_selection",
			step: "run",
			command: { kind: "select", field: "effort", value: "max" },
			agentId: "agent-1",
			desktopId: "desktop-2",
			panelId: "agent:agent-1",
			// A watch names the large window as the one to keep informed.
			replyWindowLabel: "win-large-view",
		});
		// A large window that lost its source pane has no launch pills to follow.
		expect(
			agentSessionWindowLaunchSelection(
				{ agentId: "agent-1", sourceWindowLabel: "win-workspace-2" },
				backend,
			),
		).toBeUndefined();
		stop();
	});

	it("keeps a source refusal's code and not-submitted mark across the bridge", async () => {
		const backend = transport();
		const stop = subscribeAgentSessionWindowCommands(async () => {
			throw Object.assign(new Error("client_project_move_preview_stale"), {
				code: "client_project_move_preview_stale",
				submitted: false,
			});
		}, backend);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);

		await expect(
			agentSessionWindowProjectMovePort(sourceRoute, backend).prepare(),
		).rejects.toMatchObject({
			code: "client_project_move_preview_stale",
			submitted: false,
		});
		stop();
	});

	it("rejects a project move receipt whose plan the contract refuses as uncertain", async () => {
		const backend = transport();
		const stop = subscribeAgentSessionWindowCommands(
			async (command) =>
				command.action === "project_move" && command.step === "prepare"
					? {
							kind: "project_move_prepared" as const,
							moveId: "move-1",
							projects: [],
							complete: true,
						}
					: {
							kind: "project_move_previewed" as const,
							plan: { ...movePlan(), source: { agentId: "agent-2" } } as never,
						},
			backend,
		);
		await vi.waitFor(() =>
			expect(backend.listenCommand).toHaveBeenCalledOnce(),
		);

		const prepared = await agentSessionWindowProjectMovePort(
			sourceRoute,
			backend,
		).prepare();
		await expect(prepared.preview("project-new")).rejects.toThrow(
			"outcome is uncertain",
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
		await expect(
			agentSessionWindowProjectMovePort(route, backend).prepare(),
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
		for (const [generation, step] of [
			["generation-5", { step: "commit", moveId: "move-1" }],
			["generation-6", { step: "apply", moveId: "move-1" }],
			["generation-7", { step: "preview", projectId: "project-new" }],
		] as const) {
			commandListener?.({
				action: "project_move",
				agentId: "agent-1",
				generation,
				sourcePaneOwnerId: "desktop-1:agent:agent-1",
				replyWindowLabel: "win-large-view",
				expiresAtMs: 30,
				...step,
			});
		}
		for (const [generation, step] of [
			["generation-8", { step: "subscribe" }],
			["generation-9", { step: "run", command: { kind: "restart" } }],
			[
				"generation-10",
				{ step: "run", command: { kind: "select", field: "provider", value: "x" } },
			],
		] as const) {
			commandListener?.({
				action: "launch_selection",
				agentId: "agent-1",
				generation,
				sourcePaneOwnerId: "desktop-1:agent:agent-1",
				replyWindowLabel: "win-large-view",
				expiresAtMs: 30,
				...step,
			});
		}

		expect(execute).not.toHaveBeenCalled();
		stop();
	});
});
