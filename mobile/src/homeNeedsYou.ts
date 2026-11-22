/**
 * Home's Needs you section: every agent waiting for an approval or an answer,
 * above the list, with the approval answered in place.
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
import type { UnifiedSource } from "./allSessions";
import type { ApprovalAnswer } from "./chat";
import { element, groupHeading } from "./dom";
import type { NeedsYouCard } from "./homeProjection";
import { t } from "./i18n";
import { providerGlyph } from "./providerGlyph";
import "./homeNeedsYou.css";

/** The card's answers, least committal first: Deny, then Allow once. */
const CARD_CHOICES: readonly AgentApprovalChoice[] = ["deny", "approve"];

export interface NeedsYouActions {
	readonly open: (source: UnifiedSource) => void;
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
	const section = element("section", "needs-you");
	const label = t("home.needsYou.title");
	section.setAttribute("aria-label", label);
	section.append(groupHeading(label, shown.length));
	const list = element("ul", "needs-you__list");
	for (const card of shown) list.append(renderCard(card, answers, actions));
	section.append(list);
	return section;
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

	const head = element("div", "needs-you__head");
	head.append(providerGlyph(view.provider ?? row.source.session.provider_id));
	const names = element("span", "needs-you__names");
	names.append(element("span", "needs-you__agent", row.title));
	const project = view.projectName ?? row.project;
	if (project) names.append(element("span", "needs-you__project", project));
	head.append(names);
	item.append(head);

	const ask = element("p", "needs-you__ask");
	ask.textContent = approval
		? t("chat.approval.title", { tool: approval.request.toolName })
		: card.wait === "approval"
			? t("home.needsYou.approval")
			: t("home.needsYou.input");
	const open = element(
		"button",
		"needs-you__action",
		card.wait === "input"
			? t("home.needsYou.reply")
			: t("home.needsYou.open"),
	);
	open.type = "button";
	open.addEventListener("click", () => actions.open(row.source));

	// A card the person answers elsewhere is one line: what it waits for, and
	// the way to the agent. Many waiting agents must not push the list away.
	if (!approval || !answerApproval) {
		const line = element("div", "needs-you__line");
		line.append(ask, open);
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
