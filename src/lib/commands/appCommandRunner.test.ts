import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requestPinpointBrowser: vi.fn(),
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
vi.mock("@/lib/workspace/dock/openBrowserPanel", () => ({
	openBrowserPanelOnDesktop: mocks.openBrowserPanelOnDesktop,
}));

import {
	readAppCommandContext,
	runAppCommand,
} from "@/lib/commands/appCommandRunner";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@/lib/terminal/renderer/terminalFont";
import { useStore } from "@/store";

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

describe("runAppCommand", () => {
	it("changes the terminal font the way the shortcut does", () => {
		useStore.getState().setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
		const fontSize = () => useStore.getState().terminalFontSize;

		runAppCommand("font-inc");
		expect(fontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE + 1);
		runAppCommand("font-dec");
		runAppCommand("font-dec");
		expect(fontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE - 1);
		runAppCommand("font-reset");
		expect(fontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
	});

	it("toggles the sidebar", () => {
		const before = useWindowSidebarStore.getState().open;
		runAppCommand("toggle-sidebar");
		expect(useWindowSidebarStore.getState().open).toBe(!before);
		runAppCommand("toggle-sidebar");
		expect(useWindowSidebarStore.getState().open).toBe(before);
	});

	it("targets the active Space for menu commands", () => {
		useStore.setState({ activeSpaceId: "desk-9" });
		runAppCommand("open-browser");
		expect(mocks.openBrowserPanelOnDesktop).toHaveBeenCalledWith("desk-9");
	});

	it("asks the Pinpoint owner to open its dialog", () => {
		runAppCommand("pinpoint-browser");
		expect(mocks.requestPinpointBrowser).toHaveBeenCalledOnce();
	});
});
