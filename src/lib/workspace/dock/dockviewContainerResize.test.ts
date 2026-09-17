// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeDockviewContainer } from "./dockviewContainerResize";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		disableAutoResizing: true,
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1_000, 600);
	const left = api.addPanel({ id: "left", component: "test" });
	const right = api.addPanel({
		id: "right",
		component: "test",
		position: { referencePanel: "left", direction: "right" },
	});
	left.group.api.setSize({ width: 300 });
	const layout = vi.spyOn(api, "layout");
	const disconnect = vi.fn();
	let deliver: (width: number, height: number) => void = () => {};
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				deliver = (width, height) =>
					callback(
						[
							{
								target: container,
								contentRect: new DOMRectReadOnly(0, 0, width, height),
								contentBoxSize: [{ inlineSize: width, blockSize: height }],
								borderBoxSize: [{ inlineSize: width, blockSize: height }],
								devicePixelContentBoxSize: [
									{ inlineSize: width, blockSize: height },
								],
							},
						],
						this,
					);
			}
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = disconnect;
		},
	);
	const stop = observeDockviewContainer(container, api);
	return {
		api,
		left,
		right,
		layout,
		deliver,
		disconnect,
		stop,
		dispose() {
			stop();
			api.dispose();
			container.remove();
		},
	};
}

describe("CSS-owned workspace resizing", () => {
	it("lays out actual panes during delivery, before another animation frame", () => {
		const f = fixture();
		try {
			for (const width of [1_120, 1_240, 1_060, 1_000]) {
				f.deliver(width, 650);
				expect(f.api.width).toBe(width);
				expect(f.api.height).toBe(650);
				expect(f.left.group.api.width + f.right.group.api.width).toBe(width);
				expect(f.left.group.api.width / width).toBeCloseTo(0.3, 2);
			}
			expect(f.layout).toHaveBeenCalledTimes(4);
		} finally {
			f.dispose();
		}
	});

	it("keeps a hidden workspace's split proportions and converges on reveal", () => {
		const f = fixture();
		try {
			f.deliver(0, 0);
			f.deliver(1_200, 0);
			expect(f.layout).not.toHaveBeenCalled();
			expect(f.left.group.api.width).toBe(300);
			f.deliver(1_200, 720);
			expect(f.left.group.api.width).toBe(360);
			expect(f.right.group.api.width).toBe(840);
		} finally {
			f.dispose();
		}
	});

	it("rounds browser subpixels once and does not repeat an unchanged layout", () => {
		const f = fixture();
		try {
			f.deliver(1_000.1, 600.2);
			expect(f.layout).not.toHaveBeenCalled();
			f.deliver(1_100.1, 650.2);
			f.deliver(1_100.2, 650.1);
			expect(f.layout).toHaveBeenCalledExactlyOnceWith(1_100, 650);
		} finally {
			f.dispose();
		}
	});

	it("disconnects the observation when its Dockview is released", () => {
		const f = fixture();
		f.dispose();
		expect(f.disconnect).toHaveBeenCalledOnce();
	});
});
