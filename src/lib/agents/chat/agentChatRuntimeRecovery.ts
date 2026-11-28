import { agentChatErrorMessage } from "@/lib/agents/chat/agentChatConnectionError";
import type {
	AgentChatProviderResume,
	AgentChatRefusal,
	AgentChatSessionSnapshot,
} from "@/lib/agents/chat/agentChatSessionView";
import {
	type AgentInteractionBindingV1,
	type AgentTimelinePageV1,
	sameAgentRuntimeFence,
} from "@/lib/agents/chat/agentConversationContract";
import {
	type ObservedProviderExit,
	observedProviderExit,
} from "@/lib/agents/chat/observedRuntimeFacts";
import type { DureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import {
	DureBackendRequestError,
	dureBackendAuthorityChanged,
	dureBackendRefused,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

/** The backend has no runtime for the conversation: recovering one can help. */
export const runtimeUnavailable = (error: unknown) =>
	dureBackendRefused(error, "agent_conversation_runtime_unavailable");

/** What the backend's recover answered. `moved_on` is a refusal because the
 * runtime already changed since it was read (a conflict, which also covers a
 * stale credential, a busy source and a runtime conflict) or because the
 * route the request was fenced to changed; reading the conversation again
 * shows what it moved to. */
export type RecoverOutcome =
	| { readonly kind: "recovered"; readonly binding: AgentInteractionBindingV1 }
	| { readonly kind: "moved_on"; readonly refusal: DureBackendRequestError };

/** Asks the backend to reattach or relaunch the runtime behind `binding`, on
 * the same conversation. Session recovery reads the conversation again after
 * either outcome; the person's Resume also shows a `moved_on` refusal. Any
 * other refusal rejects. */
export async function recoverConversationRuntime(
	client: Pick<DureAgentConversationClient, "recover">,
	binding: AgentInteractionBindingV1,
	routeAuthority: DureBackendRouteAuthorityV1,
): Promise<RecoverOutcome> {
	try {
		return {
			kind: "recovered",
			binding: await client.recover(binding, routeAuthority),
		};
	} catch (error) {
		if (
			!dureBackendRefused(error, "agent_conversation_conflict") &&
			!dureBackendAuthorityChanged(error)
		)
			throw error;
		return { kind: "moved_on", refusal: error as DureBackendRequestError };
	}
}

/** The exit the conversation still has to answer: the timeline's newest
 * exit, unless a Resume relaunched the runtime the conversation is bound to
 * now. A backend before #807 records a relaunched Claude's start only at its
 * first input, so there the recover receipt is what says it is up. */
export function currentProviderExit(snapshot: {
	readonly page?: Pick<AgentTimelinePageV1, "rows"> & {
		readonly binding: Pick<AgentInteractionBindingV1, "runtime">;
	};
	readonly providerResume?: AgentChatProviderResume;
}): ObservedProviderExit | undefined {
	const exit = observedProviderExit(snapshot.page);
	const resume = snapshot.providerResume;
	return exit &&
		resume?.state === "relaunched" &&
		resume.exitItemId === exit.itemId &&
		sameAgentRuntimeFence(resume.runtime, snapshot.page?.binding.runtime)
		? undefined
		: exit;
}

/** The session controller's state and reads, as the operations it delegates
 * to need them. The controller builds it once. */
export interface AgentChatSessionPort {
	readonly client: Pick<DureAgentConversationClient, "recover">;
	snapshot(): AgentChatSessionSnapshot;
	update(patch: Pick<AgentChatSessionSnapshot, "providerResume">): void;
	authority(): {
		binding: AgentInteractionBindingV1;
		routeAuthority: DureBackendRouteAuthorityV1;
	};
	/** Reads the conversation again after the backend answered. */
	reobserve(): Promise<void>;
}

function refusalOf(error: unknown): AgentChatRefusal {
	const message = agentChatErrorMessage(error);
	return error instanceof DureBackendRequestError
		? { code: error.code, message }
		: { code: message, message };
}

/** Restarts the provider behind an exited conversation through the backend's
 * recover and classifies the outcome from its receipt, as `dure runs resume`
 * does: a new runtime fence was relaunched, the same fence was not
 * restarted, and a refusal is shown as the backend said it. A relaunch is
 * read again, because sends are fenced to the runtime the page is bound to;
 * once its start is on the timeline the exit is over and the Resume clears.
 * Each closing write answers only the exit this Resume was asked for. */
export async function resumeExitedProvider(
	port: AgentChatSessionPort,
): Promise<void> {
	const before = port.snapshot();
	const exit = currentProviderExit(before);
	const running = before.providerResume;
	if (
		!exit ||
		(running?.exitItemId === exit.itemId &&
			(running.state === "resuming" || running.state === "relaunched"))
	)
		return;
	const { binding, routeAuthority } = port.authority();
	const settle = (next: AgentChatProviderResume | undefined) => {
		if (port.snapshot().providerResume?.exitItemId === exit.itemId)
			port.update({ providerResume: next });
	};
	port.update({
		providerResume: { exitItemId: exit.itemId, state: "resuming" },
	});
	let outcome: RecoverOutcome;
	try {
		outcome = await recoverConversationRuntime(
			port.client,
			binding,
			routeAuthority,
		);
	} catch (error) {
		settle({
			exitItemId: exit.itemId,
			state: "failed",
			refusal: refusalOf(error),
		});
		throw error;
	}
	if (outcome.kind === "moved_on") {
		settle({
			exitItemId: exit.itemId,
			state: "failed",
			refusal: refusalOf(outcome.refusal),
		});
		await port.reobserve();
		return;
	}
	if (sameAgentRuntimeFence(outcome.binding.runtime, binding.runtime)) {
		settle({ exitItemId: exit.itemId, state: "not_restarted" });
		return;
	}
	settle({
		exitItemId: exit.itemId,
		state: "relaunched",
		runtime: outcome.binding.runtime,
	});
	await port.reobserve();
	if (observedProviderExit(port.snapshot().page)?.itemId !== exit.itemId)
		settle(undefined);
}
