// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { openMobileSimulatorPanelOnDesktop } from "./openMobileSimulatorPanel";

const holder = vi.hoisted(() => ({
	api: undefined as DockviewApi | undefined,
	desktopId: "",
}));
vi.mock("@/lib/workspace/dock", () => ({
	withDesktopDockview: (id: string, open: (api: DockviewApi) => void) => {
		holder.desktopId = id;
		if (holder.api) open(holder.api);
	},
}));
afterEach(() => {
	holder.api?.dispose();
	holder.api = undefined;
});
it("opens in the requested Space and focuses the same pane without replacing its selected device", () => {
	const element = document.createElement("div");
	holder.api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	openMobileSimulatorPanelOnDesktop("space-one");
	expect(holder.desktopId).toBe("space-one");
	const panel = holder.api.panels[0];
	expect(panel.api.component).toBe("mobileSimulator");
	const device = { platform: "ios", id: "exact-device" };
	panel.api.updateParameters({ device });
	openMobileSimulatorPanelOnDesktop("space-one");
	expect(holder.api.panels).toHaveLength(1);
	expect(panel.params?.device).toEqual(device);
});
