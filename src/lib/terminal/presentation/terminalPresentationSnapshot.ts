const STRUCTURED_PRESENTATION_SELECTOR = "[data-terminal-surface-id]";

const SNAPSHOT_ONLY_ATTRIBUTES = [
	"data-terminal-surface-id",
	"data-terminal-canonical-columns",
	"data-terminal-viewport-rows",
	"data-terminal-cell-width",
	"data-terminal-row-height",
] as const;

/** Copies only the already-painted terminal DOM for a visibility handoff.
 * The inert clone is not a live surface and must not enter QA or geometry
 * discovery while the real observer is retired. */
export function cloneTerminalPresentationSnapshot(
	host: HTMLElement,
): HTMLElement | null {
	const presentation = host.querySelector<HTMLElement>(
		STRUCTURED_PRESENTATION_SELECTOR,
	);
	if (!presentation) return null;

	const snapshot = presentation.cloneNode(true) as HTMLElement;
	snapshot.setAttribute("aria-hidden", "true");
	snapshot.setAttribute("data-terminal-presentation-snapshot", "");
	for (const attribute of SNAPSHOT_ONLY_ATTRIBUTES) {
		snapshot.removeAttribute(attribute);
	}
	snapshot.removeAttribute("data-testid");
	for (const element of snapshot.querySelectorAll("[data-testid]")) {
		element.removeAttribute("data-testid");
	}
	for (const input of snapshot.querySelectorAll("textarea")) input.remove();
	for (const cursor of snapshot.querySelectorAll(".terminal-viewport-blink")) {
		cursor.classList.remove("terminal-viewport-blink");
	}
	return snapshot;
}
