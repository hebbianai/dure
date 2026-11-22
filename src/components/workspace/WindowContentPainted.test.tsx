// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { WindowContentPainted } from "@/components/workspace/WindowContentPainted";
import { installBootSplash } from "@/lib/workspace/boot/bootSplash";
import {
	resetWindowBootForTest,
	WINDOW_CONTENT_PAINTED_EVENT,
	windowContentPainted,
} from "@/lib/workspace/boot/windowBootState";

afterEach(() => {
	cleanup();
	resetWindowBootForTest();
	vi.restoreAllMocks();
});

function Broken(): never {
	throw new Error("root failed to render");
}

describe("WindowContentPainted", () => {
	it("ends the window's boot after the root's first paint, once", async () => {
		const heard = vi.fn();
		document.addEventListener(WINDOW_CONTENT_PAINTED_EVENT, heard);
		try {
			const view = render(
				<>
					<p>session window</p>
					<WindowContentPainted />
				</>,
			);
			// Not at commit: only after the frame that shows the root.
			expect(windowContentPainted()).toBe(false);
			await vi.waitFor(() => expect(windowContentPainted()).toBe(true));
			view.rerender(
				<>
					<p>session window updated</p>
					<WindowContentPainted />
				</>,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(heard).toHaveBeenCalledTimes(1);
		} finally {
			document.removeEventListener(WINDOW_CONTENT_PAINTED_EVENT, heard);
		}
	});

	it("still ends the boot when the root's content fails inside its boundary", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(
			<>
				<AppErrorBoundary label="session-window">
					<Broken />
				</AppErrorBoundary>
				<WindowContentPainted />
			</>,
		);
		await vi.waitFor(() => expect(windowContentPainted()).toBe(true));
	});

	it("removes a boot splash that a non-workspace window started", async () => {
		const splash = installBootSplash(document, {
			storage: null,
			reducedMotion: true,
		});
		try {
			await vi.waitFor(() => expect(splash.phase()).toBe("visible"));
			render(<WindowContentPainted />);
			await vi.waitFor(() => expect(splash.phase()).toBe("done"));
			expect(document.getElementById("dure-boot-splash")).toBeNull();
		} finally {
			splash.dispose();
		}
	});
});
