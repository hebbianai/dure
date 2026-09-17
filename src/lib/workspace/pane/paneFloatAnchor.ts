// The floating pane's "original slot" hint (2026-09-01): recorded the moment
// a grid pane floats, consumed when it returns. Same idiom as paneHideAnchor
// (nearest neighbor + restore side), extended with the pane's pre-float pixel
// size so the return split can restore its footprint, not just its position.
// Session-local by design — a reload falls back to the default placement.
import type { DockviewApi } from "dockview-react";
import {
	dockviewRegistry,
	getDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { paneHideAnchor } from "@/lib/workspace/pane/paneHideAnchor";

export interface PaneFloatAnchor {
	referencePanelId: string;
	direction: "left" | "right" | "above" | "below";
	/** Pre-float grid footprint; the axis matching `direction` is restored. */
	size?: { width: number; height: number };
}

const anchors = new Map<string, PaneFloatAnchor>();

const anchorKey = (desktopId: string, panelId: string) =>
	`${desktopId}\0${panelId}`;

/** Capture the pane's grid slot right before it floats. A pane that was not
 * in the grid (already floating) records nothing. */
export function rememberPaneFloatAnchor(
	desktopId: string,
	panelId: string,
): void {
	// The anchor is a hint — capturing it must never fail the float itself
	// (partial dockview fakes in tests, detached elements mid-teardown).
	let anchor: ReturnType<typeof paneHideAnchor>;
	try {
		anchor = paneHideAnchor(desktopId, panelId);
	} catch {
		return;
	}
	if (!anchor || !("referencePanelId" in anchor) || !anchor.referencePanelId) {
		return;
	}
	const panel = getDockview(desktopId)?.getPanel(panelId);
	const box = panel?.group.element.getBoundingClientRect();
	anchors.set(anchorKey(desktopId, panelId), {
		referencePanelId: anchor.referencePanelId,
		direction: anchor.direction,
		...(box ? { size: { width: box.width, height: box.height } } : {}),
	});
}

/** One-shot read — returning to the grid consumes the hint. */
export function takePaneFloatAnchor(
	desktopId: string,
	panelId: string,
): PaneFloatAnchor | undefined {
	const key = anchorKey(desktopId, panelId);
	const anchor = anchors.get(key);
	anchors.delete(key);
	return anchor;
}

/** Same capture for callers that hold the Dockview api but not the desktop
 * id (drag behaviors are installed per container). */
export function rememberPaneFloatAnchorByApi(
	api: DockviewApi,
	panelId: string,
): void {
	for (const [desktopId, candidate] of dockviewRegistry.entries()) {
		if (candidate === api) {
			rememberPaneFloatAnchor(desktopId, panelId);
			return;
		}
	}
}
