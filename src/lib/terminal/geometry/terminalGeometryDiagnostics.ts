import { terminalDocumentResizeDiagnosticSnapshot } from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";

interface TerminalGeometrySize {
	readonly clientWidth: number;
	readonly clientHeight: number;
	readonly rectWidth: number;
	readonly rectHeight: number;
}

interface TerminalGeometryGrid {
	readonly columns: number;
	readonly rows: number;
}

interface TerminalGeometryAncestor extends TerminalGeometrySize {
	readonly className: string;
}

interface TerminalGeometrySurfaceDiagnostic {
	readonly surfaceId: string;
	readonly canonical: TerminalGeometryGrid | null;
	readonly fit: TerminalGeometryGrid | null;
	readonly cell: { readonly width: number; readonly height: number } | null;
	readonly host: TerminalGeometrySize;
	readonly presentation: TerminalGeometrySize;
	readonly renderedRows: number;
	readonly renderedRuns: number;
	readonly positionedRuns: number;
	readonly ancestors: readonly TerminalGeometryAncestor[];
}

export interface TerminalGeometryDiagnosticSnapshot {
	readonly resizeTransaction: ReturnType<
		typeof terminalDocumentResizeDiagnosticSnapshot
	>;
	readonly surfaces: readonly TerminalGeometrySurfaceDiagnostic[];
}

const TERMINAL_SURFACE_SELECTOR = "[data-terminal-surface-id]";
const TERMINAL_HOST_SELECTOR = ".structured-terminal-host";
const MAX_ANCESTOR_DEPTH = 6;

function finitePositiveAttribute(
	element: HTMLElement,
	name: string,
): number | null {
	const value = Number(element.dataset[name]);
	return Number.isFinite(value) && value > 0 ? value : null;
}

function sizeOf(element: HTMLElement): TerminalGeometrySize {
	const rect = element.getBoundingClientRect();
	return {
		clientWidth: element.clientWidth,
		clientHeight: element.clientHeight,
		rectWidth: rect.width,
		rectHeight: rect.height,
	};
}

function ancestorSizes(host: HTMLElement): TerminalGeometryAncestor[] {
	const ancestors: TerminalGeometryAncestor[] = [];
	let current = host.parentElement;
	while (current && ancestors.length < MAX_ANCESTOR_DEPTH) {
		ancestors.push({
			className: current.className,
			...sizeOf(current),
		});
		current = current.parentElement;
	}
	return ancestors;
}

function surfaceDiagnostic(
	presentation: HTMLElement,
): TerminalGeometrySurfaceDiagnostic | null {
	const surfaceId = presentation.dataset.terminalSurfaceId;
	const host = presentation.closest<HTMLElement>(TERMINAL_HOST_SELECTOR);
	if (!surfaceId || !host) return null;
	const columns = finitePositiveAttribute(
		presentation,
		"terminalCanonicalColumns",
	);
	const rows = finitePositiveAttribute(presentation, "terminalViewportRows");
	const cellWidth = finitePositiveAttribute(presentation, "terminalCellWidth");
	const rowHeight = finitePositiveAttribute(presentation, "terminalRowHeight");
	const hostSize = sizeOf(host);
	const runs = presentation.querySelectorAll("[data-terminal-run]");
	let positionedRuns = 0;
	for (const run of runs) {
		if (run.hasAttribute("data-terminal-cell")) positionedRuns += 1;
	}
	return {
		surfaceId,
		canonical: columns === null || rows === null ? null : { columns, rows },
		fit:
			cellWidth === null || rowHeight === null
				? null
				: {
						columns: Math.max(1, Math.floor(hostSize.rectWidth / cellWidth)),
						rows: Math.max(1, Math.floor(hostSize.rectHeight / rowHeight)),
					},
		cell:
			cellWidth === null || rowHeight === null
				? null
				: { width: cellWidth, height: rowHeight },
		host: hostSize,
		presentation: sizeOf(presentation),
		renderedRows: presentation.querySelectorAll(".term-row").length,
		renderedRuns: runs.length,
		positionedRuns,
		ancestors: ancestorSizes(host),
	};
}

/**
 * Read-only, content-free geometry evidence for the CLI performance report.
 * It projects the canonical resize authority and DOM bounds without retaining
 * terminal text, cwd, credentials, or provider conversation data.
 */
export function collectTerminalGeometryDiagnostics(
	doc: Document,
): TerminalGeometryDiagnosticSnapshot {
	const surfaces = [
		...doc.querySelectorAll<HTMLElement>(TERMINAL_SURFACE_SELECTOR),
	]
		.flatMap((presentation) => {
			const diagnostic = surfaceDiagnostic(presentation);
			return diagnostic ? [diagnostic] : [];
		})
		.sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
	return {
		resizeTransaction: terminalDocumentResizeDiagnosticSnapshot(doc),
		surfaces,
	};
}
