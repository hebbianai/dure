import {
	type ActionErrorPresentation,
	presentBackendRefusal,
} from "@/lib/agents/chat/actionErrorPresentation";
import type { AgentChatProviderResume } from "@/lib/agents/chat/agentChatSessionView";
import type { ObservedProviderExit } from "@/lib/agents/chat/observedRuntimeFacts";
import { t } from "@/lib/i18n";

/** How the composer presents an exited provider and its Resume. */
export interface ProviderExitNotice {
	/** That the session ended and the draft stays, with how it ended as the
	 * detail. */
	readonly ended: ActionErrorPresentation;
	/** What became of the last Resume, when it did not bring the session
	 * back. */
	readonly outcome?: ActionErrorPresentation;
	readonly action: string;
	/** A Resume is running; the action waits for it. */
	readonly pending: boolean;
}

/** A `relaunched` Resume whose exit is still current is waiting for the
 * conversation to show the runtime it started. */
const RESUME_PRESENTATION = {
	idle: { action: "agents.chat.resumeSession", pending: false },
	resuming: { action: "agents.chat.resumingSession", pending: true },
	relaunched: { action: "agents.chat.resumingSession", pending: true },
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
	const refusal =
		answered?.state === "failed"
			? presentBackendRefusal(answered.refusal)
			: undefined;
	return {
		ended: {
			message: t("agents.chat.providerExited"),
			...(exit.reason && { detail: exit.reason }),
		},
		action: t(presentation.action),
		pending: presentation.pending,
		...("outcome" in presentation && {
			outcome: {
				message: t(presentation.outcome, { reason: refusal?.message ?? "" }),
				...(refusal?.detail && { detail: refusal.detail }),
			},
		}),
	};
}
