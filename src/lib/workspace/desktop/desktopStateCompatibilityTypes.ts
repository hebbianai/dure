import type { Desktop, Space } from "@/types";
import type { DesktopDropPosition } from "./desktopOrder";

/** Why a Space is being made active. `reveal` is a person going to it: the
 * Spaces deck comes forward, from the Work view too, even when the Space is
 * already the active one. `mount` only needs the Space's Dockview to exist
 * (a pane started from the phone) and leaves the window's view as it is. */
type SpaceActivationIntent = "reveal" | "mount";

export interface AddSpaceOptions {
	name?: string;
	/** Make the new Space the active one, which is a reveal (the default).
	 * `false` creates it without changing what the window shows. */
	activate?: boolean;
	kind?: Space["kind"];
	originSpaceId?: string;
	initialLayout?: unknown;
	layoutUpdates?: Record<string, unknown>;
	returnLayout?: unknown;
}

/** @deprecated Use `AddSpaceOptions`. */
export interface AddDesktopOptions extends Omit<AddSpaceOptions, "originSpaceId"> {
	originDesktopId?: string;
}

export interface SpaceDesktopCompatibilitySlice {
	spaces: Space[];
	activeSpaceId: string;
	spaceVisits: Record<string, number>;
	/** @deprecated Alias of `spaces`; both references are always identical. */
	desktops: Desktop[];
	/** @deprecated Alias of `activeSpaceId`. */
	activeDesktopId: string;
	/** @deprecated Alias of `spaceVisits`; both references are always identical. */
	desktopVisits: Record<string, number>;
	addSpace: (opts?: AddSpaceOptions) => string;
	removeSpace: (id: string) => void;
	renameSpace: (id: string, name: string) => void;
	reorderSpace: (
		sourceId: string,
		targetId: string,
		position: DesktopDropPosition,
	) => void;
	setActiveSpace: (id: string, intent: SpaceActivationIntent) => void;
	saveLayout: (spaceId: string, layout: unknown) => void;
	/** @deprecated Use `addSpace`. */
	addDesktop: (opts?: AddDesktopOptions) => string;
	/** @deprecated Use `removeSpace`. */
	removeDesktop: (id: string) => void;
	/** @deprecated Use `renameSpace`. */
	renameDesktop: (id: string, name: string) => void;
	/** @deprecated Use `reorderSpace`. */
	reorderDesktop: (
		sourceId: string,
		targetId: string,
		position: DesktopDropPosition,
	) => void;
	/** @deprecated Use `setActiveSpace`. */
	setActiveDesktop: (id: string, intent: SpaceActivationIntent) => void;
}
