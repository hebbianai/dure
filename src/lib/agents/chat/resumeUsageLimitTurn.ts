import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import {
	type LatestTurnFailure,
	latestTurnFailure,
} from "@/lib/agents/chat/turnFailureReason";
import {
	createDureAgentConversationClient,
	type DureAgentConversationClient,
} from "@/lib/ipc/dureAgentConversation";

export type UsageLimitResumeResult = "accepted" | "not_sent" | "uncertain";

/** Continue through the confirmed successor's existing conversation API. The
 * receipt supplies the exact backend/runtime; a UI rerender never supplies it. */
export async function resumeUsageLimitTurn(
	failure: LatestTurnFailure,
	result: AgentCredentialTransitionResult,
	client?: DureAgentConversationClient,
): Promise<UsageLimitResumeResult> {
	const target = result.kind === "completed" ? result.runtime : undefined;
	if (
		target?.interactionProfile !== "structured_protocol" ||
		!target.binding ||
		!failure.userInput ||
		!["usage_limit", "rate_limit"].includes(failure.reason)
	)
		return "not_sent";
	const conversation =
		client ??
		createDureAgentConversationClient({
			profileId: target.backendProfileId,
			routeAuthority: target.routeAuthority,
		});
	const { read } = await conversation.read({
		schemaVersion: 1,
		interactionSessionId: target.interactionSessionId,
		direction: "tail",
		cursor: null,
		limit: 100,
	});
	if (read.type !== "page" || read.page.activeTurn) return "not_sent";
	const { binding } = read.page;
	if (
		binding.agentId !== target.agentId ||
		binding.providerConversationRef !== target.providerConversationRef ||
		binding.runtime.runtimeGeneration !==
			target.binding.runtime.runtimeGeneration ||
		binding.runtime.providerEpoch !== target.binding.runtime.providerEpoch
	)
		return "not_sent";
	const current = latestTurnFailure(read.page.rows);
	// A teammate may already have continued while the account was switching.
	if (
		current?.createdAtMs !== failure.createdAtMs ||
		current.reason !== failure.reason ||
		current.userInput !== failure.userInput
	)
		return "not_sent";
	const id = `handoff-${failure.createdAtMs.toString(36)}`;
	let state: Awaited<ReturnType<DureAgentConversationClient["continueTurn"]>>;
	try {
		state = await conversation.continueTurn(
			{
				expectedCursor: read.page.finalCursor,
				intent: {
					schemaVersion: 1,
					interactionSessionId: binding.interactionSessionId,
					runtime: binding.runtime,
					turnId: id,
					clientMessageId: id,
					input: failure.userInput,
					requestedAtMs: failure.createdAtMs,
				},
			},
			target.routeAuthority,
		);
	} catch {
		// A lost receipt must not offer a fresh manual or automatic send.
		return "uncertain";
	}
	return state === "accepted"
		? "accepted"
		: state === null || state === "failed"
			? "not_sent"
			: "uncertain";
}
