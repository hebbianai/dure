import { describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";

const handover = vi.hoisted(() => ({
	setNativeAgentView: vi.fn(),
	requestChatHandover: vi.fn(async () => ({ kind: "scheduled" as const })),
	applyChatHandoverNow: vi.fn(async () => {}),
	cancelChatHandover: vi.fn(() => true),
}));
vi.mock("@/lib/agents/chatHandoverRuntime", () => handover);
const projectMove = vi.hoisted(() => {
	const prepared = () => ({
		projects: [{ id: "project-new", displayName: "New" }],
		complete: true,
		preview: vi.fn(async (projectId: string) => ({
			operationId: `operation-${projectId}`,
		})),
		status: vi.fn(async () => "unconfirmed" as const),
		repair: vi.fn(async () => {}),
		apply: vi.fn(async () => {}),
	});
	return {
		prepared,
		prepareAgentProjectMove: vi.fn(async (_agentId: string) => prepared()),
	};
});
vi.mock("@/lib/agents/agentProjectMove", () => ({
	prepareAgentProjectMove: projectMove.prepareAgentProjectMove,
}));
import { agentFixture } from "@/test/agentFixtures";
import {
	type AgentSessionWindowCommandRuntime,
	executeAgentSessionWindowCommand,
} from "./agentSessionWindowCommandRuntime";

const forkedAgent = agentFixture({
	id: "agent-fork",
	sessionId: "agent-fork",
	displayName: "Fork",
});

function presentationRuntime(options: { present?: boolean } = {}) {
	const order: string[] = [];
	const state = {
		agents: [forkedAgent],
		spaces: [{ id: "desktop-source" }, { id: "desktop-other" }],
	};
	const runtime: AgentSessionWindowCommandRuntime = {
		reconcile: vi.fn(async () => {
			order.push("reconcile");
		}),
		readState: vi.fn(() => {
			order.push("read");
			return state;
		}),
		readPaneAgentId: vi.fn(() => "agent-source"),
		activateSourcePane: vi.fn((desktopId, panelId) => {
			order.push(`source:${desktopId}:${panelId}`);
			return true;
		}),
		ownsMountedPane: vi.fn((desktopId, panelId) => {
			order.push(`owns:${desktopId}:${panelId}`);
			return true;
		}),
		ownsMountedAgentPane: vi.fn((desktopId, agentId) => {
			order.push(`owns-agent:${desktopId}:${agentId}`);
			return true;
		}),
		waitForDesktop: vi.fn(async (desktopId) => {
			order.push(`wait:${desktopId}`);
			return true;
		}),
		presentAgent: vi.fn((desktopId, agent) => {
			order.push(`present:${desktopId}:${agent.id}`);
			return options.present ?? true;
		}),
	};
	return { order, runtime, state };
}

const command = {
	action: "present_fork" as const,
	agentId: "agent-source",
	desktopId: "desktop-source",
	panelId: "agent:agent-source",
	forkedAgentId: "agent-fork",
};

describe("Agent session window command runtime", () => {
	it("hydrates, activates, and presents the fork in the source-owned desktop before acknowledging", async () => {
		const { order, runtime } = presentationRuntime();

		await expect(
			executeAgentSessionWindowCommand(command, runtime),
		).resolves.toEqual({ kind: "presented" });
		expect(runtime.reconcile).toHaveBeenCalledTimes(2);
		expect(runtime.reconcile).toHaveBeenCalledWith("desktop-source");
		expect(runtime.activateSourcePane).toHaveBeenCalledTimes(2);
		expect(runtime.activateSourcePane).toHaveBeenCalledWith(
			"desktop-source",
			"agent:agent-source",
		);
		expect(runtime.presentAgent).toHaveBeenCalledWith(
			"desktop-source",
			forkedAgent,
		);
		expect(runtime.ownsMountedPane).toHaveBeenCalledWith(
			"desktop-source",
			"agent:agent-source",
		);
		expect(runtime.ownsMountedAgentPane).toHaveBeenCalledWith(
			"desktop-source",
			"agent-fork",
		);
		expect(order).toEqual([
			"reconcile",
			"source:desktop-source:agent:agent-source",
			"wait:desktop-source",
			"source:desktop-source:agent:agent-source",
			"read",
			"present:desktop-source:agent-fork",
			"reconcile",
			"owns:desktop-source:agent:agent-source",
			"owns-agent:desktop-source:agent-fork",
		]);
	});

	it("rejects the receipt when the source dock cannot present the fork", async () => {
		const { runtime } = presentationRuntime({ present: false });

		await expect(
			executeAgentSessionWindowCommand(command, runtime),
		).rejects.toThrow(t("workspace.agentWindow.forkPresentationFailed"));
	});

	it("runs View moves through the source window's own handover runtime", async () => {
		const { runtime } = presentationRuntime();
		const source = {
			agentId: "agent-source",
			desktopId: "desktop-source",
			panelId: "agent:agent-source",
		};

		await expect(
			executeAgentSessionWindowCommand(
				{ ...source, action: "set_native_view", view: "conversation" },
				runtime,
			),
		).resolves.toEqual({ kind: "view_set" });
		await expect(
			executeAgentSessionWindowCommand(
				{ ...source, action: "chat_handover", step: "request" },
				runtime,
			),
		).resolves.toEqual({ kind: "chat_handover", outcome: "scheduled" });
		await expect(
			executeAgentSessionWindowCommand(
				{ ...source, action: "chat_handover", step: "apply_now" },
				runtime,
			),
		).resolves.toEqual({ kind: "chat_handover", outcome: "applied" });
		await expect(
			executeAgentSessionWindowCommand(
				{ ...source, action: "chat_handover", step: "cancel" },
				runtime,
			),
		).resolves.toEqual({ kind: "chat_handover", outcome: "cancelled" });

		expect(handover.setNativeAgentView).toHaveBeenCalledWith(
			"agent-source",
			"conversation",
		);
		// The shared Chat transition: no pane-specific switch is passed, so the
		// source runs exactly what its own View control and idle watcher run.
		expect(handover.requestChatHandover).toHaveBeenCalledWith("agent-source");
		expect(handover.applyChatHandoverNow).toHaveBeenCalledWith("agent-source");
		expect(handover.cancelChatHandover).toHaveBeenCalledWith("agent-source");
	});

	it("refuses a View move when the source pane now holds another Agent", async () => {
		const { runtime } = presentationRuntime();
		handover.requestChatHandover.mockClear();

		await expect(
			executeAgentSessionWindowCommand(
				{
					action: "chat_handover",
					step: "request",
					agentId: "agent-moved-away",
					desktopId: "desktop-source",
					panelId: "agent:agent-source",
				},
				runtime,
			),
		).rejects.toThrow("view command source Agent mismatch");
		expect(handover.requestChatHandover).not.toHaveBeenCalled();
	});

	describe("a large window's project move", () => {
		const source = {
			action: "project_move" as const,
			agentId: "agent-source",
			desktopId: "desktop-source",
			panelId: "agent:agent-source",
		};
		async function prepare() {
			const { runtime } = presentationRuntime();
			const prepared = projectMove.prepared();
			projectMove.prepareAgentProjectMove.mockResolvedValueOnce(prepared);
			const receipt = await executeAgentSessionWindowCommand(
				{ ...source, step: "prepare" },
				runtime,
			);
			if (receipt.kind !== "project_move_prepared")
				throw new Error("expected a prepared move");
			return { runtime, prepared, moveId: receipt.moveId };
		}

		it("prepares the move where the source pane runs and acts only on the plan it previewed", async () => {
			const { runtime, prepared, moveId } = await prepare();
			expect(projectMove.prepareAgentProjectMove).toHaveBeenLastCalledWith(
				"agent-source",
			);

			await expect(
				executeAgentSessionWindowCommand(
					{ ...source, step: "preview", moveId, projectId: "project-new" },
					runtime,
				),
			).resolves.toEqual({
				kind: "project_move_previewed",
				plan: { operationId: "operation-project-new" },
			});
			await expect(
				executeAgentSessionWindowCommand(
					{ ...source, step: "apply", moveId, operationId: "operation-other" },
					runtime,
				),
			).rejects.toMatchObject({
				code: "client_project_move_preview_stale",
				submitted: false,
			});
			expect(prepared.apply).not.toHaveBeenCalled();

			await expect(
				executeAgentSessionWindowCommand(
					{
						...source,
						step: "apply",
						moveId,
						operationId: "operation-project-new",
					},
					runtime,
				),
			).resolves.toEqual({ kind: "project_move_done" });
			expect(prepared.apply).toHaveBeenCalledWith({
				operationId: "operation-project-new",
			});
			// A finished move is released; its id names nothing any more.
			await expect(
				executeAgentSessionWindowCommand(
					{
						...source,
						step: "status",
						moveId,
						operationId: "operation-project-new",
					},
					runtime,
				),
			).rejects.toMatchObject({ submitted: false });
		});

		it("refuses a step on a move a newer preparation replaced", async () => {
			const first = await prepare();
			const second = await prepare();

			await expect(
				executeAgentSessionWindowCommand(
					{
						...source,
						step: "preview",
						moveId: first.moveId,
						projectId: "project-new",
					},
					second.runtime,
				),
			).rejects.toMatchObject({
				code: "client_project_move_preview_stale",
				submitted: false,
			});
			expect(first.prepared.preview).not.toHaveBeenCalled();
			expect(second.prepared.preview).not.toHaveBeenCalled();
		});

		it("refuses a project move when the source pane now holds another Agent", async () => {
			const { runtime } = presentationRuntime();
			projectMove.prepareAgentProjectMove.mockClear();

			await expect(
				executeAgentSessionWindowCommand(
					{ ...source, agentId: "agent-moved-away", step: "prepare" },
					runtime,
				),
			).rejects.toThrow("project move command source Agent mismatch");
			expect(projectMove.prepareAgentProjectMove).not.toHaveBeenCalled();
		});
	});
});
