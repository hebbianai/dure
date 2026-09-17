import { create } from "@bufbuild/protobuf";
import { createDockview, themeAbyss } from "dockview-react";
import { createTerminalCanvasRenderer } from "@/components/terminal/structured/TerminalCanvasRenderer";
import { createTerminalViewportDomRenderer } from "@/components/terminal/structured/TerminalViewportDomRenderer";
import { ViewportFrameSchema } from "@/contracts/terminalStateProtocol";

// Render real terminal runs; an empty textarea-only fixture misses #775.
const root = document.getElementById("fixture");
if (!root) throw new Error("Missing focus fixture");
const canvas = createTerminalCanvasRenderer();
const columns = 48;
const rows = 22;
const targets: HTMLTextAreaElement[] = [];
const contents: HTMLElement[] = [];
const frame = create(ViewportFrameSchema, {
	projectionRevision: 1n,
	canonicalColumns: columns,
	viewportRows: rows,
	cursor: { row: rows - 1, column: 1, visible: true, shape: 1 },
	rows: Array.from({ length: rows }, (_, row) => ({
		rowId: BigInt(row + 1),
		logicalLineId: BigInt(row + 1),
		logicalCellSpan: columns,
		termination: 3,
		cells: Array.from({ length: columns }, (_, column) => ({
			graphemeIndex: column % 3,
			styleIndex: column % 2,
		})),
	})),
	tables: {
		graphemes: ["x", "y", "z"].map((text) => ({ text, displayWidth: 1 })),
		styles: [0n, 1n].map((flags) => ({ flags, underline: 1 })),
	},
});

for (let index = 0; index < 12; index++) {
	const container = document.createElement("section");
	container.className = "terminal-host";
	container.style.cssText = "width:300px;height:320px;overflow:hidden";
	const surface = document.createElement("div");
	surface.style.cssText = "position:absolute;inset:0";
	container.append(surface);
	root.append(container);
	const renderer = createTerminalViewportDomRenderer();
	renderer.render(surface, { schemaMinor: 5, frame }, {
		attachmentId: `focus-style-${index}`,
		terminalEpoch: "isolated-focus-style",
		focused: false,
		fontFamily: "monospace",
		fontSize: 10.5,
		lineHeight: 1.5,
		metrics: { ...canvas.measure(300, 320, "monospace", 10.5, 1.5), columns, rows },
		theme: {
			background: "#222222", foreground: "#ffffff", cursor: "#ffffff",
			selectionBackground: "#445566", indexed: [],
		},
	});
	const input = document.createElement("textarea");
	input.setAttribute("aria-label", `Terminal ${index}`);
	input.style.cssText = "position:absolute;width:1px;height:1px;opacity:0";
	input.spellcheck = false;
	input.addEventListener("focus", () => renderer.setFocused(surface, true));
	input.addEventListener("blur", () => renderer.setFocused(surface, false));
	container.append(input);
	targets.push(input);
	contents.push(container);
}

root.replaceChildren();
let next = 0;
const dock = createDockview(root, {
	theme: themeAbyss,
	createComponent: () => ({ element: contents[next++], init() {} }),
});
dock.layout(1200, 760);
for (let index = 0; index < contents.length; index++) {
	const panel = dock.addPanel({
		id: `pane-${index}`, component: "terminal", title: `Pane ${index}`,
		...(index ? { position: { referencePanel: `pane-${index - 1}`, direction: index % 3 ? "below" : "right" } as const } : {}),
	});
	panel.group.api.locked = true;
}

export async function measureFocus() {
	const samples = [];
	for (let index = 0; index < 36; index++) {
		await new Promise(requestAnimationFrame);
		const input = targets[index % targets.length];
		dock.getPanel(`pane-${index % targets.length}`)?.api.setActive();
		const start = performance.now();
		input.focus({ preventScroll: true });
		input.setSelectionRange(input.value.length, input.value.length);
		const duration = performance.now() - start;
		if (document.activeElement !== input) throw new Error("Pane lost input focus");
		// One complete pass warms layout before the measured two passes.
		if (index >= targets.length) samples.push(duration);
	}
	return { runs: root?.querySelectorAll("[data-terminal-run]").length, samples };
}

// Dockview hover toggles this class on the content ancestor. A changing
// inherited variable here makes WebKit recalculate every terminal run's style.
export function measurePaneDropStyle() {
	const grid = JSON.stringify(dock.toJSON().grid);
	const samples: number[] = [];
	let inheritedChanges = 0;
	let contentPreserved = true;
	for (const group of dock.groups) {
		const content = group.element.querySelector<HTMLElement>(".dv-content-container");
		const run = content?.querySelector<HTMLElement>("[data-terminal-run]");
		if (!content || !run) throw new Error("Missing real terminal content");
		const bounds = () => {
			const box = content.getBoundingClientRect();
			return [box.x, box.y, box.width, box.height].join(",");
		};
		const beforeBounds = bounds();
		const beforeColor = getComputedStyle(run).color;
		const beforeDuration = getComputedStyle(run).getPropertyValue("--dv-transition-duration");
		try {
			for (const hovering of [true, false]) {
				const start = performance.now();
				content.classList.toggle("dv-drop-target", hovering);
				const duration = getComputedStyle(run).getPropertyValue("--dv-transition-duration");
				samples.push(performance.now() - start);
				if (duration !== beforeDuration) inheritedChanges++;
				contentPreserved &&= bounds() === beforeBounds && getComputedStyle(run).color === beforeColor;
			}
		} finally {
			content.classList.remove("dv-drop-target");
		}
	}
	return {
		runs: root?.querySelectorAll("[data-terminal-run]").length,
		inheritedChanges,
		contentPreserved,
		gridPreserved: grid === JSON.stringify(dock.toJSON().grid),
		samples,
	};
}

// Dockview inserts a dropzone beside terminal content when entering a pane.
// Child-index selectors must not invalidate the entire terminal subtree (#724).
export function measurePaneOverlayStyle() {
	const grid = JSON.stringify(dock.toJSON().grid);
	const samples: number[] = [];
	let contentPreserved = true;
	for (const group of dock.groups) {
		const content = group.element.querySelector<HTMLElement>(".dv-content-container");
		const run = content?.querySelector<HTMLElement>("[data-terminal-run]");
		if (!content || !run) throw new Error("Missing real terminal content");
		const before = run.outerHTML;
		const zone = document.createElement("div");
		zone.className = "dv-drop-target-dropzone";
		const selection = document.createElement("div");
		selection.className = "dv-drop-target-selection";
		zone.append(selection);
		content.classList.add("dv-drop-target");
		try {
			getComputedStyle(run).display;
			for (let index = 0; index < 2; index++) {
				const start = performance.now();
				content.append(zone);
				// Native drag listeners read dimensions after overlay mutation.
				// Flush that boundary, not only the new selection's own style.
				content.offsetWidth;
				zone.remove();
				content.offsetWidth;
				samples.push(performance.now() - start);
			}
			contentPreserved &&= run.outerHTML === before;
		} finally {
			zone.remove();
			content.classList.remove("dv-drop-target");
		}
	}
	return {
		runs: root?.querySelectorAll("[data-terminal-run]").length,
		contentPreserved,
		gridPreserved: grid === JSON.stringify(dock.toJSON().grid),
		samples,
	};
}
