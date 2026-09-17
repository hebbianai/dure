import type { TerminalResizeRenderObservation } from "@/lib/terminal/qa/terminalResizeRenderObservation";
import type { TerminalViewportFillObservation } from "@/lib/terminal/qa/terminalViewportFill";

/** Renderer-neutral QA projection emitted by structured terminal surfaces. */
export interface TerminalQaBufferState {
	columns: number;
	rows: number;
	fitColumns?: number;
	fitRows?: number;
	fitDimensionsMatch?: boolean;
	viewportFill: TerminalViewportFillObservation;
	bufferLength: number;
	scrollbackRows: number;
	viewportY: number;
	atBottom: boolean;
	concealed: boolean;
	visibleScrollbackMarker?: string;
	logicalScrollbackMarkerPresent?: boolean;
	styledScrollbackMarkerPresent?: boolean;
	resizeRenderSeedVisible: boolean;
	resizeRender?: TerminalResizeRenderObservation;
}
