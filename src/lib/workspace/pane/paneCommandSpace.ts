import { windowMainView } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";

/** The Space a pane command acts on: the one a window draws by itself (a
 * popout), otherwise the active Space while the Spaces deck is in front.
 * Behind the Work view no pane is in front of the person, so pane commands
 * and shortcuts find no Space and do nothing; the key passes through. */
export function paneCommandSpaceId(targetDesktopId?: string): string | undefined {
	if (targetDesktopId !== undefined) return targetDesktopId;
	return windowMainView() === "spaces"
		? useStore.getState().activeSpaceId
		: undefined;
}
