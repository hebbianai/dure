import type { TerminalAsciiRunCapability } from "@/lib/terminal/presentation/terminalViewportMaterialization";

export interface TerminalCanvasMetrics {
	readonly cellWidth: number;
	readonly rowHeight: number;
	readonly columns: number;
	readonly rows: number;
	readonly asciiRunCapability: TerminalAsciiRunCapability;
}

export interface TerminalCanvasTheme {
	readonly background: string;
	readonly foreground: string;
	readonly cursor: string;
	readonly selectionBackground: string;
	readonly indexed: readonly string[];
}

export interface TerminalCanvasRenderer {
	readonly invalidateMetrics: () => void;
	readonly measure: (
		width: number,
		height: number,
		fontFamily: string,
		fontSize: number,
		lineHeight: number,
	) => TerminalCanvasMetrics;
}

interface TerminalCanvasFontMeasurement {
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly lineHeight: number;
	readonly cellWidth: number;
	readonly rowHeight: number;
	readonly asciiRunCapability: TerminalAsciiRunCapability;
}

const PRINTABLE_ASCII = Array.from({ length: 0x7f - 0x20 }, (_, index) =>
	String.fromCharCode(0x20 + index),
);
const FONT_STYLE_PROBES = [
	"normal 400",
	"normal 700",
	"italic 400",
	"italic 700",
] as const;
const FIXED_ADVANCE_TOLERANCE_PX = 0.01;

export function createTerminalCanvasRenderer(): TerminalCanvasRenderer {
	let measurementCanvas: HTMLCanvasElement | null = null;
	let fontMeasurement: TerminalCanvasFontMeasurement | null = null;
	return {
		invalidateMetrics: () => {
			fontMeasurement = null;
		},
		measure: (width, height, fontFamily, fontSize, lineHeight) => {
			if (
				fontMeasurement?.fontFamily !== fontFamily ||
				fontMeasurement.fontSize !== fontSize ||
				fontMeasurement.lineHeight !== lineHeight
			) {
				measurementCanvas ??= document.createElement("canvas");
				const context = measurementCanvas.getContext("2d");
				const fontMetrics = measureTerminalFont(context, fontFamily, fontSize);
				fontMeasurement = {
					fontFamily,
					fontSize,
					lineHeight,
					cellWidth: fontMetrics.cellWidth,
					rowHeight: Math.max(1, fontSize * lineHeight),
					asciiRunCapability: fontMetrics.asciiRunCapability,
				};
			}
			return {
				cellWidth: fontMeasurement.cellWidth,
				rowHeight: fontMeasurement.rowHeight,
				columns: Math.max(1, Math.floor(width / fontMeasurement.cellWidth)),
				rows: Math.max(1, Math.floor(height / fontMeasurement.rowHeight)),
				asciiRunCapability: fontMeasurement.asciiRunCapability,
			};
		},
	};
}

function measureTerminalFont(
	context: CanvasRenderingContext2D | null,
	fontFamily: string,
	fontSize: number,
): {
	readonly cellWidth: number;
	readonly asciiRunCapability: TerminalAsciiRunCapability;
} {
	if (!context) {
		return {
			cellWidth: Math.max(1, fontSize * 0.6),
			asciiRunCapability: "positioned_cells",
		};
	}
	context.font = `normal 400 ${fontSize}px ${fontFamily}`;
	const measuredCellWidth = context.measureText("M").width;
	if (!Number.isFinite(measuredCellWidth) || measuredCellWidth <= 0) {
		return {
			cellWidth: Math.max(1, fontSize * 0.6),
			asciiRunCapability: "positioned_cells",
		};
	}
	const cellWidth = Math.max(1, measuredCellWidth);
	for (const fontStyle of FONT_STYLE_PROBES) {
		context.font = `${fontStyle} ${fontSize}px ${fontFamily}`;
		for (const glyph of PRINTABLE_ASCII) {
			const advance = context.measureText(glyph).width;
			if (
				!Number.isFinite(advance) ||
				Math.abs(advance - cellWidth) > FIXED_ADVANCE_TOLERANCE_PX
			) {
				return { cellWidth, asciiRunCapability: "positioned_cells" };
			}
		}
	}
	return { cellWidth, asciiRunCapability: "fixed_cell_advance" };
}
