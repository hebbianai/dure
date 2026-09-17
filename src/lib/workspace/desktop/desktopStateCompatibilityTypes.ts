import type { Desktop, Space } from "@/types";
import type { DesktopDropPosition } from "./desktopOrder";

export interface AddSpaceOptions {
	name?: string;
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
	setActiveSpace: (id: string) => void;
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
	setActiveDesktop: (id: string) => void;
}
