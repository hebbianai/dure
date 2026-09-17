// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { readPaneDragGeometry } from "@/lib/workspace/pane/paneDragGeometry";

describe("pane hover coordinate frame", () => {
	it.each(["dragenter", "dragover"])(
		"isolates workspaces and refreshes bounds on the next %s",
		(type) => {
			const container = document.createElement("div");
			const otherContainer = document.createElement("div");
			const firstBox = new DOMRect(0, 0, 1000, 700);
			const movedBox = new DOMRect(200, 50, 800, 600);
			const otherBox = new DOMRect(1100, 20, 600, 500);
			const geometry = vi
				.spyOn(container, "getBoundingClientRect")
				.mockReturnValue(firstBox);
			const otherGeometry = vi
				.spyOn(otherContainer, "getBoundingClientRect")
				.mockReturnValue(otherBox);
			const event = new Event(type) as DragEvent;

			expect(readPaneDragGeometry(event, container)).toBe(firstBox);
			expect(readPaneDragGeometry(event, otherContainer)).toBe(otherBox);
			expect(readPaneDragGeometry(event, container)).toBe(firstBox);
			expect(readPaneDragGeometry(event, otherContainer)).toBe(otherBox);
			expect(geometry).toHaveBeenCalledTimes(1);
			expect(otherGeometry).toHaveBeenCalledTimes(1);

			geometry.mockReturnValue(movedBox);
			const next = new Event(type) as DragEvent;
			expect(readPaneDragGeometry(next, container)).toBe(movedBox);
			expect(readPaneDragGeometry(next, otherContainer)).toBe(otherBox);
			expect(geometry).toHaveBeenCalledTimes(2);
			expect(otherGeometry).toHaveBeenCalledTimes(2);
		},
	);
});
