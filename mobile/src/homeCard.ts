/**
 * The parts home's sections above the list share: Needs you and Has a result
 * each draw a heading with its count over a column of cards, and each card
 * opens with the agent's and its project's names, under the agents that
 * manage it and over what it manages (the shared agent row's lines).
 */

import { agentPathText, managedText } from "./agentRowText";
import { element, groupHeading } from "./dom";
import type { HomeRow } from "./homeProjection";
import { providerGlyph } from "./providerGlyph";
import "./homeCard.css";

/** A section above the list: its heading with the count, then its cards. */
export function homeCardSection(
	className: string,
	label: string,
	cards: readonly HTMLElement[],
): HTMLElement {
	const section = element("section", `home-cards ${className}`);
	section.setAttribute("aria-label", label);
	section.append(groupHeading(label, cards.length));
	const list = element("ul", "home-cards__list");
	list.append(...cards);
	section.append(list);
	return section;
}

/**
 * The card's head: the provider's mark beside the agent and its project, with
 * the agents above it (`coordinator › lead`) over that line and what it
 * manages under it. A row with no relation shows neither.
 */
export function homeCardHead(view: HomeRow): HTMLElement {
	const row = view.row;
	const head = element("div", "home-card__head");
	head.append(providerGlyph(view.provider ?? row.source.session.provider_id));
	const who = element("span", "home-card__who");
	const path = view.agent?.path;
	if (path) who.append(element("span", "home-card__path", agentPathText(path)));
	const names = element("span", "home-card__names");
	names.append(element("span", "home-card__agent", row.title));
	const project = view.projectName ?? row.project;
	if (project) names.append(element("span", "home-card__project", project));
	who.append(names);
	const managed = view.agent?.managed;
	if (managed)
		who.append(element("span", "home-card__managed", managedText(managed)));
	head.append(who);
	return head;
}
