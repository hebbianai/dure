import {
	type TerminalCellColors,
	terminalCellColors,
	terminalCursorCell,
} from "@/lib/terminal/presentation/terminalCursorCellPresentation";
import {
	EMPTY_MATERIALIZED_TABLES,
	type MaterializedRow,
	type MaterializedRun,
	materializeTerminalViewportRows,
	materializeTerminalViewportTables,
} from "@/lib/terminal/presentation/terminalViewportMaterialization";
import {
	captureTerminalViewportSelection,
	restoreTerminalViewportSelection,
} from "@/lib/terminal/presentation/terminalViewportSelection";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";

export { terminalViewportSelectionText } from "@/lib/terminal/presentation/terminalViewportSelection";

import type {
	TerminalCanvasMetrics,
	TerminalCanvasTheme,
} from "./TerminalCanvasRenderer";
import {
	createTerminalViewportDomCursor,
	updateTerminalViewportDomCursor,
	updateTerminalViewportDomCursorFocus,
} from "./TerminalViewportDomCursor";
import {
	applyTerminalViewportCellStyle,
	terminalViewportCssHex as cssHex,
} from "./TerminalViewportDomStyle";

export interface TerminalViewportDomPaintResult {
	readonly metrics: TerminalCanvasMetrics;
	readonly rows: InstalledTerminalViewportFrame["frame"]["rows"];
	readonly visibleText: readonly string[];
	readonly cursorCellColors: TerminalCellColors;
}

interface TerminalViewportDomRenderOptions {
	readonly attachmentId: string;
	readonly terminalEpoch: string | null;
	readonly focused: boolean;
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly lineHeight: number;
	readonly metrics: TerminalCanvasMetrics;
	readonly theme: TerminalCanvasTheme;
	readonly openHyperlink?: (uri: string) => void;
}

export interface TerminalViewportDomRenderer {
	readonly clear: (host: HTMLDivElement) => void;
	readonly setFocused: (host: HTMLDivElement, focused: boolean) => void;
	readonly render: (
		host: HTMLDivElement,
		frame: InstalledTerminalViewportFrame,
		options: TerminalViewportDomRenderOptions,
	) => TerminalViewportDomPaintResult;
}

interface RenderedRow {
	readonly identity: string;
	readonly element: HTMLDivElement;
	readonly materialized: MaterializedRow;
}

const ANSI_COLOR_CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

export function createTerminalViewportDomRenderer(): TerminalViewportDomRenderer {
	let activeHost: HTMLDivElement | null = null;
	let renderedAttachmentIdentity = "";
	let renderedProjectionRevision = 0n;
	let renderedPresentationStyleIdentity = "";
	let renderedGeometryIdentity = "";
	let renderedCellWidth = 0;
	let renderedRows: readonly RenderedRow[] = [];
	let renderedTables = EMPTY_MATERIALIZED_TABLES;
	let cursorElement: HTMLDivElement | null = null;
	let openHyperlink: ((uri: string) => void) | undefined;

	const reset = (host: HTMLDivElement, attachmentIdentity: string) => {
		host.classList.add("term-grid", "structured-terminal-dom");
		// The host paints nothing: the outermost terminal wrapper paints the
		// palette background once, with the user's surface alpha folded in
		// (lib/theme/surfaceOpacity), and a second translucent copy here would
		// compound with it. --terminal-bg stays the palette's opaque hex for the
		// cursor and contrast math; default-background cells paint transparent
		// (TerminalViewportDomStyle) so that one surface shows through the text.
		host.style.backgroundColor = "transparent";
		host.style.color = "var(--terminal-fg)";
		host.style.padding = "0";
		host.style.borderRadius = "0";
		host.style.boxShadow = "none";
		host.style.overflow = "hidden";
		delete host.dataset.projectionRevision;
		activeHost = host;
		renderedAttachmentIdentity = attachmentIdentity;
		renderedProjectionRevision = 0n;
		renderedPresentationStyleIdentity = "";
		renderedGeometryIdentity = "";
		renderedCellWidth = 0;
		renderedRows = [];
		renderedTables = EMPTY_MATERIALIZED_TABLES;
		cursorElement = null;
	};

	return {
		clear: (host) => {
			host.replaceChildren();
			host.classList.remove("term-grid", "structured-terminal-dom", "focused");
			delete host.dataset.projectionRevision;
			if (activeHost === host) {
				activeHost = null;
				renderedAttachmentIdentity = "";
				renderedProjectionRevision = 0n;
				renderedPresentationStyleIdentity = "";
				renderedGeometryIdentity = "";
				renderedCellWidth = 0;
				renderedRows = [];
				renderedTables = EMPTY_MATERIALIZED_TABLES;
				cursorElement = null;
			}
		},
		setFocused: (host, focused) => {
			host.classList.toggle("focused", focused);
			if (activeHost !== host || !cursorElement) return;
			updateTerminalViewportDomCursorFocus(cursorElement, focused);
		},
		render: (host, installed, options) => {
			const attachmentIdentity = JSON.stringify([
				options.attachmentId,
				options.terminalEpoch,
			]);
			const preservesPresentation =
				activeHost === host &&
				attachmentIdentity === renderedAttachmentIdentity &&
				cursorElement !== null;
			if (!preservesPresentation) {
				reset(host, attachmentIdentity);
			}
			openHyperlink = options.openHyperlink;
			renderedPresentationStyleIdentity = applyPresentationStyle(
				host,
				installed,
				options,
				renderedPresentationStyleIdentity,
			);
			const geometryIdentity = JSON.stringify([
				installed.frame.canonicalColumns,
				installed.frame.viewportRows,
				options.metrics.cellWidth,
				options.metrics.rowHeight,
				options.metrics.asciiRunCapability,
				options.fontFamily,
				options.fontSize,
				options.lineHeight,
			]);
			const sourceRows = installed.frame.rows.slice(
				0,
				installed.frame.viewportRows,
			);
			const tables = materializeTerminalViewportTables(installed);
			const materializedRows = materializeTerminalViewportRows(
				sourceRows,
				tables,
				options.metrics.asciiRunCapability,
				geometryIdentity === renderedGeometryIdentity
					? renderedRows.map((row) => row.materialized)
					: [],
				renderedTables,
			);
			const mayPrioritizeDamage =
				installed.frame.damageBaseProjectionRevision ===
					renderedProjectionRevision &&
				renderedRows.length === materializedRows.length;
			const selection = preservesPresentation
				? captureTerminalViewportSelection(host)
				: null;
			if (geometryIdentity !== renderedGeometryIdentity) {
				const replacement = replaceRowsAtomically(
					host,
					materializedRows,
					() => openHyperlink,
					{
						columns: installed.frame.canonicalColumns,
						cellWidth: options.metrics.cellWidth,
						rowHeight: options.metrics.rowHeight,
					},
				);
				renderedRows = replacement.rows;
				cursorElement = replacement.cursor;
			} else {
				renderedRows = reconcileRows(
					host,
					cursorElement as HTMLDivElement,
					renderedRows,
					materializedRows,
					mayPrioritizeDamage ? installed.frame.changedRowIndices : [],
					() => openHyperlink,
					{
						columns: installed.frame.canonicalColumns,
						cellWidth: options.metrics.cellWidth,
						rowHeight: options.metrics.rowHeight,
					},
					renderedCellWidth !== options.metrics.cellWidth,
				);
			}
			renderedGeometryIdentity = geometryIdentity;
			renderedCellWidth = options.metrics.cellWidth;
			renderedTables = tables;
			const cursorCell = terminalCursorCell(installed);
			updateTerminalViewportDomCursor(
				cursorElement as HTMLDivElement,
				installed,
				options,
				cursorCell?.text,
			);
			const cursorCellColors = terminalCellColors(cursorCell?.style, {
				foreground: host.style.getPropertyValue("--terminal-fg"),
				background: host.style.getPropertyValue("--terminal-bg"),
				indexed: (index) =>
					host.style.getPropertyValue(`--terminal-color-${index}`) || undefined,
			});
			restoreTerminalViewportSelection(host, selection);
			renderedProjectionRevision = installed.frame.projectionRevision;
			host.dataset.projectionRevision = String(renderedProjectionRevision);
			return {
				metrics: {
					...options.metrics,
					columns: installed.frame.canonicalColumns,
					rows: installed.frame.viewportRows,
				},
				rows: sourceRows,
				visibleText: materializedRows.map((row) => row.text),
				cursorCellColors,
			};
		},
	};
}

interface TerminalDomGridGeometry {
	readonly columns: number;
	readonly cellWidth: number;
	readonly rowHeight: number;
}

function replaceRowsAtomically(
	host: HTMLDivElement,
	next: readonly MaterializedRow[],
	openHyperlink: () => ((uri: string) => void) | undefined,
	geometry: TerminalDomGridGeometry,
): { readonly rows: readonly RenderedRow[]; readonly cursor: HTMLDivElement } {
	const fragment = host.ownerDocument.createDocumentFragment();
	const rows = next.map((materialized) => {
		const element = createRowElement(
			host.ownerDocument,
			materialized,
			openHyperlink,
			geometry,
		);
		fragment.appendChild(element);
		return { identity: materialized.identity, element, materialized };
	});
	const cursor = createTerminalViewportDomCursor(host.ownerDocument);
	fragment.appendChild(cursor);
	host.replaceChildren(fragment);
	return { rows, cursor };
}

function reconcileRows(
	host: HTMLDivElement,
	cursor: HTMLDivElement,
	previous: readonly RenderedRow[],
	next: readonly MaterializedRow[],
	damageHints: readonly number[],
	openHyperlink: () => ((uri: string) => void) | undefined,
	geometry: TerminalDomGridGeometry,
	refreshCellWidths: boolean,
): readonly RenderedRow[] {
	const rendered = new Array<RenderedRow>(next.length);
	const candidates = new Map<string, RenderedRow>();
	const anchorCandidates = new Map<string, RenderedRow>();
	for (const row of previous) {
		candidates.set(row.identity, row);
		anchorCandidates.set(row.materialized.anchorIdentity, row);
	}

	// Damage indices only prioritize work. The validated complete frame remains
	// authoritative, and its unique logical row anchors are part of each identity.
	const visitOrder = rowVisitOrder(next.length, damageHints);
	for (const index of visitOrder) {
		const materialized = next[index];
		if (!materialized) continue;
		const existing = candidates.get(materialized.identity);
		if (existing) {
			candidates.delete(materialized.identity);
			anchorCandidates.delete(existing.materialized.anchorIdentity);
			rendered[index] = { ...existing, materialized };
		} else {
			const anchored = anchorCandidates.get(materialized.anchorIdentity);
			if (anchored) {
				candidates.delete(anchored.identity);
				anchorCandidates.delete(materialized.anchorIdentity);
				updateRowElement(
					anchored.element,
					anchored.materialized,
					materialized,
					openHyperlink,
					geometry,
				);
				rendered[index] = {
					identity: materialized.identity,
					element: anchored.element,
					materialized,
				};
				continue;
			}
			const element = createRowElement(
				host.ownerDocument,
				materialized,
				openHyperlink,
				geometry,
			);
			rendered[index] = {
				identity: materialized.identity,
				element,
				materialized,
			};
		}
	}

	for (const row of candidates.values()) row.element.remove();

	let insertionPoint: ChildNode | null = host.firstChild;
	for (let index = 0; index < rendered.length; index += 1) {
		const row = rendered[index];
		if (!row) continue;
		if (refreshCellWidths) updateRunWidths(row.element, geometry.cellWidth);
		if (row.element === insertionPoint) {
			insertionPoint = insertionPoint.nextSibling;
			continue;
		}
		host.insertBefore(row.element, insertionPoint ?? cursor);
		insertionPoint = row.element.nextSibling;
	}
	return rendered;
}

function rowVisitOrder(
	rowCount: number,
	damageHints: readonly number[],
): readonly number[] {
	const visited = new Set<number>();
	const order: number[] = [];
	for (const index of damageHints) {
		if (index >= rowCount || visited.has(index)) continue;
		visited.add(index);
		order.push(index);
	}
	for (let index = 0; index < rowCount; index += 1) {
		if (visited.has(index)) continue;
		order.push(index);
	}
	return order;
}

function createRowElement(
	documentOwner: Document,
	row: MaterializedRow,
	openHyperlink: () => ((uri: string) => void) | undefined,
	geometry: TerminalDomGridGeometry,
): HTMLDivElement {
	const element = documentOwner.createElement("div");
	element.className = "term-row terminal-viewport-row";
	updateRowPresentation(element, row, geometry);
	appendRowRuns(element, row, openHyperlink, geometry.cellWidth);
	return element;
}

function updateRowElement(
	element: HTMLDivElement,
	previous: MaterializedRow,
	next: MaterializedRow,
	openHyperlink: () => ((uri: string) => void) | undefined,
	geometry: TerminalDomGridGeometry,
): void {
	updateRowPresentation(element, next, geometry);
	const runElements = [...element.children].filter(
		(child): child is HTMLElement =>
			child instanceof HTMLElement && child.dataset.terminalRun !== undefined,
	);
	const mayUpdateRunsInPlace =
		runElements.length === previous.runs.length &&
		previous.runs.length === next.runs.length &&
		runElements.every((runElement, index) => {
			const previousRun = previous.runs[index];
			const nextRun = next.runs[index];
			return (
				previousRun !== undefined &&
				nextRun !== undefined &&
				canUpdateRunElement(runElement, previousRun, nextRun)
			);
		});
	if (!mayUpdateRunsInPlace) {
		const fragment = element.ownerDocument.createDocumentFragment();
		appendRowRuns(fragment, next, openHyperlink, geometry.cellWidth);
		element.replaceChildren(fragment);
		return;
	}
	let column = 0;
	for (let index = 0; index < next.runs.length; index += 1) {
		const run = next.runs[index];
		const runElement = runElements[index];
		if (!run || !runElement) continue;
		updateRunElement(runElement, run, geometry.cellWidth, column);
		column += run.columns;
	}
}

function updateRowPresentation(
	element: HTMLDivElement,
	row: MaterializedRow,
	geometry: TerminalDomGridGeometry,
): void {
	element.style.display = "block";
	element.style.width = `${geometry.columns * geometry.cellWidth}px`;
	element.style.height = `${geometry.rowHeight}px`;
	element.style.lineHeight = `${geometry.rowHeight}px`;
	element.style.overflow = "hidden";
	element.style.whiteSpace = "pre";
	setDatasetValue(element, "logicalLineId", String(row.source.logicalLineId));
	setDatasetValue(
		element,
		"logicalCellOffset",
		String(row.source.logicalCellOffset),
	);
	setDatasetValue(
		element,
		"logicalCellSpan",
		String(row.source.logicalCellSpan),
	);
	setDatasetValue(element, "termination", String(row.source.termination));
	setDatasetValue(
		element,
		"continuesFromPrevious",
		String(row.source.continuesFromPrevious),
	);
}

function appendRowRuns(
	parent: DocumentFragment | HTMLDivElement,
	row: MaterializedRow,
	openHyperlink: () => ((uri: string) => void) | undefined,
	cellWidth: number,
): void {
	let column = 0;
	for (const run of row.runs) {
		parent.appendChild(
			createRunElement(
				parent.ownerDocument,
				run,
				openHyperlink,
				cellWidth,
				column,
			),
		);
		column += run.columns;
	}
}

function createRunElement(
	documentOwner: Document,
	run: MaterializedRun,
	openHyperlink: () => ((uri: string) => void) | undefined,
	cellWidth: number,
	startColumn: number,
): HTMLElement {
	const hyperlinkUri = run.hyperlink
		? safeTerminalHyperlinkUri(run.hyperlink.uri)
		: null;
	const element = hyperlinkUri
		? documentOwner.createElement("a")
		: documentOwner.createElement("span");
	updateRunElement(element, run, cellWidth, startColumn);
	if (run.hyperlink && hyperlinkUri && element instanceof HTMLAnchorElement) {
		element.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openHyperlink()?.(hyperlinkUri);
		});
	}
	return element;
}

function canUpdateRunElement(
	element: HTMLElement,
	previous: MaterializedRun,
	next: MaterializedRun,
): boolean {
	const previousUri = previous.hyperlink
		? safeTerminalHyperlinkUri(previous.hyperlink.uri)
		: null;
	const nextUri = next.hyperlink
		? safeTerminalHyperlinkUri(next.hyperlink.uri)
		: null;
	return (
		previousUri === nextUri &&
		element.tagName === (nextUri === null ? "SPAN" : "A")
	);
}

function updateRunElement(
	element: HTMLElement,
	run: MaterializedRun,
	cellWidth: number,
	startColumn: number,
): void {
	setDatasetValue(element, "terminalRun", "");
	setDatasetValue(element, "terminalBlank", run.text.trim() ? undefined : "");
	setDatasetValue(element, "styleIndex", String(run.styleIndex));
	setDatasetValue(element, "column", String(startColumn));
	setDatasetValue(element, "columns", String(run.columns));
	element.style.display = "inline-block";
	element.style.verticalAlign = "top";
	element.style.whiteSpace = "pre";
	if (run.positionedCell) {
		setDatasetValue(element, "terminalCell", "");
		element.style.direction = "ltr";
		element.style.unicodeBidi = "isolate";
	} else {
		setDatasetValue(element, "terminalCell", undefined);
		element.style.removeProperty("direction");
		element.style.removeProperty("unicode-bidi");
	}
	setDatasetValue(element, "terminalCellMap", run.cellMap || undefined);
	element.style.width = `${run.columns * cellWidth}px`;
	applyTerminalViewportCellStyle(element, run.style);
	const hyperlinkUri = run.hyperlink
		? safeTerminalHyperlinkUri(run.hyperlink.uri)
		: null;
	if (run.hyperlink && hyperlinkUri && element instanceof HTMLAnchorElement) {
		const { params } = run.hyperlink;
		setDatasetValue(element, "terminalHyperlink", "");
		setDatasetValue(element, "osc8Params", params);
		element.href = hyperlinkUri;
		element.target = "_blank";
		element.rel = "noopener noreferrer";
		element.draggable = false;
		element.tabIndex = -1;
	}
	const textNode = element.firstChild;
	if (textNode instanceof Text && element.childNodes.length === 1) {
		if (textNode.data !== run.text) textNode.data = run.text;
	} else {
		element.replaceChildren(element.ownerDocument.createTextNode(run.text));
	}
}

function setDatasetValue(
	element: HTMLElement,
	key: string,
	value: string | undefined,
): void {
	if (value === undefined) {
		if (element.dataset[key] !== undefined) delete element.dataset[key];
		return;
	}
	if (element.dataset[key] !== value) element.dataset[key] = value;
}

function safeTerminalHyperlinkUri(uri: string): string | null {
	try {
		const protocol = new URL(uri).protocol;
		return protocol === "http:" || protocol === "https:" ? uri : null;
	} catch {
		return null;
	}
}

function updateRunWidths(row: HTMLDivElement, cellWidth: number): void {
	for (const run of row.querySelectorAll<HTMLElement>("[data-terminal-run]")) {
		run.style.width = `${Number(run.dataset.columns ?? 0) * cellWidth}px`;
	}
}

function applyPresentationStyle(
	host: HTMLDivElement,
	installed: InstalledTerminalViewportFrame,
	options: TerminalViewportDomRenderOptions,
	previousIdentity: string,
): string {
	host.classList.toggle("focused", options.focused);
	const overrides = installed.frame.colorOverrides;
	const foreground =
		cssHex(overrides?.defaultForegroundRgb) ?? options.theme.foreground;
	const background =
		cssHex(overrides?.defaultBackgroundRgb) ?? options.theme.background;
	const cursor = cssHex(overrides?.cursorRgb) ?? options.theme.cursor;
	const identity = JSON.stringify([
		foreground,
		background,
		cursor,
		options.theme.foreground,
		options.theme.indexed,
		(overrides?.indexed ?? []).map((entry) => [entry.index, entry.rgb]),
		options.metrics.rowHeight,
		options.fontFamily,
		options.fontSize,
		options.lineHeight,
	]);
	if (identity === previousIdentity) return previousIdentity;
	host.style.setProperty("--terminal-fg", foreground);
	host.style.setProperty("--terminal-bg", background);
	host.style.setProperty("--terminal-cursor", cursor);
	const indexedOverrides = new Map(
		(overrides?.indexed ?? []).map((entry) => [entry.index, entry.rgb]),
	);
	for (let index = 0; index < 256; index += 1) {
		host.style.setProperty(
			`--terminal-color-${index}`,
			cssHex(indexedOverrides.get(index)) ??
				options.theme.indexed[index] ??
				ansi256Color(index) ??
				options.theme.foreground,
		);
	}
	host.style.setProperty(
		"--terminal-row-height",
		`${options.metrics.rowHeight}px`,
	);
	host.style.fontFamily = options.fontFamily;
	host.style.fontSize = `${options.fontSize}px`;
	host.style.lineHeight = String(options.lineHeight);
	return identity;
}

function ansi256Color(index: number): string | undefined {
	if (index < 16 || index > 255) return undefined;
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return cssHex(level * 0x010101);
	}
	const offset = index - 16;
	return cssHex(
		(ANSI_COLOR_CUBE_LEVELS[Math.floor(offset / 36)] ?? 0) * 0x010000 +
			(ANSI_COLOR_CUBE_LEVELS[Math.floor((offset % 36) / 6)] ?? 0) * 0x000100 +
			(ANSI_COLOR_CUBE_LEVELS[offset % 6] ?? 0),
	);
}
