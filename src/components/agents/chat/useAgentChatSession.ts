import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { StructuredAgentRuntimeProjectionGenerationV1 } from "@/lib/agents/agentRuntimeProjectionRecovery";
import type { AgentChatSessionController } from "@/lib/agents/chat/agentChatSessionController";
import type { AgentGoalUpdateV1 } from "@/lib/agents/chat/agentConversationContract";
import type { AgentChatDraftIdentity } from "@/lib/agents/chat/agentChatDraftStoreSlice";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { publishConversationTitle } from "@/lib/agents/chat/conversationPresentationState";
import { observedConversationTitle } from "@/lib/agents/chat/observedRuntimeFacts";
import { acquireAgentChatSession } from "@/lib/agents/chat/agentChatSessionRuntime";

const DETACHED = {
	phase: "detached",
	reconnecting: false,
	sending: false,
	savingGoal: false,
	retryTurnAvailable: false,
	interrupting: false,
	loadingOlder: false,
	queuedMessages: [],
} as const;

export function useAgentChatSession(
	agentId: string,
	profile: AgentStructuredInteractionProfileV1,
	onRuntimeInvalidated?: (
		generation: StructuredAgentRuntimeProjectionGenerationV1,
	) => boolean | Promise<boolean>,
) {
	const [owned, setOwned] = useState<
		AgentChatDraftIdentity & { controller: AgentChatSessionController }
	>();
	const controller =
		owned?.agentId === agentId &&
		owned.backendProfileId === profile.backendProfileId &&
		owned.interactionSessionId === profile.interactionSessionId
			? owned.controller
			: undefined;
	useEffect(() => {
		const identity = {
			agentId,
			backendProfileId: profile.backendProfileId,
			interactionSessionId: profile.interactionSessionId,
		};
		const lease = acquireAgentChatSession(identity);
		const unsubscribeRuntimeInvalidation = onRuntimeInvalidated
			? lease.controller.subscribeRuntimeInvalidation(onRuntimeInvalidated)
			: undefined;
		setOwned({ ...identity, controller: lease.controller });
		return () => {
			setOwned(undefined);
			unsubscribeRuntimeInvalidation?.();
			lease.release();
		};
	}, [
		agentId,
		onRuntimeInvalidated,
		profile.backendProfileId,
		profile.interactionSessionId,
	]);

	const subscribe = useCallback(
		(listener: () => void) => controller?.subscribe(listener) ?? (() => {}),
		[controller],
	);
	const getSnapshot = useCallback(
		() => controller?.getSnapshot() ?? DETACHED,
		[controller],
	);
	const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	// Surface the provider-reported conversation title to pane headers and the
	// Spaces navigator, which never subscribe to the conversation themselves.
	const page = "page" in snapshot ? snapshot.page : undefined;
	useEffect(() => {
		publishConversationTitle(agentId, observedConversationTitle(page));
	}, [agentId, page]);

	return {
		...snapshot,
		draftIdentity: {
			agentId,
			backendProfileId: profile.backendProfileId,
			interactionSessionId: profile.interactionSessionId,
		},
		putGoal: (update: AgentGoalUpdateV1) =>
			controller?.putGoal(update) ?? Promise.resolve(false),
		retryConnection: () => controller?.retryConnection(),
		loadOlder: () =>
			controller
				? controller.loadOlder()
				: Promise.reject(new Error("agent_chat_controller_unavailable")),
		queueMessage: (input: string) => {
			if (!controller) throw new Error("agent_chat_controller_unavailable");
			controller.queueMessage(input);
		},
		steerOrQueue: (input: string) =>
			controller
				? controller.steerOrQueue(input)
				: Promise.reject(new Error("agent_chat_controller_unavailable")),
		dequeueMessage: (index: number) => controller?.dequeueMessage(index),
		send: (input: string) =>
			controller
				? controller.send(input)
				: Promise.reject(new Error("agent_chat_controller_unavailable")),
		retryTurn: () =>
			controller
				? controller.retryTurn()
				: Promise.reject(new Error("agent_chat_controller_unavailable")),
		editRetryableTurn: () => controller?.editRetryableTurn(),
		answerPending: (requestId: string, answer: unknown) =>
			controller
				? controller.answerPending(requestId, answer)
				: Promise.reject(new Error("agent_chat_controller_unavailable")),
		interrupt: () =>
			controller
				? controller.interrupt()
				: Promise.reject(new Error("agent_chat_controller_unavailable")),
		dismissActionError: () => controller?.dismissActionError(),
	};
}
