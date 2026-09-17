// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { useChatPaneActions } from "@/components/agents/chat/useChatPaneActions";
import { AgentChatSessionController } from "@/lib/agents/chat/agentChatSessionController";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import type {
	AgentConversationInvalidationV1,
	DureAgentConversationClient,
} from "@/lib/ipc/dureAgentConversation";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const acquire = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/chat/agentChatSessionRuntime", () => ({
	acquireAgentChatSession: acquire,
}));
afterEach(() => {
	cleanup();
	acquire.mockReset();
});

it("does not resend a newer failed message when the failure changes during CLI claim", async () => {
	const run = vi.fn(async () => {});
	const paneId = "pane-resend-claim";
	const hook = renderHook(({ failureId }) => useChatPaneActions(
		{ paneId, agentId: "agent-resend", interactionSessionId: "interaction-resend", conversationId: "same-conversation" },
		{ phase: "ready", reconnecting: false, activeTurn: undefined, interrupting: false,
			locked: false, error: undefined, interrupt: vi.fn(), resendLastMessage: { failureId, run } },
		"same-runtime",
	), { initialProps: { failureId: "failure-first" } });
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{ reqId: "resend-claim", action: "pane.act", params: { targetPanelId: paneId, actionId: "resend_last_message" } },
		{ claim: async () => { hook.rerender({ failureId: "failure-newer" }); return true; },
			complete, isFallbackWindow: () => false, delay: async () => {} },
	);
	expect(run).not.toHaveBeenCalled();
	expect(complete.mock.calls[0][1]).toMatchObject({ ok: false, error: { code: "pane_changed" } });
});

it("does not interrupt the next controller turn during a claimed projection update", async () => {
	const backend = { id: "backend-turn-claim", generation: "one" };
	const routeAuthority = testDureBackendRouteAuthority(
		backend.id,
		backend.generation,
	);
	const binding = {
		schemaVersion: 1 as const,
		interactionSessionId: "interaction-turn-claim",
		agentId: "agent-turn-claim",
		providerId: "codex" as const,
		executionProfile: { kind: "provider_default" as const },
		providerConversationRef: "conversation",
		runtime: { runtimeGeneration: "runtime-1", providerEpoch: "provider-1" },
		timelineEpoch: "timeline-1",
		bindingRevision: 1,
		historyComplete: true,
		createdAtMs: 1,
		updatedAtMs: 1,
	};
	const row = (
		sequence: number,
		turnId: string,
		state: "turn_started" | "turn_completed",
	) => ({
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId: `item-${sequence}`,
			turnId,
			clientMessageId: `message-${turnId}`,
			providerMessageId: null,
			body: { type: "lifecycle" as const, state, detail: null },
			createdAtMs: sequence,
		},
	});
	const firstRows = [row(1, "turn-original", "turn_started")];
	const initial = {
		type: "page" as const,
		page: {
			binding,
			rows: firstRows,
			liveText: [],
			pendingRequests: [],
			activeTurn: {
				turnId: "turn-original",
				clientMessageId: "message-turn-original",
			},
			goal: null,
			finalCursor: { epoch: "timeline-1", sequence: 1 },
			hasMore: false,
		},
	};
	const next = {
		type: "page" as const,
		page: {
			...initial.page,
			rows: [
				...firstRows,
				row(2, "turn-original", "turn_completed"),
				row(3, "turn-next", "turn_started"),
			],
			activeTurn: { turnId: "turn-next", clientMessageId: "message-turn-next" },
			finalCursor: { epoch: "timeline-1", sequence: 3 },
		},
	};
	let invalidate:
		| ((event: AgentConversationInvalidationV1) => void)
		| undefined;
	const interrupt = vi.fn<DureAgentConversationClient["interruptTurn"]>(
		async () => {},
	);
	const client: DureAgentConversationClient = {
		putGoal: async () => {
			throw new Error("unused fixture goal write");
		},
		inspect: async () => ({ backend, routeAuthority, binding }),
		recover: async (current) => current,
		read: async (request) => ({
			backend,
			routeAuthority,
			read: {
				...next,
				page: {
					...next.page,
					rows: next.page.rows.filter(
						(item) => item.cursor.sequence > (request.cursor?.sequence ?? 0),
					),
				},
			},
		}),
		subscribe: async (_request, listener) => {
			invalidate = listener;
			return {
				subscriptionId: "subscription-turn-claim",
				backend,
				routeAuthority,
				initial,
				close: async () => {},
			};
		},
		startTurn: async () => "accepted",
		steerTurn: async () => {},
		answerPending: async () => {},
		interruptTurn: interrupt,
	};
	const controller = new AgentChatSessionController({
		agentId: binding.agentId,
		interactionSessionId: binding.interactionSessionId,
		client,
	});
	acquire.mockImplementation(() => {
		controller.start();
		return { controller, release: () => controller.stop() };
	});
	const paneId = "pane-controller-turn";
	const hook = renderHook(() => {
		const session = useAgentChatSession(binding.agentId, {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "fixture-profile",
			interactionSessionId: binding.interactionSessionId,
		});
		useChatPaneActions(
			{
				paneId,
				agentId: binding.agentId,
				interactionSessionId: binding.interactionSessionId,
				conversationId: "conversation",
			},
			{
				...session,
				activeTurn: "activeTurn" in session ? session.activeTurn : undefined,
				locked: false,
				error: "error" in session ? session.error : undefined,
			},
			"same-runtime-owner",
		);
		return session;
	});
	await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
	expect(controller.getSnapshot().activeTurn?.turnId).toBe("turn-original");
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await act(async () => {
		await dispatchCliPaneActionRequest(
			{
				reqId: "controller-turn-claim",
				action: "pane.act",
				params: { targetPanelId: paneId, actionId: "interrupt" },
			},
			{
				claim: async () => {
					const observed = new Promise<void>((resolve, reject) => {
						const unsubscribe = controller.subscribe(() => {
							const snapshot = controller.getSnapshot();
							if (snapshot.error) {
								unsubscribe();
								reject(new Error(`Fixture refresh failed: ${snapshot.error}`));
							} else if (snapshot.activeTurn?.turnId === "turn-next") {
								unsubscribe();
								resolve();
							}
						});
					});
					invalidate?.({
						kind: "changed",
						interactionSessionId: binding.interactionSessionId,
						timelineCursor: next.page.finalCursor,
						kinds: ["timeline"],
					});
					await observed;
					return true;
				},
				complete,
				isFallbackWindow: () => false,
				delay: async () => {},
			},
		);
	});
	expect(interrupt).not.toHaveBeenCalled();
	expect(complete.mock.calls[0][1]).toMatchObject({
		ok: false,
		error: { code: "pane_changed" },
	});
});
