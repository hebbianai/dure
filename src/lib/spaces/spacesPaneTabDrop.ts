import {
	currentSpacesRowDrag,
	endSpacesRowDrag,
	parseSpacesDragPayload,
} from "@/lib/spaces/spacesDrag";
import { movePanelsToDesktop } from "@/lib/workspace/dock";
import { getDragState } from "@/lib/workspace/pane/paneDragState";

/** Dragover cannot read protected payload data; use only the current hint. */
export function canDropPaneOnSpace(spaceId: string): boolean {
	const rowItems = currentSpacesRowDrag();
	const pane = getDragState();
	return (rowItems ?? (pane ? [pane] : [])).some(
		(item) => item.fromDesktopId !== spaceId,
	);
}

/** Consume the payload before moving. The caller may select the destination
 * only when this resolves true; invalid/same-Space drops are harmless. */
export async function dropPanesOnSpace(
	dataTransfer: Pick<DataTransfer, "getData">,
	spaceId: string,
): Promise<boolean> {
	const raw = dataTransfer.getData("text/plain");
	const rowItems = parseSpacesDragPayload(raw);
	const pane = getDragState();
	const items =
		rowItems ?? (raw || currentSpacesRowDrag() || !pane ? [] : [pane]);
	endSpacesRowDrag();
	const moving = items.filter((item) => item.fromDesktopId !== spaceId);
	if (moving.length === 0) return false;
	const receipt = await movePanelsToDesktop(moving, spaceId);
	return !receipt.error && receipt.movedPanelIds.length > 0;
}
