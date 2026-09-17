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

export function spaceWindowLabel(
	space: Pick<Space, "id" | "kind">,
): string {
	return space.kind === "popout"
		? popoutWindowLabel(space.id)
		: MAIN_WINDOW_LABEL;
}
