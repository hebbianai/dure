import type {
	AgentApprovalChoice,
	AgentApprovalRequest,
	ApprovalAnswerState,
	PendingApproval,
} from "@/lib/agents/approvalRequest";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";
import type { NativeAgentInputFailure } from "@/lib/agents/chat/nativeAgentChat";
import { t } from "@/lib/i18n";

/** The desktop chat's presentation of a native agent's pending approval
 * (`@/lib/agents/approvalRequest`) on the shared pending-request card. */

/** The card's answers, in the shared pending-request vocabulary. */
export type NativeAgentApprovalDecision = "allow" | "allow_always" | "deny";

const DECISION_OF: Record<AgentApprovalChoice, NativeAgentApprovalDecision> = {
	approve: "allow",
	approve_always: "allow_always",
	deny: "deny",
};
const CHOICE_OF: ReadonlyMap<string, AgentApprovalChoice> = new Map(
	Object.entries(DECISION_OF).map(([choice, decision]) => [
		decision,
		choice as AgentApprovalChoice,
	]),
);

/** The answers the provider offers, as the card's decisions. */
export function nativeAgentApprovalDecisions(
	request: AgentApprovalRequest,
): NativeAgentApprovalDecision[] {
	return request.choices.map((choice) => DECISION_OF[choice]);
}

/** The offered choice a card answer names, or nothing for anything else. */
export function nativeAgentApprovalChoice(
	request: AgentApprovalRequest,
	answer: unknown,
): AgentApprovalChoice | undefined {
	const decision =
		answer !== null && typeof answer === "object"
			? (answer as { decision?: unknown }).decision
			: undefined;
	const choice =
		typeof decision === "string" ? CHOICE_OF.get(decision) : undefined;
	return choice && request.choices.includes(choice) ? choice : undefined;
}

/** The approval as the shared pending-request card renders it: the tool as
 * its title and the command, path or address it acts on as its detail. */
export function nativeAgentApprovalCardRequest(
	approval: PendingApproval,
	{ agentId, terminalEpoch }: { agentId: string; terminalEpoch: string },
): AgentPendingRequestV1 {
	const { toolName, summary } = approval.request;
	return {
		interactionSessionId: `native:${agentId}`,
		runtime: { runtimeGeneration: terminalEpoch, providerEpoch: "native" },
		request: {
			requestId: approval.attentionId,
			kind: "permission",
			turnId: null,
			clientMessageId: approval.attentionId,
			payload: {
				toolName,
				...(summary ? { input: { summary } } : {}),
				presentation: {
					title: t("agents.nativeChat.approval.title", { tool: toolName }),
					...(summary ? { description: summary } : {}),
				},
			},
			createdAtMs: 0,
		},
	};
}

/** One answer from this chat, kept by the pane for the approval it names. */
export interface NativeAgentApprovalAnswer extends ApprovalAnswerState {
	readonly failure?: NativeAgentInputFailure;
}

const ANSWER_ERROR_COPY: Record<string, string> = {
	agent_runtime_native_answer_changed:
		"agents.nativeChat.approval.error.changed",
	agent_runtime_native_changed: "agents.nativeChat.approval.error.changed",
	agent_runtime_native_answer_unavailable:
		"agents.nativeChat.approval.error.unavailable",
	agent_runtime_native_answer_unsupported:
		"agents.nativeChat.approval.error.unavailable",
	backend_transport_capability_missing:
		"agents.nativeChat.approval.error.unavailable",
	agent_runtime_native_answer_unconfirmed:
		"agents.nativeChat.approval.error.unconfirmed",
	backend_request_deadline_exceeded:
		"agents.nativeChat.approval.error.unconfirmed",
};

/** Why an answer did not land, as one sentence; the card then offers the
 * terminal. The token stays as the diagnostic detail. */
export function presentNativeAgentApprovalError({
	code,
}: NativeAgentInputFailure): {
	readonly message: string;
	readonly detail: string;
} {
	return {
		message: t(
			ANSWER_ERROR_COPY[code] ?? "agents.nativeChat.approval.error.failed",
		),
		detail: code,
	};
}
