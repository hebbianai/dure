import { describe, expect, it } from "vitest";
import { PaneFocusHistory } from "@/lib/workspace/pane/paneFocusHistory";

describe("PaneFocusHistory", () => {
	it("moves back and forward through the order panes were focused", () => {
		const history = new PaneFocusHistory();
		history.visit("first");
		history.visit("second");
		history.visit("third");

		expect(history.move("back", () => true)).toBe("second");
		expect(history.move("back", () => true)).toBe("first");
		expect(history.move("forward", () => true)).toBe("second");
	});

	it("drops forward history after a new focus and skips unavailable panes", () => {
		const history = new PaneFocusHistory();
		history.visit("first");
		history.visit("removed");
		history.visit("third");

		expect(history.move("back", (id) => id !== "removed")).toBe("first");
		history.visit("branch");
		expect(history.move("forward", () => true)).toBeUndefined();
	});
});
