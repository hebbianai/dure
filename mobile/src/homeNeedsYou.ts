/**
 * Home's Needs you section: every agent only a person can move forward — an
 * approval, an answer, an error or an unexpected exit — above the list, with
 * the approval answered in place.
 *
 * What waits is decided in `homeProjection.needsYou`; this file only draws it.
 * The answers go through the same approval request the chat card sends, past
 * the same approval sheet, so a card is a second place to press the button,
 * not a second way to answer.
 */

import {
	type AgentApprovalChoice,
	approvalShown,
} from "@/lib/agents/approvalRequest";
import type { UnifiedRow, UnifiedSource } from "./allSessions";
import { needsPersonText } from "./agentRowText";
import type { ApprovalAnswer } from "./chat";
import { element } from "./dom";
import { homeCardHead, homeCardSection } from "./homeCard";
import type { NeedsYouCard } from "./homeProjection";
import { t } from "./i18n";
import "./homeNeedsYou.css";

/** The card's answers, least committal first: Deny, then Allow once. */
const CARD_CHOICES: readonly AgentApprovalChoice[] = ["deny", "approve"];

export interface NeedsYouActions {
	readonly open: (source: UnifiedSource) => void;
	/**
	 * Show what the phone knows about a session without attaching: an agent
	 * that exited cannot be opened, so its card leads here. Without it the
	 * card only says why.
	 */
	readonly info?: (row: UnifiedRow) => void;
	/** Without it the card only opens the agent. */
	readonly answerApproval?: (
		card: NeedsYouCard,
		choice: AgentApprovalChoice,
	) => void;
}

/**
 * The cards still waiting on this phone: an approval whose answer reached the
 * computer leaves at once, as the chat's card does, and the next catalog read
 * takes the agent out once it moves on.
 */
function shownNeedsYou(
	cards: readonly NeedsYouCard[],
	answers: Readonly<Record<string, ApprovalAnswer>>,
): NeedsYouCard[] {
	return cards.filter(
		(card) =>
			!card.approval ||
			approvalShown(card.approval, answers[card.approval.attentionId]),
	);
}

/** The section, or nothing when no agent waits. */
export function renderNeedsYou(
	cards: readonly NeedsYouCard[],
	answers: Readonly<Record<string, ApprovalAnswer>>,
	actions: NeedsYouActions,
): HTMLElement | undefined {
	const shown = shownNeedsYou(cards, answers);
	if (shown.length === 0) return undefined;
	return homeCardSection(
		"needs-you",
		t("home.needsYou.title"),
		shown.map((card) => renderCard(card, answers, actions)),
	);
}

/**
 * The way from the card to the agent. A running agent opens, on Reply for a
 * question. An agent that exited has no session to attach to, so its card
 * shows the session's details, which say where it ran.
 */
function cardAction(
	card: NeedsYouCard,
	actions: NeedsYouActions,
): HTMLButtonElement | undefined {
	const row = card.view.row;
	const { info } = actions;
	const exited =
		card.status === "unexpected_exit" || card.status === "sign_in_exit";
	const run = exited
		? info && (() => info(row))
		: () => actions.open(row.source);
	if (!run) return undefined;
	const button = element(
		"button",
		"needs-you__action",
		exited
			? t("sessionInfo.action")
			: card.status === "input"
				? t("home.needsYou.reply")
				: t("home.needsYou.open"),
	);
	button.type = "button";
	button.addEventListener("click", run);
	return button;
}

function renderCard(
	card: NeedsYouCard,
	answers: Readonly<Record<string, ApprovalAnswer>>,
	actions: NeedsYouActions,
): HTMLElement {
	const { view } = card;
	const answerApproval = actions.answerApproval;
	const approval = answerApproval ? card.approval : undefined;
	const row = view.row;
	const item = element("li", "needs-you__card");
	// Not `data-session-id`: that names the list row's button, which focus and
	// tests find by it.
	item.dataset.needsYou = row.sessionId;

	item.append(homeCardHead(view));

	const ask = element("p", "needs-you__ask");
	ask.textContent = approval
		? t("chat.approval.title", { tool: approval.request.toolName })
		: needsPersonText(card.status);
	const open = cardAction(card, actions);

	// A card the person answers elsewhere is one line: what it waits for, and
	// the way to the agent. Many waiting agents must not push the list away.
	if (!approval || !answerApproval || !open) {
		const line = element("div", "needs-you__line");
		line.append(ask);
		if (open) line.append(open);
		item.append(line);
		return item;
	}

	item.append(ask);
	if (approval.request.summary)
		item.append(
			element("pre", "needs-you__summary", approval.request.summary),
		);
	const answer = answers[approval.attentionId];
	if (answer?.problem) {
		const problem = element("p", "needs-you__problem", t(answer.problem));
		problem.setAttribute("role", "alert");
		item.append(problem);
	}
	const buttons = element("div", "needs-you__actions");
	open.classList.add("needs-you__action--aside");
	buttons.append(open);
	for (const choice of CARD_CHOICES) {
		const button = element(
			"button",
			choice === "approve"
				? "needs-you__action needs-you__action--primary"
				: "needs-you__action",
			t(`home.needsYou.${choice}`),
		);
		button.type = "button";
		button.disabled = answer?.state === "sending";
		button.addEventListener("click", () => answerApproval(card, choice));
		buttons.append(button);
	}
	item.append(buttons);
	return item;
}
