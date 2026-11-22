/**
 * A tap on a phone alert opens the agent it is about.
 *
 * The alert names the agent by the key the home list already finds rows by
 * (`agentSeatKey` on the computer), so opening it is a tap on that row: the
 * same row, through the same open path, as the list or a Needs you card.
 */

import type { AgentApprovalChoice } from "@/lib/agents/approvalRequest";
import { type UnifiedRow, sourceOpenable } from "./allSessions";
import type { NeedsYouCard } from "./homeProjection";

/** Rust `PushActivation`: the agent a tapped alert names. */
export interface PushActivation {
	readonly sessionId: string;
	/**
	 * Allow once or Deny, pressed on the alert while approvals need Face ID:
	 * the app opened so its approval sheet can ask.
	 */
	readonly answer?: {
		readonly choice: Extract<AgentApprovalChoice, "approve" | "deny">;
		readonly attentionId: string;
		readonly terminalEpoch: string;
	};
}

/** Rust `ApprovalActions`: what the alert's actions need when no screen runs. */
export interface ApprovalActions {
	/** Face ID before an approval: the actions then open the app. */
	readonly ownerCheck: boolean;
	readonly approve: string;
	readonly deny: string;
	/** What the phone says when an answer from an alert did not land. */
	readonly failed: string;
}

/**
 * The row a tap opens, or none while no paired computer lists that agent
 * where the phone can reach it.
 */
export function activatedRow(
	rows: readonly UnifiedRow[],
	activation: PushActivation,
): UnifiedRow | undefined {
	return rows.find(
		(row) =>
			row.sessionId === activation.sessionId && sourceOpenable(row.source),
	);
}

/**
 * The Needs you card an alert's action answers: that agent, waiting on that
 * very approval of that very process. None once it was answered or replaced,
 * so a late press never answers a newer request.
 */
export function activatedApproval(
	cards: readonly NeedsYouCard[],
	activation: PushActivation,
): NeedsYouCard | undefined {
	const answer = activation.answer;
	if (!answer) return undefined;
	return cards.find(
		(card) =>
			card.view.row.sessionId === activation.sessionId &&
			card.approval?.attentionId === answer.attentionId &&
			card.view.row.source.session.terminal_epoch === answer.terminalEpoch &&
			card.approval.request.choices.includes(answer.choice),
	);
}
