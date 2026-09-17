import { describe, expect, it, vi } from "vitest";
import {
	capturePaneQuickCommandTarget,
	registerPaneQuickCommandTarget,
} from "./paneQuickCommandTarget";

const command = {
	id: "one",
	label: "Status",
	text: "git status",
	appendEnter: false,
};
describe("pane Quick Command routing", () => {
	it("captures the right-clicked pane, independent of the focused pane", async () => {
		const a = vi.fn(async () => {});
		const b = vi.fn(async () => {});
		const removeA = registerPaneQuickCommandTarget("a", a);
		const removeB = registerPaneQuickCommandTarget("b", b);
		try {
			await capturePaneQuickCommandTarget("a")?.(command);
			expect(a).toHaveBeenCalledWith(command);
			expect(b).not.toHaveBeenCalled();
		} finally {
			removeA();
			removeB();
		}
	});
	it("does not retarget a menu selection to a replacement surface", async () => {
		const remove = registerPaneQuickCommandTarget(
			"a",
			vi.fn(async () => {}),
		);
		const captured = capturePaneQuickCommandTarget("a");
		remove();
		const replacement = vi.fn(async () => {});
		const removeReplacement = registerPaneQuickCommandTarget("a", replacement);
		try {
			await expect(captured?.(command)).rejects.toThrow("unavailable");
			expect(replacement).not.toHaveBeenCalled();
			remove();
			await capturePaneQuickCommandTarget("a")?.(command);
			expect(replacement).toHaveBeenCalledOnce();
		} finally {
			removeReplacement();
		}
	});
});
