import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import type { TerminalViewportDomPaintResult } from "./TerminalViewportDomRenderer";

export interface PaintedPresentation {
	readonly width: number;
	readonly height: number;
	readonly sessionId: string;
	readonly attachmentId: string;
	readonly terminalEpoch: string | null;
	readonly frame: InstalledTerminalViewportFrame;
	readonly paint: TerminalViewportDomPaintResult;
}

export interface TerminalProjectionTiming {
	readonly projectionStartedAt: number;
	readonly projectionCommittedAt: number;
}

const TERMINAL_CANVAS_HOLD_PROPERTIES = [
	"top",
	"right",
	"bottom",
	"left",
	"width",
	"height",
] as const;

export function isCurrentTerminalCanvasPresentation(
	presentation: PaintedPresentation | null,
	sessionId: string,
	attachmentId: string,
	terminalEpoch: string | null,
): boolean {
	return (
		presentation !== null &&
		presentation.sessionId === sessionId &&
		presentation.attachmentId === attachmentId &&
		presentation.terminalEpoch !== null &&
		presentation.terminalEpoch === terminalEpoch
	);
}

export function holdTerminalCanvasPresentation(
	layer: HTMLDivElement,
	presentation: PaintedPresentation,
): void {
	const followTail = presentation.frame.frame.followTail;
	layer.style.top = followTail ? "auto" : "0px";
	layer.style.right = "auto";
	layer.style.bottom = followTail ? "0px" : "auto";
	layer.style.left = "0px";
	layer.style.width = `${presentation.width}px`;
	layer.style.height = `${presentation.height}px`;
}

export function releaseTerminalCanvasPresentation(layer: HTMLDivElement): void {
	for (const property of TERMINAL_CANVAS_HOLD_PROPERTIES) {
		if (layer.style.getPropertyValue(property) !== "") {
			layer.style.removeProperty(property);
		}
	}
}
