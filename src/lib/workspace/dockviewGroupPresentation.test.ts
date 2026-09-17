// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	SPACES_PANE_HOVER_ATTRIBUTE,
	syncSpacesPaneHoverGroup,
} from "./dockviewGroupPresentation";

describe("syncSpacesPaneHoverGroup", () => {
	it("marks the owning group without styling through descendant :has", () => {
		const group = document.createElement("section");
		group.className = "dv-groupview";
		const chrome = document.createElement("div");
		group.append(chrome);

		const cleanup = syncSpacesPaneHoverGroup(chrome, true);

		expect(group.hasAttribute(SPACES_PANE_HOVER_ATTRIBUTE)).toBe(true);
		expect(chrome.hasAttribute(SPACES_PANE_HOVER_ATTRIBUTE)).toBe(false);
		cleanup();
		expect(group.hasAttribute(SPACES_PANE_HOVER_ATTRIBUTE)).toBe(false);
	});

	it("is a no-op before Dockview has attached the pane chrome", () => {
		const cleanup = syncSpacesPaneHoverGroup(
			document.createElement("div"),
			true,
		);
		expect(cleanup).not.toThrow();
	});
});
