import { type CellStyle, CursorShape } from "@/contracts/terminalStateProtocol";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import type { TerminalCanvasMetrics } from "./TerminalCanvasRenderer";
import {
	applyTerminalViewportCellStyle,
	hasTerminalViewportStyleFlag,
	terminalViewportColorCss,
} from "./TerminalViewportDomStyle";

interface TerminalViewportDomCursorOptions {
	readonly focused: boolean;
	readonly metrics: Pick<TerminalCanvasMetrics, "cellWidth" | "rowHeight">;
}

export function createTerminalViewportDomCursor(
	documentOwner: Document,
): HTMLDivElement {
	const cursor = documentOwner.createElement("div");
	cursor.dataset.terminalCursor = "";
	cursor.setAttribute("aria-hidden", "true");
	cursor.className = "terminal-viewport-cursor";
	cursor.style.position = "absolute";
	cursor.style.pointerEvents = "none";
	cursor.style.overflow = "hidden";
	return cursor;
}

export function updateTerminalViewportDomCursor(
	cursorElement: HTMLDivElement,
	installed: InstalledTerminalViewportFrame,
	options: TerminalViewportDomCursorOptions,
	cursorText: string | undefined,
): void {
	const cursor = installed.frame.cursor;
	if (
		!cursor?.visible ||
		cursor.row >= installed.frame.viewportRows ||
		cursor.column >= installed.frame.canonicalColumns
	) {
		cursorElement.style.display = "none";
		return;
	}
	const shape = cursorShapeName(cursor.shape);
	const thickness = Math.max(1, Math.round(options.metrics.rowHeight * 0.12));
	const top =
		shape === "underline"
			? (cursor.row + 1) * options.metrics.rowHeight - thickness
			: cursor.row * options.metrics.rowHeight;
	const width =
		shape === "bar"
			? Math.max(1, Math.round(options.metrics.cellWidth * 0.14))
			: options.metrics.cellWidth;
	const height = shape === "underline" ? thickness : options.metrics.rowHeight;
	cursorElement.style.display = "block";
	cursorElement.style.left = `${cursor.column * options.metrics.cellWidth}px`;
	cursorElement.style.top = `${top}px`;
	cursorElement.style.width = `${width}px`;
	cursorElement.style.height = `${height}px`;
	cursorElement.style.border = "0";
	setAttributeIfChanged(cursorElement, "data-shape", shape);
	setAttributeIfChanged(
		cursorElement,
		"data-style-index",
		String(cursor.styleIndex),
	);
	setAttributeIfChanged(
		cursorElement,
		"data-blinking",
		String(cursor.blinking),
	);
	setAttributeIfChanged(
		cursorElement,
		"data-wrap-pending",
		String(cursor.wrapPending),
	);
	const cursorStyle = installed.frame.tables?.styles[cursor.styleIndex];
	if (cursorStyle) {
		cursorElement.style.color = terminalViewportColorCss(
			cursorStyle.foreground,
			"var(--terminal-fg)",
		);
		cursorElement.style.setProperty(
			"--terminal-cursor-cell-background",
			terminalViewportColorCss(cursorStyle.background, "var(--terminal-bg)"),
		);
	}
	if (shape === "block") {
		updateBlockCursorGlyph(
			cursorElement,
			cursorStyle,
			cursorText ?? " ",
			options,
		);
	} else {
		cursorElement
			.querySelector<HTMLElement>("[data-terminal-cursor-glyph]")
			?.remove();
	}
	updateTerminalViewportDomCursorFocus(cursorElement, options.focused);
}

export function updateTerminalViewportDomCursorFocus(
	cursorElement: HTMLDivElement,
	focused: boolean,
): void {
	cursorElement.classList.toggle(
		"terminal-viewport-blink",
		cursorElement.dataset.blinking === "true" && focused,
	);
	cursorElement.style.backgroundColor = focused
		? "var(--terminal-cursor)"
		: "transparent";
	cursorElement.style.boxShadow = focused
		? "none"
		: "inset 0 0 0 1px var(--terminal-cursor)";
	const glyph = cursorElement.querySelector<HTMLElement>(
		"[data-terminal-cursor-glyph]",
	);
	if (glyph) glyph.style.visibility = focused ? "visible" : "hidden";
}

function updateBlockCursorGlyph(
	cursorElement: HTMLDivElement,
	cursorStyle: CellStyle | undefined,
	text: string,
	options: TerminalViewportDomCursorOptions,
): void {
	let glyph = cursorElement.querySelector<HTMLElement>(
		"[data-terminal-cursor-glyph]",
	);
	const created = !glyph;
	if (!glyph) {
		glyph = cursorElement.ownerDocument.createElement("span");
		glyph.dataset.terminalCursorGlyph = "";
		glyph.style.display = "block";
		glyph.style.visibility = options.focused ? "visible" : "hidden";
	}
	glyph.style.width = `${options.metrics.cellWidth}px`;
	glyph.style.height = `${options.metrics.rowHeight}px`;
	glyph.style.lineHeight = `${options.metrics.rowHeight}px`;
	if (cursorStyle) {
		applyTerminalViewportCellStyle(glyph, cursorStyle, {
			backgroundColor: "transparent",
			color: terminalViewportColorCss(
				hasTerminalViewportStyleFlag(cursorStyle.flags, 4)
					? cursorStyle.foreground
					: cursorStyle.background,
				"var(--terminal-bg)",
			),
		});
	}
	updateGlyphText(glyph, text);
	if (created) cursorElement.appendChild(glyph);
}

function updateGlyphText(glyph: HTMLElement, text: string): void {
	const textNode = glyph.firstChild;
	if (textNode instanceof Text && glyph.childNodes.length === 1) {
		if (textNode.data !== text) textNode.data = text;
		return;
	}
	if (glyph.textContent !== text) {
		glyph.replaceChildren(glyph.ownerDocument.createTextNode(text));
	}
}

function setAttributeIfChanged(
	element: HTMLElement,
	name: string,
	value: string,
): void {
	if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function cursorShapeName(shape: CursorShape): "block" | "underline" | "bar" {
	switch (shape) {
		case CursorShape.UNDERLINE:
			return "underline";
		case CursorShape.BAR:
			return "bar";
		default:
			return "block";
	}
}
