import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requestPinpointBrowser: vi.fn(),
	requestNewDesktop: vi.fn(),
	openBrowserPanelOnDesktop: vi.fn(),
	api: undefined as
		| undefined
		| {
				activePanel?: object;
				groups: unknown[];
				hasMaximizedGroup(): boolean;
		  },
}));

vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	getDockview: () => mocks.api,
}));
vi.mock("@/lib/design/pinpointBrowserActivation", () => ({
	requestPinpointBrowser: mocks.requestPinpointBrowser,
}));
vi.mock("@/lib/workspace/desktop/newDesktopActivation", () => ({
	requestNewDesktop: mocks.requestNewDesktop,
}));
vi.mock("@/lib/workspace/dock/openBrowserPanel", () => ({
	openBrowserPanelOnDesktop: mocks.openBrowserPanelOnDesktop,
}));

import {
	readAppCommandContext,
	runAppCommand,
} from "@/lib/commands/appCommandRunner";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@/lib/terminal/renderer/terminalFont";
import { DEFAULT_UI_PREFS, useStore } from "@/store";

afterEach(() => {
	mocks.api = undefined;
	vi.clearAllMocks();
});

describe("readAppCommandContext", () => {
	it("reports no pane facts for a Space with no layout", () => {
		expect(readAppCommandContext()).toMatchObject({
			hasActivePane: false,
			canBalancePanes: false,
			canUndoPaneMove: false,
		});
	});

	it("reads the active pane and whether a balance would move anything", () => {
		mocks.api = {
			activePanel: {},
			groups: [{}, {}],
			hasMaximizedGroup: () => false,
		};
		expect(readAppCommandContext()).toMatchObject({
			hasActivePane: true,
			canBalancePanes: true,
		});

		mocks.api = {
			activePanel: {},
			groups: [{}, {}],
			hasMaximizedGroup: () => true,
		};
		expect(readAppCommandContext().canBalancePanes).toBe(false);

		mocks.api = {
			activePanel: {},
			groups: [{}],
			hasMaximizedGroup: () => false,
		};
		expect(readAppCommandContext().canBalancePanes).toBe(false);
	});
});

describe("readAppCommandContext Spaces", () => {
	let previous: ReturnType<typeof useStore.getState>;
	beforeEach(() => {
		previous = useStore.getState();
	});
	afterEach(() => useStore.setState(previous));

	it("lists the Spaces the tab strip shows, in its order", () => {
		useStore.setState({
			spaces: [
				{ id: "desk-a", name: "A" },
				{ id: "desk-pop", name: "Popped", kind: "popout" },
				{ id: "desk-b", name: "B" },
			],
			activeSpaceId: "desk-a",
			spaceVisits: { "desk-b": 20, "desk-a": 10 },
			uiPrefs: { ...DEFAULT_UI_PREFS, tabOrder: "recent" },
		});
		expect(readAppCommandContext()).toMatchObject({
			spaces: [
				{ id: "desk-b", name: "B" },
				{ id: "desk-a", name: "A" },
			],
			activeSpaceId: "desk-a",
		});
	});
});

describe("runAppCommand", () => {
	it("changes the terminal font the way the shortcut does", () => {
		useStore.getState().setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
		const fontSize = () => useStore.getState().terminalFontSize;

		runAppCommand({ command: "font-inc" });
		expect(fontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE + 1);
		runAppCommand({ command: "font-dec" });
		runAppCommand({ command: "font-dec" });
		expect(fontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE - 1);
		runAppCommand({ command: "font-reset" });
		expect(fontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
	});

	it("toggles the sidebar", () => {
		const before = useWindowSidebarStore.getState().open;
		runAppCommand({ command: "toggle-sidebar" });
		expect(useWindowSidebarStore.getState().open).toBe(!before);
		runAppCommand({ command: "toggle-sidebar" });
		expect(useWindowSidebarStore.getState().open).toBe(before);
	});

	it("targets the active Space for menu commands", () => {
		useStore.setState({ activeSpaceId: "desk-9" });
		runAppCommand({ command: "open-browser" });
		expect(mocks.openBrowserPanelOnDesktop).toHaveBeenCalledWith("desk-9");
	});

	it("asks the Pinpoint owner to open its dialog", () => {
		runAppCommand({ command: "pinpoint-browser" });
		expect(mocks.requestPinpointBrowser).toHaveBeenCalledOnce();
	});

	it("asks the tab strip for its naming step instead of making a Space", () => {
		const before = useStore.getState().spaces;
		runAppCommand({ command: "new-desktop" });
		expect(mocks.requestNewDesktop).toHaveBeenCalledOnce();
		expect(useStore.getState().spaces).toBe(before);
	});

	it("switches to the Space a row names, as ⌘n does", () => {
		const previous = useStore.getState();
		useStore.setState({
			spaces: [
				{ id: "desk-a", name: "A" },
				{ id: "desk-b", name: "B" },
			],
			activeSpaceId: "desk-a",
		});
		runAppCommand({ command: "switch-desktop", spaceId: "desk-b" });
		expect(useStore.getState().activeSpaceId).toBe("desk-b");

		// A Space that closed while the palette was closing is not switched to.
		runAppCommand({ command: "switch-desktop", spaceId: "desk-gone" });
		expect(useStore.getState().activeSpaceId).toBe("desk-b");
		useStore.setState(previous);
	});
});
