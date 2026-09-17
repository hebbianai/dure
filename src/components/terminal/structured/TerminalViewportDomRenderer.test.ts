// @vitest-environment jsdom

import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
	BufferId,
	type CellStyle,
	CellStyleSchema,
	ColorKind,
	CursorShape,
	CursorStateSchema,
	GraphemeSchema,
	type Hyperlink,
	HyperlinkSchema,
	InputModesSchema,
	RowTermination,
	TerminalColorOverridesSchema,
	TerminalColorSchema,
	TerminalRowSchema,
	TerminalTablesSchema,
	UnderlineKind,
	ViewportFrameSchema,
} from "@/contracts/terminalStateProtocol";
import { captureTerminalViewportSelection } from "@/lib/terminal/presentation/terminalViewportSelection";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import {
	createTerminalViewportDomRenderer,
	terminalViewportSelectionText,
} from "./TerminalViewportDomRenderer";

interface TestCell {
	readonly text: string;
	readonly width?: number;
	readonly styleIndex?: number;
}

interface TestRow {
	readonly cells: readonly TestCell[];
	readonly logicalLineId?: bigint;
	readonly logicalCellOffset?: number;
	readonly termination?: RowTermination;
	readonly continuesFromPrevious?: boolean;
}

function installedFrame(
	rows: readonly TestRow[],
	options: {
		readonly revision?: bigint;
		readonly columns?: number;
		readonly damageBase?: bigint;
		readonly changedRows?: readonly number[];
		readonly styles?: readonly CellStyle[];
		readonly hyperlinks?: readonly Hyperlink[];
		readonly indexedOverrides?: readonly {
			readonly index: number;
			readonly rgb: number;
		}[];
		readonly defaultForegroundRgb?: number;
		readonly defaultBackgroundRgb?: number;
		readonly cursorRgb?: number;
		readonly cursor?: {
			readonly row: number;
			readonly column: number;
			readonly styleIndex?: number;
			readonly shape?: CursorShape;
			readonly blinking?: boolean;
			readonly visible?: boolean;
			readonly wrapPending?: boolean;
		};
		readonly activeBuffer?: BufferId;
		readonly followTail?: boolean;
	} = {},
): InstalledTerminalViewportFrame {
	const revision = options.revision ?? 1n;
	const graphemes = rows.flatMap((row) =>
		row.cells.map((cell) =>
			create(GraphemeSchema, {
				text: cell.text,
				displayWidth: cell.width ?? 1,
			}),
		),
	);
	let graphemeIndex = 0;
	return {
		schemaMinor: 4,
		frame: create(ViewportFrameSchema, {
			projectionRevision: revision,
			damageBaseProjectionRevision: options.damageBase ?? 0n,
			canonicalColumns: options.columns ?? 20,
			viewportRows: rows.length,
			activeBuffer: options.activeBuffer ?? BufferId.NORMAL,
			followTail: options.followTail ?? true,
			rows: rows.map((row, rowIndex) => {
				const cells = row.cells.map((cell) => ({
					graphemeIndex: graphemeIndex++,
					styleIndex: cell.styleIndex ?? 0,
				}));
				return create(TerminalRowSchema, {
					rowId: revision * 100n + BigInt(rowIndex + 1),
					logicalLineId: row.logicalLineId ?? BigInt(rowIndex + 1),
					logicalCellOffset: row.logicalCellOffset ?? 0,
					logicalCellSpan: row.cells.reduce(
						(total, cell) => total + (cell.width ?? 1),
						0,
					),
					termination: row.termination ?? RowTermination.HARD_BREAK,
					continuesFromPrevious: row.continuesFromPrevious ?? false,
					cells,
				});
			}),
			tables: create(TerminalTablesSchema, {
				graphemes,
				styles: [
					...(options.styles ?? [
						create(CellStyleSchema, { underline: UnderlineKind.NONE }),
					]),
				],
				hyperlinks: [...(options.hyperlinks ?? [])],
			}),
			cursor: options.cursor
				? create(CursorStateSchema, {
						row: options.cursor.row,
						column: options.cursor.column,
						styleIndex: options.cursor.styleIndex ?? 0,
						shape: options.cursor.shape ?? CursorShape.BLOCK,
						visible: options.cursor.visible ?? true,
						blinking: options.cursor.blinking ?? false,
						wrapPending: options.cursor.wrapPending ?? false,
					})
				: undefined,
			inputModes: create(InputModesSchema),
			colorOverrides: create(TerminalColorOverridesSchema, {
				indexed: [...(options.indexedOverrides ?? [])],
				defaultForegroundRgb: options.defaultForegroundRgb,
				defaultBackgroundRgb: options.defaultBackgroundRgb,
				cursorRgb: options.cursorRgb,
			}),
			changedRowIndices: [...(options.changedRows ?? [])],
		}),
	};
}

const rendererOptions = {
	attachmentId: "attachment-a",
	terminalEpoch: "epoch-a",
	focused: true,
	fontFamily: "monospace",
	fontSize: 14,
	lineHeight: 1.25,
	metrics: {
		cellWidth: 10,
		rowHeight: 20,
		columns: 20,
		rows: 2,
		asciiRunCapability: "fixed_cell_advance" as const,
	},
	theme: {
		background: "rgb(0 0 0)",
		foreground: "rgb(255 255 255)",
		cursor: "rgb(240 240 240)",
		selectionBackground: "rgb(60 70 80)",
		indexed: ["rgb(1 2 3)", "rgb(4 5 6)"],
	},
};

describe("TerminalViewportDomRenderer", () => {
	it("reprojects host style only when its authoritative identity changes", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const baseline = installedFrame([{ cells: [{ text: "baseline" }] }]);
		renderer.render(host, baseline, rendererOptions);
		const setProperty = vi.spyOn(host.style, "setProperty");
		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "successor" }] }], { revision: 2n }),
			rendererOptions,
		);
		expect(setProperty).not.toHaveBeenCalled();

		let revision = 3n;
		let options = rendererOptions;
		let frameOptions: NonNullable<Parameters<typeof installedFrame>[1]> = {};
		const expectReprojection = (verify: () => void = () => {}) => {
			setProperty.mockClear();
			renderer.render(
				host,
				installedFrame([{ cells: [{ text: `revision ${revision}` }] }], {
					...frameOptions,
					revision,
				}),
				options,
			);
			revision += 1n;
			expect(setProperty).toHaveBeenCalled();
			verify();
		};
		const changeTheme = (
			change: Partial<(typeof rendererOptions)["theme"]>,
		) => {
			options = { ...options, theme: { ...options.theme, ...change } };
		};

		changeTheme({ foreground: "rgb(11 12 13)" });
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-fg")).toBe("rgb(11 12 13)"),
		);
		changeTheme({ background: "rgb(21 22 23)" });
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-bg")).toBe("rgb(21 22 23)"),
		);
		changeTheme({ cursor: "rgb(31 32 33)" });
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-cursor")).toBe(
				"rgb(31 32 33)",
			),
		);
		changeTheme({
			indexed: ["rgb(41 42 43)", ...options.theme.indexed.slice(1)],
		});
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-color-0")).toBe(
				"rgb(41 42 43)",
			),
		);

		options = { ...options, fontFamily: "Arial" };
		expectReprojection(() => expect(host.style.fontFamily).toBe("Arial"));
		options = { ...options, fontSize: 16 };
		expectReprojection(() => expect(host.style.fontSize).toBe("16px"));
		options = { ...options, lineHeight: 1.5 };
		expectReprojection(() => expect(host.style.lineHeight).toBe("1.5"));
		options = {
			...options,
			metrics: { ...options.metrics, rowHeight: 24 },
		};
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-row-height")).toBe("24px"),
		);

		frameOptions = { ...frameOptions, defaultForegroundRgb: 0x111213 };
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-fg")).toBe("#111213"),
		);
		frameOptions = { ...frameOptions, defaultBackgroundRgb: 0x212223 };
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-bg")).toBe("#212223"),
		);
		frameOptions = { ...frameOptions, cursorRgb: 0x313233 };
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-cursor")).toBe("#313233"),
		);
		frameOptions = {
			...frameOptions,
			indexedOverrides: [{ index: 1, rgb: 0x010203 }],
		};
		expectReprojection(() =>
			expect(host.style.getPropertyValue("--terminal-color-1")).toBe("#010203"),
		);

		options = { ...options, attachmentId: "attachment-b" };
		expectReprojection();
		options = { ...options, terminalEpoch: "epoch-b" };
		expectReprojection();
		setProperty.mockRestore();

		const replacementHost = document.createElement("div");
		const replacementStyle = vi.spyOn(replacementHost.style, "setProperty");
		renderer.render(
			replacementHost,
			installedFrame([{ cells: [{ text: "replacement host" }] }], {
				...frameOptions,
				revision,
			}),
			options,
		);
		expect(replacementStyle).toHaveBeenCalled();
		replacementStyle.mockRestore();
	});

	it("updates focus presentation without replacing an installed frame", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "stable" }] }], {
				cursor: { row: 0, column: 0, blinking: true },
			}),
			{ ...rendererOptions, focused: false },
		);
		const row = host.querySelector(".terminal-viewport-row");
		const cursor = host.querySelector<HTMLElement>("[data-terminal-cursor]");
		const cursorGlyph = cursor?.querySelector<HTMLElement>(
			"[data-terminal-cursor-glyph]",
		);

		expect(cursor?.style.backgroundColor).toBe("transparent");
		expect(cursor?.style.boxShadow).toContain("inset");
		expect(cursorGlyph?.style.visibility).toBe("hidden");

		renderer.setFocused(host, true);

		expect(host.classList).toContain("focused");
		expect(cursor?.classList).toContain("terminal-viewport-blink");
		expect(cursor?.style.backgroundColor).toBe("var(--terminal-cursor)");
		expect(cursor?.style.boxShadow).toBe("none");
		expect(cursorGlyph?.style.visibility).toBe("visible");
		expect(host.querySelector(".terminal-viewport-row")).toBe(row);
		renderer.setFocused(host, false);
		expect(host.classList).not.toContain("focused");
		expect(cursor?.classList).not.toContain("terminal-viewport-blink");
		expect(cursor?.style.backgroundColor).toBe("transparent");
		expect(cursor?.style.boxShadow).toContain("inset");
		expect(cursorGlyph?.style.visibility).toBe("hidden");
	});

	it("keeps sparse managed inline frames at their canonical rows", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const rows = [
			{ cells: [{ text: "transcript" }] },
			...Array.from({ length: 7 }, () => ({ cells: [{ text: " " }] })),
		];
		const options = {
			...rendererOptions,
			metrics: { ...rendererOptions.metrics, rows: 8 },
		};
		renderer.render(
			host,
			installedFrame(rows, {
				cursor: { row: 4, column: 0 },
				activeBuffer: BufferId.NORMAL,
				followTail: true,
			}),
			options,
		);
		const firstRow = host.querySelector<HTMLElement>(".terminal-viewport-row");
		const cursor = host.querySelector<HTMLElement>("[data-terminal-cursor]");

		expect(firstRow?.style.marginTop).toBe("");
		expect(cursor?.style.top).toBe("80px");

		renderer.render(
			host,
			installedFrame(rows, {
				revision: 2n,
				cursor: { row: 4, column: 0 },
				activeBuffer: BufferId.NORMAL,
				followTail: false,
			}),
			options,
		);
		expect(
			host.querySelector<HTMLElement>(".terminal-viewport-row")?.style
				.marginTop,
		).toBe("");
		expect(cursor?.style.top).toBe("80px");
	});

	it("moves a stable cursor without rebuilding its DOM presentation", async () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const row = {
			cells: Array.from({ length: 4 }, () => ({ text: "A" })),
		};
		const options = { ...rendererOptions, focused: false };
		renderer.render(
			host,
			installedFrame([row], { cursor: { row: 0, column: 0 } }),
			options,
		);
		const cursor = host.querySelector<HTMLElement>("[data-terminal-cursor]");
		const glyph = cursor?.querySelector<HTMLElement>(
			"[data-terminal-cursor-glyph]",
		);
		if (!cursor || !glyph) throw new Error("expected block cursor presentation");
		const records: MutationRecord[] = [];
		const observer = new MutationObserver((mutations) => records.push(...mutations));
		observer.observe(cursor, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});

		renderer.render(
			host,
			installedFrame([row], {
				revision: 2n,
				damageBase: 1n,
				cursor: { row: 0, column: 1 },
			}),
			options,
		);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		observer.disconnect();

		const nextGlyph = cursor.querySelector<HTMLElement>(
			"[data-terminal-cursor-glyph]",
		);
		expect(cursor.style.left).toBe("10px");
		expect(cursor.style.backgroundColor).toBe("transparent");
		expect(
			records.map((record) => ({
				attribute: record.attributeName,
				target:
					record.target === cursor
						? "cursor"
						: (record.target as HTMLElement).dataset?.terminalCursorGlyph !==
							undefined
							? "glyph"
							: "other",
				type: record.type,
			})),
		).toEqual([{ attribute: "style", target: "cursor", type: "attributes" }]);
		expect(nextGlyph).toBe(glyph);
		expect(nextGlyph?.textContent).toBe("A");

		records.length = 0;
		observer.observe(cursor, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});
		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "A" }, { text: "B" }] }], {
				revision: 3n,
				damageBase: 2n,
				cursor: { row: 0, column: 1 },
			}),
			options,
		);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		observer.disconnect();

		expect(cursor.querySelector("[data-terminal-cursor-glyph]")).toBe(glyph);
		expect(glyph.textContent).toBe("B");
		expect(records.map((record) => record.type)).toEqual(["characterData"]);
	});

	it("preserves cursor visibility, shape, blink, wrap, and geometry transitions", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const row = { cells: [{ text: "A" }] };
		renderer.render(
			host,
			installedFrame([row], { cursor: { row: 0, column: 0 } }),
			rendererOptions,
		);
		const cursor = host.querySelector<HTMLElement>("[data-terminal-cursor]");
		const glyph = cursor?.querySelector("[data-terminal-cursor-glyph]");
		if (!cursor || !glyph) throw new Error("expected block cursor presentation");

		renderer.render(
			host,
			installedFrame([row], {
				revision: 2n,
				damageBase: 1n,
				cursor: { row: 0, column: 0, visible: false },
			}),
			rendererOptions,
		);
		expect(host.querySelector("[data-terminal-cursor]")).toBe(cursor);
		expect(cursor.style.display).toBe("none");
		expect(cursor.querySelector("[data-terminal-cursor-glyph]")).toBe(glyph);

		renderer.render(
			host,
			installedFrame([row], {
				revision: 3n,
				damageBase: 2n,
				cursor: {
					row: 0,
					column: 0,
					shape: CursorShape.UNDERLINE,
					blinking: true,
					wrapPending: true,
				},
			}),
			rendererOptions,
		);
		expect(cursor.style.display).toBe("block");
		expect(cursor.dataset.shape).toBe("underline");
		expect(cursor.dataset.blinking).toBe("true");
		expect(cursor.dataset.wrapPending).toBe("true");
		expect(cursor.classList).toContain("terminal-viewport-blink");
		expect(cursor.style.top).toBe("18px");
		expect(cursor.style.width).toBe("10px");
		expect(cursor.style.height).toBe("2px");
		expect(cursor.querySelector("[data-terminal-cursor-glyph]")).toBeNull();
	});

	it("publishes a mixed-width run and cursor on one frame geometry", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const first = installedFrame(
			[
				{
					cells: [
						{ text: "A", width: 1 },
						{ text: "界", width: 2 },
						{ text: "🙂", width: 2 },
					],
				},
			],
			{ cursor: { row: 0, column: 5 } },
		);

		renderer.render(host, first, {
			...rendererOptions,
			metrics: {
				...rendererOptions.metrics,
				cellWidth: 11,
				rowHeight: 19,
				rows: 1,
			},
		});

		const row = host.querySelector<HTMLElement>(".terminal-viewport-row");
		const cursor = host.querySelector<HTMLElement>("[data-terminal-cursor]");
		const runs = [...host.querySelectorAll<HTMLElement>("[data-terminal-run]")];
		expect(
			runs.map((run) => ({
				column: run.dataset.column,
				columns: run.dataset.columns,
				positionedCell: "terminalCell" in run.dataset,
				text: run.textContent,
				width: run.style.width,
			})),
		).toEqual([
			{
				column: "0",
				columns: "1",
				positionedCell: false,
				text: "A",
				width: "11px",
			},
			{
				column: "1",
				columns: "2",
				positionedCell: true,
				text: "界",
				width: "22px",
			},
			{
				column: "3",
				columns: "2",
				positionedCell: true,
				text: "🙂",
				width: "22px",
			},
		]);
		expect(cursor?.style.left).toBe("55px");
		expect(cursor?.style.width).toBe("11px");
		expect(
			runs.reduce(
				(width, run) => width + Number.parseFloat(run.style.width),
				0,
			),
		).toBe(Number.parseFloat(cursor?.style.left ?? ""));
		expect(host.dataset.projectionRevision).toBe("1");

		const second = installedFrame(
			[
				{
					cells: [
						{ text: "A", width: 1 },
						{ text: "界", width: 2 },
						{ text: "🙂", width: 2 },
					],
				},
			],
			{
				revision: 2n,
				damageBase: 1n,
				cursor: { row: 0, column: 5 },
			},
		);
		renderer.render(host, second, {
			...rendererOptions,
			metrics: {
				...rendererOptions.metrics,
				cellWidth: 13,
				rowHeight: 21,
				rows: 1,
			},
		});

		const resizedRow = host.querySelector<HTMLElement>(
			".terminal-viewport-row",
		);
		const resizedCursor = host.querySelector<HTMLElement>(
			"[data-terminal-cursor]",
		);
		const resizedRuns = [
			...host.querySelectorAll<HTMLElement>("[data-terminal-run]"),
		];
		expect(resizedRow).not.toBe(row);
		expect(resizedRuns.map((run) => run.style.width)).toEqual([
			"13px",
			"26px",
			"26px",
		]);
		expect(resizedCursor?.style.left).toBe("65px");
		expect(resizedCursor?.style.height).toBe("21px");
		expect(
			resizedRuns.reduce(
				(width, run) => width + Number.parseFloat(run.style.width),
				0,
			),
		).toBe(Number.parseFloat(resizedCursor?.style.left ?? ""));
		expect(host.dataset.projectionRevision).toBe("2");
	});

	it("keeps rows on the terminal grid and overlays the cursor outside document flow", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const promptCells = [..."Run /review on my current changes"].map(
			(text) => ({
				text,
			}),
		);
		renderer.render(
			host,
			installedFrame(
				[{ cells: promptCells }, { cells: [{ text: "status footer" }] }],
				{
					columns: 40,
					cursor: { row: 0, column: 0 },
				},
			),
			rendererOptions,
		);

		const row = host.querySelector<HTMLElement>(".terminal-viewport-row");
		const run = host.querySelector<HTMLElement>("[data-terminal-run]");
		const cursor = host.querySelector<HTMLElement>("[data-terminal-cursor]");
		expect({
			rowDisplay: row?.style.display,
			rowHeight: row?.style.height,
			rowLineHeight: row?.style.lineHeight,
			rowOverflow: row?.style.overflow,
			rowWhiteSpace: row?.style.whiteSpace,
			rowWidth: row?.style.width,
			runDisplay: run?.style.display,
			runVerticalAlign: run?.style.verticalAlign,
			runWhiteSpace: run?.style.whiteSpace,
			cursorPosition: cursor?.style.position,
			cursorPointerEvents: cursor?.style.pointerEvents,
			cursorOverflow: cursor?.style.overflow,
		}).toEqual({
			rowDisplay: "block",
			rowHeight: "20px",
			rowLineHeight: "20px",
			rowOverflow: "hidden",
			rowWhiteSpace: "pre",
			rowWidth: "400px",
			runDisplay: "inline-block",
			runVerticalAlign: "top",
			runWhiteSpace: "pre",
			cursorPosition: "absolute",
			cursorPointerEvents: "none",
			cursorOverflow: "hidden",
		});
	});

	it("updates a row in place when authoritative cell boundaries change", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const renderer = createTerminalViewportDomRenderer();
		renderer.render(
			host,
			installedFrame(
				[
					{
						cells: [
							{ text: "A", width: 1 },
							{ text: "界", width: 2 },
						],
					},
				],
				{ cursor: { row: 0, column: 3 } },
			),
			{ ...rendererOptions, metrics: { ...rendererOptions.metrics, rows: 1 } },
		);
		const firstRow = host.querySelector(".terminal-viewport-row");

		renderer.render(
			host,
			installedFrame(
				[
					{
						cells: [
							{ text: "A", width: 2 },
							{ text: "界", width: 1 },
						],
					},
				],
				{
					revision: 2n,
					damageBase: 1n,
					changedRows: [0],
					cursor: { row: 0, column: 3 },
				},
			),
			{ ...rendererOptions, metrics: { ...rendererOptions.metrics, rows: 1 } },
		);

		expect(host.querySelector(".terminal-viewport-row")).toBe(firstRow);
		const run = host.querySelector<HTMLElement>("[data-terminal-run]");
		const text = run?.firstChild;
		if (!(text instanceof Text)) throw new Error("expected a row text run");
		const selection = window.getSelection();
		selection?.setBaseAndExtent(text, 0, text, 1);
		expect(
			[...host.querySelectorAll<HTMLElement>("[data-terminal-run]")].reduce(
				(width, candidate) => width + Number.parseFloat(candidate.style.width),
				0,
			),
		).toBe(30);
		expect(captureTerminalViewportSelection(host)).toMatchObject({
			focus: { logicalCellOffset: 2 },
		});
		selection?.removeAllRanges();
		host.remove();
	});

	it("removes stale cell metadata from a reused run", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "界", width: 2 }] }]),
			rendererOptions,
		);
		const row = host.querySelector<HTMLElement>(".terminal-viewport-row");
		const run = row?.querySelector<HTMLElement>("[data-terminal-run]");
		if (!row || !run) throw new Error("expected a positioned terminal run");
		expect(run.dataset.terminalCell).toBe("");
		expect(run.dataset.terminalCellMap).toBeDefined();

		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "A" }, { text: "B" }] }], {
				revision: 2n,
				damageBase: 1n,
				changedRows: [0],
			}),
			rendererOptions,
		);

		expect(host.querySelector(".terminal-viewport-row")).toBe(row);
		expect(row.querySelector("[data-terminal-run]")).toBe(run);
		expect(run.textContent).toBe("AB");
		expect(run.dataset.terminalCell).toBeUndefined();
		expect(run.dataset.terminalCellMap).toBeUndefined();
	});

	it("renders each complete grapheme string without reducing ZWJ or flag clusters", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();

		renderer.render(
			host,
			installedFrame([
				{
					cells: [
						{ text: "👩‍💻", width: 2 },
						{ text: "🇰🇷", width: 2 },
					],
				},
			]),
			rendererOptions,
		);

		expect(host.textContent).toBe("👩‍💻🇰🇷");
	});

	it("treats damage rows as hints when complete rows and OSC palette overrides disagree", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const paletteStyle = create(CellStyleSchema, {
			foreground: create(TerminalColorSchema, {
				kind: ColorKind.PALETTE,
				value: 1,
			}),
			underline: UnderlineKind.NONE,
		});
		renderer.render(
			host,
			installedFrame(
				[
					{ cells: [{ text: "old", styleIndex: 0 }] },
					{ cells: [{ text: "tail" }] },
				],
				{
					styles: [paletteStyle],
					indexedOverrides: [{ index: 1, rgb: 0x010203 }],
				},
			),
			rendererOptions,
		);

		renderer.render(
			host,
			installedFrame(
				[
					{ cells: [{ text: "new", styleIndex: 0 }] },
					{ cells: [{ text: "changed", styleIndex: 0 }] },
				],
				{
					revision: 2n,
					damageBase: 1n,
					changedRows: [1],
					styles: [paletteStyle],
					indexedOverrides: [{ index: 1, rgb: 0x0a0b0c }],
				},
			),
			rendererOptions,
		);

		expect(
			[...host.querySelectorAll<HTMLElement>(".term-row")].map(
				(row) => row.textContent,
			),
		).toEqual(["new", "changed"]);
		expect(host.style.getPropertyValue("--terminal-color-1")).toBe("#0a0b0c");
	});

	it("validates complete rows once and rematerializes only changed presentation", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const rows = Array.from({ length: 4 }, (_, rowIndex) => ({
			cells: Array.from({ length: 20 }, (_, columnIndex) => ({
				text: String.fromCharCode(65 + ((rowIndex + columnIndex) % 26)),
			})),
		}));
		const options = {
			...rendererOptions,
			metrics: { ...rendererOptions.metrics, rows: 4 },
		};
		renderer.render(host, installedFrame(rows), options);
		const previousRows = [
			...host.querySelectorAll<HTMLElement>(".terminal-viewport-row"),
		];
		const nextRows = rows.map((row, rowIndex) => ({
			cells: row.cells.map((cell, columnIndex) => ({
				text:
					rowIndex === rows.length - 1 && columnIndex === row.cells.length - 1
						? "!"
						: cell.text,
			})),
		}));
		const next = installedFrame(nextRows, {
			revision: 2n,
			damageBase: 1n,
			changedRows: [3],
		});
		const tables = next.frame.tables;
		if (!tables) throw new Error("expected terminal tables");
		let graphemeTextReads = 0;
		for (let index = 0; index < tables.graphemes.length; index += 1) {
			const grapheme = tables.graphemes[index];
			if (!grapheme) continue;
			tables.graphemes[index] = new Proxy(grapheme, {
				get(target, property, receiver) {
					if (property === "text") graphemeTextReads += 1;
					return Reflect.get(target, property, receiver);
				},
			});
		}

		renderer.render(host, next, options);

		const renderedRows = [
			...host.querySelectorAll<HTMLElement>(".terminal-viewport-row"),
		];
		expect(renderedRows.map((row) => row.textContent)).toEqual(
			nextRows.map((row) => row.cells.map((cell) => cell.text).join("")),
		);
		expect(renderedRows.slice(0, 3)).toEqual(previousRows.slice(0, 3));
		expect(renderedRows[3]).toBe(previousRows[3]);
		// Normalize every authoritative table entry once. Materializing the one
		// changed row must consume that normalized projection, not raw entries again.
		expect(graphemeTextReads).toBeLessThanOrEqual(80);
	});

	it("updates a ticking status row without detaching its compositor nodes", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const statusCells = (elapsedSeconds: number) =>
			[...`Working (${elapsedSeconds}s • esc to interrupt)`].map((text) => ({
				text,
			}));
		const options = {
			...rendererOptions,
			metrics: { ...rendererOptions.metrics, rows: 2 },
		};
		renderer.render(
			host,
			installedFrame([
				{ logicalLineId: 40n, cells: [{ text: "stable output" }] },
				{
					logicalLineId: 41n,
					cells: statusCells(1),
				},
			]),
			options,
		);
		const statusRow = host.querySelector<HTMLDivElement>(
			'[data-logical-line-id="41"]',
		);
		const statusRuns = statusRow
			? [...statusRow.querySelectorAll<HTMLElement>("[data-terminal-run]")]
			: [];
		const statusTextNodes = statusRuns.map((run) => run.firstChild);
		if (
			!statusRow ||
			statusRuns.length === 0 ||
			statusTextNodes.some((text) => !(text instanceof Text))
		) {
			throw new Error("expected the materialized status row");
		}
		const mutations = new MutationObserver(() => {});
		mutations.observe(statusRow, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});

		try {
			renderer.render(
				host,
				installedFrame(
					[
						{ logicalLineId: 40n, cells: [{ text: "stable output" }] },
						{
							logicalLineId: 41n,
							cells: statusCells(2),
						},
					],
					{ revision: 2n, damageBase: 1n, changedRows: [1] },
				),
				options,
			);

			expect(host.querySelector('[data-logical-line-id="41"]')).toBe(statusRow);
			expect([
				...statusRow.querySelectorAll<HTMLElement>("[data-terminal-run]"),
			]).toEqual(statusRuns);
			expect(statusRuns.map((run) => run.firstChild)).toEqual(statusTextNodes);
			expect(statusRow.textContent).toBe("Working (2s • esc to interrupt)");
			const records = mutations.takeRecords();
			expect(
				records.filter((mutation) => mutation.type === "childList"),
			).toEqual([]);
			const attributeMutations = records
				.filter((mutation) => mutation.type === "attributes")
				.map((mutation) => ({
					attribute: mutation.attributeName,
					target: mutation.target === statusRow ? "row" : "run",
				}));
			expect(attributeMutations).toEqual([]);
			const textMutations = records.filter(
				(mutation) => mutation.type === "characterData",
			);
			expect(textMutations).toHaveLength(1);
			expect(textMutations[0]?.target).toBe(statusTextNodes[0]);
		} finally {
			mutations.disconnect();
		}
	});

	it("keeps a native selection anchored when only another row changes", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const renderer = createTerminalViewportDomRenderer();
		renderer.render(
			host,
			installedFrame(
				[{ cells: [{ text: "selected" }] }, { cells: [{ text: "before" }] }],
				{ cursor: { row: 0, column: 0 } },
			),
			rendererOptions,
		);
		const selectedRow = host.querySelector<HTMLElement>(".term-row");
		if (!selectedRow) throw new Error("expected the selected row");
		const range = document.createRange();
		range.selectNodeContents(selectedRow);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		const anchor = selection?.anchorNode;

		renderer.render(
			host,
			installedFrame(
				[{ cells: [{ text: "selected" }] }, { cells: [{ text: "after" }] }],
				{
					revision: 2n,
					damageBase: 1n,
					changedRows: [1],
					cursor: { row: 0, column: 0 },
				},
			),
			rendererOptions,
		);

		expect(selection?.toString()).toBe("selected");
		expect(selection?.anchorNode).toBe(anchor);
		expect(anchor?.isConnected).toBe(true);
		host.remove();
	});

	it("reuses shifted rows and bounds one-row scroll frames to entering-row DOM work", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const renderer = createTerminalViewportDomRenderer();
		const openHyperlink = vi.fn();
		const plain = create(CellStyleSchema, {
			underline: UnderlineKind.NONE,
		});
		const linked = create(CellStyleSchema, {
			underline: UnderlineKind.SINGLE,
			hyperlinkIndex: 1,
		});
		const hyperlink = create(HyperlinkSchema, {
			uri: "https://example.com/shifted",
			params: "id=shifted",
		});
		const options = {
			...rendererOptions,
			metrics: { ...rendererOptions.metrics, rows: 4 },
			openHyperlink,
		};
		const projectedRows = [
			{ logicalLineId: 10n, cells: [{ text: "alpha" }] },
			{
				logicalLineId: 11n,
				cells: [
					{ text: "B", styleIndex: 1 },
					{ text: "界", width: 2, styleIndex: 1 },
				],
			},
			{ logicalLineId: 12n, cells: [{ text: "charlie" }] },
			{ logicalLineId: 13n, cells: [{ text: "👩‍💻", width: 2 }] },
			{ logicalLineId: 14n, cells: [{ text: "echo" }] },
			{ logicalLineId: 15n, cells: [{ text: "foxtrot" }] },
		];
		const scrollFrame = (start: number, revision: bigint, cursorRow: number) =>
			installedFrame(projectedRows.slice(start, start + 4), {
				revision,
				damageBase: revision - 1n,
				changedRows: revision === 1n ? [] : [0, 1, 2, 3],
				styles: [plain, linked],
				hyperlinks: [hyperlink],
				cursor: { row: cursorRow, column: 0, shape: CursorShape.BAR },
			});
		renderer.render(host, scrollFrame(0, 1n, 3), options);
		const rowsBefore = new Map(
			[...host.querySelectorAll<HTMLDivElement>(".terminal-viewport-row")].map(
				(row) => [row.dataset.logicalLineId, row],
			),
		);
		const linkBefore = host.querySelector<HTMLAnchorElement>(
			"a[data-terminal-hyperlink]",
		);
		const cursorBefore = host.querySelector<HTMLDivElement>(
			"[data-terminal-cursor]",
		);
		const selectedText = rowsBefore
			.get("12")
			?.querySelector("span")?.firstChild;
		if (!(selectedText instanceof Text)) {
			throw new Error("expected selected row text");
		}
		const selection = window.getSelection();
		selection?.setBaseAndExtent(selectedText, 1, selectedText, 5);
		expect(selection?.toString()).toBe("harl");

		const createElement = vi.spyOn(document, "createElement");
		const childList = new MutationObserver(() => {});
		childList.observe(host, { childList: true });
		try {
			renderer.render(host, scrollFrame(1, 2n, 2), options);

			expect(createElement).toHaveBeenCalledTimes(2);
			expect(childList.takeRecords()).toHaveLength(2);
			expect(
				[
					...host.querySelectorAll<HTMLDivElement>(".terminal-viewport-row"),
				].map((row) => row.textContent),
			).toEqual(["B界", "charlie", "👩‍💻", "echo"]);
			expect(host.querySelector('[data-logical-line-id="11"]')).toBe(
				rowsBefore.get("11"),
			);
			expect(host.querySelector('[data-logical-line-id="12"]')).toBe(
				rowsBefore.get("12"),
			);
			expect(host.querySelector('[data-logical-line-id="13"]')).toBe(
				rowsBefore.get("13"),
			);
			expect(host.querySelector("a[data-terminal-hyperlink]")).toBe(linkBefore);
			expect(host.querySelector("[data-terminal-cursor]")).toBe(cursorBefore);
			expect(cursorBefore?.style.top).toBe("40px");
			expect(selection?.anchorNode).toBe(selectedText);
			expect(selectedText.isConnected).toBe(true);
			expect(selection?.toString()).toBe("harl");
			expect(host.textContent).toContain("👩‍💻");
			linkBefore?.click();
			expect(openHyperlink).toHaveBeenCalledWith("https://example.com/shifted");

			const rowsAfterFirstShift = new Map(
				[
					...host.querySelectorAll<HTMLDivElement>(".terminal-viewport-row"),
				].map((row) => [row.dataset.logicalLineId, row]),
			);
			createElement.mockClear();
			renderer.render(host, scrollFrame(2, 3n, 1), options);

			expect(createElement).toHaveBeenCalledTimes(2);
			expect(childList.takeRecords()).toHaveLength(2);
			expect(
				[
					...host.querySelectorAll<HTMLDivElement>(".terminal-viewport-row"),
				].map((row) => row.textContent),
			).toEqual(["charlie", "👩‍💻", "echo", "foxtrot"]);
			expect(host.querySelector('[data-logical-line-id="12"]')).toBe(
				rowsAfterFirstShift.get("12"),
			);
			expect(host.querySelector('[data-logical-line-id="13"]')).toBe(
				rowsAfterFirstShift.get("13"),
			);
			expect(host.querySelector('[data-logical-line-id="14"]')).toBe(
				rowsAfterFirstShift.get("14"),
			);
			expect(cursorBefore?.style.top).toBe("20px");
			expect(selection?.anchorNode).toBe(selectedText);
			expect(selectedText.isConnected).toBe(true);
			expect(selection?.toString()).toBe("harl");
		} finally {
			childList.disconnect();
			createElement.mockRestore();
			selection?.removeAllRanges();
			host.remove();
		}
	});

	it("keeps a logical soft-wrap selection through a complete geometry reflow", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const renderer = createTerminalViewportDomRenderer();
		renderer.render(
			host,
			installedFrame(
				[
					{
						logicalLineId: 77n,
						logicalCellOffset: 0,
						termination: RowTermination.SOFT_WRAP,
						cells: [{ text: "A" }, { text: "界", width: 2 }, { text: "B" }],
					},
					{
						logicalLineId: 77n,
						logicalCellOffset: 4,
						continuesFromPrevious: true,
						cells: [{ text: "C" }, { text: "👩‍💻", width: 2 }, { text: "D" }],
					},
				],
				{ columns: 4 },
			),
			{
				...rendererOptions,
				metrics: { ...rendererOptions.metrics, columns: 4, rows: 2 },
			},
		);
		const selectedCells = [
			...host.querySelectorAll<HTMLElement>("[data-terminal-cell]"),
		];
		const startNode = selectedCells.find(
			(cell) => cell.textContent === "界",
		)?.firstChild;
		const endNode = selectedCells.find(
			(cell) => cell.textContent === "👩‍💻",
		)?.firstChild;
		if (!(startNode instanceof Text) || !(endNode instanceof Text)) {
			throw new Error("expected selection text nodes");
		}
		const range = document.createRange();
		range.setStart(startNode, 0);
		range.setEnd(endNode, endNode.data.length);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		const nativeSelectedText = selection?.toString();
		expect(nativeSelectedText).toBe("界BC👩‍💻");
		expect(captureTerminalViewportSelection(host)).toMatchObject({
			anchor: { logicalLineId: "77", logicalCellOffset: 1 },
			focus: { logicalLineId: "77", logicalCellOffset: 7 },
		});
		expect(terminalViewportSelectionText(host, selection)).toBe("界BC👩‍💻");

		renderer.render(
			host,
			installedFrame(
				[
					{
						logicalLineId: 77n,
						logicalCellOffset: 0,
						termination: RowTermination.SOFT_WRAP,
						cells: [
							{ text: "A" },
							{ text: "界", width: 2 },
							{ text: "B" },
							{ text: "C" },
						],
					},
					{
						logicalLineId: 77n,
						logicalCellOffset: 5,
						continuesFromPrevious: true,
						cells: [{ text: "👩‍💻", width: 2 }, { text: "D" }],
					},
				],
				{ revision: 2n, columns: 5 },
			),
			{
				...rendererOptions,
				metrics: { ...rendererOptions.metrics, columns: 5, rows: 2 },
			},
		);

		expect(startNode.isConnected).toBe(false);
		expect(endNode.isConnected).toBe(false);
		expect(selection?.anchorNode).not.toBe(startNode);
		expect(selection?.focusNode).not.toBe(endNode);
		expect(selection?.anchorNode?.isConnected).toBe(true);
		expect(selection?.focusNode?.isConnected).toBe(true);
		expect(
			selection?.anchorNode?.parentElement?.closest<HTMLElement>(
				".terminal-viewport-row",
			)?.dataset.logicalLineId,
		).toBe("77");
		expect(
			selection?.focusNode?.parentElement?.closest<HTMLElement>(
				".terminal-viewport-row",
			)?.dataset.logicalLineId,
		).toBe("77");
		expect(selection?.toString()).toBe(nativeSelectedText);
		expect(terminalViewportSelectionText(host, selection)).toBe("界BC👩‍💻");
		selection?.removeAllRanges();
		host.remove();
	});

	it("does not carry a local selection across an attachment replacement", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const renderer = createTerminalViewportDomRenderer();
		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "attachment A" }] }]),
			rendererOptions,
		);
		const selectedRow = host.querySelector<HTMLElement>(".term-row");
		if (!selectedRow) throw new Error("expected the selected row");
		const range = document.createRange();
		range.selectNodeContents(selectedRow);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		expect(selection?.toString()).toBe("attachment A");

		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "attachment B" }] }]),
			{ ...rendererOptions, attachmentId: "attachment-b" },
		);

		expect(selection?.toString()).toBe("");
		host.remove();
	});

	it("publishes a geometry-changing complete frame with one visible tree swap", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "before" }] }]),
			rendererOptions,
		);
		const replaceChildren = vi.spyOn(host, "replaceChildren");

		renderer.render(
			host,
			installedFrame(
				[{ cells: [{ text: "after-1" }] }, { cells: [{ text: "after-2" }] }],
				{ revision: 2n },
			),
			{ ...rendererOptions, metrics: { ...rendererOptions.metrics, rows: 2 } },
		);

		expect(replaceChildren).toHaveBeenCalledOnce();
		expect(
			[...host.querySelectorAll<HTMLElement>(".term-row")].map(
				(row) => row.textContent,
			),
		).toEqual(["after-1", "after-2"]);
	});

	it("bounds three visible resize projections to row-level DOM work", () => {
		const paneCount = 3;
		const resizedRowCount = 36;
		const resizedColumnCount = 80;
		const resizedCells = [
			...Array.from({ length: 72 }, () => ({ text: "y" })),
			{ text: "界", width: 2 },
			{ text: "🙂", width: 2 },
			{ text: "e\u0301" },
			{ text: "א" },
			{ text: "z" },
			{ text: "z" },
		];
		const before = installedFrame(
			Array.from({ length: 24 }, () => ({
				cells: Array.from({ length: 60 }, () => ({ text: "x" })),
			})),
			{ columns: 60 },
		);
		const after = installedFrame(
			Array.from({ length: resizedRowCount }, () => ({
				cells: resizedCells,
			})),
			{ revision: 2n, columns: resizedColumnCount },
		);
		const visible = Array.from({ length: paneCount }, () => ({
			host: document.createElement("div"),
			renderer: createTerminalViewportDomRenderer(),
		}));
		for (const pane of visible) {
			pane.renderer.render(pane.host, before, {
				...rendererOptions,
				metrics: {
					...rendererOptions.metrics,
					columns: 60,
					rows: 24,
				},
			});
		}

		const createElement = vi.spyOn(document, "createElement");
		try {
			for (const pane of visible) {
				pane.renderer.render(pane.host, after, {
					...rendererOptions,
					metrics: {
						...rendererOptions.metrics,
						columns: resizedColumnCount,
						rows: resizedRowCount,
					},
				});
			}

			const runsPerRow = 6;
			const rowAndRunElements = resizedRowCount * (1 + runsPerRow);
			expect(createElement).toHaveBeenCalledTimes(
				paneCount * (rowAndRunElements + 1),
			);
			for (const pane of visible) {
				expect(
					pane.host.querySelectorAll(".terminal-viewport-row"),
				).toHaveLength(resizedRowCount);
				expect(pane.host.querySelectorAll("[data-terminal-run]")).toHaveLength(
					resizedRowCount * runsPerRow,
				);
				expect(pane.host.querySelectorAll("[data-terminal-cell]")).toHaveLength(
					resizedRowCount * 4,
				);
			}
		} finally {
			createElement.mockRestore();
		}
	});

	it("keeps proportional-font ASCII on positioned cell boundaries", () => {
		const paneCount = 3;
		const rowCount = 12;
		const columnCount = 40;
		const frame = installedFrame(
			Array.from({ length: rowCount }, () => ({
				cells: Array.from({ length: columnCount }, (_, index) => ({
					text: index % 2 === 0 ? "W" : "i",
				})),
			})),
			{ columns: columnCount },
		);
		const createElement = vi.spyOn(document, "createElement");
		try {
			const visible = Array.from({ length: paneCount }, () => {
				const host = document.createElement("div");
				createTerminalViewportDomRenderer().render(host, frame, {
					...rendererOptions,
					fontFamily: "Arial",
					metrics: {
						...rendererOptions.metrics,
						columns: columnCount,
						rows: rowCount,
						asciiRunCapability: "positioned_cells",
					},
				});
				return host;
			});

			const rowAndCellElements = rowCount * (1 + columnCount);
			expect(createElement).toHaveBeenCalledTimes(
				paneCount * (rowAndCellElements + 2),
			);
			for (const host of visible) {
				expect(host.querySelectorAll("[data-terminal-run]")).toHaveLength(
					rowCount * columnCount,
				);
				expect(host.querySelectorAll("[data-terminal-cell]")).toHaveLength(
					rowCount * columnCount,
				);
			}
		} finally {
			createElement.mockRestore();
		}
	});

	it("materializes decoration, OSC 8, and cursor contracts as DOM behavior", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		const openHyperlink = vi.fn();
		const decorated = create(CellStyleSchema, {
			foreground: create(TerminalColorSchema, {
				kind: ColorKind.RGB,
				value: 0x112233,
			}),
			underlineColor: create(TerminalColorSchema, {
				kind: ColorKind.RGB,
				value: 0x445566,
			}),
			flags: (1n << 3n) | (1n << 6n) | (1n << 7n),
			underline: UnderlineKind.CURLY,
			hyperlinkIndex: 1,
		});
		const hyperlink = create(HyperlinkSchema, {
			uri: "https://example.com/docs",
			params: "id=guide",
		});

		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "linked" }] }], {
				styles: [decorated],
				hyperlinks: [hyperlink],
				cursor: {
					row: 0,
					column: 2,
					styleIndex: 0,
					shape: CursorShape.BAR,
					blinking: true,
				},
			}),
			{ ...rendererOptions, openHyperlink },
		);

		const run = host.querySelector<HTMLElement>("[data-terminal-run]");
		expect(run?.style.textDecorationLine).toContain("underline");
		expect(run?.style.textDecorationLine).toContain("line-through");
		expect(run?.style.textDecorationLine).toContain("overline");
		expect(run?.style.textDecorationStyle).toBe("wavy");
		expect(run?.style.textDecorationColor).toBe("rgb(68, 85, 102)");
		expect(run?.classList.contains("terminal-viewport-blink")).toBe(true);
		const link = host.querySelector<HTMLAnchorElement>(
			"a[data-terminal-hyperlink]",
		);
		expect(link?.dataset.osc8Params).toBe("id=guide");
		expect(link?.getAttribute("href")).toBe("https://example.com/docs");
		expect(link?.target).toBe("_blank");
		expect(link?.rel).toBe("noopener noreferrer");
		link?.click();
		expect(openHyperlink).toHaveBeenCalledWith("https://example.com/docs");
		const cursor = host.querySelector<HTMLElement>("[data-terminal-cursor]");
		expect(cursor?.dataset.shape).toBe("bar");
		expect(cursor?.dataset.styleIndex).toBe("0");
		expect(cursor?.dataset.blinking).toBe("true");

		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "C" }] }], {
				revision: 2n,
				styles: [decorated],
				hyperlinks: [hyperlink],
				cursor: {
					row: 0,
					column: 0,
					styleIndex: 0,
					shape: CursorShape.BLOCK,
				},
			}),
			{ ...rendererOptions, openHyperlink },
		);
		const cursorGlyph = host.querySelector<HTMLElement>(
			"[data-terminal-cursor-glyph]",
		);
		expect(cursorGlyph?.textContent).toBe("C");
		expect(cursorGlyph?.style.textDecorationLine).toContain("overline");
		expect(cursorGlyph?.classList.contains("terminal-viewport-blink")).toBe(
			true,
		);
	});

	it("renders unsafe OSC 8 schemes as inert text", () => {
		const host = document.createElement("div");
		const renderer = createTerminalViewportDomRenderer();
		renderer.render(
			host,
			installedFrame([{ cells: [{ text: "unsafe" }] }], {
				styles: [create(CellStyleSchema, { hyperlinkIndex: 1 })],
				hyperlinks: [
					create(HyperlinkSchema, {
						uri: "javascript:alert(1)",
					}),
				],
			}),
			rendererOptions,
		);

		expect(host.querySelector("a[data-terminal-hyperlink]")).toBeNull();
		expect(host.textContent).toContain("unsafe");
	});
});
