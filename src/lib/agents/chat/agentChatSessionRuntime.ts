/** The one chat-session registry for this window. The chat pane hook and
 * the CLI/HTTP input path acquire the same controller for an agent, so a
 * message sent from outside the pane lands in the same session the composer
 * uses (one authority, three transports). Outside the pane the lease is
 * held only for the send; the backend owns the turn from there. */

import { AgentChatSessionController } from "@/lib/agents/chat/agentChatSessionController";
import { createAgentChatSessionRegistry } from "@/lib/agents/chat/agentChatSessionRegistry";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { observedConversationActivity } from "@/lib/agents/chat/observedRuntimeFacts";
import { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { useStore } from "@/store";

const clients = new Map<
	string,
	ReturnType<typeof createDureAgentConversationClient>
>();

function clientForProfile(backendProfileId: string) {
	let client = clients.get(backendProfileId);
	if (!client) {
		client = createDureAgentConversationClient({ profileId: backendProfileId });
		clients.set(backendProfileId, client);
	}
	return client;
}

const registry = createAgentChatSessionRegistry({
	create: ({ agentId, backendProfileId, interactionSessionId }) => {
		const controller = new AgentChatSessionController({
			agentId,
			interactionSessionId,
			client: clientForProfile(backendProfileId),
		});
		// One observer per shared controller, including CLI-originated turns.
		// It projects presentation into the existing session activity store.
		controller.subscribe(() => {
			const page = controller.getSnapshot().page;
			if (!page) return;
			const state = useStore.getState();
			const agent = state.agents.find((candidate) => candidate.id === agentId);
			const profile = agent?.interactionProfile;
			if (
				!agent ||
				profile?.kind !== "structured_protocol" ||
				profile.backendProfileId !== backendProfileId ||
				profile.interactionSessionId !== page.binding.interactionSessionId
			) {
				return;
			}
			const activity = observedConversationActivity(page);
			state.setSessionActivity(agent.sessionId, activity.text, activity.at);
		});
		return controller;
	},
});

export function acquireAgentChatSession(input: {
	agentId: string;
	backendProfileId: string;
	interactionSessionId: string;
}) {
	return registry.acquire(input);
}

const READY_TIMEOUT_MS = 15_000;

function waitForReady(
	controller: AgentChatSessionController,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const settle = (): boolean => {
			const snapshot = controller.getSnapshot();
			if (snapshot.phase === "ready") {
				resolve();
				return true;
			}
			if (snapshot.phase === "error") {
				reject(new Error(snapshot.error ?? "agent_chat_session_error"));
				return true;
			}
			return false;
		};
		if (settle()) return;
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("agent_chat_session_not_ready"));
		}, timeoutMs);
		const unsubscribe = controller.subscribe(() => {
			if (settle()) {
				clearTimeout(timer);
				unsubscribe();
			}
		});
	});
}

export type AgentChatMessageDelivery = "sent" | "steered" | "queued";

/** Sends a message into the agent's chat session exactly as the composer
 * would: a fresh turn when idle, steer-or-queue while a turn is running. */
export async function sendAgentChatMessage({
	agentId,
	profile,
	text,
}: {
	agentId: string;
	profile: AgentStructuredInteractionProfileV1;
	text: string;
}): Promise<{ delivery: AgentChatMessageDelivery }> {
	const lease = registry.acquire({
		agentId,
		backendProfileId: profile.backendProfileId,
		interactionSessionId: profile.interactionSessionId,
	});
	try {
		const { controller } = lease;
		await waitForReady(controller, READY_TIMEOUT_MS);
		if (controller.getSnapshot().activeTurn) {
			return { delivery: await controller.steerOrQueue(text) };
		}
		await controller.send(text);
		return { delivery: "sent" };
	} finally {
		lease.release();
	}
}
