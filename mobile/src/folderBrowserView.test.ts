// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { FolderBrowserModel } from "./folderBrowser";
import {
	type FolderBrowserActions,
	renderFolderBrowserScreen,
} from "./folderBrowserView";
import { t } from "./i18n";

const MODEL: FolderBrowserModel = {
	hubId: "h1",
	boxLabel: "mac-mini",
	hosts: [
		{ id: "h1", label: "mac-mini" },
		{ id: "h2", label: "Dure" },
	],
	hostOpen: false,
	stage: {
		kind: "ready",
		rootPath: "/Users/me",
		path: "/Users/me/dev",
		entries: [{ name: "HebbianIDE", path: "/Users/me/dev/HebbianIDE" }],
	},
};

function actions(
	overrides: Partial<FolderBrowserActions> = {},
): FolderBrowserActions {
	return {
		close: vi.fn(),
		toggleHost: vi.fn(),
		selectHost: vi.fn(),
		browse: vi.fn(),
		choose: vi.fn(),
		openCreate: vi.fn(),
		editCreateName: vi.fn(),
		cancelCreate: vi.fn(),
		createFolder: vi.fn(),
		...overrides,
	};
}

describe("renderFolderBrowserScreen", () => {
	it("renders the host, open tree, and selected folder action", () => {
		const screen = renderFolderBrowserScreen(MODEL, actions());

		expect(screen.querySelector(".folder-browser__title")?.textContent).toBe(
			t("다른 폴더 열기"),
		);
		expect(
			screen.querySelector(".folder-browser__host")?.textContent,
		).toContain("mac-mini");
		expect(
			[...screen.querySelectorAll(".folder-tree__name")].map(
				(node) => node.textContent,
			),
		).toEqual(["~", "dev", "HebbianIDE"]);
		expect(screen.querySelector(".folder-browser__choose")?.textContent).toBe(
			t("{folder} 폴더에서 시작", { folder: "dev" }),
		);
	});

	it("opens the Figma new-folder confirmation with its destination", () => {
		const cancelCreate = vi.fn();
		const screen = renderFolderBrowserScreen(
			{ ...MODEL, create: { name: "feature", busy: false } },
			actions({ cancelCreate }),
		);

		expect(screen.querySelector("[role=dialog] h2")?.textContent).toBe(
			t("새 폴더"),
		);
		expect(
			screen.querySelector(".folder-create__preview")?.textContent,
		).toContain("mac-mini · ~/dev");
		expect(
			screen.querySelector<HTMLInputElement>(".folder-create__input")?.value,
		).toBe("feature");
		screen
			.querySelector("[role=dialog]")
			?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(cancelCreate).toHaveBeenCalled();
	});

	it("shows every paired host and switches by opaque hub id", () => {
		const selectHost = vi.fn();
		const screen = renderFolderBrowserScreen(
			{ ...MODEL, hostOpen: true },
			actions({ selectHost }),
		);
		const options = [
			...screen.querySelectorAll<HTMLButtonElement>(
				".folder-browser__host-option",
			),
		];

		expect(options.map((option) => option.textContent)).toEqual([
			"mac-mini",
			"Dure",
		]);
		options[1]?.click();
		expect(selectHost).toHaveBeenCalledWith("h2");
	});
});
