import type { Space } from "@/types";

const MAIN_WINDOW_LABEL = "main";
/** Must match the `win-*` capability glob in capabilities/default.json. */
export const SECONDARY_WINDOW_LABEL_PREFIX = "win-";

const WINDOW_LABEL = /^[A-Za-z0-9_-]{1,128}$/;

export function popoutWindowLabel(desktopId: string): string {
	const label = `${SECONDARY_WINDOW_LABEL_PREFIX}popout-${desktopId}`;
	if (!WINDOW_LABEL.test(label)) {
		throw new Error(`invalid popout window label for desktop ${desktopId}`);
	}
	return label;
}

/** A full workspace window: main, or one openDesktopWindow minted
 *  (`win-<time>-<n>`) when a desktop tab was torn out. */
export function isFullDesktopWindowLabel(label: string): boolean {
	return label === MAIN_WINDOW_LABEL || /^win-\d+-\d+$/.test(label);
}

export function spaceWindowLabel(
	space: Pick<Space, "id" | "kind">,
): string {
	return space.kind === "popout"
		? popoutWindowLabel(space.id)
		: MAIN_WINDOW_LABEL;
}

/** Whether `label` may present panes into `space`. Every full workspace
 *  window can show any normal Space; a popout Space lives only in its own
 *  popout window. */
export function spaceWindowAccepts(
	space: Pick<Space, "id" | "kind">,
	label: string,
): boolean {
	return space.kind === "popout"
		? label === popoutWindowLabel(space.id)
		: isFullDesktopWindowLabel(label);
}

/** The window a WebView names when it presents into `space` itself: its own
 *  label when it can host the Space, otherwise the Space's canonical window. */
export function presentingWindowLabel(
	space: Pick<Space, "id" | "kind">,
	currentLabel: string,
): string {
	return spaceWindowAccepts(space, currentLabel)
		? currentLabel
		: spaceWindowLabel(space);
}
