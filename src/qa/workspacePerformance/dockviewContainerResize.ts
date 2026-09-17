import { createDockview } from "dockview-react";
import { observeDockviewContainer } from "@/lib/workspace/dock/dockviewContainerResize";

/** Runs in the native workspace QA as well as an isolated browser. Measuring
 * in ResizeObserver delivery catches a stale grid before paint; waiting for a
 * settled screenshot would hide the extra frame this regression protects.
 */
export async function assertDockviewContainerResize(
	doc: Document,
): Promise<void> {
	const container = doc.createElement("div");
	container.style.cssText =
		"position:fixed;left:0;top:0;width:1000px;height:600px;contain:strict";
	doc.body.append(container);
	const api = createDockview(container, {
		disableAutoResizing: true,
		createComponent: () => ({ element: doc.createElement("div"), init() {} }),
	});
	const stopResize = observeDockviewContainer(container, api);
	let measure: (() => void) | undefined;
	const measurements = new ResizeObserver(() => measure?.());
	measurements.observe(container);
	try {
		for (let index = 0; index < 12; index++) {
			api.addPanel({
				id: `resize-${index}`,
				component: "test",
				position: index
					? {
							referencePanel: `resize-${index - 1}`,
							direction: index % 3 === 0 ? "below" : "right",
						}
					: undefined,
			});
		}
		for (let index = 0; index < 20; index++) {
			await new Promise<void>((resolve) =>
				doc.defaultView!.requestAnimationFrame(() => resolve()),
			);
			const width = 1_012 + index * 12;
			const height = 604 + index * 4;
			await new Promise<void>((resolve) => {
				measure = resolve;
				container.style.width = `${width}px`;
				container.style.height = `${height}px`;
			});
			if (api.width !== width || api.height !== height) {
				throw new Error(
					`workspace grid trails its container: ${api.width}x${api.height}, expected ${width}x${height}`,
				);
			}
			const bounds = container.getBoundingClientRect();
			const groups = api.groups.map((group) =>
				group.element.getBoundingClientRect(),
			);
			const right = Math.max(...groups.map((group) => group.right));
			const bottom = Math.max(...groups.map((group) => group.bottom));
			if (
				Math.abs(right - bounds.right) > 1 ||
				Math.abs(bottom - bounds.bottom) > 1
			) {
				throw new Error(
					"workspace pane edges trail their container before paint",
				);
			}
		}
	} finally {
		measurements.disconnect();
		stopResize();
		api.dispose();
		container.remove();
	}
}
