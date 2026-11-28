import { presentActionError } from "@/lib/agents/chat/actionErrorPresentation";
import { agentChatErrorMessage } from "@/lib/agents/chat/agentChatConnectionError";
import type {
	AgentChatProviderResume,
	AgentChatSessionSnapshot,
} from "@/lib/agents/chat/agentChatSessionView";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	type ObservedProviderExit,
	observedProviderExit,
} from "@/lib/agents/chat/observedRuntimeFacts";
import { t } from "@/lib/i18n";
import type { DureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

const refused = (error: unknown, code: string) =>
	error instanceof DureBackendRequestError && error.code === code;

/** The backend has no runtime for the conversation: recovering one can help. */
export const runtimeUnavailable = (error: unknown) =>
	refused(error, "agent_conversation_runtime_unavailable");

/** The route the request was fenced to changed: read the conversation again. */
export const routeChanged = (error: unknown) =>
	error instanceof DureBackendRequestError &&
	error.failure.kind === "authority_changed";

/** Asks the backend to reattach or relaunch the runtime behind `binding`, on
 * the same conversation. A conflict or a changed route means the runtime
 * already moved on, which the caller's next observation shows; any other
 * refusal rejects. Session recovery and the person's Resume both ask here. */
export async function recoverConversationRuntime(
	client: Pick<DureAgentConversationClient, "recover">,
	binding: AgentTimelinePageV1["binding"],
	routeAuthority: DureBackendRouteAuthorityV1,
): Promise<void> {
	try {
		await client.recover(binding, routeAuthority);
	} catch (error) {
		if (!refused(error, "agent_conversation_conflict") && !routeChanged(error))
			throw error;
	}
}

/** What a Resume needs from the session that owns the conversation. */
export interface ProviderResumeSession {
	readonly client: Pick<DureAgentConversationClient, "recover">;
	snapshot(): AgentChatSessionSnapshot;
	update(patch: Pick<AgentChatSessionSnapshot, "providerResume">): void;
	authority(): {
		binding: AgentTimelinePageV1["binding"];
		routeAuthority: DureBackendRouteAuthorityV1;
	};
	/** Reads the conversation again after the backend answered. */
	reobserve(): Promise<void>;
}

/** Restarts the provider behind an exited conversation through the backend's
 * recover, then reads the conversation again. A relaunched provider records
 * `session_ready`, which ends the exit episode. A backend that answers
 * without relaunching leaves the exit current; that is recorded as
 * `not_restarted` so the notice can say so instead of offering the same
 * dead end. A refusal is recorded and rethrown. */
export async function resumeExitedProvider(
	session: ProviderResumeSession,
): Promise<void> {
	const exit = observedProviderExit(session.snapshot().page);
	const current = session.snapshot().providerResume;
	if (
		!exit ||
		(current?.exitItemId === exit.itemId && current.state === "resuming")
	)
		return;
	const { binding, routeAuthority } = session.authority();
	const settle = (resume?: Omit<AgentChatProviderResume, "exitItemId">) =>
		session.update({
			providerResume: resume && { exitItemId: exit.itemId, ...resume },
		});
	settle({ state: "resuming" });
	try {
		await recoverConversationRuntime(session.client, binding, routeAuthority);
	} catch (error) {
		settle({
			state: "failed",
			failure:
				error instanceof DureBackendRequestError
					? error.code
					: agentChatErrorMessage(error),
		});
		throw error;
	}
	await session.reobserve();
	const observed = session.snapshot();
	// Only a settled read can say the exit outlived the Resume; a read still
	// reconnecting reports itself.
	const stillExited =
		observed.phase === "ready" &&
		!observed.reconnecting &&
		observedProviderExit(observed.page)?.itemId === exit.itemId;
	settle(stillExited ? { state: "not_restarted" } : undefined);
}

/** How the composer presents an exited provider and its Resume. */
export interface ProviderExitNotice {
	readonly message: string;
	readonly action: string;
	readonly pending: boolean;
	/** What became of the last Resume, when it did not restart the session. */
	readonly outcome?: { readonly text: string; readonly detail?: string };
}

const RESUME_PRESENTATION = {
	idle: { action: "agents.chat.resumeSession", pending: false },
	resuming: { action: "agents.chat.resumingSession", pending: true },
	not_restarted: {
		action: "agents.chat.resumeSession",
		pending: false,
		outcome: "agents.chat.resumeNotRestarted",
	},
	failed: {
		action: "agents.chat.resumeSession",
		pending: false,
		outcome: "agents.chat.resumeFailed",
	},
} as const satisfies Record<
	AgentChatProviderResume["state"] | "idle",
	{ action: string; pending: boolean; outcome?: string }
>;

export function presentProviderExit(
	exit: ObservedProviderExit,
	resume: AgentChatProviderResume | undefined,
): ProviderExitNotice {
	// A Resume answers only the exit it was asked for.
	const answered = resume?.exitItemId === exit.itemId ? resume : undefined;
	const presentation = RESUME_PRESENTATION[answered?.state ?? "idle"];
	const failure = answered?.failure
		? presentActionError(answered.failure)
		: undefined;
	return {
		message: exit.reason
			? t("agents.chat.providerExitedWithReason", { reason: exit.reason })
			: t("agents.chat.providerExited"),
		action: t(presentation.action),
		pending: presentation.pending,
		...("outcome" in presentation && {
			outcome: {
				text: t(presentation.outcome, { reason: failure?.message ?? "" }),
				...(failure?.detail && { detail: failure.detail }),
			},
		}),
	};
}
