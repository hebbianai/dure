import { RowTermination } from "@/contracts/terminalStateProtocol";
import type {
	TerminalSelection,
	TerminalSelectionPoint,
} from "@/lib/terminal/state/terminalSelection";

const TERMINAL_ROW_SELECTOR = ".terminal-viewport-row";
const TERMINAL_RUN_SELECTOR = "[data-terminal-run]";

interface TerminalViewportSelectionPoint {
	readonly logicalLineId: string;
	readonly logicalCellOffset: number;
}

interface NativeSelectionPoint {
	readonly node: Node;
	readonly offset: number;
}

export interface TerminalViewportSelectionSnapshot {
	readonly anchor: TerminalViewportSelectionPoint;
	readonly focus: TerminalViewportSelectionPoint;
	readonly nativeAnchor: NativeSelectionPoint;
	readonly nativeFocus: NativeSelectionPoint;
}

interface ResolvedSelectionPoint {
	readonly node: Node;
	readonly offset: number;
}

interface TerminalRunCellBoundary {
	readonly textEnd: number;
	readonly columnEnd: number;
}

/**
 * Captures browser-local selection in Host-projected logical cell coordinates.
 * The coordinates are presentation state only; they never feed terminal input
 * or become an alternate terminal authority.
 */
export function captureTerminalViewportSelection(
	host: HTMLDivElement,
): TerminalViewportSelectionSnapshot | null {
	const selection = host.ownerDocument.getSelection();
	const anchorNode = selection?.anchorNode;
	const focusNode = selection?.focusNode;
	if (
		!selection ||
		selection.rangeCount === 0 ||
		!anchorNode ||
		!focusNode ||
		!host.contains(anchorNode) ||
		!host.contains(focusNode)
	) {
		return null;
	}
	const anchor = logicalPointForDomPoint(
		host,
		anchorNode,
		selection.anchorOffset,
	);
	const focus = logicalPointForDomPoint(host, focusNode, selection.focusOffset);
	if (!anchor || !focus) return null;
	return {
		anchor,
		focus,
		nativeAnchor: { node: anchorNode, offset: selection.anchorOffset },
		nativeFocus: { node: focusNode, offset: selection.focusOffset },
	};
}

/** Restores a captured selection after the complete rows and cursor are live. */
export function restoreTerminalViewportSelection(
	host: HTMLDivElement,
	snapshot: TerminalViewportSelectionSnapshot | null,
): void {
	if (!snapshot) return;
	const selection = host.ownerDocument.getSelection();
	if (!selection) return;
	if (
		selection.anchorNode === snapshot.nativeAnchor.node &&
		selection.anchorOffset === snapshot.nativeAnchor.offset &&
		selection.focusNode === snapshot.nativeFocus.node &&
		selection.focusOffset === snapshot.nativeFocus.offset &&
		snapshot.nativeAnchor.node.isConnected &&
		snapshot.nativeFocus.node.isConnected &&
		host.contains(snapshot.nativeAnchor.node) &&
		host.contains(snapshot.nativeFocus.node)
	) {
		return;
	}
	const anchor = domPointForLogicalPoint(host, snapshot.anchor);
	const focus = domPointForLogicalPoint(host, snapshot.focus);
	if (!anchor || !focus) return;
	try {
		selection.setBaseAndExtent(
			anchor.node,
			anchor.offset,
			focus.node,
			focus.offset,
		);
	} catch {
		// Selection is non-critical local presentation. A logical line may leave
		// the viewport between capture and install; never fail a complete frame.
	}
}

/** Projects the local logical drag selection onto the currently installed
 * viewport. When its true anchor has scrolled out of the DOM, the visible
 * highlight is clamped to the corresponding edge; the accumulated logical
 * selection remains the copy authority. */
export function applyTerminalViewportSelection(
	host: HTMLDivElement,
	selectionModel: TerminalSelection,
	offscreenAnchorEdge: "start" | "end",
): void {
	const selection = host.ownerDocument.getSelection();
	if (!selection) return;
	const anchor =
		domPointForTerminalSelectionPoint(host, selectionModel.anchor) ??
		domPointForViewportEdge(host, offscreenAnchorEdge);
	const focus = domPointForTerminalSelectionPoint(host, selectionModel.focus);
	if (!anchor || !focus) return;
	try {
		selection.setBaseAndExtent(
			anchor.node,
			anchor.offset,
			focus.node,
			focus.offset,
		);
	} catch {
		// The next complete frame will retry against its live row generation.
	}
}

function domPointForTerminalSelectionPoint(
	host: HTMLDivElement,
	point: TerminalSelectionPoint,
): ResolvedSelectionPoint | null {
	return domPointForLogicalPoint(host, {
		logicalLineId: String(point.logicalLineId),
		logicalCellOffset: point.logicalCellOffset,
	});
}

function domPointForViewportEdge(
	host: HTMLDivElement,
	edge: "start" | "end",
): ResolvedSelectionPoint | null {
	const rows = host.querySelectorAll<HTMLElement>(TERMINAL_ROW_SELECTOR);
	const row = edge === "start" ? rows[0] : rows[rows.length - 1];
	if (!row) return null;
	const run =
		edge === "start"
			? row.querySelector<HTMLElement>(TERMINAL_RUN_SELECTOR)
			: [...row.querySelectorAll<HTMLElement>(TERMINAL_RUN_SELECTOR)].pop();
	if (!run) {
		return {
			node: row,
			offset: edge === "start" ? 0 : row.childNodes.length,
		};
	}
	return runBoundaryForColumn(
		run,
		edge === "start"
			? 0
			: finiteDatasetNumber(run.dataset.columns) ?? 0,
		finiteDatasetNumber(run.dataset.columns) ?? 0,
	);
}

function logicalPointForDomPoint(
	host: HTMLDivElement,
	node: Node,
	offset: number,
): TerminalViewportSelectionPoint | null {
	const rowBoundary = terminalRowForDomPoint(host, node, offset);
	if (!rowBoundary) return null;
	const { row, edge } = rowBoundary;
	const logicalLineId = row.dataset.logicalLineId;
	const rowOffset = finiteDatasetNumber(row.dataset.logicalCellOffset);
	const rowSpan = finiteDatasetNumber(row.dataset.logicalCellSpan);
	if (!logicalLineId || rowOffset === null || rowSpan === null) return null;
	let cellOffset: number;
	if (edge === "start") cellOffset = 0;
	else if (edge === "end") cellOffset = rowSpan;
	else cellOffset = cellOffsetForDomPoint(row, node, offset, rowSpan);
	return {
		logicalLineId,
		logicalCellOffset: rowOffset + cellOffset,
	};
}

function terminalRowForDomPoint(
	host: HTMLDivElement,
	node: Node,
	offset: number,
): { readonly row: HTMLElement; readonly edge: "start" | "end" | null } | null {
	const element = node instanceof Element ? node : node.parentElement;
	const row = element?.closest<HTMLElement>(TERMINAL_ROW_SELECTOR);
	if (row && host.contains(row)) return { row, edge: null };
	if (node !== host) return null;
	const rows = [...host.querySelectorAll<HTMLElement>(TERMINAL_ROW_SELECTOR)];
	if (rows.length === 0) return null;
	for (const candidate of rows) {
		const childIndex = [...host.childNodes].indexOf(candidate);
		if (offset <= childIndex) return { row: candidate, edge: "start" };
	}
	return { row: rows[rows.length - 1] as HTMLElement, edge: "end" };
}

function cellOffsetForDomPoint(
	row: HTMLElement,
	node: Node,
	offset: number,
	rowSpan: number,
): number {
	const pointElement = node instanceof Element ? node : node.parentElement;
	const owningRun = pointElement?.closest<HTMLElement>(TERMINAL_RUN_SELECTOR);
	if (owningRun && row.contains(owningRun)) {
		return runCellOffsetForDomPoint(owningRun, node, offset, rowSpan);
	}
	for (const run of row.querySelectorAll<HTMLElement>(TERMINAL_RUN_SELECTOR)) {
		const column = finiteDatasetNumber(run.dataset.column);
		const columns = finiteDatasetNumber(run.dataset.columns);
		if (column === null || columns === null) continue;
		if (compareDomPoints(node, offset, run, 0) <= 0) return column;
		if (compareDomPoints(node, offset, run, run.childNodes.length) < 0) {
			return runCellOffsetForDomPoint(run, node, offset, rowSpan);
		}
	}
	return rowSpan;
}

function runCellOffsetForDomPoint(
	run: HTMLElement,
	node: Node,
	offset: number,
	rowSpan: number,
): number {
	const column = finiteDatasetNumber(run.dataset.column);
	const columns = finiteDatasetNumber(run.dataset.columns);
	if (column === null || columns === null) return rowSpan;
	const prefix = run.ownerDocument.createRange();
	prefix.setStart(run, 0);
	prefix.setEnd(node, offset);
	return column + columnsForTextOffset(run, prefix.toString().length, columns);
}

function columnsForTextOffset(
	run: HTMLElement,
	textOffset: number,
	columns: number,
): number {
	if (textOffset <= 0) return 0;
	const encoded = run.dataset.terminalCellMap;
	if (!encoded) return Math.min(columns, textOffset);
	const boundaries = decodeTerminalRunCellBoundaries(encoded);
	if (!boundaries) return columns;
	let previousTextEnd = 0;
	let previousColumnEnd = 0;
	for (const boundary of boundaries) {
		if (textOffset <= previousTextEnd) return previousColumnEnd;
		if (textOffset <= boundary.textEnd) {
			return Math.min(columns, boundary.columnEnd);
		}
		previousTextEnd = boundary.textEnd;
		previousColumnEnd = boundary.columnEnd;
	}
	return columns;
}

function decodeTerminalRunCellBoundaries(
	encoded: string,
): readonly TerminalRunCellBoundary[] | null {
	let textEnd = 0;
	let columnEnd = 0;
	const boundaries: TerminalRunCellBoundary[] = [];
	for (const cell of encoded.split(",")) {
		const [encodedLength, encodedColumns] = cell.split(".");
		const textLength = Number.parseInt(encodedLength ?? "", 36);
		const cellColumns = Number.parseInt(encodedColumns ?? "", 36);
		if (
			!Number.isInteger(textLength) ||
			textLength < 0 ||
			!Number.isInteger(cellColumns) ||
			cellColumns < 0
		) {
			return null;
		}
		textEnd += textLength;
		columnEnd += cellColumns;
		boundaries.push({ textEnd, columnEnd });
	}
	return boundaries;
}

function compareDomPoints(
	leftNode: Node,
	leftOffset: number,
	rightNode: Node,
	rightOffset: number,
): number {
	const documentOwner = leftNode.ownerDocument;
	if (!documentOwner || rightNode.ownerDocument !== documentOwner) return 0;
	const left = documentOwner.createRange();
	left.setStart(leftNode, leftOffset);
	left.collapse(true);
	const right = documentOwner.createRange();
	right.setStart(rightNode, rightOffset);
	right.collapse(true);
	return left.compareBoundaryPoints(Range.START_TO_START, right);
}

function domPointForLogicalPoint(
	host: HTMLDivElement,
	point: TerminalViewportSelectionPoint,
): ResolvedSelectionPoint | null {
	for (const row of host.querySelectorAll<HTMLElement>(TERMINAL_ROW_SELECTOR)) {
		if (row.dataset.logicalLineId !== point.logicalLineId) continue;
		const rowOffset = finiteDatasetNumber(row.dataset.logicalCellOffset);
		const rowSpan = finiteDatasetNumber(row.dataset.logicalCellSpan);
		if (
			rowOffset === null ||
			rowSpan === null ||
			point.logicalCellOffset < rowOffset ||
			point.logicalCellOffset > rowOffset + rowSpan
		) {
			continue;
		}
		const relativeOffset = point.logicalCellOffset - rowOffset;
		for (const run of row.querySelectorAll<HTMLElement>(
			TERMINAL_RUN_SELECTOR,
		)) {
			const column = finiteDatasetNumber(run.dataset.column);
			const columns = finiteDatasetNumber(run.dataset.columns);
			if (column === null || columns === null) continue;
			if (relativeOffset <= column) return runBoundary(run, 0);
			if (relativeOffset <= column + columns) {
				return runBoundaryForColumn(run, relativeOffset - column, columns);
			}
		}
		return { node: row, offset: row.childNodes.length };
	}
	return null;
}

function runBoundaryForColumn(
	run: HTMLElement,
	columnOffset: number,
	columns: number,
): ResolvedSelectionPoint {
	const text = run.firstChild;
	if (text instanceof Text) {
		if (columnOffset <= 0) return { node: text, offset: 0 };
		const encoded = run.dataset.terminalCellMap;
		if (!encoded) {
			return { node: text, offset: Math.min(text.data.length, columnOffset) };
		}
		const boundaries = decodeTerminalRunCellBoundaries(encoded);
		if (boundaries) {
			for (const boundary of boundaries) {
				if (columnOffset <= boundary.columnEnd) {
					return {
						node: text,
						offset: Math.min(text.data.length, boundary.textEnd),
					};
				}
			}
		}
		return { node: text, offset: text.data.length };
	}
	return {
		node: run,
		offset: columnOffset >= columns ? run.childNodes.length : 0,
	};
}

function runBoundary(
	run: HTMLElement,
	columnOffset: number,
): ResolvedSelectionPoint {
	return runBoundaryForColumn(
		run,
		columnOffset,
		finiteDatasetNumber(run.dataset.columns) ?? 0,
	);
}

function finiteDatasetNumber(value: string | undefined): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function terminalViewportSelectionText(
	host: HTMLDivElement | null,
	selection: Selection | null,
): string {
	if (
		!host ||
		!selection ||
		selection.isCollapsed ||
		selection.rangeCount === 0
	) {
		return "";
	}
	const anchor = selection.anchorNode;
	const focus = selection.focusNode;
	if (!anchor || !focus || !host.contains(anchor) || !host.contains(focus)) {
		return "";
	}
	const range = selection.getRangeAt(0);
	const selectedRows: Array<{
		readonly text: string;
		readonly logicalLineId: string;
		readonly logicalCellOffset: number;
		readonly logicalCellSpan: number;
		readonly continuesFromPrevious: boolean;
		readonly termination: RowTermination;
	}> = [];
	for (const row of host.querySelectorAll<HTMLElement>(TERMINAL_ROW_SELECTOR)) {
		if (!range.intersectsNode(row)) continue;
		const slice = host.ownerDocument.createRange();
		slice.selectNodeContents(row);
		if (row.contains(range.startContainer)) {
			slice.setStart(range.startContainer, range.startOffset);
		}
		if (row.contains(range.endContainer)) {
			slice.setEnd(range.endContainer, range.endOffset);
		}
		selectedRows.push({
			text: slice.toString().trimEnd(),
			logicalLineId: row.dataset.logicalLineId ?? "",
			logicalCellOffset: Number(row.dataset.logicalCellOffset ?? 0),
			logicalCellSpan: Number(row.dataset.logicalCellSpan ?? 0),
			continuesFromPrevious: row.dataset.continuesFromPrevious === "true",
			termination: Number(
				row.dataset.termination ?? RowTermination.HARD_BREAK,
			) as RowTermination,
		});
	}
	let text = "";
	for (const [index, row] of selectedRows.entries()) {
		const previous = selectedRows[index - 1];
		if (previous) {
			const continuousSoftWrap =
				previous.termination === RowTermination.SOFT_WRAP &&
				previous.logicalLineId === row.logicalLineId &&
				row.continuesFromPrevious &&
				previous.logicalCellOffset + previous.logicalCellSpan ===
					row.logicalCellOffset;
			if (!continuousSoftWrap) text += "\n";
		}
		text += row.text;
	}
	return text;
}
