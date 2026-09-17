import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";

const DURE_DRAG_PAYLOAD_PREFIX = "dure:";
export const DURE_DESKTOP_DRAG_TYPE = "dure/desktop";
// Dragover protects payload contents; this MIME advertises placement capability only.
// The ordinary drop handler still parses and validates the text/plain payload.
export const DURE_NEW_PANE_DRAG_TYPE = "application/x-dure-new-pane";

type DragTypeEvent = Pick<DragEvent, "type" | "dataTransfer">;
const hoverTypes = new WeakMap<DragTypeEvent, readonly string[]>();

/** Native hover types are immutable, but reading them can synchronously cross
 * WebKit's process boundary. Share one snapshot across listeners of that event,
 * never across events or the writable dragstart/readable drop phases. */
export function readDragTypes(event: DragTypeEvent): readonly string[] {
	const hover = event.type === "dragenter" || event.type === "dragover";
	if (hover) {
		const types = hoverTypes.get(event);
		if (types) return types;
	}
	const types = Object.freeze(Array.from(event.dataTransfer?.types ?? []));
	if (hover) hoverTypes.set(event, types);
	return types;
}

export function isNewPaneDrag(event: DragTypeEvent): boolean {
	return readDragTypes(event).includes(DURE_NEW_PANE_DRAG_TYPE);
}

export function encodeDureDragPayload(value: unknown): string {
	return `${DURE_DRAG_PAYLOAD_PREFIX}${JSON.stringify(value)}`;
}

export function stripDureDragPayloadPrefix(value: string): string {
	if (value.startsWith(DURE_DRAG_PAYLOAD_PREFIX)) {
		return value.slice(DURE_DRAG_PAYLOAD_PREFIX.length);
	}
	if (value.startsWith(LEGACY_PRODUCT_COMPATIBILITY.dragPayloadPrefix)) {
		return value.slice(LEGACY_PRODUCT_COMPATIBILITY.dragPayloadPrefix.length);
	}
	return value;
}

export function readDurePanelDragData(
	dataTransfer: Pick<DataTransfer, "getData"> | null | undefined,
): string {
	return (
		dataTransfer?.getData("text/plain") ||
		dataTransfer?.getData(LEGACY_PRODUCT_COMPATIBILITY.panelDragMime) ||
		""
	);
}
