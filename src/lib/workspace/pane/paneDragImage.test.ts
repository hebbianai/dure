// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPaneDragImage } from "@/lib/workspace/pane/paneDragImage";

afterEach(() => {
	document.querySelectorAll(".pane-transfer-drag-image").forEach((node) => {
		node.remove();
	});
	vi.useRealTimers();
});

describe("setPaneDragImage", () => {
	it("uses a pane-shaped ghost and exposes the multi-pane count", () => {
		vi.useFakeTimers();
		const setDragImage = vi.fn();
		setPaneDragImage({ setDragImage } as unknown as DataTransfer, {
			title: "codex-16",
			count: 3,
		});

		const ghost = document.querySelector<HTMLElement>(
			".pane-transfer-drag-image",
		);
		expect(ghost?.textContent).toContain("codex-16");
		expect(ghost?.textContent).toContain("3");
		expect(setDragImage).toHaveBeenCalledWith(ghost, 24, 18);

		vi.runAllTimers();
		expect(document.querySelector(".pane-transfer-drag-image")).toBeNull();
	});
});
