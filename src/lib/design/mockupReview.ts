// Mockup-anchored review comments: the DiffPanel
// comment→deliverAgentPrompt loop applied to design artifacts — an anchored
// "this margin is wrong" that the agent turns into a mockup edit.

import { t } from "@/lib/i18n";

/** Human- and agent-readable anchor for an element inside a mockup document:
 *  a short ancestor path plus identifying attributes and a text snippet. */
export function describeMockupElement(element: Element): string {
	const parts: string[] = [];
	let node: Element | null = element;
	for (let depth = 0; node && depth < 4; depth++) {
		let part = node.tagName.toLowerCase();
		if (node.id) part += `#${node.id}`;
		else if (typeof node.className === "string" && node.className.trim()) {
			part += `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}`;
		}
		parts.unshift(part);
		node = node.parentElement;
	}
	const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
	return text ? `${parts.join(" > ")} — "${text}"` : parts.join(" > ");
}

export interface MockupCommentInput {
	/** repo-relative mockup path */
	path: string;
	anchor: string;
	comment: string;
}

/** The prompt typed into the agent pane (never auto-submitted — the user
 *  reviews and presses Enter, same trust rule as DesignMode capture). */
export function formatMockupComment({ path, anchor, comment }: MockupCommentInput): string {
	// Typed into the agent pane at user-action time, so t() is callable here;
	// the Korean literals are lookup keys.
	return [
		`[${t("design.mockupReview.title")}] ${path}`,
		`${t("common.target")}: ${anchor}`,
		`${t("design.mockupReview.request")}: ${comment.trim()}`,
		"",
		t("design.mockupReview.editInstructions"),
	].join("\n");
}
