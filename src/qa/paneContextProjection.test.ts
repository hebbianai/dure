// @vitest-environment jsdom
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hmux } from "@/lib/ipc";
import * as dock from "@/lib/workspace/dock";
import { probePaneContextProjection } from "./paneContextProjection";

beforeEach(() => {
	mockWindows("main");
	mockIPC(() => null);
});
afterEach(() => {
	clearMocks();
	vi.restoreAllMocks();
});

it.each(["slot", "agent:previous", "launcher:previous"])(
	"projects current content through the real Workspace and header in %s",
	async (id) => {
		const create = vi.spyOn(hmux, "createStandalone");
		const createManaged = vi.spyOn(hmux, "createManagedShell");
		const initial = vi.spyOn(dock, "openDesktopInitialTerminal");
		expect(await probePaneContextProjection(id)).toEqual({
			panelId: id,
			contentReplaced: true,
			retargeted: true,
			invalidated: true,
			preserved: true,
			projectId: "qa-second-project",
			hiddenRestored: true,
		});
		expect(create).not.toHaveBeenCalled();
		expect(createManaged).not.toHaveBeenCalled();
		expect(initial).not.toHaveBeenCalled();
	},
);

it("publishes current pane context while the WebView is not eligible to paint", async () => {
	let nextFrame = 0;
	vi.spyOn(window, "requestAnimationFrame").mockImplementation(
		() => ++nextFrame,
	);
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
	expect(await probePaneContextProjection("unpainted-slot")).toMatchObject({
		panelId: "unpainted-slot",
		retargeted: true,
		invalidated: true,
		preserved: true,
		hiddenRestored: true,
	});
});
