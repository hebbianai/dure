/**
 * Home's Has a result section: the newest agents with a result from the last
 * day, under Needs you and above the list, each with the first line of its
 * last answer, so a result is read without opening every agent. Dure knows a
 * turn finished, not that the work is done, so it never says "done".
 *
 * Which agents count is `homeProjection.recentlyFinished`; their answers are
 * read by `finalResponses.ts`. This file only draws the cards that have one:
 * an agent whose turn left no answer, or whose answer has not arrived yet,
 * stays in the list below only.
 */

import { element } from "./dom";
import { homeCardHead, homeCardSection } from "./homeCard";
import type { FinishedCard } from "./homeProjection";
import { t } from "./i18n";
import { relativeTime } from "./relativeTime";
import type { UnifiedSource } from "./allSessions";
import "./homeFinished.css";

/** The section, or nothing when no finished agent has an answer to show. */
export function renderRecentlyFinished(
	cards: readonly FinishedCard[],
	answers: Readonly<Record<string, string>>,
	now: number,
	actions: { readonly open: (source: UnifiedSource) => void },
): HTMLElement | undefined {
	const shown = cards.flatMap((card) => {
		const answer = answers[card.key];
		return answer ? [renderCard(card, answer, now, actions.open)] : [];
	});
	if (shown.length === 0) return undefined;
	return homeCardSection("finished", t("home.finished.title"), shown);
}

function renderCard(
	card: FinishedCard,
	answer: string,
	now: number,
	open: (source: UnifiedSource) => void,
): HTMLElement {
	const item = element("li", "finished__card");
	// Not `data-session-id`: that names the list row's button.
	item.dataset.finished = card.view.row.sessionId;
	const button = element("button", "finished__open");
	button.type = "button";
	const head = homeCardHead(card.view);
	if (card.view.activityAt !== undefined)
		head.append(
			element("span", "finished__when", relativeTime(card.view.activityAt, now)),
		);
	button.append(head, element("span", "finished__answer", answer));
	button.addEventListener("click", () => open(card.source));
	item.append(button);
	return item;
}
