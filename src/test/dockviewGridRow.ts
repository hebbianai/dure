import {
	createDockview,
	type DockviewApi,
	type IDockviewPanel,
} from "dockview-react";

export interface DockviewGridRowOptions {
	/** Observes every panel layout Dockview performs, in call order. */
	readonly onLayout?: (width: number, height: number) => void;
	readonly width?: number;
	readonly height?: number;
}

export interface DockviewGridRow {
	readonly api: DockviewApi;
	readonly container: HTMLElement;
	/** Panels in left-to-right order, one group each. */
	readonly panels: readonly IDockviewPanel[];
	/** Grid sashes in DOM order; the first sits between the first two panels. */
	sashes(): HTMLElement[];
	/** The first grid sash. Throws when Dockview created none. */
	sash(): HTMLElement;
	/** Current group widths in panel order. */
	widths(): number[];
	dispose(): void;
}

/**
 * A real Dockview grid in jsdom: one row of single-panel groups split from
 * left to right, laid out at a fixed size so sash geometry is deterministic.
 */
export function createDockviewGridRow(
	ids: readonly string[],
	options: DockviewGridRowOptions = {},
): DockviewGridRow {
	if (ids.length === 0) throw new Error("a grid row needs at least one panel");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
			dispose() {},
			layout(width: number, height: number) {
				options.onLayout?.(width, height);
			},
		}),
	});
	api.layout(options.width ?? 600, options.height ?? 400);
	const panels: IDockviewPanel[] = [];
	for (const id of ids) {
		const previous = panels[panels.length - 1];
		panels.push(
			api.addPanel({
				id,
				component: "test",
				position: previous
					? { referencePanel: previous, direction: "right" }
					: undefined,
			}),
		);
	}
	const sashes = () => [...container.querySelectorAll<HTMLElement>(".dv-sash")];
	return {
		api,
		container,
		panels,
		sashes,
		sash() {
			const [first] = sashes();
			if (!first) throw new Error("Dockview did not create a grid sash");
			return first;
		},
		widths: () => panels.map((panel) => panel.api.width),
		dispose() {
			api.dispose();
			container.remove();
		},
	};
}
