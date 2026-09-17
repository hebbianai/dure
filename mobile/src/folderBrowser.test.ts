import { describe, expect, it } from "vitest";
import { displayPath, folderName, pathRows } from "./folderBrowser";

describe("folder browser paths", () => {
	it("shows the home-relative path from the Figma flow", () => {
		expect(displayPath("/Users/me", "/Users/me/dev/HebbianIDE")).toBe(
			"~/dev/HebbianIDE",
		);
		expect(folderName("/Users/me/dev/HebbianIDE/")).toBe("HebbianIDE");
	});

	it("keeps every open ancestor and selects only the current folder", () => {
		expect(pathRows("/Users/me", "/Users/me/dev/app")).toEqual([
			{ label: "~", path: "/Users/me", depth: 0, selected: false },
			{ label: "dev", path: "/Users/me/dev", depth: 1, selected: false },
			{ label: "app", path: "/Users/me/dev/app", depth: 2, selected: true },
		]);
	});
});
